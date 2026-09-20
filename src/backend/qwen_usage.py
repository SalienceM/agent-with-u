"""Qwen result usage is a native-session total, not necessarily a turn delta."""
from __future__ import annotations

from typing import Any

_FIELDS = {"inputTokens": "input_tokens", "outputTokens": "output_tokens",
           "cachedInputTokens": "cache_read_input_tokens"}


def counts(raw: Any) -> dict | None:
    if not isinstance(raw, dict) or not any(key in raw for key in _FIELDS.values()):
        return None
    result = {}
    for target, source in _FIELDS.items():
        value = raw.get(source, 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
            return None
        try:
            result[target] = int(value)
        except (ValueError, OverflowError):
            return None
    return result


class QwenTurnUsage:
    def __init__(self) -> None:
        self.seen: set[str] = set()
        self.totals = dict.fromkeys(_FIELDS, 0)
        self.requests = 0
        self.zero_usage_events = 0
        self.last_input = 0
        self.missing = False

    def observe(self, message: dict) -> None:
        body = message.get("message") or {}
        identity = str(message.get("uuid") or body.get("id") or "")
        if identity and identity in self.seen:
            return
        value = counts(body.get("usage"))
        if value is None:
            self.missing = True
            return
        if identity:
            self.seen.add(identity)
        self.requests += 1
        if not any(value.values()):
            self.zero_usage_events += 1
        for key in self.totals:
            self.totals[key] += value[key]
        if not message.get("parent_tool_use_id") and value["inputTokens"]:
            self.last_input = value["inputTokens"]

    def finish(self, raw: Any, native_id: str | None, resumed: bool) -> dict | None:
        cumulative = counts(raw)
        provider = {key: value for key, value in (raw or {}).items()
                    if key in {"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "total_tokens"}
                    and isinstance(value, (int, float)) and not isinstance(value, bool)} if isinstance(raw, dict) else {}
        # 优先采用本次 query 的 completed assistant usage，不会因 resume 重放旧账；
        # 不把 stream_event 的重复 usage 再累加。CLI 内部辅助调用可能没有 assistant 事件。
        if self.requests and not self.missing and (any(self.totals.values()) or not cumulative or not any(cumulative.values())):
            result = {**self.totals, "reported": True, "usageSource": "qwen-assistant-turn",
                      "usageEventCount": self.requests, "zeroUsageEventCount": self.zero_usage_events,
                      "contextTokens": self.last_input,
                      "providerUsage": provider, "nativeResumed": resumed}
            if cumulative is not None and native_id:
                result.update(providerCumulative=cumulative, contextId=native_id)
            return result
        if cumulative is None:
            return None
        if not resumed:
            return {**cumulative, "reported": True, "usageSource": "qwen-fresh-result",
                    "providerCumulative": cumulative, "contextId": native_id or "", "providerUsage": provider}
        # 老 SDK 只有终结累计值时，交给持久账本按原生线程差分。
        # 升级后首笔缺少旧基线不能把所有历史算作本轮，必须明确降级。
        return {**cumulative, "reported": True, "cumulative": True,
                "baselineRequired": True, "contextId": native_id or "",
                "usageSource": "qwen-cumulative-result", "providerUsage": provider}
