"""有界、可核对的工程进程生命周期；客户端取消等待不取消 owned 任务。"""
from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Callable

from .engineering_host import FRAME_LIMIT
from .owned_process_tree import OwnedProcessTree


class EngineeringProcess:
    def __init__(self, on_data: Callable[[str, bytes], None], on_state: Callable[[], None] = lambda: None) -> None:
        self.on_data, self.on_state = on_data, on_state
        self.process: asyncio.subprocess.Process | None = None
        self.owner: OwnedProcessTree | None = None
        self.reader: asyncio.Task | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.sequence = 0
        self.lock = asyncio.Lock()
        self.started = False
        self.stdout_eof = False
        self.exit_code: int | None = None
        self.spawn_attempted = False
        self.spawn_failed = False
        self.failed = False
        self.confirmed = False
        self.stop_task: asyncio.Task | None = None
        self.helper_command: list[str] | None = None
        self.spawn_task: asyncio.Task | None = None

    async def start(self, argv: list[str], cwd: str, env: dict[str, str], mode: str = 'pipe', cols: int = 80, rows: int = 24) -> None:
        if self.spawn_attempted:
            raise RuntimeError('process_already_started')
        self.spawn_attempted = True
        helper = self.helper_command or ([sys.executable, '--agentwithu-engine-host'] if getattr(sys, 'frozen', False) else [
            sys.executable, str(Path(__file__).resolve().parents[2] / 'ws_main_entry.py'), '--agentwithu-engine-host']
        )
        async def spawn_owned() -> None:
            try:
                self.process = await asyncio.create_subprocess_exec(*helper, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=env,
                    limit=FRAME_LIMIT + 1, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            except OSError:
                self.spawn_failed = True; self.confirmed = True; raise
            if os.name == 'nt':
                self.owner = OwnedProcessTree(self.process)
                if not self.owner.complete:
                    # 尚未放行子进程。固定 helper 只会等 stdin，核对直接子进程。
                    self.process.stdin.close()
                    await asyncio.wait_for(self.process.wait(), 5)
                    self.confirmed = True; self.owner.release()
                    raise RuntimeError('process_ownership_unavailable')
            self.reader = asyncio.create_task(self._read())
        self.spawn_task = asyncio.create_task(spawn_owned())
        try:
            await asyncio.shield(self.spawn_task)
            await self.command({'action': 'start', 'argv': argv, 'cwd': cwd, 'env': env, 'mode': mode,
                                'cols': cols, 'rows': rows}, timeout=15)
            self.started = True
        except BaseException:
            self.failed = True
            await self.stop()
            raise

    async def _read(self) -> None:
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    break
                if len(line) > FRAME_LIMIT:
                    raise ValueError('host_output_limit')
                row = json.loads(line)
                if row.get('event') == 'data':
                    data = base64.b64decode(row['data'], validate=True)
                    if len(data) > 32768 or row.get('stream') not in ('stdout', 'stderr'):
                        raise ValueError('host_output_limit')
                    self.on_data(row['stream'], data)
                elif row.get('event') == 'eof':
                    if row.get('stream') == 'stdout':
                        self.stdout_eof = True
                    self.on_state()
                elif row.get('event') == 'exit' and type(row.get('code')) is int:
                    self.exit_code = row['code']
                    self.on_state()
                elif type(row.get('id')) is int:
                    future = self.pending.pop(row['id'], None)
                    if future and not future.done():
                        future.set_result(row)
        except (OSError, ValueError, KeyError, asyncio.LimitOverrunError):
            self.failed = True
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError('host_disconnected'))
            self.pending.clear()
            if not self.confirmed:
                self.failed = True
            self.on_state()

    async def command(self, payload: dict[str, Any], timeout: float = 5) -> dict[str, Any]:
        if self.process is None or self.process.returncode is not None or len(self.pending) >= 32:
            raise RuntimeError('host_unavailable')
        async with self.lock:
            self.sequence += 1
            request = self.sequence
            data = json.dumps({**payload, 'id': request}, ensure_ascii=True).encode() + b'\n'
            if len(data) > FRAME_LIMIT:
                raise ValueError('host_input_limit')
            future = asyncio.get_running_loop().create_future()
            self.pending[request] = future
            try:
                self.process.stdin.write(data)
                await asyncio.wait_for(self.process.stdin.drain(), timeout)
                row = await asyncio.wait_for(asyncio.shield(future), timeout)
                if not row.get('ok'):
                    raise RuntimeError(row.get('reasonCode', 'host_operation_failed'))
                return row
            finally:
                self.pending.pop(request, None)
                if not future.done():
                    future.cancel()

    async def write(self, data: bytes) -> None:
        if not self.started or self.failed or self.stop_task:
            raise RuntimeError('process_not_ready')
        for start in range(0, len(data), 65536):
            await self.command({'action': 'write', 'data': base64.b64encode(data[start:start + 65536]).decode('ascii')})

    async def resize(self, cols: int, rows: int) -> None:
        await self.command({'action': 'resize', 'cols': cols, 'rows': rows})

    async def close_input(self) -> None:
        await self.command({'action': 'closeInput'})

    async def stop(self) -> bool:
        if self.confirmed:
            return True
        if self.stop_task is None or self.stop_task.done():
            self.stop_task = asyncio.create_task(self._stop())
        return await asyncio.shield(self.stop_task)

    async def _stop(self) -> bool:
        if self.spawn_task and not self.spawn_task.done():
            try:
                await asyncio.shield(self.spawn_task)
            except (OSError, RuntimeError, asyncio.TimeoutError):
                pass
        if self.confirmed:
            return True
        if self.process is None:
            return self.confirmed  # 无进程引用不等于确认退出。
        try:
            if self.owner:
                self.confirmed = await self.owner.stop()
                if self.confirmed:
                    self.owner.release()
            else:
                row = await self.command({'action': 'stop'}, timeout=8)
                await asyncio.wait_for(self.process.wait(), 3)
                self.confirmed = row.get('cleanupConfirmed') is True and self.process.returncode == 0
            if self.confirmed and self.reader:
                await asyncio.wait_for(asyncio.shield(self.reader), 2)
        except (OSError, RuntimeError, asyncio.TimeoutError):
            self.failed = True
        self.on_state()
        return self.confirmed
