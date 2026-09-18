"""普通聊天的执行端序列调度。无客户端计时器、无离线轮询、无隐式授权。"""
from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .bridge_ws import BridgeWS


async def dispatch_sequence_message(bridge: BridgeWS, payload_json: str) -> bool:
    """可在执行端等价执行的应用命令；不把未知 UI 命令偷偷当模型提示词。"""
    payload = json.loads(payload_json)
    text = str(payload.get("content") or "").strip()
    command = text.split(maxsplit=1)[0].lower() if text else ""
    sid = payload["sessionId"]
    session = bridge._active_sessions.get(sid) or bridge._session_store.load(sid)
    bridge._active_sessions[sid] = session
    if command in {"/compact", "/clear", "/new", "/autocontinue"}:
        if payload.get("images") or payload.get("textAttachments"):
            raise ValueError("序列中的应用命令不接收附件，请拆为单独消息")
        if text.lower() != command:
            raise ValueError(f"{command} 不接收参数，请检查序列内容")
        if command == "/new":
            result = json.loads(bridge._rpc_clearSessionContext(sid))
            return result.get("success") is True
        args = {"enabled": not session.auto_continue} if command == "/autocontinue" else {}
        result = json.loads(bridge._rpc_executeCommand(json.dumps({
            "command": "set_auto_continue" if command == "/autocontinue" else command[1:],
            "sessionId": sid, "args": args,
        })))
        if command == "/clear":
            bridge._emit_session_updated({"type": "context_cleared", "sessionId": sid})
        return result.get("status") in {"ok", "skip"}
    if command == "/continue":
        payload["content"] = "Continue exactly from where you left off. Do not repeat any content you already generated."
    elif command.startswith("/") and command != "/skill" and not command.startswith("/opsx-"):
        raise ValueError(f"{command} 尚不支持执行端序列，请在聊天窗口单独执行或编辑此条；未调用模型。")
    return await bridge._handle_send_message(json.dumps(payload, ensure_ascii=False))


