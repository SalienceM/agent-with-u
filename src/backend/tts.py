"""Text-to-speech helpers used by ordinary and real-time voice playback."""

from __future__ import annotations

import asyncio
import html
import io
import json
import re
import threading
import wave
from dataclasses import dataclass
from typing import Callable


DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
DASHSCOPE_DEFAULT_MODEL = "cosyvoice-v1"
DASHSCOPE_DEFAULT_VOICE = "longxiaochun"
DASHSCOPE_SAMPLE_RATE = 24_000
MAX_SPEECH_CHARS = 12_000
_VOICE_RE = re.compile(r"^[A-Za-z]{2,3}-[A-Za-z]{2,8}-[A-Za-z0-9]+Neural$")
_DASHSCOPE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_DASHSCOPE_SDK_LOCK = threading.Lock()


@dataclass(frozen=True)
class SpeechResult:
    audio: bytes
    text: str
    voice: str
    rate: int
    truncated: bool = False
    mime: str = "audio/mpeg"
    sample_rate: int = 0
    model: str = ""


def markdown_to_speech_text(value: str) -> str:
    """Turn a rendered assistant answer into text that sounds natural aloud."""
    text = str(value or "").replace("\r\n", "\n")
    text = re.sub(
        r"```[\s\S]*?```",
        "\n代码块已省略。\n",
        text,
    )
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", lambda m: m.group(1) or "图片", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"<https?://[^>]+>", "", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"(?m)^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s*", "", text)
    text = re.sub(r"`([^`\n]+)`", r"\1", text)
    text = re.sub(r"(\*\*|__|~~)(.*?)\1", r"\2", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_voice(value: str) -> str:
    voice = str(value or "").strip() or DEFAULT_VOICE
    if not _VOICE_RE.fullmatch(voice):
        raise ValueError("无效的语音名称")
    return voice


def normalize_rate(value: int | float | str) -> int:
    try:
        rate = int(float(value))
    except (TypeError, ValueError):
        rate = 0
    return max(-50, min(50, rate))


def normalize_dashscope_model(value: str) -> str:
    model = str(value or "").strip() or DASHSCOPE_DEFAULT_MODEL
    if not _DASHSCOPE_NAME_RE.fullmatch(model):
        raise ValueError("无效的 DashScope TTS 模型名称")
    return model


def normalize_dashscope_voice(value: str) -> str:
    voice = str(value or "").strip() or DASHSCOPE_DEFAULT_VOICE
    if not _DASHSCOPE_NAME_RE.fullmatch(voice):
        raise ValueError("无效的 DashScope TTS 音色名称")
    return voice


def dashscope_speech_rate(value: int | float | str) -> float:
    """Map the shared -50..+50 percent slider to DashScope's 0.5..1.5 rate."""
    return 1.0 + normalize_rate(value) / 100.0


def format_dashscope_tts_error(
    value,
    *,
    model: str = "",
    voice: str = "",
) -> str:
    """Turn the SDK's JSON task-failed frame into an actionable safe message."""
    payload = value
    if isinstance(value, str):
        try:
            payload = json.loads(value)
        except (TypeError, ValueError):
            payload = None
    header = payload.get("header", {}) if isinstance(payload, dict) else {}
    code = str(header.get("error_code") or "").strip()
    message = str(header.get("error_message") or "").strip()
    request_id = str(header.get("task_id") or "").strip()
    if not message:
        message = str(value or "DashScope TTS 任务失败").strip()

    prefix = "DashScope TTS 失败"
    if code:
        prefix += f" [{code}]"
    detail = f"{prefix}: {message}"
    lowered = f"{code} {message}".lower()
    if "engine return error code: 418" in lowered:
        combo = ""
        if model or voice:
            combo = f"（当前 {model or '默认模型'} + {voice or '默认音色'}）"
        detail += (
            f"。模型与音色组合在当前账号/地域不可用{combo}；"
            "longxiaochun 可先改用已验证的 cosyvoice-v1，其他模型请配套填写其支持音色"
        )
    elif "throttling" in lowered or "rate limit" in lowered:
        detail += "。请求过于频繁，请稍后重试"
    if request_id:
        detail += f"（request_id: {request_id}）"
    return detail


def pcm16_mono_to_wav(pcm: bytes, sample_rate: int = DASHSCOPE_SAMPLE_RATE) -> bytes:
    """Wrap little-endian signed 16-bit mono PCM so browsers can preview it."""
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return output.getvalue()


def _build_dashscope_synthesizer(
    *,
    api_key: str,
    workspace_id: str,
    api_base_url: str,
    model: str,
    voice: str,
    rate: int | float | str,
    callback=None,
):
    """Construct an SDK synthesizer while containing its process-global API key."""
    try:
        import dashscope
        from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer
    except ImportError as exc:
        raise RuntimeError(
            "DashScope 实时 TTS 需要 dashscope>=1.26.3，请执行 pip install -U dashscope"
        ) from exc

    from .stt_service import _dashscope_inference_url

    resolved_key = str(api_key or "").strip()
    if not resolved_key:
        raise ValueError("请先在设置 → 语音识别中配置 DashScope API Key")
    resolved_model = normalize_dashscope_model(model)
    resolved_voice = normalize_dashscope_voice(voice)

    # DashScope SDK still reads ``dashscope.api_key`` in the constructor. Keep
    # that global mutation inside a short lock and restore the previous value;
    # the constructed Request retains its own key afterwards.
    with _DASHSCOPE_SDK_LOCK:
        previous_key = getattr(dashscope, "api_key", None)
        dashscope.api_key = resolved_key
        try:
            synthesizer = SpeechSynthesizer(
                model=resolved_model,
                voice=resolved_voice,
                format=AudioFormat.PCM_24000HZ_MONO_16BIT,
                speech_rate=dashscope_speech_rate(rate),
                callback=callback,
                workspace=str(workspace_id or "").strip() or None,
                url=_dashscope_inference_url(api_base_url),
            )
        finally:
            dashscope.api_key = previous_key
    return synthesizer


class DashScopeRealtimeStream:
    """One run-task/continue-task/finish-task lifecycle on the executor.

    The DashScope SDK owns a WebSocket worker thread. Public methods are async
    wrappers around its blocking lifecycle methods; binary audio is forwarded
    immediately from that worker through ``on_audio``.
    """

    def __init__(
        self,
        *,
        api_key: str,
        workspace_id: str = "",
        api_base_url: str = "",
        model: str = DASHSCOPE_DEFAULT_MODEL,
        voice: str = DASHSCOPE_DEFAULT_VOICE,
        rate: int | float | str = 0,
        on_audio: Callable[[bytes], None],
        on_error: Callable[[str], None],
    ) -> None:
        try:
            from dashscope.audio.tts_v2 import ResultCallback
        except ImportError as exc:
            raise RuntimeError(
                "DashScope 实时 TTS 需要 dashscope>=1.26.3，请执行 pip install -U dashscope"
            ) from exc

        owner = self

        class _Callback(ResultCallback):
            def on_data(self, data: bytes) -> None:
                if data and not owner.cancelled:
                    on_audio(bytes(data))

            def on_error(self, message) -> None:
                owner._set_error(format_dashscope_tts_error(
                    message,
                    model=owner.model,
                    voice=owner.voice,
                ))
                if not owner.cancelled:
                    on_error(owner.error or "DashScope TTS 任务失败")

        self.model = normalize_dashscope_model(model)
        self.voice = normalize_dashscope_voice(voice)
        self.rate = normalize_rate(rate)
        self.sample_rate = DASHSCOPE_SAMPLE_RATE
        self.cancelled = False
        self.error = ""
        self._state_lock = threading.Lock()
        self._synthesizer = _build_dashscope_synthesizer(
            api_key=api_key,
            workspace_id=workspace_id,
            api_base_url=api_base_url,
            model=self.model,
            voice=self.voice,
            rate=self.rate,
            callback=_Callback(),
        )

    def _set_error(self, message: str) -> None:
        with self._state_lock:
            if not self.error:
                self.error = str(message or "DashScope TTS 任务失败")

    def _append_sync(self, text: str) -> None:
        if self.cancelled:
            return
        self._synthesizer.streaming_call(text)
        if self.error:
            raise RuntimeError(self.error)

    async def append(self, text: str) -> None:
        normalized = markdown_to_speech_text(text)
        if not normalized:
            raise ValueError("实时语音片段不能为空")
        await asyncio.to_thread(self._append_sync, normalized)

    def _finish_sync(self) -> None:
        if self.cancelled:
            return
        self._synthesizer.streaming_complete(120_000)
        if self.error:
            raise RuntimeError(self.error)

    async def finish(self) -> None:
        await asyncio.to_thread(self._finish_sync)

    def _cancel_sync(self) -> None:
        synthesizer = self._synthesizer
        try:
            if getattr(synthesizer, "_is_started", False):
                synthesizer.streaming_cancel()
                return
        except Exception:
            pass

        # Cancellation may race the first run-task handshake. Close the socket
        # and release the SDK's wait events so the worker thread cannot linger
        # for its full startup/finish timeout.
        try:
            stopped = getattr(synthesizer, "_stopped", None)
            if stopped is not None:
                stopped.set()
            start_event = getattr(synthesizer, "start_event", None)
            if start_event is not None:
                start_event.set()
            complete_event = getattr(synthesizer, "complete_event", None)
            if complete_event is not None:
                complete_event.set()
        except Exception:
            pass
        try:
            ws = getattr(synthesizer, "ws", None)
            if ws is not None:
                ws.close()
        except Exception:
            pass

    async def cancel(self) -> None:
        self.cancelled = True
        await asyncio.to_thread(self._cancel_sync)


def create_dashscope_realtime_stream(**kwargs) -> DashScopeRealtimeStream:
    """Small factory kept patchable for bridge-level lifecycle tests."""
    return DashScopeRealtimeStream(**kwargs)


async def synthesize_dashscope(
    value: str,
    *,
    api_key: str,
    workspace_id: str = "",
    api_base_url: str = "",
    model: str = DASHSCOPE_DEFAULT_MODEL,
    voice: str = DASHSCOPE_DEFAULT_VOICE,
    rate: int | float | str = 0,
) -> SpeechResult:
    """Generate a complete WAV preview through DashScope's inference endpoint."""
    text = markdown_to_speech_text(value)
    if not text:
        raise ValueError("没有可朗读的正文")
    truncated = len(text) > MAX_SPEECH_CHARS
    if truncated:
        text = text[:MAX_SPEECH_CHARS].rstrip() + "。内容较长，后续部分已省略。"

    resolved_model = normalize_dashscope_model(model)
    resolved_voice = normalize_dashscope_voice(voice)
    resolved_rate = normalize_rate(rate)
    try:
        from dashscope.audio.tts_v2 import ResultCallback
    except ImportError as exc:
        raise RuntimeError(
            "DashScope 实时 TTS 需要 dashscope>=1.26.3，请执行 pip install -U dashscope"
        ) from exc

    class _PreviewCallback(ResultCallback):
        def __init__(self) -> None:
            self.audio: list[bytes] = []
            self.error = ""

        def on_data(self, data: bytes) -> None:
            if data:
                self.audio.append(bytes(data))

        def on_error(self, message) -> None:
            self.error = format_dashscope_tts_error(
                message,
                model=resolved_model,
                voice=resolved_voice,
            )

    callback = _PreviewCallback()
    synthesizer = _build_dashscope_synthesizer(
        api_key=api_key,
        workspace_id=workspace_id,
        api_base_url=api_base_url,
        model=resolved_model,
        voice=resolved_voice,
        rate=resolved_rate,
        callback=callback,
    )

    def _run_preview() -> bytes:
        # ``SpeechSynthesizer.call`` unconditionally enables SSML in SDK 1.26.x
        # and also hides task-failed details behind an empty byte result. Use
        # the same plain-text streaming lifecycle as realtime playback instead.
        synthesizer.streaming_call(text)
        synthesizer.streaming_complete(120_000)
        response = (
            synthesizer.get_response()
            if callable(getattr(synthesizer, "get_response", None))
            else getattr(synthesizer, "last_response", None)
        )
        header = response.get("header", {}) if isinstance(response, dict) else {}
        if callback.error:
            raise RuntimeError(callback.error)
        if str(header.get("event") or "").lower() == "task-failed":
            raise RuntimeError(format_dashscope_tts_error(
                response,
                model=resolved_model,
                voice=resolved_voice,
            ))
        return b"".join(callback.audio)

    pcm = await asyncio.to_thread(_run_preview)
    if not pcm:
        raise RuntimeError(
            f"DashScope TTS 已完成但未返回音频（{resolved_model} + {resolved_voice}）"
        )
    return SpeechResult(
        audio=pcm16_mono_to_wav(bytes(pcm)),
        text=text,
        voice=resolved_voice,
        rate=resolved_rate,
        truncated=truncated,
        mime="audio/wav",
        sample_rate=DASHSCOPE_SAMPLE_RATE,
        model=resolved_model,
    )


async def synthesize(
    value: str,
    voice: str = DEFAULT_VOICE,
    rate: int | float | str = 0,
) -> SpeechResult:
    """Generate MP3 bytes through Edge neural voices."""
    text = markdown_to_speech_text(value)
    if not text:
        raise ValueError("没有可朗读的正文")

    truncated = len(text) > MAX_SPEECH_CHARS
    if truncated:
        text = text[:MAX_SPEECH_CHARS].rstrip() + "。内容较长，后续部分已省略。"

    resolved_voice = normalize_voice(voice)
    resolved_rate = normalize_rate(rate)
    rate_arg = f"{resolved_rate:+d}%"

    try:
        import edge_tts
    except ImportError as exc:
        raise RuntimeError("缺少 edge-tts，请执行 pip install edge-tts") from exc

    chunks: list[bytes] = []
    communicate = edge_tts.Communicate(
        text=text,
        voice=resolved_voice,
        rate=rate_arg,
    )
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            chunks.append(chunk["data"])

    audio = b"".join(chunks)
    if not audio:
        raise RuntimeError("Edge TTS 未返回音频，请检查执行节点的网络连接")
    return SpeechResult(
        audio=audio,
        text=text,
        voice=resolved_voice,
        rate=resolved_rate,
        truncated=truncated,
    )
