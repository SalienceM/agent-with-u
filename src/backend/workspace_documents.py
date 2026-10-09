"""完整文档与字节基线；独立于普通文件同步接口，不允许预览片段覆盖原文件。"""
from __future__ import annotations

import codecs
import hashlib
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import sys
import threading
from contextlib import contextmanager
from typing import Any, BinaryIO, Callable, Iterator
import uuid

from .engine_workbench import WorkbenchError, WorkspaceIdentity

MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
PREVIEW_BYTES = 256 * 1024
NON_TEXT_SUFFIXES = frozenset({'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif', '.zip', '.gz',
    '.tar', '.7z', '.exe', '.dll', '.pyd', '.so', '.mp4', '.mp3', '.wav', '.woff', '.woff2'})
_LOCKS: dict[str, tuple[threading.Lock, int]] = {}
_LOCKS_GUARD = threading.Lock()


@contextmanager
def document_lock(target: Path) -> Iterator[None]:
    """规范路径跨 Session/Bridge 共用；有等待者时不删除锁，空闲后回收。"""
    key = os.path.normcase(str(target))
    with _LOCKS_GUARD:
        lock, count = _LOCKS.get(key, (threading.Lock(), 0))
        _LOCKS[key] = lock, count + 1
    try:
        with lock:
            yield
    finally:
        with _LOCKS_GUARD:
            _, count = _LOCKS[key]
            if count == 1:
                del _LOCKS[key]
            else:
                _LOCKS[key] = lock, count - 1


@contextmanager
def guarded_parent(root: Path, target: Path) -> Iterator[int | None]:
    """Windows 持有不共享删除的目录句柄；Linux 使用 pinned dirfd 提交。"""
    directories = [root]
    for part in target.parent.relative_to(root).parts:
        directories.append(directories[-1] / part)
    handles = []
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                           wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        try:
            for directory in directories:
                # FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES：仅 0x80 属性访问不参与
                # Windows 的删除共享约束，目录仍可在校验与替换之间被重命名。
                handle = create(str(directory), 0x81, 3, None, 3, 0x02200000, None)
                if handle in (None, ctypes.c_void_p(-1).value):
                    raise ctypes.WinError(ctypes.get_last_error())
                handles.append(handle)
            safe_document_path(str(root), target.relative_to(root).as_posix())
            yield None
        finally:
            for handle in reversed(handles):
                kernel.CloseHandle(handle)
    else:
        try:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            handles.append(fd)
            for part in target.parent.relative_to(root).parts:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                handles.append(fd)
            yield fd
        finally:
            for fd in reversed(handles):
                os.close(fd)


def _replace_existing(temporary: Path, target: Path, parent_fd: int | None) -> None:
    if os.name == 'nt':
        # ReplaceFile 保留原文件 DACL、创建时间、必要属性/数据流。
        # 不使用忽略 ACL 合并错误的 flags，也不回退会丢失这些属性的裸覆盖。
        import ctypes
        from ctypes import wintypes
        replace = ctypes.WinDLL('kernel32', use_last_error=True).ReplaceFileW
        replace.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                            wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
        replace.restype = wintypes.BOOL
        if not replace(str(target), str(temporary), None, 0, None, None):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.replace(temporary.name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)


def _preserve_attributes(target: Path, temporary: Path, info: os.stat_result) -> None:
    if os.name != 'nt':
        current = temporary.stat()
        if (current.st_uid, current.st_gid) != (info.st_uid, info.st_gid):
            os.chown(temporary, info.st_uid, info.st_gid)
    # chown 会清除 set-id 位，必须先变更 owner/group 再恢复 mode。
    os.chmod(temporary, stat.S_IMODE(info.st_mode))
    if os.name != 'nt':
        if hasattr(os, 'listxattr'):
            names = os.listxattr(target, follow_symlinks=False)
            budget = 1024 * 1024
            for inherited in os.listxattr(temporary, follow_symlinks=False):
                if inherited not in names:
                    os.removexattr(temporary, inherited, follow_symlinks=False)
            for name in names:
                data = os.getxattr(target, name, follow_symlinks=False)
                budget -= len(os.fsencode(name)) + len(data)
                if budget < 0:
                    raise WorkbenchError('attributes_unavailable')
                os.setxattr(temporary, name, data, follow_symlinks=False)


