"""完整清单驱动的目录上传：正文暂存，复核后提交；不执行 Git。"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import tempfile
import threading
import time
from typing import Any, Callable
import uuid

MAX_FILES = 20000
MAX_BYTES = 8 * 1024 ** 3
CHUNK_BYTES = 1024 ** 2


def relative(value: str, empty: bool = False) -> str:
    if empty and value == '':
        return value
    if (not isinstance(value, str) or len(value) > 4096 or '\\' in value
            or PureWindowsPath(value).drive or value.startswith('/')
            or any(not p or p in ('.', '..') or p.rstrip(' .') != p
                   or re.search(r'[<>:"|?*\x00-\x1f]', p)
                   or re.fullmatch(r'(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?', p)
                   for p in value.split('/'))):
        raise ValueError('非法相对路径')
    return value


def safe_path(root: Path, rel: str) -> Path:
    path = root
    for part in relative(rel, True).split('/') if rel else []:
        path /= part
        if path.is_symlink() or os.path.normcase(os.path.realpath(path)) != os.path.normcase(os.path.abspath(path)):
            raise ValueError(f'不支持符号链接或目录联接：{rel}')
        path.resolve().relative_to(root)
    return path


def ignored(rel: str, patterns: list[str], include_git: bool) -> bool:
    parts = rel.split('/')
    if '.git' in [p.lower() for p in parts]:
        return not include_git
    for pattern in patterns:
        pattern = pattern.strip().rstrip('/')
        if not pattern:
            continue
        expression = re.escape(pattern).replace(r'\*', '.*').replace(r'\?', '.')
        if re.fullmatch(expression, rel) or any(re.fullmatch(expression, p) for p in parts):
            return True
    return False


def file_meta(path: Path) -> dict | None:
    try:
        before = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f'不是普通文件：{path.name}')
    digest = hashlib.sha256()
    count = 0
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(CHUNK_BYTES), b''):
            digest.update(chunk)
            count += len(chunk)
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or count != before.st_size:
        raise ValueError('扫描期间文件发生变化，请重新预览')
    return {'hash': digest.hexdigest(), 'size': count}


def scan(root: Path, scope: str, directory: bool, patterns: list[str], include_git: bool) -> dict:
    """不使用 mtime 哈希缓存，不忽略任何范围内读取错误。"""
    selected = safe_path(root, scope)
    if scope and ignored(scope, patterns, include_git):
        raise ValueError('所选范围被同步规则排除')
    if not selected.exists():
        return {}
    if selected.is_dir() != directory:
        raise ValueError('文件/目录类型冲突')
    files: dict[str, dict] = {}
    total = 0
    def visit(path: Path) -> None:
        nonlocal total
        rel = path.relative_to(root).as_posix()
        if rel != '.' and ignored(rel, patterns, include_git):
            return
        safe_path(root, '' if rel == '.' else rel)
        if path.is_dir():
            with os.scandir(path) as items:
                for entry in items:
                    visit(Path(entry.path))
        else:
            relative(rel)
            meta = file_meta(path)
            if meta is None:
                raise ValueError('扫描期间文件消失')
            files[rel] = meta
            total += meta['size']
            if len(files) > MAX_FILES or total > MAX_BYTES:
                raise ValueError('超出传输扫描预算（20000 文件 / 8 GiB）')
    visit(selected)
    return files


def manifest(value: Any, scope: str, directory: bool, patterns: list[str], include_git: bool) -> dict:
    if not isinstance(value, dict) or len(value) > MAX_FILES:
        raise ValueError('无效源清单')
    result: dict[str, dict] = {}
    folded: set[str] = set()
    for path, meta in value.items():
        relative(path)
        if (directory and scope and not path.startswith(scope + '/') or not directory and path != scope
                or ignored(path, patterns, include_git)):
            raise ValueError('源清单超出确认范围')
        if (not isinstance(meta, dict) or set(meta) != {'hash', 'size'}
                or not isinstance(meta['hash'], str) or not re.fullmatch('[a-f0-9]{64}', meta['hash'])
                or type(meta['size']) is not int or meta['size'] < 0):
            raise ValueError('源文件缺少完整哈希/大小')
        if path.casefold() in folded:
            raise ValueError('路径大小写冲突')
        folded.add(path.casefold())
        result[path] = dict(meta)
    for path in folded:
        parts = path.split('/')
        if any('/'.join(parts[:i]) in folded for i in range(1, len(parts))):
            raise ValueError('源文件/目录冲突')
    if sum(m['size'] for m in result.values()) > MAX_BYTES:
        raise ValueError('超出传输大小预算')
    return result


class DirectoryTransfers:
    """有界进程内计划和回执；重启后未知，绝不重放写请求。"""
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.lock = threading.RLock()

    def plan(self, identity: dict, request: dict, patterns: list[str]) -> dict:
        if set(request) != {'scope', 'directory', 'mirror', 'includeGit', 'source', 'ignore'}:
            raise ValueError('无效传输计划')
        scope = relative(request['scope'], True)
        if any(type(request[k]) is not bool for k in ('directory', 'mirror', 'includeGit')):
            raise ValueError('无效传输模式')
        if not request['directory'] and not scope or request['mirror'] and (not request['directory'] or request['includeGit']):
            raise ValueError('镜像仅支持普通目录，不包含 Git 元数据')
        if request['ignore'] != patterns:
            raise ValueError('同步规则变化，请重新预览')
        root = Path(identity['workingDir']).resolve(strict=True)
        source = manifest(request['source'], scope, request['directory'], patterns, request['includeGit'])
        target = scan(root, scope, request['directory'], patterns, request['includeGit'])
        manifest(target, scope, request['directory'], patterns, request['includeGit'])
        # 新文件不能替换目录或经过文件父路径，包含空目录的冲突也必须拒绝。
        aliases = {p.casefold(): p for p in target}
        for path in source:
            dest = safe_path(root, path)
            if dest.is_dir() or any(p.exists() and not p.is_dir() for p in dest.parents if p != root and root in p.parents):
                raise ValueError(f'文件/目录类型冲突：{path}')
            if path.casefold() in aliases and aliases[path.casefold()] != path:
                raise ValueError('目标路径大小写冲突')
        entries = [{'path': p, 'action': 'skip' if target.get(p) == meta else 'update' if p in target else 'add', **meta}
                   for p, meta in sorted(source.items())]
        if request['mirror']:
            entries += [{'path': p, 'action': 'delete', **target[p]} for p in sorted(target.keys() - source.keys())]
        identifier = str(uuid.uuid4())
        with self.lock:
            for key, old in list(self.rows.items()):
                if old['state'] != 'committing' and time.monotonic() - old['created'] > 1800:
                    self._clean(old)
                    del self.rows[key]
            if len(self.rows) >= 64 or sum(r['state'] == 'preview' for r in self.rows.values()) >= 8:
                raise ValueError('传输计划过多，请关闭旧预览')
            row = {'id': identifier, 'identity': identity, 'root': root, 'rootStat': root.stat(),
                   'request': {**request, 'source': source}, 'target': target, 'entries': entries,
                   'state': 'preview', 'created': time.monotonic(), 'temp': None, 'uploaded': [], 'deleted': []}
            self.rows[identifier] = row
            return self.public(row)

    def public(self, row: dict) -> dict:
        return {'version': 1, 'id': row['id'], 'state': row['state'], 'workspace': row['identity'],
                'scope': row['request']['scope'], 'mirror': row['request']['mirror'], 'entries': row['entries'],
                'uploaded': list(row['uploaded']), 'deleted': list(row['deleted']), 'message': row.get('message', '')}

    def get(self, identity: dict, identifier: str) -> dict:
        row = self.rows.get(identifier)
        if row is None or row['identity'] != identity:
            raise ValueError('原传输计划不可核对，请勿重放提交')
        return row

    def chunk(self, identity: dict, identifier: str, path: str, offset: int, data: str) -> dict:
        with self.lock:
            row = self.get(identity, identifier)
            if row['state'] != 'preview':
                raise ValueError('计划已关闭或已提交')
            entry = next((e for e in row['entries'] if e['path'] == path and e['action'] in ('add', 'update')), None)
            if entry is None or type(offset) is not int or offset < 0 or len(data) > (CHUNK_BYTES + 2) // 3 * 4:
                raise ValueError('无效正文分块')
            content = base64.b64decode(data, validate=True)
            if len(content) > CHUNK_BYTES or offset + len(content) > entry['size']:
                raise ValueError('分块超过冻结大小')
            if row['temp'] is None:
                row['temp'] = tempfile.TemporaryDirectory(prefix='awu-transfer-')
            temp = Path(row['temp'].name) / hashlib.sha256(path.encode()).hexdigest()
            if (temp.stat().st_size if temp.exists() else 0) != offset:
                raise ValueError('分块顺序不符，不能自动重传')
            with temp.open('ab') as stream:
                stream.write(content)
            return {'written': len(content)}

    @staticmethod
    def _clean(row: dict) -> None:
        if row['temp']:
            row['temp'].cleanup()
            row['temp'] = None

    def cancel(self, identity: dict, identifier: str) -> dict:
        with self.lock:
            row = self.get(identity, identifier)
            if row['state'] == 'preview':
                row['state'] = 'cancelled'
                self._clean(row)
            return self.public(row)

    def commit(self, identity: dict, identifier: str, gate: Callable[[], None]) -> dict:
        with self.lock:
            row = self.get(identity, identifier)
            if row['state'] != 'preview':
                return self.public(row)
            if any(r is not row and r['state'] == 'committing' and r['root'] == row['root'] for r in self.rows.values()):
                raise ValueError('目标目录已有传输正在提交')
            row['state'] = 'committing'
        try:
            root, req = row['root'], row['request']
            def check_root() -> None:
                now = root.stat()
                if root.resolve() != root or (now.st_dev, now.st_ino) != (row['rootStat'].st_dev, row['rootStat'].st_ino):
                    raise ValueError('工作目录身份变化')
                gate()
            check_root()
            current = scan(root, req['scope'], req['directory'], req['ignore'], req['includeGit'])
            if current != row['target']:
                raise ValueError('目标内容已变化，请重新预览')
            writes = [e for e in row['entries'] if e['action'] in ('add', 'update')]
            for entry in writes:
                temp = Path(row['temp'].name) / hashlib.sha256(entry['path'].encode()).hexdigest() if row['temp'] else None
                if temp is None or file_meta(temp) != req['source'][entry['path']]:
                    raise ValueError('传输正文不完整或哈希不一致')
            # 全部正文先验收，再逐文件提交；任何失败都停止后续删除。
            for entry in writes:
                path = entry['path']
                check_root()
                dest = safe_path(root, path)
                if file_meta(dest) != row['target'].get(path):
                    raise ValueError(f'目标内容变化：{path}')
                dest.parent.mkdir(parents=True, exist_ok=True)
                temp = Path(row['temp'].name) / hashlib.sha256(path.encode()).hexdigest()
                fd, staged_name = tempfile.mkstemp(prefix='.awu-upload-', dir=dest.parent)
                staged = Path(staged_name)
                try:
                    with os.fdopen(fd, 'wb') as stream, temp.open('rb') as source:
                        shutil.copyfileobj(source, stream, CHUNK_BYTES)
                    check_root()
                    if safe_path(root, path) != dest or file_meta(dest) != row['target'].get(path):
                        raise ValueError(f'目标内容变化：{path}')
                    if dest.exists():
                        os.chmod(staged, stat.S_IMODE(dest.stat().st_mode))
                    os.replace(staged, dest)
                    row['uploaded'].append(path)
                finally:
                    staged.unlink(missing_ok=True)
            expected = {**row['target'], **req['source']}
            if scan(root, req['scope'], req['directory'], req['ignore'], req['includeGit']) != expected:
                raise ValueError('提交后目标变化，已停止后续删除')
            for entry in row['entries']:
                if entry['action'] != 'delete':
                    continue
                path = entry['path']
                check_root()
                dest = safe_path(root, path)
                if file_meta(dest) != row['target'][path]:
                    raise ValueError(f'待删除文件变化：{path}')
                dest.unlink()
                row['deleted'].append(path)
                expected.pop(path)
            if scan(root, req['scope'], req['directory'], req['ignore'], req['includeGit']) != expected:
                raise ValueError('最终内容核验失败')
            row['state'] = 'succeeded'
        except Exception as error:
            row.update(state='failed', message=str(error))
        finally:
            self._clean(row)
        return self.public(row)
