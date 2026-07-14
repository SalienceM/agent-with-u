import json
import tempfile
import unittest
from pathlib import Path

from src.backend.device_auth import DeviceAuthStore, cookie_value


class DeviceAuthStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = [1_000_000.0]
        self.path = Path(self.tmp.name) / "agent-with-u-web-auth.json"
        self.store = DeviceAuthStore(
            self.path,
            device_code="ABCD-EFGH",
            session_seconds=12 * 60 * 60,
            block_seconds=12 * 60 * 60,
            max_failures=3,
            now_fn=lambda: self.now[0],
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_three_wrong_codes_block_ip_and_persist_audit_times(self):
        for remaining in (2, 1, 0):
            ok, token, status = self.store.login("10.0.0.8", "WRONG")
            self.assertFalse(ok)
            self.assertIsNone(token)
            self.assertEqual(status["remainingAttempts"], remaining)
        self.assertTrue(status["blocked"])
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(len([e for e in data["events"] if e["event"] == "login_failed"]), 3)
        self.assertTrue(all("time" in e and e["ip"] == "10.0.0.8" for e in data["events"]))

    def test_successful_session_lasts_twelve_hours_and_token_is_hashed(self):
        ok, token, status = self.store.login("10.0.0.9", "abcd efgh")
        self.assertTrue(ok)
        self.assertTrue(token)
        self.assertTrue(self.store.validate("10.0.0.9", token))
        self.assertNotIn(token, self.path.read_text(encoding="utf-8"))
        self.now[0] += 12 * 60 * 60 + 1
        self.assertFalse(self.store.validate("10.0.0.9", token))

    def test_cookie_parser(self):
        self.assertEqual(cookie_value("a=1; awu_device_session=secret; b=2"), "secret")

    def test_forwarded_ip_is_only_trusted_from_loopback_proxy(self):
        self.store.trust_loopback_proxy = True
        self.assertEqual(self.store.client_ip("127.0.0.1", "203.0.113.7", ""), "203.0.113.7")
        self.assertEqual(self.store.client_ip("127.0.0.1", "", "198.51.100.8, 127.0.0.1"), "198.51.100.8")
        self.assertEqual(self.store.client_ip("10.0.0.5", "203.0.113.7", ""), "10.0.0.5")
        self.assertEqual(self.store.client_ip("127.0.0.1", "not-an-ip", ""), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
