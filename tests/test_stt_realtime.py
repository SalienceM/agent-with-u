import json
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse

from src.backend.bridge_ws import BridgeWS
from src.backend import stt_service
from src.backend.stt_service import (
    FunAsrRealtimeSession,
    SttConfig,
    _FUN_ASR_FLASH_DEFAULT,
    _FUN_ASR_REALTIME_DEFAULT,
    _append_transcript,
    _dashscope_http_base_url,
    _dashscope_inference_url,
    _parse_fun_asr_flash_response,
    transcribe_fun_asr_flash,
)


class _FakeRecognitionResult:
    def __init__(self, sentence):
        self._sentence = sentence

    def get_sentence(self):
        return self._sentence


class _FakeRecognizer:
    def __init__(self):
        self.frames = []

    def send_audio_frame(self, frame):
        self.frames.append(frame)


class _FakeStreamSession:
    def __init__(
        self,
        text="实时识别结果",
        pcm=b"\x00\x00",
        *,
        overflow=False,
    ):
        self.text = text
        self.pcm = pcm
        self.capture_overflow = overflow
        self.stopped = False

    async def stop(self):
        self.stopped = True
        return self.text

    def captured_pcm(self):
        return self.pcm


class SttRealtimeConfigTests(unittest.TestCase):
    def test_legacy_dashscope_model_migrates_to_selected_fun_asr_models(self):
        cfg = SttConfig.from_dict({
            "mode": "dashscope",
            "apiModel": "qwen3-asr-flash-realtime",
            "workspaceId": "ws-demo",
            "flashModel": "old-model",
        })

        self.assertEqual(cfg.api_model, _FUN_ASR_REALTIME_DEFAULT)
        self.assertEqual(cfg.flash_model, _FUN_ASR_FLASH_DEFAULT)
        self.assertEqual(cfg.workspace_id, "ws-demo")
        self.assertTrue(cfg.flash_refine_enabled)

    def test_flash_refine_can_be_disabled(self):
        cfg = SttConfig.from_dict({
            "mode": "dashscope",
            "apiModel": _FUN_ASR_REALTIME_DEFAULT,
            "flashRefineEnabled": False,
        })

        self.assertFalse(cfg.flash_refine_enabled)

    def test_dashscope_endpoints_use_fun_asr_inference_protocol(self):
        public_http = urlparse(_dashscope_http_base_url(""))
        public_ws = urlparse(_dashscope_inference_url(""))

        self.assertEqual(public_http.geturl(), "https://dashscope.aliyuncs.com/api/v1")
        self.assertEqual(public_ws.geturl(), "wss://dashscope.aliyuncs.com/api-ws/v1/inference")

        workspace_ws = urlparse(_dashscope_inference_url(
            "https://demo.cn-beijing.maas.aliyuncs.com/api/v1",
        ))
        self.assertEqual(workspace_ws.scheme, "wss")
        self.assertEqual(workspace_ws.netloc, "demo.cn-beijing.maas.aliyuncs.com")
        self.assertEqual(workspace_ws.path, "/api-ws/v1/inference")

    def test_fun_asr_flash_response_parses_both_documented_shapes(self):
        self.assertEqual(
            _parse_fun_asr_flash_response({
                "output": {"text": "顶层文本"},
            }),
            "顶层文本",
        )
        self.assertEqual(
            _parse_fun_asr_flash_response({
                "output": {
                    "output": {
                        "sentence": {"text": "嵌套文本"},
                    },
                },
            }),
            "嵌套文本",
        )

    def test_transcript_merge_handles_overlap_and_english_words(self):
        self.assertEqual(_append_transcript("你好", "你好世界"), "你好世界")
        self.assertEqual(_append_transcript("你好世界", "世界"), "你好世界")
        self.assertEqual(_append_transcript("你好世界", "世界和平"), "你好世界和平")
        self.assertEqual(_append_transcript("hello", "world"), "hello world")


class FunAsrRealtimeSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_events_merge_partial_and_final_transcripts(self):
        updates = []
        session = FunAsrRealtimeSession(
            "key",
            _FUN_ASR_REALTIME_DEFAULT,
            "zh",
            lambda text, final: updates.append((text, final)),
        )

        session._sdk_event(_FakeRecognitionResult({"text": "你好"}))
        session._sdk_event(_FakeRecognitionResult({
            "text": "你好啊",
            "end_time": 1200,
        }))
        session._sdk_event(_FakeRecognitionResult({"text": "世界"}))
        session._sdk_event(_FakeRecognitionResult({
            "text": "世界",
            "sentence_end": True,
        }))

        self.assertEqual(session._final_text, "你好啊世界")
        self.assertEqual(
            updates,
            [
                ("你好", False),
                ("你好啊", True),
                ("你好啊世界", False),
                ("你好啊世界", True),
            ],
        )

    async def test_audio_capture_stops_and_clears_when_five_minute_limit_overflows(self):
        session = FunAsrRealtimeSession(
            "key",
            _FUN_ASR_REALTIME_DEFAULT,
            "zh",
            lambda _text, _final: None,
            capture_audio=True,
        )
        session._MAX_FLASH_CAPTURE_BYTES = 4
        session._recognizer = _FakeRecognizer()

        await session.send_audio(b"1234")
        await session.send_audio(b"5")

        self.assertTrue(session.capture_overflow)
        self.assertEqual(session.captured_pcm(), b"")
        self.assertEqual(session._recognizer.frames, [b"1234", b"5"])

    async def test_flash_rejects_audio_over_five_minutes_before_upload(self):
        too_long_pcm = b"\x00\x00" * (16000 * 300 + 1)

        with self.assertRaisesRegex(ValueError, "5 分钟"):
            await transcribe_fun_asr_flash(
                too_long_pcm,
                api_key="key",
            )


class BridgeSttFlowTests(unittest.IsolatedAsyncioTestCase):
    def _bridge_with_stream(self, session, cfg=None):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._stt_stream = session
        bridge._stt_stream_cfg = cfg or SttConfig(
            mode="dashscope",
            api_key="key",
            api_model=_FUN_ASR_REALTIME_DEFAULT,
            flash_model=_FUN_ASR_FLASH_DEFAULT,
            flash_refine_enabled=True,
        )
        return bridge

    async def test_stream_start_uses_selected_realtime_model_and_captures_for_flash(self):
        created = {}

        class FakeRealtimeSession:
            def __init__(self, *args, **kwargs):
                created["args"] = args
                created["kwargs"] = kwargs

            async def start(self):
                created["started"] = True

        cfg = SttConfig(
            mode="dashscope",
            api_key="key",
            api_model="legacy-model",
            flash_refine_enabled=True,
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._stt_stream = None
        bridge._stt_stream_cfg = None

        with (
            patch.object(stt_service, "load_stt_config", return_value=cfg),
            patch.object(stt_service, "SttRealtimeSession", FakeRealtimeSession),
        ):
            payload = json.loads(await bridge._rpc_sttStreamStart())

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["model"], _FUN_ASR_REALTIME_DEFAULT)
        self.assertEqual(created["args"][1], _FUN_ASR_REALTIME_DEFAULT)
        self.assertTrue(created["kwargs"]["capture_audio"])
        self.assertTrue(created["started"])

    async def test_flash_success_replaces_realtime_result(self):
        bridge = self._bridge_with_stream(_FakeStreamSession())

        with patch.object(
            stt_service,
            "transcribe_fun_asr_flash",
            new=AsyncMock(return_value="Flash 精校结果"),
        ):
            payload = json.loads(await bridge._rpc_sttStreamStop())

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["refinedByFlash"])
        self.assertEqual(payload["text"], "Flash 精校结果")

    async def test_flash_failure_falls_back_to_realtime_result(self):
        bridge = self._bridge_with_stream(_FakeStreamSession())

        with patch.object(
            stt_service,
            "transcribe_fun_asr_flash",
            new=AsyncMock(side_effect=RuntimeError("flash unavailable")),
        ):
            payload = json.loads(await bridge._rpc_sttStreamStop())

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["refinedByFlash"])
        self.assertEqual(payload["text"], "实时识别结果")
        self.assertEqual(payload["refineError"], "flash unavailable")

    async def test_over_five_minutes_skips_flash_and_keeps_realtime_result(self):
        bridge = self._bridge_with_stream(
            _FakeStreamSession(overflow=True),
        )
        flash = AsyncMock(return_value="不应调用")

        with patch.object(
            stt_service,
            "transcribe_fun_asr_flash",
            new=flash,
        ):
            payload = json.loads(await bridge._rpc_sttStreamStop())

        flash.assert_not_awaited()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["text"], "实时识别结果")
        self.assertIn("超过 5 分钟", payload["refineSkipped"])


if __name__ == "__main__":
    unittest.main()
