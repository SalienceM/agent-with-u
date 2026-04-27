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
    device_id: str = ""                  # 前端麦克风 deviceId（持久化）

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "language": self.language,
            "localModel": self.local_model,
            "apiBaseUrl": self.api_base_url,
            "apiKey": self.api_key,
            "apiModel": self.api_model,
            "deviceId": self.device_id,
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
            device_id=d.get("deviceId", ""),
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
_local_force_cpu: bool = False  # 一旦 GPU 失败过，后续直接走 CPU


def _get_local_model(model_size: str):
    """懒加载 faster-whisper 模型，缓存复用。GPU 失败过则永久降级 CPU。"""
    global _local_force_cpu
    if model_size in _local_model_cache:
        return _local_model_cache[model_size]
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        raise RuntimeError(
            "本地语音识别需要安装 faster-whisper: pip install faster-whisper"
        )
    if _local_force_cpu:
        device, ctype = "cpu", "int8"
    else:
        device, ctype = "auto", "auto"
    print(f"[STT] 加载本地模型: {model_size} (device={device}) ...",
          file=sys.stderr, flush=True)
    model = WhisperModel(model_size, device=device, compute_type=ctype)
    _local_model_cache[model_size] = model
    print(f"[STT] 模型加载完成: {model_size}", file=sys.stderr, flush=True)
    return model


def _transcribe_with_fallback(audio_path: str, language: str, model_size: str) -> str:
    """转写音频，GPU 出错时自动降级 CPU 并标记后续直接走 CPU。"""
    global _local_force_cpu
    model = _get_local_model(model_size)
    try:
        segments, _ = model.transcribe(
            audio_path, language=language if language else None,
            beam_size=5, vad_filter=True,
        )
        return "".join(seg.text for seg in segments).strip()
    except RuntimeError as e:
        if _local_force_cpu:
            raise
        print(f"[STT] GPU 转写失败 ({e})，降级 CPU 重试", file=sys.stderr, flush=True)
        _local_force_cpu = True
        _local_model_cache.pop(model_size, None)
        model = _get_local_model(model_size)
        segments, _ = model.transcribe(
            audio_path, language=language if language else None,
            beam_size=5, vad_filter=True,
        )
        return "".join(seg.text for seg in segments).strip()


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

def run(device, compute_type):
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    segs, _ = model.transcribe(audio_path, language=language, beam_size=5, vad_filter=True)
    return "".join(s.text for s in segs).strip()

try:
    text = run("auto", "auto")
except Exception:
    text = run("cpu", "int8")
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
                # ★ 非冻结：直接 import，GPU 失败自动降级 CPU
                return _transcribe_with_fallback(tmp_path, language, model_size)
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
    *,
    skip_language: bool = False,
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
        if language and not skip_language:
            data["language"] = language

        print(f"[STT] API 请求: {url}, model={api_model}, lang={language}, size={len(audio_bytes)}",
              file=sys.stderr, flush=True)
        resp = await client.post(url, headers=headers, files=files, data=data)
        if resp.status_code != 200:
            body = resp.text[:500]
            print(f"[STT] API 错误: status={resp.status_code}, body={body}",
                  file=sys.stderr, flush=True)
            raise RuntimeError(
                f"STT API 返回 {resp.status_code}: {body}"
            )
        result = resp.json()
        return result.get("text", "").strip()


# ═══════════════════════════════════════════════════════════════════════════
#  DashScope 转写 (阿里云百炼)
# ═══════════════════════════════════════════════════════════════════════════

_DASHSCOPE_COMPAT_MODELS = {"sensevoice-v1", "paraformer-v2", "paraformer-realtime-v2"}
_DASHSCOPE_ALL_MODELS = _DASHSCOPE_COMPAT_MODELS | {"fun-asr"}


async def transcribe_dashscope(
    audio_bytes: bytes,
    language: str = "zh",
    api_base_url: str = "",
    api_key: str = "",
    api_model: str = "sensevoice-v1",
) -> str:
    """调用阿里云 DashScope 语音识别。

    sensevoice / paraformer 走 OpenAI 兼容接口（短音频直传）；
    fun-asr 等原生模型走 DashScope Python SDK（异步任务模式）。
    打包时需 --hidden-import dashscope --collect-all dashscope。
    """
    if not api_key:
        raise ValueError("DashScope 需要配置 apiKey")

    if api_model in _DASHSCOPE_COMPAT_MODELS:
        host = "https://dashscope.aliyuncs.com"
        if api_base_url:
            from urllib.parse import urlparse
            parsed = urlparse(api_base_url)
            if parsed.scheme and parsed.netloc:
                host = f"{parsed.scheme}://{parsed.netloc}"
        compat_base = f"{host}/compatible-mode/v1"
        print(f"[STT] DashScope compat: model={api_model}, base={compat_base}",
              file=sys.stderr, flush=True)
        # SenseVoice 自动检测语言，不传 language 参数
        skip_lang = api_model == "sensevoice-v1"
        return await transcribe_api(
            audio_bytes, language, compat_base, api_key, api_model,
            skip_language=skip_lang,
        )

    return await _transcribe_dashscope_native(
        audio_bytes, language, api_base_url, api_key, api_model,
    )


