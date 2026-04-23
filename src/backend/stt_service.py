"""
语音转文字服务 — 支持本地 (faster-whisper) 和 API (OpenAI-compatible) 两种模式。
"""
import os
import sys
import json
import asyncio
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional
import base64

import httpx


# ═══════════════════════════════════════════════════════════════════════════
#  配置
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class SttConfig:
    mode: str = "api"                    # "local" | "api"
    language: str = "zh"                 # BCP-47 language code
    local_model: str = "base"            # faster-whisper model: tiny/base/small/medium/large-v3
    api_base_url: str = ""               # OpenAI-compatible base URL
    api_key: str = ""                    # API key
    api_model: str = "whisper-1"         # 模型名

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "language": self.language,
            "localModel": self.local_model,
            "apiBaseUrl": self.api_base_url,
            "apiKey": self.api_key,
            "apiModel": self.api_model,
        }

    @staticmethod
    def from_dict(d: dict) -> "SttConfig":
        return SttConfig(
            mode=d.get("mode", "api"),
            language=d.get("language", "zh"),
            local_model=d.get("localModel", "base"),
            api_base_url=d.get("apiBaseUrl", ""),
            api_key=d.get("apiKey", ""),
            api_model=d.get("apiModel", "whisper-1"),
        )


_CONFIG_DIR = Path.home() / ".agent-with-u"
_CONFIG_FILE = _CONFIG_DIR / "stt_config.json"


def load_stt_config() -> SttConfig:
    if _CONFIG_FILE.exists():
        try:
            with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
                return SttConfig.from_dict(json.load(f))
        except Exception as e:
            print(f"[STT] 配置加载失败: {e}", file=sys.stderr, flush=True)
    return SttConfig()


def save_stt_config(cfg: SttConfig) -> None:
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg.to_dict(), f, ensure_ascii=False, indent=2)


# ═══════════════════════════════════════════════════════════════════════════
#  本地转写 (faster-whisper)
# ═══════════════════════════════════════════════════════════════════════════

_local_model_cache: dict = {}


def _get_local_model(model_size: str):
    """懒加载 faster-whisper 模型，缓存复用。"""
    if model_size in _local_model_cache:
        return _local_model_cache[model_size]
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        raise RuntimeError(
            "本地语音识别需要安装 faster-whisper: pip install faster-whisper"
        )
    print(f"[STT] 加载本地模型: {model_size} ...", file=sys.stderr, flush=True)
    model = WhisperModel(model_size, device="auto", compute_type="auto")
    _local_model_cache[model_size] = model
    print(f"[STT] 模型加载完成: {model_size}", file=sys.stderr, flush=True)
    return model


def _find_system_python() -> Optional[str]:
    """在冻结环境中找到系统 Python（复用 bridge_ws 里的同名函数逻辑）。"""
    import shutil, subprocess as _sp
    if not getattr(sys, 'frozen', False):
        return sys.executable
    for name in ("python3", "python", "py"):
        path = shutil.which(name)
        if path:
            try:
                r = _sp.run([path, "--version"], capture_output=True, text=True, timeout=5)
                if r.returncode == 0:
                    return path
            except Exception:
                continue
    return None


# ★ 冻结环境下通过子进程调用系统 Python 执行 whisper 转写的内联脚本
_SUBPROCESS_SCRIPT = '''
import sys, json
audio_path = sys.argv[1]
language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
model_size = sys.argv[3] if len(sys.argv) > 3 else "base"
from faster_whisper import WhisperModel
model = WhisperModel(model_size, device="auto", compute_type="auto")
segments, _ = model.transcribe(audio_path, language=language, beam_size=5, vad_filter=True)
text = "".join(seg.text for seg in segments).strip()
print(json.dumps({"text": text}))
'''


async def transcribe_local(
    audio_bytes: bytes,
    language: str = "zh",
    model_size: str = "base",
) -> str:
    """用 faster-whisper 本地模型转写音频。冻结环境自动走子进程。"""
    loop = asyncio.get_running_loop()

    # 写临时音频文件
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    is_frozen = getattr(sys, 'frozen', False)

    def _run():
        try:
            if is_frozen:
                # ★ 冻结环境：通过系统 Python 子进程执行
                python = _find_system_python()
                if not python:
                    raise RuntimeError("未找到系统 Python，无法执行本地语音识别")
                import subprocess as _sp
                r = _sp.run(
                    [python, "-c", _SUBPROCESS_SCRIPT, tmp_path, language or "", model_size],
                    capture_output=True, text=True, timeout=120,
                )
                if r.returncode != 0:
                    raise RuntimeError(f"转写进程失败:\n{r.stderr or r.stdout}")
                import json as _json
                result = _json.loads(r.stdout.strip().split('\n')[-1])
                return result.get("text", "")
            else:
                # ★ 非冻结：直接 import 使用
                model = _get_local_model(model_size)
                segments, _ = model.transcribe(
                    tmp_path,
                    language=language if language else None,
                    beam_size=5,
                    vad_filter=True,
                )
                return "".join(seg.text for seg in segments).strip()
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return await loop.run_in_executor(None, _run)


