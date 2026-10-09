"""会话执行端 PTY。内存内实例/输入回执，不保存输入、环境或自动重放命令。"""
from __future__ import annotations

import asyncio
import codecs
from collections import OrderedDict, deque
from dataclasses import dataclass, field
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import sys
from typing import Any, Callable
import uuid

from .engine_workbench import EngineeringActivity, WorkbenchError, WorkspaceIdentity
from .engineering_process import EngineeringProcess
from .workbench_windows import identifier

OUTPUT_LIMIT = 2 * 1024 * 1024
READ_LIMIT = 128 * 1024
MAX_TERMINALS = 16


def terminal_shells() -> list[dict[str, Any]]:
    if os.name == 'nt':
        if importlib.util.find_spec('winpty') is None:
            return []
        system = Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32'
        choices = [('powershell', system / 'WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo', '-NoProfile']),
                   ('cmd', system / 'cmd.exe', ['/D'])]
    elif sys.platform.startswith('linux') and platform.machine() == 'x86_64' and Path('/proc/self/fd').is_dir():
        choices = [('bash', Path('/bin/bash'), ['--noprofile', '--norc']), ('sh', Path('/bin/sh'), [])]
    else:
        return []
    return [{'id': key, 'executable': str(path), 'args': args} for key, path, args in choices if path.is_file()]


@dataclass
class Terminal:
    workspace: WorkspaceIdentity
    lease: EngineeringActivity
    resource_id: str
    generation: str
    request_id: str
    shell: dict[str, Any]
    cols: int
    rows: int
    status: str = 'starting'
    reason: str = ''
    sequence: int = 0
    revision: int = 1
    size: int = 0
    input_sequence: int = 0
    chunks: deque[tuple[int, str, int]] = field(default_factory=deque)
    inputs: OrderedDict[int, tuple[str, str]] = field(default_factory=OrderedDict)
    process: Any = None
    task: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    notice: asyncio.TimerHandle | None = None
    notice_task: asyncio.Task | None = None
    notice_dirty: bool = False
    decoder: Any = field(default_factory=lambda: codecs.getincrementaldecoder('utf-8')('replace'))

    def snapshot(self) -> dict[str, Any]:
        return {'workspace': self.workspace.to_dict(), 'resourceId': self.resource_id, 'generation': self.generation,
                'requestId': self.request_id, 'shell': self.shell, 'status': self.status, 'reasonCode': self.reason,
                'cols': self.cols, 'rows': self.rows, 'revision': self.revision, 'lastSequence': self.sequence, 'inputSequence': self.input_sequence,
                'activityId': self.lease.activity_id, 'exitConfirmed': self.status == 'stopped'}

    def append(self, data: bytes) -> None:
        text = self.decoder.decode(data)
        if not text:
            return
        self.sequence += 1
        size = len(text.encode('utf-8'))
        self.chunks.append((self.sequence, text, size)); self.size += size
        while self.size > OUTPUT_LIMIT or len(self.chunks) > 8192:
            _, _, size = self.chunks.popleft(); self.size -= size

    def read(self, after: int) -> dict[str, Any]:
        if type(after) is not int or after < 0 or after >= 2**53:
            raise WorkbenchError('invalid_terminal_position')
        first = self.chunks[0][0] if self.chunks else self.sequence + 1
        gap = after < first - 1 or after > self.sequence
        rows, size = [], 0
        for sequence, text, count in self.chunks:
            if sequence <= after and not gap:
                continue
            if size + count > READ_LIMIT:
                break
            rows.append({'sequence': sequence, 'text': text}); size += count
        return {**self.snapshot(), 'status': 'ok', 'terminalStatus': self.status, 'gap': gap,
                'earliestSequence': first, 'chunks': rows, 'through': rows[-1]['sequence'] if rows else self.sequence}


