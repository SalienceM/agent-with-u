"""Exact-release staging tests. Payloads are inert bytes; no installer is invoked."""
import copy
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.update_manager import UpdateManager, UpdateError, _canonical_manifest_payload


class PublishedUpdateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manager = UpdateManager(self.root / "updates")
        self.manager.configure({"manifestUrl": str(self.root / "latest.json"), "channel": "beta"})
        self.artifact = self.root / "fixture.msi"
        self.artifact.write_bytes(b"not an executable installer")
        self.document = {"schemaVersion": 1, "channel": "stable", "release": {
            "version": "99.1.1", "buildId": "20990101000000-a", "sequence": 20990101000000,
            "kitUpdateProtocol": 1}, "artifacts": [{
                "id": "msi-a", "kind": "msi", "platform": "windows", "arch": "x86_64", "target": "desktop",
                "url": str(self.artifact), "fileName": "fixture.msi", "size": self.artifact.stat().st_size,
                "sha256": hashlib.sha256(self.artifact.read_bytes()).hexdigest()}]}
        for name, result in [("_platform", "windows"), ("_runtime", "desktop"), ("_arch", "x86_64")]:
            started = patch("src.backend.update_manager." + name, return_value=result)
            started.start()
            self.addCleanup(started.stop)

    def publish(self):
        path = self.root / "immutable-a.json"
        path.write_text(json.dumps(self.document), encoding="utf-8")
        return {"schemaVersion": 1, "runId": "run-a", "stepId": "publish", "jobId": "job-a", "planId": "plan-a",
                "planFingerprint": "f" * 64, "manifestUrl": str(path),
                "manifestSha256": hashlib.sha256(_canonical_manifest_payload(self.document)).hexdigest(),
                "channel": "stable", "release": copy.deepcopy(self.document["release"]),
                "artifacts": copy.deepcopy(self.document["artifacts"])}

    async def test_latest_drift_does_not_change_exact_download_or_config(self):
        published = self.publish()
        before = self.manager.config_path.read_bytes()
        (self.root / "latest.json").write_text('{"release":{"buildId":"other"}}', encoding="utf-8")
        result = await self.manager.stage_published(published)
        self.assertEqual("staged", result["phase"])
        self.assertEqual("20990101000000-a", result["release"]["buildId"])
        self.assertEqual(before, self.manager.config_path.read_bytes())
        self.assertEqual(self.artifact.read_bytes(), Path(result["stagedPath"]).read_bytes())

    async def test_manifest_drift_and_artifact_replacement_rejected(self):
        published = self.publish()
        self.document["release"]["buildId"] = "other"
        self.publish()
        with self.assertRaisesRegex(UpdateError, "摘要"):
            await self.manager.stage_published(published)
        self.document["release"]["buildId"] = "20990101000000-a"
        published = self.publish()
        self.artifact.write_bytes(b"wrong")
        with self.assertRaisesRegex(UpdateError, "mismatch"):
            await self.manager.stage_published(published)
        self.assertFalse(list((self.root / "updates").rglob("install-plan.json")))

    async def test_multiple_installers_require_explicit_selection(self):
        self.document["artifacts"].append({**self.document["artifacts"][0], "id": "msi-b"})
        published = self.publish()
        self.assertEqual("needs_selection", (await self.manager.stage_published(published))["phase"])
        self.assertIsNone(self.manager._task)
        with self.assertRaisesRegex(UpdateError, "选择"):
            await self.manager.stage_published(published, "absent")
        self.assertEqual("staged", (await self.manager.stage_published(published, "msi-b"))["phase"])

    async def test_legacy_protocol_wrong_platform_and_commands_fail_closed(self):
        for protocol in (None, 0, 2, True):
            self.document["release"]["kitUpdateProtocol"] = protocol
            with self.assertRaisesRegex(UpdateError, "协议"):
                await self.manager.stage_published(self.publish())
        self.document["release"]["kitUpdateProtocol"] = 1
        self.document["artifacts"][0]["platform"] = "linux"
        with self.assertRaisesRegex(UpdateError, "Windows"):
            await self.manager.stage_published(self.publish())
        self.document["artifacts"][0]["platform"] = "windows"
        self.document["artifacts"][0]["install"] = {"program": "arbitrary"}
        with self.assertRaisesRegex(UpdateError, "自定义"):
            await self.manager.stage_published(self.publish())

    async def test_signature_policy_is_not_downgraded(self):
        self.manager.configure({"requireSignature": True, "signatureKey": "fixture-only"})
        with self.assertRaisesRegex(UpdateError, "signature"):
            await self.manager.stage_published(self.publish())
        self.document["signature"] = {"algorithm": "hmac-sha256", "value": hmac.new(
            b"fixture-only", _canonical_manifest_payload(self.document), hashlib.sha256).hexdigest()}
        self.assertEqual("staged", (await self.manager.stage_published(self.publish()))["phase"])
