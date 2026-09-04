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

    def test_retention_config_is_explicit_and_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, _ = self._project(root)
            manager = self._manager(root, project)

            self.assertEqual(0, manager.public_config()["retentionCount"])
            self.assertEqual(5, manager.configure({"retentionCount": 5})["retentionCount"])
            with self.assertRaisesRegex(Exception, "0 到 100"):
                manager.configure({"retentionCount": 101})

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
                self.refreshed: list[str] = []
                self.public_manifest = None
                super().__init__(release_root)

            async def _upload(self, job_id, qshell, bucket, key, path, **kwargs):  # type: ignore[override]
                self.uploaded.append(key)
                if key.endswith("/stable/manifest.json"):
                    self.public_manifest = json.loads(path.read_text(encoding="utf-8"))

            async def _fetch_manifest(self, source):  # type: ignore[override]
                return self.public_manifest

            async def _refresh_cdn(self, job_id, qshell, manifest_url):  # type: ignore[override]
                self.refreshed.append(manifest_url)
                return True

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
            self.assertEqual([preview["plan"]["manifestUrl"]], manager.refreshed)
            status = manager.status()
            self.assertEqual("succeeded", status["jobs"][0]["status"])
            self.assertEqual("published", status["candidates"][0]["status"])
            self.assertEqual(1, len(status["history"]))

        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(os.environ, {"AGENT_WITH_U_UPDATE_SIGNING_KEY": "fixture-key"}):
                asyncio.run(scenario(Path(temporary)))

    def test_retention_deletes_only_tracked_old_objects_after_verified_publish(self):
        class RetentionManager(ReleaseCenterManager):
            def __init__(self, release_root: Path):
                self.deleted: list[tuple[str, str]] = []
                self.public_manifest = None
                super().__init__(release_root)

            async def _upload(self, job_id, qshell, bucket, key, path, **kwargs):  # type: ignore[override]
                if key.endswith("/stable/manifest.json"):
                    self.public_manifest = json.loads(path.read_text(encoding="utf-8"))

            async def _fetch_manifest(self, source):  # type: ignore[override]
                return self.public_manifest

            async def _refresh_cdn(self, job_id, qshell, manifest_url):  # type: ignore[override]
                return True

            async def _delete_object(self, job_id, qshell, bucket, key):  # type: ignore[override]
                self.deleted.append((bucket, key))

        async def scenario(root: Path) -> None:
            project, _ = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = RetentionManager(root / "release-center")
            manager.configure({
                "projectRoot": str(project), "baseUrl": "https://cdn.example.com",
                "qiniuBucket": "fixture-bucket", "qshell": str(qshell),
                "retentionCount": 1,
            })
            with manager._guard():
                state = manager._load_state()
                state["history"] = [{
                    "id": "old-release", "channel": "stable",
                    "qiniuBucket": "fixture-bucket",
                    "manifestKey": "agentwithu/releases/stable/manifest.json",
                    "objectKeys": [
                        "agentwithu/releases/old/AgentWithU.msi",
                        "agentwithu/releases/old/manifest.json",
                        # 防御旧数据：可变 channel manifest 即使误记也永不删除。
                        "agentwithu/releases/stable/manifest.json",
                    ],
                    "publishedAt": 1,
                }]
                manager._save_state(state)

            candidate = manager.scan_project()["candidate"]
            with mock.patch.object(
                manager, "qiniu_account_status", return_value=self._ACCOUNT_READY,
            ):
                preview = await manager.preview(
                    candidate["id"], [candidate["artifacts"][0]["id"]], {},
                )
                self.assertEqual(1, preview["plan"]["retentionCount"])
                started = await manager.start_publish(preview["plan"]["id"])
                await manager._tasks[started["job"]["id"]]

            status = manager.status()
            self.assertEqual("succeeded", status["jobs"][0]["status"])
            self.assertEqual({
                "removedReleases": 1, "deletedObjects": 2, "failedObjects": 0,
            }, status["jobs"][0]["cleanup"])
            self.assertEqual(1, len(status["history"]))
            self.assertNotEqual("old-release", status["history"][0]["id"])
            self.assertEqual([
                ("fixture-bucket", "agentwithu/releases/old/AgentWithU.msi"),
                ("fixture-bucket", "agentwithu/releases/old/manifest.json"),
            ], manager.deleted)
            self.assertNotIn(
                ("fixture-bucket", "agentwithu/releases/stable/manifest.json"),
                manager.deleted,
            )

        with tempfile.TemporaryDirectory() as temporary:
            asyncio.run(scenario(Path(temporary)))

    def test_cleanup_failure_keeps_old_record_without_failing_published_release(self):
        class CleanupFailureManager(ReleaseCenterManager):
            def __init__(self, release_root: Path):
                self.public_manifest = None
                super().__init__(release_root)

            async def _upload(self, job_id, qshell, bucket, key, path, **kwargs):  # type: ignore[override]
                if key.endswith("/stable/manifest.json"):
                    self.public_manifest = json.loads(path.read_text(encoding="utf-8"))

            async def _fetch_manifest(self, source):  # type: ignore[override]
                return self.public_manifest

            async def _refresh_cdn(self, job_id, qshell, manifest_url):  # type: ignore[override]
                return True

            async def _delete_object(self, job_id, qshell, bucket, key):  # type: ignore[override]
                raise RuntimeError("fixture delete failure")

        async def scenario(root: Path) -> None:
            project, _ = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = CleanupFailureManager(root / "release-center")
            manager.configure({
                "projectRoot": str(project), "baseUrl": "https://cdn.example.com",
                "qiniuBucket": "fixture-bucket", "qshell": str(qshell),
                "retentionCount": 1,
            })
            with manager._guard():
                state = manager._load_state()
                state["history"] = [{
                    "id": "old-release", "channel": "stable",
                    "qiniuBucket": "fixture-bucket",
                    "manifestKey": "agentwithu/releases/stable/manifest.json",
                    "objectKeys": ["agentwithu/releases/old/AgentWithU.msi"],
                    "publishedAt": 1,
                }]
                manager._save_state(state)

            candidate = manager.scan_project()["candidate"]
            with mock.patch.object(
                manager, "qiniu_account_status", return_value=self._ACCOUNT_READY,
            ):
                preview = await manager.preview(
                    candidate["id"], [candidate["artifacts"][0]["id"]], {},
                )
                started = await manager.start_publish(preview["plan"]["id"])
                await manager._tasks[started["job"]["id"]]

            status = manager.status()
            self.assertEqual("succeeded", status["jobs"][0]["status"])
            self.assertEqual(1, status["jobs"][0]["cleanup"]["failedObjects"])
            old = next(item for item in status["history"] if item["id"] == "old-release")
            self.assertIn("fixture delete failure", old["cleanupError"])
            self.assertIn("清理失败", status["jobs"][0]["message"])

        with tempfile.TemporaryDirectory() as temporary:
            asyncio.run(scenario(Path(temporary)))

    def test_upload_reports_intermediate_process_bytes(self):
        class FakeStream:
            async def read(self, _size):
                return b""

        class FakeProcess:
            def __init__(self):
                self.pid = 4242
                self.returncode = None
                self.stdout = FakeStream()
                self.stderr = FakeStream()

            async def wait(self):
                await asyncio.sleep(0.04)
                self.returncode = 0
                return 0

        async def scenario(root: Path) -> None:
            project, _ = self._project(root)
            manager = self._manager(root, project)
            upload_path = root / "large.bin"
            upload_path.write_bytes(b"x" * 1_000)
            with manager._guard():
                state = manager._load_state()
                state["jobs"] = [{
                    "id": "job", "status": "running", "progress": 0,
                    "message": "upload", "log": [], "createdAt": 1, "updatedAt": 1,
                }]
                manager._save_state(state)

            observed_patches = []
            original_update = manager._update_job

            def capture(job_id, patch):
                observed_patches.append(dict(patch))
                return original_update(job_id, patch)

            counters = iter([10_000, 10_120, 10_360, 10_710, 10_900, 10_900, 10_900])
            last_counter = 10_900

            def process_bytes(_pid):
                nonlocal last_counter
                try:
                    last_counter = next(counters)
                except StopIteration:
                    pass
                return last_counter

            process = FakeProcess()
            with (
                mock.patch.object(asyncio, "create_subprocess_exec", new=mock.AsyncMock(return_value=process)),
                mock.patch("src.backend.release_center._process_read_bytes", side_effect=process_bytes),
                mock.patch("src.backend.release_center.UPLOAD_PROGRESS_INTERVAL", 0.005),
                mock.patch.object(manager, "_update_job", side_effect=capture),
            ):
                await manager._upload(
                    "job", "qshell", "bucket", "large.bin", upload_path,
                    completed_bytes=0, total_bytes=1_000,
                )

            intermediate = [
                int(patch.get("currentFileBytes") or 0) for patch in observed_patches
                if 0 < int(patch.get("currentFileBytes") or 0) < 1_000
            ]
            self.assertTrue(intermediate, observed_patches)
            final = manager.status()["jobs"][0]
            self.assertEqual(1_000, final["currentFileBytes"])
            self.assertEqual(1_000, final["uploadedBytes"])

        with tempfile.TemporaryDirectory() as temporary:
            asyncio.run(scenario(Path(temporary)))

    def test_publish_fails_when_public_manifest_is_still_old(self):
        class StaleManifestManager(ReleaseCenterManager):
            async def _upload(self, job_id, qshell, bucket, key, path, **kwargs):  # type: ignore[override]
                return None

            async def _refresh_cdn(self, job_id, qshell, manifest_url):  # type: ignore[override]
                return True

            async def _fetch_manifest(self, source):  # type: ignore[override]
                return {
                    "schemaVersion": 1,
                    "channel": "stable",
                    "release": {
                        "version": "26.8.27.100000",
                        "buildId": "20260827100000-old",
                        "sequence": 20260827100000,
                    },
                    "artifacts": [],
                }

            async def _verify_published_manifest(self, source, expected, **kwargs):  # type: ignore[override]
                return await super()._verify_published_manifest(source, expected, attempts=1)

        async def scenario(root: Path) -> None:
            project, _ = self._project(root)
            qshell = root / ("qshell.exe" if os.name == "nt" else "qshell")
            qshell.write_text("fixture", encoding="utf-8")
            manager = StaleManifestManager(root / "release-center")
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
                started = await manager.start_publish(preview["plan"]["id"])
                await manager._tasks[started["job"]["id"]]

            status = manager.status()
            self.assertEqual("failed", status["jobs"][0]["status"])
            self.assertIn("回读不一致", status["jobs"][0]["error"])
            self.assertEqual("candidate", status["candidates"][0]["status"])
            self.assertEqual([], status["history"])

        with tempfile.TemporaryDirectory() as temporary:
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
