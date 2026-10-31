import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

from src.backend.bridge_ws import BridgeWS, _REQUEST_CLIENT, _REQUEST_IDENTITY_SOURCE, _REQUEST_CAN_CLAIM_LEGACY
from src.backend.kit_capabilities import KitCapabilityRegistry, KitCapabilityContext, KitCapabilityError
from src.backend.kit_update_journal import JournalError
from src.backend.update_manager import UpdateManager


class IdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._update_manager = UpdateManager(Path(self.tmp.name))
        self.client = object()
        self.bridge._clients = {self.client}
        self.identity = dict(protocol=1, proof="test-ephemeral-proof", pid=123,
            exe=str(Path(self.tmp.name) / "desktop.exe"), deviceId="executor-A", instanceId="instance-A",
            installed=True, release=dict(version="99", packageVersion="99", buildId="full-build", sequence=999))
        env = patch.dict(os.environ, {"AGENT_WITH_U_KIT_DESKTOP_PROOF": self.identity["proof"],
            "AGENT_WITH_U_DESKTOP_PID": "123", "AGENT_WITH_U_DESKTOP_EXE": self.identity["exe"],
            "AGENT_WITH_U_DEVICE_ID": "executor-A", "AGENT_WITH_U_RUNTIME": "desktop"})
        env.start(); self.addCleanup(env.stop)
        token = _REQUEST_CLIENT.set(self.client); self.addCleanup(_REQUEST_CLIENT.reset, token)

    def test_authenticated_local_handshake_does_not_accept_remote_or_old_clients(self):
        self.bridge._rpc_kitDesktopReady(json.dumps(self.identity))
        self.assertNotIn("proof", self.bridge._kit_desktops[self.client])
        for change in ({"proof": "forged"}, {"pid": 9}, {"deviceId": "control-window"}, {"protocol": 0}):
            with self.subTest(change=change), self.assertRaises(PermissionError):
                self.bridge._rpc_kitDesktopReady(json.dumps({**self.identity, **change}))
        relay = Mock(identity_src="relay")
        self.bridge._clients.add(relay)
        token = _REQUEST_CLIENT.set(relay)
        try:
            with self.assertRaises(PermissionError):
                self.bridge._rpc_kitDesktopReady(json.dumps(self.identity))
        finally:
            _REQUEST_CLIENT.reset(token)

    def test_installed_executor_only_no_platform_offline_or_instance_fallback(self):
        with patch("src.backend.kit_update_bridge._platform", return_value="windows"), patch("sys.frozen", True, create=True):
            with self.assertRaises(JournalError): self.bridge._kit_desktop()
            self.bridge._rpc_kitDesktopReady(json.dumps(self.identity))
            self.assertEqual(self.client, self.bridge._kit_desktop()[0])
            self.bridge._kit_desktops[self.client]["installed"] = False
            with self.assertRaises(JournalError): self.bridge._kit_desktop()
            self.bridge._kit_desktops[self.client]["installed"] = True
            other = object(); self.bridge._clients.add(other)
            self.bridge._kit_desktops[other] = self.identity
            with self.assertRaisesRegex(JournalError, "歧义"): self.bridge._kit_desktop()
            self.bridge._clients.remove(other)
            self.bridge._clients.remove(self.client)
            with self.assertRaises(JournalError): self.bridge._kit_desktop()
        for platform, frozen in (("linux", True), ("windows", False)):
            with patch("src.backend.kit_update_bridge._platform", return_value=platform), patch("sys.frozen", frozen, create=True):
                with self.assertRaises(JournalError): self.bridge._kit_desktop()

    async def test_registry_requires_bound_service_and_never_starts_from_model_context(self):
        registry = KitCapabilityRegistry()
        context = KitCapabilityContext(Mock(), Path(self.tmp.name), "test")
        for arguments in ({"command": "install"}, {"planPath": "C:/fake"}, {"owner": "x"}, {"publishedRelease": {}}):
            with self.assertRaises(KitCapabilityError): registry.validate("node.update_local_published", arguments)
        with self.assertRaises(KitCapabilityError): await registry.prepare("node.update_local_published", {}, context)
        with self.assertRaises(KitCapabilityError): await registry.start("node.update_local_published", {}, context)
        source = _REQUEST_IDENTITY_SOURCE.set("relay")
        rights = _REQUEST_CAN_CLAIM_LEGACY.set(False)
        try:
            with self.assertRaises(PermissionError): self.bridge._require_node_update_capability()
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(rights); _REQUEST_IDENTITY_SOURCE.reset(source)
