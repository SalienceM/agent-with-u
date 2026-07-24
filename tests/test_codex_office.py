import asyncio
import json
import os
import sys
import types
import unittest
from unittest.mock import patch

# base.py imports httpx for other backends, but these unit tests exercise only
# Codex command construction and do not require the optional HTTP dependency.
sys.modules.setdefault("httpx", types.ModuleType("httpx"))

from src.backend.codex_office import (
    CodexOfficeBackend,
    _codex_launch_command,
    _is_windows_store_codex,
    _normalize_proxy_url,
    _is_retrying_transport_error,
    _smooth_text_chunks,
    resolve_codex_cli,
)
from src.backend.codex_app_server import CODEX_JSONL_STREAM_LIMIT
from src.types import BackendType, ModelBackendConfig


class CodexOfficeTests(unittest.TestCase):
    def _backend(self, env=None):
        return CodexOfficeBackend(ModelBackendConfig(
            id="test",
            label="test",
            type=BackendType.CODEX_OFFICIAL,
            env=env or {},
        ))

    def test_native_resume_defaults_on_and_can_be_disabled(self):
        self.assertTrue(self._backend()._native_resume_enabled())
        self.assertFalse(self._backend({"AGENTWITHU_CODEX_NATIVE_RESUME": "false"})._native_resume_enabled())

    def test_smooth_text_chunks_preserve_content_and_bound_frames(self):
        text = "流式输出" * 1000
        chunks = _smooth_text_chunks(text)
        self.assertEqual("".join(chunks), text)
        self.assertLessEqual(len(chunks), 300)
        self.assertGreater(len(chunks), 1)

    def test_custom_proxy_is_scoped_to_codex_child(self):
        proxy = "http://127.0.0.1:7890"
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://system:8080"}, clear=False):
            env = self._backend({
                "AGENTWITHU_CODEX_PROXY_MODE": "custom",
                "AGENTWITHU_CODEX_PROXY": proxy,
            })._build_env()
            self.assertEqual(env["HTTPS_PROXY"], proxy)
            self.assertEqual(env["https_proxy"], proxy)
            self.assertEqual(env["ALL_PROXY"], proxy)
            self.assertEqual(os.environ["HTTPS_PROXY"], "http://system:8080")
            self.assertNotIn("AGENTWITHU_CODEX_PROXY_MODE", env)

    def test_direct_proxy_mode_removes_inherited_proxy(self):
        inherited = {key: "http://system:8080" for key in (
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
            "http_proxy", "https_proxy", "all_proxy",
        )}
        with patch.dict(os.environ, inherited, clear=False):
            env = self._backend({"AGENTWITHU_CODEX_PROXY_MODE": "direct"})._build_env()
            for key in inherited:
                self.assertNotIn(key, env)

    def test_system_proxy_mode_clears_env_proxy_and_enables_codex_feature(self):
        backend = self._backend({"AGENTWITHU_CODEX_PROXY_MODE": "system"})
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://stale:8080"}, clear=False):
            self.assertNotIn("HTTPS_PROXY", backend._build_env())
        command = backend._build_cmd(
            codex_cli="codex",
            prompt="hello",
            model="gpt-test",
            approval_mode="never",
            sandbox_mode="danger-full-access",
            agent_session_id=None,
            output_path=None,
            image_paths=[],
            stdin_mode=False,
        )
        idx = command.index("--enable")
        self.assertEqual(command[idx + 1], "respect_system_proxy")
        self.assertIn("model_provider=agentwithu_http", command)
        self.assertIn("model_providers.agentwithu_http.supports_websockets=false", command)
        self.assertIn("model_providers.agentwithu_http.requires_openai_auth=true", command)

    def test_http_provider_never_overrides_reserved_openai_provider(self):
        command = self._backend({
            "AGENTWITHU_CODEX_PROXY_MODE": "custom",
            "AGENTWITHU_CODEX_PROXY": "http://127.0.0.1:7890",
        })._build_cmd(
            codex_cli="codex", prompt="hello", model="gpt-test",
            approval_mode="never", sandbox_mode="danger-full-access",
            agent_session_id=None, output_path=None, image_paths=[], stdin_mode=False,
        )
        joined = " ".join(command)
        self.assertIn("model_provider=agentwithu_http", joined)
        self.assertNotIn("model_providers.openai.", joined)

    def test_http_provider_uses_api_key_auth_when_configured(self):
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="test", label="test", type=BackendType.CODEX_OFFICIAL,
            api_key="secret", env={
                "AGENTWITHU_CODEX_PROXY_MODE": "custom",
                "AGENTWITHU_CODEX_PROXY": "http://127.0.0.1:7890",
            },
        ))
        args = backend._http_provider_args()
        self.assertIn("model_providers.agentwithu_http.env_key=OPENAI_API_KEY", args)
        self.assertNotIn("model_providers.agentwithu_http.requires_openai_auth=true", args)

    def test_force_http_can_be_disabled_explicitly(self):
        backend = self._backend({
            "AGENTWITHU_CODEX_PROXY_MODE": "system",
            "AGENTWITHU_CODEX_FORCE_HTTP": "false",
        })
        self.assertFalse(backend._force_http_enabled())
        self.assertEqual(backend._http_provider_args(), [])

    def test_reconnecting_transport_event_is_recoverable(self):
        self.assertTrue(_is_retrying_transport_error(
            "Reconnecting... 4/5 (stream disconnected before completion: websocket closed)"
        ))
        self.assertFalse(_is_retrying_transport_error("authentication failed"))

    def test_legacy_https_proxy_remains_supported(self):
        proxy = "http://127.0.0.1:7890"
        env = self._backend({"HTTPS_PROXY": proxy})._build_env()
        self.assertEqual(env["HTTP_PROXY"], proxy)
        self.assertEqual(env["all_proxy"], proxy)

    def test_bare_proxy_endpoint_gets_http_scheme(self):
        self.assertEqual(_normalize_proxy_url("10.0.0.8:7897"), "http://10.0.0.8:7897")
        env = self._backend({
            "AGENTWITHU_CODEX_PROXY_MODE": "custom",
            "AGENTWITHU_CODEX_PROXY": "10.0.0.8:7897",
        })._build_env()
        self.assertEqual(env["HTTPS_PROXY"], "http://10.0.0.8:7897")

    def test_unsupported_proxy_scheme_is_not_injected(self):
        self.assertEqual(_normalize_proxy_url("socks5://10.0.0.8:1080"), "")
        backend = self._backend({
            "AGENTWITHU_CODEX_PROXY_MODE": "custom",
            "AGENTWITHU_CODEX_PROXY": "socks5://10.0.0.8:1080",
        })
        self.assertIn("HTTP / mixed", backend._proxy_config_error() or "")

    def test_network_summary_masks_proxy_credentials(self):
        backend = self._backend({
            "AGENTWITHU_CODEX_PROXY_MODE": "custom",
            "AGENTWITHU_CODEX_PROXY": "http://secret:token@127.0.0.1:7897",
        })
        summary = backend._network_summary()
        self.assertIn("127.0.0.1:7897", summary)
        self.assertNotIn("secret", summary)
        self.assertNotIn("token", summary)

    def test_resume_command_places_session_before_prompt(self):
        command = self._backend()._build_cmd(
            codex_cli="codex",
            prompt="next question",
            model="gpt-test",
            approval_mode="never",
            sandbox_mode="danger-full-access",
            agent_session_id="thread-123",
            output_path=None,
            image_paths=[],
            stdin_mode=False,
        )
        self.assertEqual(command[-2:], ["thread-123", "next question"])
        self.assertIn("resume", command)

    def test_command_accepts_independent_model_and_reasoning_effort(self):
        command = self._backend()._build_cmd(
            codex_cli="codex",
            prompt="review strictly",
            model="gpt-5.6-sol",
            approval_mode="never",
            sandbox_mode="danger-full-access",
            agent_session_id=None,
            output_path=None,
            image_paths=[],
            stdin_mode=False,
            reasoning_effort="xhigh",
        )
        self.assertEqual(command[command.index("--model") + 1], "gpt-5.6-sol")
        self.assertEqual(
            command[command.index("--config") + 1],
            "model_reasoning_effort=xhigh",
        )
        self.assertLess(command.index("--config"), command.index("exec"))

    def test_invalid_reasoning_effort_is_not_forwarded(self):
        command = self._backend()._build_cmd(
            codex_cli="codex",
            prompt="hello",
            model="gpt-5.6-terra",
            approval_mode="never",
            sandbox_mode="danger-full-access",
            agent_session_id=None,
            output_path=None,
            image_paths=[],
            stdin_mode=False,
            reasoning_effort="ultra-unknown",
        )
        self.assertNotIn("--config", command)

    def test_resumed_prompt_does_not_repeat_constraints_or_history(self):
        prompt = self._backend()._build_prompt(
            [],
            "current question",
            "very large session constraints",
            include_history=False,
            include_constraints=False,
        )
        self.assertIn("current question", prompt)
        self.assertNotIn("very large session constraints", prompt)
        self.assertNotIn("system_constraints", prompt)

    @patch("src.backend.codex_office.sys.platform", "win32")
    def test_windows_cmd_prompt_can_be_carried_by_stdin(self):
        command = self._backend()._build_cmd(
            codex_cli=r"C:\npm\codex.cmd",
            prompt="<system_constraints>\nfull content",
            model="gpt-test",
            approval_mode="never",
            sandbox_mode="danger-full-access",
            agent_session_id=None,
            output_path=None,
            image_paths=[],
            stdin_mode=True,
        )
        self.assertEqual(command[1:4], ["/d", "/s", "/c"])
        self.assertTrue(command[4].endswith(" -"))
        self.assertNotIn("system_constraints", command[4])

    @patch("src.backend.codex_office.sys.platform", "win32")
    def test_windows_cmd_reasoning_effort_has_no_literal_quotes(self):
        command = self._backend()._build_cmd(
            codex_cli=r"C:\npm\codex.cmd",
            prompt="review",
            model="gpt-5.6-sol",
            approval_mode="never",
            sandbox_mode="danger-full-access",
            agent_session_id=None,
            output_path=None,
            image_paths=[],
            stdin_mode=False,
            reasoning_effort="max",
        )
        self.assertIn("model_reasoning_effort=max", command[4])
        self.assertNotIn('\\\"max\\\"', command[4])

    @patch("src.backend.codex_office.sys.platform", "win32")
    def test_windows_cmd_uses_command_interpreter(self):
        command = _codex_launch_command(r"C:\npm\codex.cmd", ["--version"])
        self.assertEqual(command[1:4], ["/d", "/s", "/c"])
        self.assertIn("codex.cmd", command[4])

    @patch("src.backend.codex_office.sys.platform", "win32")
    def test_windows_store_app_is_rejected(self):
        path = r"C:\Program Files\WindowsApps\OpenAI.Codex_1.0\app\resources\codex.exe"
        with patch.dict(os.environ, {"ProgramFiles": r"C:\Program Files"}):
            self.assertTrue(_is_windows_store_codex(path))
            with patch("src.backend.codex_office.shutil.which", return_value=path), \
                 patch.dict(os.environ, {"APPDATA": ""}, clear=False):
                self.assertEqual(resolve_codex_cli(), "codex")

    def test_command_event_is_compact_and_completed(self):
        event = {
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "command_execution",
                "command": r'"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Get-Content README.md"',
                "aggregated_output": "file contents",
                "exit_code": 0,
                "status": "completed",
            },
        }
        payload = self._backend()._command_tool_payload(event, event["item"])
        self.assertEqual(payload["name"], "PowerShell")
        self.assertEqual(payload["input"], event["item"]["command"])
        self.assertEqual(payload["output"], "file contents")
        self.assertEqual(payload["status"], "done")
        self.assertTrue(payload["completed"])
        self.assertNotIn("aggregated_output", payload["input"])


