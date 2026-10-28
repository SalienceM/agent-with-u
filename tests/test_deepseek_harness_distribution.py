from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from scripts.prepare_deepseek_harness import load_lock, main, verify_source, verify_wheel
from src.backend import deepseek_harness_distribution as bundle


class HarnessDistributionTests(unittest.TestCase):
    def test_locked_version_is_exact_and_matches_python_pair(self) -> None:
        lock = load_lock()
        self.assertEqual(lock["pythonVersion"], "0.2.1rc3")
        self.assertNotEqual(lock["pythonVersion"], lock["observedChannels"]["pypiSdk"])
        for key, value in (("pythonVersion", "0.2.1rc2"), ("version", "latest"), ("commit", "main")):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary:
                data = copy.deepcopy(lock)
                data[key] = value
                path = Path(temporary) / "lock.json"
                path.write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_lock(path)

    def test_wrong_source_or_tracked_changes_rejected_before_build(self) -> None:
        lock = load_lock()
        with patch("scripts.prepare_deepseek_harness._git", return_value=b"wrong\n"):
            with self.assertRaisesRegex(ValueError, "commit"):
                verify_source(Path("unused"), lock)
        with patch("scripts.prepare_deepseek_harness._git", side_effect=[lock["commit"].encode(), b" M tracked"]):
            with self.assertRaisesRegex(ValueError, "local changes"):
                verify_source(Path("unused"), lock)

    def _sdk_wheel(self, directory: Path, dependency: str) -> Path:
        path = directory / "deepseek_harness_sdk-0.2.1rc3-py3-none-any.whl"
        prefix = "deepseek_harness_sdk-0.2.1rc3.dist-info/"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(prefix + "METADATA", "Metadata-Version: 2.4\nName: deepseek-harness-sdk\n"
                             "Version: 0.2.1rc3\nLicense-Expression: MIT\nLicense-File: LICENSE\n"
                             f"Requires-Dist: {dependency}\n")
            archive.writestr(prefix + "WHEEL", "Wheel-Version: 1.0\nTag: py3-none-any\n")
            archive.writestr(prefix + "licenses/LICENSE", "test license fixture")
        return path

    def test_same_version_sdk_wheel_checksums_and_pairing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            wheel = self._sdk_wheel(Path(temporary), "deepseek-harness-runtime-bin==0.2.1rc3")
            receipt = verify_wheel(wheel, load_lock())
            self.assertEqual(len(receipt["sha256"]), 64)
            self.assertEqual(receipt["version"], "0.2.1rc3")
            self.assertGreater(receipt["size"], 0)
            self._sdk_wheel(Path(temporary), "deepseek-harness-runtime-bin==0.2.1rc2")
            with self.assertRaisesRegex(ValueError, "same runtime"):
                verify_wheel(wheel, load_lock())

    def test_alias_and_wrong_platform_fail_before_opening(self) -> None:
        for name, platform in (("sdk-latest.whl", None), ("runtime.whl", "linux-arm64")):
            with self.subTest(name=name), self.assertRaises(ValueError):
                verify_wheel(Path(name), load_lock(), platform)

    def test_staged_cli_receipt_reports_verified_pair_and_propagates_failure(self) -> None:
        arguments = ["prepare_deepseek_harness.py", "--verify-staged", "fixture", "--platform", "win-x64"]
        with patch.object(sys, "argv", arguments), patch("builtins.print") as output:
            with patch("scripts.prepare_deepseek_harness.verify_staged_wheels",
                       return_value=[Path("sdk.whl"), Path("runtime.whl")]):
                main()
            self.assertTrue(json.loads(output.call_args.args[0])["pairedWheelsVerified"])
            output.reset_mock()
            with patch("scripts.prepare_deepseek_harness.verify_staged_wheels",
                       side_effect=ValueError("digest mismatch")):
                with self.assertRaisesRegex(ValueError, "digest mismatch"):
                    main()
            output.assert_not_called()


class BundleResourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-harness-bundle-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.name = "deepseek-harness-sdk-runtime-linux-x64"
        self.runtime = self.root / "deepseek_harness_runtime/runtime" / self.name
        self.runtime.parent.mkdir(parents=True)
        self.runtime.write_bytes(b"owned executable fixture")
        self.runtime.chmod(0o700)
        resource = self.runtime.relative_to(self.root).as_posix()
        self.manifest = {"platforms": {"linux-x64": {resource: {
            "sha256": hashlib.sha256(self.runtime.read_bytes()).hexdigest(), "executable": True}}}, "bridge": {}}
        module = types.ModuleType("deepseek_harness_runtime")
        module.bundled_package_dir = lambda: self.root / "deepseek_harness_runtime"
        for mock in (patch.dict(sys.modules, {"deepseek_harness_runtime": module}),
                     patch.object(bundle, "bundle_manifest", return_value=(self.root, self.manifest)),
                     patch.object(bundle, "target_platform", return_value="linux-x64"),
                     patch.object(bundle.importlib.metadata, "version", return_value=bundle.VERSION)):
            mock.start()
            self.addCleanup(mock.stop)

    def test_verified_inventory_and_exact_runtime_override(self) -> None:
        self.assertEqual(len(bundle.verify_bundle()), 1)
        self.assertEqual(bundle.verify_runtime_override(self.runtime), self.runtime.resolve())
        self.runtime.write_bytes(b"different runtime claiming same version")
        for check in (bundle.verify_bundle, lambda: bundle.verify_runtime_override(self.runtime)):
            with self.assertRaisesRegex(RuntimeError, "校验失败"):
                check()

    def test_missing_resource_unsafe_manifest_and_wrong_version_fail_closed(self) -> None:
        with patch.object(bundle.importlib.metadata, "version", return_value="0.2.1rc2"):
            with self.assertRaisesRegex(RuntimeError, "版本不匹配"):
                bundle.verify_bundle()
        self.runtime.unlink()
        with self.assertRaisesRegex(RuntimeError, "缺失"):
            bundle.verify_bundle()
        self.manifest["bridge"]["../escaped"] = {"sha256": "0" * 64, "executable": False}
        self.manifest["platforms"]["linux-x64"].clear()
        with self.assertRaisesRegex(RuntimeError, "路径无效"):
            bundle.verify_bundle()

    def test_executable_repair_is_only_for_verified_frozen_resource(self) -> None:
        with patch.object(sys, "platform", "linux"), patch.object(os, "access", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "权限缺失"):
                bundle.verify_bundle(repair_executable=True)
            with patch.object(sys, "frozen", True, create=True), patch.object(Path, "chmod") as chmod:
                bundle.verify_bundle(repair_executable=True)
                chmod.assert_called_once()
            self.runtime.write_bytes(b"tampered")
            with patch.object(sys, "frozen", True, create=True), patch.object(Path, "chmod") as chmod:
                with self.assertRaisesRegex(RuntimeError, "校验失败"):
                    bundle.verify_bundle(repair_executable=True)
                chmod.assert_not_called()

    def test_unsupported_architecture_is_explicit(self) -> None:
        # Restore the real function only for this platform gate assertion.
        # Call the saved real function without invalidating the fixture patches.
        with patch.object(bundle.platform, "machine", return_value="arm64"):
            with self.assertRaisesRegex(RuntimeError, "仅验证"):
                _target_platform()


_target_platform = bundle.target_platform


if __name__ == "__main__":
    unittest.main()
