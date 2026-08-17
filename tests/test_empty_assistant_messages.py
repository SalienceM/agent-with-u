import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from src.backend.bridge_ws import BridgeWS
from src.backend.session_store import SessionStore
from src.types import ChatMessage, Session


class _EmptyBackend:
    async def send_message(self, **_kwargs):
        return {"stopReason": "end_turn"}


class _CancelledBackend:
    async def send_message(self, **_kwargs):
        raise asyncio.CancelledError


class EmptyAssistantPersistenceTests(unittest.TestCase):
    def test_legacy_empty_assistant_is_removed_but_non_text_payloads_survive(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = SessionStore.__new__(SessionStore)
            store._dir = Path(temp_dir)
            payload = {
                "id": "legacy",
                "title": "Legacy",
                "createdAt": 1,
                "updatedAt": 2,
                "workingDir": ".",
                "backendId": "backend",
                "messages": [
                    {"id": "u", "role": "user", "content": "question", "timestamp": 1},
                    {"id": "empty", "role": "assistant", "content": "", "timestamp": 2},
                    {
                        "id": "thinking", "role": "assistant", "content": "", "timestamp": 3,
                        "thinkingBlocks": [{"content": "checked the workspace"}],
                    },
                    {
                        "id": "tool", "role": "assistant", "content": "", "timestamp": 4,
                        "toolCalls": [{"name": "shell", "status": "done"}],
                    },
                ],
            }
            (Path(temp_dir) / "legacy.json").write_text(
                json.dumps(payload), encoding="utf-8",
            )

            session = store.load("legacy")

        self.assertIsNotNone(session)
        self.assertEqual([message.id for message in session.messages], ["u", "thinking", "tool"])
        self.assertEqual(session.messages[1].thinking_blocks[0].content, "checked the workspace")
        self.assertTrue(session.messages[2].tool_calls)


class EmptyAssistantStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def _run_empty_backend(self, backend):
        bridge = BridgeWS.__new__(BridgeWS)
        emitted = []
        bridge._get_backend = lambda _backend_id: backend
        bridge._collect_backend_skills = lambda _session: ([], {})
        bridge._add_runtime_kwargs = lambda *_args, **_kwargs: None
        bridge._emit_delta = emitted.append
        bridge._clear_skip_permission = lambda _sid: None
        bridge._emit_session_updated = lambda _event: None
        bridge._session_store = SimpleNamespace(save=lambda *_args, **_kwargs: None)

        assistant = ChatMessage(
            id="assistant", role="assistant", content="", streaming=True,
        )
        session = Session(
            id="session", title="Session", created_at=1, updated_at=1,
            messages=[
                ChatMessage(id="user", role="user", content="question"),
                assistant,
            ],
            working_dir=".", backend_id="backend",
        )

        await bridge._async_send(session, "question", None, "backend", "assistant")

        return session, emitted

    async def test_empty_done_removes_backend_placeholder(self):
        session, emitted = await self._run_empty_backend(_EmptyBackend())

        self.assertEqual([message.id for message in session.messages], ["user"])
        self.assertTrue(any(delta.type == "done" for delta in emitted))

    async def test_backend_cancel_still_finishes_and_removes_placeholder(self):
        session, emitted = await self._run_empty_backend(_CancelledBackend())

        self.assertEqual([message.id for message in session.messages], ["user"])
        self.assertTrue(any(delta.type == "done" for delta in emitted))


if __name__ == "__main__":
    unittest.main()
