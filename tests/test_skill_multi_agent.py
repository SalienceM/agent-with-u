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

    def test_generated_markdown_resolves_python_inside_active_bash(self):
        with patch.object(
            self.bridge,
            "_resolve_python_exe",
            return_value="C:/Users/example/Python/python.EXE",
        ):
            markdown = self.bridge._generate_backend_skill_md(
                "web-search",
                self.info,
                agent_name="codex",
            )

        self.assertIn(
            '_AWU_PYTHON="$(command -v python.exe || command -v python3 || command -v python)"',
            markdown,
        )
        self.assertIn(
            '"$_AWU_PYTHON" ".agents/skills/web-search/_call.py" "<PROMPT>"',
            markdown,
        )
        self.assertNotIn("C:/Users/example/Python/python.EXE", markdown)

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

        with tempfile.TemporaryDirectory() as tmp:
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
