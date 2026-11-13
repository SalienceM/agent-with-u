"""Fun-ASR 双工连接：逐帧发送 PCM，单独读取结果，不等待录音结束。"""
from __future__ import annotations

import asyncio
import json
import sys
import math
from array import array
from uuid import uuid4


class FunAsrRealtimeSession:
    _MAX_FLASH_CAPTURE_BYTES = 5 * 60 * 16000 * 2

    def __init__(self, api_key: str, model: str, language: str, on_text, on_end=None,
                 api_base_url: str = "", workspace_id: str = "", vad_silence_ms: int = 400,
                 capture_audio: bool = False):
        self._api_key, self._model, self._language = api_key, model, language
        self._api_base_url, self._workspace_id = api_base_url, workspace_id
        self._on_text, self._on_end = on_text, on_end
        self._capture_audio = capture_audio
        self._captured_pcm = bytearray()
        self._capture_overflow = False
        self._ws = None
        self._listener_task = None
        self._opened, self._done = asyncio.Event(), asyncio.Event()
        self._write_lock = asyncio.Lock()
        self._task_id = uuid4().hex
        self._stopped_by_user = False
        self._end_notified = False
        self._error = ""
        self._final_text = self._partial_text = ""
        self._last_emitted = ("", False)
        self._sent_bytes = self._sent_frames = self._text_events = 0
        self._audio_samples = self._audio_energy = self._audio_peak = 0

    @property
    def capture_overflow(self) -> bool:
        return self._capture_overflow

    @property
    def error(self) -> str:
        return self._error

    def captured_pcm(self) -> bytes:
        return bytes(self._captured_pcm)

    @property
    def has_audio_signal(self) -> bool:
        return self._audio_peak > 0

    def _notify_end(self) -> None:
        if not self._end_notified and not self._stopped_by_user and self._on_end:
            self._end_notified = True
            self._on_end()

    def _fail(self, message: str) -> None:
        if not self._error:
            self._error = message
        self._opened.set()
        self._done.set()
        self._notify_end()

    def _handle_sentence(self, sentence: dict) -> None:
        from .stt_service import _append_transcript
        if sentence.get("heartbeat"):
            return
        text = str(sentence.get("text") or "")
        if not text:
            return
        final = sentence.get("end_time") is not None or bool(sentence.get("sentence_end"))
        if final:
            self._final_text = _append_transcript(self._final_text, text)
            self._partial_text = ""
            visible = self._final_text
        else:
            self._partial_text = text
            visible = _append_transcript(self._final_text, text)
        update = (visible, final)
        if update != self._last_emitted:
            self._last_emitted = update
            self._text_events += 1
            self._on_text(*update)

    def _message(self, action: str, payload: dict) -> str:
        return json.dumps({"header": {"action": action, "task_id": self._task_id, "streaming": "duplex"},
                           "payload": payload}, ensure_ascii=False)

    async def _listen(self) -> None:
        try:
            async for raw in self._ws:
                if not isinstance(raw, str):
                    continue
                message = json.loads(raw)
                header = message.get("header") or {}
                if header.get("task_id") != self._task_id:
                    continue
                event = header.get("event")
                if event == "task-started":
                    self._opened.set()
                elif event == "result-generated":
                    sentence = ((message.get("payload") or {}).get("output") or {}).get("sentence")
                    for item in sentence if isinstance(sentence, list) else [sentence]:
                        if isinstance(item, dict):
                            self._handle_sentence(item)
                elif event == "task-failed":
                    self._fail(f"Fun-ASR Realtime 错误 [{header.get('error_code', 'unknown')}]: "
                               f"{header.get('error_message', '识别失败')}")
                    break
                elif event == "task-finished":
                    self._done.set()
                    break
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._fail(f"实时语音连接中断：{error}")
        finally:
            if not self._done.is_set():
                self._fail("实时语音连接提前关闭，已保留收到的文字")
            if self._ws:
                await self._ws.close()
            self._notify_end()

    async def start(self) -> None:
        from websockets.asyncio.client import connect
        from .stt_service import _dashscope_inference_url, _DASHSCOPE_REALTIME_MODELS
        if not self._api_key:
            raise ValueError("Fun-ASR Realtime 需要配置 DashScope API Key")
        if self._model not in _DASHSCOPE_REALTIME_MODELS:
            raise ValueError(f"不支持的 Fun-ASR Realtime 模型: {self._model}")
        headers = {"Authorization": f"Bearer {self._api_key}"}
        if self._workspace_id:
            headers["X-DashScope-WorkSpace"] = self._workspace_id
        parameters = {"format": "pcm", "sample_rate": 16000, "heartbeat": True}
        if self._language:
            parameters["language_hints"] = [self._language]
        try:
            self._ws = await connect(_dashscope_inference_url(self._api_base_url), additional_headers=headers,
                                     open_timeout=10, close_timeout=2, ping_interval=20, ping_timeout=20,
                                     max_size=1024 * 1024)
            self._listener_task = asyncio.create_task(self._listen())
            await self._ws.send(self._message("run-task", {"task_group": "audio", "task": "asr",
                "function": "recognition", "model": self._model, "parameters": parameters, "input": {}}))
            await asyncio.wait_for(self._opened.wait(), 10)
            if self._error:
                raise RuntimeError(self._error)
        except BaseException:
            self._stopped_by_user = True
            await self._close()
            raise
        print(f"[STT] Fun-ASR Realtime 就绪: model={self._model}, task={self._task_id}", file=sys.stderr, flush=True)

    async def send_audio(self, pcm_chunk: bytes) -> None:
        if not pcm_chunk:
            return
        if len(pcm_chunk) % 2:
            raise ValueError("实时语音 PCM16 音频帧长度无效")
        # 只统计电平，不保存或打印录音；用于区分静音采集和上游识别失败。
        samples = array('h', pcm_chunk)
        if sys.byteorder != 'little':
            samples.byteswap()
        self._audio_samples += len(samples)
        self._audio_energy += sum(value * value for value in samples)
        self._audio_peak = max(self._audio_peak, max(map(abs, samples), default=0))
        if self._capture_audio and not self._capture_overflow:
            if len(self._captured_pcm) + len(pcm_chunk) <= self._MAX_FLASH_CAPTURE_BYTES:
                self._captured_pcm.extend(pcm_chunk)
            else:
                self._captured_pcm.clear()
                self._capture_overflow = True
        async with self._write_lock:
            if self._stopped_by_user or self._done.is_set() or not self._ws:
                raise RuntimeError(self._error or "实时语音连接已停止")
            try:
                await asyncio.wait_for(self._ws.send(bytes(pcm_chunk)), 5)
                self._sent_bytes += len(pcm_chunk)
                self._sent_frames += 1
            except Exception as error:
                self._fail(f"实时语音音频发送失败：{error}")
                await self._close()
                raise RuntimeError(self._error) from error

    async def _close(self) -> None:
        if self._ws:
            await self._ws.close()
        task = self._listener_task
        if task and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._ws = None

    async def stop(self) -> str:
        from .stt_service import _append_transcript
        self._stopped_by_user = True
        try:
            async with self._write_lock:
                if self._ws and not self._done.is_set():
                    await asyncio.wait_for(self._ws.send(self._message("finish-task", {"input": {}})), 5)
            if self._ws:
                await asyncio.wait_for(self._done.wait(), 10)
        except Exception as error:
            self._error = self._error or f"实时识别结束未确认：{type(error).__name__}"
        finally:
            await self._close()
        text = _append_transcript(self._final_text, self._partial_text)
        rms = math.sqrt(self._audio_energy / max(1, self._audio_samples))
        print(f"[STT] Fun-ASR Realtime 结束: frames={self._sent_frames}, bytes={self._sent_bytes}, "
              f"textEvents={self._text_events}, chars={len(text)}, pcmPeak={self._audio_peak}, "
              f"pcmRms={rms:.1f}, error={bool(self._error)}",
              file=sys.stderr, flush=True)
        if self._error and not text:
            raise RuntimeError(self._error)
        return text
