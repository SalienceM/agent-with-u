"""Session-level token usage ledger shared by chat and LOOP turns."""

from __future__ import annotations

import time
from typing import Any, Optional


LEDGER_VERSION = 2
MAX_TREND_EVENTS = 80
MAX_CONTEXT_EVENTS = 30
_COUNT_KEYS = (
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningOutputTokens",
)


def _count(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def estimate_tokens(text: str) -> int:
    """Return a rough multilingual estimate; callers must label it estimated."""
    value = str(text or "")
    if not value:
        return 0
    cjk = sum(1 for char in value if "\u3400" <= char <= "\u9fff")
    other = max(0, len(value) - cjk)
    return max(1, round(cjk / 1.5 + other / 4))


def _empty_ledger() -> dict:
    return {
        "version": LEDGER_VERSION,
        "inputTokens": 0,
        "outputTokens": 0,
        "cachedInputTokens": 0,
        "reasoningOutputTokens": 0,
        "actualTurns": 0,
        "estimatedTurns": 0,
        "contextEventCount": 0,
        "cumulativeBaselines": {},
        "events": [],
        "contextEvents": [],
        "latestContexts": {},
        "contextScope": "chat",
        "legacyHistory": False,
    }


def _normalize_ledger(raw: Any) -> dict:
    source = raw if isinstance(raw, dict) else {}
    ledger = _empty_ledger()
    for key in _COUNT_KEYS:
        ledger[key] = _count(source.get(key))
    ledger["actualTurns"] = _count(source.get("actualTurns"))
    ledger["estimatedTurns"] = _count(source.get("estimatedTurns"))
    ledger["contextEventCount"] = _count(source.get("contextEventCount"))
    ledger["captureEnabled"] = source.get("captureEnabled") is True
    ledger["legacyHistory"] = source.get("legacyHistory") is True or (
        source.get("version") == 1 and bool(source.get("actualTurns") or source.get("estimatedTurns")
                                           or source.get("events") or any(ledger[key] for key in _COUNT_KEYS)))
    ledger["contextScope"] = source.get("contextScope", "chat")
    ledger["contextIdentity"] = source.get("contextIdentity")
    ledger["latestContexts"] = dict(source.get("latestContexts") or {}) if source.get("version") == LEDGER_VERSION else {}
    ledger["cumulativeBaselines"] = {
        str(key): dict(value) for key, value in (source.get("cumulativeBaselines") or {}).items()
        if isinstance(value, dict)
    }
    ledger["events"] = [
        dict(item) for item in (source.get("events") or [])[-MAX_TREND_EVENTS:]
        if isinstance(item, dict)
    ]
    ledger["contextEvents"] = [
        dict(item) for item in (source.get("contextEvents") or [])[-MAX_CONTEXT_EVENTS:]
        if isinstance(item, dict)
    ]
    return ledger


def ensure_session_ledger(session: Any) -> dict:
    """Return a normalized ledger, bootstrapping legacy message usage once."""
    raw = getattr(session, "token_usage", None)
    if isinstance(raw, dict) and raw.get("version") in (1, LEDGER_VERSION):
        ledger = _normalize_ledger(raw)
        identity = [getattr(session, key, None) or "" for key in ("backend_id", "model_override", "agent_session_id")]
        if ledger.get("contextIdentity") != identity:
            ledger["latestContexts"] = {}
        ledger["contextIdentity"] = identity
        ledger["contextScope"] = "loop" if getattr(session, "session_type", "normal") == "loop" else "chat"
        session.token_usage = ledger
        return ledger

    ledger = _empty_ledger()
    ledger["contextIdentity"] = [getattr(session, key, None) or "" for key in ("backend_id", "model_override", "agent_session_id")]
    ledger["contextScope"] = "loop" if getattr(session, "session_type", "normal") == "loop" else "chat"
    session.token_usage = ledger
    for message in getattr(session, "messages", []) or []:
        usage = getattr(message, "usage", None)
        if not isinstance(usage, dict):
            continue
        if usage.get("usageScope") != "turn":
            session.token_usage["legacyHistory"] = True
        record_session_usage(
            session,
            usage=usage,
            event_id=f"chat:{getattr(message, 'id', '')}",
            source="chat",
            stage="reply",
            backend_id=getattr(message, "backend_id", None),
            timestamp=getattr(message, "timestamp", None),
        )
    return session.token_usage


def _normalized_usage(usage: Optional[dict]) -> dict:
    data = usage if isinstance(usage, dict) else {}
    normalized = {key: _count(data.get(key)) for key in _COUNT_KEYS}
    context_tokens = data.get("contextTokens", data.get("lastInputTokens"))
    context_window = data.get("contextWindow", data.get("modelContextWindow"))
    if type(context_tokens) is int and context_tokens >= 0:
        normalized["contextTokens"] = context_tokens
    if type(context_window) is int and context_window > 0:
        normalized["contextWindow"] = context_window
        normalized["contextWindowSource"] = data.get("contextWindowSource") or "provider"
    if data.get("contextId") is not None:
        normalized["contextId"] = str(data["contextId"])[:200]
    for key in ("usageWarning", "usageScope"):
        if data.get(key):
            normalized[key] = str(data[key])[:300]
    if data.get("contextCompacted"):
        normalized["contextCompacted"] = True
    if data.get("cumulative"):
        normalized["cumulative"] = True
        normalized["contextId"] = str(data.get("contextId") or "")[:200]
    for key in ("reported", "baselineRequired", "nativeResumed"):
        if data.get(key) is True:
            normalized[key] = True
    if data.get("usageSource"):
        normalized["usageSource"] = str(data["usageSource"])[:80]
    if data.get("requestCount"):
        normalized["requestCount"] = _count(data["requestCount"])
    for key in ("usageEventCount", "zeroUsageEventCount"):
        if key in data:
            normalized[key] = _count(data[key])
    if isinstance(data.get("providerUsage"), dict):
        normalized["providerUsage"] = {key: _count(value) for key, value in data["providerUsage"].items()
                                       if key in {"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "total_tokens"}}
    if isinstance(data.get("providerCumulative"), dict):
        normalized["providerCumulative"] = {key: _count(data["providerCumulative"].get(key)) for key in _COUNT_KEYS}
        normalized["contextId"] = str(data.get("contextId") or "")[:200]
    return normalized


def _qwen_accounting(usage: dict, previous: Optional[dict]) -> dict:
    """保留可复算的证据；累计差分不证明差额属于本次主回复。"""
    after = usage.get("providerCumulative") or {key: _count(usage.get(key)) for key in _COUNT_KEYS}
    fresh = usage.get("usageSource") == "qwen-fresh-result" or (
        usage.get("usageSource") == "qwen-assistant-turn" and not usage.get("nativeResumed"))
    before = {key: 0 for key in _COUNT_KEYS} if fresh else (
        {key: _count(previous.get(key)) for key in _COUNT_KEYS} if previous is not None else None)
    delta = {key: after[key] - before[key] for key in _COUNT_KEYS} if before is not None else None
    reply = ({key: _count(usage.get(key)) for key in _COUNT_KEYS}
             if usage.get("usageSource") == "qwen-assistant-turn" else None)
    remainder = {key: delta[key] - reply[key] for key in _COUNT_KEYS} if delta is not None and reply is not None else None
    status = "missing-baseline" if before is None else "result-only" if reply is None else "matched"
    if delta is not None and any(value < 0 for value in delta.values()):
        status = "counter-reset"
    elif remainder is not None:
        if any(value < 0 for value in remainder.values()):
            status = "inconsistent"
        elif any(remainder.values()):
            status = "unattributed"
    return {"version": 2, "status": status, "replyUsage": reply,
            "cumulativeBefore": before, "cumulativeAfter": after, "cumulativeDelta": delta,
            "unattributedDelta": remainder,
            "baselineKind": "fresh-zero" if fresh else "recorded" if previous is not None else "unknown",
            "baselineEventId": str((previous or {}).get("eventId") or "") if not fresh else "",
            "usageEventCount": _count(usage.get("usageEventCount")),
            "zeroUsageEventCount": _count(usage.get("zeroUsageEventCount"))}


def record_session_usage(
    session: Any,
    *,
    usage: Optional[dict],
    event_id: str,
    source: str,
    stage: str,
    backend_id: Optional[str] = None,
    model: Optional[str] = None,
    seq: Optional[int] = None,
    timestamp: Optional[float] = None,
    prompt_text: str = "",
    output_text: str = "",
    context_window: Optional[int] = None,
) -> dict:
    """Append one model-call event and return the compact public summary."""
    ledger = ensure_session_ledger(session)
    stable_id = str(event_id or "").strip()
    if stable_id and any(str(item.get("id") or "") == stable_id for item in ledger["events"]):
        return usage_summary(ledger)

    normalized = _normalized_usage(usage)
    actual = not (usage or {}).get("estimated") and (
        bool(normalized.get("reported")) or any(normalized.get(key, 0) for key in _COUNT_KEYS))
    audit = None
    is_qwen = str(normalized.get("usageSource", "")).startswith("qwen-")
    if is_qwen and (normalized.get("providerCumulative") is not None or normalized.get("cumulative")):
        key = f"{backend_id or ''}:{normalized.get('contextId') or 'default'}"
        audit = _qwen_accounting(normalized, ledger["cumulativeBaselines"].get(key))
    provider_totals: Optional[dict] = None
    if normalized.get("cumulative"):
        baseline_key = f"{backend_id or ''}:{normalized.get('contextId') or 'default'}"
        previous = ledger["cumulativeBaselines"].get(baseline_key) or {}
        provider_totals = {key: _count(normalized.get(key)) for key in _COUNT_KEYS}
        if previous:
            for key in _COUNT_KEYS:
                # 同线程计数器重置时从新零点算起；相同累计值仍是实报 0，不能估算补账。
                normalized[key] = (provider_totals[key] - _count(previous.get(key))
                                   if provider_totals[key] >= _count(previous.get(key)) else provider_totals[key])
        elif normalized.get("baselineRequired"):
            actual = False
            normalized.update({key: 0 for key in _COUNT_KEYS})
            normalized["usageWarning"] = "缺少原生线程历史基线；本笔用文本估算，未将历史累计重复入账。"
        ledger["cumulativeBaselines"].pop(baseline_key, None)
        ledger["cumulativeBaselines"][baseline_key] = {**provider_totals, "eventId": stable_id}
    elif normalized.get("providerCumulative") is not None and normalized.get("contextId"):
        baseline_key = f"{backend_id or ''}:{normalized['contextId']}"
        totals = normalized["providerCumulative"]
        # 主账只计本轮直接上报的回复用量。差分及无法归因的部分保留在独立审计中，
        # 不能把“不小于回复用量”当作“已证实属于此轮的辅助请求”。
        ledger["cumulativeBaselines"].pop(baseline_key, None)
        ledger["cumulativeBaselines"][baseline_key] = {**totals, "eventId": stable_id}
    ledger["cumulativeBaselines"] = dict(list(ledger["cumulativeBaselines"].items())[-256:])
    if not actual and not (usage or {}).get("estimated"):
        normalized["inputTokens"] = estimate_tokens(prompt_text)
        normalized["outputTokens"] = estimate_tokens(output_text)
    if audit is not None:
        audit["countedUsage"] = {key: normalized[key] for key in _COUNT_KEYS}
        normalized["qwenAccounting"] = audit
    if context_window and not normalized.get("contextWindow"):
        normalized["contextWindow"] = _count(context_window)
        normalized["contextWindowSource"] = "configured"
    # 整轮可能有多次请求，累计输入绝不能充当最后一次请求的上下文。

    event = {
        "id": stable_id,
        "at": float(timestamp or time.time()),
        "source": source if source in {"loop", "followup", "review"} else "chat",
        "stage": str(stage or "reply")[:80],
        "backendId": str(backend_id or ""),
        "model": str(model or "")[:160],
        "estimated": not actual,
        **normalized,
    }
    if provider_totals is not None:
        event["providerCumulative"] = provider_totals
    if seq is not None:
        event["seq"] = _count(seq)

    context_tokens = _count(event.get("contextTokens"))
    context_limit = _count(event.get("contextWindow"))
    if context_tokens and context_limit:
        previous = ledger["latestContexts"].get(event["source"])
        if previous and any(previous.get(key) != event.get(key) for key in ("backendId", "model", "contextId", "contextWindow")):
            previous = None
        previous_tokens = _count(previous.get("contextTokens")) if previous else 0
        if previous_tokens >= 4096 and context_tokens <= previous_tokens * 0.65:
            event["contextDrop"] = True

    for key in _COUNT_KEYS:
        ledger[key] += _count(event.get(key))
    ledger["actualTurns" if actual else "estimatedTurns"] += 1
    ledger["events"].append(event)
    ledger["events"] = ledger["events"][-MAX_TREND_EVENTS:]
    # 包括零值/未知值：不得回头捞旧线程、旧模型或辅助调用的上下文。
    ledger["latestContexts"][event["source"]] = dict(event) if "contextTokens" in event else None
    if source == "chat" and (
        (getattr(session, "backend_id", None) and backend_id != session.backend_id)
        or (getattr(session, "model_override", None) and model != session.model_override)
        or (getattr(session, "agent_session_id", None) and event.get("contextId")
            and event["contextId"] != session.agent_session_id)
    ):
        ledger["latestContexts"]["chat"] = None

    if event.get("contextCompacted"):
        record_context_event(
            session,
            event_type="provider_compaction",
            event_id=f"compact:{stable_id}",
            label="模型自动压缩上下文",
            timestamp=event["at"],
            source=event["source"],
        )
    return usage_summary(session.token_usage)


def record_context_event(
    session: Any,
    *,
    event_type: str,
    event_id: str,
    label: str,
    timestamp: Optional[float] = None,
    removed: int = 0,
    source: Optional[str] = None,
) -> dict:
    ledger = ensure_session_ledger(session)
    stable_id = str(event_id or "").strip()
    if stable_id and any(str(item.get("id") or "") == stable_id for item in ledger["contextEvents"]):
        return usage_summary(ledger)
    ledger["contextEvents"].append({
        "id": stable_id,
        "at": float(timestamp or time.time()),
        "type": str(event_type or "context_change")[:80],
        "label": str(label or "上下文发生变化")[:200],
        "removed": _count(removed),
    })
    ledger["contextEventCount"] += 1
    if source in {"chat", "loop"}:
        ledger["latestContexts"][source] = None
    else:
        ledger["latestContexts"] = {}
    ledger["contextEvents"] = ledger["contextEvents"][-MAX_CONTEXT_EVENTS:]
    return usage_summary(ledger)


def usage_summary(raw: Any) -> dict:
    ledger = _normalize_ledger(raw)
    events = ledger["events"][-24:]
    latest_context = ledger["latestContexts"].get(ledger["contextScope"])
    total_turns = ledger["actualTurns"] + ledger["estimatedTurns"]
    return {
        "inputTokens": ledger["inputTokens"],
        "outputTokens": ledger["outputTokens"],
        "cachedInputTokens": ledger["cachedInputTokens"],
        "reasoningOutputTokens": ledger["reasoningOutputTokens"],
        "totalTokens": ledger["inputTokens"] + ledger["outputTokens"],
        "actualTurns": ledger["actualTurns"],
        "estimatedTurns": ledger["estimatedTurns"],
        "turnCount": total_turns,
        "coverage": (ledger["actualTurns"] / total_turns) if total_turns else 0,
        "events": [dict(item) for item in events],
        "contextEvents": [dict(item) for item in ledger["contextEvents"][-12:]],
        "contextEventCount": ledger["contextEventCount"],
        "latestContext": latest_context,
        "captureEnabled": ledger.get("captureEnabled", False),
        "legacyHistory": ledger["legacyHistory"],
    }


def turn_usage_from_summary(summary: dict, event_id: str) -> Optional[dict]:
    """消息脚注保存入账后的本轮值，原生累计值仅保留为审计证据。"""
    event = next((item for item in summary.get("events", []) if item.get("id") == event_id), None)
    if event is None:
        return None
    return {**{key: value for key, value in event.items()
               if key not in {"cumulative", "baselineRequired", "id", "at", "source", "stage", "seq"}},
            "usageScope": "turn"}


def merge_call_usage(totals: dict, metadata: dict, incoming: Optional[dict]) -> None:
    """合并同轮续跑；累计快照替换，普通请求求和，最后一次未知上下文覆盖旧值。"""
    for key in ("contextTokens", "contextWindow", "contextWindowSource"):
        metadata.pop(key, None)
    if not incoming:
        metadata["usageWarning"] = "部分调用未上报用量；本轮已知计数可能不完整。"
        return
    cumulative = bool(incoming.get("cumulative"))
    previous_cumulative = bool(metadata.get("cumulative"))
    same_context = incoming.get("contextId") == metadata.get("contextId")
    had_usage = metadata.get("_hasUsage", False)
    if had_usage and (cumulative != previous_cumulative or (cumulative and not same_context)):
        # 不能把不同原生线程的累计快照相减，也不能把累计值和本轮值相加。
        metadata["_mixedCumulative"] = True
    for key in _COUNT_KEYS:
        value = _count(incoming.get(key))
        totals[key] = value if cumulative else totals[key] + value
    for key in ("contextTokens", "contextWindow", "contextWindowSource", "contextCompacted", "usageWarning",
                "cumulative", "contextId", "reported", "baselineRequired", "providerCumulative", "providerUsage",
                "usageSource", "nativeResumed"):
        if key in incoming:
            if key in {"baselineRequired", "nativeResumed"} and had_usage and same_context and key in metadata:
                continue  # 首次为新线程的续跑仍从零开始，不能误变成“接管旧线程”。
            metadata[key] = incoming[key]
        elif key in {"cumulative", "baselineRequired", "providerCumulative", "providerUsage", "contextId", "nativeResumed"}:
            metadata.pop(key, None)
    for key in ("usageEventCount", "zeroUsageEventCount", "requestCount"):
        if key in incoming:
            metadata[key] = _count(metadata.get(key)) + _count(incoming[key])
    metadata["_hasUsage"] = True


def finish_call_usage(totals: dict, metadata: dict) -> Optional[dict]:
    if not any(totals.values()) and not metadata.get("reported"):
        return None
    result = {**totals, **{key: value for key, value in metadata.items() if not key.startswith("_")}}
    if metadata.get("_mixedCumulative"):
        checkpoint = dict(totals) if metadata.get("cumulative") else metadata.get("providerCumulative")
        result.update({key: 0 for key in _COUNT_KEYS})
        result.update(reported=False, cumulative=False, usageSource="mixed-cumulative-fallback",
                      usageWarning="同轮调用切换了累计计数身份/口径，无法可靠差分；本轮使用文本估算，未累加历史快照。")
        if checkpoint:
            result["providerCumulative"] = checkpoint
    return result
