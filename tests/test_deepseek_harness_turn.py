"""fake runtime 经完整 Backend/SDK/worker 路径验证提交门与终态。"""
from __future__ import annotations

import asyncio
import json
import importlib.metadata
import os
import sys
import tempfile
import threading
from types import SimpleNamespace
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
        self.wait_timeouts = []
        self.methods = []

    async def send(self, scenario="normal", native=None, trace=None, working_dir=None, wait_scale=1,
                   backend=None, settle=True, close_hook=None):
        backend = backend or DeepSeekHarnessBackend(self.config)
        deltas = []
        def client(*, config, owner):
            fixture = Path(__file__).parent / "fixtures/deepseek_harness_runtime.py"
            owned_client = create_client(config=config, owner=owner, launch_args=(sys.executable, "-u", str(fixture.resolve()),
                "--state", str(self.root / "state.json"), "--scenario", scenario, "--identity-patch", config.patches[0]))
            request = owned_client.request
            def observed_request(method, params=None, **options):
                self.methods.append(method)
                if method == "session/wait":
                    self.wait_timeouts.append(options["timeout_seconds"])
                    options["timeout_seconds"] *= wait_scale
                return request(method, params, **options)
            owned_client.request = observed_request
            if close_hook:
                close = owned_client.close
                def delayed_close():
                    close_hook()
                    close()
                owned_client.close = delayed_close
            return owned_client
        with patch("src.backend.deepseek_harness_turn.create_client", client):
            kwargs = dict(messages=[], content="new input only", images=None, session_id="test-session", message_id="message",
                          on_delta=deltas.append, agent_session_id=native,
                          working_dir=working_dir if working_dir is not None else str(self.root), owner_id="test-user")
            if trace is None:
                result = await backend.send_message(**kwargs)
            else:
                from src.backend.call_trace import traced_send
                result = await traced_send(backend, kwargs, trace)
        if settle:
            for worker in list(getattr(backend, "_harness_workers", {}).values()):
                await asyncio.wait_for(asyncio.shield(worker.task), timeout=12)
            self.assertFalse(backend.has_unconfirmed_activity("test-session"))
        return result, deltas

    async def test_projection_failure_releases_cache_only_after_actual_exit(self) -> None:
        from src.backend.deepseek_harness_events import HarnessProjection
        backend = DeepSeekHarnessBackend(self.config)
        gate = threading.Event()
        original = HarnessProjection.observe
        def fail(projection, note):
            if note["payload"].get("event", {}).get("type") == "assistant/message":
                raise ValueError("Harness 实时帧 index 无效")
            return original(projection, note)
        try:
            with patch.object(HarnessProjection, "observe", fail):
                result, deltas = await self.send(backend=backend, settle=False, close_hook=lambda: gate.wait(5))
            self.assertFalse(result["success"])
            self.assertIn("流式事件处理", result["error"])
            self.assertNotIn("done", [d.type for d in deltas])
            worker = backend._harness_workers["test-session"]
            self.assertFalse(worker.confirmed)
            blocked, _ = await self.send(backend=backend, settle=False)
            self.assertFalse(blocked["success"])
            self.assertIs(backend._harness_workers["test-session"], worker)
            self.assertEqual(self.methods.count("session/prompt"), 1)
        finally:
            gate.set()
        await asyncio.wait_for(asyncio.gather(asyncio.shield(worker.task), return_exceptions=True), 10)
        await asyncio.sleep(0)
        self.assertTrue(worker.confirmed)
        self.assertNotIn("test-session", backend._harness_workers)
        self.assertFalse(worker.layout.activity_file.exists())
        # 兼容已退出但旧版本遗留的缓存；新提交仍恢复同一原生 Session。
        backend._harness_workers["test-session"] = worker
        resumed, _ = await self.send(backend=backend, native=result["agentSessionId"])
        self.assertTrue(resumed["success"])
        self.assertEqual(resumed["agentSessionId"], result["agentSessionId"])
        self.assertEqual(self.methods.count("session/prompt"), 2)

    async def test_finished_cleanup_preserves_unknown_exit_and_replacement(self) -> None:
        from src.backend.deepseek_harness_turn import _retire_finished_worker
        backend = DeepSeekHarnessBackend(self.config)
        task = asyncio.create_task(asyncio.sleep(0))
        await task
        old = SimpleNamespace(confirmed=False, task=task)
        backend._harness_workers = {"test-session": old}
        _retire_finished_worker(backend, "test-session", old)
        blocked, _ = await self.send(backend=backend, settle=False)
        self.assertFalse(blocked["success"])
        self.assertIs(backend._harness_workers["test-session"], old)
        self.assertNotIn("session/prompt", self.methods)
        newer = SimpleNamespace(confirmed=False, task=None)
        backend._harness_workers["test-session"] = newer
        old.confirmed = True
        _retire_finished_worker(backend, "test-session", old)
        self.assertIs(backend._harness_workers["test-session"], newer)

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

    async def test_compaction_of_historic_result_before_model_does_not_fail_turn(self) -> None:
        result, deltas = await self.send("compaction")
        self.assertTrue(result["success"], [d.to_dict() for d in deltas])
        self.assertEqual("".join(d.text or "" for d in deltas), "reply-1")
        self.assertNotIn("tool_result", [d.type for d in deltas])
        self.assertEqual([d.type for d in deltas].count("done"), 1)
        self.assertEqual(self.methods.count("session/prompt"), 1)

    async def test_native_goal_continuations_share_budget_and_complete_once(self) -> None:
        # 压缩 RPC 时钟：旧 120 秒变为 .12 秒，会在原生续跑途中错误终止。
        result, deltas = await self.send("continuation", wait_scale=.001)
        self.assertTrue(result["success"], [d.to_dict() for d in deltas])
        self.assertEqual("".join(d.text or "" for d in deltas), "reply-1continued-15continued-16")
        self.assertEqual([d.type for d in deltas].count("done"), 1)
        self.assertEqual(self.methods.count("session/prompt"), 1)
        self.assertEqual(self.methods.count("session/wait"), 1)
        self.assertTrue(120 < self.wait_timeouts[0] <= 1800)

    async def test_native_continuation_failure_is_never_erased_by_other_success(self) -> None:
        for scenario, status in (("continuation-error", 503), ("continuation-recovery", 429)):
            with self.subTest(scenario=scenario):
                result, deltas = await self.send(scenario)
                self.assertFalse(result["success"])
                self.assertIn(f"HTTP {status}", result["error"])
                self.assertIn("模型与工具执行", result["error"])
                self.assertNotIn("done", [d.type for d in deltas])

    async def test_continuations_require_matching_start_end_boundaries(self) -> None:
        for scenario in ("continuation-missing-end", "continuation-wrong-end",
                         "continuation-repeated-start", "duplicate-new-seq"):
            with self.subTest(scenario=scenario):
                result, deltas = await self.send(scenario)
                self.assertFalse(result["success"])
                self.assertNotIn("done", [d.type for d in deltas])
                diagnosis = next(d.diagnostic for d in deltas if d.type == "diagnostic"
                                 and d.diagnostic.get("phase") == "backend_error")
                self.assertEqual(diagnosis["errorCode"], "protocol_error")

    async def test_overall_deadline_still_bounds_wait_and_active_continuation(self) -> None:
        for scenario, stage in (("wait-stall", "wait"), ("continuation-stall", "execution")):
            with self.subTest(scenario=scenario), patch("src.backend.deepseek_harness_turn.TURN_TIMEOUT_SECONDS", .5):
                result, deltas = await asyncio.wait_for(self.send(scenario), timeout=8)
                self.assertFalse(result["success"])
                self.assertNotIn("done", [d.type for d in deltas])
                diagnosis = next(d.diagnostic for d in deltas if d.type == "diagnostic"
                                 and d.diagnostic.get("phase") == "backend_error")
                self.assertEqual(diagnosis["errorCode"], "timeout")
                self.assertEqual(diagnosis["failureStage"], stage)
                self.assertTrue(0 < self.wait_timeouts[-1] <= .5)

    async def test_trace_is_opt_in_and_auth_errors_do_not_echo_credentials(self) -> None:
        await self.send()
        self.assertFalse((self.root / "data/call-traces").exists())
        from src.backend.call_trace import CallTrace
        trace = CallTrace("test-session", "fixture-event")
        result, deltas = await self.send("http-401", trace=trace)
        self.assertFalse(result["success"])
        text = json.dumps([delta.to_dict() for delta in deltas]) + json.dumps(trace.data)
        self.assertNotIn(self.config.api_key, text)
        self.assertNotIn("PRIVATE_PROVIDER", text)
        self.assertIn('"scope": "harness-failure"', text)
        self.assertTrue(any(delta.type == "diagnostic" and delta.diagnostic.get("category") == "auth" for delta in deltas))
        self.assertTrue((self.root / "data/call-traces").is_dir())

    async def test_structured_provider_failure_survives_with_stage_and_no_image_blame(self) -> None:
        for status, code in ((401, "auth"), (403, "auth"), (404, "not_found"),
                             (429, "rate_limit"), (503, "server_error")):
            result, deltas = await self.send(f"http-{status}")
            self.assertFalse(result["success"])
            self.assertIn(f"HTTP {status}", result["error"])
            self.assertIn("模型与工具执行", result["error"])
            self.assertNotIn("图片", result["error"])
            self.assertNotIn("PRIVATE_PROVIDER", json.dumps([d.to_dict() for d in deltas]))
            diagnosis = next(d.diagnostic for d in deltas if d.type == "diagnostic"
                             and d.diagnostic.get("phase") == "backend_error")
            self.assertEqual(diagnosis["errorCode"], code)
            self.assertEqual(diagnosis["httpStatus"], status)
            self.assertEqual(diagnosis["failureStage"], "execution")
            self.assertNotIn("done", [d.type for d in deltas])

    async def test_stale_duplicate_and_child_terminal_do_not_poison_root_diagnosis(self) -> None:
        for scenario in ("stale-end", "duplicate-end", "child-end"):
            result, deltas = await self.send(scenario)
            self.assertTrue(result["success"], scenario)
            self.assertNotIn("error", [d.type for d in deltas])

    async def test_missing_workspace_is_diagnosed_before_spawn(self) -> None:
        result, deltas = await self.send(working_dir=str(self.root / "missing-PRIVATE_PATH"))
        self.assertFalse(result["success"])
        self.assertIn("workspace_missing", result["error"])
        self.assertIn("执行节点", result["error"])
        self.assertNotIn("PRIVATE_PATH", json.dumps([d.to_dict() for d in deltas]))
        self.assertFalse((self.root / "state.json").exists())

    async def test_rpc_text_does_not_masquerade_as_http_evidence(self) -> None:
        result, deltas = await self.send("auth")
        self.assertFalse(result["success"])
        self.assertIn("RPC -32000", result["error"])
        self.assertIn("运行时初始化", result["error"])
        self.assertNotIn("HTTP 401", result["error"])
        self.assertNotIn(self.config.api_key, json.dumps([d.to_dict() for d in deltas]))


if __name__ == "__main__":
    unittest.main()
