import asyncio
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.backend.bridge_ws import (
    BridgeWS, _REQUEST_CAN_CLAIM_LEGACY, _REQUEST_IDENTITY_SOURCE,
)
from src.backend.release_center import ReleaseCenterManager, _classify_artifact, sha256_file


class ReleaseCenterTests(unittest.TestCase):
    _ACCOUNT_READY = {
        "configured": True,
        "mode": "workspace",
        "message": "当前执行用户的七牛账号已配置",
        "checkedAt": 1,
    }

    def _project(self, root: Path) -> tuple[Path, Path]:
        project = root / "project"
        (project / "src").mkdir(parents=True)
        (project / "src" / "_version.py").write_text(
            "__version__='26.8.28.120000'\n"
            "__display_version__='26.8.28.120000'\n"
            "__package_version__='26.8.56720'\n"
            "__build_id__='20260828120000-abc123'\n"
            "__build_sequence__=20260828120000\n"
            "__commit__='abc123'\n",
            encoding="utf-8",
        )
        bundle = project / "src-tauri" / "target" / "release" / "bundle" / "msi"
        bundle.mkdir(parents=True)
        installer = bundle / "AgentWithU_26.8.56720_x64_en-US.msi"
        installer.write_bytes(b"msi release fixture\n")
        dist = project / "dist"
        dist.mkdir()
        (dist / "agent-with-u-backend.exe").write_bytes(b"sidecar is not an installer")
        return project, installer

    def _manager(self, root: Path, project: Path) -> ReleaseCenterManager:
        manager = ReleaseCenterManager(root / "release-center")
        manager.configure({"projectRoot": str(project)})
        return manager

    def test_scan_registers_only_publishable_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, installer = self._project(root)
            manager = self._manager(root, project)

            result = manager.scan_project(source="test-build")
            candidate = result["candidate"]

            self.assertEqual("20260828120000-abc123", candidate["buildId"])
            self.assertEqual("26.8.28.120000", candidate["version"])
            self.assertEqual(1, len(candidate["artifacts"]))
            self.assertEqual(str(installer.resolve()), candidate["artifacts"][0]["path"])
            self.assertEqual("msi", candidate["artifacts"][0]["kind"])
            self.assertEqual(sha256_file(installer), candidate["artifacts"][0]["sha256"])

            repeated = manager.scan_project(source="test-build")["candidate"]
            self.assertEqual(candidate["id"], repeated["id"])
            self.assertEqual(1, len(manager.status()["candidates"]))

    def test_docker_image_archive_is_classified_without_custom_installer(self):
        metadata = _classify_artifact(Path("agent-with-u-docker-linux-x86_64.tar"))
        self.assertEqual({
            "platform": "linux", "arch": "x86_64",
            "target": "docker", "kind": "docker-bundle",
        }, metadata)

    def test_docker_bundle_preview_never_requires_manifest_argv_installer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, _ = self._project(root)
            bundle = project / "dist" / "agent-with-u-docker-linux-x86_64.tar"
            bundle.write_bytes(b"docker bundle fixture")
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = self._manager(root, project)
            manager.configure({
                "baseUrl": "https://cdn.example.com",
                "qiniuBucket": "fixture-bucket",
                "qshell": str(qshell),
            })
            candidate = manager.scan_project()["candidate"]
            artifact = next(
                item for item in candidate["artifacts"] if item["kind"] == "docker-bundle"
            )
            with mock.patch.object(
                manager, "qiniu_account_status", return_value=self._ACCOUNT_READY,
            ):
                preview = asyncio.run(manager.preview(
                    candidate["id"], [artifact["id"]], {},
                ))

            self.assertFalse(any("install JSON" in item for item in preview["plan"]["blockers"]))
            self.assertEqual("docker", preview["plan"]["manifest"]["artifacts"][0]["target"])
            self.assertNotIn("install", preview["plan"]["manifest"]["artifacts"][0])

    def test_preview_freezes_hashes_and_compares_stable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, installer = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            stable = root / "stable.json"
            stable.write_text(json.dumps({
                "schemaVersion": 1,
                "channel": "stable",
                "release": {
                    "version": "26.8.27.100000", "sequence": 20260827100000,
                    "buildId": "20260827100000-old", "commit": "old",
                },
                "artifacts": [{
                    "id": "old-msi", "platform": "windows", "arch": "x86_64",
                    "target": "desktop", "kind": "msi", "size": 4, "sha256": "old",
                }],
            }), encoding="utf-8")
            manager = self._manager(root, project)
            manager.configure({
                "baseUrl": "https://cdn.example.com", "qiniuBucket": "fixture-bucket",
                "qshell": str(qshell), "stableManifestUrl": str(stable),
            })
            candidate = manager.scan_project()["candidate"]
            artifact_id = candidate["artifacts"][0]["id"]

            with (
                mock.patch.dict(os.environ, {"AGENT_WITH_U_UPDATE_SIGNING_KEY": "fixture-key"}),
                mock.patch.object(manager, "qiniu_account_status", return_value=self._ACCOUNT_READY),
            ):
                result = asyncio.run(manager.preview(
                    candidate["id"], [artifact_id], {"notes": "ready"},
                ))

            self.assertEqual("ok", result["status"])
            plan = result["plan"]
            self.assertEqual([], plan["blockers"])
            self.assertTrue(plan["comparison"]["available"])
            self.assertTrue(plan["comparison"]["commitChanged"])
            self.assertEqual(sha256_file(installer), plan["uploadJobs"][0]["sha256"])
            self.assertTrue((manager.plans_dir / f"{plan['id']}.json").is_file())
            self.assertTrue(plan["manifestKey"].endswith("stable/manifest.json"))

    def test_changed_artifact_blocks_a_frozen_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, installer = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = self._manager(root, project)
            manager.configure({
                "baseUrl": "https://cdn.example.com", "qiniuBucket": "fixture-bucket",
                "qshell": str(qshell),
            })
            candidate = manager.scan_project()["candidate"]
            installer.write_bytes(b"changed after registration")

            with mock.patch.object(
                manager, "qiniu_account_status", return_value=self._ACCOUNT_READY,
            ):
                result = asyncio.run(manager.preview(
                    candidate["id"], [candidate["artifacts"][0]["id"]], {},
                ))
            self.assertEqual("blocked", result["status"])
            self.assertTrue(any("重新扫描" in item for item in result["plan"]["blockers"]))

    def test_qiniu_account_is_configured_by_qshell_without_persisting_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, _ = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = self._manager(root, project)
            completed = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout="Name: release\nAccessKey: fixture-access\nSecretKey: fixture-secret\n",
                stderr="",
            )

            with mock.patch.object(manager, "_run_qshell_account", return_value=completed) as run:
                config = manager.configure({"qshell": str(qshell)})
                result = manager.configure_qiniu_account(
                    "fixture-access", "-Wfixture-secret", "release-node",
                )

            self.assertTrue(config["qiniuAccountConfigured"])
            self.assertTrue(result["configured"])
            self.assertEqual("release-node", result["accountName"])
            command_args = [call.args[1] for call in run.call_args_list]
            self.assertIn(
                ["--overwrite", "--", "fixture-access", "-Wfixture-secret", "release-node"],
                command_args,
            )
            credential_call = next(
                call for call in run.call_args_list
                if call.args[1] == ["--overwrite", "--", "fixture-access", "-Wfixture-secret", "release-node"]
            )
            self.assertTrue(credential_call.kwargs["local"])
            persisted = manager.config_path.read_text(encoding="utf-8")
            self.assertNotIn("fixture-access", persisted)
            self.assertNotIn("-Wfixture-secret", persisted)
            self.assertNotIn("fixture-access", json.dumps(result))
            self.assertNotIn("-Wfixture-secret", json.dumps(result))

    def test_qshell_account_error_redacts_both_credentials(self):
        message = ReleaseCenterManager._safe_qshell_error(
            "AccessKey: fixture-access\nSecretKey: fixture-secret",
            "failed fixture-access fixture-secret",
            ("fixture-access", "fixture-secret"),
        )
        self.assertNotIn("fixture-access", message)
        self.assertNotIn("fixture-secret", message)
        self.assertIn("***", message)

    def test_preview_blocks_when_qshell_account_is_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, _ = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = self._manager(root, project)
            with mock.patch.object(
                manager, "qiniu_account_status",
                return_value={"configured": False, "message": "尚未配置", "checkedAt": 1},
            ):
                manager.configure({
                    "baseUrl": "https://cdn.example.com", "qiniuBucket": "fixture-bucket",
                    "qshell": str(qshell),
                })
                candidate = manager.scan_project()["candidate"]
                result = asyncio.run(manager.preview(
                    candidate["id"], [candidate["artifacts"][0]["id"]], {},
                ))

            self.assertEqual("blocked", result["status"])
            self.assertTrue(any("AccessKey" in item for item in result["plan"]["blockers"]))

    def test_publish_uploads_channel_manifest_last_and_records_history(self):
        class RecordingManager(ReleaseCenterManager):
            def __init__(self, release_root: Path):
                self.uploaded: list[str] = []
                super().__init__(release_root)

            async def _upload(self, job_id, qshell, bucket, key, path):  # type: ignore[override]
                self.uploaded.append(key)

        async def scenario(root: Path) -> None:
            project, _ = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = RecordingManager(root / "release-center")
            manager.configure({
                "projectRoot": str(project), "baseUrl": "https://cdn.example.com",
                "qiniuBucket": "fixture-bucket", "qshell": str(qshell),
            })
            candidate = manager.scan_project()["candidate"]
            with mock.patch.object(
                manager, "qiniu_account_status", return_value=self._ACCOUNT_READY,
            ):
                preview = await manager.preview(
                    candidate["id"], [candidate["artifacts"][0]["id"]], {},
                )
                self.assertEqual([], preview["plan"]["blockers"])
                started = await manager.start_publish(preview["plan"]["id"])
                job_id = started["job"]["id"]
                await manager._tasks[job_id]

            self.assertEqual(preview["plan"]["manifestKey"], manager.uploaded[-1])
            self.assertEqual(preview["plan"]["versionedManifestKey"], manager.uploaded[-2])
            status = manager.status()
            self.assertEqual("succeeded", status["jobs"][0]["status"])
            self.assertEqual("published", status["candidates"][0]["status"])
            self.assertEqual(1, len(status["history"]))

        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(os.environ, {"AGENT_WITH_U_UPDATE_SIGNING_KEY": "fixture-key"}):
                asyncio.run(scenario(Path(temporary)))


class ReleaseCenterAuthorizationTests(unittest.TestCase):
    def test_release_rpcs_share_the_primary_device_management_gate(self):
        bridge = BridgeWS.__new__(BridgeWS)
        source = _REQUEST_IDENTITY_SOURCE.set("relay")
        capability = _REQUEST_CAN_CLAIM_LEGACY.set(False)
        try:
            with self.assertRaises(PermissionError):
                bridge._authorize_rpc("releaseStatus", lambda: None, [])
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(capability)
            _REQUEST_IDENTITY_SOURCE.reset(source)

        source = _REQUEST_IDENTITY_SOURCE.set("relay")
        capability = _REQUEST_CAN_CLAIM_LEGACY.set(True)
        try:
            bridge._authorize_rpc("releaseStatus", lambda: None, [])
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(capability)
            _REQUEST_IDENTITY_SOURCE.reset(source)


if __name__ == "__main__":
    unittest.main()
