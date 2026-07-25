"""Edge neural text-to-speech helpers."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass


DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
MAX_SPEECH_CHARS = 12_000
_VOICE_RE = re.compile(r"^[A-Za-z]{2,3}-[A-Za-z]{2,8}-[A-Za-z0-9]+Neural$")


@dataclass(frozen=True)
class SpeechResult:
    audio: bytes
    text: str
    voice: str
    rate: int
    truncated: bool = False


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