class TerminalManager:
    def __init__(self, bridge: Any, factory: Callable[..., Any] = EngineeringProcess) -> None:
        self.bridge, self.factory = bridge, factory
        self.rows: OrderedDict[str, Terminal] = OrderedDict()
        self.receipts: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()

    def require(self, workspace: WorkspaceIdentity, resource: str, generation: str) -> Terminal:
        row = self.rows.get(identifier(resource))
        if row is None or row.generation != identifier(generation):
            raise WorkbenchError('terminal_instance_unavailable')
        row.workspace.require_match(workspace.to_dict())
        return row

    def changed(self, row: Terminal) -> None:
        row.revision += 1
        # 仅有活动时合并通知；发送队列至多一个在途帧 + 一个短计时器。
        if row.notice is not None or row.notice_task and not row.notice_task.done():
            row.notice_dirty = True
            return
        async def notify() -> None:
            try:
                await self.bridge._send_for_session(row.workspace.sessionId, {'event': 'terminalUpdated',
                    'data': json.dumps({'sessionId': row.workspace.sessionId, **row.snapshot()}, ensure_ascii=False)},
                    owner_id=row.workspace.ownerId)
            except (OSError, RuntimeError):
                pass
            finally:
                row.notice_task = None
                if row.notice_dirty:
                    row.notice_dirty = False; self.changed(row)
        def send() -> None:
            row.notice = None
            row.notice_task = asyncio.create_task(notify())
        row.notice = asyncio.get_running_loop().call_later(.1, send)

    def remember(self, key: tuple[str, str], receipt: dict[str, Any]) -> None:
        self.receipts[key] = receipt
        while len(self.receipts) > 256:
            self.receipts.popitem(last=False)

    def create(self, workspace: WorkspaceIdentity, p: dict[str, Any]) -> Terminal:
        request = identifier(p.get('requestId'))
        shell = next((item for item in terminal_shells() if item['id'] == p.get('shell')), None)
        if shell is None:
            raise WorkbenchError('terminal_shell_unavailable')
        cols, rows = p.get('cols', 80), p.get('rows', 24)
        if not all(type(n) is int and 2 <= n <= 500 for n in (cols, rows)):
            raise WorkbenchError('invalid_terminal_size')
        fingerprint = hashlib.sha256(json.dumps([workspace.to_dict(), shell, cols, rows, p.get('controlRevision')], sort_keys=True).encode()).hexdigest()
        key = (workspace.workspaceRevision, request)
        old = self.receipts.get(key)
        if old:
            if old['fingerprint'] != fingerprint:
                raise WorkbenchError('terminal_request_conflict')
            return self.require(workspace, old['resourceId'], old['generation'])
        if sum(row.status != 'stopped' for row in self.rows.values()) >= MAX_TERMINALS:
            raise WorkbenchError('terminal_limit')
        if sum(row.workspace == workspace and row.status != 'stopped' for row in self.rows.values()) >= 4:
            raise WorkbenchError('session_terminal_limit')
        while len(self.rows) >= 64:
            stopped = next((key for key, value in self.rows.items() if value.status == 'stopped'), None)
            if stopped is None:
                raise WorkbenchError('terminal_limit')
            del self.rows[stopped]
        lease = self.bridge._engineering_admit(workspace.sessionId, workspace.to_dict(), p.get('controlRevision'), 'terminal')
        row = Terminal(workspace, lease, uuid.uuid4().hex, uuid.uuid4().hex, request, shell, cols, rows)
        self.rows[row.resource_id] = row
        self.remember(key, {'fingerprint': fingerprint, 'resourceId': row.resource_id, 'generation': row.generation})
        row.task = asyncio.create_task(self._start(row))
        return row

    async def _start(self, row: Terminal) -> None:
        def output(stream: str, data: bytes) -> None:
            row.append(data)
            while sum(item.size for item in self.rows.values()) > MAX_TERMINALS * OUTPUT_LIMIT:
                oldest = next((item for item in self.rows.values() if item.chunks), None)
                if oldest is None:
                    break
                _, _, count = oldest.chunks.popleft(); oldest.size -= count
            self.changed(row)
        def state() -> None:
            if row.process and (row.process.stdout_eof or row.process.failed) and row.status == 'running' and not (row.stop_task and not row.stop_task.done()):
                row.status = 'stopping'; row.stop_task = asyncio.create_task(self._stop(row))
            self.changed(row)
        row.process = self.factory(output, state)
        launched = False
        try:
            self.bridge._engineering_recheck(row.lease)
            env = dict(os.environ); env.update(TERM='xterm-256color', COLORTERM='truecolor')
            launched = True
            await row.process.start([row.shell['executable'], *row.shell['args']], row.workspace.workingDir,
                                    env, mode='pty', cols=row.cols, rows=row.rows)
            row.status = 'running'
            state()
        except (OSError, RuntimeError, ValueError, asyncio.TimeoutError):
            row.reason = 'terminal_start_failed'; row.status = 'unknown'
            if not launched or row.process.confirmed:
                self.finish(row)
        self.changed(row)

    def finish(self, row: Terminal) -> None:
        if row.status != 'stopped':
            self.bridge._engineering_confirm_finished(row.lease)
            row.status = 'stopped'

    async def input(self, row: Terminal, p: dict[str, Any]) -> dict[str, Any]:
        sequence, text, request = p.get('sequence'), p.get('text'), identifier(p.get('requestId'))
        if type(sequence) is not int or not 1 <= sequence < 2**53 or not isinstance(text, str) or len(text.encode('utf-8')) > 65536:
            raise WorkbenchError('invalid_terminal_input')
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        old = row.inputs.get(sequence)
        if old:
            if old != (request, digest):
                raise WorkbenchError('terminal_input_conflict')
            return {'status': 'duplicate', 'sequence': sequence, 'terminal': row.snapshot()}
        if sequence != row.input_sequence + 1:
            raise WorkbenchError('stale_terminal_input')
        if row.status != 'running':
            raise WorkbenchError('terminal_not_running')
        self.bridge._engineering_recheck(row.lease)
        # 在任何 await 前消费序号。超时后可能已注入，不允许重放该输入。
        row.input_sequence = sequence; row.inputs[sequence] = (request, digest)
        self.changed(row)
        while len(row.inputs) > 128:
            row.inputs.popitem(last=False)
        try:
            await row.process.write(text.encode('utf-8'))
        except (RuntimeError, OSError, asyncio.TimeoutError, asyncio.CancelledError):
            row.status = 'unknown'; row.reason = 'terminal_input_unknown'; self.changed(row)
            return {'status': 'unknown', 'sequence': sequence, 'terminal': row.snapshot()}
        return {'status': 'accepted', 'sequence': sequence, 'terminal': row.snapshot()}

    async def resize(self, row: Terminal, cols: int, rows: int) -> dict[str, Any]:
        if not all(type(n) is int and 2 <= n <= 500 for n in (cols, rows)):
            raise WorkbenchError('invalid_terminal_size')
        if row.status != 'running':
            raise WorkbenchError('terminal_not_running')
        self.bridge._engineering_recheck(row.lease)
        await row.process.resize(cols, rows)
        row.cols, row.rows = cols, rows
        self.changed(row)
        return row.snapshot()

    async def stop(self, row: Terminal, request: str) -> dict[str, Any]:
        identifier(request)
        if row.status == 'stopped':
            return row.snapshot()
        if not row.stop_task or row.stop_task.done():
            row.status = 'stopping'; self.changed(row)
            row.stop_task = asyncio.create_task(self._stop(row))
        await asyncio.shield(row.stop_task)
        return row.snapshot()

    async def _stop(self, row: Terminal) -> None:
        try:
            if row.task and not row.task.done() and row.task is not asyncio.current_task():
                await asyncio.shield(row.task)
            if row.process and await row.process.stop():
                self.finish(row)
            else:
                row.status = 'unknown'; row.reason = 'terminal_exit_unconfirmed'
        except (RuntimeError, OSError, asyncio.TimeoutError):
            row.status = 'unknown'; row.reason = 'terminal_exit_unconfirmed'
        self.changed(row)


