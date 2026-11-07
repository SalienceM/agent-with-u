"""Provider usage contracts: request snapshots are not deltas or turn totals."""
from __future__ import annotations

from typing import Any

COUNT_KEYS = ("inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens")


def stream_usage_unsupported(body: Any) -> bool:
    """Only explicit parameter rejection permits retry without usage (never a streamed request)."""
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return False
    text = str(error.get("message") or "").lower()[:4096]
    parameter = str(error.get("param") or "").lower()
    named = parameter in {"stream_options", "stream_options.include_usage"} or "stream_options" in text
    rejected = str(error.get("code") or "") in {"unsupported_parameter", "unknown_parameter"} or any(
        phrase in text for phrase in ("not supported", "unsupported", "unrecognized", "unknown parameter", "unexpected keyword"))
    return named and rejected


def usage_dict(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if hasattr(raw, "model_dump"):
        return raw.model_dump(exclude_none=True)
    return {key: getattr(raw, key) for key in (
        "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"
    ) if getattr(raw, key, None) is not None}


def _number(raw: dict, key: str) -> int:
    value = raw.get(key, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("Invalid provider token count")
    return value


def anthropic_counts(raw: Any) -> dict | None:
    data = usage_dict(raw)
    if not any(key in data for key in ("input_tokens", "output_tokens")):
        return None
    try:
        cached = _number(data, "cache_read_input_tokens")
        return {"inputTokens": _number(data, "input_tokens") + cached + _number(data, "cache_creation_input_tokens"),
                "outputTokens": _number(data, "output_tokens"), "cachedInputTokens": cached,
                "reasoningOutputTokens": 0}
    except ValueError:
        return None


def openai_counts(raw: Any) -> dict | None:
    if not isinstance(raw, dict) or "prompt_tokens" not in raw or "completion_tokens" not in raw:
        return None
    try:
        return {"inputTokens": _number(raw, "prompt_tokens"), "outputTokens": _number(raw, "completion_tokens"),
                "cachedInputTokens": _number(raw.get("prompt_tokens_details") or {}, "cached_tokens"),
                "reasoningOutputTokens": _number(raw.get("completion_tokens_details") or {}, "reasoning_tokens")}
    except (ValueError, AttributeError):
        return None


class RequestUsage:
    """Latest snapshot per actual request; sum requests only once, retain missing coverage."""
    def __init__(self, provider: str) -> None:
        self.provider = provider
        self.requests: list[dict] = []

    def start(self) -> None:
        self.requests.append({})

    def observe(self, raw: Any) -> None:
        if self.requests:
            # Anthropic message_delta is a partial cumulative snapshot, not an increment.
            self.requests[-1].update(usage_dict(raw))

    def finish(self) -> dict | None:
        if not self.requests:
            return None
        parse = openai_counts if self.provider == "openai" else anthropic_counts
        values = [parse(raw) for raw in self.requests]
        if not any(value is not None for value in values):
            return None
        result = {key: sum((value or {}).get(key, 0) for value in values) for key in COUNT_KEYS}
        result.update(reported=True, usageSource=f"{self.provider}-requests", requestCount=len(values))
        if values[-1] is not None and ("prompt_tokens" if self.provider == "openai" else "input_tokens") in self.requests[-1]:
            result["contextTokens"] = values[-1]["inputTokens"]
        required = ("prompt_tokens", "completion_tokens") if self.provider == "openai" else ("input_tokens", "output_tokens")
        if any(value is None or not all(key in raw for key in required) for raw, value in zip(self.requests, values)):
            result["usageWarning"] = "部分请求未上报用量；本轮仅累计已知计数，不代表完整消耗。"
        return result


class ClaudeTurnUsage:
    """Result usage is turn-wide; completed root assistant usage is last-request context."""
    def __init__(self) -> None:
        self.last_input: int | None = None
        self.last_model = ""

    def observe(self, raw: Any, *, parent: Any = None, model: str = "") -> None:
        if parent:
            return
        data = usage_dict(raw)
        value = anthropic_counts(data)
        if value is None or "input_tokens" not in data:
            self.last_input = None
            self.last_model = ""
            return
        # Zero-token thinking blocks are not proof that the native context is empty.
        if value is not None and "input_tokens" in data and value["inputTokens"]:
            self.last_input = value["inputTokens"]
            self.last_model = model

    def finish(self, raw: Any, model_usage: Any = None, native_id: str = "") -> dict | None:
        value = anthropic_counts(raw)
        if value is None:
            return None
        result = {**value, "reported": True, "usageSource": "claude-turn-result", "contextId": native_id or ""}
        if self.last_input is not None:
            result["contextTokens"] = self.last_input
        models = model_usage if isinstance(model_usage, dict) else {}
        model = models.get(self.last_model, {}) if self.last_model else {}
        window = model.get("contextWindow") if isinstance(model, dict) else None
        if isinstance(window, int) and not isinstance(window, bool) and window > 0:
            result.update(contextWindow=window, contextWindowSource="provider")
        return result
