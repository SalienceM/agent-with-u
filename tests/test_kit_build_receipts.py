import tempfile
import unittest
from pathlib import Path

from src.backend.kit_build_receipts import BuildCapture, register_build_receipt
from src.backend.release_center import ReleaseCenterManager


class KitBuildReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "dist").mkdir()
        self.artifact = self.project / "dist" / "AgentWithU_setup_x64.exe"
        self.artifact.write_bytes(b"old")
        self.version("build-old")
        self.manager = ReleaseCenterManager(self.root / "release")

    def version(self, build_id):
        (self.project / "src" / "_version.py").write_text(
            f"__version__='26.11.1'\n__build_id__='{build_id}'\n__build_sequence__=20261101000000\n",
            encoding="utf-8")

    def capture(self):
        capture = BuildCapture(self.manager, self.project, "run-a", "build-a")
        self.addCleanup(capture.close)
        return capture

    def register(self, capture):
        candidate = self.manager.scan_project(str(self.project), "fixture")["candidate"]
        register_build_receipt(candidate, capture.environment())
        return candidate

    def test_current_build_is_snapshot_not_mutable_candidate(self):
        capture = self.capture()
        self.version("build-new")
        self.artifact.write_bytes(b"new")
        candidate = self.register(capture)
        candidate["buildId"] = "other"
        receipt = capture.complete()
        self.assertEqual("build-new", receipt["candidate"]["buildId"])
        self.assertEqual("run-a", receipt["runId"])

    def test_old_build_rejected_even_with_successful_registration(self):
        capture = self.capture()
        self.register(capture)
        with self.assertRaisesRegex(ValueError, "版本标识"):
            capture.complete()

    def test_new_version_without_new_artifact_is_rejected(self):
        capture = self.capture()
        self.version("build-new")
        self.register(capture)
        with self.assertRaisesRegex(ValueError, "新制品"):
            capture.complete()

    def test_missing_registration_is_not_success(self):
        capture = self.capture()
        with self.assertRaisesRegex(ValueError, "未登记"):
            capture.complete()

    def test_replaced_artifact_rejected(self):
        capture = self.capture()
        self.version("build-new")
        self.artifact.write_bytes(b"new")
        self.register(capture)
        self.artifact.write_bytes(b"bad")
        with self.assertRaisesRegex(ValueError, "已改变"):
            capture.complete()

    def test_parallel_build_cannot_take_project(self):
        self.capture()
        with self.assertRaisesRegex(ValueError, "并发"):
            BuildCapture(self.manager, self.project, "run-b", "build-b")

    def test_other_run_cannot_register_and_duplicate_receipt_is_rejected(self):
        capture = self.capture()
        self.version("build-new")
        self.artifact.write_bytes(b"new")
        candidate = self.manager.scan_project(str(self.project))["candidate"]
        env = {**capture.environment(), "AWU_KIT_BUILD_NONCE": "wrong"}
        with self.assertRaisesRegex(ValueError, "身份"):
            register_build_receipt(candidate, env)
        register_build_receipt(candidate, capture.environment())
        with self.assertRaises(FileExistsError):
            register_build_receipt(candidate, capture.environment())

    def test_non_kit_registration_has_no_additional_writes(self):
        register_build_receipt({}, {})
        self.assertFalse((self.manager.root / "kit-builds").exists())


if __name__ == "__main__":
    unittest.main()
