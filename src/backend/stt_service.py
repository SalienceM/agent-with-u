"""
语音转文字服务 — 支持本地 (faster-whisper) 和 API (OpenAI-compatible) 两种模式。
"""
import os
import sys
import json
import asyncio
import io
import tempfile
import wave
from dataclasses import dataclass
from typing import Optional
import base64
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from uuid import uuid4

import httpx

from . import paths


# ═══════════════════════════════════════════════════════════════════════════
#  配置
# ═══════════════════════════════════════════════════════════════════════════

_DASHSCOPE_COMPAT_MODELS = {"sensevoice-v1", "paraformer-v2", "paraformer-realtime-v2"}
_FUN_ASR_REALTIME_DEFAULT = "fun-asr-realtime-2026-02-28"
_FUN_ASR_FLASH_DEFAULT = "fun-asr-flash-2026-06-15"
_DASHSCOPE_REALTIME_MODELS = {
    _FUN_ASR_REALTIME_DEFAULT,
}
_DASHSCOPE_FLASH_MODELS = {_FUN_ASR_FLASH_DEFAULT}
_LEGACY_DASHSCOPE_REALTIME_MODELS = {
    "qwen3-asr-flash-realtime",
    "qwen3-asr-flash-realtime-2026-02-10",
    "qwen3-asr-flash-realtime-2025-10-27",
}
_DASHSCOPE_ALL_MODELS = (
    _DASHSCOPE_COMPAT_MODELS
    | {"fun-asr"}
    | _DASHSCOPE_REALTIME_MODELS
    | _DASHSCOPE_FLASH_MODELS
)
_DASHSCOPE_REALTIME_DEFAULT = _FUN_ASR_REALTIME_DEFAULT


@dataclass
class SttConfig:
    mode: str = "api"                    # "local" | "api" | "dashscope"
    language: str = "zh"                 # BCP-47 language code
    local_model: str = "base"            # faster-whisper model: tiny/base/small/medium/large-v3
    api_base_url: str = ""               # OpenAI-compatible base URL
    api_key: str = ""                    # API key
    api_model: str = "whisper-1"         # 模型名
    device_id: str = ""                  # 前端麦克风 deviceId（持久化）
    workspace_id: str = ""               # 百炼 Workspace ID（可选）
    vad_silence_ms: int = 400             # 旧 Qwen 配置兼容字段（Fun-ASR 不使用）
    flash_model: str = _FUN_ASR_FLASH_DEFAULT
    flash_refine_enabled: bool = True     # ≤5 分钟录音停止后用 Flash 精校

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "language": self.language,
            "localModel": self.local_model,
            "apiBaseUrl": self.api_base_url,
            "apiKey": self.api_key,
            "apiModel": self.api_model,
            "deviceId": self.device_id,
            "workspaceId": self.workspace_id,
            "vadSilenceMs": self.vad_silence_ms,
            "flashModel": self.flash_model,
            "flashRefineEnabled": self.flash_refine_enabled,
        }

    @staticmethod
    def from_dict(d: dict) -> "SttConfig":
        mode = d.get("mode", "api")
        api_model = d.get("apiModel", "whisper-1")
        # DashScope 麦克风链路统一迁移到用户选定的 Fun-ASR 快照版。
        if mode == "dashscope" and (
            api_model not in _DASHSCOPE_REALTIME_MODELS
            or api_model in _LEGACY_DASHSCOPE_REALTIME_MODELS
        ):
            api_model = _DASHSCOPE_REALTIME_DEFAULT
        try:
            vad_silence_ms = int(d.get("vadSilenceMs", 400))
        except (TypeError, ValueError):
            vad_silence_ms = 400
        return SttConfig(
            mode=mode,
            language=d.get("language", "zh"),
            local_model=d.get("localModel", "base"),
            api_base_url=d.get("apiBaseUrl", ""),
            api_key=d.get("apiKey", ""),
            api_model=api_model,
            device_id=d.get("deviceId", ""),
            workspace_id=d.get("workspaceId", ""),
            vad_silence_ms=max(200, min(6000, vad_silence_ms)),
            flash_model=(
                d.get("flashModel")
                if d.get("flashModel") in _DASHSCOPE_FLASH_MODELS
                else _FUN_ASR_FLASH_DEFAULT
            ),
            flash_refine_enabled=bool(d.get("flashRefineEnabled", True)),
        )


