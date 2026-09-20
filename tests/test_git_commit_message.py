import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.git_commit_message import (
    CommitMessageSettings, DEFAULT_SETTING, collect_evidence, repository_root, build_prompt, clean_message,
)
from src.backend.prompt_store import PromptStore
from src.backend.bridge_ws import BridgeWS
from src.backend.base import StreamDelta
from src.types import Session


class CommitRulesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data")})
        env.start(); self.addCleanup(env.stop)
        self.prompts = PromptStore()
        self.store = CommitMessageSettings(self.prompts)
        self.repo = self.root / "repo"; self.repo.mkdir()
        self.git("init")
        self.git("config", "user.email", "qa@example.invalid")
        self.git("config", "user.name", "QA")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.DEVNULL,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def write(self, name, text):
        (self.repo / name).write_text(text, encoding="utf-8")

    def baseline(self):
        self.write("file.txt", "one\ntwo\nthree\n")
        self.git("add", "."); self.git("commit", "-m", "test baseline")

    def save(self, root, value, owner="alice"):
        return self.store.save(owner, root, value, self.store.get(owner, root)["revision"])

    def test_owner_defaults_project_override_restart_and_revision(self):
        root = repository_root(str(self.repo))
        before = self.store.get("alice")
        self.save("", {**DEFAULT_SETTING, "mode": "custom", "prompt": "默认规则"})
        self.assertEqual(self.store.get("alice", root)["prompt"], "默认规则")
        self.assertEqual(self.store.get("bob", root)["source"], "builtin")
        self.save(root, {**DEFAULT_SETTING, "mode": "custom", "prompt": "项目规则", "signature": False})
        restarted = CommitMessageSettings(self.prompts)
        self.assertEqual(restarted.get("alice", root)["prompt"], "项目规则")
        self.assertFalse(restarted.get("alice", root)["effective"]["signature"])
        with self.assertRaisesRegex(ValueError, "其他窗口"):
            self.store.save("alice", "", DEFAULT_SETTING, before["revision"])
        self.save(root, None)
        self.assertEqual(self.store.get("alice", root)["prompt"], "默认规则")

    def test_live_library_reference_missing_fails_closed(self):
        self.prompts.save_prompt("提交", "第一版")
        self.save("", {**DEFAULT_SETTING, "mode": "library", "promptName": "提交"})
        self.prompts.save_prompt("提交", "第二版")
        self.assertEqual(self.store.get("alice")["prompt"], "第二版")
        self.prompts.delete_prompt("提交")
        state = self.store.get("alice")
        self.assertIn("不存在", state["resolutionError"])
        with self.assertRaises(ValueError):
            build_prompt(state, {})
        for setting in [{"mode": "bad"}, {"signature": "false"}, {"mode": "custom", "prompt": ""},
                        {"mode": "library", "promptName": "../outside"}, {"arbitrary": True}]:
            with self.assertRaises(ValueError):
                self.save("", setting)

    def test_selected_combines_staged_and_worktree_without_mutating_index(self):
        self.baseline()
        self.write("file.txt", "staged change\ntwo\nthree\n")
        self.git("add", "file.txt")
        self.write("file.txt", "staged change\ntwo\nworking change\n")
        self.write("unrelated.txt", "not selected")
        before = self.git("diff", "--cached")
        evidence = collect_evidence(str(self.repo), False, ["file.txt"])
        self.assertEqual(evidence["files"], ["file.txt"])
        excerpt = evidence["patches"][0]["excerpt"]
        self.assertIn("+staged change", excerpt)
        self.assertIn("+working change", excerpt)
        staged = collect_evidence(str(self.repo), True)
        self.assertNotIn("working change", staged["patches"][0]["excerpt"])
        self.assertEqual(self.git("diff", "--cached"), before)
        self.assertEqual(self.git("rev-list", "--count", "HEAD").strip(), b"1")

    def test_initial_untracked_unicode_binary_and_empty_selection(self):
        self.write("新 文件.txt", "用户可见变化")
        (self.repo / "binary.bin").write_bytes(b"\0binary")
        evidence = collect_evidence(str(self.repo), False)
        self.assertEqual(evidence["fileCount"], 2)
        self.assertIn("用户可见变化", str(evidence))
        self.assertIn("二进制", str(evidence))
        with self.assertRaises(ValueError):
            collect_evidence(str(self.repo), True)
        for selected in [[], ["../outside"], "file.txt", ["/absolute"]]:
            with self.assertRaises(ValueError):
                collect_evidence(str(self.repo), False, selected)
        self.git("add", ".")
        self.assertEqual(collect_evidence(str(self.repo), True)["fileCount"], 2)

    def test_budget_samples_later_files_and_marks_incomplete(self):
        self.baseline()
        self.write("a-large.txt", "large\n" * 5000)
        self.write("z-small.txt", "important late file")
        evidence = collect_evidence(str(self.repo), False, budget=1000)
        self.assertIn("important late file", str(evidence))
        self.assertTrue(evidence["warnings"])
        self.assertTrue(evidence["patches"][0]["truncated"])
        prompt = build_prompt(self.store.get("alice"), evidence)
        self.assertIn("不可信数据", prompt["constraints"])
        self.assertIn("truncated", prompt["content"])

    def test_deleted_and_renamed_paths_and_literal_pathspec(self):
        self.baseline()
        self.git("mv", "file.txt", "renamed.txt")
        self.assertEqual(collect_evidence(str(self.repo), False)["files"], ["file.txt", "renamed.txt"])
        with self.assertRaisesRegex(ValueError, "没有可分析"):
            collect_evidence(str(self.repo), False, [":(glob)*"])

    def test_signature_is_explicit_postprocessing(self):
        source = "```text\nfeat: 行为变化\n\nBy AgentWithU\nCo-Authored-By: someone\n```"
        self.assertEqual(clean_message(source, True), "feat: 行为变化\n\nBy AgentWithU")
        self.assertEqual(clean_message(source, False), "feat: 行为变化")
        with self.assertRaises(ValueError):
            clean_message("", True)

    def test_rpc_preview_and_both_generation_paths_share_rules(self):
        self.baseline(); self.write("file.txt", "changed\n"); self.git("add", ".")
        root = repository_root(str(self.repo))
        self.save(root, {**DEFAULT_SETTING, "mode": "custom", "prompt": "按能力分组", "signature": False}, owner="local")
        bridge = object.__new__(BridgeWS)
        bridge._commit_settings = self.store
        backend = SimpleNamespace(config=SimpleNamespace(id="b"), clear_cancelled=Mock())
        bridge._get_backend = lambda _: backend
        bridge._backend_configs = []
        bridge._emit_event = Mock()
        session = Session(id="s", title="qa", created_at=1, updated_at=1, messages=[],
                          backend_id="b", working_dir=str(self.repo), model_override="model-qa")
        calls = []

        async def generate(_backend, **kwargs):
            calls.append(kwargs)
            kwargs["on_delta"](StreamDelta(kwargs["session_id"], kwargs["message_id"], "text_delta", text="fix: 保留变更说明"))

        with patch("src.backend.text_only.send_text_only", side_effect=generate) as sender:
            preview = json.loads(asyncio.run(bridge._rpc_gitCommitPromptPreview(str(self.repo), True)))
            self.assertEqual(preview["status"], "ok")
            sender.assert_not_called()
            manual = json.loads(asyncio.run(bridge._rpc_gitGenerateCommitMessage(str(self.repo), True, "b")))
            auto = asyncio.run(bridge._auto_generate_commit_msg(str(self.repo), session))
        self.assertEqual(manual["message"], auto)
        self.assertEqual(calls[0]["constraints"], calls[1]["constraints"])
        self.assertIn("按能力分组", calls[0]["constraints"])
        self.assertEqual(calls[1]["model_override"], "model-qa")
        self.assertNotEqual(calls[0]["session_id"], calls[1]["session_id"])

    def test_configuration_rpc_workspace_authorization_and_no_commit_on_failure(self):
        bridge = object.__new__(BridgeWS)
        bridge._require_working_dir_access = Mock(side_effect=PermissionError("denied"))
        with self.assertRaises(PermissionError):
            bridge._authorize_rpc("gitCommitSettingsSave", bridge._rpc_gitCommitSettingsSave, [str(self.repo), "null", "rev"])
        bridge._git_run = Mock(return_value=(0, "changed", ""))
        bridge._auto_generate_commit_msg = AsyncMock(side_effect=ValueError("模板已删除"))
        bridge._emit_event = Mock()
        session = SimpleNamespace(working_dir=str(self.repo), id="s")
        with patch("src.backend.bridge_ws._git_is_repo", return_value=True):
            asyncio.run(bridge._try_auto_commit(session))
        self.assertFalse(any("commit" in call.args[1] for call in bridge._git_run.call_args_list))
        self.assertEqual(bridge._emit_event.call_args.args[1]["status"], "error")

    def test_rules_are_frozen_before_diff_collection(self):
        self.baseline(); self.write("file.txt", "changed")
        self.save("", {**DEFAULT_SETTING, "mode": "custom", "prompt": "本轮规则"}, owner="local")
        bridge = object.__new__(BridgeWS); bridge._commit_settings = self.store

        def collect(*args):
            self.save("", {**DEFAULT_SETTING, "mode": "custom", "prompt": "下一轮规则"}, owner="local")
            return collect_evidence(*args)

        with patch("src.backend.bridge_ws.collect_evidence", side_effect=collect):
            _, prompt = asyncio.run(bridge._commit_message_input(str(self.repo), False, None, "local"))
        self.assertIn("本轮规则", prompt["constraints"])
        self.assertNotIn("下一轮规则", prompt["constraints"])


if __name__ == "__main__":
    unittest.main()
