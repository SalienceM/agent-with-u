"""无真实进程/模型的工程活动与权威 LOOP 交接竞争回归。"""
import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.loop_store import LoopState, LoopStore
from src.backend.loop_store import LoopRecord
from src.backend.chat_extras_store import ChatExtras, SeqTask
from src.backend.loop_control_snapshot import SnapshotResult
from tests.engine_workbench_fixtures import EngineFixture, FakePty


class EngineeringActivityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session(session_type='loop')
        self.sid = self.session.id
        self.state = LoopState(session_id=self.sid, stage='loopexecute', control_mode='manual')
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.sid: self.session}
        self.bridge._loop_states = {self.sid: self.state}
        self.bridge._loop_store = LoopStore()
        self.fixture.require_path(self.bridge._loop_store._dir)
        self.bridge._session_store = SimpleNamespace(load=lambda _: self.session)
        self.bridge._emit_loop_updated = Mock()
        self.bridge._mirror_loop_control_mode = Mock()
        self.bridge._loop_environment_executor = Mock(return_value='engine-fixture-executor')
        self.bridge._loop_run_agent = Mock(side_effect=AssertionError('No model calls'))
        snapshot_patch = patch('src.backend.loop_control_bridge.snapshot_handoff',
            new_callable=AsyncMock, return_value=SnapshotResult(git='fake-checkpoint'))
        self.snapshot = snapshot_patch.start()
        self.addCleanup(snapshot_patch.stop)

    async def asyncSetUp(self):
        self.owner = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.identity = self.bridge._workbench_identity(self.sid).to_dict()

    async def asyncTearDown(self):
        _REQUEST_OWNER_ID.reset(self.owner)

    def admit(self, kind='document-save', expected=None, revision=None):
        return self.bridge._engineering_admit(self.sid, self.identity if expected is None else expected,
            self.state.control_revision if revision is None else revision, kind)

    async def release(self):
        return json.loads(await self.bridge._rpc_loopControlRequest(self.sid, json.dumps({
            'requestId': 'release-fixture', 'action': 'release',
            'expectedControlRevision': self.state.control_revision})))

    async def finish_release(self):
        await self.bridge._loop_control_jobs[self.sid]['task']
        self.assertEqual(self.state.control_mode, 'loop')
        self.assertTrue(self.state.control_operation['committed'])
        self.bridge._loop_run_agent.assert_not_called()

    async def test_activity_wins_release_rejected_before_snapshot(self):
        lease = self.admit()
        self.bridge._engineering_recheck(lease)
        result = await self.release()
        self.assertEqual(result['reasonCode'], 'engineering_activity')
        self.assertFalse(result['eligibility']['release']['allowed'])
        self.snapshot.assert_not_called()
        self.assertFalse(self.bridge._loop_control_reserved(self.sid))
        self.bridge._engineering_confirm_finished(lease)
        self.assertEqual((await self.release())['status'], 'accepted')
        await self.finish_release()

    async def test_handoff_wins_all_new_writes_rejected_even_before_commit(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def snapshot(*args):
            entered.set()
            await finish.wait()
            return SnapshotResult(git='fake-checkpoint')
        self.snapshot.side_effect = snapshot
        self.assertEqual((await self.release())['status'], 'accepted')
        await asyncio.wait_for(entered.wait(), 2)
        for kind in ('document-save', 'terminal', 'language-write'):
            with self.assertRaisesRegex(WorkbenchError, 'handoff_busy'):
                self.admit(kind)
        finish.set()
        await self.finish_release()
        with self.assertRaisesRegex(WorkbenchError, 'stale_control_revision'):
            self.admit(revision=0)
        with self.assertRaisesRegex(WorkbenchError, 'manual_control_required'):
            self.admit()

    async def test_cancel_waiter_and_stop_request_do_not_release_terminal(self):
        lease = self.admit('terminal')
        pty = FakePty(self.fixture, self.session)
        waiter = asyncio.create_task(asyncio.Event().wait())
        await asyncio.sleep(0)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        pty.stop()
        self.assertFalse(pty.exit_confirmed)
        self.assertEqual((await self.release())['reasonCode'], 'engineering_activity')
        pty.confirm_exit()
        self.bridge._engineering_confirm_finished(lease)
        self.assertEqual(self.bridge._engineering_active(self.sid), ())

    async def test_only_original_lease_can_release_and_workers_cannot_mutate(self):
        lease = self.admit()
        with self.assertRaisesRegex(WorkbenchError, 'stale_activity'):
            self.bridge._engineering_confirm_finished(replace(lease))
        with self.assertRaises(RuntimeError):
            await asyncio.to_thread(self.bridge._engineering_confirm_finished, lease)
        self.assertEqual(len(self.bridge._engineering_active(self.sid)), 1)
        self.bridge._engineering_confirm_finished(lease)

    async def test_identity_revision_and_readonly_kinds_fail_closed(self):
        for expected in (None, {}, {**self.identity, 'ownerId': 'other'}):
            with self.assertRaises(WorkbenchError):
                self.bridge._engineering_admit(self.sid, expected, 0, 'terminal')
        for invalid in (True, -1, '0', 2**53):
            with self.assertRaises(WorkbenchError):
                self.admit(revision=invalid)
        for kind in ('preview', 'draft', 'read-only-lsp'):
            with self.assertRaisesRegex(WorkbenchError, 'invalid_activity'):
                self.admit(kind)
        self.assertEqual(self.bridge._engineering_active(self.sid), ())
        self.assertTrue(self.bridge._loop_control_eligibility(self.state)['release']['allowed'])

    async def test_recheck_fails_on_workspace_change_old_completion_keeps_new_lease(self):
        old = self.admit()
        self.session.working_dir = str(self.fixture.home)
        with self.assertRaisesRegex(WorkbenchError, 'stale_workspace'):
            self.bridge._engineering_recheck(old)
        current = self.admit(expected=self.bridge._workbench_identity(self.sid).to_dict())
        self.bridge._engineering_confirm_finished(old)
        self.assertEqual(self.bridge._engineering_active(self.sid), (current,))
        self.bridge._engineering_confirm_finished(current)

    async def test_missing_authoritative_state_and_persisted_reservation_are_not_idle(self):
        del self.bridge._loop_states[self.sid]
        with self.assertRaisesRegex(WorkbenchError, 'control_unavailable'):
            self.admit()
        self.state.control_operation = {'status': 'running', 'requestId': 'old'}
        self.bridge._loop_states[self.sid] = self.state
        with self.assertRaisesRegex(WorkbenchError, 'handoff_busy'):
            self.admit()

    async def test_normal_session_and_limits(self):
        self.session.session_type = 'normal'
        leases = [self.admit('language-write') for _ in range(128)]
        with self.assertRaisesRegex(WorkbenchError, 'activity_limit'):
            self.admit()
        for lease in leases:
            self.bridge._engineering_confirm_finished(lease)
        self.assertEqual(self.bridge._engineering_active(self.sid), ())

    async def test_feedback_locates_exact_resource_and_unknown_exit_keeps_it_visible(self):
        lease = self.admit('terminal')
        row = SimpleNamespace(lease=lease, resource_id='specific-terminal', generation='specific-generation', status='unknown')
        self.bridge._terminal_manager = SimpleNamespace(rows={'specific-terminal': row})
        summary = json.loads(await self.bridge._rpc_loopControlGet(self.sid))
        activity = summary['engineeringActivities'][0]
        self.assertEqual(activity, {'activityId': lease.activity_id, 'kind': 'terminal', 'workspace': self.identity,
            'status': 'unknown', 'resourceId': row.resource_id, 'generation': row.generation, 'relativePath': ''})
        self.assertFalse(summary['eligibility']['release']['allowed'])
        self.bridge._engineering_confirm_finished(lease)
        self.assertEqual(json.loads(await self.bridge._rpc_loopControlGet(self.sid))['engineeringActivities'], [])

    async def test_successful_engineering_work_does_not_change_empty_round_queue_auto_or_native_fault(self):
        import copy
        self.state.loops = [LoopRecord(seq=1, kind='manual', round=1, manual_start_index=0)]
        self.state.execution_environment = {'status': 'blocked', 'reasonCode': 'native_tool_failed', 'revision': 7}
        environment = copy.deepcopy(self.state.execution_environment)
        self.state.auto = False
        queued = SeqTask(id='historical', text='must never execute')
        self.bridge._chat_extras = {self.sid: ChatExtras(session_id=self.sid, seq_tasks=[queued])}
        self.bridge._dispatch_next_seqtask = Mock(side_effect=AssertionError('No queue dispatch'))
        self.bridge._sync_manual_loop_record = Mock()
        self.bridge._resolved_runtime = Mock(return_value={})
        self.bridge._session_runtime = Mock(return_value={})
        for kind in ('document-save', 'terminal', 'language-write'):
            lease = self.admit(kind)
            self.assertFalse(self.bridge._loop_control_eligibility(self.state)['release']['allowed'])
            self.bridge._engineering_confirm_finished(lease)
        self.assertEqual((await self.release())['status'], 'accepted')
        await self.finish_release()
        self.assertEqual(self.state.loops, [])
        self.assertFalse(self.state.auto)
        self.assertEqual(self.state.execution_environment, environment)
        self.assertEqual(self.bridge._chat_extras[self.sid].seq_tasks, [queued])
        self.bridge._dispatch_next_seqtask.assert_not_called()
