"""Kit 安装的执行器边界；不允许控制端替换目标或绕过安装确认。"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from .kit_update_journal import HANDOFF_PHASES, JournalError, durable_json, fingerprint
from .update_manager import _current_release, _platform, _runtime

UPDATE_CAPABILITY = "node.update_local_published"

# 交接期间仅允许观察和停止；其他入口 fail closed，不能通过看似只读的 RPC 启动探测进程。
HANDOFF_RPC = {
    "ping", "getSession", "listSessions", "getBackends", "getAppConfig", "getUserProfile",
    "listConnectedClients", "getNodeInfo", "getNodeCapabilities", "nodeUpdateStatus",
    "loadSession", "loadSessionMeta", "loadSessionMessages", "getSessionTokenUsage", "getStatus",
    "sessionFavoriteGet", "getDefaultAbilities", "kitGenerationGet", "getConfig",
    "kitGetState", "kitCapabilityList", "kitCancel", "kitResume", "kitCapabilityRespond",
    "kitUpdateReconcile", "kitDesktopReady", "kitInstallHandoffFailed",
    "loopGetState", "loopGetRecord", "loopStop", "abortMessage", "getSessionRunState",
    "terminalStop", "terminalList", "terminalRead", "languageServiceStop",
}


class KitUpdateBridge:
    def _kit_local_update_context(self, state: Any, session: Any, run: Any, step: Any) -> Any:
        from dataclasses import replace
        from .kit_capabilities import KitLocalUpdateServices
        async def prepare() -> dict[str, Any]:
            await self._run_kit_update_step(state, session, run, step)
            return step.config["capabilityRuntime"]
        def reconcile() -> dict[str, Any]:
            return self._reconcile_kit_update(step.config["capabilityRuntime"]["installRequestId"])
        def cancel() -> None:
            self._cancel_kit_update(state, run, step)
        return replace(self._kit_capability_context(session, run),
                       local_update=KitLocalUpdateServices(prepare, reconcile, cancel))

    def _rpc_kitDesktopReady(self, identity_json: str) -> str:
        from .bridge_ws import _REQUEST_CLIENT
        client = _REQUEST_CLIENT.get()
        identity = json.loads(identity_json)
        expected = os.environ.get("AGENT_WITH_U_KIT_DESKTOP_PROOF", "")
        supplied = str(identity.pop("proof", ""))
        if (not client or client not in self._clients or getattr(client, "identity_src", "") == "relay"
                or not expected or not secrets.compare_digest(supplied, expected)
                or identity.get("protocol") != 1
                or identity.get("pid") != int(os.environ.get("AGENT_WITH_U_DESKTOP_PID") or 0)
                or Path(str(identity.get("exe") or "")).resolve() != Path(os.environ.get("AGENT_WITH_U_DESKTOP_EXE", "")).resolve()
                or identity.get("deviceId") != os.environ.get("AGENT_WITH_U_DEVICE_ID")):
            raise PermissionError("无法验证目标执行器的本地桌面实例")
        if not hasattr(self, "_kit_desktops"):
            self._kit_desktops = {}
        self._kit_desktops[client] = {key: identity[key] for key in
            ("protocol", "instanceId", "pid", "exe", "deviceId", "installed", "release")}
        active = self._update_manager.journal.active()
        if active.get("kind") == "kit":
            self._start_kit_update_observer(active["requestId"])
        return json.dumps({"status": "ok", "protocol": 1})

    def _kit_desktop(self) -> tuple[Any, dict[str, Any]]:
        if _platform() != "windows" or _runtime() != "desktop" or not getattr(sys, "frozen", False):
            raise JournalError("本机更新仅支持已安装 Windows 桌面；源码和其他平台不支持")
        candidates = [(client, view) for client, view in getattr(self, "_kit_desktops", {}).items()
                      if client in self._clients]
        if len(candidates) != 1:
            raise JournalError("目标执行器的本地桌面离线、旧协议或存在多实例歧义")
        client, view = candidates[0]
        if view.get("protocol") != 1 or view.get("installed") is not True:
            raise JournalError("目标不是可验证的已安装桌面实例；首次部署请使用原更新入口")
        return client, view

    def _published_for_update(self, run: Any) -> dict[str, Any]:
        sources = [step for step in run.steps[:run.current_step] if step.status == "succeeded"
                   and step.config.get("capability") == "release.publish_latest"
                   and (step.config.get("capabilityRuntime") or {}).get("boundBuild")]
        if len(sources) != 1:
            raise JournalError("需要当前运行唯一且成功的严格绑定发布步骤")
        source = sources[0]
        runtime = source.config.get("capabilityRuntime") or {}
        return self._release_center().published_result(runtime.get("jobId", ""), runtime.get("planId", ""),
            runtime.get("planFingerprint", ""), run.id, source.id)

    async def _run_kit_update_step(self, state: Any, session: Any, run: Any, step: Any,
                                    artifact_id: str = "") -> None:
        self._require_node_update_capability()
        if run.trigger == "schedule" or step is not run.steps[-1]:
            raise JournalError("本机更新只能人工触发并且必须是展开计划的最后一步")
        runtime = step.config.setdefault("capabilityRuntime", {})
        if runtime.get("installRequestId") and runtime.get("phase") in HANDOFF_PHASES:
            self._reconcile_kit_update(runtime["installRequestId"])
            return
        _client, desktop = self._kit_desktop()
        published = self._published_for_update(run)
        identity = dict(ownerId=self._session_owner_id(session.id), deviceId=desktop["deviceId"],
                        instanceId=desktop["instanceId"], sessionId=session.id, runId=run.id, stepId=step.id)
        request_id = runtime.get("installRequestId") or uuid.uuid4().hex
        self._update_manager.reserve_kit(request_id, identity)
        runtime.update(installRequestId=request_id, identity=identity, phase="staging", publishedRelease=published)
        step.started_at = step.started_at or time.time()
        step.status = run.status = "running"
        try:
            self._kit_save(state)
            staged = await self._update_manager.stage_published(published, artifact_id, request_id=request_id)
            if staged["phase"] == "needs_selection":
                plan = {"device": desktop["deviceId"], "instanceId": desktop["instanceId"],
                        "release": published["release"], "artifacts": staged["artifacts"],
                        "channel": published["channel"], "blockers": ["请选择本次发布的安装器"], "warnings": []}
                runtime.update(phase="needs_selection", planId=request_id, plan=plan, planFingerprint=fingerprint(plan))
            else:
                # 下载期间桌面/权限可变化，再核对；最终确认仍会再次检查。
                _client, current = self._kit_desktop()
                if current != desktop:
                    raise JournalError("下载期间本地桌面身份变化，请取消后重新准备")
                plan_path = Path(staged["planPath"])
                install_plan = json.loads(plan_path.read_text(encoding="utf-8"))
                artifact = self._update_manager._selection["artifact"]
                reasons = self._update_busy_reasons(run.id)
                frozen = self._update_manager.journal.freeze(request_id, identity, {
                    "desktop": desktop, "backendPid": os.getpid(), "current": _current_release(),
                    "release": published["release"], "artifact": artifact, "channel": published["channel"],
                    "publishedRelease": published, "installPlan": install_plan,
                    "warnings": ["安装将退出目标节点的桌面与 Backend，控制窗口不会被更新", "交接后无法保证撤回；不会自动重装或回滚"],
                    "preflight": reasons,
                })
                install_plan["kitUpdate"] = {"protocol": 1, "requestId": request_id, "identity": identity,
                                             "planFingerprint": frozen["planFingerprint"]}
                durable_json(plan_path, install_plan)
                public_plan = {key: value for key, value in frozen["plan"].items() if key != "installPlan"}
                public_plan.update(blockers=[], preflight=reasons)
                runtime.update(phase="waiting_approval", planId=request_id, planPath=str(plan_path),
                               planFingerprint=frozen["planFingerprint"], plan=public_plan)
            step.status = run.status = "waiting_approval"
            self._kit_save(state)
        except BaseException as error:
            self._update_manager.release_kit(request_id, identity,
                "cancelled" if isinstance(error, asyncio.CancelledError) else "failed")
            raise

    def _rpc_kitUpdateSelect(self, session_id: str, run_id: str, artifact_id: str,
                             plan_fingerprint: str, request_id: str) -> str:
        self._require_node_update_capability()
        self._require_session_access(session_id)
        state = self._kit_get(session_id)
        run = next(r for r in state.runs if r.id == run_id)
        step = run.steps[-1]
        runtime = step.config.get("capabilityRuntime") or {}
        selection = {"requestId": request_id, "artifactId": artifact_id, "planFingerprint": plan_fingerprint}
        if not request_id or len(request_id) > 128 or step.config.get("capability") != UPDATE_CAPABILITY:
            raise JournalError("无效制品选择请求")
        if runtime.get("selection"):
            if runtime["selection"] != selection:
                raise JournalError("该计划已有选择请求，请核对当前运行")
            return json.dumps({"status": "accepted", "run": run.to_dict()}, ensure_ascii=False)
        if runtime.get("phase") != "needs_selection" or runtime.get("planFingerprint") != plan_fingerprint:
            raise JournalError("制品选择计划已过期")
        if artifact_id not in {a["id"] for a in runtime.get("plan", {}).get("artifacts", [])}:
            raise JournalError("只能选择当前计划中的制品")
        runtime["selection"] = selection
        async def prepare() -> None:
            try:
                await self._run_kit_update_step(state, self._kit_session(session_id), run, step, artifact_id)
            except asyncio.CancelledError:
                step.status = run.status = "cancelled"
                self._kit_save(state)
            except Exception as error:
                runtime["phase"] = "failed"
                step.status = run.status = "error"
                step.error = run.error = str(error)
                step.ended_at = run.ended_at = time.time()
                self._kit_save(state)
        self._kit_save(state)
        task = asyncio.create_task(prepare())
        # Task 在首次执行前也可能被取消，此时协程的 finally 不会运行。
        def settled(done: asyncio.Task) -> None:
            if done.cancelled():
                self._update_manager.release_kit(runtime["installRequestId"], runtime["identity"])
        task.add_done_callback(settled)
        self._kit_track_task(run.id, task)
        return json.dumps({"status": "accepted", "run": run.to_dict()}, ensure_ascii=False)

    def _confirm_kit_update(self, state: Any, session: Any, run: Any, step: Any,
                            approved: bool, expected_fingerprint: str, request_id: str) -> str:
        self._require_node_update_capability()
        self._require_session_access(session.id)
        runtime = step.config.get("capabilityRuntime") or {}
        install_id = runtime.get("installRequestId", "")
        identity = runtime.get("identity") or {}
        if (identity.get("ownerId") != self._current_owner_id() or
                any(identity.get(k) != v for k, v in {
                    "sessionId": session.id, "runId": run.id, "stepId": step.id}.items())):
            raise PermissionError("安装确认归属已变化")
        journal = self._update_manager.journal
        record = journal.get(install_id, identity)
        if not approved:
            return self._cancel_kit_update(state, run, step)
        if record.get("confirmationId"):
            journal.confirm(install_id, identity, expected_fingerprint, request_id)
            return json.dumps({"status": "ok", "decision": "already_accepted", "run": run.to_dict()}, ensure_ascii=False)
        if runtime.get("phase") != "waiting_approval":
            raise JournalError("请先完成制品选择和下载校验")
        client, desktop = self._kit_desktop()
        if desktop != record["plan"]["desktop"]:
            raise JournalError("桌面实例已变化；旧安装确认失效")
        if self._published_for_update(run) != record["plan"]["publishedRelease"]:
            raise JournalError("发布凭据已变化")
        self._begin_update_handoff(install_id, run.id)
        try:
            journal.confirm(install_id, identity, expected_fingerprint, request_id)
            runtime.update(phase="handing_off", approval={"source": "human", "requestId": request_id,
                           "planFingerprint": expected_fingerprint, "approved": True, "actor": self._current_owner_id()})
            run.status = step.status = "handing_off"
            self._kit_save(state)
            self._kit_store.save_durable(state)
        except BaseException:
            # intent 可能已落盘：只在尚未确认时撤掉内存屏障，绝不推送安装通知。
            if not journal.get(install_id, identity).get("confirmationId"):
                self._kit_update_barrier = ""
            raise
        asyncio.create_task(self._send_kit_update_handoff(client, state, run, step))
        return json.dumps({"status": "ok", "decision": "accepted", "run": run.to_dict()}, ensure_ascii=False)

    async def _send_kit_update_handoff(self, client: Any, state: Any, run: Any, step: Any) -> None:
        runtime = step.config["capabilityRuntime"]
        try:
            await client.send(json.dumps({"event": "nodeUpdateInstallRequested", "data": json.dumps({
                "planPath": runtime["planPath"], "delayMs": 1500, "kitRequestId": runtime["installRequestId"],
                "instanceId": runtime["identity"]["instanceId"]}, ensure_ascii=False)}, ensure_ascii=False))
            phase = "waiting_restart"
        except Exception:
            phase = "result_unknown"  # 发送失败不证明客户端没有收到。
        runtime["phase"] = run.status = step.status = phase
        self._update_manager.journal.update(runtime["installRequestId"], runtime["identity"], {"phase": phase})
        self._kit_save(state)
        self._start_kit_update_observer(runtime["installRequestId"])

    def _reconcile_kit_update(self, request_id: str) -> dict[str, Any]:
        journal = self._update_manager.journal
        record = journal.get(request_id)
        desktop = None
        try:
            _client, desktop = self._kit_desktop()
        except JournalError:
            pass
        record = journal.reconcile(request_id, record["identity"], desktop=desktop,
                                   backend=_current_release(), ready=desktop is not None)
        identity = record["identity"]
        state = self._kit_get(identity["sessionId"])
        run = next((r for r in state.runs if r.id == identity["runId"]), None)
        step = next((s for s in run.steps if s.id == identity["stepId"]), None) if run else None
        if not step or (step.config.get("capabilityRuntime") or {}).get("installRequestId") != request_id:
            return record  # 不能创建替代运行或借用历史步骤。
        runtime = step.config["capabilityRuntime"]
        runtime.update(phase=record["phase"], receipt=record.get("receipt"), verification=record.get("verification"),
                       message=record.get("message", ""))
        step.status = run.status = record["phase"]
        if record["phase"] in {"succeeded", "failed"}:
            step.ended_at = run.ended_at = time.time()
            run.verdict = "passed" if record["phase"] == "succeeded" else "failed"
            step.exit_code = 0 if record["phase"] == "succeeded" else 1
            step.error = run.error = "" if step.exit_code == 0 else record.get("message", "安装失败")
            self._kit_update_barrier = ""
            self._update_manager._save_state({"phase": "installed" if step.exit_code == 0 else "error",
                                             "message": record.get("message", ""), "error": step.error})
        self._kit_save(state, emit=self._session_owner_id(identity["sessionId"]) == identity["ownerId"])
        return record

    def _start_kit_update_observer(self, request_id: str) -> None:
        if not hasattr(self, "_kit_update_observers"):
            self._kit_update_observers = {}
        if request_id in self._kit_update_observers:
            return
        async def observe() -> None:
            try:
                for _ in range(13):
                    record = self._reconcile_kit_update(request_id)
                    if record["phase"] in {"succeeded", "failed", "result_unknown"}:
                        return
                    await asyncio.sleep(15)
            finally:
                self._kit_update_observers.pop(request_id, None)
        self._kit_update_observers[request_id] = asyncio.create_task(observe())

    def _rpc_kitUpdateReconcile(self, session_id: str, run_id: str) -> str:
        self._require_session_access(session_id)
        run = next(r for r in self._kit_get(session_id).runs if r.id == run_id)
        step = run.steps[-1]
        runtime = step.config.get("capabilityRuntime") or {}
        if runtime.get("identity", {}).get("ownerId") != self._current_owner_id():
            raise PermissionError("安装记录不属于当前用户")
        self._reconcile_kit_update(runtime["installRequestId"])
        return json.dumps({"status": "ok", "run": run.to_dict()}, ensure_ascii=False)

    def _cancel_kit_update(self, state: Any, run: Any, step: Any) -> str:
        runtime = step.config.get("capabilityRuntime") or {}
        request_id = runtime.get("installRequestId")
        if request_id:
            record = self._update_manager.journal.get(request_id, runtime["identity"])
            if record.get("confirmationId"):
                return json.dumps({"status": "cannot_cancel", "message": "安装已交接，不能保证撤回；请只读核对结果", "run": run.to_dict()}, ensure_ascii=False)
        task = self._kit_tasks.get(run.id)
        if task and not task.done():
            task.cancel()
        elif request_id:
            self._update_manager.release_kit(request_id, runtime["identity"])
        step.status = run.status = "cancelled"
        runtime["phase"] = "cancelled"
        run.verdict = "cancelled"
        step.ended_at = run.ended_at = time.time()
        self._kit_save(state)
        return json.dumps({"status": "ok", "run": run.to_dict()}, ensure_ascii=False)

    def _rpc_kitInstallHandoffFailed(self, request_id: str) -> str:
        from .bridge_ws import _REQUEST_CLIENT
        client = _REQUEST_CLIENT.get()
        if client not in getattr(self, "_kit_desktops", {}) or client not in self._clients:
            raise PermissionError("仅目标本地桌面可报告交接结果")
        self._reconcile_kit_update(request_id)
        return json.dumps({"status": "ok"})

    def _update_work_blocked(self) -> bool:
        if getattr(self, "_kit_update_barrier", ""):
            return True
        manager = getattr(self, "_update_manager", None)
        if manager is None:
            return False
        active = manager.journal.active()
        if active.get("kind") != "kit":
            return False
        record = manager.journal.get(active["requestId"])
        return record["phase"] in HANDOFF_PHASES

    def _require_update_work_allowed(self) -> None:
        if self._update_work_blocked():
            raise RuntimeError("节点更新已进入交接或结果未知；暂不接收新任务，请核对安装结果")

    def _update_busy_reasons(self, own_run: str) -> list[str]:
        """只返回有界类别，不泄漏别的 owner 的会话内容或任务日志。"""
        reasons: list[str] = []
        def active(values: Any) -> bool:
            return any(task is not None and not task.done() for task in values)
        if any(active(tasks) for tasks in getattr(self, "_chat_turn_tasks", {}).values()):
            reasons.append("仍有对话正在运行")
        if any(deadline > time.time() for deadline in getattr(self, "_seq_dispatch_reservations", {}).values()):
            reasons.append("序列任务正在派发")
        scheduler = getattr(self, "_sequence_scheduler", None)
        if active(getattr(scheduler, "workers", {}).values()):
            reasons.append("序列派发尚未完成")
        for name, label in (("_loop_tasks", "LOOP 仍在运行"), ("_kit_generation_tasks", "Kit 生成仍在运行"),
                            ("_kit_optimization_tasks", "Kit 优化仍在运行"), ("_codex_sync_tasks", "原生线程同步仍在运行")):
            if active(getattr(self, name, {}).values()):
                reasons.append(label)
        for name in ("_loop_running", "_loop_active_backends", "_loop_environment_checks", "_loop_environment_requests",
                     "_loop_environment_orphans", "_loop_startup_jobs", "_engineering_activities", "_inspection_jobs",
                     "_aside_running", "_chat_aside_running", "_destroying_sessions"):
            if getattr(self, name, None):
                reasons.append("有受管工作、写入或未确认退出")
        if active(task for rid, task in getattr(self, "_kit_tasks", {}).items() if rid != own_run):
            reasons.append("其他 Kit 仍在运行")
        if any(proc.returncode is None for proc in getattr(self, "_kit_processes", {}).values()):
            reasons.append("Kit 命令进程尚未结束")
        if any(row.get("proc") and row["proc"].returncode is None
               for row in getattr(self, "_kit_terminals", {}).values()):
            reasons.append("Kit 终端尚未关闭")
        current = asyncio.current_task()
        if any(task is not current and not task.done()
               for task in getattr(self, "_kit_update_rpc_tasks", {}).values()):
            reasons.append("其他节点操作尚未完成")
        # 也检查未水合的历史 Kit；重启丢失 Task 句柄不能解除未知执行保护。
        from .kit_update_activity import records, loop_unsettled
        from .workspace_kit_store import FINAL_RUN_STATUSES
        states = dict(getattr(self, "_kit_states", {}))
        for data in records(getattr(self, "_kit_store", None)):
            if data["sessionId"] not in states and any(r.get("id") != own_run
                    and r.get("status") not in FINAL_RUN_STATUSES for r in data.get("runs", [])):
                reasons.append("其他 Kit 有未结束的运行记录")
        if any(run.id != own_run and run.status not in FINAL_RUN_STATUSES
               for state in states.values() if state for run in state.runs):
            reasons.append("其他 Kit 有未结束的运行记录")
        for sid, state in getattr(self, "_loop_states", {}).items():
            if self._loop_has_active_call(sid) or self._loop_control_reserved(sid):
                reasons.append("LOOP 调用或控制权转交尚未结束")
        for data in records(getattr(self, "_loop_store", None)):
            if data["sessionId"] not in getattr(self, "_loop_states", {}) and loop_unsettled(data):
                reasons.append("LOOP 持久化记录有未确认退出或转交")
        release = getattr(self, "_release_center_manager", None)
        if release and any(job.get("status") in {"queued", "running"} for job in release.status().get("jobs", [])):
            reasons.append("发布任务尚未完成")
        sessions = getattr(self, "_session_store", None)
        if sessions:
            from .deepseek_harness_worker import session_has_activity
            for session in sessions.list():
                if session_has_activity(owner=session.get("ownerId") or session.get("owner_id") or "local", session=session["id"]):
                    reasons.append("Harness 原生进程退出尚未确认")
                    break
        return list(dict.fromkeys(reasons))[:12]

    def _begin_update_handoff(self, request_id: str, own_run: str) -> None:
        # 同一事件循环中：置屏障 -> 权威复核 -> durable intent，中间不能 await。
        previous = getattr(self, "_kit_update_barrier", "")
        if previous and previous != request_id:
            raise JournalError("其他更新正在交接")
        self._kit_update_barrier = request_id
        try:
            reasons = self._update_busy_reasons(own_run)
            if reasons:
                raise JournalError("；".join(reasons) + "；请结束任务后重新确认")
        except BaseException:
            self._kit_update_barrier = previous
            raise
