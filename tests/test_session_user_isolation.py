import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.base import StreamDelta
from src.backend.bridge_ws import (
    BridgeWS,
    _REQUEST_CAN_CLAIM_LEGACY,
    _REQUEST_IDENTITY_SOURCE,
    _REQUEST_OWNER_ID,
)
from src.backend.session_store import SessionStore
from src.types import ChatMessage, Session


class _MemorySessionStore:
    def __init__(self, sessions):
        self.sessions = {session.id: session for session in sessions}

    def list(self):
        return [session.meta_dict() for session in self.sessions.values()]

    def get_meta(self, session_id):
        session = self.sessions.get(session_id)
        return session.meta_dict() if session else None

    def load(self, session_id):
        return self.sessions.get(session_id)

    def save(self, session, async_=True):
        del async_
        self.sessions[session.id] = session

    def update_meta(self, session):
        self.sessions[session.id] = session

    def reassign_legacy_sessions(self, session_ids, target_owner_id):
        for session_id in session_ids:
            self.sessions[session_id].owner_id = target_owner_id
        return {
            "count": len(session_ids),
            "sessionIds": list(session_ids),
            "backupPath": "memory-backup.tar.gz",
        }

    def delete(self, session_id):
        return self.sessions.pop(session_id, None) is not None


class _Client:
    def __init__(self, identity, source="relay"):
        self.identity = identity
        self.identity_src = source
        self.sent = []

    async def send(self, payload):
        self.sent.append(json.loads(payload))


def _session(session_id, owner_id, working_dir):
    return Session(
        id=session_id,
        title=session_id,
        created_at=1,
        updated_at=1,
        messages=[ChatMessage(id=f"{session_id}-m", role="user", content=session_id)],
        working_dir=working_dir,
        backend_id="backend",
        owner_id=owner_id,
    )


def _stop_store(store):
    store._io_running = False
    if store._io_thread:
        store._io_thread.join(timeout=1)
    if store._index_save_timer:
        store._index_save_timer.cancel()


class SessionUserIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.alice = _session("alice-session", "alice-id", str(root / "alice"))
        self.bob = _session("bob-session", "bob-id", str(root / "bob"))
        self.local = _session("legacy-local", "local", str(root / "local"))

        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._session_store = _MemorySessionStore(
            [self.alice, self.bob, self.local]
        )
        self.bridge._active_sessions = {
            session.id: session for session in (self.alice, self.bob, self.local)
        }
        self.bridge._ensure_kit_scheduler = lambda: None
        self.bridge._sync_backend_skills_to_directory = lambda _session: None
        self.bridge._backend_configs = []
        self.bridge._default_abilities = lambda: {"skills": [], "prompts": []}
        self.bridge._emit_session_updated = lambda *_args, **_kwargs: None
        self.bridge._clients = set()
        self.bridge._chat_turn_tasks = {}
        self.bridge._seq_dispatch_reservations = {}
        self.bridge._loop_tasks = {}
        self.bridge._loop_running = set()
        self.bridge._aside_running = set()
        self.bridge._chat_aside_running = set()
        self.bridge._kit_optimization_running = set()
        self.bridge._kit_tasks = {}
        self.bridge._kit_states = {}

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def _dispatch_as(
        self, owner_id, method, *params, source="internal", can_claim=False,
    ):
        token = _REQUEST_OWNER_ID.set(owner_id)
        source_token = _REQUEST_IDENTITY_SOURCE.set(source)
        claim_token = _REQUEST_CAN_CLAIM_LEGACY.set(can_claim)
        try:
            return await self.bridge._dispatch(method, list(params))
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(claim_token)
            _REQUEST_IDENTITY_SOURCE.reset(source_token)
            _REQUEST_OWNER_ID.reset(token)

    async def test_lists_are_filtered_for_remote_and_local_users(self):
        alice_rows = json.loads(await self._dispatch_as("alice-id", "listSessions"))
        bob_rows = json.loads(await self._dispatch_as("bob-id", "listSessions"))
        local_rows = json.loads(await self._dispatch_as("local", "listSessions"))

        self.assertEqual(["alice-session"], [item["id"] for item in alice_rows])
        self.assertEqual(["bob-session"], [item["id"] for item in bob_rows])
        self.assertEqual(["legacy-local"], [item["id"] for item in local_rows])

    async def test_foreign_session_rpc_fails_before_any_handler_runs(self):
        calls = [
            ("loadSession", self.alice.id, 25),
            ("renameSession", self.alice.id, "stolen"),
            ("loopGetState", self.alice.id, True),
            ("kitGetState", self.alice.id),
            ("sendMessage", json.dumps({
                "sessionId": self.alice.id,
                "backendId": "backend",
                "content": "must not run",
            })),
        ]
        for call in calls:
            with self.subTest(method=call[0]):
                with self.assertRaises(PermissionError):
                    await self._dispatch_as("bob-id", call[0], *call[1:])

        self.assertEqual("alice-session", self.alice.title)

    async def test_foreign_workspace_file_rpc_is_rejected(self):
        with self.assertRaises(PermissionError):
            await self._dispatch_as(
                "bob-id", "syncReadFile", self.alice.working_dir, "secret.txt",
            )

    async def test_new_session_is_owned_by_authenticated_user(self):
        working_dir = str(Path(self.temp.name) / "alice-new")
        payload = json.loads(await self._dispatch_as(
            "alice-id", "createSession", working_dir, "backend", "normal", "", "",
        ))

        self.assertEqual("alice-id", payload["ownerId"])
        stored = self.bridge._session_store.load(payload["id"])
        self.assertEqual("alice-id", stored.owner_id)

    async def test_stream_events_go_only_to_session_owner(self):
        alice_one = _Client("alice-id")
        alice_two = _Client("alice-id")
        bob = _Client("bob-id")
        local = _Client("local", "loopback")
        self.bridge._clients = {alice_one, alice_two, bob, local}

        self.bridge._emit_delta(StreamDelta(
            self.alice.id, "assistant-1", "text_delta", text="private",
        ))
        await asyncio.sleep(0.02)

        self.assertEqual(1, len(alice_one.sent))
        self.assertEqual(1, len(alice_two.sent))
        self.assertEqual("streamDelta", alice_one.sent[0]["event"])
        self.assertEqual([], bob.sent)
        self.assertEqual([], local.sent)

    async def test_only_relay_default_user_can_claim_legacy_sessions(self):
        with self.assertRaises(PermissionError):
            await self._dispatch_as(
                "alice-id", "legacySessionOwnershipPreview",
                source="relay", can_claim=False,
            )

        preview = json.loads(await self._dispatch_as(
            "alice-id", "legacySessionOwnershipPreview",
            source="relay", can_claim=True,
        ))
        self.assertEqual(["legacy-local"], [item["id"] for item in preview["items"]])

        result = json.loads(await self._dispatch_as(
            "alice-id", "claimLegacySessions",
            json.dumps(["legacy-local"]), "CLAIM_LOCAL_SESSIONS",
            source="relay", can_claim=True,
        ))
        self.assertEqual("ok", result["status"])
        self.assertEqual("alice-id", self.local.owner_id)
        self.assertEqual(
            {"alice-session", "legacy-local"},
            {item["id"] for item in json.loads(await self._dispatch_as(
                "alice-id", "listSessions",
            ))},
        )