class SequenceScheduler:
    def __init__(self, bridge: BridgeWS) -> None:
        self.bridge = bridge
        self.workers: dict[str, asyncio.Task] = {}
        self.closed = False
        self.started = False
        self.deleted: set[str] = set()
        self.interrupted: set[str] = set()
        self.redirecting: set[str] = set()

    async def start(self) -> None:
        """进程启动恢复 pending；不自动重放可能已产生副作用的 running。"""
        sids = await asyncio.to_thread(self.bridge._chat_extras_store.session_ids)
        for sid in sids:
            ex = self.bridge._chat_extras_get(sid)
            interrupted = [task for task in ex.seq_tasks if task.status == "running"]
            for task in interrupted:
                task.status = "error"
                task.error = "执行端重启，上一条结果未确认；请核对结果后重试或删除。"
                task.updated_at = time.time()
            if interrupted:
                ex.seq_auto = False
                ex.seq_error = interrupted[0].error
                self.bridge._chat_extras_save(ex)
        self.started = True
        # 启动期间新到达的添加请求也纳入；恢复完成前禁止任何 worker 抢跑。
        for sid in set(sids) | set(self.bridge._chat_extras):
            self.kick(sid)

    def kick(self, sid: str) -> None:
        if not self.started or self.closed or sid in self.deleted:
            return
        previous = self.workers.get(sid)
        if previous and not previous.done():
            return
        # 主 turn 注册在 create_task 同步边界；done 帧不是任务完成信号。
        if getattr(self.bridge, "_chat_turn_tasks", {}).get(sid):
            return
        ex = self.bridge._chat_extras_get(sid)
        if not ex.seq_auto or not ex.pending_tasks():
            return
        # 恢复任务也绑定 Session owner，不能继承另一控制端或启动进程的身份。
        from .bridge_ws import _REQUEST_OWNER_ID, _REQUEST_IDENTITY_SOURCE, _REQUEST_CAN_CLAIM_LEGACY
        owner = self.bridge._session_owner_id(sid)
        if not owner:
            return
        tokens = (
            _REQUEST_OWNER_ID.set(owner),
            _REQUEST_IDENTITY_SOURCE.set("sequence"),
            _REQUEST_CAN_CLAIM_LEGACY.set(False),
        )
        try:
            self.workers[sid] = asyncio.create_task(self._drain(sid))
        finally:
            _REQUEST_OWNER_ID.reset(tokens[0])
            _REQUEST_IDENTITY_SOURCE.reset(tokens[1])
            _REQUEST_CAN_CLAIM_LEGACY.reset(tokens[2])

    def pause(self, sid: str, reason: str = "") -> None:
        if self.closed or sid in self.deleted:
            return
        ex = self.bridge._chat_extras_get(sid)
        ex.seq_auto = False
        ex.seq_error = reason
        self.bridge._chat_extras_save(ex)
        self.bridge._emit_seqtask_updated(ex)

    def turn_finished(self, sid: str, success: bool) -> None:
        if self.closed or sid in self.deleted:
            return
        ex = self.bridge._chat_extras_get(sid)
        self.interrupted.discard(sid)
        self.redirecting.discard(sid)
        # redirect 是用户明确要求的“中断后重引导”，不是普通的手动停止。
        pending = ex.pending_tasks()
        redirect = bool(pending and pending[0].delivery_mode == "redirect")
        if not success and pending and not redirect:
            self.pause(sid, "上一轮未正常完成，序列已暂停；检查聊天结果后可继续。")
        self.kick(sid)

    async def _drain(self, sid: str) -> None:
        current = None
        try:
            while not self.closed and sid not in self.deleted:
                ex = self.bridge._chat_extras_get(sid)
                if not ex.seq_auto or getattr(self.bridge, "_chat_turn_tasks", {}).get(sid):
                    return
                remaining = [task for task in ex.seq_tasks if task.status not in {"done", "sent", "interrupted"}]
                if not remaining or remaining[0].status != "pending":
                    return
                current = remaining[0]
                session = self.bridge._active_sessions.get(sid) or self.bridge._session_store.load(sid)
                if not session:
                    raise ValueError("会话不存在，无法派发序列")
                self.bridge._require_agent_execution_enabled()
                current.status = "running"
                current.error = ""
                current.updated_at = time.time()
                # 必须先落盘，再注册主 turn；中间没有 await、没有第二次客户端 RPC。
                self.bridge._chat_extras_save(ex)
                self.bridge._emit_seqtask_updated(ex)
                payload = {
                    "sessionId": sid, "backendId": session.backend_id,
                    "workingDir": session.working_dir,
                    "content": current.text, "images": current.images,
                    "textAttachments": current.text_attachments,
                    "deliveryMode": current.delivery_mode,
                    "autoContinue": session.auto_continue,
                    "skipPermissions": session.skip_permissions,
                    "userMessageId": f"seq-user-{current.id}-{time.time_ns()}",
                    "messageId": f"seq-assistant-{current.id}-{time.time_ns()}",
                    # 不保存/复用上一轮 Kit 代确认开关与动态令牌。
                }
                success = await self.bridge._start_chat_turn(
                    json.dumps(payload, ensure_ascii=False), sequence=True,
                )
                if self.closed or sid in self.deleted:
                    return
                interrupted = sid in self.interrupted
                redirected = sid in self.redirecting
                self.interrupted.discard(sid)
                self.redirecting.discard(sid)
                success = success and not interrupted and not redirected
                current.status = "interrupted" if redirected else "done" if success else "error"
                current.updated_at = time.time()
                if redirected:
                    current.error = "用户中断后重引导；原任务未标记为完成。"
                elif not success:
                    current.error = "本条未正常完成；请核对聊天结果，重试可能重复部分操作。"
                    ex.seq_auto = False
                    ex.seq_error = current.error
                self.bridge._chat_extras_save(ex)
                self.bridge._emit_seqtask_updated(ex)
                current = None
                # 让控制请求有机会插入；下一轮仍需重新读取暂停状态和排序。
                await asyncio.sleep(0)
        except asyncio.CancelledError:
            # 进程退出时保留 running，下次启动按不确定结果恢复，不重放。
            raise
        except Exception as exc:
            if not self.closed and sid not in self.deleted:
                if current:
                    current.status = "error"
                    current.error = str(exc)[:500]
                self.pause(sid, str(exc)[:500])
        finally:
            if self.workers.get(sid) is asyncio.current_task():
                self.workers.pop(sid, None)

    def remove(self, sid: str) -> None:
        self.deleted.add(sid)
        self.interrupted.discard(sid)
        self.redirecting.discard(sid)
        worker = self.workers.pop(sid, None)
        if worker:
            worker.cancel()

    async def stop(self) -> None:
        self.closed = True
        tasks = list(self.workers.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
