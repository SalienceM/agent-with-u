import unittest
from types import SimpleNamespace

from src.backend.qwen_usage import QwenTurnUsage
from src.backend.token_usage import record_session_usage, ensure_session_ledger


def assistant(identity, input_tokens, output_tokens=10, cache=0):
    return {"type": "assistant", "uuid": identity, "message": {
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens,
                  "cache_read_input_tokens": cache}}}


class QwenUsageTests(unittest.TestCase):
    def record(self, session, usage, identity):
        return record_session_usage(session, usage=usage, event_id=identity,
                                    source="chat", stage="reply", backend_id="qwen",
                                    prompt_text="你是谁", output_text="回答")

    def test_resumed_turn_counts_completed_messages_not_historical_result(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        for index, (current, total) in enumerate(((100, 100), (120, 220))):
            turn = QwenTurnUsage()
            msg = assistant(str(index), current, cache=30)
            turn.observe(msg)
            turn.observe(msg)  # duplicate completed event
            result = turn.finish({"input_tokens": total, "output_tokens": 10 * (index + 1)}, "thread", bool(index))
            self.record(session, result, str(index))
        self.assertEqual(session.token_usage["inputTokens"], 220)
        self.assertEqual(session.token_usage["cachedInputTokens"], 60)
        self.assertEqual(session.token_usage["events"][-1]["contextTokens"], 120)
        self.assertEqual(result["providerUsage"]["input_tokens"], 220)

    def test_multi_request_turn_and_cache_are_added_once(self):
        turn = QwenTurnUsage()
        turn.observe(assistant("a", 90, 4, 50))
        turn.observe(assistant("b", 110, 6, 60))
        usage = turn.finish({"input_tokens": 99999, "output_tokens": 900}, "thread", True)
        self.assertEqual((usage["inputTokens"], usage["outputTokens"], usage["cachedInputTokens"]), (200, 10, 110))
        self.assertEqual(usage["usageEventCount"], 2)
        self.assertNotIn("requestCount", usage)

    def test_native_delta_is_separate_from_reply_usage(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        for i, (visible, cumulative) in enumerate(((100, 110), (120, 240))):
            turn = QwenTurnUsage()
            turn.observe(assistant(str(i), visible))
            result = self.record(session, turn.finish({"input_tokens": cumulative, "output_tokens": 10 * (i + 1)}, "thread", bool(i)), str(i))
        self.assertEqual(result["inputTokens"], 220)
        event = result["events"][-1]
        self.assertEqual(event["inputTokens"], 120)
        self.assertEqual(event["usageSource"], "qwen-assistant-turn")
        self.assertEqual(event["qwenAccounting"]["cumulativeDelta"]["inputTokens"], 130)
        self.assertEqual(event["qwenAccounting"]["unattributedDelta"]["inputTokens"], 10)
        self.assertEqual(event["qwenAccounting"]["baselineEventId"], "0")

    def test_user_0198_fixture_keeps_20598_290_and_audits_35500_755(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        ensure_session_ledger(session)["cumulativeBaselines"]["qwen:native"] = {
            "inputTokens": 36721, "outputTokens": 229, "cachedInputTokens": 0, "eventId": "previous"}
        turn = QwenTurnUsage()
        turn.observe(assistant("thinking", 0, 0))
        turn.observe(assistant("text", 20598, 290))
        turn.observe(assistant("text", 20598, 290))
        result = self.record(session, turn.finish({"input_tokens": 72221, "output_tokens": 984,
                            "cache_read_input_tokens": 10019}, "native", True), "current")
        event = result["events"][-1]
        self.assertEqual((event["inputTokens"], event["outputTokens"]), (20598, 290))
        self.assertEqual(event["usageEventCount"], 2)  # thinking + text, not two requests
        self.assertEqual(event["zeroUsageEventCount"], 1)
        audit = event["qwenAccounting"]
        self.assertEqual(audit["status"], "unattributed")
        self.assertEqual(audit["cumulativeDelta"]["inputTokens"], 35500)
        self.assertEqual(audit["cumulativeDelta"]["outputTokens"], 755)
        self.assertEqual(audit["unattributedDelta"]["inputTokens"], 14902)
        self.assertEqual(audit["unattributedDelta"]["outputTokens"], 465)
        self.assertEqual(audit["cumulativeBefore"]["inputTokens"], 36721)
        self.assertEqual(audit["cumulativeAfter"]["inputTokens"], 72221)
        self.assertEqual(audit["countedUsage"], audit["replyUsage"])

    def test_resumed_missing_checkpoint_never_invents_zero_baseline(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        turn = QwenTurnUsage()
        turn.observe(assistant("text", 20598, 290))
        event = self.record(session, turn.finish({"input_tokens": 72221, "output_tokens": 984}, "native", True), "a")["events"][-1]
        self.assertIsNone(event["qwenAccounting"]["cumulativeDelta"])
        self.assertIsNone(event["qwenAccounting"]["unattributedDelta"])
        self.assertEqual(event["qwenAccounting"]["status"], "missing-baseline")
        self.assertEqual(event["inputTokens"], 20598)

    def test_counter_reset_is_flagged_without_replacing_reply(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        ensure_session_ledger(session)["cumulativeBaselines"]["qwen:native"] = {"inputTokens": 500, "outputTokens": 50}
        turn = QwenTurnUsage()
        turn.observe(assistant("reply", 100, 10))
        event = self.record(session, turn.finish({"input_tokens": 100, "output_tokens": 10}, "native", True), "a")["events"][-1]
        self.assertEqual(event["inputTokens"], 100)
        self.assertEqual(event["qwenAccounting"]["status"], "counter-reset")
        self.assertEqual(event["qwenAccounting"]["cumulativeDelta"]["inputTokens"], -400)

    def test_result_only_resume_uses_persisted_baseline(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        self.record(session, QwenTurnUsage().finish({"input_tokens": 100, "output_tokens": 10}, "a", False), "1")
        # No in-memory QwenTurnUsage or Backend instance carried over.
        ensure_session_ledger(session)
        result = self.record(session, QwenTurnUsage().finish({"input_tokens": 220, "output_tokens": 20}, "a", True), "2")
        self.assertEqual(result["inputTokens"], 220)
        self.assertEqual(result["events"][-1]["inputTokens"], 120)

    def test_zero_delta_is_reported_zero_not_text_estimate(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        self.record(session, QwenTurnUsage().finish({"input_tokens": 100, "output_tokens": 10}, "a", False), "1")
        result = self.record(session, QwenTurnUsage().finish({"input_tokens": 100, "output_tokens": 10}, "a", True), "2")
        self.assertEqual(result["inputTokens"], 100)
        self.assertEqual(result["estimatedTurns"], 0)
        self.assertEqual(result["events"][-1]["inputTokens"], 0)

    def test_upgrade_missing_baseline_does_not_charge_all_history(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        result = self.record(session, QwenTurnUsage().finish({"input_tokens": 38000, "output_tokens": 1000}, "old", True), "1")
        self.assertLess(result["inputTokens"], 20)
        self.assertTrue(result["events"][-1]["estimated"])
        self.assertIn("基线", result["events"][-1]["usageWarning"])
        result = self.record(session, QwenTurnUsage().finish({"input_tokens": 38120, "output_tokens": 1010}, "old", True), "2")
        self.assertEqual(result["events"][-1]["inputTokens"], 120)

    def test_new_thread_reset_and_duplicate_event_are_isolated(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        for event_id, native_id, total, resumed in (("1", "a", 100, False), ("2", "b", 50, False), ("3", "a", 120, True), ("3", "a", 120, True)):
            result = self.record(session, QwenTurnUsage().finish({"input_tokens": total}, native_id, resumed), event_id)
        self.assertEqual(result["inputTokens"], 170)
        self.assertEqual(result["turnCount"], 3)

    def test_missing_or_invalid_usage_is_not_reported(self):
        turn = QwenTurnUsage()
        self.assertIsNone(turn.finish({}, "x", False))
        self.assertIsNone(turn.finish({"input_tokens": "bad"}, "x", False))

    def test_capture_preference_survives_normalization(self):
        session = SimpleNamespace(token_usage={}, messages=[])
        ensure_session_ledger(session)["captureEnabled"] = True
        result = self.record(session, {"inputTokens": 1}, "1")
        self.assertTrue(result["captureEnabled"])


if __name__ == "__main__":
    unittest.main()
