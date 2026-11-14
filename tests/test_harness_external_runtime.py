from __future__ import annotations

import copy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from src.backend import deepseek_harness_cli as cli
from src.backend import deepseek_harness_distribution as distribution
from src.backend import deepseek_harness_sdk as sdk
from scripts import harness_pyinstaller, package_policy


class ExternalCliTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="awu-external-cli-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.prefix = self.root / "npm with spaces"
        self.package = self.prefix / "node_modules/@deepseek-ai/dsh"
        (self.package / "lib").mkdir(parents=True)
        self.entry = self.package / "lib/bin.js"
        self.entry.write_text("// fixture; never execute", encoding="utf-8")
        self.manifest = self.package / "package.json"
        self.meta = {"name": "@deepseek-ai/dsh", "version": cli.RUNTIME_VERSION, "bin": {"dsh": "lib/bin.js"}}
        self.manifest.write_text(json.dumps(self.meta), encoding="utf-8")
        self.shim = self.prefix / "dsh.cmd"
        self.shim.write_text("malicious shell commands must never execute", encoding="utf-8")
        self.node = self.root / ("node.exe" if os.name == "nt" else "node")
        self.node.write_bytes(b"fixture executable; subprocess is mocked")
        self.contract = {"packages": {"@deepseek-ai/dsh": {"version": cli.RUNTIME_VERSION,
            "resources": {"package.json": hashlib.sha256(self.manifest.read_bytes()).hexdigest(),
                          "lib/bin.js": hashlib.sha256(self.entry.read_bytes()).hexdigest()}}}}
        self.env = {"PATH": str(self.prefix), "APPDATA": str(self.root / "appdata"), "NODE_OPTIONS": "must-not-inherit"}
        for mock in (patch.object(cli, "load_external_contract", return_value=self.contract),
                     patch.object(cli.shutil, "which", return_value=str(self.node)),
                     patch.object(cli.subprocess, "run", return_value=SimpleNamespace(stdout="v24.10.0\n"))):
            result = mock.start()
            self.addCleanup(mock.stop)
            self.last_mock = result

    def test_windows_shim_and_space_paths_use_node_argv_without_shell(self) -> None:
        selected = cli.resolve_external_cli(str(self.shim), environment=self.env)
        self.assertEqual(selected.source, "explicit")
        self.assertEqual(selected.argv("sdk", ("space patch.json",)),
                         (str(self.node), str(self.entry), "--profile", "sdk", "--patch", "space patch.json"))
        args, kwargs = self.last_mock.call_args
        self.assertEqual(args[0], [str(self.node), "--version"])
        self.assertNotIn("shell", kwargs)
        self.assertNotIn("NODE_OPTIONS", kwargs["env"])

    def test_real_entry_symlink_resolves_same_installation(self) -> None:
        link = self.root / "dsh"
        try:
            link.symlink_to(self.entry)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {type(exc).__name__}")
        selected = cli.resolve_external_cli(str(link), environment=self.env)
        self.assertEqual(selected.entry, self.entry)

    def test_explicit_invalid_does_not_fall_back_to_available_install(self) -> None:
        for name in (str(self.root / "missing.cmd"), "dsh.cmd", str(self.node)):
            with self.subTest(name=name), self.assertRaises(cli.HarnessDependencyError) as caught:
                cli.resolve_external_cli(name, environment=self.env)
            self.assertEqual(caught.exception.reason, "path_invalid")
        self.last_mock.assert_not_called()

    def test_path_discovery_does_not_execute_same_named_python_executable(self) -> None:
        self.shim.unlink()
        (self.prefix / "dsh.exe").write_bytes(b"unrelated")
        with self.assertRaises(cli.HarnessDependencyError) as caught:
            cli.resolve_external_cli(environment=self.env)
        self.assertEqual(caught.exception.reason, "cli_missing")
        self.last_mock.assert_not_called()

    def test_node_missing_and_old_version_are_distinct(self) -> None:
        with patch.object(cli.shutil, "which", return_value=None), self.assertRaises(cli.HarnessDependencyError) as caught:
            cli.resolve_external_cli(str(self.shim), environment=self.env)
        self.assertEqual(caught.exception.reason, "node_missing")
        self.last_mock.return_value.stdout = "v22.15.0"
        with self.assertRaises(cli.HarnessDependencyError) as caught:
            cli.resolve_external_cli(str(self.shim), environment=self.env)
        self.assertEqual(caught.exception.reason, "node_version")

    def test_wrong_version_changed_and_missing_resources_fail_before_start(self) -> None:
        for change in ("version", "bytes", "missing"):
            with self.subTest(change=change):
                self.manifest.write_text(json.dumps({**self.meta, "version": "latest" if change == "version" else cli.RUNTIME_VERSION}), encoding="utf-8")
                self.entry.write_text("// changed", encoding="utf-8")
                if change == "missing":
                    self.entry.unlink()
                with self.assertRaises(cli.HarnessDependencyError) as caught:
                    cli.resolve_external_cli(str(self.shim), environment=self.env)
                self.assertEqual(caught.exception.reason, "version_mismatch" if change == "version" else "installation_invalid")
        self.last_mock.assert_not_called()

    def test_resource_escape_is_rejected(self) -> None:
        changed = copy.deepcopy(self.contract)
        changed["packages"]["@deepseek-ai/dsh"]["resources"]["../outside"] = "0" * 64
        with self.assertRaises(cli.HarnessDependencyError):
            cli.verify_external_package(self.package, changed)

    def test_errors_guide_owner_node_without_leaking_path_or_installing(self) -> None:
        from src.backend.harness_image_errors import harness_error_text
        for reason in ("cli_missing", "path_invalid", "node_missing", "node_version", "version_mismatch", "installation_invalid"):
            message = str(cli.HarnessDependencyError(reason))
            self.assertIn("Session 所属执行节点", message)
            self.assertIn(cli.INSTALL_COMMAND, message)
            self.assertNotIn("latest", message)
            self.assertNotIn(str(self.root), message)
            error = cli.HarnessDependencyError(reason)
            error.args = ("PRIVATE_FIXTURE_ERROR",)
            self.assertEqual(harness_error_text(error), message)


