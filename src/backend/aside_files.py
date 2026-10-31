"""有界只读文件服务。Windows 固定祖先句柄，POSIX 逐级 no-follow 打开。"""
from __future__ import annotations

import hashlib
import os
import re
import stat
import time
from contextlib import contextmanager
from itertools import islice
from pathlib import Path
from typing import Iterator

from .aside_inspection import InspectionError, QueryBudget, QueryIdentity, budget_error


SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'dist', 'target', '.venv', 'venv'}
SECRET_NAMES = {'.env', '.npmrc', '.pypirc', '.netrc', 'auth.json', 'credentials',
                'credentials.json', 'oauth_creds.json', 'token.json', 'tokens.json',
                'secrets.json', 'secrets.yaml', 'secrets.yml', 'id_rsa', 'id_ed25519', 'id_ecdsa'}


def sensitive(path: Path) -> bool:
    return any(part.lower() in SECRET_NAMES or part.lower().startswith('.env.') or
               part.lower().endswith(('.pem', '.key', '.p12', '.pfx')) or
               part.lower() in {'.ssh', '.aws', '.azure', '.kube', '.codex', '.qwen', '.claude'}
               for part in path.parts)


def _win_open(path: Path, directory: bool) -> int:
    import ctypes
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
    create.restype = w.HANDLE
    # 不共享 DELETE：持有路径各级目录，防止检查后被重命名/换成 junction。
    handle = create(str(path), 0x80 if directory else 0x80000000, 3, None, 3,
                    0x00200000 | (0x02000000 if directory else 0), None)
    if handle == w.HANDLE(-1).value:
        error = ctypes.get_last_error()
        if error in (2, 3):
            raise FileNotFoundError(str(path))
        raise PermissionError(f'Windows 文件打开失败 ({error})')
    return int(handle)


def _win_close(handle: int) -> None:
    import ctypes
    from ctypes import wintypes as w
    close = ctypes.WinDLL('kernel32', use_last_error=True).CloseHandle
    close.argtypes = [w.HANDLE]
    close.restype = w.BOOL
    close(handle)


def _win_validate(handle: int, expected: Path, directory: bool) -> None:
    import ctypes
    from ctypes import wintypes as w

    class Info(ctypes.Structure):
        _fields_ = [('attrs', w.DWORD), ('created', w.FILETIME), ('accessed', w.FILETIME),
                    ('written', w.FILETIME), ('volume', w.DWORD), ('sizeHigh', w.DWORD),
                    ('sizeLow', w.DWORD), ('links', w.DWORD), ('indexHigh', w.DWORD), ('indexLow', w.DWORD)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    inspect = kernel.GetFileInformationByHandle
    inspect.argtypes = [w.HANDLE, ctypes.POINTER(Info)]
    inspect.restype = w.BOOL
    info = Info()
    if not inspect(handle, ctypes.byref(info)) or info.attrs & 0x400:
        raise InspectionError('denied', '不读取符号链接或 Windows 重解析点。')
    if bool(info.attrs & 0x10) != directory:
        raise InspectionError('unsupported', '查询目标的文件类型不匹配。')
    final_path = kernel.GetFinalPathNameByHandleW
    final_path.argtypes = [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD]
    final_path.restype = w.DWORD
    buf = ctypes.create_unicode_buffer(32768)
    count = final_path(handle, buf, len(buf), 0)
    if not count or count >= len(buf):
        raise InspectionError('denied', '无法核验实际文件句柄目标。')
    final = buf.value.removeprefix('\\\\?\\')
    if os.path.normcase(os.path.normpath(final)) != os.path.normcase(str(expected)):
        raise InspectionError('denied', '实际文件目标与请求路径不同。')


@contextmanager
def secure_open(path: Path, directory: bool) -> Iterator[int]:
    """返回只读 fd；祖先无链接且在整个操作期间保持打开。"""
    if os.name == 'nt':
        import msvcrt
        handles: list[int] = []
        fd = None
        try:
            for ancestor in reversed(path.parents):
                handle = _win_open(ancestor, True)
                handles.append(handle)
                _win_validate(handle, ancestor, True)
            handle = _win_open(path, directory)
            handles.append(handle)
            _win_validate(handle, path, directory)
            if directory:
                yield handle
            else:
                fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
                handles.pop()  # fd 取得句柄拥有权。
                yield fd
        finally:
            if fd is not None:
                os.close(fd)
            for handle in reversed(handles):
                _win_close(handle)
    else:
        descriptors: list[int] = []
        try:
            current = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
            descriptors.append(current)
            parts = path.parts[1:]
            for index, part in enumerate(parts):
                is_dir = index < len(parts) - 1 or directory
                current = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                                  (os.O_DIRECTORY if is_dir else 0), dir_fd=current)
                descriptors.append(current)
            mode = os.fstat(current).st_mode
            if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
                raise InspectionError('unsupported', '只读查询仅支持普通目录或文本文件。')
            yield current
        finally:
            for fd in reversed(descriptors):
                os.close(fd)


