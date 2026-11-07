"""提交记录只操作隔离 sidecar；无 Backend、原生进程或网络。"""
from __future__ import annotations

from dataclasses import replace
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

from src.backend.chat_extras_store import ChatExtras, ChatExtrasStore, SeqTask
from src.backend.harness_image_receipts import (
    ImageSubmission, ReceiptError, commit_record, compact_records, load_records, payload_digest, recover_records,
)


class HarnessImageReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="awu-image-receipts-")
        self.addCleanup(temporary.cleanup)
        root = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": temporary.name})
        root.start()
        self.addCleanup(root.stop)
        self.store = ChatExtrasStore()
        self.extras = ChatExtras(session_id="session-a")
        self.payload = {"content": "fixture input", "images": [{"id": "image", "base64": "fixture-image-bytes"}],
                        "backendId": "harness", "draftRevision": 2, "userMessageId": "user-a", "messageId": "reply-a"}
        self.record = ImageSubmission(request_id="request-a", digest=payload_digest(self.payload),
            owner_id="owner-a", executor_id="local", session_id="session-a", backend_id="harness",
            user_message_id="user-a", assistant_message_id="reply-a", draft_revision=2,
            created_at=1, updated_at=1, route_fingerprint="a" * 64)

    def test_persist_before_side_effect_and_deduplicate_across_reload(self) -> None:
        calls = []
        for reload in (False, False, True):
            if reload:
                self.extras = self.store.load("session-a")
            receipt, created = commit_record(self.extras, self.record, self.store.save)
            if created:
                # 作为未来 RPC 的调用顺序契约：落盘和回读在副作用前完成。
                self.assertEqual(self.store.load("session-a").harness_image_submissions["request-a"], receipt)
                calls.append("submit")
            self.assertEqual(receipt.state, "platform_accepted")
            self.assertFalse(receipt.native_received)
        self.assertEqual(calls, ["submit"])

    def test_failed_replace_never_installs_or_submits_and_preserves_old_queue(self) -> None:
        self.extras.seq_tasks.append(SeqTask("queue-old", text="retained"))
        self.store.save(self.extras)
        original = self.store._path("session-a").read_bytes()
        submit = Mock()
        with patch("src.backend.chat_extras_store.os.replace", side_effect=OSError("private failure")):
            with self.assertRaisesRegex(ReceiptError, "保存失败"):
                _record, created = commit_record(self.extras, self.record, self.store.save)
                if created:
                    submit()
        submit.assert_not_called()
        self.assertEqual(self.extras.harness_image_submissions, {})
        self.assertEqual(self.store._path("session-a").read_bytes(), original)
        self.assertEqual(list(self.store._dir.glob("*.tmp")), [])

    def test_conflicts_never_save_or_run_and_do_not_echo_payload(self) -> None:
        commit_record(self.extras, self.record, self.store.save)
        for changed in (replace(self.record, digest="b" * 64), replace(self.record, owner_id="other"),
                        replace(self.record, executor_id="other"), replace(self.record, draft_revision=3),
                        replace(self.record, user_message_id="other"), replace(self.record, backend_id="other")):
            save = Mock()
            with self.assertRaises(ReceiptError) as caught:
                commit_record(self.extras, changed, save)
            self.assertEqual(caught.exception.code, "request_conflict")
            self.assertNotIn("fixture", str(caught.exception))
            save.assert_not_called()

    def test_record_whitelist_and_digest_exclude_temporary_authority(self) -> None:
        changed = {**self.payload, "kitApprovalDelegation": True, "workspaceToolsVersion": 1,
                   "toolToken": "fixture-secret"}
        self.assertEqual(payload_digest(changed), self.record.digest)
        self.assertNotEqual(payload_digest({**changed, "content": "changed"}), self.record.digest)
        self.assertNotEqual(payload_digest({**changed, "images": []}), self.record.digest)
        parsed = ImageSubmission.from_dict({**self.record.to_dict(), **changed})
        # 输入中的 messageId/draftRevision 与记录相同；其他内容必须被过滤。
        encoded = json.dumps(parsed.to_dict())
        for secret in ("fixture-image-bytes", "fixture-secret", "fixture input", "kitApprovalDelegation"):
            self.assertNotIn(secret, encoded)
        self.assertNotIn("routeFingerprint", parsed.public())
        self.assertNotIn("payloadDigest", parsed.public())

    def test_versions_duplicate_keys_scope_and_invalid_fields_fail_closed(self) -> None:
        for overrides in ({"version": True}, {"version": 2}, {"nativeReceived": 1},
                          {"state": "succeeded"}, {"draftRevision": True}, {"payloadDigest": "secret"},
                          {"reason": "upstream body"}, {"requestId": "../bad"}, {"updatedAt": float("nan")}):
            with self.subTest(overrides=tuple(overrides)):
                with self.assertRaises(ReceiptError):
                    ImageSubmission.from_dict({**self.record.to_dict(), **overrides})
        with self.assertRaises(ReceiptError):
            load_records([self.record.to_dict()] * 2, "session-a")
        with self.assertRaises(ReceiptError):
            load_records([self.record.to_dict()], "session-b")
        self.assertEqual(ChatExtras.from_dict({"sessionId": "old"}).harness_image_submissions, {})

    def test_cas_transition_preserves_association_and_rejects_late_state(self) -> None:
        current, _ = commit_record(self.extras, self.record, self.store.save)
        for state in ("submitting", "native_received", "failed"):
            following = current.advance(state, reason="runtime_failed" if state == "failed" else "")
            committed, created = commit_record(self.extras, following, self.store.save,
                                               expected_revision=current.revision)
            self.assertFalse(created)
            with self.assertRaises(ReceiptError):
                commit_record(self.extras, following, self.store.save, expected_revision=current.revision)
            current = committed
        duplicate, created = commit_record(self.extras, self.record, self.store.save)
        self.assertFalse(created)
        self.assertEqual(duplicate.state, "failed")
        self.assertTrue(duplicate.native_received)
        with self.assertRaises(ReceiptError):
            duplicate.advance("rejected")

    def test_compaction_keeps_all_dedup_links_and_every_active_unknown_record(self) -> None:
        rows = {}
        for number in range(80):
            record = replace(self.record, request_id=f"request-{number}", updated_at=number)
            rows[record.request_id] = record.advance("rejected", reason="preflight_rejected")
        rows["active"] = replace(self.record, request_id="active")
        rows["unknown"] = replace(self.record, request_id="unknown").advance("unknown", reason="receipt_unknown")
        compacted = compact_records(rows, recent=2)
        self.assertEqual(set(compacted), set(rows))
        self.assertEqual([item.public() for item in rows.values()], [item.public() for item in compacted.values()])
        self.assertEqual(compacted["active"], rows["active"])
        self.assertEqual(compacted["unknown"], rows["unknown"])
        self.assertEqual(sum(bool(item.route_fingerprint) for item in compacted.values()), 4)
        self.extras.harness_image_submissions = compacted
        self.store.save(self.extras)
        loaded = self.store.load("session-a")
        receipt, created = commit_record(loaded, replace(self.record, request_id="request-0"), self.store.save)
        self.assertFalse(created)
        self.assertEqual(receipt.state, "rejected")

    def test_corrupt_sidecar_is_not_treated_as_missing(self) -> None:
        self.assertIsNone(self.store.load("missing"))
        with patch("pathlib.Path.read_text", return_value="{invalid fixture"):
            with patch("pathlib.Path.exists", return_value=True):
                with self.assertRaisesRegex(ReceiptError, "保留原状态"):
                    self.store.load("session-a")

    def test_restart_recovers_inflight_unknown_without_changing_queued_or_terminal(self) -> None:
        rows = {"platform": self.record, "submitting": self.record.advance("submitting"),
                "native": self.record.advance("submitting").advance("native_received"),
                "queued": replace(self.record, state="queued"),
                "rejected": self.record.advance("rejected")}
        recovered = recover_records(rows)
        for key in ("platform", "submitting", "native"):
            self.assertEqual(recovered[key].state, "unknown")
            self.assertEqual(recovered[key].reason, "restarted")
        self.assertTrue(recovered["native"].native_received)
        self.assertEqual(recovered["queued"], rows["queued"])
        self.assertEqual(recovered["rejected"], rows["rejected"])


if __name__ == "__main__":
    unittest.main()
