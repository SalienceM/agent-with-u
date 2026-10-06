"""Optional, read-only OpenSpec adapter. Never executes instructions returned by CLI.

Only an explicitly bound LOOP calls this module. All paths belong to its executor
workspace. Checkboxes are state, not implementation acceptance.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import yaml

from .loop_decisions import bounded_object, digest

MAX_BYTES = 1_048_576
MAX_TASKS = 100
PROCESS_TIMEOUT = 20
SNAPSHOT_TIMEOUT = 60
CHANGE = re.compile(r'^[a-z0-9][a-z0-9-]{0,127}$')
NUMBERED = re.compile(r'^(\d+(?:\.\d+)+)\.?\s+(.+)$')
CHECKBOX = re.compile(r'^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$')


class SourceError(Exception):
    def __init__(self, code: str, message: str, *, transient: bool = False):
        super().__init__(message)
        self.code, self.transient = code, transient


def confined(root: Path, value: str | Path) -> Path:
    path = Path(value)
    path = path if path.is_absolute() else root / path
    path = path.resolve()
    if not path.is_relative_to(root.resolve()):
        raise SourceError('path_outside', '来源路径超出当前工作区，不会读取。')
    return path


def read_bytes(root: Path, value: str | Path) -> bytes:
    path = confined(root, value)
    try:
        with path.open('rb') as handle:
            data = handle.read(MAX_BYTES + 1)
    except OSError:
        raise SourceError('file_unavailable', '来源文件不可读，请检查项目与权限。') from None
    if len(data) > MAX_BYTES:
        raise SourceError('output_limit', '来源文件超过 1 MiB 核对上限。')
    return data


def normalized(text: str) -> str:
    return ' '.join(text.split())


def task_rows(root: Path, value: str | Path) -> list[dict]:
    path = confined(root, value)
    try:
        text = read_bytes(root, path).decode('utf-8-sig')
    except UnicodeError:
        raise SourceError('protocol', '任务文件不是受支持的 UTF-8 文本。') from None
    rows: list[dict] = []
    fence = ''
    for line, content in enumerate(text.splitlines(), 1):
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', content)
        if marker:
            token = marker[1]
            if not fence:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = ''
            continue
        if fence:
            continue
        match = CHECKBOX.match(content)
        if not match:
            continue
        description = normalized(match[2])
        identity = NUMBERED.match(description)
        if not identity:
            raise SourceError('unstable_id', '任务缺少显式稳定编号（例如 1.1），不能用 CLI 位置序号代替。')
        rows.append({'id': identity[1], 'description': description, 'done': match[1].lower() == 'x',
                     'sourcePath': path.relative_to(root).as_posix(), 'line': line})
        if len(rows) > MAX_TASKS:
            raise SourceError('task_limit', '正式任务超过 100 项，清单不完整，不能据此收口。')
    return rows


def normalize_snapshot(root: Path, change: str, status: dict, apply: dict, version: str) -> dict:
    """Verify real checkboxes, including 1.13.1's positional-id protocol."""
    if not isinstance(status, dict) or not isinstance(apply, dict):
        raise SourceError('protocol', 'OpenSpec 返回了不支持的 JSON 协议。')
    expected = confined(root, f'openspec/changes/{change}')
    returned = status.get('changeRoot') or apply.get('changeDir')
    if not isinstance(returned, str) or confined(root, returned) != expected or not expected.is_dir():
        raise SourceError('root_mismatch', 'change 根不存在或不属于所选工作区。')
    schema = status.get('schemaName')
    state = apply.get('state')
    if not isinstance(schema, str) or not schema or state not in ('ready', 'blocked', 'all_done'):
        raise SourceError('protocol', '缺少 schema 或受支持的 apply 状态。')
    files = apply.get('contextFiles')
    raw = apply.get('tasks')
    if not isinstance(files, dict) or not isinstance(raw, list) or len(raw) > MAX_TASKS:
        raise SourceError('protocol', '缺少有界任务/工件清单。')
    task_files = files.get('tasks', [])
    if not isinstance(task_files, list) or len(task_files) > 20 or any(not isinstance(p, str) for p in task_files):
        raise SourceError('protocol', '任务文件定位不受支持。')
    # blocked may legitimately have no task file yet, but never becomes zero remaining.
    if state != 'blocked' and (not raw or not task_files):
        raise SourceError('protocol', '没有可核对的正式任务，不能当作全部完成。')
    rows = [row for path in task_files for row in task_rows(root, path)]
    if len(rows) > MAX_TASKS or len({r['id'] for r in rows}) != len(rows):
        raise SourceError('duplicate_id', '任务编号重复或超过容量，无法可靠映射。')
    matched: list[dict] = []
    for task in raw:
        if (not isinstance(task, dict) or not isinstance(task.get('description'), str)
                or not isinstance(task.get('done'), bool)):
            raise SourceError('protocol', '任务缺少 description/done 字段。')
        candidates = [r for r in rows if r['description'] == normalized(task['description']) and r['done'] == task['done']]
        if 'sourcePath' in task or 'line' in task:
            if not isinstance(task.get('sourcePath'), str) or type(task.get('line')) is not int:
                raise SourceError('protocol', '任务定位字段不完整。')
            path = confined(root, task['sourcePath']).relative_to(root).as_posix()
            candidates = [r for r in candidates if r['sourcePath'] == path and r['line'] == task['line']]
        if len(candidates) != 1 or candidates[0] in matched:
            raise SourceError('mapping', 'CLI 与真实 checkbox 不一致或映射有歧义，请重新核对。')
        matched.append(candidates[0])
    if len(matched) != len(rows):
        raise SourceError('mapping', 'CLI 清单遗漏了源文件中的正式任务。')
    artifacts, fingerprints = {}, {}
    all_files = set()
    for group in files.values():
        if not isinstance(group, list) or any(not isinstance(p, str) for p in group):
            raise SourceError('protocol', '工件清单协议不受支持。')
        all_files.update(group)
    if len(all_files) > 100:
        raise SourceError('output_limit', '验收工件过多，不能完整核对。')
    for value in sorted(all_files):
        path = confined(root, value)
        if not path.is_relative_to(expected):
            raise SourceError('path_outside', '验收工件不在所选 change 内。')
        data = read_bytes(root, path)
        relative = path.relative_to(root).as_posix()
        fingerprints[relative] = digest(data.hex())
        if value not in task_files:
            try:
                artifacts[relative] = digest(normalized(data.decode('utf-8-sig')))
            except UnicodeError:
                raise SourceError('protocol', '验收工件不是受支持的文本。') from None
        else:
            # 正式任务外的说明/验收文字同样是范围输入；只去除 checkbox 位。
            text = data.decode('utf-8-sig')
            # 围栏示例不是正式任务，保留内容会把示例排版误判范围，因此以实际
            # 非任务说明独立核对；行号与空白不参与，示例区不提供完成信用。
            lines, fence = [], ''
            for line in text.splitlines():
                marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
                if marker:
                    if not fence:
                        fence = marker[1]
                    elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                        fence = ''
                elif not fence and not CHECKBOX.match(line):
                    lines.append(line)
            artifacts[relative] = digest(normalized(' '.join(lines)))
    scope = sorted((r['id'], r['description'], r['sourcePath']) for r in matched)
    for name in ('config.yaml', 'config.yml'):
        config = root / 'openspec' / name
        if config.exists():
            fingerprints[config.relative_to(root).as_posix()] = digest(read_bytes(root, config).hex())
    return {'version': 1, 'valid': True, 'change': change, 'root': str(root), 'schema': schema,
            'cliVersion': version, 'cliState': state, 'capturedAt': time.time(), 'tasks': matched,
            'scopeDigest': digest([schema, scope, artifacts]), 'stateDigest': digest(matched),
            'artifactDigests': artifacts, 'fileDigests': fingerprints,
            'missingArtifacts': [str(v)[:240] for v in apply.get('missingArtifacts', [])[:100]]
            if isinstance(apply.get('missingArtifacts'), list) else [],
            'instruction': str(apply.get('instruction', ''))[:1200]}