class ReadonlyFiles:
    def __init__(self, identity: QueryIdentity, budget: QueryBudget) -> None:
        self.identity = identity
        self.budget = budget
        self.cache: dict[tuple, dict] = {}

    def path(self, raw: str) -> Path:
        root = Path(self.identity.file_root())
        value = raw.replace('\\', '/')
        if value.startswith('//') or any(ord(c) < 32 for c in raw):
            raise InspectionError('denied', '不支持设备、网络或特殊路径。')
        parts = value.split('/')
        if '..' in parts or any(':' in p for p in parts[1:]) or (':' in parts[0] and not re.fullmatch('[A-Za-z]:', parts[0])):
            raise InspectionError('denied', '路径越界或包含特殊流。')
        if not root.is_absolute() or str(root).startswith(('\\\\', '//')):
            raise InspectionError('unsupported', '当前工作区路径不支持安全查询。')
        target = Path(os.path.abspath(raw if os.path.isabs(raw) else root / raw))
        base = Path(os.path.abspath(root))
        try:
            relative = target.relative_to(base)
        except ValueError:
            raise InspectionError('denied', '只允许查询当前 Session 工作区。') from None
        if sensitive(relative) or any(p.lower() in SKIP_DIRS for p in relative.parts):
            raise InspectionError('denied', '该路径属于凭据、内部元数据或依赖/生成目录，不读取。')
        return target

    def relative(self, path: Path) -> str:
        return path.relative_to(Path(os.path.abspath(self.identity.file_root()))).as_posix()

    def directory(self, path: str = '.', offset: int = 0, limit: int = 200) -> dict:
        self.budget.check_discovery()
        target = self.path(path)
        limit = min(max(limit, 1), 200)
        if offset > 2000:
            raise budget_error('directory_page')
        with secure_open(target, True) as handle:
            with os.scandir(str(target) if os.name == 'nt' else handle) as entries:
                # 包括过滤项在内有扫描上限，不能为了凑足页无限枚举。
                page = list(islice(entries, offset, offset + limit + 1))
                items = []
                for entry in page[:limit]:
                    self.budget.check_discovery()
                    if sensitive(Path(entry.name)) or entry.name.lower() in SKIP_DIRS:
                        continue
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                        continue
                    items.append({'name': entry.name, 'directory': stat.S_ISDIR(info.st_mode)})
        return {'status': 'ok', 'path': self.relative(target), 'entries': items, 'offset': offset, 'entryCount': len(items),
                'nextOffset': offset + limit if len(page) > limit else None,
                'complete': len(page) <= limit and offset == 0, 'readAt': time.time()}

    def text(self, path: str, offset: int = 0, limit: int = 16000, revision: str = '',
             *, whole: bool = False, search: bool = False) -> dict:
        self.budget.check_discovery()
        target = self.path(path)
        with secure_open(target, False) as fd:
            before = os.fstat(fd)
            if before.st_size > self.budget.file_bytes:
                raise budget_error('file_bytes')
            # 重新确认文件签名后才复用本次请求中的原文。
            key = (str(target), before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            cached = self.cache.get(key)
            if cached is None:
                self.budget.bytes(before.st_size, search=search)
                data = os.read(fd, before.st_size)
                after = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise InspectionError('changed', '文件在读取期间变化，未合并不同版本。')
                if len(data) != before.st_size or b'\0' in data:
                    raise InspectionError('unsupported', '文件不是完整可读文本。')
                try:
                    content = data.decode('utf-8-sig')
                except UnicodeError:
                    raise InspectionError('unsupported', '目前仅支持 UTF-8 文本，未猜测二进制内容。') from None
                if '-----BEGIN ' in content and 'PRIVATE KEY-----' in content:
                    raise InspectionError('denied', '检测到私钥资料，未返回正文。')
                cached = {'content': content, 'revision': hashlib.sha256(data).hexdigest()}
                self.cache[key] = cached
            if revision and revision != cached['revision']:
                raise InspectionError('changed', '文件修订已变化，请从头读取，不拼接旧页。')
        content = cached['content']
        end = len(content) if whole else min(len(content), offset + min(max(limit, 1), 16000))
        return {'status': 'ok', 'path': self.relative(target), 'content': content[offset:end],
                'revision': cached['revision'], 'offset': offset, 'end': end, 'length': len(content),
                'complete': offset == 0 and end == len(content), 'readAt': time.time()}

    def search(self, path: str, query: str, limit: int = 40) -> dict:
        self.budget.check_discovery()
        if self.budget.search_exhausted or self.budget.used_search_bytes >= self.budget.search_limit:
            raise budget_error('search_bytes')
        limit = min(max(limit, 1), 100)
        pending = [path]
        found, visited, directories = [], 0, 0
        limited = False
        reason = ''
        stop = False
        while pending and visited < 200 and directories < 40 and len(found) < limit:
            directory = pending.pop(0)
            page = self.directory(directory)
            directories += 1
            if not page['complete']:
                limited, reason = True, 'directory_page'
            for entry in page['entries']:
                self.budget.check_discovery()
                child = (Path(directory) / entry['name']).as_posix()
                if entry['directory']:
                    pending.append(child)
                    continue
                if visited >= 200 or len(found) >= limit:
                    limited, reason = True, 'search_scope'
                    break
                visited += 1
                try:
                    document = self.text(child, whole=True, search=True)
                except InspectionError as exc:
                    if exc.code in {'cancelled', 'timeout', 'identity_changed'} or exc.reason == 'answer_reserve':
                        raise
                    limited, reason = True, exc.reason or 'unreadable_files'
                    if exc.reason in {'total_bytes', 'search_bytes'}:
                        stop = True
                        break
                    continue
                except OSError:
                    limited, reason = True, 'unreadable_files'
                    continue
                for number, line in enumerate(document['content'].splitlines(), 1):
                    if query.casefold() in line.casefold():
                        found.append({'path': document['path'], 'line': number, 'text': line[:500],
                                      'revision': document['revision']})
                        if len(found) >= limit:
                            limited, reason = True, 'search_scope'
                            break
            if stop:
                break
        complete = not limited and not pending
        if not complete and not reason:
            reason = 'search_scope'
        return {'status': 'ok', 'path': self.relative(self.path(path)), 'matches': found,
                'visited': visited, 'matchCount': len(found), 'complete': complete, 'readAt': time.time(),
                **({'limitReason': reason} if reason else {})}
