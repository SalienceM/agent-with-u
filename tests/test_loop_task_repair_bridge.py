"""Repair RPCs with an isolated LoopStore and fake Backend only."""
import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import LoopStore, LoopState, LoopRecord, LoopStep, Addon
from src.backend.loop_task_blockers import normalize_blockers
from tests import test_loop_stage_details as stage_tests
from tests.test_loop_task_blockers import tasks, steps, plan, blocker


class RepairBridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bridge, self.session, self.state, self.record = stage_tests.LoopStageDetailsTests().setup_case()
        b, s, st, rec = self.bridge, self.session, self.state, self.record
        s.session_type = 'loop'
        s.owner_id = 'fixture-owner'
        b._require_session_access = Mock()
        b._active_sessions = {s.id: s}
        b._loop_states = {s.id: st}
        b._loop_running = set()
        b._loop_tasks = {}
        b._loop_pending_out = set()
        b._loop_control_jobs = {}
        b._loop_control_writes = {}
        b._loop_environment_executor = lambda: 'fixture-node'
        b._abort_loop_backend_calls = Mock()
        with patch('src.backend.loop_store.paths.sub', return_value=Path(self.temp.name)):
            b._loop_store = LoopStore()
        b._loop_save = BridgeWS._loop_save.__get__(b)
        identity = b._loop_task_identity(s, st, rec)
        st.blocked_task_scope = plan(identity)
        st.unresolved_blockers = normalize_blockers(blocker(), st.blocked_task_scope, identity, boundary='1:1:step1')
        st.unresolved_blockers['valid'] = False
        rec.task_plan = plan(identity)
        rec.orchestration = [LoopStep.from_dict(steps()[0])]
        rec.orchestration[0].status = 'done'
        rec.orchestration[0].output = json.dumps({'taskBlockers': blocker()})
        rec.terminal_kind = 'paused'
        rec.contract_required = True
        rec.contract_validation = {'status': 'exhausted', 'causeRef': 'contract:fixture', 'causeRevision': 1}
        rec.decision = {'action': 'wait', 'reasonCode': 'task_contract_invalid', 'decisionId': 'fixture'}
        rec.stage_details['prepare'] = {'attempts': [{'parsed': {'taskPlan': {}, 'orchestration': steps()}}]}
        st.progress_guard = {'pause': True, 'reasonCode': 'task_contract_invalid'}
        st.auto = False
        b._loop_save(st)
        self.calls = []
        async def agent(*args, **kwargs):
            self.calls.append(kwargs)
            return json.dumps({'taskPlan': {'version': 1, 'tasks': tasks()}, 'orchestration': steps()}), None
        b._loop_run_agent = agent

    def payload(self, rid='repair-1'):
        return dict(requestId=rid, causeRef='contract:fixture', causeRevision=1,
                    round=self.state.round, seq=self.record.seq, controlRevision=self.state.control_revision)

    async def submit(self, payload=None):
        return json.loads(await self.bridge._rpc_loopRepairTaskContract(self.session.id, json.dumps(payload or self.payload())))

    async def finish(self):
        job = self.bridge._loop_contract_jobs.get(self.session.id)
        if job:
            await asyncio.shield(job['task'])
        return self.state.contract_repairs[-1]

    async def test_success_preserves_blocker_history_and_does_not_run_or_enable_auto(self):
        previous_output = self.record.orchestration[0].output
        self.assertEqual((await self.submit())['status'], 'accepted')
        receipt = await self.finish()
        self.assertEqual(receipt['status'], 'succeeded', receipt.get('reason'))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]['execution_access'], 'read-only')
        self.assertFalse(self.state.auto)
        self.assertTrue(self.state.progress_guard['pause'])
        self.assertEqual(self.record.orchestration[0].output, previous_output)
        self.assertFalse(receipt['original']['blockers']['valid'])
        self.assertTrue(self.state.unresolved_blockers['valid'])
        self.assertEqual(self.state.unresolved_blockers['items'][0]['id'], 'baseline')
        self.assertEqual(self.record.contract_validation['status'], 'repaired')
        restored = self.bridge._loop_store.load(self.session.id)
        self.assertEqual(restored.contract_repairs[-1]['status'], 'succeeded')
        self.assertFalse(self.bridge._loop_control_reserved(self.session.id))

    async def test_duplicate_request_and_different_or_stale_request_cannot_double_call(self):
        accepted = await self.submit()
        replay = await self.submit()
        self.assertEqual(accepted['status'], 'accepted')
        self.assertEqual(replay['status'], 'ok')
        self.assertEqual((await self.submit(self.payload('another')))['status'], 'error')
        conflicting = self.payload()
        conflicting['causeRevision'] = 99
        self.assertEqual((await self.submit(conflicting))['status'], 'error')
        await self.finish()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual((await self.submit())['operation']['status'], 'succeeded')

    async def test_access_and_identity_are_authoritative(self):
        self.bridge._require_session_access.side_effect = PermissionError('denied')
        with self.assertRaises(PermissionError): await self.submit()
        self.bridge._require_session_access.side_effect = None
        payload = self.payload()
        payload['seq'] += 1
        self.assertEqual((await self.submit(payload))['status'], 'error')
        self.assertFalse(self.calls)
        await self.submit()
        await self.finish()
        self.session.owner_id = 'different-owner'
        self.assertEqual((await self.submit())['status'], 'error')

    async def test_two_corrections_exhaust_without_running_and_view_is_read_only(self):
        async def invalid(*args, **kwargs):
            self.calls.append(kwargs)
            return '{}', None
        self.bridge._loop_run_agent = invalid
        before = copy.deepcopy(self.state.to_dict())
        await self.bridge._rpc_loopTaskContractRepairGet(self.session.id)
        self.assertEqual(before, self.state.to_dict())
        await self.submit()
        receipt = await self.finish()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(receipt['status'], 'blocked')
        self.assertFalse(self.state.unresolved_blockers['valid'])

    async def test_goal_change_late_result_and_addon_save_do_not_clobber_state(self):
        gate = asyncio.Event()
        started = asyncio.Event()
        async def agent(*args, **kwargs):
            started.set()
            await gate.wait()
            return json.dumps({'taskPlan': {'version': 1, 'tasks': tasks()}, 'orchestration': steps()}), None
        self.bridge._loop_run_agent = agent
        await self.submit()
        await started.wait()
        self.state.addons.append(Addon(id='addon', text='concurrent addon'))
        self.state.goal = 'changed explicit goal'
        self.bridge._loop_save(self.state)
        gate.set()
        receipt = await self.finish()
        self.assertEqual(receipt['status'], 'stale')
        self.assertFalse(self.state.unresolved_blockers['valid'])
        restored = self.bridge._loop_store.load(self.session.id)
        self.assertEqual(restored.goal, 'changed explicit goal')
        self.assertEqual(restored.addons[0].text, 'concurrent addon')

    async def test_cancel_confirms_own_call_but_unconfirmed_exit_keeps_reservation(self):
        started = asyncio.Event()
        async def agent(*args, **kwargs):
            started.set()
            await asyncio.Event().wait()
        self.bridge._loop_run_agent = agent
        await self.submit()
        await started.wait()
        await self.bridge._rpc_loopCancelTaskContractRepair(self.session.id, 'repair-1')
        receipt = await self.finish()
        self.assertEqual(receipt['status'], 'cancelled')
        self.assertFalse(self.bridge._loop_control_reserved(self.session.id))
        started.clear()
        await self.submit(self.payload('repair-2'))
        await started.wait()
        self.bridge._loop_has_active_call = lambda *_: True
        await self.bridge._rpc_loopCancelTaskContractRepair(self.session.id, 'repair-2')
        receipt = await self.finish()
        self.assertEqual(receipt['status'], 'unknown')
        self.assertTrue(self.bridge._loop_control_reserved(self.session.id))

    async def test_restart_unknown_is_read_only_and_normal_run_cannot_repeat_failure(self):
        self.bridge._schedule_loop_iteration = Mock()
        result = json.loads(self.bridge._rpc_loopRunIteration(self.session.id))
        self.assertEqual(result['status'], 'error')
        self.bridge._schedule_loop_iteration.assert_not_called()
        self.state.contract_repairs = [{'version': 1, 'requestId': 'r', 'status': 'running'}]
        self.bridge._loop_save(self.state)
        await self.bridge._loop_flush(self.session.id)
        self.bridge._loop_states.clear()
        self.assertTrue(self.bridge._loop_control_reserved(self.session.id))
        result = json.loads(await self.bridge._rpc_loopTaskContractRepairGet(self.session.id, 'r'))
        self.assertEqual(result['operation']['status'], 'unknown')
        self.assertFalse(self.calls)

    async def test_save_failure_never_publishes_success_or_replaces_original(self):
        self.bridge._loop_store.save_frozen = Mock(side_effect=OSError('fake write failure'))
        await self.submit()
        receipt = await self.finish()
        self.assertEqual(receipt['status'], 'unknown')
        self.assertTrue(self.bridge._loop_control_reserved(self.session.id))
        self.assertFalse(self.state.unresolved_blockers['valid'])
        self.assertEqual(self.record.contract_validation['status'], 'exhausted')

    async def test_successful_commit_merges_addon_and_failure_before_commit_preserves_blockers(self):
        original = self.bridge._loop_run_agent
        async def agent(*args, **kwargs):
            self.state.addons.append(Addon(id='concurrent', text='kept during repair'))
            self.bridge._loop_save(self.state)
            return await original(*args, **kwargs)
        self.bridge._loop_run_agent = agent
        await self.submit()
        receipt = await self.finish()
        self.assertEqual(receipt['status'], 'succeeded')
        restored = self.bridge._loop_store.load(self.session.id)
        self.assertEqual(restored.addons[0].text, 'kept during repair')
        self.assertFalse(restored.auto)
        self.assertEqual(restored.control_revision, 0)

    async def test_final_commit_failure_never_installs_candidate(self):
        save = self.bridge._loop_store.save_frozen
        def fail_commit(data):
            if data['contractRepairs'][-1]['status'] == 'succeeded':
                raise OSError('synthetic commit failed')
            save(data)
        self.bridge._loop_store.save_frozen = fail_commit
        await self.submit()
        receipt = await self.finish()
        self.assertEqual(receipt['status'], 'failed')
        self.assertFalse(self.state.unresolved_blockers['valid'])
        self.assertEqual(self.record.contract_validation['status'], 'exhausted')
        self.assertEqual(self.bridge._loop_store.load(self.session.id).contract_repairs[-1]['status'], 'failed')

    async def test_repaired_run_still_uses_original_environment_and_control_gates(self):
        await self.submit()
        await self.finish()
        self.bridge._schedule_loop_iteration = Mock()
        self.assertEqual(json.loads(self.bridge._rpc_loopRunIteration(self.session.id))['status'], 'ok')
        self.bridge._schedule_loop_iteration.assert_called_once()
        self.bridge._schedule_loop_iteration.reset_mock()
        self.state.control_mode = 'manual'
        self.assertEqual(json.loads(self.bridge._rpc_loopRunIteration(self.session.id))['status'], 'error')
        self.state.control_mode = 'loop'
        self.bridge._loop_has_active_call = lambda *_: True
        self.assertEqual(json.loads(self.bridge._rpc_loopRunIteration(self.session.id))['status'], 'error')
        self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_repair_does_not_bypass_later_budget_source_or_access_boundary(self):
        await self.submit()
        await self.finish()
        self.session.agent_session_id = None
        self.session.auto_commit = False
        self.bridge._loop_pending_continues = {}
        self.bridge._maybe_autocontinue = Mock()
        self.bridge._apply_loop_out = Mock()
        self.state.policy.max_loops = 1
        original = self.record.orchestration[0].output
        await self.bridge._run_loop_iteration(self.session.id)
        self.assertEqual(len(self.state.loops), 1)
        self.assertEqual(len(self.calls), 1)  # 仅修复调用，未执行项目。
        self.assertEqual(self.record.orchestration[0].output, original)
        self.assertTrue(self.state.unresolved_blockers['items'])
        from src.backend.loop_store import LoopRecord
        future = LoopRecord(seq=2, round=1)
        self.state.loops.append(future)
        self.state.policy.max_loops = 8
        self.state.progress_guard = {}
        basis = self.bridge._loop_contract_context(self.session, self.state, future)
        self.session.constraints = 'new explicit access constraint'
        failure = self.bridge._loop_contract_boundary(self.session, self.state, future, basis)
        self.assertEqual(failure['reasonCode'], 'identity_mismatch')
        self.session.constraints = ''
        self.state.task_source = {'binding': {'change': 'different'}, 'status': 'conflict'}
        failure = self.bridge._loop_contract_boundary(self.session, self.state, future, basis)
        self.assertEqual(failure['reasonCode'], 'identity_mismatch')

    async def test_non_contract_hard_pause_is_not_misrouted_to_repair(self):
        self.record.contract_validation = {'valid': True, 'status': 'valid'}
        self.record.decision = {'action': 'wait', 'reasonCode': 'authorization'}
        self.state.progress_guard['reasonCode'] = 'authorization'
        self.assertFalse(self.bridge._loop_contract_pending(self.state))
        self.assertEqual((await self.submit())['status'], 'error')
        self.record.decision['reasonCode'] = 'task_contract_invalid'
        self.state.progress_guard['reasonCode'] = 'task_contract_invalid'
        for origin in ('source', 'identity'):
            self.record.contract_validation.update(status='paused', origin=origin)
            self.assertFalse(self.bridge._loop_contract_pending(self.state))
            self.assertFalse(self.bridge._loop_repair_eligibility(self.state)['canRequest'])

    async def test_new_issue_revision_and_risk_make_late_repair_stale(self):
        for change in ('issue', 'risk', 'control'):
            with self.subTest(change=change):
                self.setUp()
                agent = self.bridge._loop_run_agent
                async def delayed(*args, **kwargs):
                    if change == 'issue': self.record.contract_validation['causeRevision'] += 1
                    elif change == 'risk': self.state.risk_coefficient = 1.0
                    else: self.state.control_revision += 1
                    return await agent(*args, **kwargs)
                self.bridge._loop_run_agent = delayed
                await self.submit()
                self.assertEqual((await self.finish())['status'], 'stale')
                self.assertFalse(self.state.unresolved_blockers['valid'])

    async def test_lazy_audit_has_original_and_no_private_identity_or_query_mutation(self):
        await self.submit()
        await self.finish()
        before = copy.deepcopy(self.state.to_dict())
        self.bridge._loop_progress_for_record = lambda *_: {}
        self.bridge._runtime_label = lambda *_: 'fake'
        detail = json.loads(self.bridge._rpc_loopGetRecord(self.session.id, self.record.seq))['record']
        self.assertIn('original', detail['contractRepairAudits'][0])
        self.assertNotIn('"identity"', json.dumps(detail['contractRepairAudits']))
        self.assertTrue(detail['contractRepairRevision'])
        self.assertEqual(before, self.state.to_dict())

    async def test_causal_pause_is_stable_through_terminal_reduction_and_hard_pause_changes_it(self):
        from src.backend.loop_task_blockers import invalid
        result = invalid('缺少编号', origin='output', repairable=True)
        self.bridge._loop_contract_wait(self.state, self.record, result)
        cause = self.record.decision['causeRef']
        revision = self.record.decision['causeRevision']
        self.bridge._loop_contract_wait(self.state, self.record, result)
        self.assertEqual(self.record.decision['causeRef'], cause)
        self.assertEqual(self.state.progress_guard['causeRevision'], revision)
        self.bridge._loop_reduce(self.state, self.record)
        self.assertEqual(self.record.decision['causeRef'], cause)
        self.bridge._loop_wait(self.state, self.record, 'authorization', '缺少编号')
        self.assertNotEqual(self.record.decision['causeRef'], cause)
        self.assertEqual(self.record.decision['causeRef'], self.state.progress_guard['causeRef'])
        self.assertFalse(self.bridge._loop_repair_eligibility(self.state)['canRequest'])

    async def test_unrelated_raw_history_cannot_restore_unknown_scope(self):
        self.record.orchestration[0].output = ''
        other = LoopRecord(seq=0, round=0, task_plan={'valid': True, 'identity': {'owner': 'another'}},
                           orchestration=[LoopStep(index=1, desc='unrelated', output=json.dumps({'taskBlockers': blocker()}))])
        self.state.loops.insert(0, other)
        await self.submit()
        self.assertEqual((await self.finish())['status'], 'blocked')
        self.assertFalse(self.state.unresolved_blockers['valid'])
        self.assertFalse(self.calls)
