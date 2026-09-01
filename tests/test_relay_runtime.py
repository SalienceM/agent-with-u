import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from src.backend.bridge_ws import (
    BridgeWS,
    _REQUEST_CAN_CLAIM_LEGACY,
    _REQUEST_IDENTITY_SOURCE,
)
from src.backend.relay import RelayRuntimeManager
from src.ws_main import resolve_device_identity


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
        self.assertTrue(status["agentExecutionEnabled"])
        self.assertTrue(status["connected"])
        self.assertTrue(status["hasToken"])
        self.assertNotIn("token", status)
        self.assertEqual("web-node-1", status["deviceId"])
        self.assertEqual("NAS Web executor", status["deviceName"])

        on_disk = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual("relay-master-secret", on_disk["token"])
        self.assertEqual("wss://relay.example.test/ws", on_disk["url"])
        self.assertEqual("web-node-1", on_disk["deviceId"])
        self.assertTrue(on_disk["agentExecutionEnabled"])

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

    async def test_agent_execution_policy_is_global_and_does_not_change_relay(self):
        await self.manager.configure({
            "enabled": True,
            "url": "wss://relay.example.test/ws",
            "token": "relay-master-secret",
            "deviceName": "Docker Web",
        })

        status = await self.manager.configure({"agentExecutionEnabled": False})

        self.assertTrue(status["enabled"])
        self.assertTrue(status["connected"])
        self.assertFalse(status["agentExecutionEnabled"])
        stored = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertFalse(stored["agentExecutionEnabled"])

        await self.manager.stop()
        restored = RelayRuntimeManager(
            object(),
            device_id="web-node-1",
            device_name="Docker Web",
            config_path=self.config_path,
            link_factory=_FakeRelayLink,
        )
        try:
            self.assertFalse(restored.status()["agentExecutionEnabled"])
        finally:
            await restored.stop()

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

    async def test_environment_registration_is_saved_for_the_next_container(self):
        config_path = Path(self.temporary.name) / "environment-relay.json"
        manager = RelayRuntimeManager(
            object(),
            device_id="docker-stable-id",
            device_name="Docker executor",
            initial_url="wss://relay.example.test/ws",
            initial_token="environment-secret",
            config_path=config_path,
            link_factory=_FakeRelayLink,
        )
        try:
            persisted = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual("environment-secret", persisted["token"])
            self.assertEqual("docker-stable-id", persisted["deviceId"])
            self.assertEqual("environment", manager.status()["source"])
        finally:
            await manager.stop()

        recreated = RelayRuntimeManager(
            object(),
            device_id="docker-stable-id",
            device_name="Docker executor",
            config_path=config_path,
            link_factory=_FakeRelayLink,
        )
        try:
            self.assertEqual("saved", recreated.status()["source"])
            self.assertTrue(recreated.status()["hasToken"])
            await recreated.start()
            await asyncio.sleep(0)
            self.assertTrue(recreated.status()["connected"])
        finally:
            await recreated.stop()

    async def test_same_environment_url_reuses_saved_token_but_new_url_does_not(self):
        await self.manager.configure({
            "enabled": True,
            "url": "wss://relay.example.test/ws",
            "token": "saved-secret",
            "deviceName": "NAS",
        })
        await self.manager.stop()

        same_relay = RelayRuntimeManager(
            object(),
            device_id="web-node-1",
            device_name="Docker Web",
            initial_url="wss://relay.example.test/ws",
            initial_token="",
            config_path=self.config_path,
            link_factory=_FakeRelayLink,
        )
        try:
            self.assertEqual("environment+saved", same_relay.status()["source"])
            self.assertTrue(same_relay.status()["hasToken"])
        finally:
            await same_relay.stop()

        different_relay = RelayRuntimeManager(
            object(),
            device_id="web-node-1",
            device_name="Docker Web",
            initial_url="wss://other-relay.example.test/ws",
            initial_token="",
            config_path=self.config_path,
            link_factory=_FakeRelayLink,
        )
        try:
            self.assertFalse(different_relay.status()["hasToken"])
            await different_relay.start()
            self.assertIn("Token", different_relay.status()["lastError"])
        finally:
            await different_relay.stop()


class DeviceIdentityPersistenceTests(unittest.TestCase):
    def test_explicit_docker_device_id_is_always_written_to_data_volume(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": temporary}, clear=False,
        ):
            device_id, device_name = resolve_device_identity(SimpleNamespace(
                device_id="nas-docker-node", device_name="NAS Docker",
            ))

            self.assertEqual("nas-docker-node", device_id)
            self.assertEqual("NAS Docker", device_name)
            self.assertEqual(
                "nas-docker-node",
                (Path(temporary) / "device-id").read_text(encoding="utf-8").strip(),
            )

    def test_missing_device_file_recovers_identity_from_relay_config(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            os.environ, {"AGENT_WITH_U_DATA_ROOT": temporary}, clear=False,
        ):
            root = Path(temporary)
            (root / "relay-node.json").write_text(json.dumps({
                "schemaVersion": 1,
                "enabled": True,
                "deviceId": "recovered-relay-node",
                "deviceName": "NAS",
            }), encoding="utf-8")

            device_id, _ = resolve_device_identity(SimpleNamespace(
                device_id=None, device_name=None,
            ))

            self.assertEqual("recovered-relay-node", device_id)
            self.assertEqual(
                "recovered-relay-node",
                (root / "device-id").read_text(encoding="utf-8").strip(),
            )

    def test_docker_updater_and_compose_retain_relay_inputs(self):
        repository = Path(__file__).resolve().parents[1]
        compose = (repository / "deploy" / "docker-compose.example.yml").read_text(encoding="utf-8")
        updater = (repository / "deploy" / "docker-updater.sh").read_text(encoding="utf-8")
        self.assertIn("hostname: awu-backend", compose)
        updater_environment = compose.split("  awu-updater:", 1)[1]
        for name in (
            "AGENT_WITH_U_RELAY_URL", "AGENT_WITH_U_RELAY_TOKEN",
            "AGENT_WITH_U_DEVICE_ID", "AGENT_WITH_U_DEVICE_NAME",
        ):
            self.assertIn(name, updater_environment)
            self.assertIn(name, updater)
        self.assertLess(
            updater.index("preserve_relay_environment\n"),
            updater.index("\n    docker compose"),
        )


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

    async def test_control_only_node_rejects_new_agent_sessions(self):
        self.bridge._relay_runtime_manager = type("Manager", (), {
            "status": lambda _self: {"agentExecutionEnabled": False},
        })()

        with self.assertRaisesRegex(RuntimeError, "控制端专用"):
            self.bridge._require_agent_execution_enabled()


if __name__ == "__main__":
    unittest.main()
