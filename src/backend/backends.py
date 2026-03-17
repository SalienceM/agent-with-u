"""
ModelBackend: Abstract interface for all model backends.
"""
import os
import sys
import asyncio
import json
import subprocess
from abc import ABC, abstractmethod
from typing import Optional, Callable

import httpx

from ..types import (
    ModelBackendConfig,
    BackendType,
    ChatMessage,
    ImageAttachment,
    ToolCallInfo,
    new_id,
)


class StreamDelta:
    """
    A single streaming event pushed to the frontend.

    ★ delta_type 说明：
      text_delta   - 正文文本增量
      thinking     - 思考内容增量（新增）
      tool_start   - 工具调用开始（含名称、输入）
      tool_input   - 工具输入增量（增量式场景）
      tool_result  - 工具执行结果（含输出、状态）
      done         - 流结束
      error        - 错误
    """
    def __init__(
        self,
        session_id: str,
        message_id: str,
        delta_type: str,
        text: Optional[str] = None,
        tool_call: Optional[dict] = None,
        error: Optional[str] = None,
        usage: Optional[dict] = None,
    ):
        self.session_id = session_id
        self.message_id = message_id
        self.type = delta_type
        self.text = text
        self.tool_call = tool_call
        self.error = error
        self.usage = usage

    def to_dict(self) -> dict:
        d = {
            "sessionId": self.session_id,
            "messageId": self.message_id,
            "type": self.type,
        }
        if self.text is not None:
            d["text"] = self.text
        if self.tool_call is not None:
            d["toolCall"] = self.tool_call
        if self.error is not None:
            d["error"] = self.error
        if self.usage is not None:
            d["usage"] = self.usage
        return d


