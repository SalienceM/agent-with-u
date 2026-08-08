import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import (
    LoopRecord,
    LoopState,
    LoopStep,
    STAGE_EXECUTE,
    STAGE_OUT,
    SUB_PREPARE,
)
from src.types import ChatMessage


class LoopLifecycleTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _bridge(state: LoopState) -> tuple[BridgeWS, SimpleNamespace]:
        bridge = BridgeWS.__new__(BridgeWS)
        session = SimpleNamespace(
            id=state.session_id,
            agent_session_id=None,
            auto_commit=False,
        )
        bridge._active_sessions = {state.session_id: session}
        bridge._session_store = SimpleNamespace(
            load=lambda _sid: session,
            save=lambda *_args, **_kwargs: None,
        )
        bridge._loop_states = {state.session_id: state}
        bridge._loop_state = lambda sid: bridge._loop_states.get(sid)
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._loop_history_brief = lambda *_args, **_kwargs: ""
        bridge._loop_running = set()
        bridge._loop_tasks = {}
        bridge._loop_cancel = {}
        bridge._loop_pending_out = set()
        bridge._loop_pending_continues = {}
        bridge._loop_active_backends = {}
        bridge._abort_loop_backend_calls = Mock()
        return bridge, session

    async def _start_blocked_iteration(
        self,
        bridge: BridgeWS,
        session_id: str,
    ) -> asyncio.Task:
        started = asyncio.Event()
        blocker = asyncio.Event()

        async def blocked_prepare(*_args, **_kwargs) -> None:
            started.set()
            await blocker.wait()

        bridge._loop_do_prepare = blocked_prepare
        bridge._loop_do_execute = Mock()
        bridge._loop_do_analysis = Mock()
        self.assertTrue(bridge._schedule_loop_iteration(session_id))
        await asyncio.wait_for(started.wait(), timeout=1)
        task = bridge._active_loop_task(session_id)
        self.assertIsNotNone(task)
        return task

    async def test_continue_cancels_stuck_previous_loop_and_opens_new_round(self) -> None:
        sid = "loop-stuck-continue"
        record = LoopRecord(
            seq=1,
            round=1,
            sub_stage=SUB_PREPARE,
            orchestration=[LoopStep(index=1, status="running", desc="blocked")],
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            round=1,
            loops=[record],
        )
        bridge, _session = self._bridge(state)
        task = await self._start_blocked_iteration(bridge, sid)

        # 模拟旧实现已经把 UI 推到 loopout，但旧顶层任务仍未退出。
        state.stage = STAGE_OUT
        result = json.loads(bridge._rpc_loopContinue(sid, "second round"))

        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["stopping"])
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

        self.assertEqual(state.stage, STAGE_EXECUTE)
        self.assertEqual(state.round, 2)
        self.assertEqual(state.goal, "second round")
        self.assertIn("中止上一轮", record.error)
        self.assertEqual(record.orchestration[0].status, "error")
        self.assertFalse(bridge._loop_is_running(sid))

    async def test_advance_out_cancels_active_iteration_instead_of_orphaning_it(self) -> None:
        sid = "loop-stuck-out"
        record = LoopRecord(
            seq=1,
            round=1,
            sub_stage=SUB_PREPARE,
            orchestration=[LoopStep(index=1, status="running", desc="blocked")],
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            round=1,
            loops=[record],
        )
        bridge, _session = self._bridge(state)
        task = await self._start_blocked_iteration(bridge, sid)

        result = json.loads(bridge._rpc_loopAdvanceToOut(sid))

        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["stopping"])
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

        self.assertEqual(state.stage, STAGE_OUT)
        self.assertEqual(state.status, "aborted")
        self.assertIn("进入 loopout", record.error)
        self.assertFalse(bridge._loop_is_running(sid))

    async def test_restart_residue_is_sealed_before_new_round(self) -> None:
        sid = "loop-restart-residue"
        record = LoopRecord(
            seq=3,
            round=1,
            sub_stage=SUB_PREPARE,
            orchestration=[LoopStep(index=8, status="running", desc="stale")],
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_OUT,
            round=1,
            loops=[record],
        )
        bridge, _session = self._bridge(state)

        result = json.loads(bridge._rpc_loopContinue(sid, "recover"))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(state.round, 2)
        self.assertEqual(state.stage, STAGE_EXECUTE)
        self.assertTrue(record.error)
        self.assertEqual(record.orchestration[0].status, "error")

    async def test_empty_manual_takeover_releases_despite_stale_flags_and_queue(self) -> None:
        sid = "manual-empty-release"
        record = LoopRecord(
            seq=2,
            kind="manual",
            round=1,
            manual_start_index=1,
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            control_mode="manual",
            loops=[record],
        )
        # 旧消息的 streaming=True 是一次中断留下的磁盘残渣，不代表真实任务。
        session = SimpleNamespace(
            id=sid,
            messages=[SimpleNamespace(streaming=True)],
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_states = {sid: state}
        bridge._loop_state = lambda key: bridge._loop_states.get(key)
        bridge._active_sessions = {sid: session}
        bridge._session_store = SimpleNamespace(load=lambda _sid: session)
        bridge._chat_turn_tasks = {}
        bridge._chat_extras_get = lambda _sid: SimpleNamespace(pending=lambda: [object()])
        bridge._sync_manual_loop_record = Mock()
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()

        result = json.loads(bridge._rpc_loopRelease(sid))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(state.control_mode, "loop")
        self.assertEqual(state.loops, [])

    async def test_manual_release_obeys_authoritative_running_task(self) -> None:
        sid = "manual-real-running"
        record = LoopRecord(seq=1, kind="manual", round=1)
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            control_mode="manual",
            loops=[record],
        )
        session = SimpleNamespace(id=sid, messages=[])
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_state = lambda _sid: state
        bridge._active_sessions = {sid: session}
        bridge._session_store = SimpleNamespace(load=lambda _sid: session)
        release = asyncio.Event()
        task = asyncio.create_task(release.wait())
        bridge._chat_turn_tasks = {sid: {task}}

        result = json.loads(bridge._rpc_loopRelease(sid))

        self.assertEqual(result["status"], "error")
        self.assertIn("仍在生成", result["message"])
        self.assertEqual(state.control_mode, "manual")
        release.set()
        await task

    async def test_finalize_manual_record_repairs_stale_streaming_step(self) -> None:
        sid = "manual-finalize-stale"
        record = LoopRecord(
            seq=4,
            kind="manual",
            round=1,
            manual_start_index=0,
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            control_mode="manual",
            loops=[record],
        )
        session = SimpleNamespace(
            id=sid,
            backend_id="backend-1",
            working_dir=".",
            messages=[
                ChatMessage(id="u", role="user", content="do it", timestamp=1),
                ChatMessage(
                    id="a",
                    role="assistant",
                    content="partial but finished",
                    timestamp=2,
                    streaming=True,
                ),
            ],
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_state = lambda _sid: state
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._resolved_runtime = lambda *_args: {}
        bridge._session_runtime = lambda *_args: {}

        with patch("src.backend.bridge_ws.git_snapshot", return_value=None):
            bridge._sync_manual_loop_record(session, finalize=True)

        self.assertTrue(record.completed)
        self.assertEqual(record.orchestration[0].status, "done")
        self.assertGreater(record.orchestration[0].ended_at, 0)

    async def test_iteration_broadcasts_running_start_and_idle_finish(self) -> None:
        sid = "loop-running-events"
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            loops=[LoopRecord(seq=1, round=1, sub_stage=SUB_PREPARE)],
        )
        bridge, _session = self._bridge(state)
        observed: list[bool] = []
        bridge._emit_loop_updated = lambda current: observed.append(
            bridge._loop_is_running(current.session_id)
        )

        async def finish_stage(*_args, **_kwargs) -> None:
            return None

        bridge._loop_do_prepare = finish_stage
        bridge._loop_do_execute = finish_stage
        bridge._loop_do_analysis = finish_stage

        self.assertTrue(bridge._schedule_loop_iteration(sid))
        task = bridge._active_loop_task(sid)
        self.assertIsNotNone(task)
        await task
        # done callback 负责从 registry 移除任务并补发 running=false。
        await asyncio.sleep(0)

        self.assertTrue(observed[0])
        self.assertFalse(observed[-1])
        self.assertFalse(bridge._loop_is_running(sid))


if __name__ == "__main__":
    unittest.main()