_CONFIG_DIR = paths.data_root()
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
                r = _sp.run([path, "--version"], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=5)
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
    suffix = ".wav" if audio_bytes[:4] == b'RIFF' else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
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
                    capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=120,
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
        is_wav = audio_bytes[:4] == b'RIFF'
        fname = "audio.wav" if is_wav else "audio.webm"
        mime = "audio/wav" if is_wav else "audio/webm"
        files = {"file": (fname, audio_bytes, mime)}
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

async def transcribe_dashscope(
    audio_bytes: bytes,
    language: str = "zh",
    api_base_url: str = "",
    api_key: str = "",
    api_model: str = "sensevoice-v1",
    workspace_id: str = "",
    vad_silence_ms: int = 400,
    flash_model: str = _FUN_ASR_FLASH_DEFAULT,
    prefer_flash: bool = False,
) -> str:
    """调用阿里云 DashScope 语音识别。

    sensevoice / paraformer 走 OpenAI 兼容接口（短音频直传）；
    fun-asr 等原生模型走 DashScope Python SDK（异步任务模式）。
    打包时需 --hidden-import dashscope --collect-all dashscope。
    """
    if not api_key:
        raise ValueError("DashScope 需要配置 apiKey")

    if prefer_flash or api_model in _DASHSCOPE_FLASH_MODELS:
        return await transcribe_fun_asr_flash(
            audio_bytes,
            api_key=api_key,
            api_model=(
                api_model if api_model in _DASHSCOPE_FLASH_MODELS
                else flash_model
            ),
            api_base_url=api_base_url,
            workspace_id=workspace_id,
        )

    if api_model in _DASHSCOPE_REALTIME_MODELS:
        return await transcribe_dashscope_realtime(
            audio_bytes,
            language,
            api_key,
            api_model,
            api_base_url,
            workspace_id,
        )

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


def _parse_transcription_results(results: list) -> str:
    """从 DashScope Transcription 结果列表中提取文本。"""
    from urllib import request as _request
    for trans in results:
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

    suffix = ".wav" if audio_bytes[:4] == b'RIFF' else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    def _run():
        try:
            dashscope.api_key = api_key
            dashscope.base_http_api_url = (
                api_base_url.rstrip('/') if api_base_url
                else 'https://dashscope.aliyuncs.com/api/v1'
            )

            # ① 上传文件到 OSS
            file_url = None
            _oss_mode = False

            # 新版 SDK (1.17+): dashscope.utils.oss_utils.OssUtils
            try:
                from dashscope.utils.oss_utils import OssUtils
                file_url = OssUtils.upload(
                    model=api_model,
                    file_path=tmp_path,
                    api_key=api_key,
                )
                _oss_mode = True
            except (ImportError, AttributeError):
                pass

            # 旧版 SDK: dashscope.Uploader
            if not file_url:
                _uploader = getattr(dashscope, 'Uploader', None)
                if _uploader is None:
                    try:
                        from dashscope.common.upload import Uploader as _uploader
                    except ImportError:
                        pass
                if _uploader is not None:
                    file_url = _uploader.upload(file_path=tmp_path, model=api_model)

            if not file_url or not isinstance(file_url, str):
                raise RuntimeError(
                    f"DashScope 文件上传失败，SDK 无可用上传接口。"
                    f"请确认 dashscope 已正确安装。"
                )
            print(f"[STT] DashScope 上传完成: {file_url[:80]}",
                  file=sys.stderr, flush=True)

            # ② 提交异步转写任务（官方标准流程）
            # OssUtils 返回 oss:// 前缀 URL，需要带 header 让服务端解析
            _extra = {}
            if _oss_mode and file_url.startswith('oss://'):
                _extra['headers'] = {'X-DashScope-OssResourceResolve': 'enable'}
            task_resp = Transcription.async_call(
                model=api_model,
                file_urls=[file_url],
                language_hints=[language] if language else None,
                **_extra,
            )

            task_id = (task_resp.output.get('task_id')
                       if hasattr(task_resp, 'output')
                       and isinstance(task_resp.output, dict)
                       else None)
            if not task_id:
                task_id = getattr(getattr(task_resp, 'output', None), 'task_id', None)
            if not task_id:
                raise RuntimeError(f"DashScope 任务提交失败: {repr(task_resp)[:300]}")
            print(f"[STT] DashScope task={task_id}", file=sys.stderr, flush=True)

            # ③ 轮询等待结果
            result = Transcription.wait(task=task_id)

            status_code = getattr(result, 'status_code', 0)
            if status_code != 200:
                output = getattr(result, 'output', None)
                msg = ''
                if isinstance(output, dict):
                    msg = output.get('message', '')
                else:
                    msg = getattr(output, 'message', '')
                raise RuntimeError(f"DashScope 转写失败 (code={status_code}): {msg}")

            # ④ 解析转写结果
            output = result.output
            results = output.get('results', []) if isinstance(output, dict) else getattr(output, 'results', [])
            return _parse_transcription_results(results)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return await loop.run_in_executor(None, _run)


