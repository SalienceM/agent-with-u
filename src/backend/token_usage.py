"""Session-level token usage ledger shared by chat and LOOP turns."""

from __future__ import annotations

import time
from typing import Any, Optional


LEDGER_VERSION = 1
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
    except (TypeError, ValueError):
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
    if isinstance(raw, dict) and raw.get("version") == LEDGER_VERSION:
        ledger = _normalize_ledger(raw)
        session.token_usage = ledger
        return ledger

    ledger = _empty_ledger()
    session.token_usage = ledger
    for message in getattr(session, "messages", []) or []:
        usage = getattr(message, "usage", None)
        if not isinstance(usage, dict):
            continue
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
    context_tokens = _count(data.get("contextTokens", data.get("lastInputTokens")))
    context_window = _count(data.get("contextWindow", data.get("modelContextWindow")))
    if context_tokens:
        normalized["contextTokens"] = context_tokens
    if context_window:
        normalized["contextWindow"] = context_window
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
    actual = bool(normalized.get("reported")) or any(normalized.get(key, 0) for key in _COUNT_KEYS)
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
    if not actual:
        normalized["inputTokens"] = estimate_tokens(prompt_text)
        normalized["outputTokens"] = estimate_tokens(output_text)
    if audit is not None:
        audit["countedUsage"] = {key: normalized[key] for key in _COUNT_KEYS}
        normalized["qwenAccounting"] = audit
    if context_window and not normalized.get("contextWindow"):
        normalized["contextWindow"] = _count(context_window)
    if (
        normalized.get("contextWindow")
        and not normalized.get("contextTokens")
        and normalized.get("inputTokens")
        and normalized["inputTokens"] <= normalized["contextWindow"]
        and not normalized.get("cumulative")
        and normalized.get("usageSource") != "qwen-fresh-result"
    ):
        # Qwen/OpenAI-compatible usage usually reports the prompt size as inputTokens.
        # It is useful for warning thresholds, but is labelled approximate because
        # multi-call agent turns may aggregate more than one request.
        normalized["contextTokens"] = normalized["inputTokens"]
        normalized["contextApprox"] = True

    event = {
        "id": stable_id,
        "at": float(timestamp or time.time()),
        "source": "loop" if source == "loop" else "chat",
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
        previous = next((
            item for item in reversed(ledger["events"])
            if _count(item.get("contextTokens"))
            and str(item.get("backendId") or "") == event["backendId"]
            and _count(item.get("contextWindow")) == context_limit
        ), None)
        previous_tokens = _count(previous.get("contextTokens")) if previous else 0
        if previous_tokens >= 4096 and context_tokens <= previous_tokens * 0.65:
            event["contextDrop"] = True

    for key in _COUNT_KEYS:
        ledger[key] += _count(event.get(key))
    ledger["actualTurns" if actual else "estimatedTurns"] += 1
    ledger["events"].append(event)
    ledger["events"] = ledger["events"][-MAX_TREND_EVENTS:]

    if event.get("contextCompacted"):
        record_context_event(
            session,
            event_type="provider_compaction",
            event_id=f"compact:{stable_id}",
            label="模型自动压缩上下文",
            timestamp=event["at"],
        )
    return usage_summary(ledger)


def record_context_event(
    session: Any,
    *,
    event_type: str,
    event_id: str,
    label: str,
    timestamp: Optional[float] = None,
    removed: int = 0,
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
    ledger["contextEvents"] = ledger["contextEvents"][-MAX_CONTEXT_EVENTS:]
    return usage_summary(ledger)


def usage_summary(raw: Any) -> dict:
    ledger = _normalize_ledger(raw)
    events = ledger["events"][-24:]
    latest_context = next((
        dict(item) for item in reversed(events)
        if _count(item.get("contextTokens")) and _count(item.get("contextWindow"))
    ), None)
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
    }
