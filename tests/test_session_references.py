import unittest
from types import SimpleNamespace

from src.backend.bridge_ws import BridgeWS
from src.types import ChatMessage


class SessionReferenceContextTests(unittest.TestCase):
    def test_normal_session_reference_keeps_visible_recent_messages(self):
        bridge = BridgeWS.__new__(BridgeWS)
        referenced = SimpleNamespace(
            id="session-ref",
            title="参考会话",
            backend_id="backend-ref",
            session_type="normal",
            messages=[
                ChatMessage(id="m1", role="user", content="关键背景"),
                ChatMessage(id="m2", role="assistant", content="已确认方案"),
            ],
        )
        bridge._resolve_session_ref_token = lambda token, _current: (
            referenced if token == "session-ref" else None
        )

        expanded = bridge._build_session_reference_context(
            "继续处理 @SESSION:session-ref ", "session-current",
        )

        self.assertIn("Referenced session: 参考会话 (session-ref)", expanded)
        self.assertIn("关键背景", expanded)
        self.assertIn("已确认方案", expanded)
        self.assertTrue(expanded.endswith("继续处理 @SESSION:session-ref "))

    def test_loop_session_reference_uses_stage_digest_instead_of_empty_chat(self):
        bridge = BridgeWS.__new__(BridgeWS)
        loop_state = object()
        referenced = SimpleNamespace(
            id="loop-ref",
            title="自动 LOOP",
            backend_id="backend-ref",
            session_type="loop",
            messages=[],
        )
        bridge._resolve_session_ref_token = lambda _token, _current: referenced
        bridge._loop_state = lambda sid: loop_state if sid == "loop-ref" else None
        bridge._loop_context_digest = lambda state: (
            "阶段(stage): loopexecute\n全局目标(goal): 完成交付"
            if state is loop_state else ""
        )

        expanded = bridge._build_session_reference_context(
            "参考 @SESSION:loop-ref 再规划", "session-current",
        )

        self.assertIn("阶段(stage): loopexecute", expanded)
        self.assertIn("全局目标(goal): 完成交付", expanded)
        self.assertNotIn("(empty session)", expanded)

    def test_plain_prompt_is_not_rewritten(self):
        bridge = BridgeWS.__new__(BridgeWS)
        prompt = "没有引用的普通提示"

        self.assertIs(bridge._build_session_reference_context(prompt, "current"), prompt)


class LoopSessionReferenceBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_loop_agent_expands_references_before_backend_call(self):
        captured = {}

        class Backend:
            async def send_message(self, **kwargs):
                captured.update(kwargs)
                return {}

            def clear_cancelled(self, _session_id):
                return None

        backend = Backend()
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_active_backends = {}
        bridge._new_backend_instance = lambda _backend_id: backend
        bridge._build_session_reference_context = lambda prompt, sid: (
            f"expanded[{sid}]:{prompt}"
        )
        bridge._emit_loop_progress = lambda *_args, **_kwargs: None
        bridge._add_runtime_kwargs = lambda *_args, **_kwargs: None
        session = SimpleNamespace(
            id="loop-current",
            backend_id="backend-current",
            agent_session_id=None,
            working_dir=".",
            sandbox_enabled=False,
        )

        await bridge._loop_run_agent(
            session,
            "使用 @SESSION:loop-ref",
            sub_stage="idea",
            seq=-1,
            resume=False,
        )

        self.assertEqual(
            captured["content"],
            "expanded[loop-current]:使用 @SESSION:loop-ref",
        )


if __name__ == "__main__":
    unittest.main()
