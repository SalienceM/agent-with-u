import json
import tempfile
import unittest
import copy
import threading
from contextlib import contextmanager
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


@contextmanager
def _fixture():
    with tempfile.TemporaryDirectory() as tmp:
        with patch("src.backend.session_store.paths.sub", return_value=Path(tmp) / "sessions"):
            store = SessionStore()
            session = _session(tmp)
            store.save(session, async_=False)
            bridge = BridgeWS.__new__(BridgeWS)
            bridge._active_sessions = {session.id: session}
            bridge._session_store = store
            events = []
            bridge._emit_session_updated = events.append
            try:
                yield store, session, bridge, events
            finally:
                _stop_store(store)


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
        bridge._session_store.commit_appearance.return_value = {"status": "ok", "pinned": True}
        bridge._session_store.get_meta.return_value = {**session.meta_dict(), "pinned": True, "sidebarColor": "violet", "favoriteRevision": 1}
        events = []
        bridge._emit_session_updated = events.append

        invalid = json.loads(bridge._rpc_updateSessionAppearance(
            session.id, json.dumps({"sidebarColor": "url(javascript:bad)"}),
        ))
        self.assertEqual("error", invalid["status"])
        bridge._session_store.commit_appearance.assert_not_called()

        result = json.loads(bridge._rpc_updateSessionAppearance(
            session.id, json.dumps({"pinned": True, "sidebarColor": "violet"}),
        ))
        self.assertEqual("ok", result["status"])
        self.assertTrue(session.pinned)
        self.assertEqual("violet", session.sidebar_color)
        bridge._session_store.commit_appearance.assert_called_once_with(
            session.id, {"pinned": True, "sidebarColor": "violet"},
        )
        self.assertEqual("session_changed", events[0]["type"])
        self.assertTrue(events[0]["summary"]["pinned"])

    def test_revision_receipt_restart_and_legacy_data(self) -> None:
        with _fixture() as (store, session, bridge, events):
            before = store._session_path(session.id).read_bytes()
            updated = session.updated_at
            self.assertEqual(0, store.load(session.id).favorite_revision)
            result = json.loads(bridge._rpc_sessionFavoriteSet(session.id, json.dumps({
                "pinned": True, "expectedRevision": 0, "requestId": "first",
            })))
            self.assertEqual("ok", result["status"])
            self.assertEqual(1, result["favoriteRevision"])
            self.assertEqual(updated, session.updated_at)
            self.assertEqual(before, store._session_path(session.id).read_bytes())
            reopened = SessionStore()
            try:
                self.assertTrue(reopened.load(session.id).pinned)
                self.assertEqual(1, reopened.load(session.id).favorite_revision)
                self.assertEqual("first", reopened.favorite_state(session.id)["lastRequestId"])
                self.assertNotIn("_favoriteReceipt", reopened.list()[0])
            finally:
                _stop_store(reopened)

    def test_cas_duplicate_and_legacy_color(self) -> None:
        with _fixture() as (store, session, bridge, events):
            payload = {"pinned": True, "expectedRevision": 0, "requestId": "first"}
            first = json.loads(bridge._rpc_sessionFavoriteSet(session.id, json.dumps(payload)))
            self.assertEqual(1, first["favoriteRevision"])
            self.assertEqual(1, json.loads(bridge._rpc_sessionFavoriteSet(session.id, json.dumps(payload)))["favoriteRevision"])
            self.assertEqual("error", json.loads(bridge._rpc_sessionFavoriteSet(session.id, json.dumps({**payload, "pinned": False})))["status"])
            self.assertEqual("conflict", json.loads(bridge._rpc_sessionFavoriteSet(session.id, json.dumps({**payload, "requestId": "second"})))["status"])
            color = json.loads(bridge._rpc_updateSessionAppearance(session.id, '{"sidebarColor":"ocean"}'))
            self.assertEqual(1, color["favoriteRevision"])
            legacy = json.loads(bridge._rpc_updateSessionAppearance(session.id, '{"pinned":false}'))
            self.assertEqual(2, legacy["favoriteRevision"])
            self.assertEqual("ocean", session.sidebar_color)

    def test_failed_disk_commit_is_not_installed_or_replayed(self) -> None:
        with _fixture() as (store, session, bridge, events):
            before = store.get_meta(session.id)
            with patch.object(store, "_atomic_write_text", side_effect=OSError("disk full")):
                result = json.loads(bridge._rpc_sessionFavoriteSet(session.id, json.dumps({
                    "pinned": True, "expectedRevision": 0, "requestId": "first",
                })))
            self.assertEqual("error", result["status"])
            self.assertEqual([], events)
            self.assertEqual(before, store.get_meta(session.id))
            self.assertFalse(session.pinned)
            store._save_index_sync()
            self.assertFalse(json.loads(store._index_path.read_text(encoding="utf-8"))[0]["pinned"])

    def test_stale_session_save_preserves_committed_favorite(self) -> None:
        with _fixture() as (store, session, bridge, events):
            old = copy.deepcopy(session)
            store.commit_appearance(session.id, {"pinned": True}, expected_revision=0, request_id="first")
            old.title = "new message title"
            store.save(old, async_=False)
            store._save_index_sync()
            self.assertTrue(store.get_meta(session.id)["pinned"])
            self.assertEqual(1, old.favorite_revision)
            self.assertEqual("new message title", store.load(session.id).title)
            self.assertEqual("first", store.favorite_state(session.id)["lastRequestId"])

    def test_concurrent_meta_and_timer_do_not_rollback_committed_fields(self) -> None:
        with _fixture() as (store, session, bridge, events):
            other = copy.deepcopy(session)
            other.id = "other"
            store.save(other, async_=False)
            entered, release = threading.Event(), threading.Event()
            original = store._atomic_write_text
            def slow(path, text):
                if threading.current_thread().name == "favorite-test":
                    entered.set()
                    self.assertTrue(release.wait(3))
                original(path, text)
            errors = []
            def submit():
                try:
                    store.commit_appearance(session.id, {"pinned": True}, expected_revision=0, request_id="first")
                except Exception as exc:
                    errors.append(exc)
            with patch.object(store, "_atomic_write_text", side_effect=slow):
                worker = threading.Thread(target=submit, name="favorite-test")
                worker.start()
                self.assertTrue(entered.wait(3))
                other.title = "concurrent"
                store.update_meta(other)
                session.title = "changed during IO"
                store.update_meta(session)
                release.set()
                worker.join(4)
                self.assertFalse(worker.is_alive())
            self.assertEqual([], errors)
            store._save_index_sync()
            rows = {row["id"]: row for row in json.loads(store._index_path.read_text(encoding="utf-8"))}
            self.assertTrue(rows[session.id]["pinned"])
            self.assertEqual("changed during IO", rows[session.id]["title"])
            self.assertEqual("concurrent", rows[other.id]["title"])

    def test_invalid_payloads_and_missing_session_never_write(self) -> None:
        with _fixture() as (store, session, bridge, events):
            for payload in [{}, {"pinned": 1, "expectedRevision": 0, "requestId": "a"},
                            {"pinned": True, "expectedRevision": True, "requestId": "a"},
                            {"pinned": True, "expectedRevision": -1, "requestId": "a"},
                            {"pinned": True, "expectedRevision": 0, "requestId": "a" * 129}]:
                self.assertEqual("error", json.loads(bridge._rpc_sessionFavoriteSet(session.id, json.dumps(payload)))["status"])
            self.assertEqual("not_found", json.loads(bridge._rpc_sessionFavoriteGet("missing"))["status"])
            self.assertEqual("not_found", store.commit_appearance("missing", {"pinned": True})["status"])
            self.assertEqual([], events)


if __name__ == "__main__":
    unittest.main()
