"""按需、有界的工作区导航；不复用具有不同覆盖语义的同步/Git 写接口。"""
from __future__ import annotations

import fnmatch
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Iterator

from pathspec import GitIgnoreSpec

from .engine_workbench import WorkbenchError, WorkspaceIdentity
from .workspace_documents import decode_document, guarded_parent, read_document, safe_document_path

MAX_RESULTS = 500
MAX_ENTRIES = 20000
MAX_SEARCH_BYTES = 32 * 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024
MAX_IGNORE_BYTES = 64 * 1024
MAX_GIT_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 8.0
# 如果 OS 无法确认固定只读 Git 子进程退出，保留原对象；不按 PID 重开/认领。
UNCONFIRMED_GIT: list[subprocess.Popen] = []


class SearchBudget:
    def __init__(self, cancelled: threading.Event) -> None:
        self.cancelled = cancelled
        self.deadline = time.monotonic() + MAX_SECONDS
        self.entries = 0
        self.bytes = 0
        self.ignore_bytes = 0
        self.truncated = False
        self.skipped = 0

    def check(self) -> None:
        if self.cancelled.is_set():
            raise WorkbenchError('search_cancelled')
        if time.monotonic() >= self.deadline:
            raise WorkbenchError('search_timeout')


def _app_ignored(relative: str, patterns: tuple[str, ...]) -> bool:
    parts = relative.split('/')
    return '.git' in parts or any(fnmatch.fnmatch(relative, pat.rstrip('/'))
        or any(fnmatch.fnmatch(part, pat.rstrip('/')) for part in parts) for pat in patterns if pat.strip())


def _git_ignored(relative: str, directory: bool, rules: list[tuple[str, GitIgnoreSpec]]) -> bool:
    ignored = False
    for prefix, spec in rules:
        if relative.startswith(prefix):
            decision = spec.check_file(relative[len(prefix):] + ('/' if directory else '')).include
            if decision is not None:
                ignored = decision
    return ignored


def workspace_files(identity: WorkspaceIdentity, patterns: tuple[str, ...], budget: SearchBudget) -> Iterator[str]:
    root = Path(identity.workingDir)
    stack: list[tuple[str, list[tuple[str, GitIgnoreSpec]]]] = [('', [])]
    while stack:
        prefix, inherited = stack.pop()
        budget.check()
        if prefix.count('/') > 64:
            budget.truncated = True
            continue
        rules = inherited[:]
        ignore_relative = prefix + '.gitignore'
        ignore = safe_document_path(identity.workingDir, ignore_relative)
        if ignore.exists():
            # 过量或不可读的规则不能静默忽略后暴露本应隐藏的文件。
            size = ignore.stat().st_size
            budget.ignore_bytes += size
            if size > MAX_IGNORE_BYTES or budget.ignore_bytes > 1024 * 1024:
                raise WorkbenchError('ignore_limit')
            content = read_document(identity, ignore_relative, cancelled=budget.cancelled)
            if content['readByteLength'] > MAX_IGNORE_BYTES or not content['complete'] or not content['editable']:
                raise WorkbenchError('ignore_unreadable')
            rules.append((prefix, GitIgnoreSpec.from_lines(content['text'].splitlines())))
        directory = root / prefix
        # 目录也使用已固定的父链；不沿目录链接扫描其他工作区。
        safe_document_path(identity.workingDir, prefix + '.awu-search-boundary')
        with guarded_parent(root, directory / '.awu-search-boundary') as fd:
            with os.scandir(directory if fd is None else fd) as entries:
                for entry in entries:
                    budget.check()
                    budget.entries += 1
                    if budget.entries > MAX_ENTRIES:
                        budget.truncated = True
                        return
                    relative = prefix + entry.name
                    if _app_ignored(relative, patterns):
                        continue
                    try:
                        path = safe_document_path(identity.workingDir, relative)
                        is_directory = entry.is_dir(follow_symlinks=False)
                        if _git_ignored(relative, is_directory, rules):
                            continue
                        if is_directory:
                            stack.append((relative + '/', rules))
                        elif entry.is_file(follow_symlinks=False) and path.is_file():
                            yield relative
                    except (OSError, WorkbenchError):
                        budget.skipped += 1