# ═══════════════════════════════════════════════════════════════════════════
#  DashScope 实时转写 (WebSocket)
# ═══════════════════════════════════════════════════════════════════════════

def _qwen_event_id() -> str:
    return f"event_{uuid4().hex}"


def _qwen_dashscope_realtime_url(api_base_url: str, model: str) -> str:
    """把控制台中的 HTTP/WS 地址规范成 Qwen-ASR Realtime 端点。"""
    raw = (api_base_url or "").strip()
    if not raw:
        raw = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    elif "://" not in raw:
        raw = f"https://{raw}"

    parsed = urlparse(raw)
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme, parsed.scheme)
    if scheme not in {"ws", "wss"} or not parsed.netloc:
        raise ValueError(f"无效的 DashScope 实时端点: {api_base_url}")

    path = (parsed.path or "").rstrip("/")
    legacy_suffixes = ("/api/v1", "/compatible-mode/v1")
    if not path or path.endswith(legacy_suffixes):
        for suffix in legacy_suffixes:
            if path.endswith(suffix):
                path = path[:-len(suffix)]
                break
        path = f"{path}/api-ws/v1/realtime"
    elif not path.endswith("/realtime"):
        path = f"{path}/api-ws/v1/realtime"

    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["model"] = model
    return urlunparse((scheme, parsed.netloc, path, "", urlencode(query), ""))


def _qwen_dashscope_headers(api_key: str, workspace_id: str = "") -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "OpenAI-Beta": "realtime=v1",
    }
    if workspace_id.strip():
        headers["X-DashScope-WorkSpace"] = workspace_id.strip()
    return headers


async def _open_qwen_dashscope_realtime(
    api_key: str,
    model: str,
    api_base_url: str = "",
    workspace_id: str = "",
):
    import websockets

    url = _qwen_dashscope_realtime_url(api_base_url, model)
    return await websockets.connect(
        url,
        additional_headers=_qwen_dashscope_headers(api_key, workspace_id),
        open_timeout=10,
        close_timeout=5,
        ping_interval=20,
        ping_timeout=20,
        max_size=8 * 1024 * 1024,
    )


async def _configure_qwen_dashscope_realtime(
    ws,
    language: str,
    vad_silence_ms: int = 400,
) -> None:
    """发送 session.update，并明确等到服务端确认后才允许音频进入。"""
    await ws.send(json.dumps({
        "event_id": _qwen_event_id(),
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "input_audio_transcription": {
                "language": language or "zh",
            },
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.0,
                "prefix_padding_ms": 300,
                "silence_duration_ms": max(200, min(6000, vad_silence_ms)),
            },
        },
    }))

    # 建连后 session.created 可能先于 session.updated 到达。旧实现看到
    # session.created 就开始发音频，会导致前几帧按服务端默认格式处理。
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        if isinstance(raw, bytes):
            continue
        msg = json.loads(raw)
        event_type = msg.get("type", "")
        if event_type == "session.updated":
            return
        if event_type == "error":
            raise RuntimeError(_format_qwen_dashscope_error(msg))


def _format_qwen_dashscope_error(message: dict) -> str:
    error = message.get("error", message)
    if isinstance(error, dict):
        code = error.get("code", "")
        detail = error.get("message", "") or error.get("detail", "")
        return f"DashScope 实时识别错误{f' [{code}]' if code else ''}: {detail or error}"
    return f"DashScope 实时识别错误: {error}"


