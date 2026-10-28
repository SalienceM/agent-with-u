"""Harness 绑定只在发送时准备，并且只暴露管理清单内的原生 Skills。"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.deepseek_harness_skills import skill_root, run_skill_view
from src.backend.deepseek_harness_state import HarnessLayout
from src.backend.skill_store import SkillStore
from src.backend.skill_commands import command_catalog, resolve_skill_call
from src.types import BackendType, ModelBackendConfig, Session


class HarnessSkillTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-harness-skills-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.library = self.root / "library"
        env = patch.dict("os.environ", {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data")})
        env.start()
        self.addCleanup(env.stop)
        for name, value in (("LIBRARY_DIR", self.library), ("INDEX_FILE", self.library / "index.json"), ("SECRETS_DIR", self.root / "secrets")):
            patched = patch("src.backend.skill_store." + name, value)
            patched.start()
            self.addCleanup(patched.stop)
        self.store = SkillStore()
        self.store.install_standard_files({"SKILL.md": b"---\nname: demo\ndescription: local fixture\n---\nUse {{SKILL_DIR}}/guide.md",
                                           "guide.md": b"local reference"})
        self.config = ModelBackendConfig(id="harness", type=BackendType.DEEPSEEK_HARNESS, label="test")
        self.session = Session(id="sid", title="test", created_at=1, updated_at=1, messages=[],
            owner_id="test-owner", backend_id="harness", working_dir=str(self.project), abilities={"skills": ["demo"]})
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._backend_configs = [self.config]
        self.bridge._skill_store = self.store
        self.bridge._prompt_store = SimpleNamespace(get_prompt=lambda _name: None)

    async def test_binding_catalog_and_native_preparation_are_isolated_and_incremental(self) -> None:
        target_root = skill_root(owner="test-owner", backend="harness", session="sid")
        self.bridge._apply_session_abilities(self.session, self.session.abilities, deploy=False)
        catalog = command_catalog(self.session, self.config, self.store)
        self.assertEqual(catalog["commands"][0]["unavailableReason"], "")
        self.assertFalse(target_root.exists(), "Binding/catalog must not deploy")
        await self.bridge._prepare_session_skills(self.session)
        target = target_root / "demo"
        self.assertIn(target.as_posix(), (target / "SKILL.md").read_text(encoding="utf-8"))
        self.assertEqual((target / "guide.md").read_text(), "local reference")
        before = (target / "guide.md").stat().st_mtime_ns
        await self.bridge._prepare_session_skills(self.session)
        self.assertEqual((target / "guide.md").stat().st_mtime_ns, before)
        for agent in (".claude", ".qwen", ".agents", ".dsh"):
            self.assertFalse((self.project / agent).exists())
        self.assertNotEqual(target_root, skill_root(owner="other", backend="harness", session="sid"))

    async def test_unbind_keeps_user_files_but_they_cannot_enter_native_catalog(self) -> None:
        await self.bridge._prepare_session_skills(self.session)
        layout = HarnessLayout.for_session(owner="test-owner", executor="local", backend="harness", session="sid")
        root = layout.root / "skills"
        (root / "demo/user-note.txt").write_text("preserve user data")
        manual = root / "unbound-user"
        manual.mkdir()
        (manual / "SKILL.md").write_text("user skill, not bound")
        run = self.root / "run"
        run.mkdir()
        dirs, names = run_skill_view(layout, run)
        self.assertEqual(names, ["demo"])
        self.assertFalse((Path(dirs[0]) / "unbound-user").exists())
        self.assertFalse((Path(dirs[0]) / "demo/user-note.txt").exists())
        self.session.abilities = {"skills": []}
        await self.bridge._prepare_session_skills(self.session)
        self.assertEqual((root / "demo/user-note.txt").read_text(), "preserve user data")
        self.assertTrue((manual / "SKILL.md").exists())
        self.assertEqual(run_skill_view(layout, self.root), ([], []))

    async def test_nonmanaged_collision_is_not_overwritten(self) -> None:
        root = skill_root(owner="test-owner", backend="harness", session="sid")
        (root / "demo").mkdir(parents=True)
        file = root / "demo/SKILL.md"
        file.write_text("user file")
        with self.assertRaisesRegex(ValueError, "不能覆盖"):
            await self.bridge._prepare_session_skills(self.session)
        self.assertEqual(file.read_text(), "user file")


if __name__ == "__main__":
    unittest.main()
