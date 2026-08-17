import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS
from src.backend.skill_paths import (
    PROJECT_SKILL_ROOTS,
    project_skill_reference,
    render_skill_markdown,
)
from src.backend.skill_store import SkillStore


class SkillPathTests(unittest.TestCase):
    def test_project_references_match_each_agent_framework(self):
        self.assertEqual(
            project_skill_reference("claude", "web-search"),
            ".claude/skills/web-search",
        )
        self.assertEqual(
            project_skill_reference("qwen", "web-search"),
            ".qwen/skills/web-search",
        )
        self.assertEqual(
            project_skill_reference("codex", "web-search"),
            ".agents/skills/web-search",
        )

    def test_placeholder_and_legacy_self_reference_render_to_target(self):
        source = (
            "new={{SKILL_DIR}}/_call.py\n"
            "old=.claude/skills/demo/_call.py\n"
        )

        rendered = render_skill_markdown(
            source,
            skill_name="demo",
            skill_dir_reference=".qwen/skills/demo",
        )

        self.assertEqual(
            rendered,
            "new=.qwen/skills/demo/_call.py\n"
            "old=.qwen/skills/demo/_call.py\n",
        )

    def test_unknown_agent_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported agent"):
            project_skill_reference("unknown", "demo")


class BackendSkillGenerationTests(unittest.TestCase):
    def setUp(self):
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.info = {
            "description": "Search the web",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                },
                "required": ["prompt"],
            },
        }

    def test_generated_markdown_uses_native_call_script_for_each_agent(self):
        expected = {
            "claude": ".claude/skills/web-search/_call.py",
            "qwen": ".qwen/skills/web-search/_call.py",
            "codex": ".agents/skills/web-search/_call.py",
        }

        for agent_name, call_script in expected.items():
            with self.subTest(agent=agent_name):
                markdown = self.bridge._generate_backend_skill_md(
                    "web-search",
                    self.info,
                    agent_name=agent_name,
                )
                self.assertIn(call_script, markdown)
                for other_script in expected.values():
                    if other_script != call_script:
                        self.assertNotIn(other_script, markdown)

    def test_generated_markdown_uses_native_powershell_for_codex_on_windows(self):
        with patch.object(
            self.bridge,
            "_resolve_python_exe",
            return_value="C:/Users/example/Python/python.EXE",
        ), patch("src.backend.bridge_ws.sys.platform", "win32"):
            markdown = self.bridge._generate_backend_skill_md(
                "web-search",
                self.info,
                agent_name="codex",
            )

        self.assertIn("必须使用 shell_command 工具直接执行下方 PowerShell 命令", markdown)
        self.assertIn("```powershell", markdown)
        self.assertIn("Get-Command python.exe, python3, python", markdown)
        self.assertIn(
            "& $awuPython '.agents/skills/web-search/_call.py' '<PROMPT>'",
            markdown,
        )
        self.assertNotIn("command -v", markdown)
        self.assertNotIn("C:/Users/example/Python/python.EXE", markdown)

    def test_generated_markdown_keeps_bash_for_claude(self):
        with patch.object(
            self.bridge,
            "_resolve_python_exe",
            return_value="C:/Users/example/Python/python.EXE",
        ):
            markdown = self.bridge._generate_backend_skill_md(
                "web-search",
                self.info,
                agent_name="claude",
            )

        self.assertIn("必须使用 Bash 工具直接执行下方命令", markdown)
        self.assertIn(
            '_AWU_PYTHON="$(command -v python.exe || command -v python3 || command -v python)"',
            markdown,
        )

    def test_python_skill_command_quotes_each_argument(self):
        command = self.bridge._build_skill_python_cmd(
            ".agents/skills/demo/_call.py",
            ["<PROMPT>", "<REF_IMAGE_URL>"],
        )

        self.assertEqual(
            command,
            '_AWU_PYTHON="$(command -v python.exe || command -v python3 || command -v python)" && '
            '"$_AWU_PYTHON" ".agents/skills/demo/_call.py" "<PROMPT>" "<REF_IMAGE_URL>"',
        )

    def test_powershell_skill_command_quotes_path_and_arguments(self):
        command = self.bridge._build_skill_python_cmd(
            ".agents/skills/demo/_call.py",
            ["<PROMPT>", "O'Reilly"],
            shell="powershell",
        )

        self.assertIn("Get-Command python.exe, python3, python", command)
        self.assertIn("& $awuPython '.agents/skills/demo/_call.py'", command)
        self.assertTrue(command.endswith("'<PROMPT>' 'O''Reilly'"))

    def test_powershell_curl_fallback_uses_curl_exe_and_json(self):
        command = self.bridge._build_skill_curl_cmd(
            "web-fetch",
            {"url": "<URL>"},
            shell="powershell",
        )

        self.assertIn("ConvertTo-Json -Compress", command)
        self.assertIn("curl.exe", command)
        self.assertIn("'url' = '<URL>'", command)

    def test_native_tool_block_does_not_force_codex_back_to_bash(self):
        instruction = self.bridge._blocked_tool_instruction({"WebFetch", "WebSearch"})

        self.assertIn("Skill: web-search", instruction)
        self.assertIn("Skill: web-fetch", instruction)
        self.assertIn("当前 Agent 与操作系统", instruction)
        self.assertNotIn("用 Bash", instruction)

    def test_loading_session_refreshes_deployed_skill_templates(self):
        session = type("SessionStub", (), {
            "id": "session-1",
            "messages": [],
            "to_dict": lambda self, message_limit=0: {"id": self.id, "messages": []},
        })()
        self.bridge._active_sessions = {"session-1": session}
        self.bridge._session_store = type("StoreStub", (), {
            "load": lambda _self, _sid: None,
        })()
        refreshed = []
        self.bridge._sync_backend_skills_to_directory = refreshed.append

        result = self.bridge._rpc_loadSession("session-1", 25)

        self.assertEqual(refreshed, [session])
        self.assertIn('"id": "session-1"', result)

    def test_sync_writes_agent_specific_markdown_to_every_native_root(self):
        class FakeSkillStore:
            def get_skill(self, name):
                if name != "web-search":
                    return None
                return {
                    **self_info,
                    "type": "web-search",
                }

        self_info = self.info
        self.bridge._skill_store = FakeSkillStore()
        self.bridge._backend_configs = []

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("src.backend.bridge_ws.sys.platform", "win32"),
        ):
            base = Path(tmp)
            roots = [
                (agent_name, base / relative_root)
                for agent_name, relative_root in PROJECT_SKILL_ROOTS.items()
            ]
            self.bridge._skill_deploy_roots_for_session = lambda _session: roots
            session = type("SessionStub", (), {
                "abilities": {"skills": ["web-search"]},
            })()

            self.bridge._sync_backend_skills_to_directory(session)

            for agent_name, skills_dir in roots:
                skill_dir = skills_dir / "web-search"
                markdown = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
                expected = (
                    f"{project_skill_reference(agent_name, 'web-search')}/_call.py"
                )
                self.assertIn(expected, markdown)
                self.assertTrue((skill_dir / "_call.py").exists())
                if agent_name == "codex":
                    self.assertIn("```powershell", markdown)
                    self.assertIn("& $awuPython", markdown)
                    self.assertNotIn("command -v", markdown)
                else:
                    self.assertIn("```bash", markdown)
                    self.assertIn("command -v", markdown)


class TraditionalSkillDeploymentTests(unittest.TestCase):
    def test_project_activation_deploys_and_renders_all_agent_directories(self):
        store = SkillStore.__new__(SkillStore)
        source = (
            "---\n"
            "name: demo\n"
            "description: demo\n"
            "---\n"
            '"python" "{{SKILL_DIR}}/call.py"\n'
            '"python" ".claude/skills/demo/legacy.py"\n'
        )

        with tempfile.TemporaryDirectory() as tmp:
            store._deploy("demo", source, tmp)

            for agent_name, relative_root in PROJECT_SKILL_ROOTS.items():
                target = Path(tmp) / relative_root / "demo" / "SKILL.md"
                rendered = target.read_text(encoding="utf-8")
                reference = project_skill_reference(agent_name, "demo")
                self.assertIn(f'"{reference}/call.py"', rendered)
                self.assertIn(f'"{reference}/legacy.py"', rendered)

            store._undeploy("demo", tmp)
            for relative_root in PROJECT_SKILL_ROOTS.values():
                self.assertFalse(
                    (Path(tmp) / relative_root / "demo" / "SKILL.md").exists()
                )


if __name__ == "__main__":
    unittest.main()
