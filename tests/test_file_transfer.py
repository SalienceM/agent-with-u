from __future__ import annotations

import base64
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS


class FileTransferTests(unittest.TestCase):
    def setUp(self) -> None:
        # 分块 RPC 不依赖 BridgeWS 的运行态成员，绕过昂贵的完整后端初始化。
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def parsed(raw: str) -> dict:
        return json.loads(raw)

    def test_chunk_upload_keeps_old_file_until_finish(self) -> None:
        target = self.root / "nested" / "large.bin"
        target.parent.mkdir()
        target.write_bytes(b"old")
        transfer = "transfer_12345678"
        payload = b"A" * 700_000 + b"B" * 300_000

        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteStart(str(self.root), "nested/large.bin", transfer))["status"], "ok")
        self.assertEqual(target.read_bytes(), b"old")

        first = payload[:700_000]
        second = payload[700_000:]
        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteChunk(
            str(self.root), "nested/large.bin", transfer, 0, base64.b64encode(first).decode()
        ))["written"], len(first))
        self.assertEqual(target.read_bytes(), b"old")
        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteChunk(
            str(self.root), "nested/large.bin", transfer, len(first), base64.b64encode(second).decode()
        ))["status"], "ok")
        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteFinish(
            str(self.root), "nested/large.bin", transfer, len(payload)
        ))["status"], "ok")
        self.assertEqual(target.read_bytes(), payload)

    def test_chunk_read_and_invalid_offset(self) -> None:
        payload = bytes(range(256)) * 6000
        target = self.root / "data.bin"
        target.write_bytes(payload)
        first = self.parsed(self.bridge._rpc_syncReadChunk(str(self.root), "data.bin", 0, 700_000))
        second = self.parsed(self.bridge._rpc_syncReadChunk(str(self.root), "data.bin", first["size"], 700_000))
        restored = base64.b64decode(first["data"]) + base64.b64decode(second["data"])
        self.assertEqual(restored, payload[:1_400_000])
        self.assertEqual(first["total"], len(payload))

        transfer = "transfer_abcdefgh"
        self.bridge._rpc_syncWriteStart(str(self.root), "new.bin", transfer)
        error = self.parsed(self.bridge._rpc_syncWriteChunk(
            str(self.root), "new.bin", transfer, 12, base64.b64encode(b"bad").decode()
        ))
        self.assertEqual(error["status"], "error")
        self.assertFalse((self.root / "new.bin").exists())
        self.bridge._rpc_syncWriteAbort(str(self.root), "new.bin", transfer)

    def test_file_panel_can_list_hidden_git_directory(self) -> None:
        (self.root / ".git").mkdir()
        (self.root / ".git" / "config").write_text("[core]", encoding="utf-8")
        (self.root / ".env").write_text("secret=false", encoding="utf-8")

        default_entries = self.parsed(
            self.bridge._rpc_listDirectory("", str(self.root))
        )
        self.assertNotIn(".git", {item["name"] for item in default_entries})

        transfer_entries = self.parsed(
            self.bridge._rpc_listDirectory("", str(self.root), True)
        )
        self.assertIn(".git", {item["name"] for item in transfer_entries})
        self.assertIn(".env", {item["name"] for item in transfer_entries})
        env_entry = next(item for item in transfer_entries if item["name"] == ".env")
        self.assertIsInstance(env_entry["mtime"], int)
        git_entry = next(item for item in transfer_entries if item["name"] == ".git")
        self.assertIsNone(git_entry["mtime"])

    def test_sync_manifest_excludes_git_by_default_and_requires_opt_in(self) -> None:
        (self.root / ".git").mkdir()
        (self.root / ".git" / "config").write_text("[core]", encoding="utf-8")
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules" / "package.js").write_text("ignored", encoding="utf-8")
        # 普通模式始终排除 .git；显式迁移模式则优先于旧 syncIgnore 配置。
        self.bridge._app_config_store = Mock()
        self.bridge._app_config_store.get.return_value = [".git", "node_modules"]

        manifest = self.parsed(self.bridge._rpc_syncManifest(str(self.root)))
        self.assertEqual("ok", manifest["status"])
        self.assertNotIn(".git/config", manifest["files"])
        self.assertNotIn("node_modules/package.js", manifest["files"])

        ordinary = self.root / "ordinary.txt"
        ordinary.write_text("mtime", encoding="utf-8")
        with_mtime = self.parsed(self.bridge._rpc_syncManifest(str(self.root)))
        self.assertIsInstance(with_mtime["files"]["ordinary.txt"]["mtime"], int)
        self.assertGreater(with_mtime["files"]["ordinary.txt"]["mtime"], 0)

        migration_manifest = self.parsed(
            self.bridge._rpc_syncManifest(str(self.root), True)
        )
        self.assertIn(".git/config", migration_manifest["files"])
        self.assertNotIn("node_modules/package.js", migration_manifest["files"])

    def test_fast_file_list_returns_subtree_sizes_and_hidden_git_files(self) -> None:
        (self.root / ".git" / "objects").mkdir(parents=True)
        (self.root / ".git" / "objects" / "abc").write_bytes(b"git-object")
        (self.root / "src").mkdir()
        (self.root / "src" / "main.py").write_bytes(b"print('ok')")
        (self.root / "outside.txt").write_bytes(b"outside")

        blocked = self.parsed(self.bridge._rpc_syncFileList(str(self.root), ".git"))
        self.assertEqual("error", blocked["status"])

        subtree = self.parsed(
            self.bridge._rpc_syncFileList(str(self.root), ".git", True)
        )
        self.assertEqual("ok", subtree["status"])
        self.assertEqual({".git/objects/abc": 10}, subtree["files"])

        root_list = self.parsed(self.bridge._rpc_syncFileList(str(self.root), ""))
        self.assertEqual(11, root_list["files"]["src/main.py"])
        self.assertNotIn(".git/objects/abc", root_list["files"])

        migration_root = self.parsed(
            self.bridge._rpc_syncFileList(str(self.root), "", True)
        )
        self.assertIn(".git/objects/abc", migration_root["files"])

    def test_fast_file_list_rejects_paths_outside_workspace(self) -> None:
        result = self.parsed(self.bridge._rpc_syncFileList(str(self.root), "../outside"))
        self.assertEqual("error", result["status"])

    def test_sync_manifest_reuses_hash_when_size_and_mtime_are_unchanged(self) -> None:
        target = self.root / "cached.bin"
        target.write_bytes(b"stable")
        self.bridge._app_config_store = Mock()
        self.bridge._app_config_store.get.return_value = []
        first = self.parsed(self.bridge._rpc_syncManifest(str(self.root)))
        cache = self.bridge._sync_manifest_cache
        cache_key = next(iter(cache))
        cached_tuple = cache[cache_key]["cached.bin"]

        with patch("hashlib.sha256", side_effect=AssertionError("unchanged file was re-hashed")):
            second = self.parsed(self.bridge._rpc_syncManifest(str(self.root)))
        self.assertEqual(first["files"]["cached.bin"], second["files"]["cached.bin"])
        self.assertEqual(cached_tuple, cache[cache_key]["cached.bin"])

    def test_dispatch_runs_manifest_scan_off_event_loop(self) -> None:
        self.bridge._ensure_kit_scheduler = Mock()
        entered = __import__('threading').Event()
        release = __import__('threading').Event()

        def slow_manifest(*_args):
            entered.set()
            release.wait(2)
            return '{"status":"ok","files":{}}'

        self.bridge._rpc_syncManifest = slow_manifest

        async def scenario() -> None:
            task = asyncio.create_task(self.bridge._dispatch("syncManifest", [str(self.root)]))
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            # 如果 handler 仍直接跑在事件循环，这个 yield 无法及时返回。
            await asyncio.wait_for(asyncio.sleep(0), timeout=0.2)
            release.set()
            result = await asyncio.wait_for(task, timeout=1)
            self.assertIn('"status":"ok"', result)

        try:
            asyncio.run(scenario())
        finally:
            release.set()


if __name__ == "__main__":
    unittest.main()