def atomic_save_document(identity: WorkspaceIdentity, relative: str, baseline: Any,
                          text: str, before_commit: Callable[[], None]) -> dict[str, Any]:
    target = safe_document_path(identity.workingDir, relative)
    root = Path(identity.workingDir)
    with document_lock(target), guarded_parent(root, target) as parent_fd:
        if not isinstance(baseline, dict) or type(baseline.get('exists')) is not bool:
            raise WorkbenchError('invalid_baseline')
        creating = baseline == {'exists': False}
        try:
            original = read_document(identity, relative)
        except FileNotFoundError:
            if not creating or not target.parent.is_dir():
                raise WorkbenchError('disk_conflict')
            original = {'version': {'exists': False}, 'editable': target.suffix.lower() not in NON_TEXT_SUFFIXES,
                        'encoding': 'utf-8', 'bom': '', 'eol': 'lf'}
        if original['version'] != baseline:
            raise WorkbenchError('disk_conflict')
        if not original['editable']:
            raise WorkbenchError('document_readonly')
        if not creating and not target.stat().st_mode & 0o222:
            raise PermissionError('document_readonly')  # root 也不得通过替换绕过只读意图。
        data = encode_document(text, original)
        temporary = target.parent / f'.awu-save-{uuid.uuid4().hex}.tmp'
        committed = False
        replace_started = False
        temporary_object: tuple[int, int] | None = None
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0)
            if parent_fd is None:
                fd = os.open(temporary, flags, 0o600)
            else:
                fd = os.open(temporary.name, flags | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
            with os.fdopen(fd, 'wb') as stream:
                created = os.fstat(stream.fileno())
                temporary_object = (created.st_dev, created.st_ino)
                _file_object_id(stream)  # 不支持可靠对象身份的文件系统不开始提交。
                if _descriptor_path(stream) != temporary:
                    raise WorkbenchError('path_unverifiable')
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if not creating:
                _preserve_attributes(target, temporary, target.stat())
            if parent_fd is not None:
                synced_fd = os.open(temporary.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
                try:
                    os.fsync(synced_fd)  # 属性变更也在提交前同步。
                finally:
                    os.close(synced_fd)
            before_commit()  # worker 回到事件循环核验所属活动与权威控制修订。
            if safe_document_path(identity.workingDir, relative) != target:
                raise WorkbenchError('disk_conflict')
            try:
                current = read_document(identity, relative)
                if current['version'] != baseline:
                    raise WorkbenchError('disk_conflict')
            except FileNotFoundError:
                if not creating:
                    raise WorkbenchError('disk_conflict')
            if creating:
                # 不覆盖在最终核验后刚出现的同名新文件。
                if parent_fd is None:
                    os.link(temporary, target)
                else:
                    os.link(temporary.name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            else:
                replace_started = True
                _replace_existing(temporary, target, parent_fd)
            committed = True
            if creating:
                if parent_fd is None:
                    temporary.unlink()
                else:
                    os.unlink(temporary.name, dir_fd=parent_fd)
            if parent_fd is not None:
                os.fsync(parent_fd)
            result = read_document(identity, relative)
            if result['version']['sha256'] != hashlib.sha256(data).hexdigest():
                raise WorkbenchError('save_result_unverified')
            return {'status': 'succeeded', 'document': result['document'], 'version': result['version'],
                    'encoding': result['encoding'], 'bom': result['bom'], 'eol': result['eol']}
        except Exception as error:
            if replace_started and not committed:
                try:
                    committed = read_document(identity, relative)['version'] != baseline
                except Exception:
                    committed = True  # 替换已经开始却无法核对，不能假设原文件未变。
            if committed:
                unresolved = WorkbenchError('save_result_unverified')
                unresolved.saved_hash = hashlib.sha256(data).hexdigest()
                raise unresolved from error
            raise
        finally:
            # create-exclusive 失败时没有所属文件；不能清理碰巧同名的用户文件。
            try:
                if temporary_object is not None:
                    present = (temporary.lstat() if parent_fd is None else
                               os.stat(temporary.name, dir_fd=parent_fd, follow_symlinks=False))
                    if (present.st_dev, present.st_ino) == temporary_object:
                        if parent_fd is None:
                            os.chmod(temporary, 0o600)  # 本次临时文件可能复制了只读属性。
                            temporary.unlink()
                        else:
                            os.unlink(temporary.name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass


def safe_document_path(workspace: str, relative: Any, *, preserve_case: bool = False) -> Path:
    if (not isinstance(relative, str) or not relative or len(relative) > 4096
            or '\0' in relative or relative.startswith(('/', '\\')) or PureWindowsPath(relative).drive):
        raise WorkbenchError('invalid_path')
    parts = [part for part in relative.replace('\\', '/').split('/') if part and part != '.']
    if not parts or any(part == '..' or ':' in part for part in parts):
        raise WorkbenchError('invalid_path')
    root = Path(workspace)
    target = root
    for part in parts:
        if os.name == 'nt' and (part.rstrip(' .') != part or re.fullmatch(
                r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part)):
            raise WorkbenchError('invalid_path')
        target = target / part
        try:
            info = target.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise WorkbenchError('linked_path')
    resolved = target.resolve()
    if not resolved.is_relative_to(root.resolve()) or resolved == root.resolve():
        raise WorkbenchError('outside_workspace')
    return resolved if preserve_case else Path(os.path.normcase(str(resolved)))


def _descriptor_path(stream: BinaryIO) -> Path:
    """先核对真正打开的对象再读内容，避免父目录在 open 前被替换成链接。"""
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        get_path = kernel.GetFinalPathNameByHandleW
        get_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
        get_path.restype = wintypes.DWORD
        buffer = ctypes.create_unicode_buffer(32768)
        length = get_path(msvcrt.get_osfhandle(stream.fileno()), buffer, len(buffer), 0)
        if not 0 < length < len(buffer):
            raise WorkbenchError('path_unverifiable')
        value = buffer.value
        if value.startswith('\\\\?\\UNC\\'):
            value = '\\\\' + value[8:]
        elif value.startswith('\\\\?\\'):
            value = value[4:]
        return Path(os.path.normcase(value))
    proc_path = Path(f'/proc/self/fd/{stream.fileno()}')
    if proc_path.is_symlink():
        return Path(os.path.realpath(proc_path))
    # 未有平台文件句柄验证实现时拒绝，不以路径字符串检查冒充强校验。
    raise WorkbenchError('path_unverifiable')


def _stat_key(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _file_object_id(stream: BinaryIO) -> str:
    info = os.fstat(stream.fileno())
    identity = f'{info.st_dev}:{info.st_ino}'
    if sys.platform == 'linux':
        import array
        import fcntl
        import struct
        generation = array.array('i', [0])
        try:
            # FS_IOC_GETVERSION 返回 inode 分配代次，避免同 tick 删除/重建复用 ino。
            fcntl.ioctl(stream.fileno(), 0x80007601 | (struct.calcsize('l') << 16), generation)
        except OSError as error:
            raise WorkbenchError('file_identity_unverifiable') from error
        identity += f':{generation[0] & 0xffffffff}'
    return identity


def byte_version(data: bytes, info: os.stat_result, file_id: str) -> dict[str, Any]:
    return {'exists': True, 'sha256': hashlib.sha256(data).hexdigest(), 'byteLength': len(data),
            'fileId': file_id,
            'modifiedNs': str(info.st_mtime_ns), 'changedNs': str(info.st_ctime_ns)}


def decode_document(data: bytes, *, complete: bool) -> dict[str, Any]:
    encoding, bom, body = 'utf-8', '', data
    if data.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        return {'text': '', 'encoding': 'unknown', 'bom': '', 'eol': 'none', 'reasonCode': 'unsupported_encoding'}
    for marker, codec, name in ((codecs.BOM_UTF8, 'utf-8', 'utf8'),
                              (codecs.BOM_UTF16_LE, 'utf-16-le', 'utf16le'),
                              (codecs.BOM_UTF16_BE, 'utf-16-be', 'utf16be')):
        if data.startswith(marker):
            encoding, bom, body = codec, name, data[len(marker):]
            break
    try:
        # 部分预览允许尾部不完整字符，绝不允许坏字节替换；不产生可保存基线。
        decoder = codecs.getincrementaldecoder(encoding)(errors='strict')
        text = decoder.decode(body, final=complete)
    except UnicodeError:
        return {'text': '', 'encoding': 'unknown', 'bom': '', 'eol': 'none', 'reasonCode': 'invalid_encoding'}
    eols = set(re.findall(r'\r\n|\r|\n', text))
    eol = {frozenset({'\r\n'}): 'crlf', frozenset({'\n'}): 'lf',
           frozenset({'\r'}): 'cr', frozenset(): 'none'}.get(frozenset(eols), 'mixed')
    reason = ''
    if any(ord(char) < 32 and char not in '\t\n\r' for char in text):
        text, reason = '', 'binary'
    elif '\ufffd' in text:
        reason = 'replacement_character'
    elif eol == 'mixed':
        reason = 'mixed_eol'
    elif complete and text.encode(encoding) != body:
        reason = 'non_roundtrip_encoding'
    return {'text': text.replace('\r\n', '\n').replace('\r', '\n'),
            'encoding': encoding, 'bom': bom, 'eol': eol, 'reasonCode': reason}


def encode_document(text: Any, metadata: dict[str, Any]) -> bytes:
    if not isinstance(text, str) or len(text) > MAX_DOCUMENT_BYTES:
        raise WorkbenchError('too_large')
    # CodeMirror 的缓冲区统一为 LF，保存时按已核验磁盘格式重建。
    normalized = text.replace('\r\n', '\n').replace('\r', '\n')
    eol = {'crlf': '\r\n', 'cr': '\r', 'lf': '\n', 'none': '\n'}.get(metadata.get('eol'))
    if eol is None:
        raise WorkbenchError('mixed_eol')
    bom = {'': b'', 'utf8': codecs.BOM_UTF8, 'utf16le': codecs.BOM_UTF16_LE,
           'utf16be': codecs.BOM_UTF16_BE}.get(metadata.get('bom'))
    if bom is None or metadata.get('encoding') not in ('utf-8', 'utf-16-le', 'utf-16-be'):
        raise WorkbenchError('unsupported_encoding')
    try:
        data = bom + normalized.replace('\n', eol).encode(metadata['encoding'], errors='strict')
    except UnicodeError as error:
        raise WorkbenchError('invalid_encoding') from error
    if len(data) > MAX_DOCUMENT_BYTES:
        raise WorkbenchError('too_large')
    verified = decode_document(data, complete=True)
    if verified['reasonCode']:
        raise WorkbenchError(verified['reasonCode'])
    return data


def read_document(identity: WorkspaceIdentity, relative: str, *, preview: bool = False,
                  cancelled: threading.Event | None = None) -> dict[str, Any]:
    def check_cancelled() -> None:
        if cancelled is not None and cancelled.is_set():
            raise WorkbenchError('read_cancelled')
    check_cancelled()
    target = safe_document_path(identity.workingDir, relative)
    document = {'workspace': identity.to_dict(), 'relativePath':
                target.relative_to(Path(identity.workingDir)).as_posix(),
                'canonicalPath': str(target), 'source': 'executor'}
    before = target.stat()
    if not stat.S_ISREG(before.st_mode):
        raise WorkbenchError('not_regular_file')
    limit = PREVIEW_BYTES if preview or before.st_size > MAX_DOCUMENT_BYTES else MAX_DOCUMENT_BYTES
    with target.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if (_descriptor_path(stream) != target or safe_document_path(identity.workingDir, relative) != target
                or _stat_key(opened) != _stat_key(before)):
            raise WorkbenchError('file_changed_during_read')
        try:
            file_id = _file_object_id(stream)
        except WorkbenchError:
            file_id = ''  # 仍可预览，但不提供可用于覆盖保存的基线。
        chunks = []
        remaining = limit + 1
        while remaining:
            check_cancelled()
            chunk = stream.read(min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b''.join(chunks)
        after = os.fstat(stream.fileno())
    check_cancelled()
    if _stat_key(before) != _stat_key(after) or _stat_key(target.stat()) != _stat_key(after):
        raise WorkbenchError('file_changed_during_read')
    complete = len(data) == before.st_size and len(data) <= limit
    decoded = decode_document(data[:limit], complete=complete)
    reason = decoded.pop('reasonCode')
    if not complete:
        reason = 'too_large' if before.st_size > MAX_DOCUMENT_BYTES else 'preview_only'
    elif target.suffix.lower() in NON_TEXT_SUFFIXES:
        reason = 'specialized_preview'
    elif before.st_nlink != 1:
        reason = 'hardlinked_file'
    elif not file_id:
        reason = 'file_identity_unverifiable'
    return {'status': 'ok', 'document': document, **decoded, 'complete': complete,
            'editable': complete and not reason, 'reasonCode': reason,
            'byteLength': before.st_size, 'readByteLength': min(len(data), limit),
            'version': byte_version(data, before, file_id) if complete and file_id else None}
