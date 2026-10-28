"""Harness 单轮协调；请求接收、原生完成和进程退出是三个独立边界。"""
from __future__ import annotations

import asyncio
import concurrent.futures
import queue
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .base import PermissionRequest, StreamDelta
from .deepseek_harness_config import COMMIT, PROTOCOL_VERSION, REASONING_EFFORTS, RUNTIME_VERSION, validate_config_fields
from .deepseek_harness_sdk import bridge_path, create_client, create_harness_config, default_model
from .deepseek_harness_state import HarnessLayout, atomic_json, config_fingerprint, make_profile_patch
from .deepseek_harness_worker import HarnessWorker
from .call_trace import trace_request, trace_response
from .loop_diagnostics import error_evidence


async def send_turn(backend: Any, *, messages: list, content: str, images: list | None,
                    session_id: str, message_id: str, on_delta: Any, agent_session_id: str | None,
                    working_dir: str | None, skip_permissions: bool | None, on_permission_request: Any,
                    constraints: str | None, sandbox_enabled: bool, model_override: str | None = None,
                    reasoning_effort: str | None = None, execution_access: str | None = None,
                    owner_id: str = "local", executor_id: str = "local", text_only: bool = False,
                    isolated_context: bool = False, activity_parent: str | None = None,
                    **unknown: Any) -> dict:
    def emit(kind: str, **data: Any) -> None:
        on_delta(StreamDelta(session_id, message_id, kind, **data))

    native = agent_session_id
    worker: HarnessWorker | None = None
    approvals: set[asyncio.Task] = set()
    seen_approvals: set[str] = set()
    try:
        if unknown:
            raise ValueError("Harness 不支持请求中的额外运行选项")
        validate_config_fields(backend.config.to_dict())
        if images:
            raise ValueError("此 Harness 路由的附件能力尚未验证；保留附件，不会删除后自动重发")
        if reasoning_effort and reasoning_effort not in REASONING_EFFORTS:
            raise ValueError("此 Harness 版本不支持该推理强度")
        if text_only:
            if agent_session_id or activity_parent:
                raise ValueError("Harness 纯文本调用不能恢复主会话或继承活动身份")
            isolated_context = True
        cwd = str(Path(working_dir or backend.config.working_dir or Path.cwd()).resolve(strict=True)) if not text_only else ""
        if not text_only and not Path(cwd).is_dir():
            raise ValueError("Harness 工作目录不是目录")
        from .deepseek_harness_mcp import normalize_servers
        servers = [] if text_only else normalize_servers(backend.config.mcp_servers, cwd=cwd)
        mode = "read-only" if text_only else execution_access or backend.config.harness_permission_mode or "workspace-write"
        if sandbox_enabled:
            raise ValueError("Harness 尚无已验证的 AWU OS 沙箱覆盖，不能忽略沙箱请求")
        if isolated_context:
            native = agent_session_id or "awu-" + uuid.uuid4().hex
        layout = HarnessLayout.for_session(owner=owner_id, executor=executor_id,
            backend=backend.config.id, session=session_id, context=native if isolated_context else None)
        if text_only:
            cwd = str(layout.root / "work")
        skill_layout = HarnessLayout.for_session(owner=owner_id, executor=executor_id,
            backend=backend.config.id, session=session_id)
        generation = uuid.uuid4().hex
        fingerprint = config_fingerprint(backend.config, runtime={"model": model_override,
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
            "constraintChars": len(constraints or ""), "model": model_override or backend.config.model,
            "reasoningEffort": reasoning_effort, "access": mode},
            "SDK 提交元数据；不包含环境、动态凭据或供应商原始 HTTP 请求。")

        def work(owned: HarnessWorker, publish: Any) -> dict:
            nonlocal native
            if text_only:
                Path(cwd).mkdir(mode=0o700)
            from pydantic import BaseModel
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

            meta = layout.read_metadata(cwd=cwd, native_id=agent_session_id)
            if isolated_context and not agent_session_id:
                meta["nativeId"] = native
            native = meta["nativeId"]
            identity = {"sessionId": native, "generation": generation, "configFingerprint": fingerprint}
            patch = owned.owner.receipt.parent / "awu.patch.yml"
            skip = True if text_only else backend.config.skip_permissions if skip_permissions is None else skip_permissions
            from .deepseek_harness_skills import run_skill_view
            skills, skill_names = ([], []) if text_only else run_skill_view(skill_layout, patch.parent)
            rows = make_profile_patch(native_id=native, generation=generation, fingerprint=fingerprint,
                bridge=bridge_path(), cwd=cwd, mode=mode, skip_permissions=skip,
                skill_dirs=skills, skill_names=skill_names)
            atomic_json(patch, rows)
            env = dict(backend.config.env or {})
            if backend.config.api_key is not None:
                env["DEEPSEEK_API_KEY"] = backend.config.api_key
            if backend.config.base_url is not None:
                env["DEEPSEEK_BASE_URL"] = backend.config.base_url
            client = create_client(config=create_harness_config(dsh_bin=backend.config.cli_path, profile="sdk",
                dsh_home=str(layout.home), cwd=cwd, patches=(str(patch),), env=env,
                initialize_timeout_seconds=20, request_timeout_seconds=10), owner=owned.owner)
            owned.client = client
            client.start()
            owned.reservation.mark_active(generation, owned.owner.process.pid)
            if owned.stop_requested.is_set():
                raise RuntimeError("Harness 已取消")
            client.initialize(cwd=cwd, provider=backend.config.harness_provider or "deepseek-official",
                model=model_override or backend.config.model or default_model(),
                reasoning_effort=reasoning_effort, max_tokens=backend.config.harness_max_tokens)
            cap = client.request("awu/capabilities", {}, response_model=Capabilities)
            if (cap.protocolVersion != PROTOCOL_VERSION or cap.runtimeVersion != RUNTIME_VERSION
                    or cap.sourceCommit != COMMIT or not cap.realtime or not cap.approvals
                    or any(getattr(cap, key) != value for key, value in identity.items())):
                raise RuntimeError("Harness AWU 桥握手不匹配，禁止提交")
            options = {**identity, "constraints": constraints or "", "textOnly": text_only, "mcpServers": servers}
            if backend.config.allowed_tools is not None:
                options["allowedTools"] = backend.config.allowed_tools
            client.request("awu/configure", options, response_model=Empty, timeout_seconds=20)
            publish({"method": "awu/ready", "payload": {**identity}})
            if meta.get("submitted") or agent_session_id:
                client.resume_session(native)
            # 提交前持久关联，即便 receipt 丢失也不创建替代线程或重放用户输入。
            meta.update(submitted=True, configFingerprint=fingerprint)
            layout.save_metadata(meta)
            receipt = client.session_prompt(native, [{"type": "text", "text": content}])
            publish({"method": "awu/receipt", "payload": {**identity, "messageId": receipt}})
            received = False
            ended: str | None = None
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
                            raise RuntimeError("Harness 未成功结束: " + str(ended))
                        return {"agentSessionId": native, "success": True, "stopReason": "end_turn"}
                    continue
                payload = note.payload
                event = payload.get("event", {})
                if not received:
                    received = (note.method == "session.event" and payload.get("sessionId") == native
                        and event.get("type") == "agent/inbox/spliced"
                        and any(isinstance(item, dict) and item.get("id") == receipt
                                for item in event.get("data", {}).get("inserted", [])))
                    if not received:
                        continue
                if note.method == "session.event" and payload.get("sessionId") == native and event.get("type") == "turn/end":
                    ended = event.get("data", {}).get("reason", {}).get("kind")
                    if not isinstance(ended, str):
                        raise RuntimeError("Harness turn/end 缺少有效结束原因")
                publish({"method": note.method, "payload": payload})
                if (note.method == "session.status" and payload.get("sessionId") == native
                        and payload.get("status") == "idle" and wait_result is None):
                    if ended is None:
                        raise RuntimeError("Harness 根空闲但缺少本轮终态")
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
            nonlocal projection
            if note["method"] == "awu/ready":
                emit("diagnostic", diagnostic={"phase": "runner_ready"})
                return
            if note["method"] == "awu/receipt":
                from .deepseek_harness_events import HarnessProjection
                projection = HarnessProjection(native, generation, fingerprint, emit)
                emit("diagnostic", diagnostic={"phase": "turn_accepted"})
                trace_response("harness-sdk", {"method": "session/prompt", "accepted": True},
                    "原生输入接收，不代表模型完成或成功。")
                return
            if note["method"] == "session.event":
                observed = note["payload"].get("event", {})
                trace_response("harness-event", {"type": observed.get("type"), "seq": observed.get("seq")},
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
                projection.observe(note)

        worker.start(work)
        result = await worker.consume(event)
        emit("diagnostic", diagnostic={"phase": "sdk_response"})
        usage = projection.usage() if projection else None
        emit("done", **({"usage": usage} if usage else {}))
        return result
    except asyncio.CancelledError:
        if worker:
            worker.request_stop()
        raise
    except Exception as exc:
        emit("diagnostic", diagnostic={"phase": "backend_error", **error_evidence(exc)})
        # SDK 原始异常可含服务商回显或 stderr；只展示受控本地错误。
        local = type(exc).__module__.startswith(("builtins", "src.backend.deepseek_harness"))
        message = str(exc) if local and isinstance(exc, (ValueError, RuntimeError, TimeoutError)) else "Harness 调用失败，请检查依赖、连接和原生历史状态"
        secrets = [backend.config.api_key, *(backend.config.env or {}).values()]
        for secret in secrets:
            if secret:
                message = message.replace(secret, "[redacted]")
        emit("error", error=message[:1000])
        # 保留原生关联；不能触发 Bridge 的 without_session 自动重放。
        return {"agentSessionId": agent_session_id or native, "error": message[:1000],
                "success": False, "stopReason": "error"}
    finally:
        for task in list(approvals):
            task.cancel()
        if approvals:
            await asyncio.gather(*approvals, return_exceptions=True)
        running = getattr(backend, "_harness_workers", {})
        if worker and worker.confirmed and running.get(session_id) is worker:
            running.pop(session_id, None)
