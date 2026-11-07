import unittest
from types import SimpleNamespace

from src.backend.token_usage import (
    ensure_session_ledger,
    record_context_event,
    record_session_usage,
    usage_summary,
    turn_usage_from_summary,
    merge_call_usage,
    finish_call_usage,
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

    def test_configured_window_needs_explicit_last_request_input(self):
        session = SimpleNamespace(token_usage={}, messages=[], session_type="loop")
        record_session_usage(
            session,
            usage={"inputTokens": 180_000, "contextTokens": 80_000, "outputTokens": 500},
            event_id="loop:1:prepare", source="loop", stage="prepare",
            backend_id="qwen", context_window=100_000,
        )
        result = record_session_usage(
            session,
            usage={"inputTokens": 90_000, "contextTokens": 30_000, "outputTokens": 400},
            event_id="loop:1:analysis", source="loop", stage="analysis",
            backend_id="qwen", context_window=100_000,
        )

        self.assertEqual(result["latestContext"]["contextTokens"], 30_000)
        self.assertEqual(result["latestContext"]["contextWindowSource"], "configured")
        self.assertTrue(result["latestContext"]["contextDrop"])

    def record(self, session, usage, identity="a", **kwargs):
        return record_session_usage(session, usage=usage, event_id=identity,
                                    source=kwargs.pop("source", "chat"), stage="reply", **kwargs)

    def test_aggregate_never_becomes_context(self):
        result = self.record(SimpleNamespace(token_usage={}, messages=[]),
                             {"inputTokens": 90_000}, context_window=100_000)
        self.assertIsNone(result["latestContext"])
        self.assertNotIn("contextTokens", result["events"][-1])

    def test_context_without_window_zero_and_missing_supersede_old(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        result = self.record(session, {"inputTokens": 670951, "contextTokens": 171859})
        self.assertEqual(result["latestContext"]["contextTokens"], 171859)
        self.assertNotIn("contextWindow", result["latestContext"])
        result = self.record(session, {"reported": True, "contextTokens": 0}, "zero")
        self.assertEqual(result["latestContext"]["contextTokens"], 0)
        result = self.record(session, {"inputTokens": 90}, "unknown")
        self.assertIsNone(result["latestContext"])

    def test_invalid_context_is_unknown_not_zero(self):
        for invalid in (True, -1, "unknown", float("inf")):
            result = self.record(SimpleNamespace(token_usage={}, messages=[]), {"inputTokens": 5, "contextTokens": invalid})
            self.assertIsNone(result["latestContext"])

    def test_reset_and_identity_changes_invalidate_context_but_keep_totals(self):
        session = SimpleNamespace(token_usage={}, messages=[], backend_id="b", model_override="m", agent_session_id="thread")
        for index, key in enumerate(("backend_id", "model_override", "agent_session_id")):
            before = self.record(session, {"inputTokens": 100, "contextTokens": 20, "contextId": session.agent_session_id},
                                 str(index), backend_id=session.backend_id, model=session.model_override)
            self.assertIsNotNone(before["latestContext"])
            setattr(session, key, "new-" + key)
            after = usage_summary(ensure_session_ledger(session))
            self.assertIsNone(after["latestContext"])
            self.assertEqual(after["totalTokens"], before["totalTokens"])
        self.record(session, {"contextTokens": 20}, "reset", backend_id=session.backend_id, model=session.model_override)
        result = record_context_event(session, event_type="context_reset", event_id="clear", label="reset")
        self.assertIsNone(result["latestContext"])

    def test_late_old_model_and_auxiliary_calls_cannot_replace_chat_context(self):
        session = SimpleNamespace(token_usage={}, messages=[], model_override="m")
        self.record(session, {"inputTokens": 100, "contextTokens": 100}, model="m")
        result = self.record(session, {"inputTokens": 9000, "contextTokens": 9000}, "aux", source="loop", model="m")
        self.assertEqual(result["latestContext"]["contextTokens"], 100)
        self.assertEqual(result["inputTokens"], 9100)
        result = self.record(session, {"inputTokens": 10, "contextCompacted": True}, "aux-compact", source="loop", model="m")
        self.assertEqual(result["latestContext"]["contextTokens"], 100)
        session.model_override = "next"
        result = self.record(session, {"inputTokens": 200, "contextTokens": 200}, "late", model="m")
        self.assertIsNone(result["latestContext"])

    def test_legacy_ledger_preserves_totals_and_capture_but_not_stale_context(self):
        session = SimpleNamespace(messages=[], token_usage={"version": 1, "inputTokens": 6040059,
            "actualTurns": 10, "captureEnabled": True, "events": [{"contextTokens": 999, "contextWindow": 1000}]})
        result = usage_summary(ensure_session_ledger(session))
        self.assertEqual(result["inputTokens"], 6040059)
        self.assertTrue(result["legacyHistory"])
        self.assertTrue(result["captureEnabled"])
        self.assertIsNone(result["latestContext"])

    def test_resumed_codex_missing_baseline_and_turn_footer_roundtrip(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        usage = {"inputTokens": 1000000, "outputTokens": 10000, "reported": True,
                 "cumulative": True, "baselineRequired": True, "contextId": "native", "contextTokens": 30000}
        first = self.record(session, usage, "first", backend_id="codex", prompt_text="hello")
        self.assertLess(first["inputTokens"], 10)
        self.assertTrue(first["events"][-1]["estimated"])
        second = self.record(session, {**usage, "inputTokens": 1000600, "outputTokens": 10010}, "second", backend_id="codex")
        footer = turn_usage_from_summary(second, "second")
        self.assertEqual(footer["inputTokens"], 600)
        self.assertEqual(footer["providerCumulative"]["inputTokens"], 1000600)
        self.assertNotIn("cumulative", footer)
        restored = SimpleNamespace(token_usage={}, messages=[ChatMessage(id="saved", role="assistant", content="ok", usage=footer)])
        result = usage_summary(ensure_session_ledger(restored))
        self.assertEqual(result["inputTokens"], 600)
        self.assertFalse(result["legacyHistory"])

    def test_native_new_thread_continuations_preserve_initial_zero_baseline(self):
        totals = dict.fromkeys(("inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"), 0)
        metadata = {}
        for index in range(2):
            merge_call_usage(totals, metadata, {"inputTokens": 100 * (index + 1), "reported": True,
                "cumulative": True, "contextId": "new-thread", "baselineRequired": bool(index),
                "nativeResumed": bool(index), "contextTokens": 50 + index})
        usage = finish_call_usage(totals, metadata)
        self.assertFalse(usage["baselineRequired"])
        result = self.record(SimpleNamespace(token_usage={}, messages=[]), usage)
        self.assertEqual(result["inputTokens"], 200)
        self.assertFalse(result["events"][-1]["estimated"])

    def test_continuation_missing_context_and_request_totals(self):
        totals = dict.fromkeys(("inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"), 0)
        metadata = {}
        merge_call_usage(totals, metadata, {"inputTokens": 100, "contextTokens": 50, "requestCount": 2})
        merge_call_usage(totals, metadata, {"inputTokens": 120, "requestCount": 3})
        usage = finish_call_usage(totals, metadata)
        self.assertEqual((usage["inputTokens"], usage["requestCount"]), (220, 5))
        self.assertNotIn("contextTokens", usage)
        merge_call_usage(totals, metadata, None)
        self.assertIn("usageWarning", finish_call_usage(totals, metadata))

    def test_mixed_native_counters_do_not_masquerade_as_exact_turn_usage(self):
        totals = dict.fromkeys(("inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"), 0)
        metadata = {}
        for context_id, value in (("old", 100000), ("new", 200)):
            merge_call_usage(totals, metadata, {"inputTokens": value, "reported": True, "cumulative": True, "contextId": context_id})
        usage = finish_call_usage(totals, metadata)
        session = SimpleNamespace(token_usage={}, messages=[])
        result = self.record(session, usage, prompt_text="hello")
        self.assertTrue(result["events"][-1]["estimated"])
        self.assertEqual(session.token_usage["cumulativeBaselines"][":new"]["inputTokens"], 200)

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
