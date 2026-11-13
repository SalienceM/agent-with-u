import asyncio
import json
import os
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
    def setUp(self):
        bypass = patch.dict(os.environ, {'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'})
        bypass.start()
        self.addCleanup(bypass.stop)

    async def test_events_merge_partial_and_final_transcripts(self):
        updates = []
        session = FunAsrRealtimeSession(
            "key",
            _FUN_ASR_REALTIME_DEFAULT,
            "zh",
            lambda text, final: updates.append((text, final)),
        )

        session._handle_sentence({"text": "你好"})
        session._handle_sentence({
            "text": "你好啊",
            "end_time": 1200,
        })
        session._handle_sentence({"text": "世界"})
        session._handle_sentence({
            "text": "世界",
            "sentence_end": True,
        })

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
        session._ws = AsyncMock()

        await session.send_audio(b"1234")
        await session.send_audio(b"56")

        self.assertTrue(session.capture_overflow)
        self.assertEqual(session.captured_pcm(), b"")
        self.assertEqual([call.args[0] for call in session._ws.send.await_args_list], [b"1234", b"56"])

    async def test_pcm_diagnostics_distinguish_silence_without_changing_audio(self):
        session = FunAsrRealtimeSession('key', _FUN_ASR_REALTIME_DEFAULT, 'zh', lambda *_: None)
        session._ws = AsyncMock()
        await session.send_audio(b'\0' * 3200)
        self.assertFalse(session.has_audio_signal)
        await session.send_audio(b'\x00\x10\x00\xf0')
        self.assertTrue(session.has_audio_signal)
        self.assertEqual(session._audio_peak, 4096)
        self.assertEqual(session._audio_energy, 2 * 4096 * 4096)
        self.assertEqual(session._audio_samples, 1602)
        self.assertEqual(session._ws.send.await_args.args[0], b'\x00\x10\x00\xf0')

    async def test_duplex_returns_partial_before_stop_and_preserves_last_unfinished_sentence(self):
        from websockets.asyncio.server import serve
        frames, actions, updates = [], [], []
        first_text = asyncio.Event()

        async def server(ws):
            request = json.loads(await ws.recv())
            actions.append(request)
            tid = request['header']['task_id']
            def event(name, payload, task_id=tid):
                return json.dumps({'header': {'event': name, 'task_id': task_id}, 'payload': payload})
            await ws.send(event('task-started', {}))
            async for raw in ws:
                if isinstance(raw, bytes):
                    frames.append(raw)
                    await ws.send(event('result-generated', {'output': {'sentence': {'text': 'wrong'}}}, 'other-task'))
                    await ws.send(event('result-generated', {'output': {'sentence': {'text': '第一句。', 'end_time': 200}}}))
                    await ws.send(event('result-generated', {'output': {'sentence': {'text': '还没说完'}}}))
                else:
                    actions.append(json.loads(raw))
                    await ws.send(event('task-finished', {}))
                    break

        def text(value, final):
            updates.append((value, final))
            if value.endswith('还没说完'):
                first_text.set()

        async with serve(server, '127.0.0.1', 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            session = FunAsrRealtimeSession('test-key', _FUN_ASR_REALTIME_DEFAULT, 'zh', text,
                                            api_base_url=f'http://127.0.0.1:{port}', capture_audio=True)
            await session.start()
            try:
                await session.send_audio(b'\x01\x02' * 1600)
                await asyncio.wait_for(first_text.wait(), 2)
                self.assertEqual(len(actions), 1, '必须在 finish-task 之前显示中间结果')
                self.assertEqual(updates, [('第一句。', True), ('第一句。还没说完', False)])
            finally:
                result = await session.stop()
            self.assertEqual(result, '第一句。还没说完')
            self.assertEqual(b''.join(frames), session.captured_pcm())
            self.assertEqual([item['header']['action'] for item in actions], ['run-task', 'finish-task'])
            self.assertEqual(actions[0]['payload']['parameters']['sample_rate'], 16000)
            self.assertTrue(session._listener_task.done())

    async def test_send_failure_is_reported_and_connection_closed(self):
        ended = []
        session = FunAsrRealtimeSession('key', _FUN_ASR_REALTIME_DEFAULT, 'zh', lambda *_: None, lambda: ended.append(True))
        socket = session._ws = AsyncMock()
        socket.send.side_effect = OSError('test disconnect')
        with self.assertRaisesRegex(RuntimeError, '发送失败'):
            await session.send_audio(b'12')
        self.assertEqual(ended, [True])
        socket.close.assert_awaited()
        with self.assertRaisesRegex(RuntimeError, '发送失败'):
            await session.stop()

    async def test_server_rejection_leaves_no_live_connection(self):
        from websockets.asyncio.server import serve
        async def server(ws):
            request = json.loads(await ws.recv())
            await ws.send(json.dumps({'header': {'task_id': request['header']['task_id'], 'event': 'task-failed',
                                                'error_code': 'EmptyAudio', 'error_message': 'EmptyAudio'}}))
            await ws.wait_closed()
        async with serve(server, '127.0.0.1', 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            session = FunAsrRealtimeSession('test-key', _FUN_ASR_REALTIME_DEFAULT, 'zh', lambda *_: None,
                                            api_base_url=f'http://127.0.0.1:{port}')
            with self.assertRaisesRegex(RuntimeError, 'EmptyAudio'):
                await session.start()
            self.assertIsNone(session._ws)
            self.assertTrue(session._listener_task.done())

    async def test_flash_rejects_audio_over_five_minutes_before_upload(self):
        too_long_pcm = b"\x00\x00" * (16000 * 300 + 1)

        with self.assertRaisesRegex(ValueError, "5 分钟"):
            await transcribe_fun_asr_flash(
                too_long_pcm,
                api_key="key",
            )


class BridgeSttFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_silent_microphone_does_not_request_flash_or_claim_transcription(self):
        session = _FakeStreamSession(text='', pcm=b'\0' * 3200)
        session.has_audio_signal = False
        bridge = self._bridge_with_stream(session)
        with patch.object(stt_service, 'transcribe_fun_asr_flash', new_callable=AsyncMock) as flash:
            result = json.loads(await bridge._rpc_sttStreamStop())
        self.assertFalse(result['ok'])
        self.assertIn('没有采到麦克风声音', result['error'])
        flash.assert_not_awaited()

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
