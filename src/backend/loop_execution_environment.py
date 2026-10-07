"""LOOP execution identities and bounded evidence; never execution permission.

Host discovery, a native-policy probe and actual tool events are different facts.
Only controlled probes / structured runner events may create confirmed failures.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping

MAX_CHECKS = 16
MAX_DEPENDENCIES = 8
MAX_RESULT_BYTES = 16 * 1024
STATUSES = frozenset({'unknown', 'checking', 'passed', 'blocked', 'unsupported', 'stale'})
COVERAGES = frozenset({'host_discovery', 'native_policy', 'actual_tool'})
ACCESSES = frozenset({'read-only', 'workspace-write'})
REASONS = {
    'env_cli_unresolved': ('当前执行环境无法解析所需 CLI；不能据此断言未安装。', '核对当前入口和运行时配置，在相同策略下重新检查解析及版本。'),
    'env_cli_entry_missing': ('配置的工具入口不存在。', '处理该具体入口后重新发现，并在相同策略下检查。'),
    'env_access_denied': ('当前受限环境拒绝访问所需入口。', '由用户或运维恢复原策略内的合法访问，然后重新检查；不自动放宽权限。'),
    'env_runner_setup_failed': ('原生命令执行器初始化失败；命令尚未确认执行。', '处理原生执行器后，取得覆盖相同故障路径的有效检查证据。'),
    'env_probe_unsupported': ('该执行路径不支持检查，或检查覆盖不足。', '已有阻塞须取得覆盖故障路径的有效证据；不能以宿主成功代替。'),
    'env_probe_timeout': ('环境检查超时。', '确认旧检查进程退出，处理环境后显式重新检查。'),
    'env_probe_failed': ('环境检查未取得有效的完整结果。', '确认旧检查进程退出，核对环境和检查支持后显式重新检查。'),
    'env_unknown': ('执行环境原因尚未确认。', '核对原始阶段详情并取得可靠环境证据，再显式恢复。'),
}
_REF = re.compile(r'^[\w.:/@+ -]{1,240}$')
_HASH = re.compile(r'^[a-f0-9]{16,64}$')
_ENV_KEYS = frozenset({'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'NODE_PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR'})


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def toolchain_revision(env: Mapping[str, str]) -> str:
    """No credentials (including their hashes) enter an environment observation."""
    return digest({k.upper(): str(v) for k, v in env.items() if k.upper() in _ENV_KEYS})


def path_identity(path: str) -> str:
    return os.path.normcase(str(Path(path).resolve()))


@dataclass(frozen=True)
class ExecutionIdentity:
    owner: str
    executor: str
    session_id: str
    workspace: str
    backend_id: str
    transport: str
    role: str
    access: str
    config_revision: str = ''
    runner: str = ''
    runner_version: str = ''
    toolchain_revision: str = ''
    workflow_revision: str = ''
    control_mode: str = 'loop'

    @property
    def fingerprint(self) -> str:
        data = asdict(self)
        data['workspace'] = path_identity(self.workspace)
        return digest(data)

    def summary(self) -> dict:
        return {'identity': self.fingerprint, 'backendId': self.backend_id,
                'transport': self.transport, 'role': self.role, 'access': self.access,
                'controlMode': self.control_mode, 'runnerVersion': self.runner_version}


def _ref(value: Any) -> str:
    return value if isinstance(value, str) and _REF.fullmatch(value) else ''


def _hash(value: Any) -> str:
    return value if isinstance(value, str) and _HASH.fullmatch(value) else ''


def _number(value: Any) -> float:
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value < 1e12 else 0


def _enum(value: Any, allowed: Any, default: str = 'unknown') -> str:
    return value if isinstance(value, str) and value in allowed else default


def normalize_workflow(raw: Any) -> dict:
    if not isinstance(raw, dict) or not raw:
        return {}
    return {key: _ref(raw.get(key)) for key in ('skillId', 'command', 'profileId', 'source')} | {
        'digest': _hash(raw.get('digest')), 'scope': _hash(raw.get('scope')),
        'revision': int(_number(raw.get('revision'))),
    }


def normalize_check(raw: Any) -> dict:
    """Allowlist, not redaction-by-regex: exceptions/env/prose cannot be persisted."""
    if not isinstance(raw, dict) or not raw:
        raw = {}
    status = _enum(raw.get('status'), STATUSES)
    reason = _enum(raw.get('reasonCode'), REASONS, '')
    if status == 'blocked' and not reason:
        reason = 'env_unknown'
    result = {
        'version': 1, 'id': _ref(raw.get('id')), 'identity': _hash(raw.get('identity')),
        'status': status, 'coverage': _enum(raw.get('coverage'), COVERAGES, 'host_discovery'),
        'checkedAt': _number(raw.get('checkedAt')), 'revision': int(_number(raw.get('revision'))),
        'reasonCode': reason, 'reason': REASONS[reason][0] if reason else '',
        'resumeCondition': REASONS[reason][1] if reason else '',
        'backendId': _ref(raw.get('backendId')), 'role': _ref(raw.get('role')),
        'access': _enum(raw.get('access'), ACCESSES),
        'transport': raw.get('transport') if raw.get('transport') in ('app-server', 'exec', 'ssh', 'api') else 'unknown',
        'controlMode': raw.get('controlMode') if raw.get('controlMode') in ('loop', 'manual') else 'unknown',
        'runnerVersion': _ref(raw.get('runnerVersion')), 'dependencyId': _ref(raw.get('dependencyId')),
        'probePath': raw.get('probePath') if raw.get('probePath') in ('command/exec', 'commandExecution', 'host', 'unknown') else 'unknown',
        'boundary': _ref(raw.get('boundary')),
        'scope': _hash(raw.get('scope')),
        'quiesced': raw.get('quiesced') is True,
        'incomplete': raw.get('incomplete') is True,
        'basisRefs': [_ref(v) for v in raw.get('basisRefs', [])[:16] if _ref(v)]
        if isinstance(raw.get('basisRefs'), list) else [],
    }
    # 路径仅保留单独的候选字段；不是任意命令、异常或环境字符串。
    entry = raw.get('entry')
    if (isinstance(entry, str) and len(entry) <= 1024 and os.path.isabs(entry)
            and not any(c in entry for c in '\r\n\x00')):
        result['entry'] = entry
    deps = raw.get('dependencies', [])
    if isinstance(deps, list):
        result['dependencies'] = [_ref(v) for v in deps[:MAX_DEPENDENCIES] if _ref(v)]
        if len(deps) > MAX_DEPENDENCIES:
            result.update(incomplete=True, status='blocked', reasonCode='env_probe_failed',
                          reason=REASONS['env_probe_failed'][0], resumeCondition=REASONS['env_probe_failed'][1])
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_RESULT_BYTES:
        return normalize_check({'status': 'blocked', 'reasonCode': 'env_probe_failed', 'incomplete': True})
    return result


def new_check(identity: ExecutionIdentity, *, status: str = 'unknown', coverage: str = 'host_discovery',
              reason: str = '', **fields: Any) -> dict:
    return normalize_check({**identity.summary(), 'id': uuid.uuid4().hex, 'checkedAt': time.time(),
                            'status': status, 'coverage': coverage, 'reasonCode': reason, **fields})


def normalize_history(raw: Any) -> list[dict]:
    return [normalize_check(v) for v in raw[-MAX_CHECKS:]] if isinstance(raw, list) else []


def normalize_environment(raw: Any) -> dict:
    if not isinstance(raw, dict) or not raw:
        return {'version': 1, 'revision': 0, 'status': 'unknown', 'workflowRef': {}, 'latest': {}, 'blockers': [], 'incomplete': False}
    blockers = raw.get('blockers', [])
    result = {'version': 1, 'revision': int(_number(raw.get('revision'))),
              'status': _enum(raw.get('status'), STATUSES),
              'workflowRef': normalize_workflow(raw.get('workflowRef')),
              'latest': normalize_check(raw['latest']) if raw.get('latest') else {},
              'blockers': [normalize_check(v) for v in blockers[:MAX_DEPENDENCIES]] if isinstance(blockers, list) else [],
              'incomplete': raw.get('incomplete') is True or isinstance(blockers, list) and len(blockers) > MAX_DEPENDENCIES}
    if result['incomplete']:
        result['status'] = 'blocked'
    return result


def check_summary(raw: Any) -> dict:
    value = normalize_check(raw)
    return {k: v for k, v in value.items() if k not in ('entry', 'basisRefs', 'dependencies')}


def environment_summary(raw: Any) -> dict:
    value = normalize_environment(raw)
    return {**value, 'latest': check_summary(value['latest']) if value['latest'] else {},
            'blockers': [check_summary(v) for v in value['blockers']]}


def check_matches(check: dict, identity: ExecutionIdentity, *, now: float | None = None, max_age: float = 60) -> bool:
    value = normalize_check(check)
    age = (time.time() if now is None else now) - value.get('checkedAt', 0)
    return bool(value.get('identity') == identity.fingerprint and value['status'] == 'passed'
                and value['coverage'] != 'host_discovery' and value.get('quiesced')
                and not value.get('incomplete') and 0 <= age <= max_age)


class EnvironmentError(ValueError):
    def __init__(self, code: str, *, quiesced: bool = True) -> None:
        self.code = code if code in REASONS else 'env_unknown'
        self.quiesced = quiesced
        super().__init__(REASONS[self.code][0])


class EnvironmentPause(Exception):
    """无模型请求的环境等待；不能计成调用成功或 Backend 连续故障。"""
    def __init__(self, check: dict) -> None:
        self.check = normalize_check(check)
        self.quiesced = self.check.get('quiesced', False)
        super().__init__(self.check.get('reason') or REASONS['env_unknown'][0])


def safe_entry(path: str, *, windows: bool | None = None) -> str:
    windows = os.name == 'nt' if windows is None else windows
    if (not os.path.isabs(path) or len(path) > 1024 or any(c in path for c in '\r\n\x00')
            or windows and any(c in path for c in '"%!^&|<>()')):
        raise EnvironmentError('env_probe_failed')
    return path


def _existing_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.stat().st_mode)
    except FileNotFoundError:
        return False
    except PermissionError:
        raise EnvironmentError('env_access_denied') from None
    except OSError:
        raise EnvironmentError('env_probe_failed') from None


def discover_openspec(workspace: str, env: Mapping[str, str]) -> dict:
    """Read-only host candidate lookup. NOT proof of availability inside Codex."""
    root = Path(workspace).resolve()
    name = 'openspec.cmd' if os.name == 'nt' else 'openspec'
    local = root / 'node_modules' / '.bin' / name
    candidate = ''
    try:
        if _existing_file(local):
            if not local.resolve().is_relative_to(root):
                raise EnvironmentError('env_probe_failed')
            candidate = safe_entry(str(local))
        else:
            effective_path = next((str(v) for k, v in env.items() if k.upper() == 'PATH'), '')
            for directory in effective_path.split(os.pathsep):
                directory = directory.strip('"')
                if not directory or not Path(directory).is_absolute():
                    continue
                path = Path(directory) / name
                if _existing_file(path):
                    candidate = safe_entry(str(path))
                    break
        return {'entry': candidate, 'coverage': 'host_discovery',
                'reasonCode': '' if candidate else 'env_cli_unresolved', 'dependencyId': 'openspec'}
    except EnvironmentError as exc:
        return {'entry': candidate, 'coverage': 'host_discovery', 'reasonCode': exc.code, 'dependencyId': 'openspec'}


def entry_hint(check: dict, identity: ExecutionIdentity) -> str:
    """Verified entry hints only. Inaccessible paths never become bypass advice."""
    value = normalize_check(check)
    if not check_matches(value, identity) or not value.get('entry'):
        return ''
    entry = safe_entry(value['entry'])
    return ('【本次工具环境证据，不是新增授权】\n'
            + json.dumps({'dependency': value['dependencyId'], 'entry': entry,
                          'access': identity.access, 'checkedAt': value['checkedAt'], 'coverage': value['coverage']}, ensure_ascii=False)
            + '\n按原工作流使用该已核对绝对入口；Windows PowerShell 用 & 加单引号路径（单引号写成两个）。'
              '检查不证明任务完成；若实际调用被拒绝，保留失败，不改用宿主或其他通道绕过。')
