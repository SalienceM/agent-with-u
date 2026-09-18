"""Bounded, content-free observations of a LOOP model call (not provider guesses)."""
from __future__ import annotations

import asyncio
import copy
import re
import time
from typing import Callable

from .token_usage import estimate_tokens


def error_evidence(error: object) -> dict:
    # 不保存原始异常：SDK 报错可能回显请求、密钥或带认证的 URL。
    text = str(error).lower()
    status = re.search(r"\b([45]\d{2})\b", text)
    category = "unknown"
    if re.search(r"concurren|并发", text):
        category = "concurrency"
    elif (status and status[1] == "429") or re.search(r"rate.?limit|限流|too many requests", text):
        category = "rate_limit"
    elif re.search(r"timeout|timed out|超时", text):
        category = "timeout"
    elif re.search(r"connect|network|protocol|网络|连接", text):
        category = "network"
    elif status and status[1] in ("401", "403"):
        category = "auth"
    elif re.search(r"context.?length|too many tokens|上下文.*超", text):
        category = "context_limit"
    return {"category": category, **({"httpStatus": int(status[1])} if status else {})}


class LoopCallDiagnostics:
    """One mutable record in the loop cache; pushes ≤1/s, no idle polling."""
    def __init__(self, call_id: str, stage: str, prompt: str,
                 publish: Callable[[dict], None], persist: Callable[[], None]) -> None:
        self._publish = publish
        self._persist = persist
        self._timer: asyncio.TimerHandle | None = None
        self._last_push = self._last_save = 0.0
        self._mono = time.monotonic()
        self.closed = False
        self.data: dict = {
            "id": call_id, "stage": stage, "status": "running", "phase": "local_prepare",
            "startedAt": time.time(), "promptChars": len(prompt),
            "estimatedPromptTokens": estimate_tokens(prompt), "imageCount": 0,
            "eventCounts": {}, "textChars": 0, "thinkingChars": 0,
            "transportAttempts": 0, "retryCount": 0, "retryWaitSeconds": 0,
            "timeline": [],
        }

    def mark(self, phase: str, **fields: object) -> None:
        if self.closed:
            return
        self.data.update(fields)
        if self.data["phase"] != phase or not self.data["timeline"]:
            self.data["phase"] = phase
            self.data["timeline"].append({"phase": phase, "at": time.time(),
                "elapsedMs": round((time.monotonic() - self._mono) * 1000),
                **{k: fields[k] for k in ("httpStatus", "attempt", "delaySeconds", "category") if k in fields}})
            self.data["timeline"] = self.data["timeline"][-32:]
        self.changed()

    def changed(self) -> None:
        if self.closed:
            return
        if time.monotonic() - self._last_push >= 1:
            self.flush()
        elif self._timer is None:
            self._timer = asyncio.get_running_loop().call_later(1, self.flush)

    def flush(self) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None
        now = time.monotonic()
        self._last_push = now
        self.data["observedAt"] = time.time()
        self._publish(copy.deepcopy(self.data))
        if self.closed or now - self._last_save >= 10:
            self._last_save = now
            self._persist()

    def observe(self, delta: object) -> None:
        if self.closed:
            return
        kind = getattr(delta, "type", "")
        if kind == "diagnostic":
            meta = getattr(delta, "diagnostic", None) or {}
            phase = meta.get("phase")
            if phase not in ("request", "response_headers", "retry_wait", "runner_start", "runner_ready", "turn_accepted", "backend_error", "sdk_request", "sdk_response"):
                return
            # 白名单仅接受数字和固定分类，不传播任意 Backend 数据。
            fields = {k: v for k, v in meta.items() if k in (
                "httpStatus", "attempt", "maxAttempts", "delaySeconds", "requestBytes"
            ) and isinstance(v, (int, float)) and 0 <= v < 1e12}
            category = meta.get("category")
            if category in ("rate_limit", "network", "timeout", "concurrency", "auth", "context_limit", "unknown"):
                fields["category"] = category
                self.data["lastError"] = {"category": category}
            if fields.get("httpStatus", 0) >= 400:
                self.data["lastError"] = error_evidence(f"HTTP {fields['httpStatus']}")
            if phase == "request":
                self.data["transportAttempts"] += 1
            if phase == "retry_wait":
                self.data["retryCount"] += 1
                self.data["retryWaitSeconds"] += fields.get("delaySeconds", 0)
            if phase == "backend_error":
                self.data["hadError"] = True
            if isinstance(meta.get("model"), str):
                # 模型名是明确的配置字段；不接受任意状态原文或 URL。
                if re.fullmatch(r"[\w./:@+ -]{1,120}", meta["model"]):
                    self.data["model"] = meta["model"]
            self.mark(phase, **fields)
            return
        if kind not in ("text_delta", "thinking", "tool_start", "tool_input", "tool_result",
                         "subagent_start", "subagent_progress", "subagent_done", "error", "done"):
            return
        now = time.time()
        self.data.setdefault("firstEventAt", now)
        self.data["lastActivityAt"] = now
        counts = self.data["eventCounts"]
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "done":
            usage = getattr(delta, "usage", None) or {}
            counters = {k: int(v) for k, v in usage.items()
                if k in ("inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens")
                and isinstance(v, (int, float)) and 0 <= v < 1e15}
            if counters:
                self.data["usage"] = counters
        text = getattr(delta, "text", None) or ""
        if kind == "error":
            self.fail(getattr(delta, "error", ""))
        elif kind == "text_delta" and text:
            self.data.setdefault("firstTextAt", now)
            self.data["textChars"] += len(text)
            self.mark("text")
        elif kind == "thinking" and text:
            self.data["thinkingChars"] += len(text)
            self.mark("thinking")
        elif kind.startswith("tool_") or kind.startswith("subagent_"):
            self.mark("tools")
        self.changed()

    def fail(self, error: object) -> None:
        if not self.closed:
            self.data["hadError"] = True
            self.data["lastError"] = error_evidence(error)
            self.mark("error")

    def finish(self, status: str = "done") -> None:
        if self.closed:
            return
        if status == "done" and self.data.get("hadError"):
            status = "error"
        self.mark(status, status=status, endedAt=time.time(),
                  durationMs=round((time.monotonic() - self._mono) * 1000))
        self.closed = True
        self.flush()
