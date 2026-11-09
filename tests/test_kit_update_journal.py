import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.kit_update_journal import InstallJournal, JournalError, durable_json
from src.backend.update_manager import UpdateManager


class InstallJournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.journal = InstallJournal(self.root)
        self.request = "a" * 32
        self.identity = dict(ownerId="owner", deviceId="device", instanceId="instance",
                             sessionId="session", runId="run", stepId="install")
        self.release = dict(version="99.1.1.120000", packageVersion="99.1.1", buildId="full-build", sequence=123)

    def confirmed(self):
        self.journal.reserve(self.request, self.identity)
        frozen = self.journal.freeze(self.request, self.identity, {"release": self.release})
        return self.journal.confirm(self.request, self.identity, frozen["planFingerprint"], "confirmation-request")

    def receipt(self, record, **changes):
        value = {"protocol": 1, "requestId": self.request, "identity": self.identity,
                 "planFingerprint": record["planFingerprint"], "installation": "succeeded", "restart": "started", **changes}
        durable_json(self.journal.path(self.request).with_suffix(".result.json"), value)

    def test_exclusive_reservation_survives_restart_and_unknown_write(self):
        self.journal.reserve(self.request, self.identity)
        restarted = InstallJournal(self.root)
        with self.assertRaises(JournalError):
            restarted.reserve("b" * 32, self.identity)
        with self.assertRaises(JournalError):
            restarted.reserve(self.request, {**self.identity, "ownerId": "other"})
        self.assertEqual("preparing", restarted.reserve(self.request, self.identity)["phase"])

    def test_failure_after_slot_write_retains_protection(self):
        original = durable_json
        def fail_record(path, value):
            if path.name == self.request + ".json":
                raise OSError("simulated full disk")
            original(path, value)
        with patch("src.backend.kit_update_journal.durable_json", side_effect=fail_record):
            with self.assertRaises(OSError):
                self.journal.reserve(self.request, self.identity)
        with self.assertRaisesRegex(JournalError, "未知"):
            self.journal.reserve(self.request, self.identity)
        self.assertEqual(self.request, InstallJournal(self.root).active()["requestId"])

    def test_confirmation_is_idempotent_and_scope_bound(self):
        record = self.confirmed()
        self.assertEqual(record, self.journal.confirm(self.request, self.identity, record["planFingerprint"], "confirmation-request"))
        for identity, fp, cid in [({**self.identity, "ownerId": "other"}, record["planFingerprint"], "confirmation-request"),
                                  (self.identity, "old-fingerprint", "confirmation-request"),
                                  (self.identity, record["planFingerprint"], "different-request")]:
            with self.assertRaises(JournalError):
                self.journal.confirm(self.request, identity, fp, cid)
        with self.assertRaises(JournalError):
            self.journal.freeze(self.request, self.identity, {})
        with self.assertRaises(JournalError):
            self.journal.release(self.request, self.identity)
        with self.assertRaises(JournalError):
            self.journal.update(self.request, self.identity, {"phase": "preparing"})

    def test_cancel_before_handoff_only_releases_own_slot(self):
        self.journal.reserve(self.request, self.identity)
        with self.assertRaises(JournalError):
            self.journal.release(self.request, {**self.identity, "deviceId": "other"})
        self.journal.release(self.request, self.identity)
        self.assertFalse(self.journal.active())
        with self.assertRaises(JournalError):
            self.journal.reserve(self.request, self.identity)

    def test_ordinary_update_cannot_overwrite_kit_reservation(self):
        manager = UpdateManager(self.root)
        manager.reserve_kit(self.request, self.identity)
        with self.assertRaises(JournalError):
            manager._reserve_normal()
        with self.assertRaises(JournalError):
            manager.prepare_apply()
        with self.assertRaises(JournalError):
            manager.mark_install_failed("not this update")
        durable_json(manager.result_path, {"ok": True, "finishedAt": 99999999999})
        manager.status()
        self.assertNotEqual("installed", manager._state["phase"])
        self.assertTrue(manager.journal.active())

    def test_no_success_without_bound_receipt_and_both_actual_versions(self):
        record = self.confirmed()
        desktop = {"instanceId": "instance", "deviceId": "device", "protocol": 1, "release": self.release}
        for changes in ({"identity": {**self.identity, "deviceId": "other"}}, {"requestId": "b" * 32},
                        {"planFingerprint": "old"}):
            self.receipt(record, **changes)
            checked = self.journal.reconcile(self.request, self.identity, desktop=desktop, backend=self.release, ready=True)
            self.assertNotEqual("succeeded", checked["phase"])
        self.receipt(record)
        for view, backend, ready in [(None, self.release, True), (desktop, {}, True),
                                     ({**desktop, "release": {**self.release, "buildId": "old"}}, self.release, True),
                                     (desktop, self.release, False)]:
            checked = self.journal.reconcile(self.request, self.identity, desktop=view, backend=backend, ready=ready)
            self.assertNotEqual("succeeded", checked["phase"])
            self.assertTrue(self.journal.active())
        checked = self.journal.reconcile(self.request, self.identity, desktop=desktop, backend=self.release, ready=True)
        self.assertEqual("succeeded", checked["phase"])
        self.assertFalse(self.journal.active())
        self.assertEqual(checked, self.journal.reconcile(self.request, self.identity))

    def test_timeout_unknown_preserves_reservation_and_does_not_replay(self):
        record = self.confirmed()
        checked = self.journal.reconcile(self.request, self.identity, now=record["confirmedAt"] + 181)
        self.assertEqual("result_unknown", checked["phase"])
        self.assertTrue(self.journal.active())
        self.assertFalse(self.journal.path(self.request).with_suffix(".result.json").exists())
        with self.assertRaises(JournalError):
            self.journal.release(self.request, self.identity)

    def test_install_and_restart_failures_remain_failures(self):
        record = self.confirmed()
        self.receipt(record, restart="failed", error="spawn failed")
        checked = self.journal.reconcile(self.request, self.identity)
        self.assertEqual("failed", checked["phase"])
        self.assertIn("spawn failed", checked["message"])

    def test_partial_result_is_explicitly_unknown_and_retains_slot(self):
        self.confirmed()
        self.journal.path(self.request).with_suffix(".result.json").write_text('{"protocol":')
        result = self.journal.reconcile(self.request, self.identity)
        self.assertEqual("result_unknown", result["phase"])
        self.assertTrue(self.journal.active())

    def restarted_evidence(self):
        self.journal.reserve(self.request, self.identity)
        frozen = self.journal.freeze(self.request, self.identity,
            {"release": self.release, "desktop": {"pid": 100}})
        self.journal.confirm(self.request, self.identity, frozen["planFingerprint"], "confirmation-request")
        return {"ready": True, "backend": self.release, "desktop": {
            "instanceId": "instance", "deviceId": "device", "protocol": 1,
            "pid": 200, "installed": True, "release": self.release}}

    def test_manual_install_retires_unlaunched_request_without_success_credit(self):
        evidence = self.restarted_evidence()
        checked = self.journal.retire_unlaunched(self.request, self.identity, evidence)
        self.assertEqual("failed", checked["phase"])
        self.assertEqual("superseded_unlaunched", checked["recovery"]["reason"])
        self.assertNotIn("receipt", checked)
        self.assertFalse(self.journal.active())
        # 与 Rust create_new 相同的抢占语义，阻止已完成 validate 的迟到通知。
        with self.assertRaises(FileExistsError):
            self.journal.path(self.request).with_suffix(".launch.json").open("xb")

    def test_manual_recovery_never_releases_possible_running_helper(self):
        evidence = self.restarted_evidence()
        for suffix in (".launch.json", ".claim.json", ".installed.json", ".result.json"):
            with self.subTest(suffix=suffix):
                path = self.journal.path(self.request).with_suffix(suffix)
                path.write_text("{}")
                with self.assertRaises(JournalError):
                    self.journal.retire_unlaunched(self.request, self.identity, evidence)
                self.assertTrue(self.journal.active())
                path.unlink()

    def test_manual_recovery_requires_new_same_instance_and_matching_versions(self):
        evidence = self.restarted_evidence()
        changes = [{"ready": False}, {"backend": {}}]
        changes += [{"desktop": {**evidence["desktop"], **patch}} for patch in (
            {"pid": 100}, {"pid": 0}, {"installed": False}, {"deviceId": "other"},
            {"instanceId": "other"}, {"release": {**self.release, "buildId": "other"}})]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(JournalError):
                self.journal.retire_unlaunched(self.request, self.identity, {**evidence, **change})
        self.assertTrue(self.journal.active())
        self.assertFalse(self.journal.path(self.request).with_suffix(".launch.json").exists())

    def test_recovery_after_record_write_failure_reuses_only_own_revocation(self):
        evidence = self.restarted_evidence()
        with patch("src.backend.kit_update_journal.durable_json", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.journal.retire_unlaunched(self.request, self.identity, evidence)
        self.assertTrue(self.journal.active())
        self.assertEqual("failed", self.journal.retire_unlaunched(self.request, self.identity, evidence)["phase"])
        self.assertFalse(self.journal.active())

    def test_newer_manual_version_can_close_old_unlaunched_request(self):
        evidence = self.restarted_evidence()
        newer = dict(version="99.2.0.120000", packageVersion="99.2.0", buildId="newer-build", sequence=124)
        evidence["desktop"]["release"] = evidence["backend"] = newer
        self.assertEqual("failed", self.journal.retire_unlaunched(self.request, self.identity, evidence)["phase"])

    def test_old_or_conflicting_release_cannot_close_request(self):
        evidence = self.restarted_evidence()
        for release in ({**self.release, "sequence": 122}, {**self.release, "buildId": "conflicting"}):
            evidence["desktop"]["release"] = evidence["backend"] = release
            with self.assertRaises(JournalError):
                self.journal.retire_unlaunched(self.request, self.identity, evidence)
        self.assertTrue(self.journal.active())
