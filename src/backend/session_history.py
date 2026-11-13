"""同目录续建：旧 Session 不变，新 Session 的来源字段就是持久回执。"""
from __future__ import annotations

import asyncio
import copy
import json
import re
import time
import uuid
from typing import Any

from ..types import Session
from . import paths
from .deepseek_harness_state import HarnessLayout, reject_links


def renewal_id(owner: str, source: str, request: str) -> str:
    if not isinstance(request, str) or not re.fullmatch(r"[\w-]{1,128}", request):
        raise ValueError("新会话请求标识无效")
    return str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(["awu-session-renew-v1", owner, source, request])))


def fresh_session(source: Session, sid: str, request: str, appearance: dict[str, Any]) -> Session:
    now = time.time()
    result = Session(id=sid, title=source.title, created_at=now, updated_at=now,
                     messages=[], working_dir=source.working_dir, backend_id=source.backend_id,
                     owner_id=source.owner_id)
    # 明确继承设置，不复制原生线程、聊天/用量、任务、工程身份或历史授权回执。
    for name in ("model_override", "reasoning_effort", "codex_connection_mode", "codex_remote_host",
                 "auto_continue", "skip_permissions", "max_continuations", "constraints", "abilities",
                 "auto_commit", "auto_commit_push", "auto_commit_backend_id",
                 "followup_suggestions_enabled", "followup_suggestions_config"):
        setattr(result, name, copy.deepcopy(getattr(source, name)))
    result.pinned = bool(appearance.get("pinned", source.pinned))
    result.is_private = bool(appearance.get("isPrivate", source.is_private))
    result.sidebar_color = str(appearance.get("sidebarColor", source.sidebar_color))
    result.history_root_id = source.history_root_id or source.id
    result.history_source_id = source.id
    result.history_request_id = request
    return result


class SessionHistoryBridge:
    def _renewal_existing(self, session_id: str, request_id: str) -> Session | None:
        owner = self._current_owner_id()
        sid = renewal_id(owner, session_id, request_id)
        candidate = self._session_store.load(sid)
        if candidate and (candidate.owner_id != owner or candidate.history_source_id != session_id
                          or candidate.history_request_id != request_id):
            raise ValueError("新会话回执不匹配")
        return candidate

    async def _rpc_sessionRenew(self, session_id: str, request_id: str) -> str:
        self._require_session_access(session_id)
        self._require_agent_execution_enabled()
        self._window_guard(session_id)
        sid = renewal_id(self._current_owner_id(), session_id, request_id)
        # 同源提交串行化；响应丢失后相同 requestId 只返回已保存的新 Session。
        locks = self.__dict__.setdefault("_session_renew_locks", {})
        lock = locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            existing = self._renewal_existing(session_id, request_id)
            if existing:
                self._session_store.update_meta(existing)
                await asyncio.to_thread(self._session_store._save_index_sync)
                if existing.id not in self._active_sessions:
                    self._active_sessions[existing.id] = existing
                    self._emit_session_updated({"type": "session_created", "sessionId": existing.id,
                                                "summary": existing.meta_dict()})
                return json.dumps({"status": "succeeded", "session": existing.meta_dict()}, ensure_ascii=False)
            source = self._active_sessions.get(session_id) or self._session_store.load(session_id)
            if not source:
                raise ValueError("原会话不存在")
            if source.session_type != "normal" or source.relation_kind or source.workspace_id:
                return json.dumps({"status": "error", "message": "此入口用于普通对话；LOOP 和协作工作区请使用各自的新建入口。"}, ensure_ascii=False)
            busy = self._session_destroy_busy_reason(session_id)
            if busy or self._has_native_session_activity(session_id):
                return json.dumps({"status": "error", "message": busy or "执行尚未确认结束，请结束后再开启新会话。"}, ensure_ascii=False)
            if not any(item.id == source.backend_id for item in self._backend_configs):
                return json.dumps({"status": "error", "message": "原会话的 Backend 已不可用，请先调整模型设置。"}, ensure_ascii=False)
            candidate = fresh_session(source, sid, request_id, self._session_store.get_meta(session_id) or {})
            # 先完整落盘，再发布/切换。保存排在旧会话尚未完成的普通写入之后。
            await self._session_store.save_confirmed(candidate)
            await asyncio.to_thread(self._session_store._save_index_sync)
            self._active_sessions[candidate.id] = candidate
            self._emit_session_updated({"type": "session_created", "sessionId": candidate.id,
                                        "summary": candidate.meta_dict()})
            return json.dumps({"status": "succeeded", "session": candidate.meta_dict()}, ensure_ascii=False)

    def _rpc_sessionRenewStatus(self, session_id: str, request_id: str) -> str:
        self._require_session_access(session_id)
        existing = self._renewal_existing(session_id, request_id)
        if not existing:
            lock = getattr(self, "_session_renew_locks", {}).get(session_id)
            return json.dumps({"status": "pending" if lock and lock.locked() else "not_found"})
        # 只读核对落盘的索引，不能把半完成写入当成可切换的成功。
        try:
            index = json.loads(self._session_store._index_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            index = []
        indexed = any(row.get("id") == existing.id for row in index)
        lock = getattr(self, "_session_renew_locks", {}).get(session_id)
        return json.dumps({"status": "succeeded" if indexed else "pending" if lock and lock.locked() else "incomplete",
                           **({"session": existing.meta_dict()} if indexed else {})}, ensure_ascii=False)

    def _rpc_sessionHistory(self, session_id: str, offset: int = 0, limit: int = 30) -> str:
        self._require_session_access(session_id)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError("历史分页参数无效")
        current = self._session_store.get_meta(session_id) or {}
        root = current.get("historyRootId") or session_id
        rows = [row for row in self._filter_sessions_for_current_owner(self._session_store.list())
                if row["id"] == root or row.get("historyRootId") == root]
        # 使用创建/换会话时间，回看和重命名不会改变时间轴顺序。
        rows.sort(key=lambda row: (row.get("createdAt", 0), row["id"]), reverse=True)
        end = offset + limit
        return json.dumps({"status": "ok", "items": rows[offset:end],
                           "nextOffset": end if end < len(rows) else None}, ensure_ascii=False)

    def _rpc_sessionNativeLogLocation(self, session_id: str) -> str:
        self._require_session_access(session_id)
        # 只按需返回当前位置，不启动模型、不恢复线程、不读取整份日志。
        meta = self._session_store.get_meta(session_id) or {}
        config = next((item for item in self._backend_configs if item.id == meta.get("backendId")), None)
        if not config or config.type.value != "deepseek-harness":
            return json.dumps({"status": "unsupported"})
        layout = HarnessLayout.for_session(owner=self._current_owner_id(), executor="local",
                                            backend=config.id, session=session_id)
        native_id = meta.get("agentSessionId")
        binding = layout.root / "session.json"
        reject_links(binding)
        if binding.is_file() and binding.stat().st_size <= 8192:
            native_id = json.loads(binding.read_text(encoding="utf-8")).get("nativeId")
        return json.dumps({"status": "ok", "nativeId": native_id,
                           "exists": (layout.home / "sessions").is_dir(),
                           "sessionsPath": str(layout.home / "sessions"), "bindingPath": str(binding),
                           "archivedBindingsPath": str(layout.root / "bindings"),
                           "backendLogPath": str(paths.log_file())}, ensure_ascii=False)