async def _transcribe_dashscope_native(
    audio_bytes: bytes,
    language: str,
    api_base_url: str,
    api_key: str,
    api_model: str,
) -> str:
    """通过 DashScope Python SDK 调用 fun-asr 等模型（异步任务模式）。

    流程: SDK 上传文件到 OSS → async_call 提交任务 → wait 轮询结果
    打包: pyinstaller --hidden-import dashscope --collect-all dashscope
    """
    try:
        import dashscope
        from dashscope.audio.asr import Transcription
    except ImportError:
        raise RuntimeError(
            "fun-asr 需要安装 dashscope: pip install dashscope\n"
            "打包时加 --hidden-import dashscope --collect-all dashscope"
        )

    loop = asyncio.get_running_loop()

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    def _run():
        try:
            dashscope.api_key = api_key
            dashscope.base_http_api_url = (
                api_base_url.rstrip('/') if api_base_url
                else 'https://dashscope.aliyuncs.com/api/v1'
            )

            # ① 上传文件：优先用 SDK Uploader，否则用 Files API，
            #    都没有则直接把本地路径传给 async_call（新版 SDK 支持）
            file_ref = None
            _uploader = getattr(dashscope, 'Uploader', None) or getattr(dashscope, 'Upload', None)
            if _uploader is None:
                try:
                    from dashscope.common.upload import Uploader as _uploader
                except ImportError:
                    pass

            if _uploader is not None:
                file_ref = _uploader.upload(file_path=tmp_path, model=api_model)
                print(f"[STT] DashScope Uploader 上传完成: {str(file_ref)[:80]}",
                      file=sys.stderr, flush=True)
            else:
                # 新版 SDK 没有 Uploader — 直接传本地路径，SDK 内部处理
                file_ref = f"file://{tmp_path}"
                print(f"[STT] DashScope: 无 Uploader, 尝试直接传路径",
                      file=sys.stderr, flush=True)

            # ② 提交异步转写任务
            task_resp = Transcription.async_call(
                model=api_model,
                file_urls=[file_ref],
                language_hints=[language] if language else None,
            )

            task_id = (task_resp.output.get('task_id')
                       if hasattr(task_resp, 'output')
                       and isinstance(task_resp.output, dict)
                       else None)
            if not task_id:
                raise RuntimeError(f"DashScope 任务提交失败: {task_resp}")
            print(f"[STT] DashScope task={task_id}",
                  file=sys.stderr, flush=True)

            # ③ 轮询等待结果
            result = Transcription.wait(task=task_id)

            status_code = getattr(result, 'status_code', 0)
            if status_code != 200:
                msg = ''
                if hasattr(result, 'output') and isinstance(result.output, dict):
                    msg = result.output.get('message', '')
                raise RuntimeError(
                    f"DashScope 转写失败 (code={status_code}): {msg}")

            # ④ 解析转写结果
            from urllib import request as _request
            for trans in result.output.get('results', []):
                if trans.get('subtask_status') == 'SUCCEEDED':
                    trans_url = trans.get('transcription_url', '')
                    if not trans_url:
                        continue
                    data = json.loads(
                        _request.urlopen(trans_url).read().decode('utf8'))
                    texts = [t.get('text', '') for t in data.get('transcripts', [])
                             if t.get('text')]
                    if texts:
                        return ''.join(texts).strip()

            raise RuntimeError("DashScope 转写无结果")
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return await loop.run_in_executor(None, _run)


# ═══════════════════════════════════════════════════════════════════════════
#  统一入口
# ═══════════════════════════════════════════════════════════════════════════

def _is_dashscope_config(cfg: SttConfig) -> bool:
    """检测配置是否实际指向 DashScope（即使 mode 设为 api）。"""
    if cfg.api_model in _DASHSCOPE_ALL_MODELS:
        return True
    if cfg.api_base_url and "dashscope" in cfg.api_base_url.lower():
        return True
    return False


async def transcribe(audio_bytes: bytes, config: Optional[SttConfig] = None) -> str:
    """根据配置选择本地 / API / DashScope 转写。"""
    cfg = config or load_stt_config()
    if cfg.mode == "local":
        return await transcribe_local(audio_bytes, cfg.language, cfg.local_model)
    elif cfg.mode == "dashscope" or _is_dashscope_config(cfg):
        if cfg.mode != "dashscope":
            print(f"[STT] 自动检测到 DashScope 配置 (model={cfg.api_model}), 切换到 dashscope 模式",
                  file=sys.stderr, flush=True)
        return await transcribe_dashscope(
            audio_bytes, cfg.language,
            cfg.api_base_url, cfg.api_key, cfg.api_model or "sensevoice-v1",
        )
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
