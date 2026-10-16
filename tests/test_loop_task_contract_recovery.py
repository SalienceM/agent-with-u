"""Synthetic contracts only: no provider, production Session or user data access."""
import copy
import json
import unittest
from unittest.mock import Mock

from src.backend.loop_task_blockers import freeze_plan, reduce_scope, validate_candidate
from tests.test_loop_task_blockers import IDENTITY, tasks, steps, plan
from src.backend.loop_store import LoopState, LoopRecord
from src.backend.loop_task_recovery import diagnostic, receipt_summary, repair_candidate
from tests.test_loop_task_blockers import blocker
from src.backend.loop_task_blockers import normalize_blockers
from tests import test_loop_stage_details as stage_tests


class ContractValidationTests(unittest.TestCase):
    def candidate(self, **changes):
        values = dict(raw=dict(version=1, tasks=tasks()), steps=steps(), source={}, identity=IDENTITY)
        values.update(changes)
        return validate_candidate(**values)

    def test_precise_failures_do_not_collapse_or_expose_identity_values(self):
        malformed = freeze_plan({}, steps(), {}, IDENTITY)
        output = reduce_scope(malformed, {}, IDENTITY)
        identity = reduce_scope(plan(), {}, {**IDENTITY, 'executor': 'private-secret-value'})
        history = reduce_scope(plan(), {'valid': False}, IDENTITY)
        self.assertEqual([r['reasonCode'] for r in (output, identity, history)],
                         ['plan_invalid', 'identity_mismatch', 'blockers_invalid'])
        self.assertTrue(output['repairable'])
        self.assertFalse(identity['repairable'])
        self.assertFalse(history['repairable'])
        self.assertEqual(identity['identityDimensions'], ['executor'])
        self.assertNotIn('private-secret-value', str(identity))
        for result in (output, identity, history):
            self.assertFalse(result['valid'])
            self.assertEqual(result['readyIds'], [])

    def test_full_source_ledger_is_not_the_execution_subset(self):
        source = dict(binding={'change': 'real'}, status='current', snapshot=dict(tasks=tasks()))
        self.assertTrue(self.candidate(source=source, steps=steps()[:1])['valid'])
        result = self.candidate(source=source, raw=dict(version=1, tasks=tasks()[:1]), steps=steps()[:1])
        self.assertEqual(result['reasonCode'], 'task_ids_mismatch')
        self.assertEqual(result['affectedIds'], ['D', 'U'])
        self.assertTrue(result['repairable'])
        source['status'] = 'conflict'
        result = self.candidate(source=source)
        self.assertEqual(result['origin'], 'source')
        self.assertFalse(result['repairable'])


class HistoricalRepairTests(unittest.TestCase):
    def repair(self, **overrides):
        p = plan()
        values = dict(raw=dict(version=1, tasks=tasks()), steps=steps(), source={}, identity=IDENTITY,
            basis_plan=p, retained=normalize_blockers(blocker(), p, IDENTITY, boundary='1:1:step1'),
            observations=[{'raw': blocker(), 'boundary': '1:1:step1'}], had_execution=True)
        values.update(overrides)
        before = copy.deepcopy(values)
        result = repair_candidate(**values)
        self.assertEqual(before, values)
        return result

    def test_recovers_invalid_envelope_without_losing_blockers_or_credit(self):
        retained = normalize_blockers(blocker(), plan(), IDENTITY, boundary='1:1:step1')
        retained['valid'] = False
        candidate = tasks()
        candidate[2].update(status='verified', evidence='model claim')
        result = self.repair(retained=retained, raw=dict(version=1, tasks=candidate))
        self.assertTrue(result['valid'])
        self.assertEqual(result['blockers']['items'][0]['id'], 'baseline')
        self.assertEqual(result['plan']['tasks'][2]['status'], 'pending')
        self.assertEqual(reduce_scope(result['plan'], result['blockers'], IDENTITY)['affectedIds'], ['D', 'T'])

    def test_missing_original_unknown_scope_and_changed_meaning_stay_blocked(self):
        for kwargs in ({'basis_plan': {}}, {'identity': {**IDENTITY, 'source': 'other'}},
                       {'retained': {'valid': False}, 'observations': []},
                       {'observations': [{'raw': {'version': 1, 'items': []}}]}):
            self.assertFalse(self.repair(**kwargs)['valid'])
        for field, value in [('title', 'new meaning'), ('dependsOn', ['U'])]:
            rows = tasks()
            rows[0][field] = value
            self.assertFalse(self.repair(raw=dict(version=1, tasks=rows))['valid'])

    def test_unexecuted_current_formal_plan_can_be_regenerated_without_acceptance_credit(self):
        source = dict(binding={'change': 'fixture'}, status='current', snapshot=dict(tasks=tasks()))
        result = self.repair(source=source, basis_plan={}, retained={}, observations=[], had_execution=False)
        self.assertTrue(result['valid'])
        self.assertEqual(result['blockers'], {})
        self.assertTrue(all(t['status'] == 'pending' for t in result['plan']['tasks']))

    def test_repair_cannot_drop_existing_isolation_preconditions(self):
        basis = plan()
        basis['preconditions'] = [{'id': 'original-isolation', 'baselineBasis': 'explicit acceptance'}]
        result = self.repair(basis_plan=basis)
        self.assertFalse(result['valid'])
        self.assertEqual(result['reasonCode'], 'repair_precondition_changed')


class PlanningCorrectionTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        bridge, session, state, record = stage_tests.LoopStageDetailsTests().setup_case()
        record.contract_required = True
        state.auto = True
        bridge._loop_pending_out = set()
        bridge._loop_environment_executor = lambda: 'fixture-node'
        return bridge, session, state, record

    def output(self, task_rows=None):
        return json.dumps(dict(taskPlan=dict(version=1, tasks=tasks() if task_rows is None else task_rows),
                               orchestration=steps()[:1]))

    async def test_invalid_mapping_corrects_before_any_execution(self):
        bridge, session, state, record = self.fixture()
        calls = []
        async def agent(*args, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                return json.dumps(dict(orchestration=steps()[:1], taskPlan={})), None
            self.assertEqual(record.stage_details['prepare']['status'], 'retrying')
            self.assertEqual(record.orchestration, [])
            return self.output(), None
        bridge._loop_run_agent = agent
        await bridge._loop_do_prepare(session, state, record, '')
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(c['execution_access'] == 'read-only' for c in calls))
        self.assertEqual(record.plan_attempt_count, 2)
        self.assertTrue(record.task_plan['valid'])
        self.assertEqual([a['valid'] for a in record.stage_details['prepare']['attempts']], [False, True])
        self.assertTrue(state.auto)
        self.assertFalse(record.completed)
        self.assertIsNone(record.analysis)

    async def test_three_attempts_shared_across_errors_execute_and_restart(self):
        bridge, session, state, record = self.fixture()
        outputs = ['not JSON', json.dumps(dict(orchestration=steps()[:1], taskPlan={})), self.output(tasks()[:1])]
        state.task_source = dict(binding={'change': 'fixture'}, status='current', snapshot=dict(tasks=tasks()))
        calls = []
        async def agent(*args, **kwargs):
            calls.append(args[2])
            return outputs[len(calls) - 1], None
        bridge._loop_run_agent = agent
        await bridge._loop_do_prepare(session, state, record, '')
        self.assertEqual(calls, ['prepare'] * 3)
        self.assertFalse(state.auto)
        self.assertTrue(state.progress_guard['pause'])
        self.assertEqual(record.orchestration, [])
        self.assertEqual(record.contract_validation['status'], 'exhausted')
        state = LoopState.from_dict(state.to_dict())
        record = state.loops[0]
        await bridge._loop_do_execute(session, state, record)
        self.assertEqual(len(calls), 3)

    async def test_stop_pause_and_takeover_win_over_late_correction(self):
        for change in ('stop', 'pause', 'takeover', 'new_round', 'identity', 'environment', 'risk'):
            bridge, session, state, record = self.fixture()
            calls = []
            async def agent(*args, **kwargs):
                calls.append(True)
                if len(calls) == 1:
                    return '{}', None
                if change == 'stop': bridge._loop_cancel[session.id] = False
                if change == 'pause': state.progress_guard = {'pause': True, 'reasonCode': 'authorization'}
                if change == 'takeover': state.control_mode = 'manual'; state.control_revision += 1
                if change == 'new_round': state.round += 1
                if change == 'identity': record.runtimes['execute'] = {'model': 'changed'}
                if change == 'environment': state.execution_environment = {'incomplete': True}
                if change == 'risk': state.risk_coefficient = 1
                return self.output(), None
            bridge._loop_run_agent = agent
            await bridge._loop_do_prepare(session, state, record, '')
            self.assertEqual(len(calls), 2, change)
            self.assertEqual(record.orchestration, [], change)
            self.assertTrue(record.stage_details['prepare']['attempts'][-1]['stale'], change)
            if change == 'pause': self.assertEqual(state.progress_guard['reasonCode'], 'authorization')
            if change in ('takeover', 'new_round'): self.assertEqual(state.progress_guard, {})

    async def test_unknown_attempt_and_backend_failure_are_not_retried(self):
        bridge, session, state, record = self.fixture()
        record.plan_attempt_count = 1
        bridge._loop_run_agent = Mock(side_effect=AssertionError('must not replay'))
        await bridge._loop_do_prepare(session, state, record, '')
        self.assertEqual(record.contract_validation['reasonCode'], 'call_unknown')
        bridge._loop_run_agent.assert_not_called()
        bridge, session, state, record = self.fixture()
        calls = []
        async def agent(*args, **kwargs):
            calls.append(True)
            if len(calls) == 1: return '{}', None
            raise RuntimeError('fake Backend failure')
        bridge._loop_run_agent = agent
        with self.assertRaisesRegex(RuntimeError, 'fake Backend'):
            await bridge._loop_do_prepare(session, state, record, '')
        self.assertEqual(len(calls), 2)
        self.assertEqual(record.plan_attempt_count, 2)

    async def test_source_current_does_not_require_rebinding_and_final_gate_stays(self):
        bridge, session, state, record = self.fixture()
        state.task_source = dict(binding={'change': 'fixture'}, status='current', snapshot=dict(tasks=tasks()))
        calls = []
        async def agent(*args, **kwargs):
            calls.append(True)
            return self.output(tasks()[:1] if len(calls) == 1 else None), None
        bridge._loop_run_agent = agent
        await bridge._loop_do_prepare(session, state, record, '')
        self.assertEqual(len(calls), 2)
        self.assertEqual(state.task_source['status'], 'current')
        record.orchestration[0].task_ids = ['U']
        self.assertFalse(bridge._loop_freeze_tasks(session, state, record,
                          record.stage_details['prepare']['attempts'][-1]['parsed']))

    async def test_explicit_pause_auto_off_and_pre_call_limits(self):
        bridge, session, state, record = self.fixture()
        state.auto = False
        async def valid(*args, **kwargs): return self.output(), None
        bridge._loop_run_agent = valid
        await bridge._loop_do_prepare(session, state, record, '')
        self.assertFalse(state.auto)
        self.assertTrue(record.task_plan['valid'])
        bridge, session, state, record = self.fixture()
        async def paused(*args, **kwargs):
            return json.dumps({'taskPlan': {}, 'loopControl': {'pause': True, 'reason': '授权不足'}}), None
        bridge._loop_run_agent = paused
        await bridge._loop_do_prepare(session, state, record, '')
        self.assertEqual(record.plan_attempt_count, 1)
        self.assertEqual(state.progress_guard['reasonCode'], 'unclassified_pause')
        for gate in ('risk', 'active', 'budget'):
            bridge, session, state, record = self.fixture()
            if gate == 'risk': state.risk_coefficient = 1
            if gate == 'active': bridge._loop_has_active_call = lambda *_: True
            if gate == 'budget':
                state.policy.max_loops = 1
                state.loops.insert(0, LoopRecord(seq=0, completed=True))
            bridge._loop_run_agent = Mock(side_effect=AssertionError('must not call'))
            await bridge._loop_do_prepare(session, state, record, '')
            bridge._loop_run_agent.assert_not_called()


