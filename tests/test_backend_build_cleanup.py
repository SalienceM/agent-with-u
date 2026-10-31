from __future__ import annotations

from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import build_backend_package as packaging


class BackendBuildCleanupTests(unittest.TestCase):
    def test_build_preserves_inputs_and_other_artifacts_on_repeated_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            kept = ["build/deepseek-harness/bundle-manifest.json",
                    "build/deepseek-harness/wheels/runtime.whl",
                    "build/deepseek-harness/bridge/lib/index.mjs",
                    "build/agent-with-u-web/cache", "dist/web-linux-x64/archive"]
            for name in kept:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(name.encode())
            filename = "agent-with-u-backend" + (".exe" if sys.platform == "win32" else "")
            removed = ["build/agent-with-u-backend/analysis.toc", "dist/" + filename,
                       "dist/" + filename + ".readiness.json"]

            def freeze(*args: object, **kwargs: object) -> int:
                for name in kept:
                    self.assertEqual((root / name).read_bytes(), name.encode())
                for name in removed:
                    self.assertFalse((root / name).exists())
                    file = root / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(b"new output")
                return 0

            with patch.object(packaging.subprocess, "call", side_effect=freeze) as call:
                self.assertEqual(packaging.build(root), 0)
                self.assertEqual(packaging.build(root), 0)
                self.assertEqual(call.call_count, 2)

    def test_reparse_parent_rejected_before_any_deletion_or_freeze(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            cache = root / "build/agent-with-u-backend"
            cache.mkdir(parents=True)
            sentinel = cache / "sentinel"
            sentinel.touch()
            original = Path.lstat

            def lstat(path: Path) -> object:
                if path == root / "dist":
                    return SimpleNamespace(st_mode=stat.S_IFDIR,
                                           st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
                return original(path)

            with patch.object(Path, "lstat", lstat), patch.object(packaging.subprocess, "call") as call:
                self.assertEqual(packaging.build(root), 1)
                call.assert_not_called()
            self.assertTrue(sentinel.exists())

    def test_cleanup_failure_stops_and_freezer_failure_propagates(self) -> None:
        with patch.object(packaging, "clean_outputs", side_effect=PermissionError("locked")):
            with patch.object(packaging.subprocess, "call") as call:
                self.assertEqual(packaging.build(), 1)
                call.assert_not_called()
        with patch.object(packaging, "clean_outputs"), patch.object(packaging.subprocess, "call", return_value=23):
            self.assertEqual(packaging.build(), 23)

    def test_windows_entrypoints_do_not_remove_shared_build_roots(self) -> None:
        for name in ("build_all.bat", "build_fat_sideonly.bat"):
            script = (packaging.ROOT / name).read_text(encoding="utf-8")
            self.assertNotRegex(script.lower(), r'(?:rmdir|rd)\s+/s\s+/q\s+"?(?:build|dist)"?\s')
            self.assertLess(script.index("prepare_backend_build.py"), script.index("build_backend_package.py"))


if __name__ == "__main__":
    unittest.main()
