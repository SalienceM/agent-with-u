import asyncio
import contextvars
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from src.backend.claude_agent import ClaudeAgentBackend
from src.backend.claude_code import ClaudeCodeOfficialBackend
from src.backend.claude_user_interactions import claude_question_input
from src.types import BackendType, ModelBackendConfig


class ClaudeQuestions(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_callback_crosses_thread_and_returns_updated_input(self):
        import claude_agent_sdk as sdk
        main_thread = threading.get_ident()
        owner = contextvars.ContextVar('test_owner', default='missing')
        owner.set('fixture-owner')
        inputs, decisions = [], []
        async def fake_query(*, prompt, options):
            self.assertNotEqual(threading.get_ident(), main_thread)
            self.assertEqual(owner.get(), 'missing')
            self.assertEqual(options.permission_mode, 'default')
            self.assertNotIn('AskUserQuestion', options.allowed_tools)
            async for packet in prompt: inputs.append(packet)
            hook = await options.hooks['PreToolUse'][0].hooks[0]({}, None, None)
            self.assertEqual(hook['hookSpecificOutput']['permissionDecision'], 'ask')
            result = await options.can_use_tool('AskUserQuestion', {'questions': [
                {'question': 'Choose', 'header': 'Mode', 'options': [{'label': 'A'}, {'label': 'B'}], 'multiSelect': True}]},
                sdk.ToolPermissionContext(tool_use_id='native-tool'))
            decisions.append(result)
            yield type('ResultMessage', (), {'session_id': 'sdk-native', 'is_error': False, 'subtype': 'success'})()
        async def answer(request):
            self.assertEqual(threading.get_ident(), main_thread)
            self.assertEqual(owner.get(), 'fixture-owner')
            self.assertEqual(request.native_request_id, 'native-tool')
            return {'kind': 'answers', 'answers': {'q1': ['A', 'B']}}
        backend = ClaudeAgentBackend(ModelBackendConfig(id='c', type=BackendType.CLAUDE_AGENT_SDK, label='C'))
        with tempfile.TemporaryDirectory() as cwd, patch.object(sdk, 'query', fake_query), patch.object(backend, 'get_env', return_value=None):
            await backend.send_message(messages=[], content='test', images=None, session_id='s', message_id='m',
                on_delta=lambda d: None, working_dir=cwd, on_user_interaction=answer, skip_permissions=True, sandbox_enabled=False)
        self.assertEqual(inputs[0]['message']['content'], 'test')
        self.assertIsInstance(decisions[0], sdk.PermissionResultAllow)
        self.assertEqual(decisions[0].updated_input['answers'], {'Choose': 'A, B'})

    async def test_cli_bidirectional_control_keeps_stdin_open(self):
        backend = ClaudeCodeOfficialBackend(ModelBackendConfig(id='c', type=BackendType.CLAUDE_CODE_OFFICIAL, label='C'))
        deltas, receipts = [], []
        async def answer(request):
            request.acknowledge = lambda success: receipts.append((success, request.receipt_level))
            return {'kind': 'answers', 'answers': {'q1': ['A', 'B']}}
        fixture = Path(__file__).parent / 'fixtures/claude_question_cli.py'
        with tempfile.TemporaryDirectory() as cwd, patch.object(backend, '_build_cmd', return_value=[sys.executable, '-u', str(fixture.resolve())]), patch.object(backend, '_build_env', return_value={'SystemRoot': os.environ.get('SystemRoot', '')}):
            result = await asyncio.wait_for(backend.send_message(messages=[], content='test', images=None, session_id='s', message_id='m',
                on_delta=deltas.append, working_dir=cwd, on_user_interaction=answer, sandbox_enabled=False), 5)
        self.assertEqual(result['agentSessionId'], 'isolated-native')
        self.assertTrue(any(d.text == 'answer-consumed' for d in deltas))
        self.assertEqual(receipts, [(True, 'transport_write')])

    async def test_cancel_never_allows_empty_answers_and_transport_failure_is_unknown(self):
        receipts = []
        async def answer(request):
            request.acknowledge = receipts.append
            return {'kind': 'cancelled'}
        async def failed(_updated):
            raise ConnectionError('lost')
        with self.assertRaises(ConnectionError):
            await claude_question_input({'questions': [{'question': 'Where?'}]}, 'id', session_id='s', message_id='m',
                callback=answer, cancelled=lambda: False, deliver=failed)
        self.assertEqual(receipts, [False])
