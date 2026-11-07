import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from src.backend.codex_office import CodexOfficeBackend
from src.types import BackendType, ModelBackendConfig
from tests.test_codex_remote import _FakeAppServer


class QuestionServer(_FakeAppServer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reading = False
        self.messages = [{'id': n, 'method': 'item/tool/requestUserInput', 'params': {
            'threadId': 'remote-thread-1', 'turnId': 'turn-1', 'itemId': f'item{n}', 'isBlocking': True,
            'questions': [{'id': 'choice', 'header': 'Choice', 'question': 'Which?', 'isOther': True,
                           'options': [{'label': 'A', 'description': 'a'}, {'label': 'B', 'description': 'b'}]},
                          {'id': 'path', 'header': 'Path', 'question': 'Where?', 'options': None}]}}
            for n in [10, 20]] + [{'id': 30, 'method': 'item/commandExecution/requestApproval',
                'params': {'threadId': 'remote-thread-1', 'turnId': 'turn-1', 'itemId': 'cmd', 'command': 'echo test'}}]

    async def next_message(self, timeout=None):
        if self.reading:
            raise AssertionError('second stdout reader')
        self.reading = True
        try:
            if self.messages:
                return self.messages.pop(0)
            while len(self.responses) < 3:
                await asyncio.sleep(.001)
            return {'method': 'turn/completed', 'params': {'turn': {'id': 'turn-1', 'status': 'completed'}}}
        finally:
            self.reading = False


class CodexQuestionTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_questions_and_approval_keep_native_ids_and_one_reader(self):
        backend = CodexOfficeBackend(ModelBackendConfig(id='c', type=BackendType.CODEX_OFFICIAL, label='C'))
        seen, acknowledgements, approvals = [], [], []
        both = asyncio.Event()
        async def answer(request):
            seen.append(request)
            request.acknowledge = lambda success: acknowledgements.append(success)
            if len(seen) == 2: both.set()
            await both.wait()
            return {'kind': 'answers', 'answers': {'choice': ['B'], 'path': [f'/work/{request.native_request_id}']}}
        async def approve(request):
            approvals.append(request)
            return True
        deltas = []
        with patch('src.backend.codex_office.CodexAppServerProcess', QuestionServer), patch('src.backend.codex_office.resolve_codex_cli', return_value='codex'):
            await asyncio.wait_for(backend.send_message(messages=[], content='hello', images=None, session_id='s', message_id='m',
                on_delta=deltas.append, app_server_local=True, on_user_interaction=answer, on_permission_request=approve), 3)
        responses = dict(QuestionServer.instances[-1].responses)
        self.assertEqual(responses[10]['result']['answers']['path'], {'answers': ['/work/10']})
        self.assertEqual(responses[20]['result']['answers']['choice'], {'answers': ['B']})
        self.assertEqual(responses[30]['result'], {'decision': 'accept'})
        self.assertEqual(acknowledgements, [True, True])
        self.assertEqual(len(approvals), 1)
        self.assertFalse([d for d in deltas if d.type == 'error'])

    def test_locked_schema_has_no_skip_default_or_multiselect(self):
        root = Path(__file__).parent / 'fixtures/codex-0.166.0'
        params = json.loads((root / 'ToolRequestUserInputParams.json').read_text())
        question = params['definitions']['ToolRequestUserInputQuestion']['properties']
        self.assertIn('isOther', question)
        self.assertIn('isSecret', question)
        self.assertNotIn('multiSelect', question)
        response = json.loads((root / 'ToolRequestUserInputResponse.json').read_text())
        self.assertEqual(response['required'], ['answers'])
        self.assertNotIn('skip', response['properties'])
