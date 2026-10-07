"""Deterministic, bounded Codex sandbox probes. No model or host task fallback."""
from __future__ import annotations

import asyncio
import base64
import errno
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from .loop_execution_environment import ExecutionIdentity, EnvironmentError, new_check, safe_entry, path_identity
from .codex_app_server import CodexAppServerProcess
from .owned_process_tree import OwnedProcessTree

PROBE_TIMEOUT = 10.0
FLOW_TIMEOUT = 30.0
OUTPUT_CAP = 32 * 1024
NATIVE_CAPTURE_CAP = 1024 * 1024
# 两个原生流各 1 MiB，JSON 控制字符最坏六倍转义；另留固定协议余量。
FRAME_CAP = NATIVE_CAPTURE_CAP * 12 + 65536
VERIFIED_WINDOWS_VERSIONS = frozenset({'0.154.0'})


class ProbeAppServerProcess(CodexAppServerProcess):
    """自动边界独占的连接：固定错误、有限队列、可核对的进程树退出。"""
    lease: OwnedProcessTree | None = None
    cleanup_confirmed = False

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.lease = None
        self.cleanup_confirmed = False
        self._spawn_observed = False
        self._spawn_absent_confirmed = False

    async def start(self) -> None:
        for attempt in range(2):
            self._spawn_absent_confirmed = False
            self.cleanup_confirmed = False
            try:
                await super().start()
                return
            except Exception as exc:
                # 基类仅包装了“未找到入口”；取消或未知异常不等于未创建进程。
                cause = exc.__cause__ if isinstance(exc, RuntimeError) and isinstance(exc.__cause__, FileNotFoundError) else exc
                transient = isinstance(cause, BlockingIOError) and cause.errno in (errno.EAGAIN, errno.EBUSY)
                self._spawn_absent_confirmed = (
                    not self._spawn_observed and self.proc is None and self.lease is None
                    and (isinstance(cause, (FileNotFoundError, PermissionError)) or transient))
                # 仅在 OS 明确报告尚未创建进程的瞬态资源忙时重试一次。
                # 已启动/发送请求后的失败不具备幂等证据，绝不自动重试。
                if attempt or not self._spawn_absent_confirmed or not transient:
                    raise
                await asyncio.sleep(0)

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while await self.proc.stderr.read(4096):
            pass

    def _process_started(self) -> None:
        self._spawn_observed = True
        self._spawn_absent_confirmed = False
        if self.proc:
            self.lease = OwnedProcessTree(self.proc)

    async def request(self, method: str, params: dict, timeout: float = 30) -> Any:
        # 小帧限制仅用于固定预检；同一连接的正式轮次/恢复保留正常 128 MiB 契约。
        frame_cap = FRAME_CAP if method in {
            'initialize', 'config/read', 'configRequirements/read', 'command/exec', 'command/exec/terminate',
        } else self.stream_limit
        request_id = self._next_id
        self._next_id += 1
        await self.send({'id': request_id, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        for _ in range(128):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError
            message = await self.read_bounded(remaining, frame_cap)
            if message.get('id') == request_id and ('result' in message or 'error' in message):
                if 'error' in message:
                    raise EnvironmentError(native_error_code(message['error']), quiesced=False)
                return message['result']
            if len(self._queued) >= 128:
                raise EnvironmentError('env_probe_failed', quiesced=False)
            self._queued.append(message)
        raise EnvironmentError('env_probe_failed', quiesced=False)

    async def close(self) -> None:
        proc = self.proc
        if proc and not self.lease:
            self.lease = OwnedProcessTree(proc)
        if self.lease:
            try:
                self.cleanup_confirmed = await self.lease.stop()
            except Exception:
                self.cleanup_confirmed = False
        elif self._spawn_absent_confirmed and not self._spawn_observed and proc is None:
            self.cleanup_confirmed = True
        try:
            await super().close()
            if proc and proc.returncode is None:
                await asyncio.wait_for(proc.wait(), 2)
        finally:
            if self.lease and self.cleanup_confirmed:
                self.lease.release()
                self.lease = None


def probe_policy(access: str, cwd: str) -> dict:
    if access == 'read-only':
        return {'type': 'readOnly', 'networkAccess': False}
    if access == 'workspace-write':
        return {'type': 'workspaceWrite', 'networkAccess': False,
                'writableRoots': [str(Path(cwd).resolve())], 'excludeTmpdirEnvVar': False, 'excludeSlashTmp': False}
    raise EnvironmentError('env_probe_unsupported')


def checked_policy(raw: Any, identity: ExecutionIdentity) -> dict:
    """Use the returned native policy, not a guessed full-access default."""
    if not isinstance(raw, dict) or raw.get('type') != {'read-only': 'readOnly', 'workspace-write': 'workspaceWrite'}.get(identity.access):
        raise EnvironmentError('env_probe_unsupported')
    allowed = {'type', 'networkAccess'}
    if identity.access == 'workspace-write':
        allowed |= {'writableRoots', 'excludeTmpdirEnvVar', 'excludeSlashTmp'}
    if set(raw) - allowed or type(raw.get('networkAccess', False)) is not bool:
        raise EnvironmentError('env_probe_unsupported')
    if identity.access == 'workspace-write':
        roots = raw.get('writableRoots', [])
        if not isinstance(roots, list) or len(roots) > 32 or any(not isinstance(v, str) or not Path(v).is_absolute() for v in roots):
            raise EnvironmentError('env_probe_unsupported')
        if any(type(raw.get(k, False)) is not bool for k in ('excludeTmpdirEnvVar', 'excludeSlashTmp')):
            raise EnvironmentError('env_probe_unsupported')
    return dict(raw)


async def effective_probe_policy(conn: Any, identity: ExecutionIdentity, bootstrap: Any = None) -> dict:
    """只采用原生有效策略；独立检查不创建 thread/turn，也不读取原始配置落盘。"""
    if os.name != 'nt' or getattr(conn, 'server_version', '') not in VERIFIED_WINDOWS_VERSIONS:
        raise EnvironmentError('env_probe_unsupported')
    response = await conn.request('config/read', {'cwd': path_identity(identity.workspace), 'includeLayers': False}, timeout=5)
    config = response.get('config') if isinstance(response, dict) else None
    if not isinstance(config, dict):
        raise EnvironmentError('env_probe_unsupported')
    # command/exec 没有模型 shell 环境过滤或新 permissions profile 的等价承诺。
    shell_environment = config.get('shell_environment_policy')
    default_shell = shell_environment is None or (isinstance(shell_environment, dict)
        and not set(shell_environment) - {'inherit', 'ignore_default_excludes', 'exclude', 'set', 'include_only', 'filters', 'experimental_use_profile'}
        and all(value is None for value in shell_environment.values()))
    if any(config.get(key) for key in ('permissions', 'default_permissions')) or not default_shell:
        raise EnvironmentError('env_probe_unsupported')
    if bootstrap is not None:
        if not isinstance(bootstrap, dict) or path_identity(str(bootstrap.get('cwd') or '')) != path_identity(identity.workspace):
            raise EnvironmentError('env_probe_unsupported')
        return checked_policy(bootstrap.get('sandbox'), identity)
    requirements = await conn.request('configRequirements/read', {}, timeout=5)
    if not isinstance(requirements, dict) or requirements.get('requirements') is not None:
        # 不猜测托管约束在 thread 创建时的合并结果。
        raise EnvironmentError('env_probe_unsupported')
    policy = probe_policy(identity.access, identity.workspace)
    if identity.access == 'workspace-write':
        write = config.get('sandbox_workspace_write') or {}
        fields = {'network_access': 'networkAccess', 'writable_roots': 'writableRoots',
                  'exclude_tmpdir_env_var': 'excludeTmpdirEnvVar', 'exclude_slash_tmp': 'excludeSlashTmp'}
        if not isinstance(write, dict) or set(write) - fields.keys():
            raise EnvironmentError('env_probe_unsupported')
        policy.update({target: write[source] for source, target in fields.items() if source in write})
    return checked_policy(policy, identity)


def native_error_code(error: Any) -> str:
    """Only for protocol error envelopes, NEVER arbitrary command stdout."""
    if not isinstance(error, dict):
        return 'env_unknown'
    if error.get('code') in (-32601, -32602):
        return 'env_probe_unsupported'
    message = str(error.get('message') or '')[:16000]
    if error.get('code') == -32600 and message in {
        'custom outputBytesCap is not supported with windows sandbox',
        'streaming command/exec is not supported with windows sandbox',
        'command/exec/write, command/exec/terminate, and command/exec/resize are not supported for windows sandbox processes',
    }:
        return 'env_probe_unsupported'
    if error.get('code') == -32603 and message == 'exec failed: sandbox error: command timed out':
        return 'env_probe_timeout'
    if 'orchestrator_helper_incomplete' in message:
        return 'env_runner_setup_failed'
    if re.search(r'(?i)(access(?: is)? denied|permission denied|UnauthorizedAccess|拒绝访问)', message):
        return 'env_access_denied'
    return 'env_probe_failed'


async def command_exec(conn: Any, command: list[str], cwd: str, policy: dict, *, timeout: float = PROBE_TIMEOUT) -> dict:
    """Single reader, total deadline, bounded notifications, explicit termination."""
    request_id = conn._next_id
    conn._next_id += 1
    process_id = 'awu-probe-' + uuid.uuid4().hex
    deadline = time.monotonic() + timeout
    windows_compat = getattr(conn, 'server_version', '') in VERIFIED_WINDOWS_VERSIONS and os.name == 'nt'
    lease = getattr(conn, 'lease', None)
    if lease:
        lease.capture()
    params = {
        'command': command, 'cwd': cwd, 'sandboxPolicy': policy,
        'timeoutMs': max(1, int(timeout * 1000)),
        'processId': process_id, 'streamStdoutStderr': False, 'tty': False,
    }
    if not windows_compat:
        params['outputBytesCap'] = OUTPUT_CAP
    await conn.send({'id': request_id, 'method': 'command/exec', 'params': params})
    async def read(remaining: float) -> dict:
        if hasattr(conn, 'read_bounded'):
            return await conn.read_bounded(remaining, FRAME_CAP if windows_compat else OUTPUT_CAP * 12 + 65536)
        return await conn._read_one(remaining)
    terminal = False
    notifications = 0
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError
            message = await read(remaining)
            if message.get('id') == request_id and ('result' in message or 'error' in message):
                terminal = True
                if 'error' in message:
                    code = native_error_code(message['error'])
                    raise EnvironmentError(code, quiesced=code == 'env_probe_unsupported')
                result = message.get('result')
                if (not isinstance(result, dict) or type(result.get('exitCode')) is not int
                        or any(not isinstance(result.get(k), str) or len(result[k].encode('utf-8')) >= OUTPUT_CAP for k in ('stdout', 'stderr'))):
                    raise EnvironmentError('env_probe_failed')
                return result
            notifications += 1
            if notifications > 128 or len(json.dumps(message).encode('utf-8')) > 64 * 1024:
                raise EnvironmentError('env_probe_failed', quiesced=False)
            if 'id' in message and message.get('method'):
                # 预检从不批准原生权限请求。
                await conn.respond(message['id'], error={'code': -32601, 'message': 'Unsupported probe interaction'})
            # command/exec 不创建模型轮次；无关通知不无限堆入模型事件队列。
    except (asyncio.CancelledError, Exception) as exc:
        quiesced = terminal and (not isinstance(exc, EnvironmentError) or exc.quiesced)
        if windows_compat and not quiesced:
            # Windows 不支持 terminate；取消后仍保持唯一 reader/活动租约。
            if not terminal:
                cleanup_deadline = max(deadline, time.monotonic()) + 3
                try:
                    for _ in range(128):
                        remaining = cleanup_deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        message = await read(remaining)
                        if message.get('id') == request_id and ('result' in message or 'error' in message):
                            terminal = True
                            break
                except (Exception, asyncio.CancelledError):
                    pass
            # 超时错误只证明协议已返回；退出证据来自拥有的进程树收口。
            try:
                await conn.close()
                quiesced = getattr(conn, 'cleanup_confirmed', False)
            except (Exception, asyncio.CancelledError):
                quiesced = False
        elif not terminal:
            terminate_id = conn._next_id
            conn._next_id += 1
            try:
                await conn.send({'id': terminate_id, 'method': 'command/exec/terminate', 'params': {'processId': process_id}})
                cleanup_deadline = time.monotonic() + 3
                for _ in range(128):
                    remaining = cleanup_deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    message = await read(remaining)
                    if message.get('id') == request_id and ('result' in message or 'error' in message):
                        terminal = True
                        quiesced = True
                        break
            except (Exception, asyncio.CancelledError):
                pass
        if isinstance(exc, asyncio.CancelledError):
            exc.probe_quiesced = quiesced
            raise
        code = exc.code if isinstance(exc, EnvironmentError) else 'env_probe_timeout' if isinstance(exc, asyncio.TimeoutError) else 'env_probe_failed'
        raise EnvironmentError(code, quiesced=quiesced) from None


def windows_lookup_command(entry: str, nonce: str, *, system_root: str) -> list[str]:
    if entry:
        safe_entry(entry, windows=True)
    # 路径使用单引号转义后编码，不经过外层 shell 插值。
    literal = entry.replace("'", "''")
    script = """$ErrorActionPreference='Stop'; $state='resolved'; $entry='ENTRY'; $runtime='';
try {
  if (!$entry) { $entry=(Get-Command openspec.cmd -CommandType Application -ErrorAction Stop).Source }
  $item=Get-Item -LiteralPath $entry -ErrorAction Stop;
  if ($item.PSIsContainer) { $state='entry_missing' } else { $entry=$item.FullName;
    $null=Get-Content -LiteralPath $entry -Encoding Byte -TotalCount 1 -ErrorAction Stop;
    $near=Join-Path (Split-Path -LiteralPath $entry) 'node.exe';
    if (Test-Path -LiteralPath $near -PathType Leaf -ErrorAction Stop) { $runtime=$near }
    else { try { $runtime=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source }
      catch [System.Management.Automation.CommandNotFoundException] { $state='runtime_missing' } }
  }
} catch {
  if ($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception -is [System.UnauthorizedAccessException] -or $_.Exception.InnerException -is [System.UnauthorizedAccessException]) { $state='denied' }
  elseif ($_.CategoryInfo.Category -eq 'ObjectNotFound') { if ($entry) { $state='entry_missing' } else { $state='unresolved' } }
  else { $state='error' }
}
$json=@{nonce='NONCE';state=$state;entry=$entry;runtime=$runtime} | ConvertTo-Json -Compress;
($json.ToCharArray() | ForEach-Object { if ([int]$_ -gt 127) { '\\u{0:x4}' -f [int]$_ } else { [string]$_ } }) -join ''
""".replace('ENTRY', literal).replace('NONCE', nonce)
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    shell = str(Path(system_root) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
    return [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]


def windows_version_command(entry: str, *, system_root: str) -> list[str]:
    safe_entry(entry, windows=True)
    # 入口作为独立 argv 交给原生 Windows 引号编码；不把带双引号的整句
    # 再编码一次（否则 CreateProcess 会传入反斜杠转义，cmd 不按 CRT 解码）。
    return [str(Path(system_root) / 'System32/cmd.exe'), '/d', '/c', entry, '--version']


async def probe_environment(conn: Any, identity: ExecutionIdentity, *, dependencies: list[str],
                            entry: str = '', policy: dict | None = None, system_root: str = '') -> dict:
    if (os.name != 'nt' or identity.transport != 'app-server'
            or getattr(conn, 'server_version', '') not in VERIFIED_WINDOWS_VERSIONS):
        return new_check(identity, status='unsupported', reason='env_probe_unsupported', quiesced=True)
    start = time.monotonic()
    def remaining() -> float:
        left = FLOW_TIMEOUT - (time.monotonic() - start)
        if left <= 0:
            raise EnvironmentError('env_probe_timeout')
        return min(PROBE_TIMEOUT, left)
    try:
        native_policy = checked_policy(policy, identity) if policy is not None else probe_policy(identity.access, identity.workspace)
        # 基础 runner 检查也必须在原生沙箱中执行。
        shell = str(Path(system_root or os.environ.get('SYSTEMROOT', r'C:\Windows')) / 'System32/cmd.exe')
        basic = await command_exec(conn, [shell, '/d', '/c', 'echo AWU_LOOP_PROBE'], identity.workspace, native_policy, timeout=remaining())
        if basic['exitCode'] != 0 or basic['stdout'].strip() != 'AWU_LOOP_PROBE':
            raise EnvironmentError('env_probe_failed')
        if not dependencies:
            return new_check(identity, status='passed', coverage='native_policy', probePath='command/exec', quiesced=True)
        if dependencies != ['openspec']:
            raise EnvironmentError('env_probe_unsupported')
        nonce = uuid.uuid4().hex
        result = await command_exec(conn, windows_lookup_command(entry, nonce, system_root=system_root or os.environ.get('SYSTEMROOT', r'C:\Windows')),
            identity.workspace, native_policy, timeout=remaining())
        try:
            packet = json.loads(result['stdout'].strip().lstrip('\ufeff'))
        except (ValueError, TypeError):
            raise EnvironmentError('env_probe_failed') from None
        if result['exitCode'] or not isinstance(packet, dict) or packet.get('nonce') != nonce:
            raise EnvironmentError('env_probe_failed')
        state = packet.get('state')
        if state != 'resolved':
            reason = {'denied': 'env_access_denied', 'entry_missing': 'env_cli_entry_missing',
                      'unresolved': 'env_cli_unresolved', 'runtime_missing': 'env_cli_unresolved'}.get(state, 'env_probe_failed')
            return new_check(identity, status='blocked', coverage='native_policy', reason=reason,
                dependencyId='node' if state == 'runtime_missing' else 'openspec', probePath='command/exec', quiesced=True)
        resolved = safe_entry(str(packet.get('entry') or ''), windows=True)
        runtime = safe_entry(str(packet.get('runtime') or ''), windows=True)
        if entry and os.path.normcase(resolved) != os.path.normcase(entry):
            raise EnvironmentError('env_probe_failed')
        result = await command_exec(conn, [runtime, '--version'], identity.workspace, native_policy, timeout=remaining())
        if result['exitCode'] != 0 or not re.fullmatch(r'v\d+\.\d+\.\d+', result['stdout'].strip()):
            return new_check(identity, status='blocked', coverage='native_policy', reason='env_cli_unresolved',
                             dependencyId='node', probePath='command/exec', quiesced=True)
        result = await command_exec(conn, windows_version_command(resolved, system_root=system_root or os.environ.get('SYSTEMROOT', r'C:\Windows')),
            identity.workspace, native_policy, timeout=remaining())
        if result['exitCode'] != 0 or not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][\w.-]+)?', result['stdout'].strip()):
            raise EnvironmentError('env_probe_failed')
        return new_check(identity, status='passed', coverage='native_policy', dependencyId='openspec',
                         entry=resolved, probePath='command/exec', quiesced=True, dependencies=dependencies)
    except EnvironmentError as exc:
        return new_check(identity, status='unsupported' if exc.code == 'env_probe_unsupported' else 'blocked',
            coverage='native_policy', reason=exc.code, dependencyId='openspec' if dependencies else '',
            probePath='command/exec', quiesced=exc.quiesced)
