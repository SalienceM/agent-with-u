"""跨节点只传普通文件树。归档条目按编号读取，绝不解包不可信路径。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import unicodedata
import uuid
import zipfile
from typing import Any

from .deepseek_harness_state import reject_links
from .session_collaboration_store import CollaborationError, canonical
from .task_git import TaskGit, snapshot_path

MAX_FILES = 2000
MAX_FILE = 20 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MAX_ARCHIVE = MAX_TOTAL + 2 * 1024 * 1024
CHUNK = 256 * 1024
SHA = re.compile(r'[0-9a-f]{64}')


def portable_path(name: str) -> None:
    if not isinstance(name, str) or not name or len(name) > 500 or '\\' in name:
        raise CollaborationError('快照路径无效')
    snapshot_path(name)
    parts = name.split('/')
    for part in parts:
        if part in {'', '.', '..'} or part.rstrip(' .') != part or ':' in part or any(ord(c) < 32 for c in part):
            raise CollaborationError('不可移植的快照路径：' + name)
        if part.casefold() in {'.git', '.gitmodules'} or re.fullmatch(r'(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?', part, re.I):
            raise CollaborationError('不支持的快照路径：' + name)


def validate_manifest(rows: Any) -> list[dict]:
    if not isinstance(rows, list) or len(rows) > MAX_FILES:
        raise CollaborationError('项目快照最多 2000 个文件')
    names: set[str] = set()
    total = 0
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'path', 'size', 'sha256', 'mode'}:
            raise CollaborationError('快照清单无效')
        portable_path(row['path'])
        name = unicodedata.normalize('NFC', row['path']).casefold()
        if name in names:
            raise CollaborationError('快照路径大小写或 Unicode 冲突')
        names.add(name)
        if type(row['size']) is not int or not 0 <= row['size'] <= MAX_FILE or row['mode'] not in {'100644', '100755'} or not isinstance(row['sha256'], str) or not SHA.fullmatch(row['sha256']):
            raise CollaborationError('快照文件类型、大小或哈希无效')
        total += row['size']
    if total > MAX_TOTAL:
        raise CollaborationError('项目快照正文超过 64 MiB')
    for name in names:
        if any(str(parent) in names for parent in PurePosixPath(name).parents if str(parent) != '.'):
            raise CollaborationError('快照文件与目录路径冲突')
    return rows


def export_snapshot(git: TaskGit, archive: Path, ref: str) -> dict:
    repo = git.inspect()
    if any(row['blocked'] for row in repo['dirty']):
        raise CollaborationError('项目包含不可复制的修改，请先处理凭据、链接或超限文件')
    git.disable_filters()
    entries = git.run('ls-files', '--stage', '-z').split(b'\0')
    modes = {}
    for token in entries:
        if not token: continue
        header, name = token.split(b'\t', 1)
        mode, _, stage = header.decode('ascii').split()
        if stage != '0' or mode not in {'100644', '100755'}:
            raise CollaborationError('不支持未解决冲突、链接或子模块')
        modes[name.decode('utf-8')] = mode
    names = sorted(set(value.decode('utf-8') for value in git.run('ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0') if value))
    rows: list[dict] = []
    files: list[tuple[dict, bytes]] = []
    total = 0
    for name in names:
        portable_path(name)
        path = Path(git.root) / name; reject_links(path)
        if not path.exists(): continue
        if not path.is_file(): raise CollaborationError('不支持目录或子模块：' + name)
        length = path.stat().st_size; total += length
        if length > MAX_FILE or total > MAX_TOTAL or len(rows) >= MAX_FILES:
            raise CollaborationError('项目快照超出预算（2000 文件 / 单文件 20 MiB / 总计 64 MiB）')
        with path.open('rb') as source: body = source.read(MAX_FILE + 1)
        if len(body) != length: raise CollaborationError('读取期间文件变化：' + name)
        mode = modes.get(name, '100644') if os.name == 'nt' else '100755' if path.stat().st_mode & 0o111 else '100644'
        row = {'path': name, 'size': length, 'mode': mode, 'sha256': hashlib.sha256(body).hexdigest()}
        rows.append(row); files.append((row, body))
    validate_manifest(rows)
    archive.parent.mkdir(parents=True, exist_ok=True); reject_links(archive)
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
        for index, (row, body) in enumerate(files):
            bundle.writestr(str(index), body)
        bundle.writestr('manifest.json', canonical({'version': 1, 'files': rows}))
    tree = snapshot_tree(git, files, archive.parent)
    baseline = git.run('commit-tree', tree, '-p', repo['head'], data=b'AWU project departure baseline\n').decode().strip()
    if git.inspect()['fingerprint'] != repo['fingerprint']:
        raise CollaborationError('导出期间项目变化，请重新预览')
    for row in rows:
        path = Path(git.root) / row['path']; reject_links(path)
        with path.open('rb') as source: body = source.read(MAX_FILE + 1)
        if hashlib.sha256(body).hexdigest() != row['sha256'] or os.name != 'nt' and ('100755' if path.stat().st_mode & 0o111 else '100644') != row['mode']:
            raise CollaborationError('导出期间文件变化：' + row['path'])
    if archive.stat().st_size > MAX_ARCHIVE:
        raise CollaborationError('项目归档超过预算')
    # 保留真实 A 基线；不移动工作分支或主索引。
    git.run('update-ref', ref, baseline, '0' * len(baseline))
    return {'repository': repo, 'baseline': baseline, 'files': len(rows), 'bytes': total,
            'size': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}


def snapshot_tree(git: TaskGit, files: list[tuple[dict, bytes]], scratch: Path) -> str:
    """私有工作树/索引按快照属性构造 tree；批量 hash，禁外部过滤器。"""
    stage = scratch / ('tree-' + uuid.uuid4().hex)
    stage.mkdir(); reject_links(stage)
    index = scratch / ('index-' + uuid.uuid4().hex)
    env = {'GIT_INDEX_FILE': str(index)}
    materialized: list[Path] = []
    try:
        for row, body in files:
            path = stage / row['path']; path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as target: target.write(body)
            materialized.append(path)
        git.disable_filters()
        git.run('read-tree', '--empty', env=env)
        arguments = ('--work-tree=' + str(stage), '-c', 'core.autocrlf=false')
        raw_paths = ''.join('"' + path.as_posix() + '"\n' for path in materialized).encode('utf-8')
        blobs = git.run(*arguments, 'hash-object', '-w', '--stdin-paths', data=raw_paths, env=env).decode().splitlines() if files else []
        if len(blobs) != len(files): raise CollaborationError('快照对象写入不完整')
        entries = b''.join(f"{row['mode']} {oid}\t{row['path']}".encode('utf-8') + b'\0' for (row, _), oid in zip(files, blobs))
        git.run('update-index', '-z', '--index-info', env=env, data=entries)
        return git.run('write-tree', env=env).decode().strip()
    finally:
        # 仅删除本次明确生成的文件；目录留在受管暂存区，不递归清理未知内容。
        index.unlink(missing_ok=True)
        for path in materialized: path.unlink(missing_ok=True)


def read_snapshot(archive: Path, descriptor: dict) -> list[tuple[dict, bytes]]:
    reject_links(archive)
    if archive.stat().st_size != descriptor['size'] or archive.stat().st_size > MAX_ARCHIVE:
        raise CollaborationError('归档大小不匹配')
    if hashlib.sha256(archive.read_bytes()).hexdigest() != descriptor['sha256']:
        raise CollaborationError('归档哈希不匹配')
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if len(infos) > MAX_FILES + 1 or len({i.filename for i in infos}) != len(infos):
            raise CollaborationError('归档条目无效')
        manifest = bundle.getinfo('manifest.json')
        if manifest.file_size > 1024 * 1024:
            raise CollaborationError('快照清单超过预算')
        raw = json.loads(bundle.read(manifest))
        if not isinstance(raw, dict) or set(raw) != {'version', 'files'} or raw['version'] != 1:
            raise CollaborationError('快照版本无效')
        rows = validate_manifest(raw['files'])
        if {i.filename for i in infos} != {'manifest.json', *(str(i) for i in range(len(rows)))}:
            raise CollaborationError('归档包含非清单条目')
        if len(rows) != descriptor['files'] or sum(row['size'] for row in rows) != descriptor['bytes']:
            raise CollaborationError('快照摘要不匹配')
        result = []
        for i, row in enumerate(rows):
            entry = bundle.getinfo(str(i))
            if entry.file_size != row['size'] or entry.flag_bits & 1:
                raise CollaborationError('文件大小或加密标记无效')
            body = bundle.read(entry)
            if hashlib.sha256(body).hexdigest() != row['sha256']:
                raise CollaborationError('文件哈希不匹配：' + row['path'])
            result.append((row, body))
        return result


def import_snapshot(archive: Path, descriptor: dict, root: Path, branch: str,
                    source: str = '', baseline: str = '') -> dict:
    files = read_snapshot(archive, descriptor)
    reject_links(root)
    if root.exists():
        raise CollaborationError('接收目录已存在，保留成果，未覆盖')
    root.parent.mkdir(parents=True, exist_ok=True)
    if source:
        git = TaskGit(source)
    else:
        root.mkdir()
        git = TaskGit(str(root)); git.run('init', '--initial-branch=main', '--template=')
    tree = snapshot_tree(git, files, archive.parent)
    commit = git.run('commit-tree', tree, *(['-p', baseline] if baseline else []), data=b'AWU project handoff\n').decode().strip()
    if source:
        git.run('worktree', 'add', '--no-checkout', '-b', branch, str(root), commit, timeout=60)
    else:
        git.run('update-ref', 'refs/heads/main', commit, '0' * len(commit))
    target = TaskGit(str(root))
    # 手动写正文，避免 checkout 行尾/属性过滤器改变传输字节。
    target.run('read-tree', commit)
    for row, body in files:
        path = root / row['path']; reject_links(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(body)
        if os.name != 'nt':
            path.chmod(0o755 if row['mode'] == '100755' else 0o644)
        if hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']:
            raise CollaborationError('落盘文件校验失败')
    actual = target.repository()
    if actual['head'] != commit:
        raise CollaborationError('目标提交校验失败')
    return {**actual, 'baseline': baseline or commit, 'verifiedFiles': len(files), 'verifiedBytes': descriptor['bytes']}
