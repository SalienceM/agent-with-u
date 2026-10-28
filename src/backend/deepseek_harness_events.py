"""原生事件投影。实时帧不是已提交消息；根/子代理/attempt 分开结算。"""
from __future__ import annotations

import json
from typing import Any, Callable


class HarnessProjection:
    def __init__(self, native: str, generation: str, fingerprint: str, emit: Callable[..., None]) -> None:
        self.native, self.generation, self.fingerprint, self.emit = native, generation, fingerprint, emit
        self.parents: dict[str, str] = {}
        self.parent_tools: dict[str, str] = {}
        self.seen: set[tuple[str, int]] = set()
        self.attempts: dict[str, dict[str, Any]] = {}
        self.current: dict[str, str] = {}
        self.tools: dict[tuple[str, str], dict[str, Any]] = {}
        self.usage_totals = {"inputTokens": 0, "outputTokens": 0, "cachedInputTokens": 0,
                             "reasoningOutputTokens": 0}
        self.usage_count = 0
        self.missing_usage = False
        self.text_chars = 0
        self.last_root_input = 0

    def belongs(self, sid: Any) -> bool:
        visited = set()
        while isinstance(sid, str) and sid not in visited:
            if sid == self.native:
                return True
            visited.add(sid)
            sid = self.parents.get(sid)
        return False

    def observe(self, note: dict) -> None:
        method, body = note["method"], note["payload"]
        if method == "subagent.started":
            parent, child = body.get("parentSessionId"), body.get("childSessionId")
            if not self.belongs(parent) or not isinstance(child, str) or not child or child == self.native:
                raise ValueError("Harness 子代理身份无效")
            if len(self.parents) >= 256:
                raise ValueError("Harness 子代理数量超限")
            if child not in self.parents:
                self.parents[child] = parent
                self.emit("subagent_start", subagent={"taskId": child, "description": "Harness 子代理",
                                                      "status": "running"})
            return
        sid = body.get("sessionId")
        if method == "awu/subagentLink":
            parent, call = body.get("parentSessionId"), body.get("callId")
            if (body.get("generation") != self.generation or body.get("configFingerprint") != self.fingerprint
                    or not self.belongs(parent) or not isinstance(sid, str) or not isinstance(call, str)
                    or (parent, call) not in self.tools):
                raise ValueError("Harness 子代理工具关联无效")
            self.parents[sid] = parent
            self.parent_tools[sid] = self.tool_id(parent, call)
            self.emit("subagent_progress", subagent={"taskId": sid, "status": "running",
                "parentToolUseId": self.parent_tools[sid], "description": "Harness 原生子代理"})
            return
        if method == "subagent.finished":
            sid = body.get("childSessionId")
            if self.belongs(sid):
                status = "completed" if body.get("status") == "ok" else "failed"
                self.emit("subagent_done", subagent={"taskId": sid, "status": status,
                    "parentToolUseId": self.parent_tools.get(sid)})
            return
        if not self.belongs(sid):
            raise ValueError("Harness 收到其他 Session 的事件")
        if method == "awu/assistantStream":
            if body.get("generation") != self.generation or body.get("configFingerprint") != self.fingerprint:
                raise ValueError("Harness 收到旧运行的实时帧")
            self.live(sid, body.get("frame"))
        elif method == "session.event":
            event = body.get("event")
            if (not isinstance(event, dict) or type(event.get("seq")) is not int or event["seq"] < 0
                    or not isinstance(event.get("type"), str)):
                raise ValueError("Harness 已提交事件缺少 seq")
            key = (sid, event["seq"])
            if key in self.seen:
                return
            if len(self.seen) >= 20000:
                raise ValueError("Harness 本轮事件数量超限")
            self.seen.add(key)
            self.committed(sid, event)

    def live(self, sid: str, frame: Any) -> None:
        if (not isinstance(frame, dict) or not isinstance(frame.get("attemptId"), str)
                or type(frame.get("revision")) is not int):
            raise ValueError("Harness 实时帧身份缺失")
        # revision 是每次发布递增，不是 attempt 的固定版本号。
        attempt_id = f"{sid}:{frame['attemptId']}"
        kind = frame.get("type")
        if kind == "start":
            if attempt_id in self.attempts:
                return
            if len(self.attempts) >= 1024:
                raise ValueError("Harness attempt 数量超限")
            self.attempts[attempt_id] = {"index": 0, "revision": frame["revision"], "text": "", "reasoning": ""}
            self.current[sid] = attempt_id
            return
        attempt = self.attempts.get(attempt_id)
        if attempt is None:
            raise ValueError("Harness 实时帧缺少 start")
        if self.current.get(sid) != attempt_id:
            return  # 已知旧 attempt 的迟到帧不能写进新回复。
        if frame["revision"] <= attempt["revision"]:
            return
        attempt["revision"] = frame["revision"]
        index = frame.get("index")
        if type(index) is not int or index < 0:
            raise ValueError("Harness 实时帧 index 无效")
        if kind == "end":
            if index != attempt["index"]:
                raise ValueError("Harness 实时流有缺帧")
            return
        if kind != "chunk":
            raise ValueError("Harness 实时帧类型未知")
        if index < attempt["index"]:
            return
        if index != attempt["index"]:
            raise ValueError("Harness 实时流有缺帧")
        attempt["index"] += 1
        chunk = frame.get("chunk")
        if not isinstance(chunk, dict):
            raise ValueError("Harness chunk 缺失")
        chunk_type = chunk.get("type")
        if chunk_type in {"text-delta", "reasoning-delta"}:
            text = chunk.get("text")
            if not isinstance(text, str):
                raise ValueError("Harness 文本增量无效")
            field = "text" if chunk_type == "text-delta" else "reasoning"
            self.text_chars += len(text)
            attempt[field] += text
            if self.text_chars > 4_000_000:
                raise ValueError("Harness 本轮文本超出限额")
            if sid == self.native:
                self.emit("text_delta" if field == "text" else "thinking", text=text)
            else:
                self.emit("subagent_progress", subagent={"taskId": sid, "status": "running",
                    "parentToolUseId": self.parent_tools.get(sid)})
        elif chunk_type == "tool-call-delta":
            call_id, fragment = chunk.get("id"), chunk.get("argumentsDelta")
            if not isinstance(call_id, str) or not isinstance(fragment, str):
                raise ValueError("Harness 工具增量缺少身份/参数")
            key = (sid, call_id)
            if key not in self.tools and len(self.tools) >= 256:
                raise ValueError("Harness 本轮工具数量超限")
            tool = self.tools.setdefault(key, {"id": self.tool_id(sid, call_id), "input": "", "started": False})
            tool["input"] += fragment
            if len(tool["input"]) > 1024 * 1024:
                raise ValueError("Harness 工具参数超限")
            if isinstance(chunk.get("name"), str):
                tool["name"] = chunk["name"]
            if tool.get("name") and not tool["started"]:
                tool["started"] = True
                self.emit("tool_start", tool_call={"id": tool["id"], "name": tool["name"], "input": tool["input"],
                    "parentToolUseId": self.parent_tools.get(sid)})
            elif tool["started"]:
                self.emit("tool_input", tool_call={"id": tool["id"], "input": fragment,
                    "parentToolUseId": self.parent_tools.get(sid)})
        elif chunk_type not in {"block-start", "block-end", "usage", "finish"}:
            raise ValueError("Harness chunk 类型未知")

    def tool_id(self, sid: str, call_id: str) -> str:
        return call_id if sid == self.native else sid + ":" + call_id

    def committed(self, sid: str, event: dict) -> None:
        data, kind = event.get("data"), event.get("type")
        if not isinstance(data, dict):
            raise ValueError("Harness 事件 data 无效")
        if kind in {"assistant/message", "assistant/attempt"}:
            if kind == "assistant/message":
                message = data.get("message")
                if not isinstance(message, dict) or not isinstance(message.get("content"), list):
                    raise ValueError("Harness assistant/message 缺少内容")
                current = self.attempts.get(self.current.get(sid, ""), {"text": "", "reasoning": ""})
                for block_type, field, delta in (("text", "text", "text_delta"), ("reasoning", "reasoning", "thinking")):
                    text = "".join(block.get("text", "") for block in message["content"]
                                   if isinstance(block, dict) and block.get("type") == block_type)
                    if not text.startswith(current[field]):
                        raise ValueError("Harness 实时与已提交内容不一致")
                    if sid == self.native and text[len(current[field]):]:
                        self.emit(delta, text=text[len(current[field]):])
            self.account(data, sid=sid)
        elif kind == "tool/call":
            if not all(isinstance(data.get(key), str) for key in ("callId", "name", "arguments")):
                raise ValueError("Harness tool/call 缺少字段")
            key = (sid, data["callId"])
            if key not in self.tools and len(self.tools) >= 256:
                raise ValueError("Harness 本轮工具数量超限")
            tool = self.tools.setdefault(key, {"id": self.tool_id(*key), "started": False})
            if not tool["started"]:
                self.emit("tool_start", tool_call={"id": tool["id"], "name": data["name"], "input": data["arguments"],
                    "parentToolUseId": self.parent_tools.get(sid)})
            elif tool.get("input") != data["arguments"]:
                raise ValueError("Harness 工具增量与原生参数不一致")
            tool.update(started=True, name=data["name"], input=data["arguments"])
        elif kind == "tool/result":
            message = data.get("message")
            if not isinstance(message, dict) or not isinstance(message.get("toolCallId"), str):
                raise ValueError("Harness tool/result 缺少 toolCallId")
            key = (sid, message["toolCallId"])
            if key not in self.tools:
                raise ValueError("Harness 工具结果没有对应调用")
            self.emit("tool_result", tool_call={"id": self.tool_id(*key),
                "output": json.dumps(message.get("content", []), ensure_ascii=False),
                "parentToolUseId": self.parent_tools.get(sid),
                "status": "error" if message.get("isError") else "done"})

    def account(self, data: dict, *, sid: str) -> None:
        raw = data.get("usage")
        if raw is None:
            raw = next((item.get("chunk", {}).get("usage") for item in reversed(data.get("stream", []))
                        if item.get("type") == "chunk" and item.get("chunk", {}).get("type") == "usage"), None)
        if not isinstance(raw, dict):
            self.missing_usage = True
            return
        for key in ("inputTokens", "outputTokens"):
            if type(raw.get(key)) is not int or raw[key] < 0:
                raise ValueError("Harness 用量计数无效")
        for key in ("cacheReadTokens", "cacheWriteTokens", "reasoningTokens"):
            if key in raw and (type(raw[key]) is not int or raw[key] < 0):
                raise ValueError("Harness 用量子计数无效")
        aggregate_input = raw["inputTokens"] + raw.get("cacheReadTokens", 0) + raw.get("cacheWriteTokens", 0)
        if (raw.get("reasoningTokens", 0) > raw["outputTokens"]
                or ("totalTokens" in raw and (type(raw["totalTokens"]) is not int
                    or raw["totalTokens"] != aggregate_input + raw["outputTokens"]))):
            raise ValueError("Harness 用量总计与子项不一致")
        self.usage_totals["inputTokens"] += aggregate_input
        self.usage_totals["outputTokens"] += raw["outputTokens"]
        self.usage_totals["cachedInputTokens"] += raw.get("cacheReadTokens", 0)
        self.usage_totals["reasoningOutputTokens"] += raw.get("reasoningTokens", 0)
        self.usage_count += 1
        if sid == self.native:
            self.last_root_input = aggregate_input

    def usage(self) -> dict | None:
        if not self.usage_count or self.missing_usage:
            return None  # 由现有 Bridge 的显式 estimated 路径处理。
        return {**self.usage_totals, "reported": True, "usageSource": "harness-committed-turn",
                "usageEventCount": self.usage_count, "contextTokens": self.last_root_input}