def snapshot_fresh(snapshot: dict) -> bool:
    try:
        root = Path(snapshot['root']).resolve()
        return bool(snapshot.get('valid') and snapshot.get('fileDigests')) and all(
            digest(read_bytes(root, path).hex()) == fingerprint for path, fingerprint in snapshot['fileDigests'].items())
    except (SourceError, KeyError, TypeError, OSError):
        return False


def scope_diff(before: dict, after: dict) -> dict:
    old = {t['id']: t for t in before.get('tasks', [])}
    new = {t['id']: t for t in after.get('tasks', [])}
    return {'added': sorted(new.keys() - old.keys()), 'removed': sorted(old.keys() - new.keys()),
            'changed': sorted(k for k in old.keys() & new.keys() if old[k]['description'] != new[k]['description']
                              or old[k]['sourcePath'] != new[k]['sourcePath']),
            'artifactsChanged': before.get('artifactDigests') != after.get('artifactDigests')}


def reconcile(snapshot: dict, report: dict) -> dict:
    tasks = {t['id']: t for t in snapshot.get('tasks', [])}
    items = report.get('items', [])
    reported = {t['id']: t for t in items}
    missing, extra = sorted(tasks.keys() - reported.keys()), sorted(reported.keys() - tasks.keys())
    conflicts = [key for key, task in tasks.items() if not task['done']
                 and reported.get(key, {}).get('status') == 'verified']
    manual = [key for key in tasks if reported.get(key, {}).get('status') == 'manual'
              and reported[key].get('manualBasis')]
    source_text = str(report.get('source') or '').replace('\\', '/')
    source_match = bool(snapshot.get('change') and re.search(r'(?<![\w-])' + re.escape(snapshot['change']) + r'(?![\w-])', source_text))
    mapping_valid = bool(snapshot.get('valid') and snapshot.get('cliState') != 'blocked' and tasks
                         and report.get('valid') and source_match and not missing and not extra
                         and len(items) == len(reported))
    ok = bool(mapping_valid and not conflicts
              and all(t['done'] or key in manual for key, t in tasks.items()))
    return {'valid': ok, 'mappingValid': mapping_valid, 'missing': missing, 'extra': extra, 'uncheckedVerified': conflicts, 'sourceMismatch': not source_match,
            'manualIds': manual, 'total': len(tasks), 'checked': sum(t['done'] for t in tasks.values())}


