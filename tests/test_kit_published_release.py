"""Only isolated files and fake publication; never contacts a release service."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.kit_build_receipts import BuildCapture, register_build_receipt
from src.backend.kit_capabilities import KitCapabilityContext, ReleasePublishLatestCapability
from src.backend.release_center import ReleaseCenterManager, ReleaseCenterError


class PublishedReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "dist").mkdir()
        self.manager = ReleaseCenterManager(self.root / "release")
        self.manager.configure({"baseUrl": "https://invalid.example", "qiniuBucket": "fake"})
        capture = BuildCapture(self.manager, self.project, "run-a", "build")
        self.addCleanup(capture.close)
        (self.project / "src" / "_version.py").write_text(
            "__version__='99.1.1'\n__build_id__='20990101000000-fake'\n"
            "__build_sequence__=20990101000000\n__kit_update_protocol__=1\n", encoding="utf-8")
        self.artifact = self.project / "dist" / "AgentWithU_setup_x64.exe"
        self.artifact.write_bytes(b"fake installer - never execute")
        candidate = self.manager.scan_project(str(self.project))["candidate"]
        register_build_receipt(candidate, capture.environment())
        self.receipt = capture.complete()
        self.context = KitCapabilityContext(self.manager, self.project, "test", "run-a", "publish", self.receipt)
        self.handler = ReleasePublishLatestCapability()

    async def prepare(self):
        with patch.object(self.manager, "_fetch_manifest", return_value=None):
            runtime = await self.handler.prepare({"bindBuild": True}, self.context)
        runtime["boundBuild"] = True
        return runtime

    def fake_job(self, runtime, status="succeeded"):
        # Service boundary fixture, not execution of qshell or installer.
        state = self.manager._load_state()
        state["jobs"] = [{"id": "job-a", "planId": runtime["planId"], "status": status,
                          "kitBinding": {"runId": "run-a", "stepId": "publish"}}]
        self.manager._save_state(state)
        runtime["jobId"] = "job-a"

    async def test_success_bound_to_immutable_manifest_and_exact_run(self):
        runtime = await self.prepare()
        self.fake_job(runtime)
        result = (await self.handler.poll(runtime, self.context))["publishedRelease"]
        self.assertEqual("run-a", result["runId"])
        self.assertEqual("publish", result["stepId"])
        self.assertEqual(1, result["release"]["kitUpdateProtocol"])
        self.assertIn("20990101000000-fake", result["manifestUrl"])
        self.assertNotEqual(runtime["plan"]["manifestUrl"], result["manifestUrl"])
        self.assertEqual(64, len(result["manifestSha256"]))
        for run, step, fingerprint in [("other", "publish", runtime["planFingerprint"]),
                                       ("run-a", "other", runtime["planFingerprint"]),
                                       ("run-a", "publish", "forged")]:
            with self.assertRaises(ReleaseCenterError):
                self.manager.published_result("job-a", runtime["planId"], fingerprint, run, step)

    async def test_non_success_has_no_install_receipt(self):
        runtime = await self.prepare()
        for phase in ("running", "queued", "failed", "cancelled"):
            self.fake_job(runtime, phase)
            self.assertNotIn("publishedRelease", await self.handler.poll(runtime, self.context))
            with self.assertRaises(ReleaseCenterError):
                self.manager.published_result("job-a", runtime["planId"], runtime["planFingerprint"], "run-a", "publish")

    async def test_no_latest_fallback_or_forged_input_receipt(self):
        with patch.object(self.manager, "scan_project", side_effect=AssertionError("must not scan")):
            await self.prepare()
            with self.assertRaisesRegex(Exception, "回执"):
                await self.handler.prepare({"bindBuild": True, "buildReceipt": self.receipt},
                                          KitCapabilityContext(self.manager, self.project, "test", "run-a", "publish"))

    async def test_snapshot_change_and_replaced_file_rejected(self):
        bad = copy.deepcopy(self.receipt)
        bad["candidate"]["artifacts"][0]["platform"] = "linux"
        with self.assertRaises(ReleaseCenterError):
            self.manager.verify_build_snapshot(bad, self.project)
        self.artifact.write_bytes(b"replaced")
        with self.assertRaises(ReleaseCenterError):
            await self.prepare()

    async def test_old_build_does_not_acquire_protocol_from_running_source(self):
        path = self.project / "src" / "_version.py"
        path.write_text(path.read_text(encoding="utf-8").replace("__kit_update_protocol__=1", ""), encoding="utf-8")
        candidate = self.manager.scan_project(str(self.project))["candidate"]
        self.assertEqual(0, candidate["kitUpdateProtocol"])
