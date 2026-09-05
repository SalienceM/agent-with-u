import json
import unittest
from unittest.mock import Mock

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatAside, ChatExtras
from src.backend.loop_store import AsideTurn, LoopState


class ThoughtsAttentionTests(unittest.TestCase):
    def test_legacy_turns_migrate_to_session_context(self) -> None:
        chat = ChatAside.from_dict({"id": "chat", "question": "q"})
        loop = AsideTurn.from_dict({"id": "loop", "question": "q"})

        self.assertEqual("session", chat.context_key)
        self.assertEqual("session", chat.context_kind)
        self.assertEqual("session", loop.context_key)
        self.assertEqual("session", loop.context_kind)

    def test_attention_parser_is_bounded_and_rejects_unknown_kind(self) -> None:
        parsed = BridgeWS._parse_attention_json(json.dumps({
            "key": "file:x",
            "kind": "not-a-real-surface",
            "label": "L" * 500,
            "detail": "D" * 2000,
            "content": "C" * 60_000,
        }))

        self.assertEqual("file:x", parsed["key"])
        self.assertEqual("session", parsed["kind"])
        self.assertEqual(160, len(parsed["label"]))
        self.assertEqual(1200, len(parsed["detail"]))
        self.assertEqual(50_000, len(parsed["content"]))

    def test_attention_content_is_not_persisted(self) -> None:
        turn = ChatAside(
            id="aside", question="q", context_key="file:a.py",
            context_kind="file", context_label="a.py", context_detail="src/a.py",
        )
        payload = turn.to_dict()

        self.assertEqual("file:a.py", payload["contextKey"])
        self.assertNotIn("content", payload)
        self.assertNotIn("contextContent", payload)

    def test_chat_clear_can_target_one_attention_thread(self) -> None:
        extras = ChatExtras(session_id="chat", asides=[
            ChatAside(id="a", question="a", context_key="file:a"),
            ChatAside(id="b", question="b", context_key="file:b"),
        ])
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._chat_aside_running = set()
        bridge._chat_extras_get = Mock(return_value=extras)
        bridge._chat_extras_save = Mock()
        bridge._emit_chat_aside_updated = Mock()

        result = json.loads(bridge._rpc_chatAsideClear("chat", "file:a"))

        self.assertEqual(1, result["cleared"])
        self.assertEqual(["b"], [item.id for item in extras.asides])

    def test_loop_clear_can_target_one_attention_thread(self) -> None:
        state = LoopState(session_id="loop", asides=[
            AsideTurn(id="a", question="a", context_key="panel:settings"),
            AsideTurn(id="b", question="b", context_key="session"),
        ])
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._aside_running = set()
        bridge._loop_state = Mock(return_value=state)
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()

        result = json.loads(bridge._rpc_loopAsideClear("loop", "panel:settings"))

        self.assertEqual(1, result["cleared"])
        self.assertEqual(["b"], [item.id for item in state.asides])


if __name__ == "__main__":
    unittest.main()
