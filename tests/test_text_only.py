import asyncio
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.backend.text_only import (
    _assistant_text, _codex_connection_config, _copy_auth, _deny_tool, _isolated_env,
    send_text_only,
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