class ContractPersistenceTests(unittest.TestCase):
    candidate = ContractValidationTests.candidate
    def test_round_trip_preserves_counts_causes_and_unknown_receipts(self):
        state = LoopState(session_id='synthetic', loops=[LoopRecord(seq=1,
            contract_required=True, plan_attempt_count=2, task_plan={'valid': False},
            contract_validation={'valid': False, 'causeRef': 'cause', 'causeRevision': 3})],
            contract_repairs=[{'version': 1, 'requestId': 'r', 'status': 'unknown',
                               'original': {'valid': False}, 'attemptCount': 1}])
        restored = LoopState.from_dict(state.to_dict())
        self.assertEqual(restored.loops[0].plan_attempt_count, 2)
        self.assertTrue(restored.loops[0].contract_required)
        self.assertFalse(restored.loops[0].task_plan['valid'])
        self.assertEqual(restored.loops[0].contract_validation['causeRef'], 'cause')
        self.assertEqual(restored.contract_repairs[0]['status'], 'unknown')
        self.assertEqual(restored.contract_repairs[0]['original'], {'valid': False})
        self.assertEqual(LoopRecord.from_dict({'seq': 1}).contract_validation, {})
        self.assertEqual(LoopState.from_dict({'sessionId': 's', 'contractRepairs': 'bad'}).
                         contract_repairs[0]['status'], 'unknown')

    def test_summary_allowlist_excludes_private_values_and_is_bounded(self):
        raw = {'valid': False, 'rawOutput': 'private-output', 'identity': {'env': 'private-config'},
               'fields': ['x'] * 100, 'affectedIds': ['t'] * 200,
               'evidenceRefs': ['r'] * 40, 'attemptCount': 100, 'causeRef': 'c', 'status': 'running'}
        summary = diagnostic(raw)
        self.assertTrue(diagnostic({**raw, 'scopeUnknown': False})['scopeUnknown'])
        self.assertEqual(len(summary['fields']), 16)
        self.assertEqual(len(summary['affectedIds']), 100)
        self.assertEqual(summary['attemptCount'], 3)
        for value in (summary, receipt_summary(raw)):
            self.assertNotIn('private-', str(value))
        self.assertFalse(diagnostic('invalid')['valid'])

    def test_compact_payload_never_broadcasts_repair_audit(self):
        from tests.test_loop_environment_integration import fixture
        bridge, session, state, *_ = fixture()
        bridge._loop_control_eligibility = lambda *_: {'takeover': {'allowed': True}}
        bridge._engineering_feedback = lambda *_: {}
        state.contract_repairs = [{'version': 1, 'requestId': 'repair', 'status': 'unknown',
                                   'original': 'private-repair-audit', 'identity': {'env': 'private-env'}}]
        before = copy.deepcopy(state.to_dict())
        result = bridge._loop_payload(state, compact=True)
        self.assertEqual(result['contractRepair']['status'], 'unknown')
        self.assertNotIn('private-', str(result))
        self.assertNotIn('contractRepairs', result)
        self.assertEqual(before, state.to_dict())

    def test_valid_steps_cannot_hide_invalid_new_contract(self):
        for raw in (None, {}, dict(version=True, tasks=tasks()), dict(version=1, tasks=[]),
                    dict(version=1, tasks=tasks() * 100)):
            with self.subTest(raw=str(raw)[:50]):
                self.assertFalse(self.candidate(raw=raw)['valid'])
        duplicate = tasks() + [tasks()[0]]
        cyclic = tasks()
        cyclic[0]['dependsOn'] = ['D']
        for rows in (duplicate, cyclic):
            self.assertFalse(self.candidate(raw=dict(version=1, tasks=rows))['valid'])
        rows = steps()
        rows[0]['preconditionIds'] = ['missing']
        result = self.candidate(steps=rows)
        self.assertEqual(result['fields'], ['orchestration[0]'])
        self.assertFalse(result['valid'])

    def test_legacy_is_explicit_and_never_bypasses_old_blockers(self):
        simple = [dict(index=1, desc='legacy')]
        self.assertTrue(self.candidate(raw=None, steps=simple, required=False)['legacy'])
        self.assertFalse(self.candidate(raw=None, steps=simple)['valid'])
        self.assertFalse(self.candidate(raw=None, steps=simple, required=False,
                                        blockers={'valid': False})['valid'])
        self.assertFalse(self.candidate(raw={}, steps=simple, required=False)['valid'])

    def test_validation_does_not_mutate_evidence_or_accept_bad_steps(self):
        original = plan()
        before = copy.deepcopy(original)
        self.assertTrue(self.candidate(previous=original)['valid'])
        self.assertEqual(original, before)
        for rows in ([], steps() * 2, [dict(index=1)], [dict(desc='   ')]):
            self.assertEqual(self.candidate(steps=rows)['reasonCode'], 'steps_invalid')
        result = self.candidate(previous={'valid': False})
        self.assertEqual(result['reasonCode'], 'historical_scope_invalid')
        self.assertFalse(result['repairable'])
