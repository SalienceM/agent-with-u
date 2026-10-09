"""工程工作台的隔离测试底座；fake 协议不是原生 LSP/PTY 验收证据。"""
from __future__ import annotations

import asyncio
from contextlib import ExitStack
import os
from pathlib import Path
import socket
import tempfile
from contextvars import ContextVar
from typing import Any, Callable, Optional
from unittest.mock import patch
import uuid

from src.backend.base import ModelBackend, StreamDelta
from src.types import BackendType, ModelBackendConfig, Session


_SOCKETPAIR_SETUP: ContextVar[bool] = ContextVar('engine_fixture_socketpair', default=False)


class EngineFixture:
    """只创建本次拥有的临时工程，不接受外部数据根或生产 Session。

    默认模式为进程内确定性测试：拒绝网络及真实子进程。原生集成测试
    需另建显式 opt-in runner；本类不是不受信代码的 OS 沙箱。
    """

    def __init__(self) -> None:
        self._temp: Optional[tempfile.TemporaryDirectory] = None
        self._stack = ExitStack()
        self._sessions: dict[str, Session] = {}
        self._stores: list[Any] = []
        self.root: Path
        self.home: Path
        self.workspace: Path
        self.data: Path
        self.env: dict[str, str]
        self.active = False

    def __enter__(self) -> EngineFixture:
        if self.active:
            raise RuntimeError('Fixture is already active')
        self._temp = tempfile.TemporaryDirectory(prefix='awu-engine-test-')
        self.root = Path(self._temp.name).resolve()
        if self.root.parent != Path(tempfile.gettempdir()).resolve():
            self._temp.cleanup()
            raise RuntimeError('Expected a fresh system temporary directory')
        self.home = self.root / 'home'
        self.workspace = self.root / 'workspace'
        self.data = self.root / 'data'
        for directory in (self.home, self.workspace, self.data):
            directory.mkdir()
        self.env = {
            key: value for key, value in os.environ.items()
            if key.upper() in {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'}
        }
        self.env.update({
            'HOME': str(self.home), 'USERPROFILE': str(self.home),
            'APPDATA': str(self.home / 'appdata'), 'LOCALAPPDATA': str(self.home / 'local'),
            'CODEX_HOME': str(self.home / '.codex'), 'CLAUDE_CONFIG_DIR': str(self.home / '.claude'),
            'AGENT_WITH_U_DATA_ROOT': str(self.data), 'TEMP': str(self.root), 'TMP': str(self.root),
            'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
            'ALL_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': '',
        })
        self._stack.enter_context(patch.dict(os.environ, self.env, clear=True))
        # paths._DEFAULT 可能在本夹具前导入；禁止它回落到真实数据根。
        self._stack.enter_context(patch('src.backend.paths._DEFAULT', self.data))
        original_pair, original_connect = socket.socketpair, socket.socket.connect

        def pair(*args: Any, **kwargs: Any) -> tuple[socket.socket, socket.socket]:
            # Windows asyncio 的自唤醒管道使用 Python 的回环 socketpair 实现。
            # 仅这个同步创建范围可建立其自有管道，不开放一般回环网络访问。
            token = _SOCKETPAIR_SETUP.set(True)
            try:
                return original_pair(*args, **kwargs)
            finally:
                _SOCKETPAIR_SETUP.reset(token)

        def connect(sock: socket.socket, address: Any) -> None:
            if _SOCKETPAIR_SETUP.get() and isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1'):
                return original_connect(sock, address)
            raise RuntimeError('Engine fake fixture forbids network/process execution')

        self._stack.enter_context(patch('socket.socketpair', new=pair))
        self._stack.enter_context(patch('socket.socket.connect', new=connect))
        for target in ('socket.socket.connect_ex', 'socket.create_connection', 'socket.getaddrinfo', 'subprocess.Popen'):
            self._stack.enter_context(patch(target, side_effect=RuntimeError('Engine fake fixture forbids network/process execution')))
        self.active = True
        return self

    def require_path(self, path: str | Path) -> Path:
        if not self.active:
            raise RuntimeError('Fixture is not active')
        resolved = Path(path).resolve()
        if resolved == self.root or self.root not in resolved.parents:
            raise ValueError('Path is outside this fixture')
        return resolved

    def write_project_file(self, relative: str, text: str) -> Path:
        target = self.require_path(self.workspace / relative)
        if self.workspace not in target.parents:
            raise ValueError('Path is outside fixture workspace')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')
        return target

    def session(self, *, owner: str = 'engine-test-user', session_type: str = 'normal') -> Session:
        self.require_path(self.workspace)
        session = Session(id=f'engine-test-{uuid.uuid4()}', title='Engine fixture',
                          created_at=1, updated_at=1, messages=[], working_dir=str(self.workspace),
                          backend_id='engine-fake', owner_id=owner, session_type=session_type)
        self._sessions[session.id] = session
        return session

    def require_session(self, session_id: str, working_dir: Optional[str] = None) -> Session:
        session = self._sessions.get(session_id)
        if not self.active or session is None:
            raise ValueError('Not a Session created by this fixture')
        workspace = self.require_path(working_dir or session.working_dir)
        if workspace != self.workspace or self.require_path(session.working_dir) != self.workspace:
            raise ValueError('Session workspace changed outside fixture')
        return session

    def session_store(self) -> Any:
        from src.backend.session_store import SessionStore
        self.require_path(self.data)
        store = SessionStore()
        self.require_path(store._dir)
        self._stores.append(store)
        return store

    def __exit__(self, *exc: Any) -> None:
        try:
            for store in self._stores:
                store._io_running = False
                if store._io_thread:
                    store._io_thread.join(timeout=2)
                    if store._io_thread.is_alive():
                        raise RuntimeError('Fixture store worker has not exited')
                if store._index_save_timer:
                    store._index_save_timer.cancel()
                    store._index_save_timer.join(timeout=2)
                    if store._index_save_timer.is_alive():
                        raise RuntimeError('Fixture index writer has not exited')
            # 只清理本次 TemporaryDirectory；清理前再核对没有路径替换。
            if self._temp and Path(self._temp.name).resolve() == self.root:
                self._temp.cleanup()
        finally:
            self.active = False
            self._stack.close()


class FakeEngineBackend(ModelBackend):
    def __init__(self, fixture: EngineFixture, chunks: tuple[str, ...] = ('fixture',)) -> None:
        super().__init__(ModelBackendConfig(id='engine-fake', type=BackendType.OPENAI_COMPATIBLE,
                                           label='In-memory fixture', base_url='http://127.0.0.1:9'))
        self.fixture = fixture
        self.chunks = chunks
        self.calls = 0

    async def send_message(self, messages: list, content: str, images: Optional[list],
                           session_id: str, message_id: str, on_delta: Callable[[StreamDelta], None],
                           agent_session_id: Optional[str] = None, working_dir: Optional[str] = None,
                           **kwargs: Any) -> dict:
        self.fixture.require_session(session_id, working_dir)
        self.calls += 1
        for chunk in self.chunks:
            if self.is_cancelled(session_id):
                return {'status': 'cancelled'}
            on_delta(StreamDelta(session_id, message_id, 'text_delta', text=chunk))
            await asyncio.sleep(0)
        on_delta(StreamDelta(session_id, message_id, 'done'))
        return {'status': 'ok', 'content': ''.join(self.chunks)}


class FakeLanguageServer:
    """可手工乱序完成的请求端，供协议/生命周期测试注入，不启外部进程。"""

    def __init__(self, fixture: EngineFixture, session: Session) -> None:
        fixture.require_session(session.id)
        self.fixture, self.session = fixture, session
        self.pending: dict[int, asyncio.Future] = {}
        self.requests: list[dict] = []
        self.next_id = 0

    async def request(self, method: str, params: dict) -> Any:
        self.fixture.require_session(self.session.id)
        self.next_id += 1
        request_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.requests.append({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
        try:
            return await future
        finally:
            self.pending.pop(request_id, None)

    def reply(self, request_id: int, result: Any) -> None:
        future = self.pending[request_id]
        if not future.done():
            future.set_result(result)

    def crash(self) -> None:
        for future in tuple(self.pending.values()):
            if not future.done():
                future.set_exception(RuntimeError('Injected language server exit'))


class FakePty:
    """确定性终端适配器：stop 请求和确认退出故意分开。"""

    def __init__(self, fixture: EngineFixture, session: Session) -> None:
        fixture.require_session(session.id)
        self.fixture, self.session = fixture, session
        self.inputs: list[bytes] = []
        self.outputs: list[tuple[int, bytes]] = []
        self.size = (80, 24)
        self.stop_requested = False
        self.exit_confirmed = False

    def write(self, data: bytes) -> None:
        self.fixture.require_session(self.session.id)
        if self.stop_requested or self.exit_confirmed:
            raise RuntimeError('Terminal is stopping or exited')
        self.inputs.append(data)

    def resize(self, columns: int, rows: int) -> None:
        if columns <= 0 or rows <= 0:
            raise ValueError('Invalid terminal dimensions')
        self.size = (columns, rows)

    def emit(self, data: bytes) -> None:
        self.outputs.append((len(self.outputs) + 1, data))

    def stop(self) -> None:
        self.stop_requested = True

    def confirm_exit(self) -> None:
        self.exit_confirmed = True
