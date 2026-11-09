"""Kit 启动回归：只使用临时数据目录和假执行任务，不打包、发布或安装。"""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.kit_update_journal import JournalError, durable_json
from src.backend.workspace_kit_store import KitRun, KitStepRun, WorkspaceKit
from src.types import Session
from tests.test_session_user_isolation import _stop_store


class KitRunStartupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data")})
        self.env.start()
        self.bridge = BridgeWS()
        self.assertTrue(self.bridge._kit_store._dir.resolve().is_relative_to(self.root))
        self.session = Session(id="startup", title="fixture", created_at=1, updated_at=1,
                               messages=[], working_dir=str(self.root), backend_id="fake")
        self.bridge._active_sessions[self.session.id] = self.session
        self.state = self.bridge._kit_get(self.session.id)
        self.kit = WorkspaceKit.from_dict({"id": "build", "title": "fixture", "command": "echo fixture"})
        self.state.kits.append(self.kit)

    async def asyncTearDown(self):
        tasks = list(self.bridge._kit_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        _stop_store(self.bridge._session_store)
        self.env.stop()
        self.temp.cleanup()

    def pending(self, ident="orphan"):
        run = KitRun(id=ident, kit_id=self.kit.id, session_id=self.session.id,
                     steps=[KitStepRun(id="build"), KitStepRun(id="publish")])
        self.state.runs.append(run)
        self.kit.last_run_id = run.id
        return run

    def start(self, preview=""):
        return json.loads(self.bridge._rpc_kitRun(self.session.id, self.kit.id, "{}", "human", preview))

    def history(self):
        for i in range(10):
            self.state.runs.append(KitRun(id=f"old-{i}", kit_id=self.kit.id, session_id=self.session.id,
                                         status="succeeded", stdout="history\n" * 25000))

    async def test_button_run_accepts_history_over_install_journal_limit(self):
        self.history()
        gate = asyncio.Event()
        async def hold(*args, **kwargs):
            await gate.wait()
        runner = AsyncMock(side_effect=hold)
        with patch.object(self.bridge, "_kit_run_button_approval", return_value={"previewId": "approved"}), \
                patch.object(self.bridge, "_run_workspace_kit", runner):
            result = self.start("approved")
            self.assertEqual("ok", result["status"], result)
            await asyncio.sleep(0)
            runner.assert_awaited_once()
            restored = self.bridge._kit_store.load(self.session.id)
            self.assertEqual("approved", restored.runs[-1].button_approval["previewId"])
            self.assertEqual(self.state.runs[0].stdout, restored.runs[0].stdout)
            self.assertGreater(self.bridge._kit_store._path(self.session.id).stat().st_size, 1024 * 1024)

    async def test_failed_durable_save_is_terminal_and_never_launches(self):
        runner = AsyncMock()
        with patch.object(self.bridge, "_kit_run_button_approval", return_value={"previewId": "approved"}), \
                patch.object(self.bridge._kit_store, "save_durable", side_effect=OSError("fixture full disk")), \
                patch.object(self.bridge, "_run_workspace_kit", runner):
            result = self.start("approved")
        self.assertEqual("error", result["status"], result)
        self.assertIn("fixture full disk", result["message"])
        run = self.state.runs[-1]
        self.assertEqual("error", run.status)
        self.assertIsNone(run.started_at)
        self.assertTrue(all(step.status == "skipped" for step in run.steps))
        self.assertEqual("error", self.bridge._kit_store.load(self.session.id).runs[-1].status)
        runner.assert_not_awaited()
        self.assertNotIn(run.id, self.bridge._kit_tasks)

    async def test_reload_closes_only_never_started_orphan_without_replay(self):
        run = self.pending()
        self.bridge._kit_save(self.state, emit=False)
        self.bridge._kit_states.clear()
        with patch.object(self.bridge, "_run_workspace_kit", new_callable=AsyncMock) as runner:
            state = self.bridge._kit_get(self.session.id)
        recovered = state.runs[-1]
        self.assertEqual("error", recovered.status)
        self.assertIn("未启动", recovered.error)
        self.assertIsNone(recovered.started_at)
        self.assertIsNotNone(recovered.ended_at)
        self.assertTrue(all(step.status == "skipped" for step in recovered.steps))
        self.assertEqual("error", self.bridge._kit_store.load(self.session.id).runs[-1].status)
        runner.assert_not_awaited()
        self.assertNotIn(run.id, self.bridge._kit_tasks)

    def test_install_journal_still_rejects_oversized_record(self):
        with self.assertRaises(JournalError):
            durable_json(self.root / "install.json", {"history": "x" * (1024 * 1024)})
        self.assertFalse((self.root / "install.json").exists())

    async def test_live_worker_is_not_interrupted_or_duplicated(self):
        gate = asyncio.Event()
        async def hold(*args, **kwargs):
            await gate.wait()
        with patch.object(self.bridge, "_run_workspace_kit", side_effect=hold):
            result = self.start()
            run = self.bridge._kit_get(self.session.id).runs[-1]
            self.assertEqual("queued", run.status)
            self.assertEqual("ok", result["status"])
            duplicate = self.start()
            self.assertEqual("error", duplicate["status"])
            self.assertEqual(1, len(self.state.runs))

    async def test_worker_failure_before_start_records_reason_and_releases_run(self):
        with patch.object(self.bridge, "_run_workspace_kit", new_callable=AsyncMock,
                          side_effect=RuntimeError("fixture launch failure")):
            result = self.start()
            task = self.bridge._kit_tasks[result["run"]["id"]]
            with self.assertRaisesRegex(RuntimeError, "fixture launch failure"):
                await task
            await asyncio.sleep(0)
        run = self.state.runs[-1]
        self.assertEqual("error", run.status)
        self.assertIn("fixture launch failure", run.error)
        self.assertEqual("error", self.bridge._kit_store.load(self.session.id).runs[-1].status)
        self.assertNotIn(run.id, self.bridge._kit_tasks)

    async def test_task_cancelled_before_first_schedule_cannot_leave_queued(self):
        result = self.start()
        task = self.bridge._kit_tasks[result["run"]["id"]]
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        self.assertEqual("error", self.state.runs[-1].status)
        self.assertIsNone(self.state.runs[-1].started_at)

    async def test_scheduling_failure_closes_request_without_replaying(self):
        with patch("src.backend.bridge_ws.asyncio.create_task", side_effect=RuntimeError("fixture scheduler unavailable")):
            result = self.start()
        self.assertEqual("error", result["status"])
        self.assertIn("fixture scheduler unavailable", result["message"])
        self.assertEqual({}, self.bridge._kit_tasks)
        self.assertEqual("error", self.bridge._kit_store.load(self.session.id).runs[-1].status)

    async def test_recovery_keeps_activity_evidence_and_unknown_install_protected(self):
        for status in ("running", "waiting_client", "waiting_approval", "handing_off", "waiting_restart", "result_unknown"):
            run = self.pending(status)
            run.status = status
        started = self.pending("started")
        started.started_at = 1
        step_started = self.pending("step-started")
        step_started.steps[0].status = "running"
        receipt = self.pending("receipt")
        receipt.steps[0].config["capabilityRuntime"] = {"phase": "result_unknown"}
        process = self.pending("process")
        self.bridge._kit_processes[process.id] = Mock(returncode=None)
        terminal = self.pending("terminal")
        terminal.kit_id = "terminal-kit"
        self.bridge._kit_terminals["fixture"] = {"session_id": self.session.id, "kit_id": terminal.kit_id}
        before = [run.to_dict() for run in self.state.runs]
        self.bridge._kit_get(self.session.id)
        self.assertEqual(before, [run.to_dict() for run in self.state.runs])

    async def test_recovered_orphan_allows_a_new_run_without_replaying_old_one(self):
        orphan = self.pending()
        gate = asyncio.Event()
        async def hold(*args, **kwargs):
            await gate.wait()
        with patch.object(self.bridge, "_run_workspace_kit", new_callable=AsyncMock, side_effect=hold) as runner:
            result = self.start()
            self.assertEqual("ok", result["status"], result)
            self.assertNotEqual(orphan.id, result["run"]["id"])
            await asyncio.sleep(0)
            self.assertEqual(1, runner.await_count)
            self.assertEqual(result["run"]["id"], runner.call_args.args[2])
        self.assertEqual("error", orphan.status)

    def test_failed_durable_replace_preserves_history_and_removes_temporary_file(self):
        self.history()
        self.bridge._kit_store.save(self.state)
        target = self.bridge._kit_store._path(self.session.id)
        before = target.read_bytes()
        self.pending()
        with patch("src.backend.workspace_kit_store.os.replace", side_effect=OSError("fixture replace failed")):
            with self.assertRaises(OSError):
                self.bridge._kit_store.save_durable(self.state)
        self.assertEqual(before, target.read_bytes())
        self.assertEqual([], list(target.parent.glob("*.tmp")))
