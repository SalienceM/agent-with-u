import asyncio
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.text_only import (
    _assistant_text, _codex_connection_config, _copy_auth, _deny_tool, _isolated_env,
    send_text_only, TextOnlyContext,
)
from src.backend.codex_office import CodexOfficeBackend
from src.backend.qwen_code_cli import QwenCodeSdkBackend
from src.backend.claude_agent import ClaudeAgentBackend
from src.types import BackendType, ModelBackendConfig, ImageAttachment


def fixture_image():
    from PIL import Image
    data = io.BytesIO()
    Image.new('RGB', (2, 2), 'white').save(data, format='PNG')
    return ImageAttachment(id='fixture', mime_type='image/png', base64=base64.b64encode(data.getvalue()).decode())


class TextOnlyTests(unittest.IsolatedAsyncioTestCase):
    async def test_codex_visible_deltas_arrive_before_completion_without_duplicate_final(self):
        backend = CodexOfficeBackend(ModelBackendConfig('c', BackendType.CODEX_OFFICIAL, 'c', model='test'))
        events, observed = asyncio.Queue(), asyncio.Event()
        activity, deltas = [], []
        conn = Mock(start=AsyncMock(), close=AsyncMock(), respond=AsyncMock(), proc=None)
        conn.request = AsyncMock(side_effect=[{'thread': {'id': 'isolated'}}, {'data': []}, {}])
        conn.next_message = events.get
        def preview(text, replace=False):
            activity.append((text, replace)); observed.set()
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'CODEX_HOME': root}), \
                patch('src.backend.codex_app_server.CodexAppServerProcess', return_value=conn):
            task = asyncio.create_task(send_text_only(backend, content='review', constraints='restricted',
                session_id='role', message_id='report', on_delta=deltas.append, on_activity=preview))
            try:
                await events.put({'method': 'item/reasoning/textDelta', 'params': {'delta': 'PRIVATE'}})
                await events.put({'method': 'item/agentMessage/delta', 'params': {'delta': '{"summary":'}})
                await asyncio.wait_for(observed.wait(), 2)
                self.assertFalse(task.done())
                self.assertEqual([('{"summary":', False)], activity)
                self.assertEqual([], deltas)
                await events.put({'method': 'item/agentMessage/delta', 'params': {'delta': '"ok"}'}})
                await events.put({'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'text': '{"summary":"ok"}'}}})
                await events.put({'method': 'turn/completed', 'params': {'turn': {'status': 'completed'}}})
                await asyncio.wait_for(task, 2)
            finally:
                if not task.done(): task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual([('{"summary":', False), ('"ok"}', False), ('{"summary":"ok"}', True)], activity)
        self.assertEqual(['{"summary":"ok"}'], [delta.text for delta in deltas])
        conn.close.assert_awaited_once()

    async def test_qwen_and_claude_enable_partial_messages_and_keep_final_result_single(self):
        for kind, module, factory in ((BackendType.QWEN_CODE_CLI, 'qwen_code_sdk', QwenCodeSdkBackend),
                                      (BackendType.CLAUDE_AGENT_SDK, 'claude_agent_sdk', ClaudeAgentBackend)):
            with self.subTest(kind=kind):
                backend = factory(ModelBackendConfig('native', kind, 'test', model='test'))
                observed, finish = asyncio.Event(), asyncio.Event()
                activity, deltas, options = [], [], []
                def preview(text, replace=False):
                    activity.append((text, replace)); observed.set()
                async def messages():
                    for delta in ({'type': 'thinking_delta', 'thinking': 'PRIVATE'}, {'type': 'text_delta', 'text': 'partial'}):
                        event = {'type': 'content_block_delta', 'delta': delta}
                        if kind == BackendType.QWEN_CODE_CLI:
                            yield {'type': 'stream_event', 'event': event}
                        else:
                            msg = type('StreamEvent', (), {})(); msg.event = event; yield msg
                    await finish.wait()
                    if kind == BackendType.QWEN_CODE_CLI:
                        yield {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'partial complete'}]}}
                        yield {'type': 'result', 'subtype': 'success', 'result': 'partial complete'}
                    else:
                        msg = type('AssistantMessage', (), {})(); msg.content = [{'type': 'text', 'text': 'partial complete'}]; yield msg
                        msg = type('ResultMessage', (), {})(); msg.subtype = 'success'; msg.is_error = False; msg.result = 'partial complete'; yield msg
                class Query:
                    async def __aenter__(self): return self
                    async def __aexit__(self, *args): pass
                    def __aiter__(self): return messages()
                def query(*args, **kwargs):
                    options.append(args[1] if args else kwargs['options'])
                    return Query() if kind == BackendType.QWEN_CODE_CLI else messages()
                with patch(module + '.query', side_effect=query), patch('src.backend.text_only._copy_auth'):
                    task = asyncio.create_task(send_text_only(backend, content='review', constraints='restricted',
                        session_id='role', message_id='report', on_delta=deltas.append, on_activity=preview))
                    try:
                        await asyncio.wait_for(observed.wait(), 2)
                        self.assertFalse(task.done())
                        self.assertEqual([('partial', False)], activity)
                        self.assertEqual([], deltas)
                        setting = options[0]
                        self.assertTrue(setting['include_partial_messages'] if isinstance(setting, dict) else setting.include_partial_messages)
                        finish.set()
                        await asyncio.wait_for(task, 2)
                    finally:
                        if not task.done(): task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                self.assertEqual([('partial', False), ('partial complete', True)], activity)
                self.assertEqual(['partial complete'], [delta.text for delta in deltas])

    async def test_qwen_role_persistence_requires_exact_observed_id(self):
        backend = QwenCodeSdkBackend(ModelBackendConfig('q', BackendType.QWEN_CODE_CLI, 'q', model='test'))
        seen = []; returned = 'native-role'
        class Query:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def get_session_id(self): return None
            def __aiter__(self): return self.messages()
            async def messages(self):
                yield {'type': 'result', 'subtype': 'success', 'result': 'review', 'session_id': returned}
        def query(prompt, options):
            seen.append(options)
            return Query()
        with tempfile.TemporaryDirectory() as root, patch('qwen_code_sdk.query', side_effect=query):
            saved = []; context = TextOnlyContext(Path(root) / 'home', Path(root) / 'work', None, saved.append)
            async def run():
                await send_text_only(backend, content='{}', constraints='review', session_id='role', message_id='m', on_delta=lambda d: None, context=context)
            await run(); await run()
            self.assertNotIn('resume', seen[0]); self.assertEqual(seen[1]['resume'], 'native-role')
            self.assertEqual(saved, ['native-role']); self.assertEqual(seen[1]['core_tools'], seen[1]['exclude_tools'])
            returned = None
            with self.assertRaisesRegex(RuntimeError, 'confirm'): await run()
            returned = 'different'
            with self.assertRaisesRegex(ValueError, '线程发生变化'): await run()
            self.assertEqual(context.native_id, 'native-role')

    async def test_claude_role_persistence_requires_exact_observed_id(self):
        backend = ClaudeAgentBackend(ModelBackendConfig('c', BackendType.CLAUDE_AGENT_SDK, 'c', model='test'))
        returned = 'native-role'; seen = []
        async def query(**kwargs):
            seen.append(kwargs['options'])
            result = type('ResultMessage', (), {})()
            result.session_id = returned; result.is_error = False; result.subtype = 'success'; result.result = 'review'
            yield result
        with tempfile.TemporaryDirectory() as root, patch('claude_agent_sdk.query', side_effect=query):
            saved = []; context = TextOnlyContext(Path(root) / 'home', Path(root) / 'work', None, saved.append)
            async def run():
                await send_text_only(backend, content='{}', constraints='review', session_id='role', message_id='m', on_delta=lambda d: None, context=context)
            await run(); await run()
            self.assertIsNone(seen[0].resume); self.assertEqual(seen[1].resume, 'native-role')
            self.assertNotIn('no-session-persistence', seen[0].extra_args)
            self.assertEqual(seen[1].tools, []); self.assertEqual(saved, ['native-role'])
            returned = None
            with self.assertRaisesRegex(RuntimeError, 'confirm'): await run()
            returned = 'different'
            with self.assertRaisesRegex(ValueError, '线程发生变化'): await run()

    async def test_role_codex_context_resumes_exact_thread_without_enabling_tools_or_fallback(self):
        backend = CodexOfficeBackend(ModelBackendConfig('c', BackendType.CODEX_OFFICIAL, 'c', model='test'))
        saved = []
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'CODEX_HOME': root}):
            context = TextOnlyContext(Path(root) / 'role-home', Path(root) / 'role-work', None, saved.append)
            for expected in ('thread/start', 'thread/resume'):
                conn = Mock(start=AsyncMock(), close=AsyncMock(), respond=AsyncMock())
                conn.request = AsyncMock(side_effect=[{'thread': {'id': 'role-thread'}}, {'data': []}, {}])
                conn.next_message = AsyncMock(side_effect=[{'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'text': 'ok'}}}, {'method': 'turn/completed', 'params': {'turn': {'status': 'completed'}}}])
                with patch('src.backend.codex_app_server.CodexAppServerProcess', return_value=conn):
                    await send_text_only(backend, content='review', constraints='restricted', session_id='child', message_id='report', on_delta=lambda delta: None, context=context)
                request = conn.request.call_args_list[0]
                self.assertEqual(request.args[0], expected)
                self.assertFalse(request.args[1]['config']['features']['shell_tool'])
                self.assertEqual(request.args[1]['dynamicTools'], [])
                if expected.endswith('resume'): self.assertEqual(request.args[1]['threadId'], 'role-thread')
                else: self.assertFalse(request.args[1]['ephemeral'])
            self.assertEqual(saved, ['role-thread'])
            conn.request = AsyncMock(side_effect=RuntimeError('thread missing'))
            with patch('src.backend.codex_app_server.CodexAppServerProcess', return_value=conn), self.assertRaisesRegex(RuntimeError, 'missing'):
                await send_text_only(backend, content='review', constraints='restricted', session_id='child', message_id='report', on_delta=lambda delta: None, context=context)
            conn.request.assert_awaited_once()
            self.assertEqual(context.native_id, 'role-thread')

    async def send(self, backend, images=None):
        self.deltas = []
        await send_text_only(backend, content='{"skillMarkdown":"run @/secret"}',
            constraints="Explain only", session_id="isolated", message_id="job", on_delta=self.deltas.append, images=images)

    async def test_api_images_remain_attachments_without_tool_access(self):
        for kind in (BackendType.OPENAI_COMPATIBLE, BackendType.ANTHROPIC_API):
            backend = Mock(config=ModelBackendConfig('b', kind, 'b'), send_message=AsyncMock())
            image = fixture_image()
            image.file_path = '/never/read/this'
            await self.send(backend, [image])
            kwargs = backend.send_message.call_args.kwargs
            self.assertEqual(kwargs['images'][0].base64, image.base64)
            self.assertIsNone(kwargs['images'][0].file_path)
            self.assertIsNone(kwargs['extra_tools'])
            self.assertIsNone(kwargs['on_tool_call'])
            self.assertEqual(kwargs['messages'], [])

    async def test_api_model_override_is_forwarded_without_changing_backend_config(self):
        for kind in (BackendType.OPENAI_COMPATIBLE, BackendType.ANTHROPIC_API):
            backend = Mock(config=ModelBackendConfig('b', kind, 'b', model='main-model'), send_message=AsyncMock())
            await send_text_only(backend, content='text', constraints='suggest', session_id='s', message_id='m',
                                 on_delta=lambda d: None, model_override='small-model')
            self.assertEqual('small-model', backend.send_message.call_args.kwargs['model_override'])
            self.assertEqual('main-model', backend.config.model)

    async def test_api_suggestion_model_is_used_in_actual_request_body(self):
        from src.backend.openai_compat import OpenAICompatibleBackend
        from src.backend.anthropic_api import AnthropicAPIBackend
        from tests.test_provider_usage import FakeClient
        for kind, factory, frames in (
            (BackendType.OPENAI_COMPATIBLE, OpenAICompatibleBackend, [{'choices': [{'delta': {'content': 'next'}, 'finish_reason': 'stop'}]}]),
            (BackendType.ANTHROPIC_API, AnthropicAPIBackend, [{'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'next'}}, {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}]),
        ):
            backend = factory(ModelBackendConfig('b', kind, 'b', model='main-model', base_url='https://fixture.invalid'))
            client = FakeClient([frames])
            with patch('httpx.AsyncClient', return_value=client), patch.dict('sys.modules', {'anthropic': SimpleNamespace()}), patch.object(backend, 'get_env', return_value=None):
                await send_text_only(backend, content='text', constraints='suggest', session_id='s', message_id='m',
                                     on_delta=lambda d: None, model_override='small-model')
            self.assertEqual('small-model', client.requests[0]['model'])
            self.assertNotIn('tools', client.requests[0])
            self.assertEqual('main-model', backend.config.model)

    async def test_claude_model_override_reaches_native_options_without_mutating_backend(self):
        backend = ClaudeAgentBackend(ModelBackendConfig('b', BackendType.CLAUDE_AGENT_SDK, 'b', model='main-model'))
        async def query(**kwargs):
            self.assertEqual('small-model', kwargs['options'].model)
            result = type('ResultMessage', (), {})()
            result.is_error, result.subtype, result.result = False, 'success', 'suggestion'
            yield result
        with patch('claude_agent_sdk.query', side_effect=query), patch('src.backend.text_only._copy_auth'):
            await send_text_only(backend, content='text', constraints='suggest', session_id='s', message_id='m',
                                 on_delta=lambda d: None, model_override='small-model')
        self.assertEqual('main-model', backend.config.model)

    async def test_bad_images_fail_closed_without_reading_files_or_dropping_them(self):
        backend = Mock(config=ModelBackendConfig('b', BackendType.OPENAI_COMPATIBLE, 'b'), send_message=AsyncMock())
        for images in ([ImageAttachment('x', '', file_path='/secret')],
                       [ImageAttachment('x', base64.b64encode(b'not an image').decode())],
                       [fixture_image()] * 9):
            with self.assertRaises(ValueError):
                await self.send(backend, images)
        backend.send_message.assert_not_called()

    async def test_api_model_image_error_is_not_retried_as_text_or_reported_done(self):
        async def fail(**kwargs):
            from src.backend.base import StreamDelta
            kwargs['on_delta'](StreamDelta('s', 'm', 'error', error='vision unsupported'))
        backend = Mock(config=ModelBackendConfig('b', BackendType.OPENAI_COMPATIBLE, 'b'), send_message=AsyncMock(side_effect=fail))
        with self.assertRaisesRegex(RuntimeError, 'vision unsupported'):
            await self.send(backend, [fixture_image()])
        backend.send_message.assert_awaited_once()

    async def test_agent_dispatch_and_cleanup_on_success_error_and_cancel(self):
        for kind, runner in ((BackendType.CODEX_OFFICIAL, "_codex_text"),
                             (BackendType.QWEN_CODE_CLI, "_qwen_text"),
                             (BackendType.CLAUDE_AGENT_SDK, "_claude_text"),
                             (BackendType.CLAUDE_CODE_OFFICIAL, "_claude_text")):
            for error in (None, RuntimeError("failure"), asyncio.CancelledError()):
                backend = Mock(config=ModelBackendConfig("b", kind, "b", working_dir="user-workspace"))
                dirs = []
                async def run(_backend, _content, _rules, home, cwd):
                    dirs.extend((home, cwd))
                    self.assertTrue(home.is_dir() and cwd.is_dir())
                    self.assertNotEqual(str(cwd), backend.config.working_dir)
                    if error:
                        raise error
                    return "Explanation"
                with patch("src.backend.text_only." + runner, side_effect=run):
                    if error:
                        with self.assertRaises(type(error)):
                            await self.send(backend)
                    else:
                        await self.send(backend)
                        self.assertEqual(self.deltas[0].text, "Explanation")
                self.assertTrue(all(not path.exists() for path in dirs))
                backend.send_message.assert_not_called()
                self.assertEqual(backend.config.working_dir, "user-workspace")

    def test_isolation_removes_agent_bootstrap_overrides_not_connection(self):
        env = {"HOME": "/original", "CODEX_HOME": "/original/.codex", "QWEN_CODE_SYSTEM_SETTINGS_PATH": "/hooks",
               "CLAUDE_CONFIG_DIR": "/settings", "NODE_OPTIONS": "--require unsafe.js",
               "OPENAI_API_KEY": "test-only", "PATH": "/bin", "HTTPS_PROXY": "http://proxy"}
        isolated = _isolated_env(env, Path("isolated-home"))
        self.assertNotIn("NODE_OPTIONS", isolated)
        self.assertNotIn("QWEN_CODE_SYSTEM_SETTINGS_PATH", isolated)
        self.assertEqual(isolated["OPENAI_API_KEY"], "test-only")
        self.assertEqual(env["HOME"], "/original")

    async def test_no_permission_callback_can_allow_tools(self):
        self.assertEqual((await _deny_tool("Read", {"path": "/secret"}, None))["behavior"], "deny")
        with self.assertRaises(RuntimeError):
            _assistant_text([{"type": "tool_use", "name": "Bash"}])

    def test_auth_snapshot_cannot_rotate_main_account_refresh_tokens(self):
        with tempfile.TemporaryDirectory() as root:
            source, target = Path(root) / "auth.json", Path(root) / "isolated" / "auth.json"
            data = {"tokens": {"access_token": "access", "refresh_token": "refresh"},
                    "claudeAiOauth": {"accessToken": "access", "refreshToken": "refresh"}}
            source.write_text(json.dumps(data), encoding="utf-8")
            _copy_auth(source, target)
            snapshot = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(snapshot["tokens"]["access_token"], "access")
            self.assertEqual(snapshot["tokens"]["refresh_token"], "")
            self.assertEqual(snapshot["claudeAiOauth"]["refreshToken"], "")
            self.assertEqual(json.loads(source.read_text(encoding="utf-8")), data)

    def test_codex_config_keeps_connection_only_not_commands_or_workspace(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "config.toml").write_text('''model = "configured-model"
model_provider = "custom"
developer_instructions = "PRIVATE PROJECT"
notify = ["dangerous-hook"]
[model_providers.custom]
base_url = "http://provider"
env_key = "PROVIDER_KEY"
http_headers_helper = "dangerous-helper"
[mcp_servers.untrusted]
command = "dangerous-mcp"
''', encoding="utf-8")
            config = _codex_connection_config(Path(root))
            self.assertEqual(config["model"], "configured-model")
            self.assertEqual(config["model_providers"]["custom"], {"base_url": "http://provider", "env_key": "PROVIDER_KEY"})
            self.assertNotIn("mcp_servers", config)
            self.assertNotIn("notify", config)
            self.assertNotIn("developer_instructions", config)

    async def test_codex_thread_is_ephemeral_has_no_environment_and_closes(self):
        backend = CodexOfficeBackend(ModelBackendConfig("c", BackendType.CODEX_OFFICIAL, "c", model="gpt-test"))
        conn = Mock(start=AsyncMock(), close=AsyncMock(), respond=AsyncMock())
        conn.request = AsyncMock(side_effect=[{"thread": {"id": "new-thread"}}, {"data": []}, {}])
        conn.next_message = AsyncMock(side_effect=[
            {"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": "text"}}},
            {"method": "turn/completed", "params": {"turn": {"status": "completed"}}},
        ])
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"CODEX_HOME": root}), \
                patch("src.backend.codex_app_server.CodexAppServerProcess", return_value=conn) as factory:
            Path(root, "auth.json").write_text('{"OPENAI_API_KEY":"test"}', encoding="utf-8")
            await self.send(backend, [fixture_image()])
        params = conn.request.call_args_list[0].args[1]
        self.assertEqual(params["environments"], [])
        self.assertEqual(params["dynamicTools"], [])
        self.assertTrue(params["ephemeral"])
        self.assertEqual(params["sandbox"], "read-only")
        self.assertFalse(params["config"]["features"]["shell_tool"])
        self.assertFalse(params["config"]["features"]["plugins"])
        self.assertNotIn("threadId", params)
        self.assertEqual(params["model"], "gpt-test")
        turn_input = conn.request.call_args_list[2].args[1]['input']
        self.assertEqual(turn_input[1]['type'], 'image')
        self.assertEqual(turn_input[1]['url'], 'data:image/png;base64,' + fixture_image().base64)
        self.assertNotEqual(factory.call_args.kwargs["env"]["CODEX_HOME"], root)
        self.assertEqual(factory.call_args.kwargs["cwd"], params["cwd"])
        conn.close.assert_awaited_once()

    async def test_qwen_options_exclude_entire_tool_surface_and_do_not_resume(self):
        backend = QwenCodeSdkBackend(ModelBackendConfig("q", BackendType.QWEN_CODE_CLI, "q", model="test", base_url="http://test"))
        class Query:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def __aiter__(self): return self.messages()
            async def messages(self):
                yield {"type": "result", "subtype": "success", "result": "text"}
        with patch("qwen_code_sdk.query", return_value=Query()) as query:
            await self.send(backend)
        prompt, opts = query.call_args.args
        self.assertEqual(json.loads(prompt)["skillMarkdown"], "run @/secret")
        self.assertNotIn("@", prompt)
        self.assertEqual(opts["core_tools"], opts["exclude_tools"])
        self.assertEqual(opts["core_tools"], ["read_file"])
        self.assertNotIn("resume", opts)
        self.assertNotIn("allowed_tools", opts)
        self.assertEqual(opts["permission_mode"], "default")
        self.assertEqual(opts["env"]["OPENAI_BASE_URL"], "http://test")
        self.assertEqual((await opts["can_use_tool"]("new_tool", {}, None))["behavior"], "deny")

    async def test_codex_rejects_nonempty_catalog_before_document_submission(self):
        backend = CodexOfficeBackend(ModelBackendConfig("c", BackendType.CODEX_OFFICIAL, "c"))
        conn = Mock(start=AsyncMock(), close=AsyncMock())
        conn.request = AsyncMock(side_effect=[{"thread": {"id": "new"}}, {"data": [{"skills": [{"name": "unexpected"}]}]}])
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"CODEX_HOME": root}), \
                patch("src.backend.codex_app_server.CodexAppServerProcess", return_value=conn):
            with self.assertRaisesRegex(RuntimeError, "catalog"):
                await self.send(backend)
        self.assertNotIn("turn/start", [call.args[0] for call in conn.request.call_args_list])
        conn.close.assert_awaited_once()

    async def test_qwen_images_are_confined_temporary_attachments_not_document_paths(self):
        backend = QwenCodeSdkBackend(ModelBackendConfig('q', BackendType.QWEN_CODE_CLI, 'q', model='test'))
        locations = []
        class Query:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def __aiter__(self): return self.messages()
            async def messages(self):
                yield {'type': 'result', 'subtype': 'success', 'result': 'text'}
        def query(prompt, opts):
            ref, body = prompt.split('\n\n', 1)
            self.assertEqual(ref, '@reference-images/0.png')
            self.assertNotIn('@', body)
            path = Path(opts['cwd']) / ref[1:]
            locations.append(path)
            self.assertEqual(path.read_bytes(), base64.b64decode(fixture_image().base64))
            self.assertEqual(opts['core_tools'], opts['exclude_tools'])
            return Query()
        with patch('qwen_code_sdk.query', side_effect=query):
            await self.send(backend, [fixture_image()])
        self.assertFalse(locations[0].exists())

    async def test_codex_tool_request_fails_without_executing_or_forwarding(self):
        backend = CodexOfficeBackend(ModelBackendConfig("c", BackendType.CODEX_OFFICIAL, "c"))
        conn = Mock(start=AsyncMock(), close=AsyncMock(), respond=AsyncMock())
        conn.request = AsyncMock(side_effect=[{"thread": {"id": "new"}}, {"data": []}, {}])
        conn.next_message = AsyncMock(return_value={"id": 77, "method": "item/tool/call", "params": {"tool": "exec"}})
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"CODEX_HOME": root}), \
                patch("src.backend.codex_app_server.CodexAppServerProcess", return_value=conn):
            with self.assertRaisesRegex(RuntimeError, "tool"):
                await self.send(backend)
        self.assertIn("error", conn.respond.call_args.kwargs)
        conn.close.assert_awaited_once()
        self.assertEqual(self.deltas, [])

    async def test_claude_options_remove_native_tools_mcp_and_settings(self):
        backend = ClaudeAgentBackend(ModelBackendConfig("c", BackendType.CLAUDE_AGENT_SDK, "c", model="test"))
        ResultMessage = type("ResultMessage", (), {})
        result = ResultMessage()
        result.is_error, result.subtype, result.result = False, "success", "text"
        async def query(**kwargs):
            messages = [message async for message in kwargs['prompt']]
            self.assertEqual(messages[0]['message']['content'][0]['source']['data'], fixture_image().base64)
            yield result
        with patch("claude_agent_sdk.query", side_effect=query) as mock:
            await self.send(backend, [fixture_image()])
        opts = mock.call_args.kwargs["options"]
        self.assertEqual(opts.tools, [])
        self.assertEqual(opts.setting_sources, [])
        self.assertEqual(opts.mcp_servers, {})
        self.assertIsNone(opts.resume)
        self.assertEqual(opts.permission_mode, "default")
        self.assertIn("strict-mcp-config", opts.extra_args)
        self.assertIn("disable-slash-commands", opts.extra_args)


if __name__ == "__main__":
    unittest.main()
