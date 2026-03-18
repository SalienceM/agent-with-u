"""
ModelBackend: Abstract interface for all model backends.
"""
import os
import sys
import asyncio
import json
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


def _exc_msg(e: Exception) -> str:
    """Return a non-empty error message for any exception."""
    msg = str(e).strip()
    return msg if msg else f"{type(e).__name__}"


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


class ClaudeAgentBackend(ModelBackend):
    """
    Uses the official `claude_agent_sdk` Python package (pip install claude-agent-sdk).
    The package bundles the Claude Code CLI internally — no separate CLI installation needed.

    Image support: images are passed natively via the AsyncIterable[dict] form of
    the prompt parameter using Anthropic content blocks (type: image / source: base64).
    """

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

        try:
            from claude_agent_sdk import query as sdk_query, ClaudeAgentOptions
        except ImportError:
            emit("error", error=(
                "claude-agent-sdk 未安装，请运行: pip install claude-agent-sdk"
            ))
            emit("done")
            return {}

        agent_sid = agent_session_id

        print(f"[ClaudeAgent] 收到请求, agent_session_id={agent_session_id!r}",
              file=sys.stderr, flush=True)

        try:
            model = self.get_env("ANTHROPIC_MODEL") or self.config.model
            tools: list[str] = getattr(self.config, "allowed_tools", None) or [
                "Read", "Edit", "Bash", "Glob", "Grep", "Write"
            ]
            cwd = working_dir or getattr(self.config, "working_dir", None) or "."
            if skip_permissions is None:
                skip_permissions = getattr(self.config, "skip_permissions", True)

            # 收集环境变量传给 SDK
            env_dict: dict[str, str] = {}
            for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                        "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"):
                val = self.get_env(key)
                if val:
                    env_dict[key] = val

            # ★ 图片处理：使用 AsyncIterable[dict] 形式的 prompt 原生传递图片
            # SDK 支持通过 yield Anthropic content blocks 的方式直接传递图片
            has_images = bool(images)

            async def _build_prompt():
                if not has_images:
                    yield content
                    return
                import base64 as _b64
                content_blocks: list[dict] = []
                for img in images:  # type: ignore[union-attr]
                    img_b64 = img.base64
                    if not img_b64 and img.file_path and os.path.exists(img.file_path):
                        with open(img.file_path, "rb") as f:
                            img_b64 = _b64.b64encode(f.read()).decode("ascii")
                    if img_b64:
                        content_blocks.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime_type,
                                "data": img_b64,
                            },
                        })
                content_blocks.append({"type": "text", "text": content})
                yield {
                    "type": "user",
                    "message": {"role": "user", "content": content_blocks},
                }

            options_kwargs: dict = dict(
                allowed_tools=tools,
                cwd=cwd,
                env=env_dict,
                permission_mode="bypassPermissions" if skip_permissions else "default",
                include_partial_messages=True,
            )
            if agent_session_id:
                options_kwargs["resume"] = agent_session_id
            if model and model not in ("sonnet", "claude-sonnet", "default"):
                options_kwargs["model"] = model
            cli_path = getattr(self.config, "cli_path", None)
            if cli_path:
                options_kwargs["cli_path"] = cli_path

            options = ClaudeAgentOptions(**options_kwargs)

            print(f"[ClaudeAgent] SDK query: model={model}, resume={agent_session_id!r}, "
                  f"images={len(images or [])}, cwd={cwd}",
                  file=sys.stderr, flush=True)

            _done_emitted = False
            # 无图时直接传字符串，有图时用 async generator 传 content blocks
            # SDK 对 async generator yield str 的处理与直接传 str 行为不一致
            prompt_arg = _build_prompt() if has_images else content
            async for message in sdk_query(prompt=prompt_arg, options=options):
                if self._cancelled:
                    break
                # result 消息已处理完毕，静默耗尽剩余消息避免 anyio cancel scope 错误
                if _done_emitted:
                    continue

                _CLASS_TYPE_MAP = {
                    "SystemMessage": "system",
                    "StreamEvent": "stream_event",
                    "AssistantMessage": "assistant",
                    "TaskStartedMessage": "task_started",
                    "UserMessage": "user",
                    "ResultMessage": "result",
                }
                _class_name = type(message).__name__
                msg_type = getattr(message, "type", None) or _CLASS_TYPE_MAP.get(_class_name, _class_name)

                # ★ StreamEvent: include_partial_messages=True 时的流式增量事件
                if msg_type == "stream_event":
                    evt = getattr(message, "event", {})
                    etype = evt.get("type", "")
                    if etype == "content_block_delta":
                        delta = evt.get("delta", {})
                        dtype = delta.get("type", "")
                        if dtype == "text_delta":
                            emit("text_delta", text=delta.get("text", ""))
                        elif dtype == "thinking_delta":
                            thinking = delta.get("thinking", "")
                            if thinking:
                                emit("thinking", text=thinking)
                        elif dtype == "input_json_delta":
                            partial = delta.get("partial_json", "")
                            if partial:
                                emit("tool_input", tool_call={"inputDelta": partial})
                    elif etype == "content_block_start":
                        block = evt.get("content_block", {})
                        if block.get("type") == "tool_use":
                            emit("tool_start", tool_call={
                                "id": block.get("id", ""),
                                "name": block.get("name", ""),
                                "input": "",
                                "status": "running",
                            })

                elif msg_type == "system":
                    if getattr(message, "subtype", None) == "init":
                        agent_sid = getattr(message, "session_id", agent_sid)
                        print(f"[ClaudeAgent] session_id={agent_sid}",
                              file=sys.stderr, flush=True)

                elif msg_type == "assistant":
                    # include_partial_messages=True 时 assistant 消息是已完成块的汇总
                    # 流式增量已通过 stream_event 处理，此处只处理 thinking/tool_use
                    for block in getattr(message, "content", []):
                        btype = getattr(block, "type", "")
                        if btype == "thinking":
                            # thinking 不走增量，完整输出
                            thinking = getattr(block, "thinking", "")
                            if thinking:
                                emit("thinking", text=thinking)
                        elif btype == "tool_use":
                            tool_input = getattr(block, "input", {})
                            input_str = (
                                json.dumps(tool_input, ensure_ascii=False, indent=2)
                                if tool_input else ""
                            )
                            emit("tool_start", tool_call={
                                "id": getattr(block, "id", ""),
                                "name": getattr(block, "name", ""),
                                "input": input_str,
                                "status": "running",
                            })

                elif msg_type == "user":
                    for block in getattr(message, "content", []):
                        btype = (
                            getattr(block, "type", None)
                            or (block.get("type") if isinstance(block, dict) else None)
                            or ""
                        )
                        if btype == "tool_result":
                            result_content = (
                                getattr(block, "content", None)
                                or (block.get("content") if isinstance(block, dict) else None)
                                or ""
                            )
                            if isinstance(result_content, list):
                                result_content = "\n".join(
                                    (p.get("text", json.dumps(p, ensure_ascii=False))
                                     if isinstance(p, dict) else str(p))
                                    for p in result_content
                                )
                            output_str = str(result_content or "")
                            if len(output_str) > 5000:
                                output_str = output_str[:5000] + "\n... (truncated)"
                            is_error = (
                                getattr(block, "is_error", None)
                                or (block.get("is_error") if isinstance(block, dict) else None)
                                or False
                            )
                            # ★ 兼容多种属性名，确保拿到正确的 tool_use_id
                            tool_id = (
                                getattr(block, "tool_use_id", None)
                                or (block.get("tool_use_id") if isinstance(block, dict) else None)
                                or getattr(block, "tool_call_id", None)
                                or (block.get("tool_call_id") if isinstance(block, dict) else None)
                                or getattr(block, "id", None)
                                or (block.get("id") if isinstance(block, dict) else None)
                                or ""
                            )
                            print(f"[ClaudeAgent] tool_result: id={tool_id!r}, "
                                  f"status={'error' if is_error else 'done'}, len={len(output_str)}",
                                  file=sys.stderr, flush=True)
                            emit("tool_result", tool_call={
                                "id": tool_id,
                                "output": output_str,
                                "status": "error" if is_error else "done",
                            })

                elif msg_type == "result":
                    agent_sid = getattr(message, "session_id", agent_sid)
                    print(f"[ClaudeAgent] session(result): {agent_sid}",
                          file=sys.stderr, flush=True)
                    is_error = getattr(message, "is_error", False)
                    subtype = getattr(message, "subtype", "")
                    if is_error or subtype == "error_during_execution":
                        print(f"[ClaudeAgent] Resume 失败: subtype={subtype}",
                              file=sys.stderr, flush=True)
                        emit("resume_failed")
                    usage_dict: Optional[dict] = None
                    try:
                        usage = getattr(message, "usage", None)
                        if usage:
                            in_tok = getattr(usage, "input_tokens", None)
                            out_tok = getattr(usage, "output_tokens", None)
                            if in_tok is not None or out_tok is not None:
                                usage_dict = {
                                    "inputTokens": in_tok or 0,
                                    "outputTokens": out_tok or 0,
                                }
                    except Exception as ue:
                        print(f"[ClaudeAgent] usage 读取失败: {ue}",
                              file=sys.stderr, flush=True)
                    emit("done", **({"usage": usage_dict} if usage_dict else {}))
                    _done_emitted = True  # 不 break，让生成器自然耗尽以避免 anyio cancel scope 错误

                elif msg_type not in ("task_started",):
                    print(f"[ClaudeAgent] 未处理的消息类型: {msg_type}",
                          file=sys.stderr, flush=True)
            if not _done_emitted:
                emit("done")
            return {"agentSessionId": agent_sid}

        except Exception as e:
            import traceback
            traceback.print_exc()
            emit("error", error=_exc_msg(e))
            emit("done")
            return {"agentSessionId": agent_sid}


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
                if m.role == "system":
                    continue
                if m.images:
                    # 历史消息含图片，重建 multimodal content 块
                    blocks: list[dict] = []
                    for img in m.images:
                        if img.base64:
                            blocks.append({
                                "type": "image_url",
                                "image_url": {"url": f"data:{img.mime_type};base64,{img.base64}"},
                            })
                    blocks.append({"type": "text", "text": m.content})
                    api_messages.append({"role": m.role, "content": blocks})
                else:
                    api_messages.append({"role": m.role, "content": m.content})

            current_content: list[dict] = []
            if images:
                for img in images:
                    if img.base64:
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

            _RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0, 60.0, 60.0]
            _MAX_RETRIES = len(_RETRY_DELAYS)
            data_emitted = False
            last_error: Optional[str] = None

            for attempt in range(_MAX_RETRIES + 1):
                if self._cancelled:
                    break
                if attempt > 0:
                    delay = _RETRY_DELAYS[attempt - 1]
                    print(f"[OpenAI] retry {attempt}/{_MAX_RETRIES} in {delay}s ...",
                          file=sys.stderr, flush=True)
                    await asyncio.sleep(delay)
                try:
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
                            if response.status_code == 429 and attempt < _MAX_RETRIES:
                                last_error = f"API error: 429 (rate limited, retrying {attempt+1}/{_MAX_RETRIES})"
                                print(f"[OpenAI] 429 rate limit, will retry", file=sys.stderr, flush=True)
                                continue
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
                                        data_emitted = True
                                except (json.JSONDecodeError, IndexError):
                                    pass
                    last_error = None
                    break  # success

                except (httpx.ConnectError, httpx.NetworkError,
                        httpx.TimeoutException, httpx.RemoteProtocolError) as e:
                    if data_emitted or attempt >= _MAX_RETRIES:
                        last_error = _exc_msg(e)
                        break
                    last_error = _exc_msg(e)
                    print(f"[OpenAI] network error ({last_error}), will retry",
                          file=sys.stderr, flush=True)

            if last_error and not self._cancelled:
                emit("error", error=last_error)
            emit("done")
            return {}

        except Exception as e:
            if not self._cancelled:
                emit("error", error=_exc_msg(e))
            return {}