class SessionOwnerPersistenceTests(unittest.TestCase):
    def test_owner_survives_restart_and_legacy_defaults_to_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sessions"
            with patch("src.backend.session_store.paths.sub", return_value=root):
                store = SessionStore()
                owned = _session("owned", "alice-id", str(Path(tmp) / "owned"))
                store.save(owned, async_=False)

                legacy = _session("legacy", "local", str(Path(tmp) / "legacy")).to_dict()
                legacy.pop("ownerId", None)
                (root / "legacy.json").write_text(
                    json.dumps(legacy, ensure_ascii=False), encoding="utf-8",
                )

                reloaded = SessionStore()
                self.assertEqual("alice-id", reloaded.load("owned").owner_id)
                self.assertEqual("local", reloaded.load("legacy").owner_id)
                _stop_store(reloaded)
                _stop_store(store)

    def test_legacy_owner_claim_is_backed_up_and_persisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sessions"
            with patch("src.backend.session_store.paths.sub", return_value=root):
                store = SessionStore()
                legacy = _session("legacy", "local", str(Path(tmp) / "legacy"))
                legacy_relay = _session(
                    "legacy-relay", "legacy", str(Path(tmp) / "legacy-relay"),
                )
                owned = _session("owned", "bob-id", str(Path(tmp) / "owned"))
                store.save(legacy, async_=False)
                store.save(legacy_relay, async_=False)
                store.save(owned, async_=False)

                result = store.reassign_legacy_sessions(
                    ["legacy", "legacy-relay"], "alice-id",
                )
                self.assertEqual(2, result["count"])
                self.assertTrue(Path(result["backupPath"]).exists())
                self.assertEqual("alice-id", store.get_meta("legacy")["ownerId"])
                self.assertEqual("alice-id", store.get_meta("legacy-relay")["ownerId"])
                self.assertEqual("bob-id", store.get_meta("owned")["ownerId"])

                reloaded = SessionStore()
                self.assertEqual("alice-id", reloaded.load("legacy").owner_id)
                self.assertEqual("alice-id", reloaded.load("legacy-relay").owner_id)
                self.assertEqual("bob-id", reloaded.load("owned").owner_id)
                _stop_store(reloaded)
                _stop_store(store)


if __name__ == "__main__":
    unittest.main()
