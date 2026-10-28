"""fake runtime 经完整 Backend/SDK/worker 路径验证提交门与终态。"""
from __future__ import annotations

import asyncio
import json
import importlib.metadata
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.deepseek_harness import DeepSeekHarnessBackend
from src.backend.deepseek_harness_sdk import create_client
from src.types import BackendType, ModelBackendConfig

try:
    HAS_SDK = importlib.metadata.version("deepseek-harness-sdk") == "0.2.1rc3"
except importlib.metadata.PackageNotFoundError:
    HAS_SDK = False


@unittest.skipUnless(HAS_SDK, "Install matching SDK/runtime in isolated test environment")
class HarnessTurnTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-harness-turn-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bridge = self.root / "bridge.mjs"
        self.bridge.write_text("// test only", encoding="utf-8")
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data")})
        env.start()
        self.addCleanup(env.stop)
        bridge = patch("src.backend.deepseek_harness_turn.bridge_path", return_value=self.bridge)
        bridge.start()
        self.addCleanup(bridge.stop)
        self.config = ModelBackendConfig(id="fixture", type=BackendType.DEEPSEEK_HARNESS, label="fixture",
                                          model="fixture-model", api_key="fixture-secret-never-echo")

    async def send(self, scenario="normal", native=None, trace=None):
        backend = DeepSeekHarnessBackend(self.config)
        deltas = []
        def client(*, config, owner):
            fixture = Path(__file__).parent / "fixtures/deepseek_harness_runtime.py"
            return create_client(config=config, owner=owner, launch_args=(sys.executable, "-u", str(fixture.resolve()),
                "--state", str(self.root / "state.json"), "--scenario", scenario, "--identity-patch", config.patches[0]))
        with patch("src.backend.deepseek_harness_turn.create_client", client):
            kwargs = dict(messages=[], content="new input only", images=None, session_id="test-session", message_id="message",
                          on_delta=deltas.append, agent_session_id=native, working_dir=str(self.root), owner_id="test-user")
            if trace is None:
                result = await backend.send_message(**kwargs)
            else:
                from src.backend.call_trace import traced_send
                result = await traced_send(backend, kwargs, trace)
        for worker in list(getattr(backend, "_harness_workers", {}).values()):
            await asyncio.wait_for(asyncio.shield(worker.task), timeout=12)
        return result, deltas

    async def test_handshake_missing_or_mismatch_never_submits_prompt(self) -> None:
        for scenario in ("bad-cap", "no-cap"):
            result, deltas = await self.send(scenario)
            self.assertFalse(result["success"])
            self.assertFalse((self.root / "state.json").exists())
            self.assertNotIn("done", [delta.type for delta in deltas])

    async def test_unsupported_attachment_or_sandbox_never_spawns_or_retries(self) -> None:
        backend = DeepSeekHarnessBackend(self.config)
        for option in ({"images": [object()]}, {"sandbox_enabled": True}):
            deltas = []
            kwargs = dict(messages=[], content="must not submit", images=None, session_id="blocked", message_id="m",
                          on_delta=deltas.append, working_dir=str(self.root))
            kwargs.update(option)
            with patch("src.backend.deepseek_harness_turn.create_client") as create:
                result = await backend.send_message(**kwargs)
            self.assertFalse(result["success"])
            create.assert_not_called()
            self.assertFalse(getattr(backend, "_harness_workers", {}))
            self.assertNotIn("done", [delta.type for delta in deltas])

    async def test_receipt_then_terminal_and_native_restore_only_send_new_input(self) -> None:
        first, deltas = await self.send()
        self.assertTrue(first["success"], [delta.to_dict() for delta in deltas])
        self.assertEqual("".join(delta.text or "" for delta in deltas), "reply-1")
        second, deltas = await self.send(native=first["agentSessionId"])
        self.assertTrue(second["success"], [delta.to_dict() for delta in deltas])
        self.assertEqual(first["agentSessionId"], second["agentSessionId"])
        self.assertEqual("".join(delta.text or "" for delta in deltas), "reply-2")

    async def test_partial_failure_or_missing_terminal_never_emits_success(self) -> None:
        native = None
        for scenario in ("malformed-end", "missing-end", "crash", "error", "aborted", "blocked", "max-tokens"):
            result, deltas = await self.send(scenario, native)
            native = result["agentSessionId"]
            self.assertFalse(result["success"], scenario)
            self.assertIn("error", [delta.type for delta in deltas], scenario)
            self.assertNotIn("done", [delta.type for delta in deltas], scenario)
            self.assertTrue(any(delta.type == "text_delta" and "reply-" in delta.text for delta in deltas), scenario)

    async def test_root_idle_waits_for_managed_child_before_success(self) -> None:
        result, deltas = await self.send("child")
        self.assertTrue(result["success"], [delta.to_dict() for delta in deltas])
        kinds = [delta.type for delta in deltas]
        self.assertIn("subagent_done", kinds)
        self.assertLess(kinds.index("subagent_done"), kinds.index("done"))

    async def test_trace_is_opt_in_and_auth_errors_do_not_echo_credentials(self) -> None:
        await self.send()
        self.assertFalse((self.root / "data/call-traces").exists())
        from src.backend.call_trace import CallTrace
        trace = CallTrace("test-session", "fixture-event")
        result, deltas = await self.send("auth", trace=trace)
        self.assertFalse(result["success"])
        text = json.dumps([delta.to_dict() for delta in deltas]) + json.dumps(trace.data)
        self.assertNotIn(self.config.api_key, text)
        self.assertTrue(any(delta.type == "diagnostic" and delta.diagnostic.get("category") == "auth" for delta in deltas))
        self.assertTrue((self.root / "data/call-traces").is_dir())


if __name__ == "__main__":
    unittest.main()