class ModelBackend(ABC):
    def __init__(self, config: ModelBackendConfig):
        self.config = config
        self._cancelled = False

    @abstractmethod
    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        agent_session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        skip_permissions: Optional[bool] = None,
    ) -> dict:
        ...

    def abort(self):
            self._cancelled = True

    def get_env(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Get environment variable from backend config, with priority order:

        1. Backend config env dict
        2. Process environment variable
        3. Default value
        """
        # First check backend config
        config_value = self.config.get_env(key)
        if config_value is not None:
            return config_value
        # Fallback to process environment
        return os.environ.get(key, default)

    def get_model(self) -> str:
        """Get model name from config or environment."""
        return self.get_env("ANTHROPIC_MODEL") or self.config.model or "default"


# ---------------------------------------------------------------------------
#  Claude Agent Backend
# ---------------------------------------------------------------------------

STREAM_CHUNK_SIZE = 4        # characters per chunk
STREAM_CHUNK_DELAY = 0.015   # seconds between chunks (~266 chars/s)


class SessionInstance:
    """
    Internal class representing a claude CLI instance for one session.
    Manages the agent_session_id for conversation continuity.
    """
    def __init__(
        self,
        session_id: str,
        config: ModelBackendConfig,
        agent_session_id: Optional[str] = None,
    ):
        self.session_id = session_id
        self.config = config
        self.agent_session_id = agent_session_id


class ClaudeAgentBackend(ModelBackend):

    def _get_cli_path(self) -> str:
        """Get the claude CLI executable path.

        On Windows, npm global packages are installed in %APPDATA%\\npm\\
        The claude CLI is typically at %APPDATA%\\npm\\claude.cmd
        """
        cli = getattr(self.config, "cli_path", None)
        if cli and os.path.exists(str(cli)):
            return str(cli)

        if sys.platform == "win32":
            # ★ Fix: Use the actual npm bin directory from PATH or APPDATA
            appdata = os.environ.get("APPDATA", "")
            npm_bin = os.path.join(appdata, "npm")

            # Check for claude.cmd first (Windows batch file)
            for name in ("claude.cmd", "claude.bat", "claude.exe", "claude"):
                p = os.path.join(npm_bin, name)
                if os.path.exists(p):
                    print(f"[ClaudeAgent] Found claude CLI at: {p}",
                          file=sys.stderr, flush=True)
                    return p

            # Also check if 'claude' is in PATH
            import shutil
            claude_in_path = shutil.which("claude")
            if claude_in_path:
                print(f"[ClaudeAgent] Found claude in PATH: {claude_in_path}",
                      file=sys.stderr, flush=True)
                return claude_in_path

            # Return the .cmd path even if it doesn't exist yet (for better error message)
            return os.path.join(npm_bin, "claude.cmd")

        # Unix/macOS
        return "claude"

    # ------------------------------------------------------------------ #

    async def send_message(
            self,
            messages: list[ChatMessage],
            content: str,
            images: Optional[list[ImageAttachment]],
            session_id: str,
            message_id: str,
            on_delta: Callable[[StreamDelta], None],
            agent_session_id: Optional[str] = None,
            working_dir: Optional[str] = None,
            skip_permissions: Optional[bool] = None,
        ) -> dict:
            self._cancelled = False

            def emit(delta_type: str, **kwargs):
                if not self._cancelled:
                    on_delta(StreamDelta(session_id, message_id, delta_type, **kwargs))

            agent_sid = agent_session_id
            cli_path = self._get_cli_path()

            print(f"[ClaudeAgent] 收到请求, agent_session_id={agent_session_id!r}",
                file=sys.stderr, flush=True)

            try:
                # ---------- 构建命令行 ----------
                cmd = [cli_path]

                model = self.get_env("ANTHROPIC_MODEL") or self.config.model
                if model and model not in ("sonnet", "claude-sonnet", "default"):
                    cmd.extend(["--model", model])

                if agent_session_id:
                    cmd.extend(["--resume", agent_session_id])

                cwd = working_dir or getattr(self.config, "working_dir", None) or "."

                tools = getattr(self.config, "allowed_tools", None) or [
                    "Read", "Edit", "Bash", "Glob", "Grep", "Write"
                ]
                for tool in tools:
                    cmd.extend(["--allowedTools", tool])

                cmd.extend([
                    "--output-format", "stream-json",
                    "--verbose",
                ])

                # ★ Use runtime skip_permissions if provided, otherwise fall back to config
                if skip_permissions is None:
                    skip_permissions = getattr(self.config, "skip_permissions", True)
                if skip_permissions:
                    cmd.extend(["--dangerously-skip-permissions"])

                # ★ 处理图片：使用 --input-format stream-json 通过 stdin 传递
                # claude-code 的 stream-json 格式支持图片
                has_images = images is not None and len(images) > 0
                stdin_data = None

                if has_images:
                    # 使用 stdin 方式传递图片和消息
                    cmd.extend(["--input-format", "stream-json"])

                    # 构建 Anthropic API 格式的消息
                    import base64
                    content_blocks = []
                    for img in images:
                        content_blocks.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime_type,
                                "data": img.base64
                            }
                        })
                    content_blocks.append({"type": "text", "text": content})

                    # 构建完整的消息对象 (Anthropic API 格式)
                    stdin_obj = {
                        "type": "user",
                        "content": content_blocks
                    }
                    stdin_data = json.dumps(stdin_obj, ensure_ascii=False)
                else:
                    cmd.extend(["-p", content])

                print(f"[ClaudeAgent] cmd: {' '.join(cmd[:8])}...",
                    file=sys.stderr, flush=True)
                print(f"[ClaudeAgent] cwd: {cwd}", file=sys.stderr, flush=True)

                # ---------- 用线程跑 subprocess ----------
                loop = asyncio.get_event_loop()
                msg_queue: asyncio.Queue = asyncio.Queue()

                # ★ 共享进程引用，让主循环能检测子进程是否存活
                proc_holder: list[Optional[subprocess.Popen]] = [None]

                def _run_subprocess():
                    try:
                        print("[ClaudeAgent] 子进程启动中...",
                            file=sys.stderr, flush=True)

                        # 如果有图片，需要 stdin 管道
                        if has_images:
                            proc = subprocess.Popen(
                                cmd,
                                stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE,
                                cwd=cwd,
                                encoding="utf-8",
                                errors="replace",
                                bufsize=1,
                            )
                        else:
                            proc = subprocess.Popen(
                                cmd,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE,
                                cwd=cwd,
                                encoding="utf-8",
                                errors="replace",
                                bufsize=1,
                            )

                        proc_holder[0] = proc  # 暴露给主循环

                        # 如果有图片数据，写入 stdin
                        if has_images and stdin_data:
                            proc.stdin.write(stdin_data + "\n")
                            proc.stdin.flush()
                            proc.stdin.close()

                        has_output = False
                        line_count = 0

                        while True:
                            raw_line = proc.stdout.readline()
                            if not raw_line:
                                break
                            line = raw_line.strip()
                            if not line:
                                continue
                            has_output = True
                            line_count += 1
                            print(f"[ClaudeAgent] 收到第{line_count}行: {line[:120]}",
                                file=sys.stderr, flush=True)
                            try:
                                obj = json.loads(line)
                                loop.call_soon_threadsafe(
                                    msg_queue.put_nowait, ("json", obj))
                            except json.JSONDecodeError:
                                loop.call_soon_threadsafe(
                                    msg_queue.put_nowait, ("text", line))

                        proc.wait()
                        print(f"[ClaudeAgent] 子进程结束, rc={proc.returncode}, 共{line_count}行",
                            file=sys.stderr, flush=True)

                        stderr_out = proc.stderr.read().strip()
                        if stderr_out:
                            print(f"[ClaudeAgent] stderr: {stderr_out[:500]}",
                                file=sys.stderr, flush=True)

                        if not has_output:
                            loop.call_soon_threadsafe(
                                msg_queue.put_nowait, ("fallback", None))
                        else:
                            loop.call_soon_threadsafe(
                                msg_queue.put_nowait, ("done", None))

                    except Exception as e:
                        print(f"[ClaudeAgent] 子进程异常: {e}",
                            file=sys.stderr, flush=True)
                        loop.call_soon_threadsafe(
                            msg_queue.put_nowait, ("error", str(e)))

                loop.run_in_executor(None, _run_subprocess)

                # ---------- 主循环读队列 ----------
                # ★ 改动：短轮询 + 进程存活检测，替代硬超时
                POLL_INTERVAL = 10          # 每 10 秒检查一次
                MAX_TOTAL_WAIT = 7200       # 安全上限 2 小时
                total_waited = 0

                while True:
                    if self._cancelled:
                        # ★ 取消时杀掉子进程
                        proc = proc_holder[0]
                        if proc and proc.poll() is None:
                            proc.terminate()
                        break

                    try:
                        tag, payload = await asyncio.wait_for(
                            msg_queue.get(), timeout=POLL_INTERVAL)
                    except asyncio.TimeoutError:
                        total_waited += POLL_INTERVAL
                        proc = proc_holder[0]

                        # 子进程还活着 → 继续等
                        if proc and proc.poll() is None:
                            if total_waited % 60 == 0:  # 每分钟打一条日志
                                print(f"[ClaudeAgent] 等待中... 已等 {total_waited}s, "
                                    f"子进程 pid={proc.pid} 仍在运行",
                                    file=sys.stderr, flush=True)
                            if total_waited < MAX_TOTAL_WAIT:
                                continue
                            else:
                                emit("error",
                                    error=f"已等待 {MAX_TOTAL_WAIT//3600} 小时，强制终止")
                                proc.terminate()
                                break

                        # 子进程还没启动 → 再给点时间
                        if proc is None:
                            if total_waited < 60:
                                continue
                            emit("error", error="子进程启动超时")
                            break

                        # 子进程已结束但队列为空 → 可能丢了 done 信号
                        print(f"[ClaudeAgent] 子进程已结束(rc={proc.returncode})，"
                            f"但未收到完成信号",
                            file=sys.stderr, flush=True)
                        break

                    if tag == "done":
                        break
                    elif tag == "error":
                        emit("error", error=str(payload))
                        break
                    elif tag == "fallback":
                        print("[ClaudeAgent] stream-json 无输出，回退到 json 模式",
                            file=sys.stderr, flush=True)
                        agent_sid = await self._fallback_json(
                            cli_path, content, model, agent_session_id,
                            cwd, tools, emit)
                        break
                    elif tag == "text":
                        total_waited = 0  # ★ 收到数据就重置计时
                        emit("text_delta", text=payload + "\n")
                    elif tag == "json":
                        total_waited = 0  # ★ 收到数据就重置计时
                        agent_sid, events = self._process_stream_json(
                            payload, agent_sid)
                        for evt_type, evt_kwargs in events:
                            if self._cancelled:
                                break
                            emit(evt_type, **evt_kwargs)
                            if evt_type == "text_delta":
                                await asyncio.sleep(STREAM_CHUNK_DELAY)

                emit("done")
                return {"agentSessionId": agent_sid}

            except Exception as e:
                import traceback
                traceback.print_exc()
                emit("error", error=str(e))
                return {"agentSessionId": agent_sid}
    # ------------------------------------------------------------------ #

    def _process_stream_json(self, obj: dict, agent_sid) -> tuple:
        """处理 stream-json 单行 JSON，返回 (agent_sid, events_list)

        ★ 支持的 delta 类型：
          text_delta  - 正文文本
          thinking    - 思考内容（可展开查看）
          tool_start  - 工具调用开始（含 id/name/input）
          tool_input  - 工具输入增量
          tool_result - 工具执行结果（含 output/status）
          done        - 含 usage
        """
        events = []
        msg_type = obj.get("type", "")

        # --- system init ---
        if msg_type == "system":
            if obj.get("subtype") == "init":
                agent_sid = obj.get("session_id", agent_sid)
                print(f"[ClaudeAgent] session(init): {agent_sid}",
                      file=sys.stderr, flush=True)

        # --- assistant 完整消息 ---
        elif msg_type == "assistant":
            message = obj.get("message", {})
            for block in message.get("content", []):
                btype = block.get("type", "")

                if btype == "text":
                    text = block.get("text", "")
                    if text:
                        for i in range(0, len(text), STREAM_CHUNK_SIZE):
                            chunk = text[i : i + STREAM_CHUNK_SIZE]
                            events.append(("text_delta", {"text": chunk}))

                # ★ 改动：把 thinking 完整内容传给前端
                elif btype == "thinking":
                    thinking_text = block.get("thinking", "")
                    if thinking_text:
                        events.append(("thinking", {
                            "text": thinking_text,
                        }))

                # ★ 改动：tool_use 带上 id 和完整 input
                elif btype == "tool_use":
                    tool_id = block.get("id", "")
                    tool_name = block.get("name", "unknown")
                    tool_input = block.get("input", {})
                    input_str = ""
                    if tool_input:
                        input_str = json.dumps(
                            tool_input, ensure_ascii=False, indent=2
                        )
                    events.append(("tool_start", {"tool_call": {
                        "id": tool_id,
                        "name": tool_name,
                        "input": input_str,
                        "status": "running",
                    }}))

        # ★ 新增：工具执行结果
        elif msg_type == "tool":
            for block in obj.get("content", []):
                if block.get("type") == "tool_result":
                    tool_use_id = block.get("tool_use_id", "")
                    content = block.get("content", "")
                    # content 可能是字符串或 list
                    if isinstance(content, list):
                        text_parts = []
                        for part in content:
                            if isinstance(part, dict):
                                text_parts.append(
                                    part.get("text", json.dumps(part, ensure_ascii=False))
                                )
                            else:
                                text_parts.append(str(part))
                        content = "\n".join(text_parts)
                    is_error = block.get("is_error", False)
                    # 截断过长输出
                    output_str = str(content)
                    if len(output_str) > 5000:
                        output_str = output_str[:5000] + "\n... (truncated)"
                    print(f"[ClaudeAgent] tool_result: id={tool_use_id}, status={'error' if is_error else 'done'}, output_len={len(output_str)}",
                          file=sys.stderr, flush=True)
                    events.append(("tool_result", {"tool_call": {
                        "id": tool_use_id,
                        "output": output_str,
                        "status": "error" if is_error else "done",
                    }}))

        # --- 流式 delta ---
        elif msg_type == "content_block_delta":
            delta = obj.get("delta", {})

            if delta.get("type") == "text_delta":
                text = delta.get("text", "")
                events.append(("text_delta", {"text": text}))

            # ★ 新增：思考内容增量
            elif delta.get("type") == "thinking_delta":
                thinking = delta.get("thinking", "")
                if thinking:
                    events.append(("thinking", {"text": thinking}))

            # ★ 新增：工具输入增量
            elif delta.get("type") == "input_json_delta":
                partial = delta.get("partial_json", "")
                if partial:
                    events.append(("tool_input", {"tool_call": {
                        "inputDelta": partial,
                    }}))

        # --- tool_use block 开始 ---
        elif msg_type == "content_block_start":
            block = obj.get("content_block", {})
            if block.get("type") == "tool_use":
                tool_id = block.get("id", "")
                tool_name = block.get("name", "")
                print(f"[ClaudeAgent] tool_start: id={tool_id}, name={tool_name}",
                      file=sys.stderr, flush=True)
                events.append(("tool_start", {"tool_call": {
                    "id": tool_id,
                    "name": tool_name,
                    "input": "",
                    "status": "running",
                }}))

        # --- tool_use block 结束 (tool_result) ---
        elif msg_type == "content_block_stop":
            # 工具输入结束（注意：这是输入完成，不是工具执行完成）
            # 真正的工具执行结果在后续的 tool 或 user 类型消息中
            index = obj.get("index", -1)
            print(f"[ClaudeAgent] content_block_stop: index={index}",
                  file=sys.stderr, flush=True)

        # --- result ---
        elif msg_type == "result":
            agent_sid = obj.get("session_id", agent_sid)
            print(f"[ClaudeAgent] session(result): {agent_sid}",
                  file=sys.stderr, flush=True)

            # ★ 检测 resume 失败的情况
            subtype = obj.get("subtype", "")
            is_error = obj.get("is_error", False)
            if is_error or subtype == "error_during_execution":
                print(f"[ClaudeAgent] Resume 失败检测：subtype={subtype}, is_error={is_error}",
                      file=sys.stderr, flush=True)
                # 返回一个特殊的标记，表示 resume 失败
                # 注意：不传 session_id，因为 StreamDelta 已经在构造函数中传入了
                events.append(("resume_failed", {}))

            usage = obj.get("usage", {})
            if usage:
                events.append(("done", {"usage": {
                    "inputTokens": usage.get("input_tokens"),
                    "outputTokens": usage.get("output_tokens"),
                }}))

        # ★ 新增：user 类型消息（工具执行结果回调/用户上下文注入）
        elif msg_type == "user":
            # 这是 Claude Code CLI 在工具执行完成后返回的消息
            # 格式 1: {"type":"user","message":{"content":[{"tool_use_id":"...","type":"tool_result","content":"..."}]}}
            # 格式 2: {"type":"user","parent_tool_use_id":"...","tool_use_result":{...}}
            message = obj.get("message", {})
            parent_tool_id = obj.get("parent_tool_use_id", "")
            tool_result = obj.get("tool_use_result", {})

            # ★ 优先从 message.content 中提取 tool_result（新格式）
            if isinstance(message, dict) and message.get("content"):
                for block in message["content"]:
                    if block.get("type") == "tool_result":
                        tool_use_id = block.get("tool_use_id", "")
                        content = block.get("content", "")
                        print(f"[ClaudeAgent] tool_result (from user.content): id={tool_use_id}, content_len={len(str(content))}",
                              file=sys.stderr, flush=True)
                        # 处理 content 可能是 list 的情况
                        if isinstance(content, list):
                            content = "\n".join(str(p) for p in content)
                        output_str = str(content)
                        if len(output_str) > 5000:
                            output_str = output_str[:5000] + "\n... (truncated)"
                        events.append(("tool_result", {"tool_call": {
                            "id": tool_use_id,
                            "output": output_str,
                            "status": "done",
                        }}))

            # 旧格式：直接从顶层字段获取
            elif tool_result:
                if not parent_tool_id and isinstance(message, str):
                    parent_tool_id = message[:50]  # fallback
                if isinstance(tool_result, str):
                    output_str = tool_result
                else:
                    output_str = str(tool_result.get("content", tool_result))
                if len(output_str) > 5000:
                    output_str = output_str[:5000] + "\n... (truncated)"
                events.append(("tool_result", {"tool_call": {
                    "id": parent_tool_id,
                    "output": output_str,
                    "status": "done",
                }}))

            # 如果有用户消息内容，也作为文本发送
            if isinstance(message, dict) and message.get("content"):
                # 已经处理了 tool_result，跳过
                pass
            elif isinstance(message, str) and message.strip():
                print(f"[ClaudeAgent] user 消息：{message[:100]}",
                      file=sys.stderr, flush=True)
                events.append(("text_delta", {"text": message + "\n"}))

        # ★ 未知类型打日志，方便调试
        else:
            if msg_type:
                print(f"[ClaudeAgent] 未处理的消息类型: {msg_type}, "
                      f"keys={list(obj.keys())}",
                      file=sys.stderr, flush=True)

        return agent_sid, events

    # ------------------------------------------------------------------ #

    async def _fallback_json(self, cli_path, content, model,
                             agent_session_id, cwd, tools, emit) -> str:
        cmd = [cli_path]
        if model and model not in ("sonnet", "claude-sonnet", "default"):
            cmd.extend(["--model", model])
        if agent_session_id:
            cmd.extend(["--resume", agent_session_id])
        for tool in tools:
            cmd.extend(["--allowedTools", tool])
        cmd.extend([
            "--output-format", "json",
            "--dangerously-skip-permissions",
            "-p", content,
        ])

        loop = asyncio.get_event_loop()

        def _run():
            return subprocess.run(
                cmd, capture_output=True, text=True, cwd=cwd,
                encoding="utf-8", errors="replace", timeout=300,
            )

        r = await loop.run_in_executor(None, _run)

        if r.returncode != 0:
            emit("error", error=f"CLI error (rc={r.returncode}): {r.stderr[:500]}")
            return agent_session_id

        try:
            result = json.loads(r.stdout)
            text = result.get("result", "")
            if text:
                for i in range(0, len(text), STREAM_CHUNK_SIZE):
                    chunk = text[i : i + STREAM_CHUNK_SIZE]
                    emit("text_delta", text=chunk)
                    await asyncio.sleep(STREAM_CHUNK_DELAY)

            sid = result.get("session_id", agent_session_id)
            usage = result.get("usage", {})
            if usage:
                emit("done", usage={
                    "inputTokens": usage.get("input_tokens"),
                    "outputTokens": usage.get("output_tokens"),
                })
            return sid

        except json.JSONDecodeError:
            if r.stdout.strip():
                emit("text_delta", text=r.stdout)
            return agent_session_id


# ---------------------------------------------------------------------------
#  OpenAI Compatible Backend (unchanged)
# ---------------------------------------------------------------------------

class OpenAICompatibleBackend(ModelBackend):

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        skip_permissions: Optional[bool] = None,
        **kwargs,
    ) -> dict:
        self._cancelled = False

        def emit(delta_type: str, **kw):
            if not self._cancelled:
                on_delta(StreamDelta(session_id, message_id, delta_type, **kw))

        try:
            api_messages = []
            for m in messages:
                if m.role != "system":
                    api_messages.append({"role": m.role, "content": m.content})

            current_content = []
            if images:
                for img in images:
                    current_content.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{img.mime_type};base64,{img.base64}"
                        },
                    })
            current_content.append({"type": "text", "text": content})
            api_messages.append({"role": "user", "content": current_content})

            base_url = self.config.base_url or "https://api.openai.com/v1"
            headers = {"Content-Type": "application/json"}
            if self.config.api_key:
                headers["Authorization"] = f"Bearer {self.config.api_key}"

            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{base_url}/chat/completions",
                    json={
                        "model": self.config.model or "gpt-4o",
                        "messages": api_messages,
                        "stream": True,
                    },
                    headers=headers,
                ) as response:
                    if response.status_code != 200:
                        emit("error", error=f"API error: {response.status_code}")
                        return {}

                    async for line in response.aiter_lines():
                        if self._cancelled:
                            break
                        line = line.strip()
                        if not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        try:
                            parsed = json.loads(data)
                            delta = (parsed.get("choices", [{}])[0]
                                     .get("delta", {}))
                            if delta.get("content"):
                                emit("text_delta", text=delta["content"])
                        except (json.JSONDecodeError, IndexError):
                            pass

            emit("done")
            return {}

        except Exception as e:
            if not self._cancelled:
                emit("error", error=str(e))
            return {}


# ---------------------------------------------------------------------------
#  Factory
# ---------------------------------------------------------------------------

def create_backend(config: ModelBackendConfig) -> ModelBackend:
    if config.type == BackendType.CLAUDE_AGENT_SDK:
        return ClaudeAgentBackend(config)
    elif config.type in (BackendType.OPENAI_COMPATIBLE, BackendType.ANTHROPIC_API):
        return OpenAICompatibleBackend(config)
    else:
        raise ValueError(f"Unknown backend type: {config.type}")