def validate_source(raw: Any) -> dict:
    value = bounded_object(raw, 3_145_728)
    if not value or value.get('status') == 'invalid':
        return value
    if value.get('status') == 'unbound':
        return value
    binding = value.get('binding')
    valid = (isinstance(binding, dict) and all(isinstance(binding.get(k), str) and binding[k]
             for k in ('executor', 'sessionId', 'workspace', 'backendId', 'environmentDigest', 'cli', 'change'))
             and type(value.get('revision')) is int and value['revision'] >= 1)
    for name in ('snapshot', 'candidate'):
        snap = value.get(name)
        if snap:
            tasks = snap.get('tasks') if isinstance(snap, dict) else None
            valid = valid and isinstance(tasks, list) and len(tasks) <= MAX_TASKS
            if isinstance(tasks, list):
                ids = [t.get('id') for t in tasks if isinstance(t, dict)]
                valid = valid and len(ids) == len(tasks) and all(isinstance(v, str) for v in ids) and len(set(ids)) == len(ids)
                valid = valid and all(isinstance(t, dict) and isinstance(t.get('description'), str)
                    and type(t.get('done')) is bool and type(t.get('line')) is int and t['line'] > 0
                    and isinstance(t.get('sourcePath'), str) and not Path(t['sourcePath']).is_absolute()
                    and '..' not in Path(t['sourcePath']).parts for t in tasks)
    if not valid:
        value.update(valid=False, status='invalid')
    return value


def source_summary(source: dict) -> dict:
    if not source:
        return {'status': 'unbound', 'revision': 0}
    snap = source.get('snapshot') or {}
    binding = source.get('binding') or {}
    return {'status': source.get('status', 'invalid'), 'revision': source.get('revision', 0),
            'scopeRevision': source.get('scopeRevision', 0), 'change': binding.get('change', ''),
            'executor': binding.get('executor', ''), 'backendId': binding.get('backendId', ''),
            'workspace': binding.get('workspace', ''), 'checkedAt': snap.get('capturedAt', 0),
            'total': len(snap.get('tasks', [])), 'checked': sum(t.get('done') is True for t in snap.get('tasks', [])),
            'reason': source.get('reason', '')[:1200], 'code': source.get('code', ''),
            'diff': source.get('diff', {})}