def _append_transcript(base: str, incoming: str) -> str:
    """合并最终句，兼容服务端返回单句或全会话累计文本两种形式。"""
    base = (base or "").strip()
    incoming = (incoming or "").strip()
    if not incoming:
        return base
    if not base or incoming.startswith(base):
        return incoming
    if base.endswith(incoming):
        return base

    max_overlap = min(len(base), len(incoming))
    for size in range(max_overlap, 0, -1):
        if base[-size:] == incoming[:size]:
            return base + incoming[size:]
    separator = (
        " "
        if base[-1].isascii() and incoming[0].isascii()
        and base[-1].isalnum() and incoming[0].isalnum()
        else ""
    )
    return base + separator + incoming


def _extract_pcm(audio_bytes: bytes) -> bytes:
    """从 WAV 中提取 PCM 数据；如果非 WAV 则原样返回。"""
    if audio_bytes[:4] == b'RIFF' and audio_bytes[8:12] == b'WAVE':
        import struct
        offset = 12
        while offset < len(audio_bytes) - 8:
            chunk_id = audio_bytes[offset:offset + 4]
            chunk_size = struct.unpack_from('<I', audio_bytes, offset + 4)[0]
            if chunk_id == b'data':
                return audio_bytes[offset + 8:offset + 8 + chunk_size]
            offset += 8 + chunk_size
    return audio_bytes


async def _transcribe_qwen_dashscope_realtime(
    audio_bytes: bytes,
    language: str = "zh",
    api_key: str = "",
    api_model: str = "qwen3-asr-flash-realtime",
    api_base_url: str = "",
    workspace_id: str = "",
    vad_silence_ms: int = 400,
) -> str:
    """通过 WebSocket 调用 DashScope 千问实时语音识别。

    audio_bytes: WAV (PCM 16kHz 16bit mono) 或裸 PCM 数据。
    """
    try:
        import websockets
    except ImportError:
        raise RuntimeError("实时语音识别需要 websockets: pip install websockets")

    if not api_key:
        raise ValueError("实时语音识别需要配置 apiKey")

    pcm = _extract_pcm(audio_bytes)
    if not pcm:
        raise ValueError("音频数据为空")

    transcripts: list[str] = []

    print(f"[STT] 实时转写: model={api_model}, pcm_size={len(pcm)}",
          file=sys.stderr, flush=True)

    ws = await _open_qwen_dashscope_realtime(
        api_key, api_model, api_base_url, workspace_id,
    )
    try:
        await _configure_qwen_dashscope_realtime(ws, language, vad_silence_ms)

        # ② 流式发送音频
        CHUNK = 3200  # ~0.1s at 16kHz 16-bit mono
        for offset in range(0, len(pcm), CHUNK):
            chunk = pcm[offset:offset + CHUNK]
            await ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode("ascii"),
            }))
            await asyncio.sleep(0.02)

        # ③ 结束会话
        await ws.send(json.dumps({
            "event_id": _qwen_event_id(),
            "type": "session.finish",
        }))

        # ④ 收集结果
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=30)
            except asyncio.TimeoutError:
                print("[STT] 实时转写超时", file=sys.stderr, flush=True)
                break
            msg = json.loads(raw)
            t = msg.get("type", "")
            if t == "conversation.item.input_audio_transcription.completed":
                text = msg.get("transcript", "")
                if text:
                    transcripts.append(text)
            elif t == "session.finished":
                final = msg.get("transcript", "")
                if final:
                    transcripts.append(final)
                break
            elif t == "error":
                raise RuntimeError(_format_qwen_dashscope_error(msg))
    finally:
        await ws.close()

    result = ""
    for transcript in transcripts:
        result = _append_transcript(result, transcript)
    print(f"[STT] 实时转写完成: {result[:80]}", file=sys.stderr, flush=True)
    return result


def _ws_is_open(ws) -> bool:
    """兼容 websockets v10~v16 的连接状态检查。"""
    if hasattr(ws, 'open'):
        return ws.open
    try:
        from websockets.protocol import State
        return ws.state == State.OPEN
    except Exception:
        return False


