"""实际 Bridge RPC／注册门／sidecar；异步原生边界在另一 suite 以真实 runtime 验证。"""
from __future__ import annotations

import asyncio
import base64
from contextlib import redirect_stderr
from dataclasses import replace
import io
import json
import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatExtrasStore, SeqTask
from src.backend.harness_image_receipts import ReceiptError
from src.backend.base import StreamDelta
from src.backend.deepseek_harness import DeepSeekHarnessBackend
from src.backend.session_store import SessionStore
from src.backend.sequence_scheduler import SequenceScheduler
from src.types import BackendType, ModelBackendConfig, Session
from tests.fixtures.harness_images import image_bytes


class HarnessImageSubmitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="awu-submit-receipt-")
        self.addCleanup(temporary.cleanup)
        root = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": temporary.name})
        root.start()
        self.addCleanup(root.stop)
        self.session = Session(id="s", title="fixture", created_at=1, updated_at=1, messages=[],
                               working_dir=temporary.name, backend_id="harness")
        self.bridge = bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {"s": self.session}
        bridge._backend_configs = [ModelBackendConfig(id="harness", label="fixture", type=BackendType.DEEPSEEK_HARNESS)]
        bridge._session_store = SimpleNamespace(load=lambda sid: bridge._active_sessions.get(sid))
        bridge._chat_extras = {}
        bridge._chat_extras_store = ChatExtrasStore()
        bridge._chat_turn_tasks = {}
        bridge._session_runtime = Mock(return_value={})
        bridge._window_guard = Mock()
        bridge._require_update_work_allowed = Mock()
        bridge._emit_session_updated = Mock()
        bridge._emit_seqtask_updated = Mock()
        bridge._require_agent_execution_enabled = Mock()
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        async def handle(_raw, *, image_submission):
            record, _runtime = image_submission
            persisted = bridge._chat_extras_store.load("s").harness_image_submissions[record.request_id]
            self.assertEqual(persisted.state, "platform_accepted")
            self.started.set()
            await self.release.wait()
            return True  # true/done 不是 native receipt；wrapper 必须保持真实边界。
        bridge._handle_send_message = AsyncMock(side_effect=handle)
        self.payload = {"version": 1, "sessionId": "s", "requestId": "request-a", "draftRevision": 1,
                        "backendId": "harness", "content": "fixture", "userMessageId": "user-a", "messageId": "reply-a",
                        "images": [{"id": "image-a", "base64": base64.b64encode(image_bytes()).decode(), "mime_type": "image/png"}]}

    async def asyncTearDown(self) -> None:
        self.release.set()
        scheduler = getattr(self.bridge, "_sequence_scheduler", None)
        if isinstance(scheduler, SequenceScheduler):
            await scheduler.stop()
        tasks = [task for group in self.bridge._chat_turn_tasks.values() for task in group]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def submit(self, **changes):
        return json.loads(self.bridge._rpc_harnessImageSubmit("s", json.dumps({**self.payload, **changes})))

    def status(self, request="request-a"):
        return json.loads(self.bridge._rpc_harnessImageStatus("s", request))

    async def queue(self, **changes):
        return json.loads(await self.bridge._rpc_harnessImageQueue("s", json.dumps({**self.payload, **changes})))

    async def test_invalid_input_has_controlled_pre_acceptance_rejection_without_worker_or_queue(self) -> None:
        invalid = [{**self.payload["images"][0], "base64": "broken base64"}]
        reply = await self.queue(images=invalid)
        self.assertEqual(reply["state"], "rejected")
        self.assertEqual(reply["reason"], "invalid_base64")
        self.assertFalse(reply["nativeReceived"])
        self.assertEqual(self.bridge._chat_extras_get("s").seq_tasks, [])
        self.assertFalse(self.bridge._chat_turn_tasks)
        self.bridge._handle_send_message.assert_not_called()
        reply = self.submit(images=[{**invalid[0], "mime_type": "image/gif"}])
        self.assertEqual(reply["state"], "rejected")
        self.assertEqual(reply["reason"], "unsupported_format")
        self.assertFalse(self.bridge._chat_turn_tasks)

    async def test_queue_commit_is_atomic_deduplicated_and_contains_no_temporary_grants(self) -> None:
        scheduler = self.bridge._sequence_scheduler = Mock()
        with patch.object(self.bridge._chat_extras_store, "save", side_effect=OSError("fixture")):
            with self.assertRaises(ReceiptError):
                await self.queue(kitApprovalDelegation=True, toolToken="fixture-token")
        scheduler.kick.assert_not_called()
        self.assertEqual(self.bridge._chat_extras_get("s").seq_tasks, [])
        self.bridge._emit_seqtask_updated.assert_not_called()
        receipt = await self.queue(kitApprovalDelegation=True, toolToken="fixture-token")
        self.assertEqual(receipt["state"], "queued")
        self.assertFalse(receipt["nativeReceived"])
        self.assertEqual(await self.queue(), receipt)
        self.assertEqual(len(self.bridge._chat_extras_get("s").seq_tasks), 1)
        saved = self.bridge._chat_extras_store.load("s")
        self.assertEqual(saved.seq_tasks[0].image_request_id, "request-a")
        self.assertEqual(saved.seq_tasks[0].id, receipt["queueId"])
        self.assertEqual(saved.harness_image_submissions["request-a"].queue_id, receipt["queueId"])
        text = self.bridge._chat_extras_store._path("s").read_text(encoding="utf-8")
        self.assertNotIn("kitApprovalDelegation", text)
        self.assertNotIn("fixture-token", text)
        self.bridge._handle_send_message.assert_not_called()

    async def test_queue_claim_uses_current_route_and_edit_rejects_late_old_receipt(self) -> None:
        receipt = await self.queue()
        extras = self.bridge._chat_extras_get("s")
        old = extras.harness_image_submissions["request-a"]
        self.bridge._rpc_seqtaskEdit("s", receipt["queueId"], "edited", json.dumps(self.payload["images"]))
        revised = extras.seq_tasks[0]
        self.assertEqual(revised.revision, 2)
        self.assertNotEqual(revised.image_request_id, "request-a")
        with self.assertRaises(ReceiptError):
            self.bridge._image_transition(old, "platform_accepted")
        self.bridge._backend_configs[0].model = "new-route"
        self.bridge._session_runtime.return_value = {"model": "new-model"}
        running, record, runtime = self.bridge._claim_image_queue(extras, revised, self.session)
        self.assertEqual(running.status, "running")
        self.assertEqual(runtime, {"model": "new-model"})
        self.assertEqual(record.state, "platform_accepted")
        self.assertEqual(record.queue_revision, 2)
        self.assertEqual(self.bridge._chat_extras_store.load("s").seq_tasks[0].text, "edited")
        self.bridge._handle_send_message.assert_not_called()

    async def test_queue_rejection_pauses_preserves_images_and_explicit_retry_has_new_revision(self) -> None:
        await self.queue()
        async def rejected(_raw, *, image_submission):
            record, _runtime = image_submission
            self.bridge._image_transition(record, "rejected", reason="preflight_rejected")
            return False
        self.bridge._handle_send_message = AsyncMock(side_effect=rejected)
        scheduler = self.bridge._sequence_scheduler = SequenceScheduler(self.bridge)
        await scheduler.start()
        await asyncio.gather(*list(scheduler.workers.values()))
        extras = self.bridge._chat_extras_get("s")
        task = extras.seq_tasks[0]
        self.assertEqual(task.status, "error")
        self.assertFalse(extras.seq_auto)
        self.assertEqual(task.images[0]["base64"], self.payload["images"][0]["base64"])
        old_id = task.image_request_id
        with patch.object(scheduler, "kick"):
            self.bridge._rpc_seqtaskSetAuto("s", True)
        retried = extras.seq_tasks[0]
        self.assertEqual(retried.status, "pending")
        self.assertEqual(retried.revision, 2)
        self.assertNotEqual(retried.image_request_id, old_id)
        self.assertEqual(self.status(old_id)["state"], "rejected")
        self.assertEqual(self.status(retried.image_request_id)["state"], "queued")

    async def test_unknown_queue_receipt_blocks_next_task_and_cannot_be_retried(self) -> None:
        await self.queue()
        await self.queue(requestId="request-b", userMessageId="user-b", messageId="reply-b")
        async def unknown(_raw, *, image_submission):
            record, _runtime = image_submission
            self.bridge._image_transition(record, "submitting", generation="generation-a")
            self.bridge._image_transition(record, "unknown", reason="receipt_unknown", generation="generation-a")
            return False
        self.bridge._handle_send_message = AsyncMock(side_effect=unknown)
        scheduler = self.bridge._sequence_scheduler = SequenceScheduler(self.bridge)
        await scheduler.start()
        await asyncio.gather(*list(scheduler.workers.values()))
        extras = self.bridge._chat_extras_get("s")
        self.assertEqual([task.status for task in extras.seq_tasks], ["error", "pending"])
        self.assertEqual(self.status()["state"], "unknown")
        with self.assertRaisesRegex(ValueError, "尚未确认"):
            self.bridge._rpc_seqtaskSetAuto("s", True)
        self.bridge._handle_send_message.assert_awaited_once()
        self.assertFalse(extras.seq_auto)

    async def test_queue_corrupt_image_at_dispatch_is_retained_and_not_silently_sent(self) -> None:
        await self.queue()
        extras = self.bridge._chat_extras_get("s")
        extras.seq_tasks[0].images[0]["base64"] = "!"
        del self.bridge._handle_send_message
        self.bridge._async_send = AsyncMock()
        self.bridge._emit_delta = Mock()
        scheduler = self.bridge._sequence_scheduler = SequenceScheduler(self.bridge)
        with redirect_stderr(io.StringIO()):
            await scheduler.start()
            await asyncio.gather(*list(scheduler.workers.values()))
        self.assertEqual(extras.seq_tasks[0].status, "error")
        self.assertEqual(extras.seq_tasks[0].images[0]["base64"], "!")
        self.assertEqual(self.status()["state"], "rejected")
        self.assertFalse(extras.seq_auto)
        self.bridge._async_send.assert_not_called()

    async def test_changed_backend_kind_pauses_without_using_another_channel(self) -> None:
        await self.queue()
        self.bridge._backend_configs[0].type = BackendType.OPENAI_COMPATIBLE
        scheduler = self.bridge._sequence_scheduler = SequenceScheduler(self.bridge)
        await scheduler.start()
        await asyncio.gather(*list(scheduler.workers.values()))
        self.assertEqual(self.status()["reason"], "route_changed")
        self.assertEqual(self.bridge._chat_extras_get("s").seq_tasks[0].status, "error")
        self.bridge._handle_send_message.assert_not_called()

    async def test_queue_clear_cancels_only_unsent_receipts_and_preserves_running_object(self) -> None:
        extras = self.bridge._chat_extras_get("s")
        active = SeqTask("active-legacy", status="running")
        extras.seq_tasks.append(active)
        await self.queue()
        self.assertIs(extras.seq_tasks[0], active)
        self.bridge._rpc_seqtaskClear("s")
        self.assertEqual(extras.seq_tasks, [active])
        self.assertIs(extras.seq_tasks[0], active)
        self.assertEqual(self.status()["state"], "cancelled")
        self.assertEqual(len(extras.harness_image_submissions), 1)
        self.assertEqual((await self.queue())["state"], "cancelled")
        self.assertEqual(extras.seq_tasks, [active])

    async def test_quick_platform_receipt_deduplicates_and_status_does_not_start_work(self) -> None:
        receipt = self.submit()
        self.assertEqual(receipt["state"], "platform_accepted")
        self.assertFalse(self.started.is_set())
        await self.started.wait()
        for _ in range(4):
            self.assertEqual(self.submit(), receipt)
            self.assertEqual(self.status(), receipt)
        self.bridge._handle_send_message.assert_awaited_once()
        self.release.set()
        await asyncio.gather(*self.bridge._active_chat_turn_tasks("s"))
        self.assertEqual(self.status()["state"], "rejected")
        self.assertFalse(self.status()["nativeReceived"])

    async def test_storage_failure_never_registers_or_calls_handler(self) -> None:
        with patch.object(self.bridge._chat_extras_store, "save", side_effect=OSError("fixture")):
            with self.assertRaises(ReceiptError):
                self.submit()
        self.bridge._handle_send_message.assert_not_called()
        self.assertFalse(self.bridge._active_chat_turn_tasks("s"))

    async def test_changed_payload_conflicts_while_window_update_and_owner_gates_remain(self) -> None:
        self.submit()
        with self.assertRaises(ReceiptError):
            self.submit(content="different")
        self.session.owner_id = "other-owner"
        with self.assertRaises(PermissionError):
            self.status()
        self.session.owner_id = "local"
        self.bridge._window_guard.side_effect = ValueError("window denied")
        with self.assertRaisesRegex(ValueError, "window denied"):
            self.submit()
        self.bridge._window_guard.side_effect = None
        self.bridge._require_update_work_allowed.side_effect = ValueError("update denied")
        with self.assertRaisesRegex(ValueError, "update denied"):
            self.submit()
        # 只读状态不需要写锁或模型；仍经过 owner 门。
        self.assertEqual(self.status()["state"], "platform_accepted")

    async def test_missing_status_is_unknown_and_capability_read_has_no_side_effect(self) -> None:
        self.assertEqual(self.status()["state"], "unknown")
        self.assertEqual(json.loads(self.bridge._rpc_harnessImageCapabilities("s"))["version"], 1)
        self.bridge._handle_send_message.assert_not_called()
        self.assertFalse(self.bridge._chat_extras_store._path("s").exists())

    async def test_receipt_event_cas_and_storage_failure_leave_unknown_not_retryable(self) -> None:
        self.submit()
        await self.started.wait()
        record = self.bridge._image_receipt("s", "request-a")
        self.bridge._image_transition(record, "submitting", generation="generation-a")
        with self.assertRaises(ReceiptError):
            self.bridge._image_transition(record, "native_received", generation="generation-b")
        with patch.object(self.bridge._chat_extras_store, "save", side_effect=OSError("fixture")):
            with self.assertRaises(ReceiptError):
                self.bridge._image_transition(record, "native_received", generation="generation-a")
        self.assertEqual(self.status()["state"], "unknown")
        self.assertTrue(self.status()["nativeReceived"])
        self.assertTrue(self.bridge._has_native_session_activity("s"))
        self.assertEqual(self.submit()["state"], "unknown")

    async def test_restart_inflight_keeps_association_and_never_replays_or_unlocks(self) -> None:
        self.submit()
        await self.started.wait()
        record = self.bridge._image_receipt("s", "request-a")
        self.bridge._image_transition(record, "submitting", generation="generation-a")
        self.bridge._image_transition(record, "native_received", generation="generation-a")
        self.bridge._chat_extras.clear()  # 新服务进程不拥有旧调用的缓存。
        result = self.status()
        self.assertEqual(result["state"], "unknown")
        self.assertTrue(result["nativeReceived"])
        self.assertEqual(result["userMessageId"], "user-a")
        self.assertEqual(self.submit(), result)
        self.assertTrue(self.bridge._has_native_session_activity("s"))
        self.bridge._handle_send_message.assert_awaited_once()

    async def test_full_chat_plumbing_preserves_attachments_partial_output_and_receipt(self) -> None:
        bridge = self.bridge
        del bridge._handle_send_message  # 运行真实主聊天处理器及 _async_send，不跳过公共边界。
        bridge._build_session_reference_context = lambda content, _sid: content
        bridge._build_prov_reference_context = AsyncMock(side_effect=lambda content, _session, images, _display: (content, images))
        bridge._prepare_session_skills = AsyncMock()
        bridge._compose_constraints = Mock(return_value="")
        bridge._session_kit_prompt_enabled = Mock(return_value=False)
        bridge._collect_backend_skills = Mock(return_value=([], {}))
        bridge._clear_skip_permission = Mock()
        bridge._record_session_usage = Mock()
        bridge._emit_delta = Mock()
        session_file = bridge._chat_extras_store._dir / "fixture-session.json"
        def save(session, **_options):
            SessionStore._atomic_write_text(session_file, json.dumps(session.to_dict()))
        bridge._session_store.save = save
        bridge._session_store.update_meta = Mock()
        test = self
        class FakeNative(DeepSeekHarnessBackend):
            async def send_message(self, **kwargs):
                saved = json.loads(session_file.read_text(encoding="utf-8"))
                test.assertEqual(saved["messages"][0]["images"][0]["base64"], test.payload["images"][0]["base64"])
                test.assertEqual(saved["messages"][0]["imageRequestId"], "request-a")
                test.assertEqual(kwargs["owner_id"], "local")
                test.assertEqual(kwargs["images"][0].id, "image-a")
                test.assertEqual(test.status()["state"], "platform_accepted")
                kwargs["on_submission"]("submitting", generation="generation-a")
                kwargs["on_submission"]("native_received", generation="generation-a")
                kwargs["on_delta"](StreamDelta("s", "reply-a", "text_delta", text="partial fixture"))
                kwargs["on_submission"]("failed", reason="runtime_failed", generation="generation-a")
                return {"agentSessionId": "fixture-native", "success": False, "stopReason": "error"}
        backend = FakeNative(bridge._backend_configs[0])
        bridge._get_backend = lambda _id: backend
        with redirect_stderr(io.StringIO()):
            self.submit()
            results = await asyncio.gather(*bridge._active_chat_turn_tasks("s"))
        self.assertEqual(results, [False])
        self.assertEqual(self.status()["state"], "failed")
        self.assertTrue(self.status()["nativeReceived"])
        saved = json.loads(session_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["agentSessionId"], "fixture-native")
        self.assertEqual(saved["messages"][1]["content"], "partial fixture")
        self.assertEqual(saved["messages"][0]["images"][0]["id"], "image-a")


if __name__ == "__main__":
    unittest.main()
