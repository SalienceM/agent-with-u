"""Content-free control-handoff contracts and side-effect-free eligibility."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
TERMINAL_STATUSES = frozenset({"succeeded", "failed", "blocked", "interrupted"})
OPERATION_STATUSES = TERMINAL_STATUSES | {"accepted", "running", "unresolved"}
PHASES = frozenset({"validating", "snapshot", "manual_record", "committing", "done", "recovery"})
ID_PATTERN = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
REASONS: dict[str, tuple[str, str]] = {
    "ready": ("可以转交控制权。", "request"),
    "unavailable": ("找不到 LOOP 会话。", "check"),
    "handoff_busy": ("控制权正在转交，结果待确认。", "check"),
    "active_call": ("旧调用或环境检查尚未退出，暂不能转交。", "environment"),
    "engineering_activity": ("文件保存、终端或写入型语言服务尚未确认结束。", "workbench"),
    "idea_unsealed": ("请先封口 loopidea，再开启人工轮。", "ideas"),
    "loop_running": ("LOOP 正在运行，请等待当前轮结束后接管。", "loop"),
    "loop_resumable": ("存在未完成的 LOOP，请先继续完成或处理断点。", "loop"),
    "chat_running": ("回答仍在生成，结束后才能转交控制权。", "chat"),
    "sequence_pending": ("仍有待发送的序列任务，请先查看并处理队列。", "queue"),
    "stale_revision": ("控制权状态已变化，请检查最新状态。", "check"),
    "request_conflict": ("同一请求标识的输入不一致。", "check"),
    "invalid_request": ("转交请求参数无效。", "check"),
    "snapshot_unavailable": ("切换已完成，但文件检查点不可用，不能依赖它恢复。", "none"),
    "worker_unresolved": ("后台工作尚未确认退出，转交结果待确认。", "check"),
    "persistence_failed": ("保存控制权失败，尚未完成切换。", "check"),
    "interrupted": ("转交已中断，未改变控制权。", "request"),
    "mirror_pending": ("切换已完成，界面元数据待同步。", "check"),
}


def revision(value: Any) -> int:
    return value if type(value) is int and 0 <= value <= 2**53 - 1 else 0


@dataclass(frozen=True)
class ControlFacts:
    available: bool = True
    mode: str = "loop"
    stage: str = "loopexecute"
    running: bool = False
    resumable: bool = False
    active_call: bool = False
    engineering_activity: bool = False
    chat_running: bool = False
    manual_has_messages: bool = False
    sequence_pending: bool = False
    reserved: bool = False
    control_revision: int = 0


def eligibility(action: str, facts: ControlFacts) -> dict:
    """检查顺序稳定；空人工轮不被历史队列阻塞，退出未知则始终保护。"""
    reason = "ready"
    if action not in ("takeover", "release"):
        reason = "invalid_request"
    elif not facts.available:
        reason = "unavailable"
    elif facts.reserved:
        reason = "handoff_busy"
    elif facts.active_call:
        reason = "active_call"
    elif facts.engineering_activity:
        reason = "engineering_activity"
    elif action == "takeover" and facts.mode != "manual":
        if facts.stage not in ("loopexecute", "loopout"):
            reason = "idea_unsealed"
        elif facts.running:
            reason = "loop_running"
        elif facts.stage != "loopout" and facts.resumable:
            reason = "loop_resumable"
        elif facts.chat_running:
            reason = "chat_running"
    elif action == "release" and facts.mode == "manual":
        if facts.chat_running:
            reason = "chat_running"
        elif facts.manual_has_messages and facts.sequence_pending:
            reason = "sequence_pending"
    message, next_step = REASONS[reason]
    return {"action": action, "allowed": reason == "ready", "reasonCode": reason,
            "message": message, "nextStep": next_step, "controlRevision": facts.control_revision}


def normalize_operation(value: Any) -> dict:
    """白名单序列化；不保留任意错误文本、目标正文、工具租约或环境内容。"""
    if not isinstance(value, dict):
        return {}
    rid = value.get("requestId")
    if not isinstance(rid, str) or not ID_PATTERN.fullmatch(rid):
        return {}
    if (value.get("action") not in ("takeover", "release")
            or not isinstance(value.get('status'), str) or value['status'] not in OPERATION_STATUSES):
        return {}
    result = {"requestId": rid, "action": value["action"], "status": value["status"]}
    for key in ("sourceMode", "targetMode"):
        result[key] = "manual" if value.get(key) == "manual" else "loop"
    result["phase"] = value.get("phase") if isinstance(value.get('phase'), str) and value['phase'] in PHASES else "recovery"
    for key in ("revision", "sourceControlRevision", "controlRevision"):
        result[key] = revision(value.get(key))
    for key in ("startedAt", "updatedAt"):
        raw = value.get(key)
        result[key] = float(raw) if type(raw) in (int, float) and math.isfinite(raw) and raw >= 0 else 0.0
    result["committed"] = value.get("committed") is True
    result["checkpointAvailable"] = value.get("checkpointAvailable") if type(value.get("checkpointAvailable")) is bool else None
    reason = value.get("reasonCode")
    result["reasonCode"] = reason if isinstance(reason, str) and reason in REASONS else "worker_unresolved"
    result["message"], result["nextStep"] = REASONS[result["reasonCode"]]
    # 摘要用于同 ID/不同输入校验；不保存原始输入或调用方权限。
    for key in ("inputDigest", "identityDigest"):
        raw = value.get(key)
        if isinstance(raw, str) and re.fullmatch(r"[0-9a-f]{64}", raw):
            result[key] = raw
    return result


def normalize_receipts(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    items = [normalize_operation(item) for item in value[-64:]]
    seen: set[str] = set()
    kept = []
    for item in reversed(items):
        if item and item["status"] in TERMINAL_STATUSES and item["requestId"] not in seen:
            seen.add(item["requestId"])
            kept.append(item)
            if len(kept) == 8:
                break
    return list(reversed(kept))


def operation_public(value: Any) -> dict:
    return {k: v for k, v in normalize_operation(value).items()
            if k not in ("inputDigest", "identityDigest")}
