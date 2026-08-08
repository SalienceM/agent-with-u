import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.session_store import SessionStore
from src.types import ChatMessage, Session


def _session(root: str) -> Session:
    return Session(
        id="appearance-1",
        title="Appearance",
        created_at=1.0,
        updated_at=2.0,
        messages=[ChatMessage(id="m1", role="user", content="large body")],
        working_dir=root,
        backend_id="backend-1",
    )


def _stop_store(store: SessionStore) -> None:
    store._io_running = False
    if store._io_thread:
        store._io_thread.join(timeout=1)
    if store._index_save_timer:
        store._index_save_timer.cancel()


class SessionAppearanceTests(unittest.TestCase):
    def test_appearance_is_durable_without_rewriting_session_body(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sessions"
            with patch("src.backend.session_store.paths.sub", return_value=root):
                store = SessionStore()
                session = _session(tmp)
                store.save(session, async_=False)
                session_path = root / "appearance-1.json"
                before_body = session_path.read_bytes()
                before_updated = session.updated_at

                session.pinned = True
                session.sidebar_color = "ocean"
                store.save_meta(session, touch_updated=False, immediate=True)

                self.assertEqual(before_updated, session.updated_at)
                self.assertEqual(before_body, session_path.read_bytes())
                self.assertTrue(store.get_meta(session.id)["pinned"])
                self.assertEqual("ocean", store.get_meta(session.id)["sidebarColor"])

                reloaded_store = SessionStore()
                reloaded = reloaded_store.load(session.id)
                self.assertIsNotNone(reloaded)
                self.assertTrue(reloaded.pinned)
                self.assertEqual("ocean", reloaded.sidebar_color)
                _stop_store(reloaded_store)
                _stop_store(store)

    def test_rpc_validates_presets_and_emits_summary(self) -> None:
        bridge = BridgeWS.__new__(BridgeWS)
        session = _session(".")
        bridge._active_sessions = {session.id: session}
        bridge._session_store = Mock()
        events = []
        bridge._emit_session_updated = events.append

        invalid = json.loads(bridge._rpc_updateSessionAppearance(
            session.id, json.dumps({"sidebarColor": "url(javascript:bad)"}),
        ))
        self.assertEqual("error", invalid["status"])
        bridge._session_store.save_meta.assert_not_called()

        result = json.loads(bridge._rpc_updateSessionAppearance(
            session.id, json.dumps({"pinned": True, "sidebarColor": "violet"}),
        ))
        self.assertEqual("ok", result["status"])
        self.assertTrue(session.pinned)
        self.assertEqual("violet", session.sidebar_color)
        bridge._session_store.save_meta.assert_called_once_with(
            session, touch_updated=False, immediate=True,
        )
        self.assertEqual("session_changed", events[0]["type"])
        self.assertTrue(events[0]["summary"]["pinned"])


if __name__ == "__main__":
    unittest.main()
