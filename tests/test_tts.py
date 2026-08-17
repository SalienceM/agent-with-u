from __future__ import annotations

import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS
from src.backend.tts import (
    DASHSCOPE_DEFAULT_MODEL,
    DASHSCOPE_DEFAULT_VOICE,
    DASHSCOPE_SAMPLE_RATE,
    DEFAULT_VOICE,
    MAX_SPEECH_CHARS,
    SpeechResult,
    dashscope_speech_rate,
    format_dashscope_tts_error,
    markdown_to_speech_text,
    normalize_dashscope_model,
    normalize_dashscope_voice,
    normalize_rate,
    normalize_voice,
    pcm16_mono_to_wav,
    synthesize,
    synthesize_dashscope,
)


class TextNormalizationTests(unittest.TestCase):
    def test_markdown_is_made_suitable_for_speech(self) -> None:
        source = """# 标题

这是 **重点**，请看[说明](https://example.com/doc)。

```python
print("不要朗读")
```

![界面截图](https://example.com/image.png)
"""
        spoken = markdown_to_speech_text(source)

        self.assertIn("标题", spoken)
        self.assertIn("这是 重点，请看说明。", spoken)
        self.assertIn("代码块已省略。", spoken)
        self.assertIn("界面截图", spoken)
        self.assertNotIn("print", spoken)
        self.assertNotIn("https://", spoken)
        self.assertNotIn("**", spoken)

    def test_rate_is_clamped_and_invalid_values_use_default(self) -> None:
        self.assertEqual(normalize_rate(80), 50)
        self.assertEqual(normalize_rate(-90), -50)
        self.assertEqual(normalize_rate("15"), 15)
        self.assertEqual(normalize_rate("fast"), 0)

    def test_voice_validation(self) -> None:
        self.assertEqual(normalize_voice(""), DEFAULT_VOICE)
        self.assertEqual(normalize_voice("zh-CN-YunxiNeural"), "zh-CN-YunxiNeural")
        with self.assertRaises(ValueError):
            normalize_voice("../../not-a-voice")

    def test_dashscope_runtime_options_are_bounded_and_validated(self) -> None:
        self.assertEqual(normalize_dashscope_model(""), DASHSCOPE_DEFAULT_MODEL)
        self.assertEqual(normalize_dashscope_voice(""), DASHSCOPE_DEFAULT_VOICE)
        self.assertEqual(dashscope_speech_rate(-50), 0.5)
        self.assertEqual(dashscope_speech_rate(0), 1.0)
        self.assertEqual(dashscope_speech_rate(50), 1.5)
        with self.assertRaises(ValueError):
            normalize_dashscope_model("../../bad")
        with self.assertRaises(ValueError):
            normalize_dashscope_voice("bad voice")

    def test_pcm_preview_is_wrapped_as_24khz_mono_wav(self) -> None:
        import io
        import wave

        payload = pcm16_mono_to_wav(b"\x00\x00\xff\x7f")
        with wave.open(io.BytesIO(payload), "rb") as wav_file:
            self.assertEqual(wav_file.getnchannels(), 1)
            self.assertEqual(wav_file.getsampwidth(), 2)
            self.assertEqual(wav_file.getframerate(), DASHSCOPE_SAMPLE_RATE)
            self.assertEqual(wav_file.readframes(2), b"\x00\x00\xff\x7f")

    def test_realtime_voice_constraints_hide_tool_payload_but_allow_stage_results(self) -> None:
        unchanged = BridgeWS._with_interaction_constraints("base", None)
        realtime = BridgeWS._with_interaction_constraints("base", "realtime-voice")
        foreground = BridgeWS._with_interaction_constraints(
            "base", "realtime-voice-foreground")
        background = BridgeWS._with_interaction_constraints(
            "base", "realtime-voice-background")

        self.assertEqual(unchanged, "base")
        self.assertIn("base", realtime or "")
        self.assertIn("不会朗读", realtime or "")
        self.assertIn("阶段性结论", realtime or "")
        self.assertIn("不要输出思考过程", realtime or "")
        self.assertIn("<!--AWU-VOICE-->", foreground or "")
        self.assertIn("完整正文", foreground or "")
        self.assertIn("窗口不可见", background or "")
        self.assertIn("语音是主通道", background or "")
        self.assertIn("不要输出 AWU-VOICE 标记", background or "")


