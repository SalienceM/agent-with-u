"""协议投影纯单测：不导入 SDK，不访问磁盘或模型。"""
from __future__ import annotations

import unittest

from src.backend.deepseek_harness_events import HarnessProjection


class HarnessEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.deltas = []
        self.project = HarnessProjection("root", "generation", "fingerprint", lambda kind, **data: self.deltas.append((kind, data)))
        self.seq = 0

    def live(self, kind, *, sid="root", attempt="attempt", revision=1, **data):
        self.project.observe({"method": "awu/assistantStream", "payload": {
            "sessionId": sid, "generation": "generation", "configFingerprint": "fingerprint",
            "frame": {"type": kind, "attemptId": attempt, "revision": revision, **data}}})

    def event(self, kind, data, sid="root", seq=None):
        self.seq += 1
        self.project.observe({"method": "session.event", "payload": {"sessionId": sid,
            "event": {"seq": self.seq if seq is None else seq, "type": kind, "data": data}}})

    def test_revisions_are_per_publication_and_commit_does_not_repeat_text_thinking_or_usage(self) -> None:
        self.live("start")
        for index, chunk in enumerate(({"type": "text-delta", "text": "hello"}, {"type": "reasoning-delta", "text": "reason"})):
            self.live("chunk", revision=index + 2, index=index, chunk=chunk)
        # 相同帧重发不会重复正文。
        self.live("chunk", revision=2, index=0, chunk={"type": "text-delta", "text": "hello"})
        data = {"message": {"id": "output", "content": [{"type": "text", "text": "hello!"}, {"type": "reasoning", "text": "reason"}]},
                "usage": {"inputTokens": 4, "outputTokens": 3, "cacheReadTokens": 2, "reasoningTokens": 1}}
        self.event("assistant/message", data, seq=20)
        self.event("assistant/message", data, seq=20)
        self.live("end", revision=4, index=2)
        self.assertEqual("".join(data["text"] for kind, data in self.deltas if kind == "text_delta"), "hello!")
        self.assertEqual("".join(data["text"] for kind, data in self.deltas if kind == "thinking"), "reason")
        usage = self.project.usage()
        self.assertEqual(usage["inputTokens"], 6)
        self.assertEqual(usage["outputTokens"], 3)
        self.assertEqual(usage["usageEventCount"], 1)
        self.assertTrue(usage["reported"])

    def test_tool_fragments_and_committed_call_share_real_identity_and_result_error(self) -> None:
        self.live("start")
        self.live("chunk", revision=2, index=0, chunk={"type": "tool-call-delta", "id": "call", "name": "write", "argumentsDelta": '{"file":'})
        self.live("chunk", revision=3, index=1, chunk={"type": "tool-call-delta", "id": "call", "argumentsDelta": '"x"}'})
        self.event("tool/call", {"callId": "call", "name": "write", "arguments": '{"file":"x"}'})
        self.event("tool/result", {"message": {"toolCallId": "call", "isError": True, "content": [{"type": "text", "text": "denied"}]}})
        self.assertEqual([kind for kind, _ in self.deltas], ["tool_start", "tool_input", "tool_result"])
        self.assertEqual(self.deltas[-1][1]["tool_call"]["status"], "error")
        self.assertEqual(self.deltas[-1][1]["tool_call"]["id"], "call")

    def test_child_text_never_enters_root_reply_and_real_parent_tool_link_is_preserved(self) -> None:
        self.event("tool/call", {"callId": "delegate", "name": "spawn_agent", "arguments": "{}"})
        self.project.observe({"method": "subagent.started", "payload": {"parentSessionId": "root", "childSessionId": "child"}})
        self.project.observe({"method": "awu/subagentLink", "payload": {"sessionId": "child", "parentSessionId": "root",
            "callId": "delegate", "generation": "generation", "configFingerprint": "fingerprint"}})
        self.live("start", sid="child")
        self.live("chunk", sid="child", revision=2, index=0, chunk={"type": "text-delta", "text": "private child reply"})
        self.event("assistant/message", {"message": {"content": [{"type": "text", "text": "private child reply"}]}}, sid="child")
        self.event("tool/call", {"callId": "read", "name": "read", "arguments": "{}"}, sid="child")
        self.assertNotIn("text_delta", [kind for kind, _ in self.deltas])
        self.assertEqual(self.deltas[-1][1]["tool_call"]["parentToolUseId"], "delegate")
        self.assertEqual(self.deltas[-1][1]["tool_call"]["id"], "child:read")

    def test_retry_attempt_late_frames_cannot_corrupt_new_attempt(self) -> None:
        self.live("start", attempt="first")
        self.live("chunk", attempt="first", revision=2, index=0, chunk={"type": "text-delta", "text": "partial"})
        self.live("start", attempt="second", revision=3)
        self.live("chunk", attempt="first", revision=4, index=1, chunk={"type": "text-delta", "text": "LATE"})
        self.live("chunk", attempt="second", revision=5, index=0, chunk={"type": "text-delta", "text": "new"})
        self.event("assistant/message", {"message": {"content": [{"type": "text", "text": "new"}]}})
        self.assertEqual("".join(data["text"] for kind, data in self.deltas if kind == "text_delta"), "partialnew")
        self.assertIsNone(self.project.usage())

    def test_missing_identity_gaps_and_inconsistent_tool_parameters_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            self.live("chunk", revision=2, index=0, chunk={"type": "text-delta", "text": "missing start"})
        self.live("start")
        with self.assertRaisesRegex(ValueError, "缺帧"):
            self.live("chunk", revision=2, index=5, chunk={"type": "text-delta", "text": "gap"})
        with self.assertRaises(ValueError):
            self.event("tool/result", {"message": {"callId": "not-the-real-field"}})

    def test_incomplete_usage_is_unavailable_and_bad_subcounts_are_not_exact(self) -> None:
        self.event("assistant/message", {"message": {"content": []}, "usage": {"inputTokens": 0, "outputTokens": 0}})
        self.assertTrue(self.project.usage()["reported"])
        self.event("assistant/attempt", {"stream": []})
        self.assertIsNone(self.project.usage())
        for raw in ({"inputTokens": True, "outputTokens": 0},
                    {"inputTokens": 2, "outputTokens": 1, "reasoningTokens": 3},
                    {"inputTokens": 2, "outputTokens": 1, "totalTokens": 500}):
            with self.assertRaises(ValueError):
                self.event("assistant/message", {"message": {"content": []}, "usage": raw})


if __name__ == "__main__":
    unittest.main()