def environment(session: Any, config: Any, executor: str) -> tuple[dict, dict[str, str]]:
    if getattr(session, 'codex_connection_mode', '') == 'ssh':
        raise SourceError('remote_filesystem', '首版不支持 SSH 文件系统来源。')
    root = Path(session.working_dir).resolve()
    if not (root / 'openspec').is_dir():
        raise SourceError('project_required', '当前工作区没有 openspec；不会借用父项目或自动初始化。')
    confined(root, 'openspec')
    for name in ('config.yaml', 'config.yml'):
        path = root / 'openspec' / name
        if path.exists():
            try:
                obj = yaml.safe_load(read_bytes(root, path))
                if not isinstance(obj, dict) or 'store' in obj:
                    raise SourceError('external_store', '不支持外部或声明式 store 来源，请选择工作区内 change。')
            except yaml.YAMLError:
                raise SourceError('config_invalid', 'OpenSpec 配置无法安全解析。') from None
    # Windows env keys are case-insensitive; an explicit Backend PATH wins.
    env = dict(os.environ)
    for key, value in (getattr(config, 'env', None) or {}).items():
        if value is not None:
            if key.upper() == 'PATH':
                env = {k: v for k, v in env.items() if k.upper() != 'PATH'}
                key = 'PATH'
            env[key] = str(value)
    exe = 'openspec.cmd' if os.name == 'nt' else 'openspec'
    local = root / 'node_modules' / '.bin' / exe
    cli = str(confined(root, local)) if local.is_file() else shutil.which(exe, path=env.get('PATH', ''))
    if not cli:
        raise SourceError('cli_missing', '当前 execute Backend 的项目/PATH 中没有 OpenSpec CLI；请自行安装后重试。')
    binding = {'executor': executor, 'sessionId': session.id, 'workspace': str(root),
               'backendId': config.id, 'cli': str(Path(cli).resolve())}
    # Environment values are used only in a one-way fingerprint, never persisted/logged.
    binding['environmentDigest'] = digest([binding, env, str(getattr(config, 'type', '')),
        {key: getattr(config, key, None) for key in ('model', 'cli_path', 'working_dir', 'allowed_tools', 'skip_permissions', 'base_url')}])
    return binding, env


def command(cli: str, args: list[str]) -> list[str]:
    allowed = args == ['--version'] or args == ['list', '--json'] or (
        len(args) in (4, 5) and args[-1] == '--json' and args[-3] == '--change'
        and CHANGE.fullmatch(args[-2]) and (len(args) == 4 and args[:1] == ['status'] or len(args) == 5 and args[:2] == ['instructions', 'apply']))
    if not allowed:
        raise SourceError('arguments', '拒绝未允许的来源查询参数。')
    if os.name == 'nt' and Path(cli).suffix.lower() in ('.cmd', '.bat'):
        if any(c in cli for c in '\r\n"%!^&|<>'):
            raise SourceError('cli_path', 'CLI 包装路径包含不受支持的 shell 字符。')
        # Every dynamic argument except the quoted executable is allowlisted above.
        return [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/s', '/c', subprocess.list2cmdline([cli, *args])]
    return [cli, *args]


async def run_query(cli: str, args: list[str], root: Path, env: dict[str, str]) -> str:
    proc = None
    async def stream(reader: asyncio.StreamReader) -> bytes:
        chunks, size = [], 0
        while True:
            part = await reader.read(65536)
            if not part:
                return b''.join(chunks)
            size += len(part)
            if size > MAX_BYTES:
                raise SourceError('output_limit', '查询输出超过 1 MiB，未使用截断清单。')
            chunks.append(part)
    try:
        proc = await asyncio.create_subprocess_exec(*command(cli, args), cwd=str(root), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        out, _err, code = await asyncio.wait_for(asyncio.gather(stream(proc.stdout), stream(proc.stderr), proc.wait()), PROCESS_TIMEOUT)
        if code:
            raise SourceError('cli_exit', f'只读查询退出码 {code}；未把错误文本当作任务。', transient=True)
        return out.decode('utf-8-sig')
    except asyncio.TimeoutError:
        raise SourceError('timeout', '只读查询超时，未使用旧快照放行。', transient=True) from None
    except (OSError, UnicodeError):
        raise SourceError('cli_unavailable', '无法启动或解码 OpenSpec 查询。') from None
    finally:
        if proc is not None and proc.returncode is None:
            if os.name == 'nt':
                killer = await asyncio.create_subprocess_exec('taskkill', '/pid', str(proc.pid), '/t', '/f',
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, creationflags=0x08000000)
                try:
                    await asyncio.wait_for(killer.wait(), 3)
                except asyncio.TimeoutError:
                    killer.kill()
                    await killer.wait()
            if proc.returncode is None:
                proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), 3)
            except asyncio.TimeoutError:
                raise SourceError('exit_unconfirmed', '查询进程退出未确认，必须人工核对。') from None


