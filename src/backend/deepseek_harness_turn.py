"""Harness 单轮协调；请求接收、原生完成和进程退出是三个独立边界。"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
from copy import deepcopy
import queue
import threading
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from .base import PermissionRequest, StreamDelta
from .deepseek_harness_config import COMMIT, PROTOCOL_VERSION, REASONING_EFFORTS, RUNTIME_VERSION, validate_config_fields
from .deepseek_harness_sdk import bridge_path, create_client, create_harness_config, default_model
from .deepseek_harness_state import HarnessLayout, atomic_json, config_fingerprint, make_profile_patch
from .deepseek_harness_worker import HarnessWorker
from .deepseek_harness_images import (ImagePolicyError, admission_request, admitted_image_token,
    check_request_budget, content_blocks, image_admission_error, is_image_prompt_rejection, validate_images)
from .call_trace import trace_request, trace_response
from .harness_image_errors import harness_error_details, harness_error_text, harness_event_metadata, terminal_error


async def send_turn(backend: Any, *, messages: list, content: str, images: list | None,
                    session_id: str, message_id: str, on_delta: Any, agent_session_id: str | None,
                    working_dir: str | None, skip_permissions: bool | None, on_permission_request: Any,
                    constraints: str | None, sandbox_enabled: bool, model_override: str | None = None,
                    reasoning_effort: str | None = None, execution_access: str | None = None,
                    owner_id: str = "local", executor_id: str = "local", text_only: bool = False,
                    isolated_context: bool = False, activity_parent: str | None = None,
                    on_submission: Any = None,
                    **unknown: Any) -> dict:
    def emit(kind: str, **data: Any) -> None:
        on_delta(StreamDelta(session_id, message_id, kind, **data))

    # 校验和原生启动共用本轮冻结配置；后续 UI 编辑不能放宽正在运行的权限。
    config = deepcopy(backend.config)
    if not text_only:
        constraints = (constraints or '') + ('\n当前 Harness 契约没有独立用户问答通道；需要用户信息时，'
            '请用最终回复提出问题并结束本轮，等待下一轮文字回复，不要用 shell 等待输入。')
    native = agent_session_id
    native_submitted = bool(agent_session_id)
    prompt_attempted = False
    receipt_received = False
    receipt_observed = False
    observer_failed = False
    generation = ""
    failure_stage = "preflight"

    def submission(state: str, reason: str = "") -> None:
        nonlocal observer_failed, receipt_observed
        if on_submission and not observer_failed:
            try:
                on_submission(state, reason=reason, generation=generation)
                if state == "native_received":
                    receipt_observed = True
            except Exception:
                observer_failed = True
                raise
    worker: HarnessWorker | None = None
    approvals: set[asyncio.Task] = set()
    seen_approvals: set[str] = set()
    try:
        if unknown:
            raise ValueError("Harness 不支持请求中的额外运行选项")
        validate_config_fields(config.to_dict())
        checked_images = await validate_images(images)
        if checked_images:
            if text_only:
                raise ImagePolicyError("text_only")
            check_request_budget({"jsonrpc": "2.0", "id": "turn-preflight", "method": "session/prompt", "params": {
                "sessionId": native or "awu-" + "0" * 32, "contentBlocks": content_blocks(content, checked_images),
                "awuImageAdmission": {"admissionId": "0" * 36}}})
        if reasoning_effort and reasoning_effort not in REASONING_EFFORTS:
            raise ValueError("此 Harness 版本不支持该推理强度")
        if text_only:
            if agent_session_id or activity_parent:
                raise ValueError("Harness 纯文本调用不能恢复主会话或继承活动身份")
            isolated_context = True
        failure_stage = "workspace"
        cwd = str(Path(working_dir or config.working_dir or Path.cwd()).resolve(strict=True)) if not text_only else ""
        if not text_only and not Path(cwd).is_dir():
            raise ValueError("Harness 工作目录不是目录")
        failure_stage = "preparation"
        from .deepseek_harness_mcp import normalize_servers
        servers = [] if text_only else normalize_servers(config.mcp_servers, cwd=cwd)
        mode = "read-only" if text_only else execution_access or config.harness_permission_mode or "workspace-write"
        if sandbox_enabled:
            raise ValueError("Harness 尚无已验证的 AWU OS 沙箱覆盖，不能忽略沙箱请求")
        if isolated_context:
            native = agent_session_id or "awu-" + uuid.uuid4().hex
        layout = HarnessLayout.for_session(owner=owner_id, executor=executor_id,
            backend=config.id, session=session_id, context=native if isolated_context else None)
        if text_only:
            cwd = str(layout.root / "work")
        skill_layout = HarnessLayout.for_session(owner=owner_id, executor=executor_id,
            backend=config.id, session=session_id)
        generation = uuid.uuid4().hex
        fingerprint = config_fingerprint(config, runtime={"model": model_override,
            "reasoningEffort": reasoning_effort, "mode": mode}, constraints=constraints or "")
        worker = HarnessWorker(layout, generation, activity_parent=activity_parent, ephemeral=text_only)
        # 跨 Backend 配置对象重建仍有模块级/OS 双重保护。
        running = getattr(backend, "_harness_workers", None)
        if running is None:
            running = backend._harness_workers = {}
        if session_id in running:
            raise RuntimeError("Harness Session 已有运行")
        running[session_id] = worker
        projection: Any = None
        emit("diagnostic", diagnostic={"phase": "runner_start"})
        trace_request("harness-sdk", {"method": "session/prompt", "promptChars": len(content),
            "constraintChars": len(constraints or ""), "model": model_override or config.model,
            "reasoningEffort": reasoning_effort, "access": mode},
            "SDK 提交元数据；不包含环境、动态凭据或供应商原始 HTTP 请求。")

        def work(owned: HarnessWorker, publish: Any) -> dict:
            nonlocal native, native_submitted, prompt_attempted, receipt_received, failure_stage
            if text_only:
                Path(cwd).mkdir(mode=0o700)
            from pydantic import BaseModel, ConfigDict
            class Empty(BaseModel):
                pass
            class Capabilities(BaseModel):
                protocolVersion: int
                runtimeVersion: str
                sourceCommit: str
                sessionId: str
                generation: str
                configFingerprint: str
                realtime: bool
                approvals: bool
                questions: bool = False
                questionProtocol: str = 'none'
                imageAdmission: dict[str, Any] | None = None

            class ImageReply(BaseModel):
                model_config = ConfigDict(extra="allow")

            failure_stage = "history"
            meta = layout.read_metadata(cwd=cwd, native_id=agent_session_id)
            if isolated_context and not agent_session_id:
                meta["nativeId"] = native
            native = meta["nativeId"]
            native_submitted = bool(meta.get("submitted") or agent_session_id)
            identity = {"sessionId": native, "generation": generation, "configFingerprint": fingerprint}
            needs_images = bool(checked_images or meta.get("imageInputs"))
            failure_stage = "dependencies"
            selected_bridge = bridge_path(require_images=needs_images)
            if needs_images:
                from .deepseek_harness_distribution import verify_adapter
                resources = verify_adapter()
                if resources["deepseek-harness/bridge/lib/index.mjs"].resolve() != selected_bridge:
                    raise ImagePolicyError("extension_mismatch")
            patch = owned.owner.receipt.parent / "awu.patch.yml"
            skip = True if text_only else config.skip_permissions if skip_permissions is None else skip_permissions
            from .deepseek_harness_skills import run_skill_view
            skills, skill_names = ([], []) if text_only else run_skill_view(skill_layout, patch.parent)
            provider = config.harness_provider or "deepseek-official"
            model = model_override or config.model or default_model()
            rows = make_profile_patch(native_id=native, generation=generation, fingerprint=fingerprint,
                bridge=selected_bridge, cwd=cwd, mode=mode, skip_permissions=skip,
                skill_dirs=skills, skill_names=skill_names, image_identity={"ownerId": owner_id,
                    "executorId": executor_id, "awuSessionId": session_id, "backendId": config.id,
                    "provider": provider, "model": model})
            atomic_json(patch, rows)
            env = dict(config.env or {})
            if config.api_key is not None:
                env["DEEPSEEK_API_KEY"] = config.api_key
            if config.base_url is not None:
                env["DEEPSEEK_BASE_URL"] = config.base_url
            client = create_client(config=create_harness_config(dsh_bin=config.cli_path, profile="sdk",
                dsh_home=str(layout.home), cwd=cwd, patches=(str(patch),), env=env,
                initialize_timeout_seconds=20, request_timeout_seconds=10), owner=owned.owner)
            owned.client = client
            failure_stage = "startup"
            client.start()
            owned.reservation.mark_active(generation, owned.owner.process.pid)
            if owned.stop_requested.is_set():
                raise RuntimeError("Harness 已取消")
            failure_stage = "initialize"
            client.initialize(cwd=cwd, provider=provider, model=model,
                reasoning_effort=reasoning_effort, max_tokens=config.harness_max_tokens)
            failure_stage = "handshake"
            cap = client.request("awu/capabilities", {}, response_model=Capabilities)
            if (cap.protocolVersion != PROTOCOL_VERSION or cap.runtimeVersion != RUNTIME_VERSION
                    or cap.sourceCommit != COMMIT or not cap.realtime or not cap.approvals
                    or cap.questions or cap.questionProtocol != 'none'
                    or any(getattr(cap, key) != value for key, value in identity.items())):
                raise RuntimeError("Harness AWU 桥握手不匹配，禁止提交")
            options = {**identity, "constraints": constraints or "", "textOnly": text_only, "mcpServers": servers}
            if config.allowed_tools is not None:
                options["allowedTools"] = config.allowed_tools
            failure_stage = "configure"
            client.request("awu/configure", options, response_model=Empty, timeout_seconds=20)
            publish({"method": "awu/ready", "payload": {**identity}})
            if meta.get("submitted") or agent_session_id:
                failure_stage = "resume"
                client.resume_session(native)
            params: dict[str, Any] = {"sessionId": native, "contentBlocks": content_blocks(content, checked_images)
                if checked_images else [{"type": "text", "text": content}]}
            if checked_images:
                failure_stage = "image_admission"
                request = admission_request(cap.model_dump(), {**identity, "ownerId": owner_id,
                    "executorId": executor_id, "awuSessionId": session_id, "backendId": config.id,
                    "provider": provider, "model": model}, checked_images)
                reply = client.request("awu/imageAdmission", request, response_model=ImageReply).model_dump()
                token = admitted_image_token(reply, request)
                params["awuImageAdmission"] = {"admissionId": token}
                check_request_budget({"jsonrpc": "2.0", "id": "turn-preflight", "method": "session/prompt", "params": params})
            if owned.stop_requested.is_set():
                raise RuntimeError("Harness 已取消")
            failure_stage = "submit"
            if on_submission:
                # 事件循环必须确认台账已持久提交；仅入队通知不是落盘许可。
                acknowledged = concurrent.futures.Future()
                publish({"method": "awu/submitting", "payload": identity, "ack": acknowledged})
                acknowledged.result(timeout=10)
                if owned.stop_requested.is_set():
                    raise RuntimeError("Harness 已取消")
            # 提交前持久关联，即便 receipt 丢失也不创建替代线程或重放用户输入。
            previous_meta = dict(meta)
            meta.update(submitted=True, configFingerprint=fingerprint)
            if checked_images:
                meta["imageInputs"] = True
            layout.save_metadata(meta)
            native_submitted = True
            prompt_attempted = True
            if checked_images:
                reply = client.request("session/prompt", params, response_model=ImageReply).model_dump()
                if is_image_prompt_rejection(reply):
                    prompt_attempted = False  # 受信桥明确没有进入 native handler。
                    # 只有受信桥明确未进入 handler 才能恢复旧提交位；落盘失败仍保留未知关联。
                    layout.save_metadata(previous_meta)
                    native_submitted = bool(previous_meta.get("submitted") or agent_session_id)
                    raise image_admission_error(reply.get("reason"))
                receipt = reply.get("messageId")
                if (not isinstance(receipt, str) or not receipt or len(receipt) > 200
                        or any(ord(char) < 32 or ord(char) == 127 for char in receipt)):
                    raise RuntimeError("Harness 图片提交回执未知，不自动重放")
            else:
                receipt = client.session_prompt(native, params["contentBlocks"])
            receipt_received = True
            failure_stage = "execution"
            publish({"method": "awu/receipt", "payload": {**identity, "messageId": receipt}})
            received = False
            ended: str | None = None
            end_error: Exception | None = None
            last_root_seq = -1
            wait_result: concurrent.futures.Future | None = None
            deadline = time.monotonic() + 1800
            while time.monotonic() < deadline:
                if owned.stop_requested.is_set():
                    raise RuntimeError("Harness 已取消")
                try:
                    note = client.next_owned_notification(timeout=.1)
                except queue.Empty:
                    if wait_result is not None and wait_result.done():
                        wait_result.result()
                        if ended != "completed":
                            failure_stage = "execution"
                            raise end_error or terminal_error(None)
                        return {"agentSessionId": native, "success": True, "stopReason": "end_turn"}
                    continue
                payload = note.payload
                event = payload.get("event", {})
                root_event = note.method == "session.event" and payload.get("sessionId") == native
                if root_event:
                    seq = event.get("seq")
                    if type(seq) is not int or seq < 0:
                        raise RuntimeError("Harness 根事件序列无效")
                    if seq <= last_root_seq:
                        continue
                    last_root_seq = seq
                if not received:
                    received = (note.method == "session.event" and payload.get("sessionId") == native
                        and event.get("type") == "agent/inbox/spliced"
                        and any(isinstance(item, dict) and item.get("id") == receipt
                                for item in event.get("data", {}).get("inserted", [])))
                    if not received:
                        continue
                if note.method == "session.event" and payload.get("sessionId") == native and event.get("type") == "turn/end":
                    if ended is not None:
                        raise RuntimeError("Harness 本轮收到重复终态")
                    data = event.get("data")
                    reason = data.get("reason") if isinstance(data, dict) else None
                    ended = reason.get("kind") if isinstance(reason, dict) else None
                    if not isinstance(ended, str):
                        raise RuntimeError("Harness turn/end 缺少有效结束原因")
                    if ended != "completed":
                        end_error = terminal_error(reason)
                publish({"method": note.method, "payload": payload})
                if (note.method == "session.status" and payload.get("sessionId") == native
                        and payload.get("status") == "idle" and wait_result is None):
                    if ended is None:
                        raise RuntimeError("Harness 根空闲但缺少本轮终态")
                    failure_stage = "wait"
                    wait_result = concurrent.futures.Future()
                    def wait_owned() -> None:
                        try:
                            client.request("session/wait", {"sessionId": native}, response_model=Empty, timeout_seconds=120)
                            wait_result.set_result(None)
                        except BaseException as exc:
                            wait_result.set_exception(exc)
                    threading.Thread(target=wait_owned, name="awu-dsh-wait", daemon=True).start()
            raise TimeoutError("Harness 本轮等待超时，不自动重放")

        async def approve(payload: dict) -> None:
            if (not worker or not worker.client or payload.get("generation") != generation
                    or payload.get("configFingerprint") != fingerprint or not projection
                    or not projection.belongs(payload.get("sessionId"))):
                raise RuntimeError("Harness 权限请求身份不匹配")
            for key in ("callId", "requestId", "toolName", "arguments"):
                if not isinstance(payload.get(key), str):
                    raise ValueError("Harness 权限请求缺少真实关联字段")
            call = projection.tools.get((payload["sessionId"], payload["callId"]))
            if not call or call.get("name") != payload["toolName"] or call.get("input") != payload["arguments"]:
                raise ValueError("Harness 权限请求与已观测工具参数不一致")
            if payload["requestId"] in seen_approvals or len(seen_approvals) >= 256:
                raise ValueError("Harness 权限请求重复或超出限额")
            seen_approvals.add(payload["requestId"])
            allowed = False
            if on_permission_request:
                req = PermissionRequest(session_id, message_id, projection.tool_id(payload["sessionId"], payload["callId"]),
                                        str(payload["toolName"]), str(payload["arguments"]))
                allowed = bool(await asyncio.wait_for(on_permission_request(req), timeout=290))
            if worker.stop_requested.is_set():
                return
            from pydantic import BaseModel
            class Empty(BaseModel):
                pass
            await asyncio.to_thread(worker.client.request, "awu/approvalRespond", {
                key: payload[key] for key in ("sessionId", "generation", "configFingerprint", "callId", "requestId")
            } | {"allowed": allowed}, response_model=Empty, timeout_seconds=5)

        def event(note: dict) -> None:
            nonlocal projection, failure_stage
            if note["method"] == "awu/submitting":
                try:
                    submission("submitting")
                except Exception as exc:
                    note["ack"].set_exception(exc)
                    raise
                note["ack"].set_result(None)
                return
            if note["method"] == "awu/ready":
                emit("diagnostic", diagnostic={"phase": "runner_ready"})
                return
            if note["method"] == "awu/receipt":
                from .deepseek_harness_events import HarnessProjection
                projection = HarnessProjection(native, generation, fingerprint, emit)
                submission("native_received")
                emit("diagnostic", diagnostic={"phase": "turn_accepted"})
                trace_response("harness-sdk", {"method": "session/prompt", "accepted": True},
                    "原生输入接收，不代表模型完成或成功。")
                return
            if note["method"] == "session.event":
                observed = note["payload"].get("event", {})
                trace_response("harness-event", harness_event_metadata(observed),
                    "已观测的原生事件身份；不复制原生历史、环境或隐藏思考。")
            if note["method"] == "awu/approvalRequested":
                if len(approvals) >= 32:
                    raise RuntimeError("Harness 权限等待数量超限")
                task = asyncio.create_task(approve(note["payload"]))
                approvals.add(task)
                def settled(done: asyncio.Task) -> None:
                    approvals.discard(done)
                    if not done.cancelled() and done.exception():
                        worker.request_stop()
                task.add_done_callback(settled)
            elif projection:
                try:
                    projection.observe(note)
                except Exception:
                    failure_stage = "projection"
                    raise

        worker.start(work)
        result = await worker.consume(event)
        submission("succeeded")
        emit("diagnostic", diagnostic={"phase": "sdk_response"})
        usage = projection.usage() if projection else None
        emit("done", **({"usage": usage} if usage else {}))
        return result
    except asyncio.CancelledError:
        if worker:
            worker.request_stop()
        if receipt_received and not receipt_observed:
            submission("native_received")
        # 停止不证明退出或副作用消失；已写出的请求保留 unknown。
        submission("unknown" if prompt_attempted else "rejected",
                   "receipt_unknown" if prompt_attempted else "cancelled")
        raise
    except Exception as exc:
        if receipt_received and not receipt_observed:
            submission("native_received")
        submission("failed" if receipt_received else "unknown" if prompt_attempted else "rejected",
                   "runtime_failed" if receipt_received else "receipt_unknown" if prompt_attempted
                   else exc.reason if isinstance(exc, ImagePolicyError) else "preflight_rejected")
        details = harness_error_details(exc, stage=failure_stage)
        # 即使未开启正文采集也能追查失败；仅记录安全类别与本轮关联，不存原始响应/思考/凭据。
        print("[HarnessTurn] " + json.dumps({"sessionId": session_id, "messageId": message_id,
              **details}, ensure_ascii=False), file=sys.stderr, flush=True)
        emit("diagnostic", diagnostic={"phase": "backend_error", **details})
        trace_response("harness-failure", details, "安全错误类别与失败阶段；不包含原始异常、凭据或路径。")
        # RuntimeError 等内建异常也可能包装上游正文；只允许受控类别／精确常量。
        message = harness_error_text(exc, stage=failure_stage)
        emit("error", error=message[:1000])
        # 保留原生关联；不能触发 Bridge 的 without_session 自动重放。
        return {"agentSessionId": agent_session_id or (native if native_submitted else None), "error": message[:1000],
                "success": False, "stopReason": "error"}
    finally:
        for task in list(approvals):
            task.cancel()
        if approvals:
            await asyncio.gather(*approvals, return_exceptions=True)
        running = getattr(backend, "_harness_workers", {})
        # 注册门拒绝的候选从未启动；不能将它遗留为另一个虚假的活动对象。
        # 实际 owning worker 及其 unknown 标记不在此分支，仍保留原保护。
        if worker and (worker.confirmed or worker.task is None) and running.get(session_id) is worker:
            running.pop(session_id, None)