class SynthesisTests(unittest.IsolatedAsyncioTestCase):
    async def test_audio_chunks_and_runtime_options_are_forwarded(self) -> None:
        calls: list[dict[str, object]] = []

        class FakeCommunicate:
            def __init__(self, **kwargs: object) -> None:
                calls.append(kwargs)

            async def stream(self):
                yield {"type": "metadata", "data": b"ignored"}
                yield {"type": "audio", "data": b"first"}
                yield {"type": "audio", "data": b"second"}

        fake_module = types.SimpleNamespace(Communicate=FakeCommunicate)
        with patch.dict(sys.modules, {"edge_tts": fake_module}):
            result = await synthesize("你好", "zh-CN-YunxiNeural", 15)

        self.assertEqual(result.audio, b"firstsecond")
        self.assertEqual(result.voice, "zh-CN-YunxiNeural")
        self.assertEqual(result.rate, 15)
        self.assertEqual(
            calls,
            [{"text": "你好", "voice": "zh-CN-YunxiNeural", "rate": "+15%"}],
        )

    async def test_long_text_is_bounded_with_spoken_notice(self) -> None:
        received_text: list[str] = []

        class FakeCommunicate:
            def __init__(self, **kwargs: object) -> None:
                received_text.append(str(kwargs["text"]))

            async def stream(self):
                yield {"type": "audio", "data": b"audio"}

        fake_module = types.SimpleNamespace(Communicate=FakeCommunicate)
        with patch.dict(sys.modules, {"edge_tts": fake_module}):
            result = await synthesize("字" * (MAX_SPEECH_CHARS + 10))

        self.assertTrue(result.truncated)
        self.assertTrue(received_text[0].endswith("内容较长，后续部分已省略。"))
        self.assertLessEqual(len(result.text), MAX_SPEECH_CHARS + 20)

    async def test_empty_audio_is_reported(self) -> None:
        class FakeCommunicate:
            def __init__(self, **_kwargs: object) -> None:
                pass

            async def stream(self):
                yield {"type": "metadata"}

        fake_module = types.SimpleNamespace(Communicate=FakeCommunicate)
        with patch.dict(sys.modules, {"edge_tts": fake_module}):
            with self.assertRaisesRegex(RuntimeError, "未返回音频"):
                await synthesize("你好")

    async def test_dashscope_preview_uses_plain_streaming_and_collects_pcm(self) -> None:
        calls: list[tuple[str, object]] = []

        class FakeSynthesizer:
            def __init__(self, callback) -> None:
                self.callback = callback
                self.last_response = None

            def streaming_call(self, text: str) -> None:
                calls.append(("append", text))

            def streaming_complete(self, timeout: int) -> None:
                calls.append(("finish", timeout))
                self.callback.on_data(b"\x00\x00\xff\x7f")
                self.last_response = {
                    "header": {"event": "task-finished", "task_id": "request-ok"},
                }

            def get_response(self):
                return self.last_response

        def fake_builder(**kwargs):
            return FakeSynthesizer(kwargs["callback"])

        with patch("src.backend.tts._build_dashscope_synthesizer", side_effect=fake_builder):
            result = await synthesize_dashscope(
                "在呢，请说。",
                api_key="key",
                model="cosyvoice-v1",
                voice="longxiaochun",
            )

        self.assertEqual(calls, [("append", "在呢，请说。"), ("finish", 120_000)])
        self.assertTrue(result.audio.startswith(b"RIFF"))
        self.assertEqual(result.model, "cosyvoice-v1")

    async def test_dashscope_preview_surfaces_task_failure_and_combo_guidance(self) -> None:
        failure = {
            "header": {
                "event": "task-failed",
                "task_id": "request-418",
                "error_code": "InvalidParameter",
                "error_message": "[cosyvoice:]Engine return error code: 418",
            },
        }

        class FakeSynthesizer:
            def __init__(self, callback) -> None:
                self.callback = callback

            def streaming_call(self, _text: str) -> None:
                pass

            def streaming_complete(self, _timeout: int) -> None:
                self.callback.on_error(json.dumps(failure))

            def get_response(self):
                return failure

        def fake_builder(**kwargs):
            return FakeSynthesizer(kwargs["callback"])

        with (
            patch("src.backend.tts._build_dashscope_synthesizer", side_effect=fake_builder),
            self.assertRaisesRegex(RuntimeError, "cosyvoice-v1.*request_id: request-418"),
        ):
            await synthesize_dashscope(
                "在呢，请说。",
                api_key="key",
                model="cosyvoice-v3-flash",
                voice="longxiaochun",
            )

        formatted = format_dashscope_tts_error(
            failure,
            model="cosyvoice-v3-flash",
            voice="longxiaochun",
        )
        self.assertIn("InvalidParameter", formatted)
        self.assertIn("模型与音色组合", formatted)


class StreamingSynthesisBridgeTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _bridge(events: list[dict]) -> BridgeWS:
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._tts_stream_tasks = {}
        bridge._tts_stream_semaphore = asyncio.Semaphore(2)
        bridge._tts_dashscope_streams = {}

        async def broadcast(message: dict) -> None:
            events.append(message)

        bridge._broadcast = broadcast  # type: ignore[method-assign]
        return bridge

    async def test_stream_request_returns_before_audio_and_pushes_sequence_metadata(self) -> None:
        events: list[dict] = []
        bridge = self._bridge(events)

        async def fake_synthesize(text: str, voice: str, rate: int) -> SpeechResult:
            await asyncio.sleep(0)
            return SpeechResult(b"mp3", text, voice or DEFAULT_VOICE, rate)

        with patch("src.backend.tts.synthesize", new=fake_synthesize):
            payload = json.loads(await bridge._rpc_ttsStreamSynthesize(
                "session-id", "rv_12345678", 3, "你好，世界。", DEFAULT_VOICE, 10,
            ))
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["accepted"])
            self.assertEqual(events, [])
            task = bridge._tts_stream_tasks["rv_12345678"][3]
            await task

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "ttsStreamAudio")
        event = json.loads(events[0]["data"])
        self.assertTrue(event["ok"])
        self.assertEqual(event["streamId"], "rv_12345678")
        self.assertEqual(event["seq"], 3)
        self.assertEqual(event["base64"], "bXAz")

    async def test_cancel_is_non_blocking_and_suppresses_old_stream_event(self) -> None:
        events: list[dict] = []
        bridge = self._bridge(events)
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def slow_synthesize(text: str, voice: str, rate: int) -> SpeechResult:
            del text, voice, rate
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        with patch("src.backend.tts.synthesize", new=slow_synthesize):
            accepted = json.loads(await bridge._rpc_ttsStreamSynthesize(
                "session-id", "rv_cancel12", 0, "会被取消", DEFAULT_VOICE, 0,
            ))
            self.assertTrue(accepted["ok"])
            task = bridge._tts_stream_tasks["rv_cancel12"][0]
            await asyncio.wait_for(started.wait(), timeout=1)
            result = json.loads(await bridge._rpc_ttsStreamCancel(
                "session-id", "rv_cancel12",
            ))
            self.assertEqual(result, {"ok": True, "cancelled": 1})
            await asyncio.gather(task, return_exceptions=True)

        self.assertTrue(cancelled.is_set())
        self.assertEqual(events, [])

    async def test_stream_queue_and_chunk_size_are_bounded(self) -> None:
        bridge = self._bridge([])
        bridge._tts_stream_tasks["rv_abcdefgh"] = {
            index: asyncio.create_task(asyncio.sleep(60)) for index in range(64)
        }
        try:
            full = json.loads(await bridge._rpc_ttsStreamSynthesize(
                "session-id", "rv_abcdefgh", 65, "下一块", DEFAULT_VOICE, 0,
            ))
            oversized = json.loads(await bridge._rpc_ttsStreamSynthesize(
                "session-id", "rv_other123", 0, "字" * 321, DEFAULT_VOICE, 0,
            ))
        finally:
            tasks = list(bridge._tts_stream_tasks.get("rv_abcdefgh", {}).values())
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        self.assertFalse(full["ok"])
        self.assertIn("待合成片段过多", full["error"])
        self.assertFalse(oversized["ok"])
        self.assertIn("320", oversized["error"])

    async def test_dashscope_uses_one_ordered_task_and_emits_pcm_then_finished(self) -> None:
        events: list[dict] = []
        bridge = self._bridge(events)
        appended: list[str] = []
        adapters: list[object] = []

        class FakeAdapter:
            model = "cosyvoice-v3-flash"
            voice = "longxiaochun"
            rate = 10

            def __init__(self, on_audio, on_error) -> None:
                self.on_audio = on_audio
                self.on_error = on_error
                self.finished = False
                self.cancelled = False

            async def append(self, text: str) -> None:
                appended.append(text)
                self.on_audio(b"\x00\x00\x00\x40")

            async def finish(self) -> None:
                self.finished = True

            async def cancel(self) -> None:
                self.cancelled = True

        def fake_factory(**kwargs):
            adapter = FakeAdapter(kwargs["on_audio"], kwargs["on_error"])
            adapters.append(adapter)
            return adapter

        fake_cfg = types.SimpleNamespace(api_key="key", workspace_id="ws", api_base_url="")
        with (
            patch("src.backend.tts.create_dashscope_realtime_stream", side_effect=fake_factory),
            patch("src.backend.stt_service.load_stt_config", return_value=fake_cfg),
        ):
            first = json.loads(await bridge._rpc_ttsStreamSynthesize(
                "session-id", "rv_dashscope1", 0, "第一句。", "longxiaochun", 10,
                "dashscope", "cosyvoice-v3-flash",
            ))
            second = json.loads(await bridge._rpc_ttsStreamSynthesize(
                "session-id", "rv_dashscope1", 1, "第二句。", "longxiaochun", 10,
                "dashscope", "cosyvoice-v3-flash",
            ))
            self.assertTrue(first["accepted"])
            self.assertTrue(second["accepted"])
            state = bridge._tts_dashscope_streams["rv_dashscope1"]
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            finished = json.loads(await bridge._rpc_ttsStreamFinish(
                "session-id", "rv_dashscope1", "dashscope",
            ))
            self.assertTrue(finished["accepted"])
            await state["workerTask"]
            await state["eventTask"]

        self.assertEqual(len(adapters), 1)
        self.assertEqual(appended, ["第一句。", "第二句。"])
        self.assertTrue(adapters[0].finished)  # type: ignore[attr-defined]
        payloads = [json.loads(item["data"]) for item in events]
        self.assertEqual([item["kind"] for item in payloads], ["audio", "audio", "finished"])
        self.assertEqual([item.get("audioSeq") for item in payloads[:2]], [0, 1])
        self.assertEqual(payloads[0]["encoding"], "pcm_s16le")
        self.assertEqual(payloads[0]["sampleRate"], 24_000)

    async def test_dashscope_cancel_is_immediate_and_suppresses_late_audio(self) -> None:
        events: list[dict] = []
        bridge = self._bridge(events)
        append_started = asyncio.Event()
        release_append = asyncio.Event()
        adapter_holder: list[object] = []

        class FakeAdapter:
            model = "cosyvoice-v3-flash"
            voice = "longxiaochun"
            rate = 0

            def __init__(self, on_audio) -> None:
                self.on_audio = on_audio
                self.cancelled = False

            async def append(self, _text: str) -> None:
                append_started.set()
                await release_append.wait()
                self.on_audio(b"late")

            async def finish(self) -> None:
                pass

            async def cancel(self) -> None:
                self.cancelled = True
                release_append.set()

        def fake_factory(**kwargs):
            adapter = FakeAdapter(kwargs["on_audio"])
            adapter_holder.append(adapter)
            return adapter

        fake_cfg = types.SimpleNamespace(api_key="key", workspace_id="", api_base_url="")
        with (
            patch("src.backend.tts.create_dashscope_realtime_stream", side_effect=fake_factory),
            patch("src.backend.stt_service.load_stt_config", return_value=fake_cfg),
        ):
            accepted = json.loads(await bridge._rpc_ttsStreamSynthesize(
                "session-id", "rv_dashcancel", 0, "会被取消", "longxiaochun", 0,
                "dashscope", "cosyvoice-v3-flash",
            ))
            self.assertTrue(accepted["ok"])
            await asyncio.wait_for(append_started.wait(), timeout=1)
            result = json.loads(await bridge._rpc_ttsStreamCancel(
                "session-id", "rv_dashcancel",
            ))
            self.assertEqual(result, {"ok": True, "cancelled": 1})
            await asyncio.sleep(0)
            await asyncio.sleep(0)

        self.assertTrue(adapter_holder[0].cancelled)  # type: ignore[attr-defined]
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