def search_workspace(identity: WorkspaceIdentity, mode: str, query: str,
                     limit: int, patterns: tuple[str, ...], cancelled: threading.Event) -> dict[str, Any]:
    budget = SearchBudget(cancelled)
    rows: list[dict[str, Any]] = []
    needle = query.casefold() if mode == 'files' else query
    for relative in workspace_files(identity, patterns, budget):
        if mode == 'files':
            if needle not in relative.casefold():
                continue
            rows.append({'relativePath': relative})
        else:
            try:
                size = safe_document_path(identity.workingDir, relative).stat().st_size
                if size > MAX_FILE_BYTES:
                    budget.skipped += 1
                    continue
                if budget.bytes + size > MAX_SEARCH_BYTES:
                    budget.truncated = True
                    break
                doc = read_document(identity, relative, cancelled=cancelled)
                budget.bytes += doc['readByteLength']
                if not doc['complete'] or doc['reasonCode'] in (
                        'binary', 'invalid_encoding', 'unsupported_encoding', 'specialized_preview'):
                    budget.skipped += 1
                    continue
            except (OSError, WorkbenchError):
                budget.check()
                budget.skipped += 1
                continue
            # 字面量搜索：不接受可引起灾难回溯的任意正则；列号为 UTF-16 编辑器位置。
            for line_number, line in enumerate(doc['text'].splitlines(), 1):
                budget.check()
                start = line.find(needle)
                if start < 0:
                    continue
                rows.append({'relativePath': relative, 'line': line_number,
                    'column': len(line[:start].encode('utf-16-le')) // 2 + 1,
                    'length': len(needle.encode('utf-16-le')) // 2,
                    'preview': line[max(0, start - 80):start + min(len(needle), 240) + 80],
                    'version': doc['version']})
                if len(rows) >= limit:
                    break
        if len(rows) >= limit:
            budget.truncated = True
            break
    budget.check()
    return {'status': 'ok', 'workspace': identity.to_dict(), 'results': rows,
            'truncated': budget.truncated, 'scannedEntries': budget.entries,
            'scannedBytes': budget.bytes, 'skippedFiles': budget.skipped}


def _git_environment() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'}}
    env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_SYSTEM': os.devnull,
                'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_OPTIONAL_LOCKS': '0',
                'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1',
                'GIT_TERMINAL_PROMPT': '0', 'GIT_LITERAL_PATHSPECS': '1', 'LC_ALL': 'C'})
    return env


def _check_git_metadata(root: str, budget: SearchBudget) -> None:
    # Git 自身可沿 refs/loose objects/pack 的链接读取；先拒绝任何此类链接，
    # 不把 .git 视为天然可信的路径边界。元数据超预算时明确不可比较。
    pending = ['.git']
    count = 0
    while pending:
        relative = pending.pop()
        directory = safe_document_path(root, relative)
        with guarded_parent(Path(root), directory / '.awu-search-boundary') as fd:
            with os.scandir(directory if fd is None else fd) as entries:
                for entry in entries:
                    budget.check()
                    count += 1
                    if count > MAX_ENTRIES:
                        raise WorkbenchError('git_metadata_limit')
                    child = relative + '/' + entry.name
                    safe_document_path(root, child)
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(child)


