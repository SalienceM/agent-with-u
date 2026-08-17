import json
import tempfile
import unittest
from pathlib import Path

from src.relay_server import ExecutorConn, RelayServer
from src.relay_users import RelayUserError, RelayUserStore


class FakeWebSocket:
    def __init__(self, first=None, incoming=None):
        self.first = first
        self.incoming = list(incoming or [])
        self.sent = []
        self.closed = False
        self.remote_address = ("127.0.0.1", 12345)

    async def recv(self):
        return json.dumps(self.first) if isinstance(self.first, dict) else self.first

    async def send(self, payload):
        self.sent.append(payload)

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.incoming:
            raise StopAsyncIteration
        item = self.incoming.pop(0)
        return json.dumps(item) if isinstance(item, dict) else item

    def frames(self):
        return [json.loads(item) for item in self.sent if isinstance(item, str)]


class RelayUserStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "users.json"
        self.store = RelayUserStore(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_profile_changes_do_not_change_stable_user_id(self):
        created, token = self.store.create_user(
            "alice", display_name="Alice", device_ids=["alice-home"]
        )
        updated = self.store.update_profile(created["userId"], {
            "username": "alice-renamed",
            "displayName": "Alice Zhang",
            "avatarColor": "#123ABC",
        })

        self.assertEqual(created["userId"], updated["userId"])
        self.assertEqual("alice-renamed", updated["username"])
        self.assertEqual("#123abc", updated["avatarColor"])
        self.assertNotIn("tokenHash", updated)
        self.assertEqual(created["userId"], self.store.authenticate(token)["userId"])

        reloaded = RelayUserStore(self.path)
        self.assertEqual("Alice Zhang", reloaded.authenticate(token)["displayName"])

    def test_tokens_are_hashed_and_rotation_revokes_old_token(self):
        created, token = self.store.create_user("alice")
        on_disk = self.path.read_text(encoding="utf-8")
        self.assertNotIn(token, on_disk)
        self.assertIsNotNone(self.store.authenticate(token))

        rotated, next_token = self.store.reset_token(created["userId"])
        self.assertEqual(created["userId"], rotated["userId"])
        self.assertIsNone(self.store.authenticate(token))
        self.assertIsNotNone(self.store.authenticate(next_token))

    def test_one_executor_can_be_shared_by_multiple_users(self):
        self.store.create_user("alice", device_ids=["home"])
        self.store.create_user("bob")
        self.store.set_device("bob", "home", granted=True)

        users = self.store.users_for_device("home")
        self.assertEqual({"alice", "bob"}, {item["username"] for item in users})

    def test_first_grant_becomes_default_and_admin_can_reassign_it(self):
        alice, _ = self.store.create_user("alice", device_ids=["home"])
        bob, _ = self.store.create_user("bob", device_ids=["home"])

        self.assertTrue(self.store.user_is_default_for_device(
            self.store.get_user(alice["userId"]), "home",
        ))
        self.assertFalse(self.store.user_is_default_for_device(
            self.store.get_user(bob["userId"]), "home",
        ))
        changed = self.store.set_default_user("bob", "home")
        self.assertIn("home", changed["defaultDeviceIds"])

        reloaded = RelayUserStore(self.path)
        self.assertTrue(reloaded.user_is_default_for_device(
            reloaded.get_user(bob["userId"]), "home",
        ))
        reloaded.set_device("bob", "home", granted=False)
        self.assertIsNone(reloaded.default_user_for_device("home"))

    def test_username_is_unique_but_unicode_is_supported(self):
        self.store.create_user("小雨")
        with self.assertRaises(RelayUserError):
            self.store.create_user("小雨")

    def test_deleting_last_user_does_not_downgrade_to_legacy_mode(self):
        created, _ = self.store.create_user("alice")
        self.store.delete_user(created["userId"])
        self.assertTrue(self.store.enabled)
        self.assertEqual([], self.store.list_users())


class RelayIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "users.json"
        store = RelayUserStore(self.path)
        self.alice, self.alice_token = store.create_user(
            "alice", device_ids=["home", "alice-private"]
        )
        self.bob, self.bob_token = store.create_user(
            "bob", device_ids=["home", "bob-private"]
        )
        self.server = RelayServer("executor-master", self.path)
        self.home_executor_ws = FakeWebSocket()
        self.alice_executor_ws = FakeWebSocket()
        self.bob_executor_ws = FakeWebSocket()
        self.server._devices = {
            "home": ExecutorConn(self.home_executor_ws, "home", "Shared Home PC"),
            "alice-private": ExecutorConn(
                self.alice_executor_ws, "alice-private", "Alice PC"
            ),
            "bob-private": ExecutorConn(
                self.bob_executor_ws, "bob-private", "Bob PC"
            ),
        }

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_device_list_is_filtered_by_authenticated_user(self):
        alice_ws = FakeWebSocket({"t": "list", "token": self.alice_token})
        bob_ws = FakeWebSocket({"t": "list", "token": self.bob_token})

        await self.server.handle(alice_ws)
        await self.server.handle(bob_ws)

        alice_reply = alice_ws.frames()[0]
        bob_reply = bob_ws.frames()[0]
        self.assertEqual(
            {"home", "alice-private"},
            {item["id"] for item in alice_reply["devices"]},
        )
        self.assertEqual(
            {"home", "bob-private"},
            {item["id"] for item in bob_reply["devices"]},
        )
        self.assertEqual(self.alice["userId"], alice_reply["profile"]["userId"])
        self.assertEqual(self.bob["userId"], bob_reply["profile"]["userId"])

    async def test_claimed_user_is_ignored_and_relay_injects_stable_id(self):
        ui = FakeWebSocket({
            "t": "hello",
            "token": self.alice_token,
            "deviceId": "home",
            "user": self.bob["userId"],
        })
        await self.server.handle(ui)

        opened = next(frame for frame in self.home_executor_ws.frames() if frame["t"] == "open")
        self.assertEqual(self.alice["userId"], opened["user"])
        self.assertEqual("alice", opened["username"])
        self.assertTrue(opened["canClaimLegacy"])
        self.assertNotEqual(self.bob["userId"], opened["user"])

    async def test_non_default_user_does_not_receive_legacy_claim_capability(self):
        ui = FakeWebSocket({
            "t": "hello", "token": self.bob_token, "deviceId": "home",
        })
        await self.server.handle(ui)

        opened = [
            frame for frame in self.home_executor_ws.frames()
            if frame["t"] == "open" and frame["user"] == self.bob["userId"]
        ][-1]
        self.assertFalse(opened["canClaimLegacy"])

    async def test_user_cannot_open_another_users_executor(self):
        ui = FakeWebSocket({
            "t": "hello", "token": self.alice_token, "deviceId": "bob-private"
        })
        await self.server.handle(ui)
        self.assertEqual("error", ui.frames()[0]["t"])
        self.assertIn("not authorized", ui.frames()[0]["message"])
        self.assertEqual([], self.bob_executor_ws.frames())

    async def test_profile_update_cannot_change_user_id(self):
        ui = FakeWebSocket({
            "t": "profile.update",
            "token": self.alice_token,
            "profile": {
                "userId": self.bob["userId"],
                "username": "alice-new",
                "displayName": "New Alice",
                "avatarColor": "#abcdef",
            },
        })
        await self.server.handle(ui)

        reply = ui.frames()[0]
        self.assertEqual("profile.updated", reply["t"])
        self.assertEqual(self.alice["userId"], reply["profile"]["userId"])
        self.assertEqual("alice-new", reply["profile"]["username"])

    async def test_revoking_device_invalidates_existing_authorization(self):
        conn = self.server._devices["home"]
        current = self.server._users.get_user(self.alice["userId"])
        self.assertTrue(self.server._can_access(current, conn))
        self.server._users.set_device(self.alice["userId"], "home", granted=False)
        self.assertFalse(self.server._can_access(current, conn))
        bob = self.server._users.get_user(self.bob["userId"])
        self.assertTrue(self.server._can_access(bob, conn))

    async def test_executor_cannot_write_to_foreign_cid(self):
        legacy_path = Path(self.temp.name) / "legacy.json"
        legacy = RelayServer("master", legacy_path)
        victim = FakeWebSocket()
        legacy._sessions["foreign-cid"] = victim
        executor = FakeWebSocket(incoming=[{
            "t": "data", "cid": "foreign-cid", "msg": "must-not-leak"
        }])

        await legacy._serve_executor(executor, {
            "deviceId": "attacker", "name": "Attacker"
        })

        self.assertEqual([], victim.sent)


if __name__ == "__main__":
    unittest.main()
