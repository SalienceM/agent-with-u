"""Opt-in, bounded Session call evidence. Never part of chat/usage push payloads."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any
import uuid

from . import paths

MAX_CHARS = 800_000
MAX_EVENTS = 512
MAX_FILES = 24
MAX_BYTES = 20 * 1024 * 1024
_LOCK = threading.Lock()
_EPOCHS: dict[str, int] = {}
_CURRENT: ContextVar[Any] = ContextVar("awu_call_trace", default=None)
_SECRET_KEY = re.compile(r"(?i)(?:api.?key|authorization|password|passwd|secret|auth.?token|access.?token|refresh.?token|(?:^|[_-])token$|cookie|credential|signature)")
_SECRET_TEXT = re.compile(
    r'''(?i)(["']?(?:api[_-]?key|authorization|password|passwd|secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)'''
)
_DATA = re.compile(r"data:[\w.+/-]+;base64,[A-Za-z0-9+/=\r\n]+", re.I)


def _directory(session_id: str) -> Path:
    # IDs become digests, never filesystem paths supplied by the client.
    return paths.sub("call-traces", hashlib.sha256(session_id.encode()).hexdigest())


def _filename(event_id: str) -> str:
    return hashlib.sha256(event_id.encode()).hexdigest() + ".json"


class CallTrace:
    def __init__(self, session_id: str, event_id: str) -> None:
        self.session_id = session_id
        self.epoch = _EPOCHS.get(session_id, 0)
        self.event_id = event_id
        self.remaining = MAX_CHARS
        self.secrets: set[str] = set()
        self.data: dict = {"version": 1, "eventId": event_id, "startedAt": time.time(),
                           "attempts": [], "truncated": False, "redacted": False}
        self.attempt: dict | None = None
        self.closed = False

    def clean(self, value: Any, depth: int = 0) -> Any:
        if depth > 14 or self.remaining <= 0:
            self.data["truncated"] = True
            return "[截断]"
        if isinstance(value, dict):
            result = {}
            for key, item in list(value.items())[:1000]:
                if self.remaining <= 0:
                    result["[截断]"] = True
                    self.data["truncated"] = True
                    break
                self.remaining -= len(str(key))
                if _SECRET_KEY.search(str(key)) or str(key).lower() in {"base64", "image_url", "data", "headers", "env"}:
                    # data may be structured protocol data, not necessarily binary.
                    if str(key) == "data" and isinstance(item, (dict, list)):
                        result[str(key)] = self.clean(item, depth + 1)
                    else:
                        result[str(key)] = "[已脱敏/二进制省略]"
                        self.data["redacted"] = True
                else:
                    result[str(key)] = self.clean(item, depth + 1)
            if len(value) > 1000:
                self.data["truncated"] = True
            return result
        if isinstance(value, (list, tuple)):
            if len(value) > 1000:
                self.data["truncated"] = True
            result = []
            for item in value[:1000]:
                if self.remaining <= 0:
                    self.data["truncated"] = True
                    result.append("[截断]")
                    break
                result.append(self.clean(item, depth + 1))
            return result
        if value is None or isinstance(value, (bool, int, float)):
            self.remaining -= len(str(value))
            return value
        original = str(value)
        text = original
        for secret in sorted(self.secrets, key=len, reverse=True):
            text = text.replace(secret, "[已脱敏]")
        text = _SECRET_TEXT.sub(lambda match: match[1] + '"[已脱敏]"', text)
        text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [已脱敏]", text)
        text = _DATA.sub("[二进制附件省略]", text)
        if text != original:
            self.data["redacted"] = True
        if len(text) > self.remaining:
            text = text[:self.remaining] + "\n[截断]"
            self.data["truncated"] = True
        self.remaining -= len(text)
        return text

    def add(self, direction: str, scope: str, payload: Any, note: str = "") -> None:
        if self.closed or self.attempt is None:
            return
        entries = self.attempt[direction]
        if len(entries) >= MAX_EVENTS or self.remaining <= 0:
            self.data["truncated"] = True
            return
        entries.append({"scope": scope, "note": note, "body": self.clean(payload)})

    def observe(self, delta: Any) -> None:
        if self.closed or self.attempt is None:
            return
        if self.remaining <= 0:
            self.data["truncated"] = True
            return
        kind = getattr(delta, "type", "")
        if kind in {"text_delta", "thinking"}:
            key = "output" if kind == "text_delta" else "thinking"
            self.attempt[key] += self.clean(getattr(delta, "text", "") or "")
        elif kind in {"tool_start", "tool_result", "error"}:
            self.add("received", "backend-event", {
                "type": kind, "tool": getattr(delta, "tool_call", None),
                "error": getattr(delta, "error", None),
            })


def trace_request(scope: str, payload: Any, note: str = "") -> None:
    trace = _CURRENT.get()
    if trace is not None:
        trace.add("sent", scope, payload, note)


def trace_response(scope: str, payload: Any, note: str = "") -> None:
    trace = _CURRENT.get()
    if trace is not None:
        trace.add("received", scope, payload, note)


async def traced_send(backend: Any, kwargs: dict, trace: CallTrace | None) -> Any:
    if trace is None:
        token = _CURRENT.set(None)
        try:
            return await backend.send_message(**kwargs)
        finally:
            _CURRENT.reset(token)
    trace.closed = False
    config = getattr(backend, "config", None)
    for key, value in vars(config).items() if hasattr(config, "__dict__") else []:
        if _SECRET_KEY.search(key) and isinstance(value, str) and len(value) >= 6:
            trace.secrets.add(value)
        if key == "env" and isinstance(value, dict):
            trace.secrets.update(str(v) for k, v in value.items() if _SECRET_KEY.search(k) and len(str(v)) >= 6)
    if len(trace.data["attempts"]) >= 20:
        trace.data["truncated"] = True
        return await traced_send(backend, kwargs, None)
    trace.attempt = {"sent": [], "received": [], "output": "", "thinking": "", "status": "running"}
    trace.data["attempts"].append(trace.attempt)
    attempt = trace.attempt
    token = _CURRENT.set(trace)
    on_delta = kwargs.get("on_delta")

    def observe(delta: Any) -> None:
        if trace.attempt is attempt:
            trace.observe(delta)
        if on_delta:
            on_delta(delta)

    try:
        backend_type = getattr(config, "type", "")
        backend_type = getattr(backend_type, "value", backend_type)
        instrumented = backend_type in {"qwen-code-cli", "openai-compatible", "anthropic-api"}
        boundary = {
            "backendId": getattr(config, "id", ""),
            "backendType": backend_type,
            "imageCount": len(kwargs.get("images") or []),
            "workingDir": kwargs.get("working_dir"), "nativeSessionId": kwargs.get("agent_session_id"),
            "model": kwargs.get("model") or getattr(config, "model", ""),
        }
        if not instrumented:
            boundary.update(content=kwargs.get("content"), constraints=kwargs.get("constraints"),
                            messages=[{"role": m.role, "content": m.content} for m in kwargs.get("messages", [])])
        trace_request("backend-context" if instrumented else "backend-boundary", boundary,
                      "调用路由信息；发送正文见后续 SDK/HTTP 记录。" if instrumented else
                      "应用交给 Backend 的参数；不是供应商原始 HTTP 报文。CLI 自行加载的系统提示、工具定义和原生历史可能不在此处。")
        result = await backend.send_message(**{**kwargs, "on_delta": observe})
        trace.attempt["status"] = "returned"
        return result
    except BaseException as exc:
        trace.attempt["status"] = "cancelled" if isinstance(exc, asyncio.CancelledError) else "error"
        trace.add("received", "backend-error", {"type": type(exc).__name__})
        raise
    finally:
        _CURRENT.reset(token)
        try:
            await asyncio.to_thread(save_trace, trace)
        except OSError:
            # 证据存储故障不能改变已经完成的模型请求/记账结果。
            pass


def save_trace(trace: CallTrace) -> None:
    trace.closed = True
    trace.data["endedAt"] = time.time()
    for attempt in trace.data["attempts"]:
        capture = attempt.get("modelRequestCapture")
        if capture and capture.get("status") == "pending":
            capture.update(status="unavailable", reason=(
                "观测器已启动，但未捕获模型请求 JSON；可能使用了不支持的传输或未发起模型请求。"
                if capture.get("observerReady") else
                "未收到 CLI 观测器就绪信号；启动器或运行环境可能未传递观测配置。"))
    # 对拼接完成的流式文本再脱敏，避免密钥恰好横跨两个 delta。
    scrubber = CallTrace(trace.session_id, trace.event_id)
    scrubber.secrets = trace.secrets
    scrubber.remaining = MAX_CHARS * 2
    data = scrubber.clean(trace.data)
    data["redacted"] = data.get("redacted", False) or scrubber.data["redacted"]
    data["truncated"] = data.get("truncated", False) or scrubber.data["truncated"]
    directory = _directory(trace.session_id)
    with _LOCK:
        if trace.epoch != _EPOCHS.get(trace.session_id, 0):
            return
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / _filename(trace.event_id)
        temporary = directory / (uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        files = sorted(directory.glob("*.json"), key=lambda file: file.stat().st_mtime, reverse=True)
        size = 0
        for index, file in enumerate(files):
            size += file.stat().st_size
            if index >= MAX_FILES or size > MAX_BYTES:
                file.unlink(missing_ok=True)


def read_trace(session_id: str, event_id: str) -> dict | None:
    file = _directory(session_id) / _filename(event_id)
    with _LOCK:
        if not file.is_file():
            return None
        if file.stat().st_size > MAX_BYTES:
            return None
        return json.loads(file.read_text(encoding="utf-8"))


def clear_traces(session_id: str) -> None:
    directory = _directory(session_id)
    with _LOCK:
        _EPOCHS[session_id] = _EPOCHS.get(session_id, 0) + 1
        if directory.is_dir():
            for file in directory.glob("*.json"):
                file.unlink(missing_ok=True)
