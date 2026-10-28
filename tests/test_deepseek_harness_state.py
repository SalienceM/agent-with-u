"""所有文件均在显式临时数据根；目录/参数不触及用户生产 home。"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from src.backend.deepseek_harness_state import HarnessLayout, HarnessReservation, digest, make_profile_patch, config_fingerprint, reset_context


class HarnessStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-harness-state-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root)})
        env.start()
        self.addCleanup(env.stop)

    def layout(self, **kwargs) -> HarnessLayout:
        return HarnessLayout.for_session(**dict(
            {"owner": "owner-a", "executor": "node-a", "backend": "dsh", "session": "session-a"}, **kwargs))

    def test_all_identity_axes_isolated_and_paths_do_not_use_user_text(self) -> None:
        first = self.layout()
        for field in ("owner", "executor", "backend", "session"):
            other = self.layout(**{field: "../../other"})
            self.assertNotEqual(first.root, other.root)
            self.assertEqual(other.root.parent, self.root / "deepseek-harness")
        self.assertEqual(first, self.layout())

    def test_metadata_roundtrip_and_failed_restore_never_replaces(self) -> None:
        layout = self.layout()
        layout.create()
        meta = layout.read_metadata(cwd=str(self.root), native_id=None)
        layout.save_metadata(meta)
        self.assertEqual(layout.read_metadata(cwd=str(self.root), native_id=meta["nativeId"]), meta)
        original = (layout.root / "session.json").read_bytes()
        for cwd, native in (("different-cwd", meta["nativeId"]), (str(self.root), "awu-other")):
            with self.assertRaises(ValueError):
                layout.read_metadata(cwd=cwd, native_id=native)
            self.assertEqual((layout.root / "session.json").read_bytes(), original)
        with self.assertRaises(ValueError):
            self.layout(session="missing").read_metadata(cwd=str(self.root), native_id="awu-missing")

    def test_patch_is_plain_data_and_contains_no_credentials_or_prompt(self) -> None:
        bridge = self.root / "bridge with spaces.mjs"
        bridge.touch()
        malicious = "{{model}} !!js process.exit(1)\n- name: evil\n"
        rows = make_profile_patch(native_id="awu-test", generation="run", fingerprint=digest({"label": malicious}),
                                  bridge=bridge, cwd=str(self.root / malicious), mode="read-only", skip_permissions=True)
        roundtrip = json.loads(json.dumps(rows))
        settings = {row["id"]: row for row in roundtrip if "id" in row}
        self.assertEqual(settings["sandbox-policy"]["config"]["workspaceRoot"], str(self.root / malicious))
        self.assertEqual(settings["sandbox-policy"]["config"]["mode"], "read-only")
        self.assertEqual(settings["approval"]["config"]["policy"], "never")
        self.assertTrue(settings["sdk-jsonrpc-server"]["disabled"])
        self.assertTrue(settings["session-log-deepseek"]["disabled"])
        self.assertEqual(settings["skill-filesystem"]["config"], {
            "includeDefaultRoots": False, "watch": False, "customSkillDirs": []})
        self.assertNotIn("apiKey", json.dumps(rows))

    def test_fingerprint_changes_with_secrets_without_persisting_them(self) -> None:
        config = SimpleNamespace(to_dict=lambda: {"apiKey": "fixture-secret", "env": {"TOKEN": "fixture-env"}})
        first = config_fingerprint(config, runtime={"model": "one"}, constraints="private rules")
        second = config_fingerprint(config, runtime={"model": "two"}, constraints="private rules")
        self.assertNotEqual(first, second)
        self.assertEqual(len(first), 64)
        layout = self.layout()
        layout.create()
        meta = layout.read_metadata(cwd=str(self.root), native_id=None)
        meta["configFingerprint"] = first
        layout.save_metadata(meta)
        body = (layout.root / "session.json").read_text(encoding="utf-8")
        for secret in ("fixture-secret", "fixture-env", "private rules"):
            self.assertNotIn(secret, body)

    def test_lock_is_exclusive_unknown_retained_and_disk_marker_protects_restart(self) -> None:
        layout = self.layout()
        first, second = HarnessReservation(layout), HarnessReservation(layout)
        first.acquire()
        first.mark_active("generation", os.getpid())
        with self.assertRaises(RuntimeError):
            second.acquire()
        first.release(confirmed=False)
        self.assertIsNotNone(first.handle)
        self.assertTrue(layout.activity_file.exists())
        # 模拟 AWU 进程崩溃后 OS 自动关闭文件锁；磁盘标记仍阻止重放。
        first.handle.close()
        first.handle = None
        with self.assertRaisesRegex(RuntimeError, "退出未确认"):
            second.acquire()
        first.release(confirmed=True)
        second.acquire()
        second.release(confirmed=True)

    def test_symlinked_managed_directory_fails_closed(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        linked = self.root / "deepseek-harness"
        try:
            linked.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("OS does not allow test symlinks")
        with self.assertRaisesRegex(ValueError, "reparse"):
            self.layout()

    def test_guard_survives_backend_switch_and_explicit_reset_preserves_old_binding(self) -> None:
        layout = self.layout()
        layout.create()
        meta = layout.read_metadata(cwd=str(self.root), native_id=None)
        meta["submitted"] = True
        layout.save_metadata(meta)
        reservation = HarnessReservation(layout)
        reservation.acquire()
        reservation.mark_active("fake-generation")
        self.assertEqual(layout.guard_root, self.layout(backend="changed-backend").guard_root)
        try:
            with self.assertRaises(RuntimeError):
                HarnessReservation(self.layout(backend="changed-backend")).acquire()
            with self.assertRaises(RuntimeError):
                reset_context(layout, cwd=str(self.root))
        finally:
            reservation.release(confirmed=True)
        reset_context(layout, cwd=str(self.root))
        new = layout.read_metadata(cwd=str(self.root), native_id=None)
        self.assertNotEqual(meta["nativeId"], new["nativeId"])
        self.assertFalse(new.get("submitted"))
        self.assertEqual(json.loads((layout.root / "bindings" / (meta["nativeId"] + ".json")).read_text()), meta)


if __name__ == "__main__":
    unittest.main()
