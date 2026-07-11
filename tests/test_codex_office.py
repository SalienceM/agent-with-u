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
    resolve_codex_cli,
)
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


if __name__ == "__main__":
    unittest.main()
