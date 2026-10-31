import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.types import Session


def _session(workspace: Path, *, sid: str = "destroy-1", mode=None) -> Session:
    return Session(
        id=sid,
        title="Destroy me",
        created_at=1.0,
        updated_at=2.0,
        messages=[],
        working_dir=str(workspace),
        backend_id="backend-1",
        codex_connection_mode=mode,
    )


def _bridge(session: Session, listed=None) -> BridgeWS:
    bridge = BridgeWS.__new__(BridgeWS)
    bridge._active_sessions = {session.id: session}
    bridge._session_store = Mock()
    bridge._session_store.load.return_value = session
    bridge._session_store.list.return_value = listed if listed is not None else [session.meta_dict()]
    bridge._rpc_deleteSession = Mock(return_value=True)
    bridge._chat_turn_tasks = {}
    bridge._seq_dispatch_reservations = {}
    bridge._loop_tasks = {}
    bridge._loop_running = set()
    bridge._aside_running = set()
    bridge._chat_aside_running = set()
    bridge._kit_optimization_running = set()
    bridge._kit_tasks = {}
    bridge._kit_states = {}
    bridge._kit_terminals = {}
    bridge._destroying_sessions = set()
    return bridge


class SessionDestroyTests(unittest.IsolatedAsyncioTestCase):
    def test_ordinary_delete_preserves_workspace_and_emits_once(self) -> None:
        from src.backend.session_store import SessionStore
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "project"
            workspace.mkdir()
            artifact = workspace / "keep.txt"
            artifact.write_text("keep", encoding="utf-8")
            with patch("src.backend.session_store.paths.sub", return_value=Path(tmp) / "sessions"):
                store = SessionStore()
                session = _session(workspace)
                store.save(session, async_=False)
                bridge = _bridge(session)
                bridge._session_store = store
                bridge._session_owner_id = Mock(return_value="local")
                bridge._instance_manager = Mock()
                bridge._loop_cancel = {}
                bridge._loop_states = {}
                bridge._chat_extras = {}
                bridge._loop_store = Mock()
                bridge._chat_extras_store = Mock()
                bridge._kit_store = Mock()
                bridge._emit_session_updated = Mock()
                try:
                    with patch("src.backend.call_trace.clear_traces"):
                        self.assertTrue(BridgeWS._rpc_deleteSession(bridge, session.id))
                    self.assertEqual("keep", artifact.read_text(encoding="utf-8"))
                    self.assertIsNone(store.get_meta(session.id))
                    bridge._emit_session_updated.assert_called_once_with(
                        {"type": "session_deleted", "sessionId": session.id}, owner_id="local")
                finally:
                    store._io_running = False
                    if store._index_save_timer:
                        store._index_save_timer.cancel()

    async def test_destroy_removes_workspace_then_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "project"
            workspace.mkdir()
            (workspace / "nested").mkdir()
            (workspace / "nested" / "result.txt").write_text("payload", encoding="utf-8")
            session = _session(workspace)
            bridge = _bridge(session)

            result = json.loads(await bridge._rpc_destroySession(session.id, "DESTROY"))

            self.assertEqual("ok", result["status"])
            self.assertTrue(result["directoryDeleted"])
            self.assertFalse(workspace.exists())
            bridge._rpc_deleteSession.assert_called_once_with(session.id)

    async def test_destroy_requires_confirmation_and_refuses_busy_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "project"
            workspace.mkdir()
            session = _session(workspace)
            bridge = _bridge(session)

            unconfirmed = json.loads(await bridge._rpc_destroySession(session.id, "销毁"))
            self.assertEqual("error", unconfirmed["status"])
            self.assertTrue(workspace.exists())

            bridge._seq_dispatch_reservations[session.id] = time.time() + 30
            busy = json.loads(await bridge._rpc_destroySession(session.id, "DESTROY"))
            self.assertEqual("error", busy["status"])
            self.assertIn("运行", busy["message"])
            self.assertTrue(workspace.exists())
            bridge._rpc_deleteSession.assert_not_called()

    async def test_destroy_refuses_shared_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "shared-project"
            workspace.mkdir()
            session = _session(workspace)
            other = _session(workspace, sid="other-session")
            bridge = _bridge(session, [session.meta_dict(), other.meta_dict()])

            result = json.loads(await bridge._rpc_destroySession(session.id, "DESTROY"))

            self.assertEqual("error", result["status"])
            self.assertIn("其它 Session", result["message"])
            self.assertTrue(workspace.exists())
            bridge._rpc_deleteSession.assert_not_called()

    async def test_destroy_refuses_protected_and_ssh_paths(self) -> None:
        protected = _session(Path.home())
        protected_bridge = _bridge(protected)
        protected_result = json.loads(await protected_bridge._rpc_destroySession(
            protected.id, "DESTROY",
        ))
        self.assertEqual("error", protected_result["status"])
        self.assertIn("关键数据", protected_result["message"])

        ssh = _session(Path("/srv/project"), mode="ssh")
        ssh_bridge = _bridge(ssh)
        ssh_result = json.loads(await ssh_bridge._rpc_destroySession(ssh.id, "DESTROY"))
        self.assertEqual("error", ssh_result["status"])
        self.assertIn("SSH Codex", ssh_result["message"])

    async def test_failed_directory_delete_preserves_session_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "project"
            workspace.mkdir()
            session = _session(workspace)
            bridge = _bridge(session)
            bridge._remove_session_workspace = Mock(side_effect=PermissionError("locked"))

            result = json.loads(await bridge._rpc_destroySession(session.id, "DESTROY"))

            self.assertEqual("error", result["status"])
            self.assertIn("Session 已保留", result["message"])
            self.assertTrue(workspace.exists())
            bridge._rpc_deleteSession.assert_not_called()


if __name__ == "__main__":
    unittest.main()
