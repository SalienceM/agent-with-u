import unittest
from types import SimpleNamespace

from src.backend.token_usage import (
    ensure_session_ledger,
    record_context_event,
    record_session_usage,
    usage_summary,
)
from src.types import ChatMessage


class TokenUsageLedgerTests(unittest.TestCase):
    def test_legacy_messages_bootstrap_lifetime_totals_once(self):
        session = SimpleNamespace(
            token_usage={},
            messages=[
                ChatMessage(
                    id="a1", role="assistant", content="one",
                    usage={"inputTokens": 100, "outputTokens": 20},
                    backend_id="codex", timestamp=10,
                ),
                ChatMessage(
                    id="a2", role="assistant", content="two",
                    usage={"inputTokens": 140, "outputTokens": 30},
                    backend_id="codex", timestamp=20,
                ),
            ],
        )

        first = usage_summary(ensure_session_ledger(session))
        second = usage_summary(ensure_session_ledger(session))

        self.assertEqual(first["inputTokens"], 240)
        self.assertEqual(first["outputTokens"], 50)
        self.assertEqual(first["turnCount"], 2)
        self.assertEqual(second["totalTokens"], first["totalTokens"])

    def test_compaction_event_keeps_totals_and_is_counted(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        record_session_usage(
            session,
            usage={"inputTokens": 500, "outputTokens": 100},
            event_id="chat:a1", source="chat", stage="reply",
        )
        before = usage_summary(session.token_usage)
        record_context_event(
            session,
            event_type="manual_compaction",
            event_id="compact:1",
            label="手动压缩聊天历史",
            removed=12,
        )
        after = usage_summary(session.token_usage)

        self.assertEqual(after["totalTokens"], before["totalTokens"])
        self.assertEqual(after["contextEventCount"], 1)
        self.assertEqual(after["contextEvents"][-1]["removed"], 12)

    def test_configured_window_exposes_approximate_context_and_drop(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        record_session_usage(
            session,
            usage={"inputTokens": 80_000, "outputTokens": 500},
            event_id="loop:1:prepare", source="loop", stage="prepare",
            backend_id="qwen", context_window=100_000,
        )
        result = record_session_usage(
            session,
            usage={"inputTokens": 30_000, "outputTokens": 400},
            event_id="loop:1:analysis", source="loop", stage="analysis",
            backend_id="qwen", context_window=100_000,
        )

        self.assertEqual(result["latestContext"]["contextTokens"], 30_000)
        self.assertTrue(result["latestContext"]["contextApprox"])
        self.assertTrue(result["latestContext"]["contextDrop"])

    def test_missing_provider_usage_is_visibly_estimated(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        result = record_session_usage(
            session,
            usage=None,
            event_id="loop:idea:1", source="loop", stage="idea",
            prompt_text="请检查当前实现", output_text="已经完成检查并给出结果",
        )

        self.assertEqual(result["actualTurns"], 0)
        self.assertEqual(result["estimatedTurns"], 1)
        self.assertTrue(result["events"][-1]["estimated"])
        self.assertGreater(result["totalTokens"], 0)

    def test_native_thread_cumulative_usage_is_differenced(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        record_session_usage(
            session,
            usage={
                "inputTokens": 1_000, "outputTokens": 100,
                "cumulative": True, "contextId": "thread-1",
            },
            event_id="chat:a1", source="chat", stage="reply", backend_id="codex",
        )
        result = record_session_usage(
            session,
            usage={
                "inputTokens": 1_600, "outputTokens": 180,
                "cumulative": True, "contextId": "thread-1",
            },
            event_id="chat:a2", source="chat", stage="reply", backend_id="codex",
        )

        self.assertEqual(result["inputTokens"], 1_600)
        self.assertEqual(result["outputTokens"], 180)
        self.assertEqual(result["events"][-1]["inputTokens"], 600)
        self.assertEqual(result["events"][-1]["outputTokens"], 80)


if __name__ == "__main__":
    unittest.main()
