"""LOOP routing contract, fake Backend and temporary project only."""
from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.base import StreamDelta
from src.backend.bridge_ws import BridgeWS, _LoopAgentCallError, _LoopAgentStalledError
from src.backend.deepseek_harness import DeepSeekHarnessBackend
from src.backend.loop_store import LoopRecord, LoopState
from src.types import BackendType, ModelBackendConfig, Session


class HarnessLoopTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="awu-dsh-loop-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict("os.environ", {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data")})
        env.start()
        self.addCleanup(env.stop)
        self.calls = []
        calls = self.calls
        class FakeHarness(DeepSeekHarnessBackend):
            async def send_message(self, **kwargs):
                calls.append(kwargs)
                kwargs["on_delta"](StreamDelta(kwargs["session_id"], kwargs["message_id"], "text_delta", text="fixture"))
                return {"agentSessionId": kwargs.get("agent_session_id") or "awu-" + "1" * 32, "success": True}
        self.config = ModelBackendConfig(id="harness", type=BackendType.DEEPSEEK_HARNESS, label="test")
        self.backend = FakeHarness(self.config)
        self.session = Session(id="sid", title="test", created_at=1, updated_at=1, messages=[],
            backend_id="harness", owner_id="owner", working_dir=str(self.root),
            agent_session_id="main-history", harness_loop_agent_session_id="awu-" + "2" * 32)
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._backend_configs = [self.config]
        self.bridge._active_sessions = {"sid": self.session}
        self.bridge._loop_active_backends = {}
        self.bridge._loop_state = lambda _sid: None
        self.bridge._new_backend_instance = Mock(return_value=self.backend)
        self.bridge._build_session_reference_context = lambda prompt, _sid: prompt
        self.bridge._prepare_session_skills = AsyncMock()
        self.bridge._compose_constraints = lambda _session: "fixture constraints"
        self.bridge._emit_loop_progress = Mock()
        self.bridge._record_session_usage = Mock()
        self.bridge._loop_execution_identity = Mock(return_value=None)
        self.bridge._session_store = SimpleNamespace(save=Mock())

    async def test_planning_review_and_main_are_separate_sequential_context_is_explicit(self) -> None:
        for stage in ("prepare", "analysis"):
            await self.bridge._loop_run_agent_impl(self.session, "test", stage, 1, resume=False,
                indep_session_id="sid:" + stage, execution_access="read-only")
        _, native = await self.bridge._loop_run_agent_impl(self.session, "step1", "step1", 1,
            indep_session_id="sid:steps", resume=True)
        await self.bridge._loop_run_agent_impl(self.session, "step2", "step2", 1,
            indep_session_id="sid:steps", agent_session_id=native)
        self.assertEqual([call["agent_session_id"] for call in self.calls], [None, None, None, native])
        self.assertEqual([call["execution_access"] for call in self.calls], ["read-only", "read-only", "workspace-write", "workspace-write"])
        self.assertTrue(all(call["isolated_context"] and call["owner_id"] == "owner" for call in self.calls))
        self.assertTrue(all(call["activity_parent"] == "sid" for call in self.calls))
        self.assertTrue(all("fixture constraints" in call["constraints"] for call in self.calls))
        self.assertTrue(all("/api/chat-kits" not in call["content"] and "/api/chat-workspace" not in call["content"]
                            for call in self.calls))
        self.assertEqual(self.session.agent_session_id, "main-history")
        self.assertEqual(self.session.harness_loop_agent_session_id, "awu-" + "2" * 32)
        self.assertFalse(self.bridge._loop_has_active_call("sid"))

    async def test_default_loop_resume_uses_own_context_and_actual_backend_skill_target(self) -> None:
        await self.bridge._loop_run_agent_impl(self.session, "resume", "analysis", 1)
        self.assertEqual(self.calls[-1]["agent_session_id"], self.session.harness_loop_agent_session_id)
        self.config.id = "other-harness"
        await self.bridge._loop_run_agent_impl(self.session, "independent", "prepare", 1,
            backend_id="other-harness", indep_session_id="sid:other", resume=False)
        prepared = self.bridge._prepare_session_skills.call_args.args[0]
        self.assertEqual((prepared.id, prepared.backend_id, prepared.owner_id), ("sid:other", "other-harness", "owner"))
        self.assertEqual(self.session.backend_id, "harness")
        self.assertEqual(self.session.agent_session_id, "main-history")

    async def test_missing_explicit_harness_never_falls_back(self) -> None:
        self.bridge._backend_configs.append(ModelBackendConfig(id="missing", type=BackendType.DEEPSEEK_HARNESS, label="test"))
        self.bridge._new_backend_instance = Mock(side_effect=ValueError("unavailable"))
        with self.assertRaises(_LoopAgentCallError):
            await self.bridge._loop_run_agent_impl(self.session, "test", "prepare", 1, backend_id="missing")
        self.bridge._new_backend_instance.assert_called_once_with("missing")

    async def test_environment_is_unsupported_and_does_not_clear_real_fault_or_probe_codex(self) -> None:
        from dataclasses import replace
        from tests.test_loop_environment_integration import fixture
        from src.backend.loop_execution_environment import EnvironmentPause, new_check
        bridge, session, state, record, _, identity = fixture()
        identity = replace(identity, transport="deepseek-harness")
        self.assertFalse(self.backend.execution_environment_capabilities(identity)["supported"])
        gate, _ = bridge._loop_environment_hooks(session, self.backend, identity, 1, explicit=True)
        with patch("src.backend.codex_environment.probe_environment", new_callable=AsyncMock) as probe:
            await gate()
            self.assertEqual(record.environment_checks[-1]["status"], "unsupported")
            self.assertNotEqual(record.environment_checks[-1]["coverage"], "native_policy")
            block = new_check(identity, status="blocked", reason="env_access_denied", coverage="actual_tool",
                scope=bridge._loop_environment_scope(identity), probePath="actual-tool", quiesced=True)
            bridge._loop_environment_record(state, record, block)
            with self.assertRaises(EnvironmentPause):
                await gate()
            self.assertTrue(state.execution_environment["blockers"])
            probe.assert_not_called()
        self.assertFalse(self.calls)

    async def test_explicit_environment_check_cannot_fallback_from_unavailable_harness(self) -> None:
        from tests.test_loop_environment_integration import fixture
        from src.backend.loop_environment_workflow import WorkflowSelectionError
        bridge, session, state, *_ = fixture()
        bridge._backend_configs = [self.config]
        state.policy.backends["prepare"] = "harness"
        bridge._new_backend_instance = Mock(side_effect=RuntimeError("missing harness"))
        with self.assertRaises(WorkflowSelectionError):
            await bridge._loop_environment_recheck(session, state)
        bridge._new_backend_instance.assert_called_once_with("harness")

    async def test_cancelled_waiter_with_unknown_native_exit_cannot_retry_or_release(self) -> None:
        self.backend.send_message = AsyncMock(side_effect=lambda **_kwargs: None)
        async def stuck(**_kwargs):
            await asyncio.Event().wait()
        self.backend.send_message = stuck
        self.backend.abort = Mock()
        self.backend.clear_cancelled = Mock()
        self.backend.has_unconfirmed_activity = lambda _sid: True
        with self.assertRaises(_LoopAgentStalledError) as caught:
            await self.bridge._loop_run_agent_impl(self.session, "test", "step1", 1,
                indep_session_id="sid:stuck", inactivity_timeout=.01)
        self.assertFalse(caught.exception.retryable)
        self.assertTrue(self.bridge._loop_has_active_call("sid"))
        self.assertIs(self.bridge._loop_active_backends["sid:stuck"], self.backend)
        self.backend.abort.assert_called_once_with("sid:stuck")
        self.backend.clear_cancelled.assert_not_called()

    def test_discard_round_trips_separate_loop_checkpoint(self) -> None:
        record = LoopRecord(seq=1, agent_checkpoint="main-history", harness_loop_checkpoint="awu-" + "3" * 32)
        restored = LoopRecord.from_dict(record.to_dict())
        self.assertEqual(restored.harness_loop_checkpoint, record.harness_loop_checkpoint)
        self.session.harness_loop_agent_session_id = "awu-" + "4" * 32
        self.bridge._discard_record(LoopState(session_id="sid", loops=[restored]), restored, self.session)
        self.assertEqual(self.session.harness_loop_agent_session_id, record.harness_loop_checkpoint)
        self.assertEqual(self.session.agent_session_id, "main-history")