class _LegacyQwenRealtimeSession:
    """旧 Qwen-ASR WebSocket 实现，仅保留给历史配置迁移排查。"""

    def __init__(
        self,
        api_key: str,
        model: str,
        language: str,
        on_text,  # (text: str, is_final: bool) -> None
        on_end=None,  # Optional[() -> None] — 连接意外断开时回调
        api_base_url: str = "",
        workspace_id: str = "",
        vad_silence_ms: int = 400,
    ):
        self._api_key = api_key
        self._model = model
        self._language = language
        self._on_text = on_text
        self._on_end = on_end
        self._api_base_url = api_base_url
        self._workspace_id = workspace_id
        self._vad_silence_ms = vad_silence_ms
        self._ws = None
        self._listener_task: Optional[asyncio.Task] = None
        self._final_text = ""
        self._partial_text = ""
        self._completed_items: set[str] = set()
        self._last_emitted: tuple[str, bool] = ("", False)
        self._done = asyncio.Event()
        self._stopped_by_user = False

    async def _connect_ws(self):
        ws = await _open_qwen_dashscope_realtime(
            self._api_key,
            self._model,
            self._api_base_url,
            self._workspace_id,
        )
        try:
            await _configure_qwen_dashscope_realtime(
                ws, self._language, self._vad_silence_ms,
            )
        except Exception:
            await ws.close()
            raise
        return ws

    async def start(self):
        print(f"[STT] 流式会话启动: model={self._model}", file=sys.stderr, flush=True)
        self._ws = await self._connect_ws()
        self._listener_task = asyncio.create_task(self._listen())

    async def send_audio(self, pcm_chunk: bytes):
        ws = self._ws
        if ws and _ws_is_open(ws):
            await ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(pcm_chunk).decode("ascii"),
            }))

    async def stop(self) -> str:
        self._stopped_by_user = True
        if self._ws and _ws_is_open(self._ws):
            try:
                await self._ws.send(json.dumps({
                    "event_id": _qwen_event_id(),
                    "type": "session.finish",
                }))
                await asyncio.wait_for(self._done.wait(), timeout=15)
            except (asyncio.TimeoutError, Exception) as e:
                print(f"[STT] 流式结束异常: {e}", file=sys.stderr, flush=True)
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        if self._listener_task:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except (asyncio.CancelledError, Exception):
                pass
        print(f"[STT] 流式会话结束: {self._final_text[:80]}", file=sys.stderr, flush=True)
        return self._final_text

    def _emit_text(self, text: str, is_final: bool) -> None:
        update = (text, is_final)
        if text and update != self._last_emitted:
            self._last_emitted = update
            self._on_text(text, is_final)

    def _handle_event(self, msg: dict) -> bool:
        """处理一个服务端事件；返回 True 表示会话已结束。"""
        event_type = msg.get("type", "")
        if event_type in {
            "conversation.item.input_audio_transcription.text",
            "conversation.item.input_audio_transcription.delta",
        }:
            if event_type.endswith(".delta"):
                self._partial_text += str(
                    msg.get("delta", "") or msg.get("text", "")
                )
            else:
                self._partial_text = (
                    str(msg.get("text", "")) + str(msg.get("stash", ""))
                )
            preview = _append_transcript(self._final_text, self._partial_text)
            if preview:
                self._emit_text(preview, False)
        elif event_type == "conversation.item.input_audio_transcription.completed":
            item_id = str(
                msg.get("item_id", "")
                or (msg.get("item") or {}).get("id", "")
            )
            if item_id and item_id in self._completed_items:
                return False
            if item_id:
                self._completed_items.add(item_id)
            transcript = str(msg.get("transcript", "") or msg.get("text", ""))
            if transcript:
                self._final_text = _append_transcript(
                    self._final_text, transcript,
                )
                self._partial_text = ""
                self._emit_text(self._final_text, True)
        elif event_type == "session.finished":
            final = str(msg.get("transcript", ""))
            if final:
                self._final_text = _append_transcript(self._final_text, final)
                self._emit_text(self._final_text, True)
            self._done.set()
            return True
        elif event_type == "error":
            print(f"[STT] {_format_qwen_dashscope_error(msg)}",
                  file=sys.stderr, flush=True)
            self._done.set()
            return True
        return False

    async def _listen(self):
        ws = self._ws
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                msg = json.loads(raw)
                if self._handle_event(msg):
                    break
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[STT] 流式监听异常: {e}", file=sys.stderr, flush=True)
            self._done.set()
        if not self._stopped_by_user and self._on_end:
            try:
                self._on_end()
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  用户选定模型：Fun-ASR Realtime + Fun-ASR-Flash
# ═══════════════════════════════════════════════════════════════════════════