def _git_read(root: str, args: list[str], budget: SearchBudget) -> bytes:
    """只接受固定无子进程的对象读取命令；不运行 diff/textconv/filter/项目脚本。"""
    if not args or args[0] not in ('rev-parse', 'ls-tree', 'cat-file'):
        raise WorkbenchError('git_operation_denied')
    budget.check()
    executable = shutil.which('git')
    if not executable:
        raise WorkbenchError('git_unavailable')
    binary = Path(executable).resolve()
    if Path(root) in binary.parents or os.name == 'nt' and binary.suffix.lower() != '.exe':
        raise WorkbenchError('git_executable_untrusted')
    # 禁止从工作区向上发现其他仓库；拒绝外部 worktree 元数据/对象链接。
    git_dir = safe_document_path(root, '.git')
    if not git_dir.is_dir():
        raise WorkbenchError('git_repository_unavailable')
    for relative in ('.git/objects', '.git/objects/info', '.git/objects/pack', '.git/HEAD',
                     '.git/config', '.git/commondir', '.git/objects/info/alternates',
                     '.git/objects/info/http-alternates'):
        candidate = safe_document_path(root, relative)
        if candidate.name in ('commondir', 'alternates', 'http-alternates') and candidate.exists():
            raise WorkbenchError('git_external_objects_unsupported')
    _check_git_metadata(root, budget)
    command = [str(binary), '--no-pager', '--no-replace-objects', f'--git-dir={git_dir}',
        f'--work-tree={root}', '-c', 'core.fsmonitor=false', '-c', f'core.hooksPath={os.devnull}',
        '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', *args]
    proc = subprocess.Popen(command, cwd=root, env=_git_environment(), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    chunks: queue.Queue[bytes | None] = queue.Queue(maxsize=4)
    stop = threading.Event()
    def capture() -> None:
        try:
            while not stop.is_set():
                block = proc.stdout.read(16384)
                while not stop.is_set():
                    try:
                        chunks.put(block or None, timeout=.05)
                        break
                    except queue.Full:
                        pass
                if not block:
                    break
        finally:
            proc.stdout.close()
    reader = threading.Thread(target=capture, daemon=True, name='awu-git-read')
    reader.start()
    output = bytearray()
    try:
        while True:
            budget.check()
            try:
                block = chunks.get(timeout=.05)
            except queue.Empty:
                continue
            if block is None:
                break
            if len(output) + len(block) > MAX_GIT_BYTES:
                raise WorkbenchError('git_output_limit')
            output.extend(block)
        while proc.poll() is None:
            budget.check()
            stop.wait(.01)
        if proc.returncode != 0:
            raise WorkbenchError('git_read_failed')
        return bytes(output)
    finally:
        stop.set()
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            UNCONFIRMED_GIT.append(proc)
            raise WorkbenchError('git_cleanup_unconfirmed')
        reader.join(timeout=2)
        if reader.is_alive():
            raise WorkbenchError('git_cleanup_unconfirmed')


def git_comparison(identity: WorkspaceIdentity, relative: str, cancelled: threading.Event) -> dict[str, Any]:
    target = safe_document_path(identity.workingDir, relative)
    relative = target.relative_to(identity.workingDir).as_posix()
    if '.git' in relative.split('/'):
        raise WorkbenchError('invalid_path')
    budget = SearchBudget(cancelled)
    commit = _git_read(identity.workingDir, ['rev-parse', '--verify', 'HEAD^{commit}'], budget).strip()
    if not re.fullmatch(rb'[a-f0-9]{40,64}', commit):
        raise WorkbenchError('git_invalid_response')
    entry = _git_read(identity.workingDir, ['ls-tree', '-z', commit.decode(), '--', relative], budget)
    blob: str | None = None
    data = b''
    if entry:
        records = entry.rstrip(b'\0').split(b'\0')
        if len(records) != 1:
            raise WorkbenchError('git_invalid_response')
        header, _, name = records[0].partition(b'\t')
        match = re.fullmatch(rb'100(?:644|755) blob ([a-f0-9]{40,64})', header)
        if not match or name.decode('utf-8', errors='strict') != relative:
            raise WorkbenchError('git_nontext_entry')
        blob = match[1].decode()
        data = _git_read(identity.workingDir, ['cat-file', 'blob', blob], budget)
    baseline = decode_document(data, complete=True)
    if baseline['reasonCode']:
        raise WorkbenchError('git_nontext_entry')
    try:
        current = read_document(identity, relative, cancelled=cancelled)
    except FileNotFoundError:
        current = {'text': '', 'version': {'exists': False}, 'complete': True, 'editable': True}
    if not current['complete'] or not current['editable']:
        raise WorkbenchError('document_readonly')
    # Python difflib 在大量重复行上可能消耗过量 CPU；基线和磁盘文本即完整比较来源，
    # 不在服务端计算无界 diff，由文档比较视图按其预算展示。
    budget.check()
    return {'status': 'ok', 'workspace': identity.to_dict(), 'relativePath': relative,
            'baseline': {'source': 'git-head', 'commit': commit.decode(), 'blob': blob,
                         'exists': blob is not None, 'text': baseline['text']},
            'disk': {'source': 'disk', 'version': current['version'], 'text': current['text']}}
