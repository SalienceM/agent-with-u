"""有界 LSP JSON-RPC。提供器输出不是 AWU 指令，服务端编辑一律拒绝。"""
from __future__ import annotations

import asyncio
from collections import deque
import json
import time
from typing import Any, Callable

from .engineering_process import EngineeringProcess

MAX_MESSAGE = 4 * 1024 * 1024
MAX_PENDING = 32


class LspError(ValueError):
    pass


class LspFrames:
    def __init__(self) -> None:
        self.buffer = bytearray()
        self.length: int | None = None

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        if len(data) > MAX_MESSAGE:
            raise LspError('language_message_limit')
        self.buffer.extend(data)
        result = []
        while self.buffer:
            if self.length is None:
                end = self.buffer.find(b'\r\n\r\n')
                if end < 0:
                    if len(self.buffer) > 8192:
                        raise LspError('language_header_limit')
                    break
                if end > 8192:
                    raise LspError('language_header_limit')
                lengths = []
                for line in bytes(self.buffer[:end]).split(b'\r\n'):
                    key, sep, value = line.partition(b':')
                    if not sep:
                        raise LspError('language_header_invalid')
                    if key.lower() == b'content-length':
                        if not value.strip().isdigit():
                            raise LspError('language_length_invalid')
                        lengths.append(int(value.strip()))
                if len(lengths) != 1 or not 1 <= lengths[0] <= MAX_MESSAGE:
                    raise LspError('language_message_limit')
                self.length = lengths[0]; del self.buffer[:end + 4]
            if len(self.buffer) < self.length:
                break
            raw = bytes(self.buffer[:self.length]); del self.buffer[:self.length]; self.length = None
            try:
                row = json.loads(raw.decode('utf-8', errors='strict'))
            except (ValueError, UnicodeError, RecursionError) as error:
                raise LspError('language_json_invalid') from error
            if not isinstance(row, dict) or row.get('jsonrpc') != '2.0':
                raise LspError('language_frame_invalid')
            result.append(row)
            if len(result) > 1024:
                raise LspError('language_message_flood')
        return result


