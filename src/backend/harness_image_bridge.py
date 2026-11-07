"""Harness 图片手动提交 RPC；复用主聊天注册表和 Session sidecar。"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
import json
import time
from typing import Any

from ..types import BackendType, new_id
from .chat_extras_store import SeqTask
from .deepseek_harness_state import config_fingerprint
from .harness_image_receipts import ImageSubmission, ReceiptError, VERSION, commit_record, payload_digest, valid_id
from .deepseek_harness_images import ImagePolicyError


class HarnessImageBridge:
    def _image_session(self, session_id: str) -> Any:
        self._require_session_access(session_id)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        if session is None:
            raise PermissionError("Session is unavailable for the current user")
        return session

    def _rpc_harnessImageCapabilities(self, session_id: str) -> str:
        self._image_session(session_id)
        # 这只是提交回执协议，不声明模型支持图片、不启动 native 或查询目录。
        return json.dumps({"version": VERSION, "submit": True, "queue": True, "status": True})

    def _image_receipt(self, session_id: str, request_id: str) -> ImageSubmission | None:
        session = self._image_session(session_id)
        record = self._chat_extras_get(session_id).harness_image_submissions.get(valid_id(request_id))
        if record and (record.owner_id != session.owner_id or record.executor_id != "local"):
            raise ReceiptError("request_conflict")
        return record

    def _rpc_harnessImageStatus(self, session_id: str, request_id: str) -> str:
        record = self._image_receipt(session_id, request_id)
        return json.dumps(record.public() if record else {"version": VERSION, "requestId": request_id,
            "sessionId": session_id, "state": "unknown", "reason": "receipt_unknown"}, ensure_ascii=False)

    def _emit_image_receipt(self, record: ImageSubmission) -> None:
        # 沿用已按 Session owner 路由的事件，不新建跨用户广播通道。
        self._emit_session_updated({"type": "harness_image_submission", **record.public()})

    def _image_transition(self, original: ImageSubmission, state: str, *, reason: str = "",
                          generation: str = "") -> ImageSubmission:
        current = self._image_receipt(original.session_id, original.request_id)
        if (not current or current.digest != original.digest or current.queue_revision != original.queue_revision
                or current.assistant_message_id != original.assistant_message_id
                or current.generation and generation and current.generation != generation):
            raise ReceiptError("stale_receipt")
        if current.queue_id:
            queue = next((item for item in self._chat_extras_get(original.session_id).seq_tasks
                          if item.id == current.queue_id), None)
            if not queue or queue.revision != current.queue_revision or queue.image_request_id != current.request_id:
                raise ReceiptError("stale_receipt")
        following = current.advance(state, reason=reason, generation=generation)
        extras = self._chat_extras_get(original.session_id)
        try:
            record, _ = commit_record(extras, following, self._chat_extras_store.save,
                                      expected_revision=current.revision)
        except ReceiptError as exc:
            if exc.code == "storage_failed":
                # 无法持久更新不能留作可重放的原状态；内存也保留 unknown 保护。
                unknown = replace(current, state="unknown", reason="storage_failed", revision=current.revision + 1,
                                  native_received=current.native_received or state == "native_received")
                extras.harness_image_submissions[current.request_id] = unknown
                self._emit_image_receipt(unknown)
            raise
        self._emit_image_receipt(record)
        return record

    def _rpc_harnessImageSubmit(self, session_id: str, payload_json: str) -> str:
        try:
            return self._submit_harness_image(session_id, payload_json)
        except ImagePolicyError as exc:
            return self._image_input_rejected(session_id, payload_json, exc)

    def _image_input_rejected(self, session_id: str, payload_json: str, exc: ImagePolicyError) -> str:
        session = self._image_session(session_id)
        request_id = valid_id(json.loads(payload_json).get("requestId"))
        # 仅入口解码阶段的受控异常可证明没有接单；不把通用 RPC 错误当作前置拒绝。
        return json.dumps({"version": VERSION, "requestId": request_id, "sessionId": session_id,
            "ownerId": session.owner_id, "revision": 1, "state": "rejected", "nativeReceived": False,
            "reason": exc.reason}, ensure_ascii=False)

    def _submit_harness_image(self, session_id: str, payload_json: str) -> str:
        session = self._image_session(session_id)
        self._window_guard(session_id)
        self._require_update_work_allowed()
        try:
            payload = json.loads(payload_json)
        except (ValueError, TypeError):
            raise ReceiptError() from None
        if (not isinstance(payload, dict) or payload.get("sessionId") != session_id
                or type(payload.get("version")) is not int or payload["version"] != VERSION):
            raise ReceiptError()
        request_id = valid_id(payload.get("requestId"))
        self._declare_interaction_client(payload.get('userInteractionVersion'))
        # 重复请求先查原记录；后来的 Backend 切换不能把同一 ID 变成新提交。
        existing = self._image_receipt(session_id, request_id)
        if existing:
            if existing.queue_id or existing.digest != payload_digest(payload):
                raise ReceiptError("request_conflict")
            return json.dumps(existing.public(), ensure_ascii=False)
        backend_id = valid_id(payload.get("backendId"))
        config = next((item for item in self._backend_configs if item.id == backend_id), None)
        if config is None or config.type != BackendType.DEEPSEEK_HARNESS:
            raise ReceiptError()
        from .deepseek_harness_images import parse_images
        if not parse_images(payload.get("images")):
            raise ReceiptError()
        if not isinstance(payload.get("content", ""), str):
            raise ReceiptError()
        # 本轮配置和模型身份在接单时冻结；实际发送前变化则拒绝，不用新路线代发。
        runtime = deepcopy(self._session_runtime(session))
        record = ImageSubmission(request_id=request_id, digest=payload_digest(payload), owner_id=session.owner_id,
            executor_id="local", session_id=session_id, backend_id=backend_id,
            user_message_id=valid_id(payload.get("userMessageId")), assistant_message_id=valid_id(payload.get("messageId")),
            draft_revision=payload.get("draftRevision"), created_at=time.time(), updated_at=time.time(),
            route_fingerprint=config_fingerprint(config, runtime={**runtime, "workingDir": session.working_dir}))
        # 注册门预先检查且提交后再次检查；两者之间没有 await，仍由原注册表掌握启动权。
        self._check_chat_turn_allowed(session_id)
        if any(item.state in {"platform_accepted", "submitting", "native_received", "unknown"}
               for item in self._chat_extras_get(session_id).harness_image_submissions.values()):
            raise ValueError("此 Session 有待决图片提交，请先核对原请求状态，不能重复发送")
        record, created = commit_record(self._chat_extras_get(session_id), record, self._chat_extras_store.save)
        if created:
            try:
                self._start_chat_turn(payload_json, image_submission=(record, runtime))
            except Exception:
                self._image_transition(record, "rejected", reason="preflight_rejected")
                raise
            self._emit_image_receipt(record)
        return json.dumps(record.public(), ensure_ascii=False)

    def _commit_image_queue(self, extras: Any, candidate: Any) -> None:
        try:
            self._chat_extras_store.save(candidate)
        except Exception:
            raise ReceiptError("storage_failed") from None
        # 未编辑的运行中项仍是同一对象；不能让 scheduler 持有失效副本。
        extras.seq_tasks = candidate.seq_tasks
        extras.harness_image_submissions = candidate.harness_image_submissions
        extras.seq_auto, extras.seq_error = candidate.seq_auto, candidate.seq_error
        extras.updated_at = candidate.updated_at

    async def _rpc_harnessImageQueue(self, session_id: str, payload_json: str) -> str:
        try:
            return await self._queue_harness_image(session_id, payload_json)
        except ImagePolicyError as exc:
            return self._image_input_rejected(session_id, payload_json, exc)

    async def _queue_harness_image(self, session_id: str, payload_json: str) -> str:
        session = self._image_session(session_id)
        self._window_guard(session_id)
        self._require_update_work_allowed()
        try:
            payload = json.loads(payload_json)
        except (ValueError, TypeError):
            raise ReceiptError() from None
        if (not isinstance(payload, dict) or payload.get("sessionId") != session_id
                or type(payload.get("version")) is not int or payload["version"] != VERSION):
            raise ReceiptError()
        request_id = valid_id(payload.get("requestId"))
        digest = payload_digest(payload)
        existing = self._image_receipt(session_id, request_id)
        if existing:
            if not existing.queue_id or existing.digest != digest:
                raise ReceiptError("request_conflict")
            return json.dumps(existing.public(), ensure_ascii=False)
        config = next((item for item in self._backend_configs if item.id == session.backend_id), None)
        if (not config or config.type != BackendType.DEEPSEEK_HARNESS or payload.get("backendId") != config.id
                or not isinstance(payload.get("content", ""), str)):
            raise ReceiptError()
        from .deepseek_harness_images import parse_images, validate_images, check_request_budget, content_blocks
        images = parse_images(payload.get("images"))
        if not images:
            raise ReceiptError()
        checked = await validate_images(images)  # 只本地解码；不创建能力预检 worker。
        attachments = self._parse_text_attachments_json(json.dumps(payload.get("textAttachments") or []))
        from .bridge_ws import _append_text_attachments
        check_request_budget({"jsonrpc": "2.0", "id": "queue-preflight", "method": "session/prompt", "params": {
            "sessionId": "awu-" + "0" * 32,
            "contentBlocks": content_blocks(_append_text_attachments(payload.get("content", ""), attachments), checked),
            "awuImageAdmission": {"admissionId": "0" * 36}}})
        # 解码 await 后再次核对身份／写门和去重，不能按旧客户端授权提交。
        self._image_session(session_id)
        self._window_guard(session_id)
        self._require_update_work_allowed()
        existing = self._image_receipt(session_id, request_id)
        if existing:
            if not existing.queue_id or existing.digest != digest:
                raise ReceiptError("request_conflict")
            return json.dumps(existing.public(), ensure_ascii=False)
        queue_id = new_id()
        record = ImageSubmission(request_id=request_id, digest=digest, owner_id=session.owner_id, executor_id="local",
            session_id=session_id, backend_id=config.id, user_message_id=valid_id(payload.get("userMessageId")),
            assistant_message_id=valid_id(payload.get("messageId")), draft_revision=payload.get("draftRevision"),
            queue_id=queue_id, queue_revision=1, state="queued", created_at=time.time(), updated_at=time.time())
        task = SeqTask(queue_id, text=payload.get("content", "").strip(), images=[item.to_dict() for item in images],
                       text_attachments=[item.to_dict() for item in attachments] if attachments else [],
                       image_request_id=request_id)
        extras = self._chat_extras_get(session_id)
        candidate = replace(extras, seq_tasks=[*extras.seq_tasks, task],
                            harness_image_submissions={**extras.harness_image_submissions, request_id: record})
        self._commit_image_queue(extras, candidate)
        self._emit_seqtask_updated(extras)
        self._emit_image_receipt(record)
        scheduler = getattr(self, "_sequence_scheduler", None)
        if scheduler:
            scheduler.kick(session_id)
        return json.dumps(record.public(), ensure_ascii=False)

    def _claim_image_queue(self, extras: Any, task: SeqTask, session: Any) -> tuple[SeqTask, ImageSubmission, dict]:
        record = self._image_receipt(session.id, task.image_request_id)
        if not record or record.queue_id != task.id or record.queue_revision != task.revision or record.state != "queued":
            raise ReceiptError("stale_receipt")
        config = next((item for item in self._backend_configs if item.id == session.backend_id), None)
        if not config or config.type != BackendType.DEEPSEEK_HARNESS:
            self._image_transition(record, "rejected", reason="route_changed")
            raise ValueError("排队图片的 Backend 已变化，未派发；请核对路线和原附件")
        runtime = deepcopy(self._session_runtime(session))
        following = replace(record.advance("platform_accepted"), dispatch_backend_id=config.id,
            route_fingerprint=config_fingerprint(config, runtime={**runtime, "workingDir": session.working_dir}))
        running = replace(task, status="running", error="", updated_at=time.time())
        candidate = replace(extras, seq_tasks=[running if item is task else item for item in extras.seq_tasks],
            harness_image_submissions={**extras.harness_image_submissions, record.request_id: following})
        self._commit_image_queue(extras, candidate)
        self._emit_image_receipt(following)
        return running, following, runtime

    def _revise_image_queue(self, extras: Any, task: SeqTask, *, text: str | None = None,
                            images: list | None = None, attachments: list | None = None) -> tuple[Any, ImageSubmission]:
        """显式编辑／重试生成新修订；原去重记录不改写成新载荷。"""
        original = extras.harness_image_submissions.get(task.image_request_id)
        if not original or original.queue_revision != task.revision:
            raise ReceiptError("stale_receipt")
        if original.state in {"platform_accepted", "submitting", "native_received", "unknown"}:
            raise ValueError("原图片提交结果尚未确认，不能编辑或重试为新请求")
        revised = replace(task, text=task.text if text is None else text,
            images=task.images if images is None else images,
            text_attachments=task.text_attachments if attachments is None else attachments,
            image_request_id=new_id(), revision=task.revision + 1, error="", updated_at=time.time())
        user_id, assistant_id = new_id(), new_id()
        digest = payload_digest({"content": revised.text, "images": revised.images,
            "textAttachments": revised.text_attachments, "userMessageId": user_id, "messageId": assistant_id})
        record = replace(original, request_id=revised.image_request_id, digest=digest,
            user_message_id=user_id, assistant_message_id=assistant_id, queue_revision=revised.revision,
            state="queued", native_received=False, reason="", revision=1,
            created_at=time.time(), updated_at=time.time(), route_fingerprint="", generation="", dispatch_backend_id="")
        records = {**extras.harness_image_submissions, record.request_id: record}
        if original.state == "queued":
            records[original.request_id] = original.advance("rejected", reason="queue_revised")
        candidate = replace(extras, seq_tasks=[revised if item is task else item for item in extras.seq_tasks],
                            harness_image_submissions=records)
        return candidate, record

    def _remove_image_queue(self, extras: Any, removed_ids: set[str]) -> None:
        records = dict(extras.harness_image_submissions)
        cancelled = []
        for task in extras.seq_tasks:
            if task.id in removed_ids and task.image_request_id:
                record = records.get(task.image_request_id)
                if record and record.state == "queued":
                    records[record.request_id] = record.advance("cancelled", reason="cancelled")
                    cancelled.append(records[record.request_id])
        candidate = replace(extras, seq_tasks=[item for item in extras.seq_tasks if item.id not in removed_ids],
                            harness_image_submissions=records)
        self._commit_image_queue(extras, candidate)
        for record in cancelled:
            self._emit_image_receipt(record)

    async def _handle_harness_image_turn(self, payload_json: str, record: ImageSubmission, runtime: dict) -> bool:
        try:
            outcome = await self._handle_send_message(payload_json, image_submission=(record, runtime))
        finally:
            # 无原生证据时不可从用户气泡、done 或 handler 返回值猜测成功。
            current = self._image_receipt(record.session_id, record.request_id)
            if current and current.state == "platform_accepted":
                self._image_transition(record, "rejected", reason="preflight_rejected")
            elif current and current.state in {"submitting", "native_received"}:
                self._image_transition(record, "unknown", reason="receipt_unknown")
        current = self._image_receipt(record.session_id, record.request_id)
        return outcome is True and current is not None and current.state == "succeeded"