class ExternalPackagingTests(unittest.TestCase):
    def test_docker_builds_adapter_without_host_generated_inputs(self) -> None:
        dockerfile = (Path(__file__).resolve().parents[1] / "deploy/Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY deploy/deepseek-harness.external.json ./deploy/deepseek-harness.external.json", dockerfile)
        self.assertNotIn("COPY build/deepseek-harness", dockerfile)
        self.assertIn("COPY --from=harness-build", dockerfile)
        self.assertIn("verify_adapter()", dockerfile)
        self.assertIn("resolve_external_cli()", dockerfile)

    def test_docker_external_mode_fails_closed_without_bundled_fallback(self) -> None:
        owner = Mock()
        config = SimpleNamespace(env={}, dsh_bin=None)
        with patch.dict(os.environ, {"AGENT_WITH_U_HARNESS_EXTERNAL": "1"}), \
                patch.object(sys, "frozen", False, create=True), \
                patch.object(distribution, "verify_bundle") as bundled, \
                patch.object(cli, "resolve_external_cli", side_effect=cli.HarnessDependencyError("cli_missing")) as external:
            client = sdk.create_client(config=config, owner=owner)
            with self.assertRaises(cli.HarnessDependencyError):
                client.start()
        external.assert_called_once()
        bundled.assert_not_called()
        owner.spawn.assert_not_called()

    def test_source_default_keeps_original_verification_and_no_external_discovery(self) -> None:
        owner = Mock()
        config = SimpleNamespace(env={}, dsh_bin=None)
        with patch.dict(os.environ, {"AGENT_WITH_U_HARNESS_EXTERNAL": "0"}), \
                patch.object(sys, "frozen", False, create=True), \
                patch.object(distribution, "verify_bundle", side_effect=RuntimeError("paired-resource-check")) as legacy, \
                patch.object(cli, "resolve_external_cli") as external:
            client = sdk.create_client(config=config, owner=owner)
            with self.assertRaisesRegex(RuntimeError, "paired-resource-check"):
                client.start()
        legacy.assert_called_once()
        external.assert_not_called()
        owner.spawn.assert_not_called()

    def test_sdk_does_not_require_optional_runtime(self) -> None:
        def version(name):
            if name == "deepseek-harness-runtime-bin":
                raise importlib.metadata.PackageNotFoundError(name)
            return sdk.VERSION
        with patch.object(sdk.importlib.metadata, "version", side_effect=version):
            sdk.require_locked_versions()
            with self.assertRaisesRegex(RuntimeError, "缺少"):
                sdk.require_locked_versions(runtime=True)

    def test_collects_only_sdk_and_lightweight_bridge(self) -> None:
        with patch.object(distribution, "verify_adapter") as verify, \
                patch("PyInstaller.utils.hooks.collect_all", return_value=([], [], [])) as collect, \
                patch("PyInstaller.utils.hooks.copy_metadata", return_value=[]) as metadata:
            data, _, _ = harness_pyinstaller.collect()
        verify.assert_called_once()
        collect.assert_called_once_with("deepseek_harness")
        metadata.assert_called_once_with("deepseek-harness-sdk")
        self.assertTrue(any(source.endswith("deepseek-harness.external.json") for source, _ in data))
        self.assertFalse(any("runtime_bin" in source for source, _ in data))

    def test_actual_toc_cannot_reintroduce_runtime(self) -> None:
        self.assertIn("deepseek_harness_runtime", package_policy.FROZEN_EXCLUDES)
        for member in ("deepseek_harness_runtime", "deepseek_harness_runtime/runtime/node.exe",
                       "deepseek-harness-sdk-runtime-win-x64.exe", "vendor/deepseek-harness-sdk-runtime-linux-x64"):
            with self.assertRaisesRegex(RuntimeError, "Harness"):
                package_policy.validate_analysis(SimpleNamespace(pure=[], binaries=[(member, "", "BINARY")], datas=[]))

    def test_frozen_default_never_falls_back_or_installs(self) -> None:
        owner = Mock()
        config = SimpleNamespace(env={}, dsh_bin=None, cwd=None, dsh_home=None, profile="sdk", patches=())
        with patch.object(sys, "frozen", True, create=True), \
                patch.object(cli, "resolve_external_cli", side_effect=cli.HarnessDependencyError("cli_missing")), \
                patch.object(distribution, "verify_bundle") as legacy:
            client = sdk.create_client(config=config, owner=owner)
            with self.assertRaises(cli.HarnessDependencyError):
                client.start()
            client.close()
        owner.spawn.assert_not_called()
        legacy.assert_not_called()

    def test_explicit_old_runtime_keeps_strict_validation(self) -> None:
        owner = Mock()
        config = SimpleNamespace(env={}, dsh_bin="deepseek-harness-sdk-runtime-win-x64.exe")
        with patch.object(distribution, "verify_runtime_override", side_effect=RuntimeError("digest rejected")) as legacy, \
                patch.object(cli, "resolve_external_cli") as external:
            client = sdk.create_client(config=config, owner=owner)
            with self.assertRaisesRegex(RuntimeError, "digest rejected"):
                client.start()
        legacy.assert_called_once()
        external.assert_not_called()
        owner.spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
