"""AnthropicAPIBackend — uses anthropic Python SDK."""
import sys, asyncio, json
from typing import Optional, Callable, Awaitable
import httpx
from ..types import ModelBackendConfig, ChatMessage, ImageAttachment, ToolCallInfo, new_id
from .base import ModelBackend, StreamDelta, _exc_msg

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
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kw):
            if not self.is_cancelled(session_id):
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
                _RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0]
                _MAX_RETRIES = len(_RETRY_DELAYS)
                _data_emitted = False
                _last_err: Optional[str] = None

                for _attempt in range(_MAX_RETRIES + 1):
                    if self.is_cancelled(session_id):
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
                                    if self.is_cancelled(session_id):
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
                        if self.is_cancelled(session_id):
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

            if not self.is_cancelled(session_id):
                usage_dict: Optional[dict] = None
                if input_tokens or output_tokens:
                    usage_dict = {
                        "inputTokens": input_tokens,
                        "outputTokens": output_tokens,
                    }
                emit("done", **({"usage": usage_dict} if usage_dict else {}))

            return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                import traceback
                traceback.print_exc()
                emit("error", error=_exc_msg(e))
                emit("done")
            return {}


