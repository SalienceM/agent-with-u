"""Actual orchestration + ledger, fake providers/storage; no live Session access."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.base import StreamDelta
from src.backend.bridge_ws import BridgeWS
from src.backend.token_usage import ensure_session_ledger
from src.types import ChatMessage, Session


class TokenUsageBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def run_turn(self, resumed=False, switch_model=False):
        session = Session(id="fixture", title="Fixture", created_at=1, updated_at=1, backend_id="fake", working_dir="fixture-only",
                          model_override="model", agent_session_id="native" if resumed else None,
                          messages=[ChatMessage(id="u", role="user", content="hello"),
                                    ChatMessage(id="a", role="assistant", content="")])
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._backend_configs = []
        bridge._collect_backend_skills = Mock(return_value=([], {}))
        bridge._clear_skip_permission = Mock()
        bridge._add_runtime_kwargs = Mock()
        bridge._session_store = Mock()
        bridge._emit_session_updated = Mock()
        bridge._finalize_or_remove_assistant = Mock()
        deltas = []
        bridge._emit_delta = deltas.append
        calls = []
        async def send(**kwargs):
            index = len(calls)
            calls.append(kwargs)
            if switch_model:
                session.model_override = "next-model"
            kwargs["on_delta"](StreamDelta("fixture", "a", "text_delta", text="answer"))
            kwargs["on_delta"](StreamDelta("fixture", "a", "done", usage={
                "inputTokens": 100000 + index * 600, "outputTokens": 1000 + index * 10,
                "cumulative": True, "baselineRequired": bool(kwargs.get("agent_session_id")),
                "reported": True, "contextId": "native", "contextTokens": 30000 + index,
            }))
            return {"agentSessionId": "native", "stopReason": "max_tokens" if index == 0 else "end_turn"}
        bridge._get_backend = lambda _id: SimpleNamespace(send_message=send)
        if resumed:
            ensure_session_ledger(session)["cumulativeBaselines"]["fake:native"] = {"inputTokens": 99000, "outputTokens": 900}
        with patch("src.backend.bridge_ws.print"):
            success = await bridge._async_send_with_kit_tools(session=session, backend_id="fake", content="hello",
                                                            images=None, message_id="a", runtime={"model": "model"})
        self.assertTrue(success)
        self.assertEqual(len(calls), 2)
        self.assertEqual(deltas[-1].type, "done")
        self.assertEqual(deltas[-1].usage, session.messages[-1].usage)
        self.assertEqual(deltas[-1].usage["usageScope"], "turn")
        self.assertNotIn("cumulative", deltas[-1].usage)
        bridge._session_store.save.assert_called_once()
        return session

    async def test_resumed_thread_footer_is_turn_delta_not_thread_total(self):
        session = await self.run_turn(resumed=True)
        self.assertEqual(session.messages[-1].usage["inputTokens"], 1600)
        self.assertEqual(session.messages[-1].usage["providerCumulative"]["inputTokens"], 100600)
        self.assertEqual(session.token_usage["inputTokens"], 1600)

    async def test_fresh_thread_continuation_is_not_missing_baseline(self):
        session = await self.run_turn()
        self.assertEqual(session.token_usage["inputTokens"], 100600)
        self.assertFalse(session.messages[-1].usage["estimated"])

    async def test_late_frozen_model_usage_remains_cost_not_current_context(self):
        session = await self.run_turn(switch_model=True)
        self.assertIsNone(session.token_usage["latestContexts"]["chat"])
        self.assertEqual(session.token_usage["inputTokens"], 100600)


if __name__ == "__main__":
    unittest.main()