class LspChannel:
    def __init__(self, notification: Callable[[str, Any], None], configuration: Callable[[list], list],
                 folders: list[dict], failure: Callable[[str], None], factory: Callable[..., Any] = EngineeringProcess) -> None:
        self.notification, self.configuration, self.folders, self.failure = notification, configuration, folders, failure
        self.frames = LspFrames()
        self.process = factory(self._data, self._state)
        self.pending: dict[int, asyncio.Future] = {}
        self.sequence = 0
        self.server_tasks: set[asyncio.Task] = set()
        self.failed = ''
        self.stopping = False
        self.traffic: deque[tuple[float, int]] = deque()
        self.traffic_size = 0
        self.stderr_bytes = 0

    def _fail(self, reason: str) -> None:
        if self.failed or self.stopping:
            return
        self.failed = reason
        for future in self.pending.values():
            if not future.done():
                future.set_exception(LspError(reason))
        self.failure(reason)

    def _state(self) -> None:
        if not self.stopping and (self.process.failed or self.process.stdout_eof):
            self._fail('language_process_closed')

    def _data(self, stream: str, data: bytes) -> None:
        if self.failed or self.stopping:
            return
        try:
            now = time.monotonic()
            while self.traffic and self.traffic[0][0] < now - 10:
                self.traffic_size -= self.traffic.popleft()[1]
            self.traffic.append((now, len(data))); self.traffic_size += len(data)
            if self.traffic_size > 32 * 1024 * 1024 or len(self.traffic) > 16384:
                raise LspError('language_output_flood')
            if stream == 'stderr':
                self.stderr_bytes += len(data)
                if self.stderr_bytes > 1024 * 1024:
                    raise LspError('language_stderr_limit')
                return  # 不记录提供器正文、路径或项目源码日志。
            for row in self.frames.feed(data):
                self._message(row)
        except (ValueError, TypeError, KeyError, RecursionError):
            self._fail('language_invalid_or_excess_output')

    def _message(self, row: dict[str, Any]) -> None:
        if 'method' not in row:
            if type(row.get('id')) is not int:
                return
            future = self.pending.get(row['id'])
            if future and not future.done():
                if 'error' in row:
                    future.set_exception(LspError('language_request_rejected'))
                elif 'result' in row:
                    future.set_result(row['result'])
                else:
                    future.set_exception(LspError('language_response_invalid'))
            return
        method = row['method']
        if not isinstance(method, str) or len(method) > 256:
            raise LspError('language_method_invalid')
        params = row.get('params', {})
        if 'id' not in row:
            self.notification(method, params)
            return
        identifier = row['id']
        if (type(identifier) not in (str, int) or len(str(identifier)) > 128 or len(self.server_tasks) >= 16):
            raise LspError('language_request_flood')
        result = {'jsonrpc': '2.0', 'id': identifier}
        if method == 'workspace/configuration':
            items = params.get('items')
            if not isinstance(items, list) or len(items) > 64:
                raise LspError('language_configuration_limit')
            result['result'] = self.configuration(items)
        elif method == 'workspace/workspaceFolders':
            result['result'] = self.folders
        elif method in ('window/workDoneProgress/create', 'client/registerCapability', 'client/unregisterCapability'):
            result['result'] = None
        elif method == 'workspace/applyEdit':
            result['result'] = {'applied': False, 'failureReason': 'Use explicit versioned AWU edit preview'}
        else:
            result['error'] = {'code': -32601, 'message': 'Client operation not permitted'}
        task = asyncio.create_task(self.send(result)); self.server_tasks.add(task)
        def finished(done: asyncio.Task) -> None:
            self.server_tasks.discard(done)
            if not done.cancelled() and done.exception():
                self._fail('language_response_failed')
        task.add_done_callback(finished)

    async def start(self, argv: list[str], cwd: str, env: dict[str, str]) -> None:
        await self.process.start(argv, cwd, env, mode='pipe')

    async def send(self, row: dict[str, Any]) -> None:
        if self.failed or self.stopping:
            raise LspError(self.failed or 'language_stopped')
        data = json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(data) > MAX_MESSAGE:
            raise LspError('language_message_limit')
        await self.process.write(f'Content-Length: {len(data)}\r\n\r\n'.encode() + data)

    async def notify(self, method: str, params: Any) -> None:
        await self.send({'jsonrpc': '2.0', 'method': method, 'params': params})

    async def request(self, method: str, params: Any, timeout: float = 10) -> Any:
        if len(self.pending) >= MAX_PENDING:
            raise LspError('language_request_limit')
        self.sequence += 1; identifier = self.sequence
        future = asyncio.get_running_loop().create_future(); self.pending[identifier] = future
        try:
            async with asyncio.timeout(timeout) if hasattr(asyncio, 'timeout') else _Timeout(timeout):
                await self.send({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params})
                return await asyncio.shield(future)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            try:
                await asyncio.wait_for(self.notify('$/cancelRequest', {'id': identifier}), 1)
            except (ValueError, RuntimeError, OSError, asyncio.TimeoutError):
                pass
            raise
        finally:
            self.pending.pop(identifier, None)
            if not future.done():
                future.cancel()

    async def stop(self) -> bool:
        self.stopping = True
        for future in self.pending.values():
            if not future.done():
                future.set_exception(LspError('language_stopped'))
        return await self.process.stop()


class _Timeout:
    """Python 3.10 的单调用期限，不取消拥有的宿主/进程清理任务。"""
    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self.expired = False

    async def __aenter__(self) -> None:
        self.task = asyncio.current_task()
        def expire() -> None:
            self.expired = True; self.task.cancel()
        self.timer = asyncio.get_running_loop().call_later(self.seconds, expire)

    async def __aexit__(self, kind: Any, value: Any, traceback: Any) -> bool:
        self.timer.cancel()
        if kind is asyncio.CancelledError and self.expired:
            raise asyncio.TimeoutError()
        return False