class TaskSourceReader:
    """Coalesce only a single explicit boundary/revision; no timers or polling."""
    def __init__(self, runner=run_query):
        self.runner = runner
        self.pending: dict[str, asyncio.Task] = {}
        self.cache: OrderedDict[str, dict] = OrderedDict()

    async def _query(self, binding: dict, env: dict, args: list[str], *, json_result: bool = True):
        import json
        text = await self.runner(binding['cli'], args, Path(binding['workspace']), env)
        if not json_result:
            if not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][\w.-]+)?', text.strip()):
                raise SourceError('version', 'OpenSpec 版本输出不受支持。')
            return text.strip()
        try:
            result = json.loads(text)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, RecursionError):
            raise SourceError('protocol', 'OpenSpec 没有返回受支持的 JSON 对象。') from None

    async def read(self, binding: dict, env: dict, boundary: str, revision: int, change: str = '', *, force: bool = False) -> dict:
        if change and not CHANGE.fullmatch(change):
            raise SourceError('arguments', 'change 标识无效。')
        key = digest([binding, boundary, revision, change])
        if not force and change and key in self.cache and snapshot_fresh(self.cache[key]):
            return bounded_object(self.cache[key])
        if key not in self.pending:
            self.pending[key] = asyncio.create_task(self._bounded(binding, env, change))
            def collected(task: asyncio.Task) -> None:
                if self.pending.get(key) is task:
                    self.pending.pop(key, None)
                if not task.cancelled() and task.exception() is None and change:
                    self.cache[key] = task.result()
                    self.cache.move_to_end(key)
                    while len(self.cache) > 32:
                        self.cache.popitem(last=False)
            self.pending[key].add_done_callback(collected)
        task = self.pending[key]
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and self.pending.get(key) is task:
                self.pending.pop(key, None)

    async def _bounded(self, binding: dict, env: dict, change: str) -> dict:
        async def collect() -> dict:
            version = await self._query(binding, env, ['--version'], json_result=False)
            listing = await self._query(binding, env, ['list', '--json'])
            root = Path(binding['workspace'])
            returned = listing.get('root')
            if not isinstance(returned, dict) or not isinstance(returned.get('path'), str) or Path(returned['path']).resolve() != root:
                raise SourceError('root_mismatch', 'CLI 指向父项目或外部 store；不采纳该来源。')
            candidates = listing.get('changes')
            if not isinstance(candidates, list) or len(candidates) > 100 or any(
                not isinstance(c, dict) or not isinstance(c.get('name'), str) or not CHANGE.fullmatch(c['name']) for c in candidates):
                raise SourceError('protocol', 'change 候选协议不受支持。')
            if not change:
                return {'binding': {**binding, 'cliVersion': version},
                        'candidates': [{'name': c['name']} for c in candidates]}
            if change not in [c['name'] for c in candidates]:
                raise SourceError('change_missing', '绑定的 change 不存在或已归档，不会改绑其他 change。')
            status = await self._query(binding, env, ['status', '--change', change, '--json'])
            apply = await self._query(binding, env, ['instructions', 'apply', '--change', change, '--json'])
            result = normalize_snapshot(root, change, status, apply, version)
            if bounded_object(result).get('status') == 'invalid':
                raise SourceError('output_limit', '规范化快照超过 1 MiB，未使用截断清单。')
            return result
        async def retry() -> dict:
            for attempt in range(2):
                try:
                    return await collect()
                except SourceError as exc:
                    if attempt or not exc.transient:
                        raise
            raise AssertionError('unreachable')
        try:
            return await asyncio.wait_for(retry(), SNAPSHOT_TIMEOUT)
        except asyncio.TimeoutError:
            raise SourceError('timeout', '来源快照流程超过 60 秒，已停止查询。') from None