def _dashscope_http_base_url(api_base_url: str = "") -> str:
    """把控制台/WS 地址规范成 DashScope HTTP ``.../api/v1`` 根地址。"""
    raw = (api_base_url or "").strip() or "https://dashscope.aliyuncs.com/api/v1"
    if "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlparse(raw)
    scheme = {"ws": "http", "wss": "https"}.get(parsed.scheme, parsed.scheme)
    if scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"无效的 DashScope 地址: {api_base_url}")
    path = (parsed.path or "").rstrip("/")
    api_pos = path.find("/api")
    prefix = path[:api_pos] if api_pos >= 0 else path
    return urlunparse((scheme, parsed.netloc, f"{prefix}/api/v1", "", "", ""))


def _dashscope_inference_url(api_base_url: str = "") -> str:
    """Fun-ASR Recognition SDK 使用通用 inference WebSocket，而非 Qwen realtime。"""
    http_base = urlparse(_dashscope_http_base_url(api_base_url))
    scheme = "wss" if http_base.scheme == "https" else "ws"
    prefix = http_base.path.split("/api/", 1)[0]
    return urlunparse((
        scheme,
        http_base.netloc,
        f"{prefix}/api-ws/v1/inference",
        "",
        "",
        "",
    ))


def _pcm_to_wav_bytes(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(pcm)
    return output.getvalue()


def _parse_fun_asr_flash_response(payload: dict) -> str:
    """Fun-ASR-Flash 返回结构没有 choices，兼容文档列出的两个文本位置。"""
    output = payload.get("output") or {}
    if not isinstance(output, dict):
        return ""
    text = output.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    nested = output.get("output") or {}
    sentence = nested.get("sentence") if isinstance(nested, dict) else {}
    text = sentence.get("text") if isinstance(sentence, dict) else ""
    return text.strip() if isinstance(text, str) else ""


async def transcribe_fun_asr_flash(
    audio_bytes: bytes,
    *,
    api_key: str,
    api_model: str = _FUN_ASR_FLASH_DEFAULT,
    api_base_url: str = "",
    workspace_id: str = "",
) -> str:
    """用同步 multimodal-generation 接口精转不超过 5 分钟的 16k PCM/WAV。"""
    if not api_key:
        raise ValueError("Fun-ASR-Flash 需要配置 DashScope API Key")
    if api_model not in _DASHSCOPE_FLASH_MODELS:
        raise ValueError(f"不支持的 Fun-ASR-Flash 模型: {api_model}")

    pcm = _extract_pcm(audio_bytes)
    if not pcm:
        raise ValueError("音频数据为空")
    duration_seconds = len(pcm) / (16000 * 2)
    if duration_seconds > 300:
        raise ValueError("Fun-ASR-Flash 仅支持 5 分钟以内的音频")

    wav_bytes = _pcm_to_wav_bytes(pcm)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        tmp_path = tmp.name

    def _upload() -> str:
        try:
            import dashscope
            from dashscope.utils.oss_utils import OssUtils
        except ImportError as exc:
            raise RuntimeError(
                "Fun-ASR-Flash 需要安装 dashscope: pip install -U dashscope"
            ) from exc
        dashscope.api_key = api_key
        dashscope.base_http_api_url = _dashscope_http_base_url(api_base_url)
        upload_kwargs = {}
        if workspace_id.strip():
            upload_kwargs["headers"] = {
                "X-DashScope-WorkSpace": workspace_id.strip(),
            }
        uploaded = OssUtils.upload(
            model=api_model,
            file_path=tmp_path,
            api_key=api_key,
            **upload_kwargs,
        )
        if isinstance(uploaded, tuple):
            uploaded = uploaded[0]
        if not isinstance(uploaded, str) or not uploaded:
            raise RuntimeError("Fun-ASR-Flash 音频上传失败")
        return uploaded

    try:
        file_url = await asyncio.to_thread(_upload)
        endpoint = (
            _dashscope_http_base_url(api_base_url)
            + "/services/aigc/multimodal-generation/generation"
        )
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-DashScope-SSE": "disable",
        }
        if file_url.startswith("oss://"):
            headers["X-DashScope-OssResourceResolve"] = "enable"
        if workspace_id.strip():
            headers["X-DashScope-WorkSpace"] = workspace_id.strip()
        body = {
            "model": api_model,
            "input": {
                "messages": [{
                    "role": "user",
                    "content": [{
                        "type": "input_audio",
                        "input_audio": {"data": file_url},
                    }],
                }],
            },
            "parameters": {
                "format": "wav",
                "sample_rate": "16000",
            },
        }
        print(
            f"[STT] Fun-ASR-Flash 精转: model={api_model}, "
            f"duration={duration_seconds:.1f}s",
            file=sys.stderr,
            flush=True,
        )
        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(endpoint, headers=headers, json=body)
        if response.status_code != 200:
            raise RuntimeError(
                f"Fun-ASR-Flash 返回 {response.status_code}: {response.text[:500]}"
            )
        payload = response.json()
        text = _parse_fun_asr_flash_response(payload)
        if not text:
            raise RuntimeError(
                "Fun-ASR-Flash 响应中没有 output.text 或 "
                "output.output.sentence.text"
            )
        return text
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


