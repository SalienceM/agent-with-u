import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.openai_compat import OpenAICompatibleBackend
from src.backend.anthropic_api import AnthropicAPIBackend
from src.types import ModelBackendConfig, BackendType
from tests.test_provider_usage import FakeClient, TOOLS, noop_tool


QUESTIONS = {'questions': [{'id': 'q', 'question': 'Choose', 'options': [{'id': 'a', 'label': 'A'}]}]}


class ApiQuestions(unittest.IsolatedAsyncioTestCase):
    async def answer(self, request):
        self.seen.append(request.native_request_id)
        self.assertEqual(request.skip_response, {'status': 'skipped'})
        return {'kind': 'answers', 'answers': {'q': ['a']}}

    async def test_openai_multiple_tools_return_to_same_call(self):
        self.seen = []
        client = FakeClient([[{'choices': [{'delta': {'tool_calls': [
            {'index': i, 'id': f'call-{i}', 'function': {'name': 'awu_ask_user', 'arguments': json.dumps(QUESTIONS)}}
            for i in range(2)]}, 'finish_reason': 'tool_calls'}]}], [{'choices': [{'delta': {'content': 'ok'}, 'finish_reason': 'stop'}]}]])
        backend = OpenAICompatibleBackend(ModelBackendConfig(id='o', type=BackendType.OPENAI_COMPATIBLE, label='O', base_url='https://fixture.invalid/v1'))
        deltas = []
        with patch('src.backend.openai_compat.httpx.AsyncClient', return_value=client):
            await backend.send_message([], 'test', None, 's', 'm', deltas.append, extra_tools=TOOLS,
                                       on_tool_call=noop_tool, on_user_interaction=self.answer)
        self.assertEqual(self.seen, ['call-0', 'call-1'])
        results = [m for m in client.requests[-1]['messages'] if m['role'] == 'tool']
        self.assertEqual([m['tool_call_id'] for m in results], self.seen)
        self.assertTrue(all(json.loads(m['content']) == {'status': 'answered', 'answers': {'q': ['a']}} for m in results))
        self.assertFalse([d for d in deltas if d.type == 'error'])

    async def test_anthropic_proxy_answers_are_tool_use_results(self):
        self.seen = []
        frames = []
        for index in range(2):
            frames.extend([{'type': 'content_block_start', 'index': index, 'content_block': {'type': 'tool_use', 'id': f'call-{index}', 'name': 'awu_ask_user'}},
                           {'type': 'content_block_delta', 'index': index, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(QUESTIONS)}}])
        frames.append({'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}})
        client = FakeClient([frames, [{'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}]])
        backend = AnthropicAPIBackend(ModelBackendConfig(id='a', type=BackendType.ANTHROPIC_API, label='A', base_url='https://fixture.invalid'))
        deltas = []
        with patch('src.backend.anthropic_api.httpx.AsyncClient', return_value=client), patch.dict('sys.modules', {'anthropic': SimpleNamespace()}), patch.object(backend, 'get_env', return_value=None):
            await backend.send_message([], 'test', None, 's', 'm', deltas.append, extra_tools=TOOLS,
                                       on_tool_call=noop_tool, on_user_interaction=self.answer)
        self.assertEqual(self.seen, ['call-0', 'call-1'])
        results = client.requests[-1]['messages'][-1]['content']
        self.assertEqual([m['tool_use_id'] for m in results], self.seen)
        self.assertFalse([d for d in deltas if d.type == 'error'])

    async def test_plain_chat_poe_and_text_only_have_no_question_tool(self):
        for url, tools, text_only in [('https://fixture.invalid', None, False),
                                     ('https://api.poe.com/v1', TOOLS, False),
                                     ('https://fixture.invalid', TOOLS, True)]:
            client = FakeClient([[{'choices': [{'delta': {'content': 'ok'}, 'finish_reason': 'stop'}]}]])
            backend = OpenAICompatibleBackend(ModelBackendConfig(id='o', type=BackendType.OPENAI_COMPATIBLE, label='O', base_url=url))
            with patch('src.backend.openai_compat.httpx.AsyncClient', return_value=client):
                await backend.send_message([], 'test', None, 's', 'm', lambda d: None, extra_tools=tools,
                    on_tool_call=noop_tool, on_user_interaction=self.answer, text_only=text_only)
            self.assertNotIn('awu_ask_user', str(client.requests[0].get('tools', [])))

    async def test_anthropic_sdk_branch_consumes_same_call_answer(self):
        self.seen = []
        requests = []
        def event(class_name, **fields):
            return type(class_name, (), fields)()
        class Stream:
            def __init__(self, index): self.index = index
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): pass
            async def __aiter__(self):
                if self.index == 0:
                    yield event('RawContentBlockStartEvent', content_block=event('ToolUseBlock', id='sdk-question', name='awu_ask_user'))
                    yield event('RawContentBlockDeltaEvent', delta=event('InputJSONDelta', type='input_json_delta', partial_json=json.dumps(QUESTIONS)))
                yield event('RawMessageDeltaEvent', delta=SimpleNamespace(stop_reason='tool_use' if self.index == 0 else 'end_turn'), usage=SimpleNamespace(output_tokens=1))
        def stream(**kwargs):
            requests.append(kwargs)
            return Stream(len(requests) - 1)
        sdk = SimpleNamespace(AsyncAnthropic=lambda **kwargs: SimpleNamespace(messages=SimpleNamespace(stream=stream)), NOT_GIVEN=object())
        backend = AnthropicAPIBackend(ModelBackendConfig(id='a', type=BackendType.ANTHROPIC_API, label='A'))
        deltas = []
        with patch.dict('sys.modules', {'anthropic': sdk}), patch.object(backend, 'get_env', return_value=None):
            await backend.send_message([], 'test', None, 's', 'm', deltas.append, extra_tools=TOOLS,
                on_tool_call=noop_tool, on_user_interaction=self.answer)
        self.assertEqual(self.seen, ['sdk-question'])
        self.assertEqual(requests[-1]['messages'][-1]['content'][0]['tool_use_id'], 'sdk-question')
        self.assertFalse([d for d in deltas if d.type == 'error'])