class TerminalBridge:
    def _terminals(self) -> TerminalManager:
        if not hasattr(self, '_terminal_manager'):
            self._terminal_manager = TerminalManager(self)
        return self._terminal_manager

    def _terminal_args(self, session_id: str, identity_json: str, payload: str = '{}', *, payload_limit: int = 256 * 1024) -> tuple[WorkspaceIdentity, dict[str, Any]]:
        self._require_session_access(session_id)
        if not isinstance(identity_json, str) or len(identity_json) > 16384 or not isinstance(payload, str) or len(payload) > payload_limit:
            raise WorkbenchError('invalid_request')
        workspace = self._workbench_identity(session_id, json.loads(identity_json))
        p = json.loads(payload)
        if not isinstance(p, dict):
            raise WorkbenchError('invalid_request')
        return workspace, p

    def _rpc_terminalList(self, session_id: str, identity_json: str) -> str:
        workspace, _ = self._terminal_args(session_id, identity_json)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        control = self._loop_state(session_id).control_revision if session.session_type == 'loop' else 0
        return json.dumps({'status': 'ok', 'workspace': workspace.to_dict(), 'shells': terminal_shells(), 'controlRevision': control,
            'terminals': [row.snapshot() for row in self._terminals().rows.values() if row.workspace == workspace]}, ensure_ascii=False)

    def _rpc_terminalCreate(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        self._window_guard(session_id)
        return json.dumps(self._terminals().create(workspace, p).snapshot(), ensure_ascii=False)

    def _rpc_terminalRead(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        row = self._terminals().require(workspace, p.get('resourceId'), p.get('generation'))
        return json.dumps(row.read(p.get('after', 0)), ensure_ascii=False)

    async def _rpc_terminalInput(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        self._window_guard(session_id)
        row = self._terminals().require(workspace, p.get('resourceId'), p.get('generation'))
        return json.dumps(await self._terminals().input(row, p), ensure_ascii=False)

    async def _rpc_terminalResize(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        self._window_guard(session_id)
        row = self._terminals().require(workspace, p.get('resourceId'), p.get('generation'))
        return json.dumps(await self._terminals().resize(row, p.get('cols'), p.get('rows')), ensure_ascii=False)

    async def _rpc_terminalStop(self, session_id: str, identity_json: str, payload: str) -> str:
        workspace, p = self._terminal_args(session_id, identity_json, payload)
        self._window_guard(session_id)
        row = self._terminals().require(workspace, p.get('resourceId'), p.get('generation'))
        return json.dumps(await self._terminals().stop(row, p.get('requestId')), ensure_ascii=False)
