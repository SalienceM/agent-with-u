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

    def test_skill_reference_is_auxiliary_and_never_erases_attention(self) -> None:
        for kind, key in [('session', 'session'), ('file', 'file:remote:README.md'), ('skills', 'panel:library')]:
            with self.subTest(kind=kind):
                attention = {'kind': kind, 'key': key, 'label': 'current project', 'content': 'visible project data'}
                self.assertEqual(attention, BridgeWS._skill_reference_attention('@SKILL:demo 如何用在这个项目', attention))
        legacy = BridgeWS._skill_reference_attention('@SKILL:demo 继续', {'kind': 'skills', 'key': 'skills:demo'})
        self.assertEqual(legacy['key'], 'session')
        self.assertEqual(legacy['kind'], 'session')

    def test_old_skill_threads_migrate_without_losing_turns_or_panel_history(self) -> None:
        for model in (ChatAside, AsideTurn):
            old = {'id': 'old', 'question': '@SKILL:demo 怎么用', 'answer': 'original answer', 'status': 'done',
                   'contextKey': 'skills:demo', 'contextKind': 'skills', 'contextLabel': 'Skill 手册 · demo',
                   'createdAt': 123, 'imageCount': 1}
            migrated = model.from_dict(old)
            self.assertEqual(migrated.context_key, 'session')
            self.assertEqual(migrated.context_kind, 'session')
            self.assertEqual(migrated.context_label, '')
            self.assertEqual(migrated.question, old['question'])
            self.assertEqual(migrated.answer, old['answer'])
            self.assertEqual(migrated.created_at, 123)
            self.assertEqual(migrated.image_count, 1)
            self.assertEqual(old['contextKey'], 'skills:demo')
            panel = model.from_dict({**old, 'contextKey': 'panel:library'})
            self.assertEqual(panel.context_key, 'panel:library')

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
