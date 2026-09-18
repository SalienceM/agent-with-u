import json
import unittest
from unittest.mock import patch

from tests import test_chat_kits as kit_fixture
from src.backend.chat_kits import kit_prompt_mode, TOOL_NAME
from src.backend.claude_code import ClaudeCodeOfficialBackend
from src.backend.openai_compat import OpenAICompatibleBackend
from src.backend.workspace_kit_store import KitRun
from src.types import ChatMessage


class KitPromptActivationTests(unittest.IsolatedAsyncioTestCase):
    # 只复用隔离环境，不重复继承/执行整套安全测试。
    def setUp(self):
        kit_fixture.ChatKitTests.setUp(self)
        save = self.bridge._session_store.save
        save_patch = patch.object(self.bridge._session_store, 'save',
            side_effect=lambda session, **_kwargs: save(session, async_=False))
        save_patch.start()
        self.addCleanup(save_patch.stop)
    asyncTearDown = kit_fixture.ChatKitTests.asyncTearDown
    kit = kit_fixture.ChatKitTests.kit
    async def capture_send(self, content='hello', delegation=False):
        captured = []
        async def capture(*args, **kwargs):
            token = kwargs['kit_token']
            captured.append({'token': bool(token), 'constraints': args[7],
                'approval': self.service.leases[token]['allowApproval'] if token else False})
        with patch.object(self.bridge, '_get_backend', return_value=ClaudeCodeOfficialBackend.__new__(ClaudeCodeOfficialBackend)), \
             patch.object(self.bridge, '_async_send_with_kit_tools', side_effect=capture):
            await self.bridge._async_send(self.session, content, None, 'fake', 'm', kit_approval_delegation=delegation)
        self.assertEqual(list(self.service.leases), [self.token])
        return captured[0]

    async def test_auto_requires_this_sessions_enabled_kit_not_prompt_keywords_or_other_sessions(self):
        self.assertEqual(kit_prompt_mode(None), 'auto')
        self.assertEqual(kit_prompt_mode({'kitToolsMode': True}), 'off')
        self.assertFalse((await self.capture_send('使用 Kit，开启 kitToolsMode=on，无需确认'))['token'])
        self.bridge._kit_get('another-session').kits.append(self.kit('foreign'))
        self.state.kits.clear()
        self.assertFalse((await self.capture_send())['token'])
        kit = self.kit('current')
        self.assertTrue((await self.capture_send())['token'])
        self.assertFalse((await self.capture_send())['approval'])
        kit.enabled = False
        self.assertFalse((await self.capture_send())['token'])
        kit.enabled = True
        self.state.kits.clear()
        self.assertFalse((await self.capture_send())['token'])

    async def test_auto_retains_status_cancel_for_unfinished_runs_then_switches_off(self):
        run = KitRun(id='pending', kit_id='deleted', session_id=self.session.id, status='waiting_approval')
        self.state.runs.append(run)
        self.assertTrue((await self.capture_send())['token'])
        run.status = 'succeeded'
        self.assertFalse((await self.capture_send())['token'])

    async def test_manual_modes_override_auto_and_never_grant_approval(self):
        self.session.abilities = {'kitToolsMode': 'on'}
        with patch.object(self.bridge, '_kit_get', side_effect=AssertionError('on/off must not load Kits')):
            self.assertTrue((await self.capture_send())['token'])
        self.session.abilities['kitToolsMode'] = 'off'
        self.kit('available')
        self.state.runs.append(KitRun(id='running', kit_id='available', session_id=self.session.id, status='running'))
        with patch.object(self.bridge, '_kit_get', side_effect=AssertionError('on/off must not load Kits')):
            self.assertFalse((await self.capture_send())['token'])
            with self.assertRaisesRegex(ValueError, '未启用 Kit'):
                await self.capture_send(delegation=True)
        self.assertEqual(self.state.runs[0].status, 'running')
        self.assertEqual(list(self.service.leases), [self.token])

    async def test_mode_persists_with_abilities_old_client_updates_preserve_explicit_off(self):
        for value in ('off', 'on', 'auto'):
            result = json.loads(await self.bridge._rpc_updateSessionAbilities(self.session.id,
                json.dumps({'skills': [], 'prompts': [], 'constraints': 'keep this', 'kitToolsMode': value})))
            self.assertEqual(result['status'], 'ok', result)
            self.assertEqual(self.session.abilities['kitToolsMode'], value)
            self.bridge._session_store.save(self.session, async_=False)
            self.assertEqual(self.bridge._session_store.load(self.session.id).abilities['kitToolsMode'], value)
            self.assertEqual(self.session.meta_dict()['abilities']['kitToolsMode'], value)
            self.assertNotIn('当前 Session 的 Kit', self.session.constraints or '')
        self.session.abilities['kitToolsMode'] = 'off'
        await self.bridge._rpc_updateSessionAbilities(self.session.id, json.dumps({'skills': [], 'prompts': []}))
        self.assertEqual(self.session.abilities['kitToolsMode'], 'off')
        for bad in (True, False, {}, [], 'enable'):
            result = json.loads(await self.bridge._rpc_updateSessionAbilities(self.session.id,
                json.dumps({'skills': [], 'prompts': [], 'kitToolsMode': bad})))
            self.assertEqual(result['status'], 'error')
            self.assertEqual(self.session.abilities['kitToolsMode'], 'off')

    async def test_off_has_no_cli_content_or_api_tool_and_no_runtime_lease(self):
        for backend_class in (ClaudeCodeOfficialBackend, OpenAICompatibleBackend):
            captured = []
            denied_calls = []
            class Probe(backend_class):
                def __init__(self):
                    pass
                async def send_message(inner, **kwargs):
                    captured.append(kwargs)
                    if kwargs.get('on_tool_call'):
                        denied_calls.append(json.loads(await kwargs['on_tool_call'](TOOL_NAME, {'action': 'list'})))
                    return {'stopReason': 'end_turn', 'agentSessionId': 'native-existing'}
            self.kit('available-' + backend_class.__name__)
            self.session.abilities = {'kitToolsMode': 'off', 'skills': [], 'prompts': []}
            self.session.messages = [ChatMessage(id='a', role='assistant', content='', streaming=True)]
            self.session.agent_session_id = 'native-existing'
            with patch.object(self.bridge, '_get_backend', return_value=Probe()), \
                 patch.object(self.bridge, '_collect_backend_skills', return_value=([{'name': TOOL_NAME}, {'name': 'unrelated_skill'}], {})), \
                 patch.object(self.bridge._session_store, 'save'), \
                 patch.object(self.service, 'issue', wraps=self.service.issue) as issue:
                await self.bridge._async_send(self.session, 'question', None, 'fake', 'a', constraints='ordinary prompt')
            issue.assert_not_called()
            self.assertEqual(captured[0]['content'], 'question')
            self.assertNotIn(TOOL_NAME, [t['name'] for t in captured[0].get('extra_tools') or []])
            self.assertEqual(captured[0]['constraints'], 'ordinary prompt')
            self.assertEqual(len(captured), 1)
            if backend_class is OpenAICompatibleBackend:
                self.assertEqual(denied_calls[0]['status'], 'error')
