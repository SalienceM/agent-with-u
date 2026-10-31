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
