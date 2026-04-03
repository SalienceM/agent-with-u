"""OpenAICompatibleBackend — generic OpenAI-compatible /chat/completions."""
import sys, asyncio, json
from typing import Optional, Callable, Awaitable
import httpx
from ..types import ModelBackendConfig, ChatMessage, ImageAttachment, new_id
from .base import ModelBackend, StreamDelta, _exc_msg

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
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kw):
            if not self.is_cancelled(session_id):
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

            _RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0]
            _MAX_RETRIES = len(_RETRY_DELAYS)
            data_emitted = False
            last_error: Optional[str] = None

            for attempt in range(_MAX_RETRIES + 1):
                if self.is_cancelled(session_id):
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
                                emit("done")
                                return {}

                            async for line in response.aiter_lines():
                                if self.is_cancelled(session_id):
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

            if last_error and not self.is_cancelled(session_id):
                emit("error", error=last_error)
            emit("done")
            return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                emit("error", error=_exc_msg(e))
            emit("done")
            return {}