class _FunAsrRecognitionCallback:
    """DashScope SDK callback；SDK 在线程中回调，统一投递回 asyncio loop。"""

    def __init__(self, session: "FunAsrRealtimeSession"):
        self._session = session

    def on_open(self) -> None:
        self._session._post(self._session._sdk_opened)

    def on_event(self, result) -> None:
        self._session._post(self._session._sdk_event, result)

    def on_complete(self) -> None:
        self._session._post(self._session._sdk_complete)

    def on_error(self, result) -> None:
        self._session._post(self._session._sdk_error, result)

    def on_close(self) -> None:
        self._session._post(self._session._sdk_closed)


class FunAsrRealtimeSession:
    """Fun-ASR Realtime SDK 会话；接收浏览器送来的 16kHz PCM16 单声道帧。"""

    _MAX_FLASH_CAPTURE_BYTES = 5 * 60 * 16000 * 2

    def __init__(
        self,
        api_key: str,
        model: str,
        language: str,
        on_text,
        on_end=None,
        api_base_url: str = "",
        workspace_id: str = "",
        vad_silence_ms: int = 400,
        capture_audio: bool = False,
    ):
        del vad_silence_ms  # 仅兼容旧调用；Fun-ASR Recognition 不使用 Qwen VAD 参数。
        self._api_key = api_key
        self._model = model
        self._language = language
        self._on_text = on_text
        self._on_end = on_end
        self._api_base_url = api_base_url
        self._workspace_id = workspace_id
        self._capture_audio = capture_audio
        self._captured_pcm = bytearray()
        self._capture_overflow = False
        self._recognizer = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._opened: Optional[asyncio.Event] = None
        self._done: Optional[asyncio.Event] = None
        self._stopped_by_user = False
        self._end_notified = False
        self._error = ""
        self._final_text = ""
        self._partial_text = ""
        self._last_emitted: tuple[str, bool] = ("", False)

    @property
    def capture_overflow(self) -> bool:
        return self._capture_overflow

    def captured_pcm(self) -> bytes:
        return bytes(self._captured_pcm)

    def _post(self, callback, *args) -> None:
        loop = self._loop
        if loop and loop.is_running():
            loop.call_soon_threadsafe(callback, *args)
        else:
            callback(*args)

    def _sdk_opened(self) -> None:
        if self._opened:
            self._opened.set()

    def _emit_text(self, text: str, is_final: bool) -> None:
        update = (text, is_final)
        if text and update != self._last_emitted:
            self._last_emitted = update
            self._on_text(text, is_final)

    def _sdk_event(self, result) -> None:
        sentence = result.get_sentence() if hasattr(result, "get_sentence") else None
        if isinstance(sentence, list):
            sentence = sentence[-1] if sentence else None
        if not isinstance(sentence, dict):
            output = getattr(result, "output", None)
            sentence = output.get("sentence") if isinstance(output, dict) else None
        if not isinstance(sentence, dict):
            return
        text = str(sentence.get("text", "") or "")
        if not text:
            return
        is_final = (
            sentence.get("end_time") is not None
            or bool(sentence.get("sentence_end"))
        )
        if is_final:
            self._final_text = _append_transcript(self._final_text, text)
            self._partial_text = ""
            self._emit_text(self._final_text, True)
        else:
            self._partial_text = text
            self._emit_text(
                _append_transcript(self._final_text, self._partial_text),
                False,
            )

    def _sdk_complete(self) -> None:
        if self._done:
            self._done.set()

    def _notify_end(self) -> None:
        if self._end_notified or self._stopped_by_user or not self._on_end:
            return
        self._end_notified = True
        self._on_end()

    def _sdk_error(self, result) -> None:
        code = getattr(result, "code", "") or getattr(result, "status_code", "")
        message = getattr(result, "message", "") or str(result)
        self._error = f"Fun-ASR Realtime 错误{f' [{code}]' if code else ''}: {message}"
        if self._done:
            self._done.set()
        self._notify_end()

    def _sdk_closed(self) -> None:
        if self._done:
            self._done.set()
        self._notify_end()

    async def start(self) -> None:
        if not self._api_key:
            raise ValueError("Fun-ASR Realtime 需要配置 DashScope API Key")
        if self._model not in _DASHSCOPE_REALTIME_MODELS:
            raise ValueError(f"不支持的 Fun-ASR Realtime 模型: {self._model}")
        try:
            import dashscope
            from dashscope.audio.asr import Recognition
        except ImportError as exc:
            raise RuntimeError(
                "Fun-ASR Realtime 需要安装 dashscope: pip install -U dashscope"
            ) from exc

        self._loop = asyncio.get_running_loop()
        self._opened = asyncio.Event()
        self._done = asyncio.Event()
        dashscope.api_key = self._api_key
        dashscope.base_websocket_api_url = _dashscope_inference_url(
            self._api_base_url
        )
        kwargs = {"heartbeat": True}
        if self._language:
            kwargs["language_hints"] = [self._language]
        self._recognizer = Recognition(
            model=self._model,
            callback=_FunAsrRecognitionCallback(self),
            format="pcm",
            sample_rate=16000,
            workspace=self._workspace_id or None,
            **kwargs,
        )
        print(
            f"[STT] Fun-ASR Realtime 启动: model={self._model}, "
            f"endpoint={dashscope.base_websocket_api_url}",
            file=sys.stderr,
            flush=True,
        )
        await asyncio.to_thread(self._recognizer.start)
        await asyncio.wait_for(self._opened.wait(), timeout=10)
        if self._error:
            raise RuntimeError(self._error)

    async def send_audio(self, pcm_chunk: bytes) -> None:
        if self._capture_audio and not self._capture_overflow:
            next_size = len(self._captured_pcm) + len(pcm_chunk)
            if next_size <= self._MAX_FLASH_CAPTURE_BYTES:
                self._captured_pcm.extend(pcm_chunk)
            else:
                self._captured_pcm.clear()
                self._capture_overflow = True
        if self._recognizer is not None:
            self._recognizer.send_audio_frame(bytes(pcm_chunk))

    async def stop(self) -> str:
        self._stopped_by_user = True
        recognizer = self._recognizer
        self._recognizer = None
        if recognizer is not None:
            try:
                await asyncio.to_thread(recognizer.stop)
            except Exception as exc:
                if not self._error:
                    self._error = str(exc)
        if self._done and not self._done.is_set():
            try:
                await asyncio.wait_for(self._done.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass
        text = self._final_text or self._partial_text
        if self._error and not text:
            raise RuntimeError(self._error)
        print(
            f"[STT] Fun-ASR Realtime 结束: {text[:80]}",
            file=sys.stderr,
            flush=True,
        )
        return text


# 对外名称保持不变，Bridge 不需要知道底层从 Qwen 协议切到了 Recognition SDK。
SttRealtimeSession = FunAsrRealtimeSession


async def transcribe_dashscope_realtime(
    audio_bytes: bytes,
    language: str = "zh",
    api_key: str = "",
    api_model: str = _FUN_ASR_REALTIME_DEFAULT,
    api_base_url: str = "",
    workspace_id: str = "",
) -> str:
    pcm = _extract_pcm(audio_bytes)
    if not pcm:
        raise ValueError("音频数据为空")
    session = FunAsrRealtimeSession(
        api_key,
        api_model,
        language,
        lambda _text, _final: None,
        api_base_url=api_base_url,
        workspace_id=workspace_id,
    )
    await session.start()
    try:
        for offset in range(0, len(pcm), 3200):
            await session.send_audio(pcm[offset:offset + 3200])
            await asyncio.sleep(0.01)
        return await session.stop()
    except Exception:
        try:
            await session.stop()
        except Exception:
            pass
        raise


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
            cfg.workspace_id, cfg.vad_silence_ms,
            cfg.flash_model, cfg.flash_refine_enabled,
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