# ---------------------------------------------------------------------------
#  Anthropic API Backend (uses anthropic Python SDK, supports images natively)
# ---------------------------------------------------------------------------

class AnthropicAPIBackend(ModelBackend):
    """
    Uses the official `anthropic` Python SDK to call Claude models directly.
    Supports images natively via the Anthropic messages API format.
    No CLI dependency required.
    """

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
            import anthropic as _anthropic
        except ImportError:
            emit("error", error=(
                "anthropic SDK not installed. Run: pip install anthropic"
            ))
            emit("done")
            return {}

        try:
            api_key = (
                self.get_env("ANTHROPIC_API_KEY")
                or self.get_env("ANTHROPIC_AUTH_TOKEN")
                or self.config.api_key
            )
            base_url = (
                self.get_env("ANTHROPIC_BASE_URL")
                or self.config.base_url
            )
            model = (
                self.get_env("ANTHROPIC_MODEL")
                or self.config.model
                or "claude-sonnet-4-6"
            )

            # Build conversation history
            api_messages: list[dict] = []
            for m in messages:
                if m.role == "system":
                    continue
                msg_content: list | str = m.content
                # Re-attach images from history if present
                if m.images:
                    blocks: list[dict] = []
                    for img in m.images:
                        img_b64 = img.base64
                        if not img_b64 and img.file_path:
                            import base64 as _b64
                            with open(img.file_path, "rb") as f:
                                img_b64 = _b64.b64encode(f.read()).decode("ascii")
                        if img_b64:  # skip broken image attachments
                            blocks.append({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": img.mime_type,
                                    "data": img_b64,
                                },
                            })
                    if m.content:  # only add text block if non-empty
                        blocks.append({"type": "text", "text": m.content})
                    if not blocks:
                        continue  # skip message with no valid content
                    msg_content = blocks
                elif not m.content:
                    # Skip empty text messages (e.g. interrupted assistant streams)
                    continue
                api_messages.append({"role": m.role, "content": msg_content})

            # Build current user message (text + optional images)
            current_blocks: list[dict] = []
            if images:
                for img in images:
                    img_b64 = img.base64
                    if not img_b64 and img.file_path:
                        import base64 as _b64
                        with open(img.file_path, "rb") as f:
                            img_b64 = _b64.b64encode(f.read()).decode("ascii")
                    if img_b64:  # skip broken image attachments
                        current_blocks.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime_type,
                                "data": img_b64,
                            },
                        })
            if content:  # only add text block if non-empty
                current_blocks.append({"type": "text", "text": content})
            if not current_blocks:
                current_blocks.append({"type": "text", "text": "(image)"})
            api_messages.append({"role": "user", "content": current_blocks})

            # System prompt
            system_msgs = [m.content for m in messages if m.role == "system"]
            system_str = "\n\n".join(system_msgs) if system_msgs else None

            if api_key:
                api_key = api_key.strip()
            print(f"[AnthropicAPI] model={model}, proxy={bool(base_url)}, "
                  f"images={len(images or [])}, history_len={len(api_messages)-1}, "
                  f"api_key={'set('+str(len(api_key))+'chars, prefix='+repr(api_key[:8])+')' if api_key else 'NONE'}",
                  file=sys.stderr, flush=True)

            input_tokens = 0
            output_tokens = 0

            if base_url:
                # ── 代理模式：httpx 直接调用，完全控制请求头 ──────────────────
                # Anthropic SDK 始终发送 x-api-key；MiniMax 等代理要求 Authorization: Bearer
                req_headers: dict[str, str] = {
                    "Content-Type": "application/json",
                    "anthropic-version": "2023-06-01",
                }
                if api_key:
                    # Send both headers: some proxies (e.g. MiniMax) require both
                    req_headers["Authorization"] = f"Bearer {api_key}"
                    req_headers["x-api-key"] = api_key
                # Merge user-configured extra headers (can override defaults)
                if self.config.extra_headers:
                    req_headers.update(self.config.extra_headers)
                req_body: dict = {
                    "model": model,
                    "max_tokens": 8096,
                    "messages": api_messages,
                    "stream": True,
                }
                if system_str:
                    req_body["system"] = system_str

                url = base_url.rstrip("/") + "/v1/messages"
                _RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0, 60.0, 60.0]
                _MAX_RETRIES = len(_RETRY_DELAYS)
                _data_emitted = False
                _last_err: Optional[str] = None

                for _attempt in range(_MAX_RETRIES + 1):
                    if self._cancelled:
                        break
                    if _attempt > 0:
                        _d = _RETRY_DELAYS[_attempt - 1]
                        print(f"[AnthropicAPI] retry {_attempt}/{_MAX_RETRIES} in {_d}s ...",
                              file=sys.stderr, flush=True)
                        await asyncio.sleep(_d)
                    try:
                        async with httpx.AsyncClient(timeout=120.0) as hclient:
                            async with hclient.stream(
                                "POST", url, headers=req_headers, json=req_body
                            ) as resp:
                                if resp.status_code == 429 and _attempt < _MAX_RETRIES:
                                    _last_err = f"HTTP 429 (rate limited, retrying {_attempt+1}/{_MAX_RETRIES})"
                                    print(f"[AnthropicAPI] 429 rate limit, will retry",
                                          file=sys.stderr, flush=True)
                                    continue
                                if resp.status_code != 200:
                                    body = await resp.aread()
                                    raise Exception(
                                        f"HTTP {resp.status_code}: {body.decode(errors='replace')}"
                                    )
                                async for line in resp.aiter_lines():
                                    if self._cancelled:
                                        break
                                    if not line.startswith("data:"):
                                        continue
                                    data_str = line[5:].strip()
                                    if not data_str or data_str == "[DONE]":
                                        continue
                                    try:
                                        evt = json.loads(data_str)
                                    except json.JSONDecodeError:
                                        continue

                                    etype = evt.get("type", "")
                                    if etype == "content_block_delta":
                                        delta = evt.get("delta", {})
                                        dtype = delta.get("type", "")
                                        if dtype == "text_delta":
                                            emit("text_delta", text=delta.get("text", ""))
                                            _data_emitted = True
                                        elif dtype == "thinking_delta":
                                            emit("thinking", text=delta.get("thinking", ""))
                                        elif dtype == "input_json_delta":
                                            emit("tool_input", tool_call={
                                                "inputDelta": delta.get("partial_json", "")
                                            })
                                    elif etype == "content_block_start":
                                        block = evt.get("content_block", {})
                                        if block.get("type") == "tool_use":
                                            emit("tool_start", tool_call={
                                                "id": block.get("id", ""),
                                                "name": block.get("name", ""),
                                                "input": "",
                                                "status": "running",
                                            })
                                    elif etype == "message_delta":
                                        output_tokens = evt.get("usage", {}).get(
                                            "output_tokens", output_tokens
                                        )
                                    elif etype == "message_start":
                                        input_tokens = (
                                            evt.get("message", {})
                                            .get("usage", {})
                                            .get("input_tokens", input_tokens)
                                        )
                        _last_err = None
                        break  # success

                    except (httpx.ConnectError, httpx.NetworkError,
                            httpx.TimeoutException, httpx.RemoteProtocolError) as _ne:
                        if _data_emitted or _attempt >= _MAX_RETRIES:
                            _last_err = _exc_msg(_ne)
                            break
                        _last_err = _exc_msg(_ne)
                        print(f"[AnthropicAPI] network error ({_last_err}), will retry",
                              file=sys.stderr, flush=True)

                if _last_err:
                    raise Exception(_last_err)
            else:
                # ── 官方 Anthropic：使用 SDK ──────────────────────────────────
                client = _anthropic.AsyncAnthropic(
                    **({"api_key": api_key} if api_key else {})
                )
                async with client.messages.stream(
                    model=model,
                    max_tokens=8096,
                    system=system_str or _anthropic.NOT_GIVEN,
                    messages=api_messages,
                ) as stream:
                    async for event in stream:
                        if self._cancelled:
                            break

                        etype = type(event).__name__

                        if etype == "RawContentBlockDeltaEvent":
                            delta = event.delta
                            dtype = type(delta).__name__
                            if dtype == "TextDelta":
                                emit("text_delta", text=delta.text)
                            elif dtype == "ThinkingDelta":
                                emit("thinking", text=delta.thinking)
                            elif dtype == "InputJSONDelta":
                                emit("tool_input", tool_call={"inputDelta": delta.partial_json})

                        elif etype == "RawContentBlockStartEvent":
                            block = event.content_block
                            btype = type(block).__name__
                            if btype == "ToolUseBlock":
                                emit("tool_start", tool_call={
                                    "id": block.id,
                                    "name": block.name,
                                    "input": "",
                                    "status": "running",
                                })

                        elif etype == "RawMessageDeltaEvent":
                            usage = getattr(event, "usage", None)
                            if usage:
                                output_tokens = getattr(usage, "output_tokens", 0)

                        elif etype == "RawMessageStartEvent":
                            usage = getattr(event.message, "usage", None)
                            if usage:
                                input_tokens = getattr(usage, "input_tokens", 0)

            if not self._cancelled:
                usage_dict: Optional[dict] = None
                if input_tokens or output_tokens:
                    usage_dict = {
                        "inputTokens": input_tokens,
                        "outputTokens": output_tokens,
                    }
                emit("done", **({"usage": usage_dict} if usage_dict else {}))

            return {}

        except Exception as e:
            if not self._cancelled:
                import traceback
                traceback.print_exc()
                emit("error", error=_exc_msg(e))
                emit("done")
            return {}


# ---------------------------------------------------------------------------
#  Factory
# ---------------------------------------------------------------------------

def create_backend(config: ModelBackendConfig) -> ModelBackend:
    if config.type == BackendType.CLAUDE_AGENT_SDK:
        return ClaudeAgentBackend(config)
    elif config.type == BackendType.ANTHROPIC_API:
        return AnthropicAPIBackend(config)
    elif config.type == BackendType.OPENAI_COMPATIBLE:
        return OpenAICompatibleBackend(config)
    else:
        raise ValueError(f"Unknown backend type: {config.type}")