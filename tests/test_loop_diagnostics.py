import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS, _LoopAgentStalledError
from src.backend.base import StreamDelta
from src.backend.loop_store import LoopState, LoopRecord
from src.backend.loop_diagnostics import LoopCallDiagnostics, error_evidence
from src.backend.openai_compat import OpenAICompatibleBackend
from src.types import ModelBackendConfig, BackendType


class LoopDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def bridge_case(self, backend):
        record = LoopRecord(seq=1)
        state = LoopState(session_id='s', loops=[record])
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_states = {'s': state}
        bridge._loop_active_backends = {}
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._send_for_session = AsyncMock()
        bridge._prepare_session_skills = AsyncMock()
        bridge._build_session_reference_context = lambda prompt, _sid: prompt + ' reference'
        bridge._new_backend_instance = lambda _id: backend
        bridge._add_runtime_kwargs = Mock()
        bridge._record_session_usage = Mock()
        bridge._emit_loop_progress = Mock()
        bridge._session_store = SimpleNamespace(save=Mock())
        session = SimpleNamespace(id='s', backend_id='worker', working_dir='.', sandbox_enabled=False, agent_session_id=None)
        return bridge, session, record

    async def test_real_call_boundary_captures_request_and_final_usage_without_changing_output(self):
        class Backend:
            config = SimpleNamespace(type='openai-compatible', model='fixture')
            async def send_message(self, **kw):
                kw['on_delta'](StreamDelta('s', 'm', 'thinking', text='not stored'))
                kw['on_delta'](StreamDelta('s', 'm', 'text_delta', text='plan'))
                kw['on_delta'](StreamDelta('s', 'm', 'done', usage={'inputTokens': 50, 'outputTokens': 10}))
                return {}
            def clear_cancelled(self, _sid):
                pass

        bridge, session, record = self.bridge_case(Backend())
        result = await bridge._loop_run_agent(session, 'prompt', 'prepare', 1, resume=False)
        await asyncio.sleep(0)
        self.assertEqual(result, ('plan', None))
        diag = record.call_diagnostics[0]
        self.assertEqual(diag['promptChars'], len('prompt reference'))
        self.assertEqual(diag['model'], 'fixture')
        self.assertEqual(diag['status'], 'done')
        self.assertEqual(diag['usage'], {'inputTokens': 50, 'outputTokens': 10})
        self.assertIn('localPrepareMs', diag)
        self.assertGreaterEqual(diag['firstTextAt'], diag['dispatchedAt'])
        self.assertEqual(bridge._record_session_usage.call_args.kwargs['usage']['inputTokens'], 50)
        self.assertNotIn('not stored', json.dumps(record.to_dict()))

    async def test_diagnostic_retry_heartbeats_cannot_defeat_inactivity_timeout(self):
        class Backend:
            aborted = False
            async def send_message(self, **kw):
                while True:
                    kw['on_delta'](StreamDelta('s', 'm', 'diagnostic', diagnostic={'phase': 'retry_wait', 'delaySeconds': 1}))
                    await asyncio.sleep(0.01)
            def clear_cancelled(self, _sid):
                pass
            def abort(self, _sid):
                self.aborted = True

        backend = Backend()
        bridge, session, record = self.bridge_case(backend)
        with self.assertRaises(_LoopAgentStalledError):
            await bridge._loop_run_agent(session, 'prompt', 'prepare', 1, resume=False, inactivity_timeout=0.05)
        await asyncio.sleep(0)
        self.assertTrue(backend.aborted)
        self.assertEqual(record.call_diagnostics[0]['status'], 'stalled')
        self.assertNotIn('firstEventAt', record.call_diagnostics[0])

    async def test_timing_thinking_and_bounded_content_free_pushes(self):
        pushes, saves = [], Mock()
        diag = LoopCallDiagnostics('id', 'prepare', 'secret prompt', pushes.append, saves)
        diag.mark('local_prepare')
        diag.mark('backend_dispatch', dispatchedAt=diag.data['startedAt'] + 0.01)
        for _ in range(100):
            diag.observe(StreamDelta('s', 'm', 'thinking', text='private thinking'))
        self.assertEqual(len(pushes), 1)
        self.assertNotIn('firstTextAt', diag.data)
        self.assertEqual(diag.data['eventCounts']['thinking'], 100)
        diag.observe(StreamDelta('s', 'm', 'text_delta', text='answer'))
        diag.finish()
        self.assertEqual(diag.data['status'], 'done')
        self.assertLessEqual(diag.data['firstEventAt'], diag.data['firstTextAt'])
        self.assertNotIn('private thinking', json.dumps(diag.data))
        self.assertNotIn('secret prompt', json.dumps(diag.data))
        self.assertEqual(len(pushes), 2)
        self.assertIsNone(diag._timer)
        for _ in range(50):
            diag.observe(StreamDelta('s', 'm', 'error', error='late orphan'))
        self.assertEqual(diag.data['status'], 'done')

    async def test_retry_evidence_not_first_model_response_and_no_credentials(self):
        diag = LoopCallDiagnostics('id', 'prepare', '', Mock(), Mock())
        for _ in range(30):
            diag.observe(StreamDelta('s', 'm', 'diagnostic', diagnostic={'phase': 'response_headers', 'httpStatus': 429}))
            diag.observe(StreamDelta('s', 'm', 'diagnostic', diagnostic={'phase': 'retry_wait',
                'delaySeconds': 8, 'category': 'rate_limit', 'password': 'never persist'}))
        self.assertNotIn('firstEventAt', diag.data)
        self.assertEqual(diag.data['retryCount'], 30)
        self.assertEqual(diag.data['retryWaitSeconds'], 240)
        self.assertLessEqual(len(diag.data['timeline']), 32)
        diag.fail('HTTP 429 https://secret:password@private/path?api_key=secret')
        diag.finish()
        self.assertEqual(diag.data['lastError'], {'category': 'rate_limit', 'httpStatus': 429})
        self.assertNotIn('secret', json.dumps(diag.data))
        self.assertEqual(error_evidence('very slow')['category'], 'unknown')
        self.assertEqual(error_evidence('concurrent requests exceeded')['category'], 'concurrency')

    async def test_bridge_persists_error_cancel_and_compact_latest_only(self):
        record = LoopRecord(seq=1)
        state = LoopState(session_id='s', loops=[record])
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_states = {'s': state}
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._send_for_session = AsyncMock()
        session = SimpleNamespace(id='s')

        async def call(*_args, _diagnostic, **_kwargs):
            _diagnostic.fail('429 api_key=do-not-store')
            return '', None  # Existing backend recovery returns empty text; diagnostics still says error.

        bridge._loop_run_agent_impl = call
        self.assertEqual(await bridge._loop_run_agent(session, 'private', 'prepare', 1), ('', None))
        self.assertEqual(record.call_diagnostics[0]['status'], 'error')

        async def cancelled(*_args, **_kwargs):
            raise asyncio.CancelledError()

        bridge._loop_run_agent_impl = cancelled
        with self.assertRaises(asyncio.CancelledError):
            await bridge._loop_run_agent(session, '', 'prepare', 1)
        await asyncio.sleep(0)
        self.assertEqual(record.call_diagnostics[-1]['status'], 'cancelled')
        self.assertEqual(LoopRecord.from_dict(record.to_dict()).call_diagnostics, record.call_diagnostics)
        bridge._loop_is_running = lambda _sid: False
        compact = bridge._loop_payload(state, compact=True)
        self.assertEqual(len(compact['loops'][0]['callDiagnostics']), 1)
        self.assertEqual(len(record.call_diagnostics), 2)
        self.assertLess(len(json.dumps(compact)), 10_000)

    async def test_openai_429_retry_is_visible_before_text_and_recovers(self):
        class Response:
            def __init__(self, status):
                self.status_code = status
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_args):
                pass
            async def aiter_lines(self):
                yield 'data: ' + json.dumps({'choices': [{'delta': {'reasoning_content': 'thinking'}}]})
                yield 'data: ' + json.dumps({'choices': [{'delta': {'content': 'plan'}}]})
                yield 'data: [DONE]'

        class Client:
            responses = [Response(429), Response(200)]
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_args):
                pass
            def stream(self, *_args, **_kwargs):
                return self.responses.pop(0)

        config = ModelBackendConfig(id='test', label='test', type=BackendType.OPENAI_COMPATIBLE, model='fixture')
        backend = OpenAICompatibleBackend(config)
        deltas = []
        with patch('src.backend.openai_compat.httpx.AsyncClient', return_value=Client()), \
             patch('src.backend.openai_compat.asyncio.sleep', new=AsyncMock()), \
             patch('src.backend.openai_compat.print'):
            await backend.send_message([], 'hello', None, 's', 'm', deltas.append)
        meta = [d.diagnostic for d in deltas if d.type == 'diagnostic']
        self.assertEqual([d['phase'] for d in meta], ['request', 'response_headers', 'retry_wait', 'request', 'response_headers'])
        self.assertEqual(meta[1]['httpStatus'], 429)
        self.assertEqual(meta[2]['delaySeconds'], 1)
        self.assertTrue(any(d.type == 'thinking' for d in deltas))
        self.assertFalse(any(d.type == 'error' for d in deltas))
