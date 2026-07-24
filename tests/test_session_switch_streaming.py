import asyncio
import unittest

from src.backend.bridge_ws import BridgeWS
from src.backend.base import StreamDelta
from src.types import ChatMessage, Session


class _StreamingBackend:
    def __init__(self) -> None:
        self.delta_sent = asyncio.Event()
        self.release = asyncio.Event()

    async def send_message(self, **kwargs):
        kwargs["on_delta"](StreamDelta(
            kwargs["session_id"],
            kwargs["message_id"],
            "text_delta",
            text="已经输出的内容",
        ))
        self.delta_sent.set()
        await self.release.wait()
        return {"stopReason": "end_turn"}


class SessionSwitchStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_in_memory_session_exposes_partial_assistant_text(self) -> None:
        bridge = BridgeWS.__new__(BridgeWS)
        backend = _StreamingBackend()
        bridge._get_backend = lambda _backend_id: backend
        bridge._collect_backend_skills = lambda _session: ([], {})
        bridge._add_runtime_kwargs = lambda *_args, **_kwargs: None
        bridge._emit_delta = lambda _delta: None
        bridge._clear_skip_permission = lambda _sid: None
        bridge._emit_session_updated = lambda _event: None
        bridge._session_store = type("Store", (), {"save": lambda *_args, **_kwargs: None})()

        assistant = ChatMessage(
            id="assistant-1",
            role="assistant",
            content="",
            streaming=True,
        )
        session = Session(
            id="session-1",
            title="Session",
            created_at=1,
            updated_at=1,
            messages=[
                ChatMessage(id="user-1", role="user", content="问题"),
                assistant,
            ],
            working_dir=".",
            backend_id="backend-1",
        )

        task = asyncio.create_task(bridge._async_send(
            session,
            "问题",
            None,
            "backend-1",
            "assistant-1",
        ))
        await backend.delta_sent.wait()

        self.assertEqual(assistant.content, "已经输出的内容")
        self.assertTrue(assistant.streaming)

        backend.release.set()
        await task
        self.assertFalse(assistant.streaming)


if __name__ == "__main__":
    unittest.main()
