import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.followup_suggestions import FollowupSuggestions, suggestion_material
from src.backend.session_collaboration_store import CollaborationScope, CollaborationStore
from src.backend.token_usage import record_session_usage, usage_summary
from src.types import Session, ChatMessage, ModelBackendConfig, BackendType
from src.backend.base import StreamDelta


class SuggestionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.scope = CollaborationScope('test', 'executor')
        self.store = CollaborationStore(Path(self.temp.name) / 'collaboration.db')
        self.bridge = FollowupSuggestions()
        self.session = Session(id='s', title='test', created_at=1, updated_at=1, messages=[], working_dir=self.temp.name, owner_id='test', backend_id='fake')
        self.message = ChatMessage(id='answer', role='assistant', content='可以先核对两个目录的差异。')
        self.session.messages = [ChatMessage(id='user', role='user', content='【当前 Session 的 Kit 调用工具】secret\n【用户本轮请求】比较两个目录'), self.message]
        self.bridge._collaboration_session = lambda sid: self.session
        self.bridge._collaboration_scope = lambda sid: self.scope
        self.bridge._collaboration_store = lambda: self.store
        self.bridge._window_guard = Mock()
        self.bridge._session_store = SimpleNamespace(save=Mock())
        self.bridge._emit_event = Mock()
        self.bridge._emit_session_updated = Mock()
        self.bridge._backend_configs = [ModelBackendConfig('fake', BackendType.OPENAI_COMPATIBLE, 'main'),
                                        ModelBackendConfig('light', BackendType.CODEX_OFFICIAL, 'lightweight')]
        self.bridge._new_backend_instance = Mock(return_value=SimpleNamespace(config=SimpleNamespace(type='openai-compatible')))
        self.bridge._record_session_usage = lambda session, **kwargs: record_session_usage(session, **kwargs)

    def start(self, success=True):
        self.bridge._completed_followup(self.session, self.message, success, 'fake', {'model': 'chosen'})

    async def wait(self):
        await asyncio.gather(*(entry['task'] for entry in self.bridge._followup_slots().values()))

    async def test_off_history_failure_and_dedup_use_no_extra_call(self):
        async def fake(backend, **kwargs):
            self.assertLessEqual(len(kwargs['content']), 8000)
            self.assertNotIn('secret', kwargs['content'])
            self.assertNotIn('agent_session_id', kwargs)
            self.assertNotIn('skip_permissions', kwargs)
            self.assertEqual(kwargs['model_override'], 'chosen')
            kwargs['on_delta'](StreamDelta('aux', 'aux', 'text_delta', text='请列出需要核对的目录。'))
        with patch('src.backend.followup_suggestions.send_text_only', side_effect=fake) as send:
            self.start()
            self.assertEqual(json.loads(self.bridge._rpc_followupSuggestionSettings('s'))['enabled'], False)
            self.bridge._rpc_followupSuggestionSettings('s', True)
            self.start(False)
            send.assert_not_called()
            self.start(); self.start(); await self.wait()
            send.assert_awaited_once()
            self.bridge._followup_slots().clear()  # 重启等效：既有 request journal 阻止重新生成。
            self.start(); send.assert_awaited_once()
            event = usage_summary(self.session.token_usage)['events'][-1]
            self.assertEqual((event['source'], event['stage'], event['estimated']), ('followup', 'suggestion', True))

    async def test_edit_disable_and_new_turn_cancel_owned_task_and_drop_late_output(self):
        started = asyncio.Event()
        async def stubborn(backend, **kwargs):
            started.set()
            try: await asyncio.sleep(3600)
            except asyncio.CancelledError:
                kwargs['on_delta'](StreamDelta('aux', 'aux', 'text_delta', text='late must be ignored'))
        self.session.followup_suggestions_enabled = True
        with patch('src.backend.followup_suggestions.send_text_only', side_effect=stubborn):
            self.start(); await started.wait()
            entry = self.bridge._followup_slots()['s']
            self.bridge._rpc_followupSuggestionDismiss('s', 'unrelated')
            self.assertFalse(entry['invalid'])
            self.bridge._rpc_followupSuggestionSettings('s', False)
            await entry['task']
            self.assertTrue(entry['invalid'])
            self.assertFalse(any(args[0][1].get('state') == 'ready' for args in self.bridge._emit_event.call_args_list))

    async def test_unsupported_and_failed_calls_do_not_fallback(self):
        self.session.followup_suggestions_enabled = True
        self.bridge._new_backend_instance.return_value.config.type = 'poe-api'
        with patch('src.backend.followup_suggestions.send_text_only') as send:
            self.start(); await self.wait()
            send.assert_not_called()
            self.assertEqual(self.bridge._followup_slots()['s']['view']['state'], 'unavailable')
        self.bridge._new_backend_instance.assert_called_once_with('fake')

    async def test_bounded_material_output_and_independent_usage(self):
        self.session.followup_suggestions_enabled = True
        self.message.content = '正文' * 9000
        self.assertLessEqual(len(suggestion_material(self.session, 'answer')), 8000)
        record_session_usage(self.session, usage={'inputTokens': 100, 'contextTokens': 100}, event_id='main', source='chat', stage='reply', backend_id='fake')
        async def fake(backend, **kwargs):
            kwargs['on_delta'](StreamDelta('aux', 'aux', 'text_delta', text='建议' * 500))
            kwargs['on_delta'](StreamDelta('aux', 'aux', 'done', usage={'inputTokens': 20, 'outputTokens': 5, 'contextTokens': 20}))
        with patch('src.backend.followup_suggestions.send_text_only', side_effect=fake):
            self.start(); await self.wait()
        self.assertEqual(len(self.bridge._followup_slots()['s']['view']['text']), 300)
        summary = usage_summary(self.session.token_usage)
        self.assertEqual(summary['latestContext']['contextTokens'], 100)
        self.assertEqual(summary['events'][-1]['source'], 'followup')

    async def test_custom_route_is_persisted_and_does_not_inherit_main_reasoning(self):
        self.session.followup_suggestions_enabled = True
        saved = json.loads(self.bridge._rpc_followupSuggestionSettings('s', None, json.dumps(
            {'backendId': 'light', 'model': 'small-model', 'timeoutSeconds': 60})))
        self.assertEqual(2, saved['version'])
        self.assertEqual('small-model', saved['config']['model'])
        self.assertEqual('fake', self.session.backend_id)
        self.bridge._new_backend_instance.assert_not_called()
        async def fake(backend, **kwargs):
            self.assertEqual('small-model', kwargs['model_override'])
            self.assertIsNone(kwargs['reasoning_effort'])
            kwargs['on_delta'](StreamDelta('aux', 'aux', 'text_delta', text='next'))
        with patch('src.backend.followup_suggestions.send_text_only', side_effect=fake) as send:
            self.bridge._completed_followup(self.session, self.message, True, 'fake', {'model': 'large', 'reasoningEffort': 'high'})
            await self.wait()
            send.assert_awaited_once()
        self.bridge._new_backend_instance.assert_called_once_with('light')
        event = usage_summary(self.session.token_usage)['events'][-1]
        self.assertEqual('light', event['backendId'])
        self.assertEqual('small-model', event['model'])

    async def test_timeout_explains_limit_and_does_not_retry_or_use_partial_output(self):
        self.session.followup_suggestions_enabled = True
        self.session.followup_suggestions_config = {'timeoutSeconds': 60}
        async def fake(backend, **kwargs):
            kwargs['on_delta'](StreamDelta('aux', 'aux', 'text_delta', text='unfinished'))
        async def expired(coro, timeout):
            self.assertEqual(60, timeout)
            await coro
            raise asyncio.TimeoutError()
        with patch('src.backend.followup_suggestions.send_text_only', side_effect=fake) as send, \
                patch('src.backend.followup_suggestions.asyncio.wait_for', side_effect=expired):
            self.start(); await self.wait(); self.start()
            send.assert_awaited_once()
        view = self.bridge._followup_slots()['s']['view']
        self.assertEqual('unavailable', view['state'])
        self.assertEqual('', view['text'])
        self.assertIn('60 秒', view['notice'])
        self.assertIn('建议模型', view['notice'])

    async def test_deleted_backend_never_falls_back_to_main_and_invalid_settings_do_not_save(self):
        self.session.followup_suggestions_enabled = True
        self.session.followup_suggestions_config = {'backendId': 'missing', 'model': 'small'}
        with patch('src.backend.followup_suggestions.send_text_only') as send:
            self.start(); await self.wait(); send.assert_not_called()
        self.bridge._new_backend_instance.assert_not_called()
        self.assertIn('已删除或停用', self.bridge._followup_slots()['s']['view']['notice'])
        for config in ({'backendId': 'missing'}, {'model': 'unsafe\nmodel'}, {'timeoutSeconds': True}, {'timeoutSeconds': 999}, {'reasoningEffort': 'high'}, {'node': 'another'}):
            with self.assertRaises(ValueError): self.bridge._rpc_followupSuggestionSettings('s', None, json.dumps(config))
        self.assertEqual('missing', self.session.followup_suggestions_config['backendId'])

    async def test_setting_change_cancels_inflight_suggestion_without_new_call_and_rolls_back_failed_save(self):
        entered = asyncio.Event()
        async def slow(backend, **kwargs):
            entered.set()
            try: await asyncio.Future()
            except asyncio.CancelledError:
                kwargs['on_delta'](StreamDelta('aux', 'aux', 'text_delta', text='old suggestion'))
        self.session.followup_suggestions_enabled = True
        with patch('src.backend.followup_suggestions.send_text_only', side_effect=slow) as send:
            self.start(); await entered.wait()
            entry = self.bridge._followup_slots()['s']
            self.bridge._rpc_followupSuggestionSettings('s', None, '{"backendId":"light"}')
            await entry['task']; send.assert_awaited_once()
            self.assertTrue(entry['invalid'])
        self.assertFalse(any(call.args[1].get('state') == 'ready' for call in self.bridge._emit_event.call_args_list))
        before = dict(self.session.followup_suggestions_config)
        self.bridge._session_store.save.side_effect = OSError('disk unavailable')
        with self.assertRaises(OSError): self.bridge._rpc_followupSuggestionSettings('s', False, '{}')
        self.assertTrue(self.session.followup_suggestions_enabled)
        self.assertEqual(before, self.session.followup_suggestions_config)
