import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import json

from src.backend.bridge_ws import BridgeWS
from src.backend.kit_update_journal import JournalError
from src.backend.update_manager import UpdateManager


class UpdateBarrierTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._update_manager = UpdateManager(Path(self.tmp.name))
        self.bridge._loop_states = {}

    async def test_authoritative_busy_check_never_kills_tasks(self):
        task = asyncio.create_task(asyncio.Event().wait())
        try:
            self.bridge._chat_turn_tasks = {"s": {task}}
            with self.assertRaisesRegex(JournalError, "对话"):
                self.bridge._begin_update_handoff("request", "own")
            self.assertFalse(task.cancelled())
            self.assertFalse(self.bridge._update_work_blocked())
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_new_work_cannot_cross_successful_barrier(self):
        self.bridge._begin_update_handoff("request", "own")
        with self.assertRaisesRegex(RuntimeError, "更新"):
            self.bridge._start_chat_turn('{"sessionId":"s"}')
        with self.assertRaises(RuntimeError):
            self.bridge._queue_workspace_kit_run("s", "k", {}, trigger="manual", owner="human")
        with self.assertRaises(RuntimeError):
            await self.bridge._dispatch("terminalCreate", [])
        self.assertFalse(self.bridge._schedule_loop_iteration("s"))

    async def test_managed_unknown_and_other_kit_are_blockers(self):
        self.bridge._engineering_activities = {"lease": object()}
        self.bridge._kit_states = {"s": SimpleNamespace(runs=[SimpleNamespace(id="other", status="running")])}
        with self.assertRaises(JournalError):
            self.bridge._begin_update_handoff("request", "own")
        self.assertIn("其他 Kit 有未结束的运行记录", self.bridge._update_busy_reasons("own"))

    async def test_own_orchestrator_not_blocker_but_other_inflight_rpc_is(self):
        self.bridge._kit_tasks = {"own": asyncio.current_task()}
        self.bridge._kit_states = {"s": SimpleNamespace(runs=[SimpleNamespace(id="own", status="running")])}
        self.assertEqual([], self.bridge._update_busy_reasons("own"))
        other = asyncio.create_task(asyncio.Event().wait())
        self.bridge._kit_update_rpc_tasks = {"other": other}
        try:
            with self.assertRaisesRegex(JournalError, "节点操作"):
                self.bridge._begin_update_handoff("request", "own")
        finally:
            other.cancel()
            await asyncio.gather(other, return_exceptions=True)

    async def test_restart_retains_durable_handoff_barrier(self):
        request = "a" * 32
        identity = dict(ownerId="o", deviceId="d", instanceId="i", sessionId="s", runId="r", stepId="u")
        journal = self.bridge._update_manager.journal
        journal.reserve(request, identity)
        record = journal.freeze(request, identity, {"release": {}})
        journal.confirm(request, identity, record["planFingerprint"], "confirmation-request")
        self.assertTrue(self.bridge._update_work_blocked())
        self.bridge._update_manager = UpdateManager(Path(self.tmp.name))
        self.assertTrue(self.bridge._update_work_blocked())

    async def test_unhydrated_loop_and_corrupt_activity_never_mean_idle(self):
        folder = Path(self.tmp.name) / "loops"
        folder.mkdir()
        self.bridge._loop_store = SimpleNamespace(_dir=folder)
        path = folder / "s.json"
        path.write_text(json.dumps({"sessionId": "s", "startup": {"status": "unknown"}}))
        with self.assertRaisesRegex(JournalError, "LOOP"):
            self.bridge._begin_update_handoff("request", "own")
        path.write_text("{broken")
        with self.assertRaisesRegex(JournalError, "损坏"):
            self.bridge._begin_update_handoff("request", "own")
        self.assertFalse(self.bridge._update_work_blocked())

    async def test_sequence_and_native_process_are_not_interrupted(self):
        self.bridge._seq_dispatch_reservations = {"s": 99999999999}
        proc = SimpleNamespace(returncode=None)
        self.bridge._kit_processes = {"own": proc}
        with self.assertRaisesRegex(JournalError, "序列.*进程"):
            self.bridge._begin_update_handoff("request", "own")
        self.assertIsNone(proc.returncode)