# ═══════════════════════════════════════════════════════════════════════════
#  API 转写 (OpenAI-compatible /v1/audio/transcriptions)
# ═══════════════════════════════════════════════════════════════════════════

async def transcribe_api(
    audio_bytes: bytes,
    language: str = "zh",
    api_base_url: str = "",
    api_key: str = "",
    api_model: str = "whisper-1",
) -> str:
    """调用 OpenAI-compatible Whisper API 转写音频。"""
    if not api_base_url:
        raise ValueError("API 模式需要配置 apiBaseUrl")
    if not api_key:
        raise ValueError("API 模式需要配置 apiKey")

    url = f"{api_base_url.rstrip('/')}/audio/transcriptions"
    headers = {"Authorization": f"Bearer {api_key}"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        files = {"file": ("audio.webm", audio_bytes, "audio/webm")}
        data: dict = {"model": api_model}
        if language:
            data["language"] = language

        print(f"[STT] API 请求: {url}, model={api_model}, lang={language}",
              file=sys.stderr, flush=True)
        resp = await client.post(url, headers=headers, files=files, data=data)
        resp.raise_for_status()
        result = resp.json()
        return result.get("text", "").strip()


# ═══════════════════════════════════════════════════════════════════════════
#  统一入口
# ═══════════════════════════════════════════════════════════════════════════

async def transcribe(audio_bytes: bytes, config: Optional[SttConfig] = None) -> str:
    """根据配置选择本地或 API 转写。"""
    cfg = config or load_stt_config()
    if cfg.mode == "local":
        return await transcribe_local(audio_bytes, cfg.language, cfg.local_model)
    else:
        return await transcribe_api(
            audio_bytes, cfg.language,
            cfg.api_base_url, cfg.api_key, cfg.api_model,
        )


# ═══════════════════════════════════════════════════════════════════════════
#  LLM 润色 / 总结
# ═══════════════════════════════════════════════════════════════════════════

_REFINE_SYSTEM_PROMPT = """你是一个语音转文字后处理助手。用户会给你一段语音识别的原始文本，可能包含：
- 口语化表达、语气词（嗯、啊、那个、就是说）
- 重复和修正（说错后重新说）
- 不完整的句子
- 标点缺失或混乱

请你：
1. 去除语气词和无意义的重复
2. 修正明显的语音识别错误（谐音字）
3. 补全标点符号
4. 保持原意不变，不要添加原文没有的内容
5. 如果是多个零散的想法，整理成结构清晰的段落
6. 直接输出处理后的文本，不要加任何说明"""

async def refine_with_llm(
    text: str,
    api_key: str,
    base_url: str,
    model: str = "claude-sonnet-4-20250514",
) -> str:
    """用 LLM 润色/整理语音转写文本。"""
    if not text.strip():
        return text

    url = f"{base_url.rstrip('/')}/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": 4096,
        "system": _REFINE_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": text}],
    }

    # 尝试 Anthropic Messages API
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            result = resp.json()
            # Anthropic format
            content = result.get("content", [])
            if isinstance(content, list) and content:
                return content[0].get("text", text).strip()
            return text
    except Exception as e1:
        print(f"[STT] Anthropic API 润色失败: {e1}, 尝试 OpenAI 格式",
              file=sys.stderr, flush=True)

    # Fallback: OpenAI-compatible format
    url_oai = f"{base_url.rstrip('/')}/chat/completions"
    headers_oai = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload_oai = {
        "model": model,
        "messages": [
            {"role": "system", "content": _REFINE_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "max_tokens": 4096,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url_oai, headers=headers_oai, json=payload_oai)
            resp.raise_for_status()
            result = resp.json()
            choices = result.get("choices", [])
            if choices:
                return choices[0].get("message", {}).get("content", text).strip()
            return text
    except Exception as e2:
        print(f"[STT] OpenAI 格式润色也失败: {e2}", file=sys.stderr, flush=True)
        raise RuntimeError(f"LLM 润色失败: {e2}")
