"""同步审阅：完整原字节、强版本与受保护提交；不调用文本编码保存。"""
from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import stat
from typing import Any, Callable
import uuid

from .engine_workbench import WorkbenchError, WorkspaceIdentity
from .workspace_documents import (safe_document_path, document_lock, guarded_parent,
    _descriptor_path, _file_object_id, _stat_key, byte_version, decode_document,
    NON_TEXT_SUFFIXES, _preserve_attributes, _replace_existing)

MAX_BYTES = 2 * 1024 * 1024
MAX_LINES = 20_000
MAX_LINE_LENGTH = 64 * 1024


def review_format(data: bytes, relative: str) -> dict[str, Any]:
    decoded = decode_document(data, complete=True)
    reason = decoded.pop('reasonCode')
    if reason == 'mixed_eol':
        reason = ''  # 展示允许混合换行；写入始终复制原字节。
    text = decoded.pop('text')
    if len(data) > MAX_BYTES:
        reason = 'too_large'
    elif Path(relative).suffix.lower() in NON_TEXT_SUFFIXES:
        reason = 'specialized_preview'
    elif not reason:
        lines = text.split('\n')
        if len(lines) > MAX_LINES:
            reason = 'too_many_lines'
        elif any(len(line) > MAX_LINE_LENGTH for line in lines):
            reason = 'line_too_long'
    return {**decoded, 'finalNewline': text.endswith('\n'), 'reasonCode': reason}


def read_review(identity: WorkspaceIdentity, relative: str, include_data: bool = True) -> dict[str, Any]:
    target = safe_document_path(identity.workingDir, relative)
    parent = target.parent
    root = Path(identity.workingDir)
    while parent != root:
        if parent.exists() and not parent.is_dir():
            raise WorkbenchError('type_conflict')
        parent = parent.parent
    result = {'status': 'ok', 'workspace': identity.to_dict(), 'relativePath': relative}
    try:
        before = target.stat()
    except FileNotFoundError:
        return {**result, 'kind': 'missing', 'version': {'exists': False}}
    if stat.S_ISDIR(before.st_mode):
        return {**result, 'kind': 'directory', 'version': None, 'reasonCode': 'type_conflict'}
    if not stat.S_ISREG(before.st_mode):
        raise WorkbenchError('not_regular_file')
    if before.st_size > MAX_BYTES:
        return {**result, 'kind': 'unavailable', 'version': None, 'byteLength': before.st_size, 'reasonCode': 'too_large'}
    with target.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if (_descriptor_path(stream) != target or safe_document_path(identity.workingDir, relative) != target
                or _stat_key(opened) != _stat_key(before)):
            raise WorkbenchError('file_changed_during_read')
        file_id = _file_object_id(stream)
        data = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
    if (len(data) != before.st_size or len(data) > MAX_BYTES or _stat_key(after) != _stat_key(before)
            or _stat_key(target.stat()) != _stat_key(after)):
        raise WorkbenchError('file_changed_during_read')
    metadata = review_format(data, relative)
    if before.st_nlink != 1:
        metadata['reasonCode'] = 'hardlinked_file'
    result.update(kind='file', version=byte_version(data, after, file_id), byteLength=len(data),
                  readonly=not bool(before.st_mode & 0o222), **metadata)
    if include_data and not metadata['reasonCode']:
        result['data'] = base64.b64encode(data).decode('ascii')
    return result


def _make_parents(identity: WorkspaceIdentity, relative: str) -> None:
    root = Path(identity.workingDir)
    target = safe_document_path(str(root), relative)
    current = root
    for part in target.parent.relative_to(root).parts:
        child = current / part
        # 每一层的创建都在真实父目录保护内；不跟随链接，不替换阻塞文件。
        with guarded_parent(root, child) as parent_fd:
            try:
                if parent_fd is None:
                    child.mkdir()
                else:
                    os.mkdir(child.name, dir_fd=parent_fd)
            except FileExistsError:
                pass
            safe_document_path(str(root), child.relative_to(root).as_posix())
            if not child.is_dir():
                raise WorkbenchError('type_conflict')
        current = child


def apply_review(identity: WorkspaceIdentity, relative: str, baseline: Any, data: bytes,
                 before_commit: Callable[[], None]) -> dict[str, Any]:
    if not isinstance(data, bytes) or len(data) > MAX_BYTES:
        raise WorkbenchError('too_large')
    reason = review_format(data, relative)['reasonCode']
    if reason:
        raise WorkbenchError(reason)
    if not isinstance(baseline, dict) or type(baseline.get('exists')) is not bool:
        raise WorkbenchError('invalid_baseline')
    target = safe_document_path(identity.workingDir, relative)
    root = Path(identity.workingDir)
    creating = baseline == {'exists': False}
    expected_hash = hashlib.sha256(data).hexdigest()
    with document_lock(target):
        original = read_review(identity, relative, False)
        if original['version'] != baseline:
            raise WorkbenchError('disk_conflict')
        if original.get('reasonCode') or original.get('readonly'):
            raise WorkbenchError(original.get('reasonCode') or 'document_readonly')
        before_commit()
        if creating:
            _make_parents(identity, relative)
        with guarded_parent(root, target) as parent_fd:
            temporary = target.parent / f'.awu-review-{uuid.uuid4().hex}.tmp'
            temporary_object = None
            published = False
            replacing = False
            try:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0)
                fd = (os.open(temporary, flags, 0o600) if parent_fd is None else
                      os.open(temporary.name, flags | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd))
                with os.fdopen(fd, 'wb') as stream:
                    info = os.fstat(stream.fileno())
                    temporary_object = (info.st_dev, info.st_ino)
                    _file_object_id(stream)
                    if _descriptor_path(stream) != temporary:
                        raise WorkbenchError('path_unverifiable')
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                if not creating:
                    _preserve_attributes(target, temporary, target.stat())
                if parent_fd is not None:
                    fd = os.open(temporary.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                before_commit()
                current = read_review(identity, relative, False)
                if (current['version'] != baseline or current.get('reasonCode') or current.get('readonly')
                        or safe_document_path(identity.workingDir, relative) != target):
                    raise WorkbenchError('disk_conflict')
                if creating:
                    if parent_fd is None:
                        os.link(temporary, target)
                    else:
                        os.link(temporary.name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                    published = True
                    if parent_fd is None:
                        temporary.unlink()
                    else:
                        os.unlink(temporary.name, dir_fd=parent_fd)
                else:
                    replacing = True
                    _replace_existing(temporary, target, parent_fd)
                    published = True
                if parent_fd is not None:
                    os.fsync(parent_fd)
                observed = read_review(identity, relative, False)
                version = observed.get('version') or {}
                if version.get('sha256') != expected_hash or version.get('byteLength') != len(data):
                    raise WorkbenchError('review_result_unverified')
                return {'status': 'succeeded', 'version': version}
            except Exception as error:
                if replacing and not published:
                    try:
                        published = read_review(identity, relative, False)['version'] != baseline
                    except Exception:
                        published = True
                if published:
                    # 不用“磁盘恰好同 hash”猜测本次提交成功，也不回滚后来修改。
                    raise WorkbenchError('review_result_unverified') from error
                raise
            finally:
                try:
                    if temporary_object is not None:
                        present = (temporary.lstat() if parent_fd is None else
                                   os.stat(temporary.name, dir_fd=parent_fd, follow_symlinks=False))
                        if (present.st_dev, present.st_ino) == temporary_object:
                            if parent_fd is None:
                                os.chmod(temporary, 0o600)
                                temporary.unlink()
                            else:
                                os.unlink(temporary.name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
