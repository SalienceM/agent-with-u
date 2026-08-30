import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from src.backend.bridge_ws import (
    BridgeWS,
    _REQUEST_CAN_CLAIM_LEGACY,
    _REQUEST_IDENTITY_SOURCE,
)
from src.backend.relay import RelayRuntimeManager


class _FakeRelayLink:
    instances = []

    def __init__(self, bridge, relay_url, device_id, device_name, token):
        self.bridge = bridge
        self.relay_url = relay_url
        self.device_id = device_id
        self.device_name = device_name
        self.token = token
        self.connected = False
        self.last_error = ""
        self.started = asyncio.Event()
        self.__class__.instances.append(self)

    async def run(self):
        self.connected = True
        self.started.set()
        try:
            await asyncio.Future()
        finally:
            self.connected = False

    async def wait_until_registered(self, timeout=8.0):
        try:
            await asyncio.wait_for(self.started.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False


class RelayRuntimeManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temporary.name) / "relay-node.json"
        _FakeRelayLink.instances.clear()
        self.manager = RelayRuntimeManager(
            object(),
            device_id="web-node-1",
            device_name="Docker Web",
            config_path=self.config_path,
            link_factory=_FakeRelayLink,
        )

    async def asyncTearDown(self):
        await self.manager.stop()
        self.temporary.cleanup()

    async def test_web_configuration_persists_and_never_echoes_master_token(self):
        status = await self.manager.configure({
            "enabled": True,
            "url": "wss://relay.example.test/ws",
            "token": "relay-master-secret",
            "deviceName": "NAS Web executor",
        })

        self.assertTrue(status["supported"])
        self.assertTrue(status["enabled"])
        self.assertTrue(status["connected"])
        self.assertTrue(status["hasToken"])
        self.assertNotIn("token", status)
        self.assertEqual("web-node-1", status["deviceId"])
        self.assertEqual("NAS Web executor", status["deviceName"])

        on_disk = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual("relay-master-secret", on_disk["token"])
        self.assertEqual("wss://relay.example.test/ws", on_disk["url"])

        await self.manager.stop()
        reloaded = RelayRuntimeManager(
            object(),
            device_id="web-node-1",
            device_name="Docker Web",
            config_path=self.config_path,
            link_factory=_FakeRelayLink,
        )
        try:
            restored = reloaded.status()
            self.assertEqual("saved", restored["source"])
            self.assertTrue(restored["enabled"])
            self.assertTrue(restored["hasToken"])
            self.assertNotIn("token", restored)
            await reloaded.start()
            await asyncio.sleep(0)
            self.assertTrue(reloaded.status()["connected"])
        finally:
            await reloaded.stop()

    async def test_saved_token_can_be_kept_when_only_name_or_url_changes(self):
        await self.manager.configure({
            "enabled": True,
            "url": "ws://relay.example.test:44360",
            "token": "keep-this-token",
            "deviceName": "Before",
        })
        status = await self.manager.configure({
            "enabled": True,
            "url": "wss://relay.example.test/ws",
            "deviceName": "After",
        })

        self.assertTrue(status["hasToken"])
        self.assertEqual("After", status["deviceName"])
        self.assertEqual(
            "keep-this-token",
            json.loads(self.config_path.read_text(encoding="utf-8"))["token"],
        )

    async def test_disabling_stops_registration_but_keeps_local_execution_config(self):
        await self.manager.configure({
            "enabled": True,
            "url": "ws://relay.example.test:44360",
            "token": "relay-master-secret",
            "deviceName": "Docker Web",
        })
        active_link = _FakeRelayLink.instances[-1]

        status = await self.manager.configure({
            "enabled": False,
            "url": "",
            "deviceName": "Docker Web",
        })

        self.assertFalse(status["enabled"])
        self.assertFalse(status["connected"])
        self.assertTrue(status["hasToken"])
        self.assertFalse(active_link.connected)

    async def test_invalid_or_incomplete_registration_is_rejected_before_save(self):
        with self.assertRaisesRegex(ValueError, "ws://"):
            await self.manager.configure({
                "enabled": True,
                "url": "https://relay.example.test",
                "token": "secret",
            })
        with self.assertRaisesRegex(ValueError, "Token"):
            await self.manager.configure({
                "enabled": True,
                "url": "wss://relay.example.test/ws",
                "token": "",
            })
        self.assertFalse(self.config_path.exists())


class RelayNodeRpcAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._ensure_kit_scheduler = lambda: None
        self.bridge._relay_runtime_manager = type("Manager", (), {
            "status": lambda _self: {
                "supported": True,
                "enabled": False,
                "connected": False,
                "hasToken": False,
            },
        })()

    async def _dispatch(self, source, can_claim=False):
        source_token = _REQUEST_IDENTITY_SOURCE.set(source)
        claim_token = _REQUEST_CAN_CLAIM_LEGACY.set(can_claim)
        try:
            return await self.bridge._dispatch("relayNodeStatus", [])
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(claim_token)
            _REQUEST_IDENTITY_SOURCE.reset(source_token)

    async def test_local_web_client_can_manage_current_node(self):
        payload = json.loads(await self._dispatch("loopback"))
        self.assertTrue(payload["supported"])

    async def test_relay_primary_user_can_manage_current_node(self):
        payload = json.loads(await self._dispatch("relay", can_claim=True))
        self.assertTrue(payload["supported"])

    async def test_shared_relay_user_cannot_change_global_node_settings(self):
        with self.assertRaises(PermissionError):
            await self._dispatch("relay", can_claim=False)


if __name__ == "__main__":
    unittest.main()