class _AsyncLineStream:
    def __init__(self, lines):
        self._lines = iter(lines)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._lines)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _FakeCodexProcess:
    def __init__(self, stdout):
        self.stdout = stdout
        self.stderr = _AsyncLineStream([])
        self.stdin = None
        self.returncode = None

    async def wait(self):
        self.returncode = 0
        return 0

    def terminate(self):
        self.returncode = -15

    def kill(self):
        self.returncode = -9


class CodexOfficeStreamingTests(unittest.IsolatedAsyncioTestCase):
    def _backend(self):
        backend = CodexOfficeBackend(ModelBackendConfig(
            id="test",
            label="test",
            type=BackendType.CODEX_OFFICIAL,
            cli_path="codex-test.exe",
            env={"AGENTWITHU_CODEX_SMOOTH_STREAM": "false"},
        ))
        backend._probed_codex_cli = "codex-test.exe"
        return backend

    async def test_exec_jsonl_uses_large_line_limit(self):
        event = json.dumps({
            "type": "thread.started",
            "thread_id": "native-thread",
            "padding": "x" * 200_000,
        }).encode("utf-8") + b"\n"
        captured = {}

        async def fake_spawn(*args, **kwargs):
            captured.update(kwargs)
            return _FakeCodexProcess(_AsyncLineStream([event]))

        deltas = []
        with patch("src.backend.codex_office.cli_available", return_value=True), \
             patch("src.backend.codex_office.asyncio.create_subprocess_exec", side_effect=fake_spawn):
            result = await self._backend().send_message(
                messages=[],
                content="hello",
                images=None,
                session_id="session-1",
                message_id="message-1",
                on_delta=deltas.append,
                working_dir=".",
            )

        self.assertEqual(captured["limit"], CODEX_JSONL_STREAM_LIMIT)
        self.assertEqual(result["agentSessionId"], "native-thread")
        self.assertFalse([delta for delta in deltas if delta.type == "error"])

    async def test_exec_line_limit_error_is_user_friendly(self):
        class FailingStream:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise ValueError("Separator is not found, and chunk exceed the limit")

        async def fake_spawn(*args, **kwargs):
            return _FakeCodexProcess(FailingStream())

        deltas = []
        with patch("src.backend.codex_office.cli_available", return_value=True), \
             patch("src.backend.codex_office.asyncio.create_subprocess_exec", side_effect=fake_spawn):
            await self._backend().send_message(
                messages=[],
                content="hello",
                images=None,
                session_id="session-1",
                message_id="message-1",
                on_delta=deltas.append,
                working_dir=".",
            )

        errors = [delta.error for delta in deltas if delta.type == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("128 MiB", errors[0])
        self.assertNotIn("Separator is not found", errors[0])


if __name__ == "__main__":
    unittest.main()
