import asyncio
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.loop_task_blockers import (freeze_plan, normalize_blockers, merge_blockers,
    reduce_scope, review_scope, protect_report, BLOCKER_INSTRUCTIONS, PLAN_INSTRUCTIONS, REVIEW_INSTRUCTIONS)
from src.backend.loop_task_isolation import isolation_receipts, isolation_gate, resolve_observations
from src.backend.loop_task_blockers import ContractError
from src.backend.loop_store import LoopState, LoopRecord, LoopStep, LoopAnalysis
from src.backend.loop_delivery import normalize_report, assess_progress, planning_context
from tests import test_loop_delivery as delivery_tests


IDENTITY = dict(owner='owner', executor='node', session='s', source='revision1', workspace='fixture', environment='e')


def tasks():
    return [dict(id=k, title=k, status='pending', dependsOn=deps, evidence='') for k, deps in [('T', []), ('D', ['T']), ('U', [])]]


def steps():
    return [dict(index=i, taskIds=[key], dependsOn=deps, preconditionIds=[], access='write', desc=key)
            for i, key, deps in [(1, 'T', []), (2, 'D', ['T']), (3, 'U', [])]]


def plan(identity=None):
    return freeze_plan(dict(version=1, tasks=tasks(), preconditions=[]), steps(), {}, identity or IDENTITY)


def blocker():
    return dict(version=1, items=[dict(id='baseline', affectedTaskIds=['T'], reasonCode='check_unavailable',
        reason='Access denied; Godot 未启动; cases=[]; screenshots=0', evidenceRefs=['step1:exit23'],
        resolution='明确基线要求仍保留；需要合法读取条件或新的适用隔离证据')])


def report():
    return normalize_report(dict(mode='delivery', source='tasks.md', scopeComplete=True, items=tasks(),
        blockers=[], verification=dict(status='blocked', evidence='tests not run')))


def review():
    return dict(version=1, confirmedBlockerIds=['baseline'], independentTaskIds=['U'], evidenceRefs=['tasks.md:T<-D;U independent'])


class TaskBlockerProtocolTests(unittest.TestCase):
    def test_valid_contract_and_transitive_dependency_closure(self):
        p = plan()
        b = normalize_blockers(blocker(), p, IDENTITY, boundary='1:1:step1')
        self.assertTrue(b['valid'])
        self.assertEqual(reduce_scope(p, b, IDENTITY)['readyIds'], ['U'])
        self.assertEqual(reduce_scope(p, b, IDENTITY)['affectedIds'], ['D', 'T'])
        self.assertTrue(review_scope(review(), report(), p, b, IDENTITY)['valid'])

    def test_invalid_protocol_cannot_authorize(self):
        variants = [None, {}, dict(version=True, items=[]), dict(version=2, items=blocker()['items']),
                    dict(version=1, items=[]), dict(version=1, items=blocker()['items'] * 51),
                    {**blocker(), 'owner': 'forged'}]
        for field, value in [('affectedTaskIds', []), ('affectedTaskIds', ['unknown']),
                             ('affectedTaskIds', ['T'] * 101), ('reason', 'a' * 1201),
                             ('resolution', ''), ('evidenceRefs', ['x' * 241]), ('identity', {'owner': 'forged'})]:
            candidate = blocker()
            candidate['items'][0][field] = value
            variants.append(candidate)
        for raw in variants:
            with self.subTest(raw=str(raw)[:100]):
                b = normalize_blockers(raw, plan(), IDENTITY, boundary='b')
                self.assertFalse(b['valid'])
                self.assertEqual(reduce_scope(plan(), b, IDENTITY)['readyIds'], [])

    def test_plan_rejects_missing_cyclic_unknown_and_spoofed_fields(self):
        for task_rows in [tasks() + [tasks()[0]], tasks()[1:],
                          [dict(id='T', dependsOn=['D']), dict(id='D', dependsOn=['T'])]]:
            self.assertFalse(freeze_plan(dict(version=1, tasks=task_rows), steps(), {}, IDENTITY)['valid'])
        for field, value in [('taskIds', []), ('dependsOn', ['missing']), ('preconditionIds', ['unknown']), ('testWritesUserData', True)]:
            rows = steps()
            rows[0][field] = value
            self.assertFalse(freeze_plan(dict(version=1, tasks=tasks()), rows, {}, IDENTITY)['valid'])
        self.assertFalse(freeze_plan(dict(version=1, tasks=tasks(), identity=IDENTITY), steps(), {}, IDENTITY)['valid'])
        self.assertEqual(freeze_plan(None, [dict(index=1)], {}, IDENTITY), {})
        self.assertFalse(normalize_blockers(blocker(), {}, IDENTITY, boundary='b')['valid'])

    def test_formal_source_and_frozen_ledger_cannot_drift(self):
        raw = dict(version=1, tasks=tasks())
        source = dict(binding={'change': 'real'}, status='current', snapshot=dict(tasks=tasks()))
        self.assertTrue(freeze_plan(raw, steps(), source, IDENTITY)['valid'])
        source['snapshot']['tasks'] = tasks()[1:]
        self.assertFalse(freeze_plan(raw, steps(), source, IDENTITY)['valid'])
        raw['tasks'][0]['id'] = 'renamed'
        self.assertFalse(freeze_plan(raw, steps(), {}, IDENTITY, plan())['valid'])
        raw = dict(version=1, tasks=tasks())
        raw['tasks'][2]['title'] = '用 U 编号重试原被拒操作'
        self.assertFalse(freeze_plan(raw, steps(), {}, IDENTITY, plan())['valid'])

    def test_review_cannot_call_task_with_unverified_isolation_independent(self):
        p = plan()
        b = normalize_blockers(blocker(), p, IDENTITY, boundary='b')
        p['preconditions'] = [dict(id='iso-u', affectedTaskIds=['U'])]
        self.assertFalse(review_scope(review(), report(), p, b, IDENTITY)['valid'])
        self.assertTrue(review_scope(review(), report(), p, b, IDENTITY, {'iso-u'})['valid'])

    def test_identity_changes_and_duplicates_preserve_blockers(self):
        p = plan()
        b = normalize_blockers(blocker(), p, IDENTITY, boundary='b')
        self.assertEqual(merge_blockers(b, b), b)
        self.assertEqual(merge_blockers(b, {'valid': False})['items'], b['items'])
        for field in IDENTITY:
            other = {**IDENTITY, field: 'different'}
            self.assertFalse(normalize_blockers(blocker(), p, other, boundary='b')['valid'])
            self.assertFalse(reduce_scope(p, b, other)['valid'])
        state = LoopState(session_id='s', unresolved_blockers=b, blocked_task_scope=p,
            loops=[LoopRecord(seq=1, task_plan=p, task_blockers=b, blocker_review=dict(status='running'))])
        restored = LoopState.from_dict(state.to_dict())
        self.assertEqual(restored.unresolved_blockers, b)
        self.assertEqual(restored.loops[0].blocker_review['status'], 'running')
        self.assertEqual(LoopState.from_dict(dict(sessionId='old')).unresolved_blockers, {})
        self.assertEqual(LoopStep.from_dict(dict(index=1)).task_ids, [])
        self.assertFalse(LoopState.from_dict(dict(sessionId='s', unresolvedBlockers='invalid')).unresolved_blockers['valid'])

    def test_review_omission_and_fake_verified_cannot_credit_progress(self):
        p = plan()
        b = normalize_blockers(blocker(), p, IDENTITY, boundary='b')
        bad = report()
        bad['items'] = bad['items'][1:]
        self.assertFalse(review_scope(review(), bad, p, b, IDENTITY)['valid'])
        for ready in (['D'], ['T'], ['unknown']):
            self.assertFalse(review_scope({**review(), 'independentTaskIds': ready}, report(), p, b, IDENTITY)['valid'])
        fake = report()
        for row in fake['items']:
            if row['id'] != 'U':
                row.update(status='verified', evidence='model claims passed')
        protected = protect_report(fake, p, b, IDENTITY)
        self.assertEqual([r['status'] for r in protected['items']], ['blocked', 'blocked', 'pending'])
        records = [LoopRecord(seq=i, completed=True, progress_version=2, delivery=protected) for i in range(4)]
        self.assertEqual(assess_progress(records)['noProgressCount'], 3)

    def test_malformed_empty_mapping_is_not_legacy_and_storage_is_bounded(self):
        step = LoopStep.from_dict(dict(index=1, testWritesUserData='x' * 300000))
        serialized = step.to_dict()
        self.assertLess(len(json.dumps(serialized)), 2000)
        self.assertFalse(serialized['taskMappingValid'])
        self.assertFalse(freeze_plan(None, [serialized], {}, IDENTITY)['valid'])

    def test_unscored_review_preserves_previous_completion_score(self):
        state = LoopState(session_id='s', loops=[LoopRecord(seq=1, analysis=LoopAnalysis(score=63)),
            LoopRecord(seq=2, analysis=LoopAnalysis(score_observed=False))])
        restored = LoopState.from_dict(state.to_dict())
        self.assertFalse(restored.loops[1].analysis.score_observed)
        self.assertEqual(restored.latest_score(), 63)

    def test_prompt_contract_does_not_require_real_baseline_or_escape(self):
        self.assertIn('不等于默认读取真实存档', BLOCKER_INSTRUCTIONS)
        self.assertIn('正式规格明确要求', BLOCKER_INSTRUCTIONS)
        self.assertIn('不得换宿主/节点/通道', BLOCKER_INSTRUCTIONS)
        self.assertIn('同次调用不能自行宣布安全然后启动应用', PLAN_INSTRUCTIONS)
        self.assertIn('不运行应用/构建/测试', REVIEW_INSTRUCTIONS)
        self.assertIn('不探测已被拒资源', REVIEW_INSTRUCTIONS)


class BlockerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setup_fixture(self):
        self.bridge = delivery_tests.DeliveryIntegrationTests.bridge(self)
        self.bridge._loop_pending_out = set()
        self.bridge._loop_environment_executor = lambda: 'fake-node'
        self.session = SimpleNamespace(id='s', backend_id='executor', owner_id='fixture', working_dir='.')
        self.rec = LoopRecord(seq=1, outcome_version=1, progress_version=2,
            orchestration=[LoopStep.from_dict(row) for row in steps()])
        self.state = LoopState(session_id='s', auto=True, stage='loopexecute', loops=[self.rec])
        self.identity = self.bridge._loop_task_identity(self.session, self.state, self.rec)
        self.rec.task_plan = plan(self.identity)
        self.calls = []

    async def agent(self, _session, prompt, stage=None, seq=None, **kwargs):
        stage = stage or kwargs.get('sub_stage')
        self.calls.append((stage, prompt, kwargs))
        if stage == 'analysis':
            return json.dumps(dict(delivery=report(), blockerReview=review())), None
        return json.dumps(dict(taskBlockers=blocker())), None

    async def run_blocked(self):
        self.setup_fixture()
        self.bridge._loop_run_agent = self.agent
        await self.bridge._loop_do_execute(self.session, self.state, self.rec)

    async def test_user_incident_stops_current_batch_reviews_read_only_then_replans_u(self):
        await self.run_blocked()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.rec.orchestration[0].call_result, 'normal')
        self.assertEqual(self.rec.orchestration[0].task_result, 'blocked')
        self.assertEqual([s.status for s in self.rec.orchestration], ['done', 'pending', 'pending'])
        self.assertFalse(self.state.progress_guard.get('pause'))
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(self.calls[1][2]['resume'])
        self.assertEqual(self.calls[1][2]['execution_access'], 'read-only')
        self.assertIn('blocker-review', self.calls[1][2]['indep_session_id'])
        self.assertIn('Godot 未启动', self.calls[1][1])
        self.assertEqual(self.rec.decision['action'], 'replan')
        self.assertEqual(self.rec.blocker_review['readyIds'], ['U'])
        self.assertEqual(self.rec.blocker_review['affectedIds'], ['D', 'T'])
        self.assertFalse(self.rec.analysis.outputtable)
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 2)
        self.assertIn('未解决任务阻塞', planning_context(self.state, LoopRecord(seq=2)))

    async def test_hard_pause_wins_even_with_local_protocol(self):
        self.setup_fixture()
        async def agent(*args, **kwargs):
            return json.dumps(dict(taskBlockers=blocker(), loopControl=dict(pause=True, reason='global safety'))), None
        self.bridge._loop_run_agent = agent
        await self.bridge._loop_do_execute(self.session, self.state, self.rec)
        self.assertEqual(self.rec.decision['reasonCode'], 'unclassified_pause')
        self.assertFalse(self.state.auto)
        self.assertEqual(self.rec.blocker_review, {})

    async def test_review_failure_and_restart_do_not_retry(self):
        for status in ('running', 'failed', 'unknown'):
            await self.run_blocked()
            self.rec.blocker_review['status'] = status
            await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
            self.assertEqual(len(self.calls), 1)
            self.assertFalse(self.state.auto)
        await self.run_blocked()
        async def fail(*args, **kwargs):
            raise RuntimeError('fake failure')
        self.bridge._loop_run_agent = fail
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(self.rec.decision['reasonCode'], 'task_review_failed')
        self.assertEqual(self.rec.call_results['analysis'], 'error')

    async def test_review_output_limit_cancel_and_timeout_are_bounded(self):
        await self.run_blocked()
        async def oversized(*args, **kwargs):
            return 'x' * 262145, None
        self.bridge._loop_run_agent = oversized
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertFalse(self.state.auto)
        self.assertEqual(self.rec.blocker_review['status'], 'failed')
        await self.run_blocked()
        async def cancelled(*args, **kwargs):
            raise asyncio.CancelledError()
        self.bridge._loop_run_agent = cancelled
        with self.assertRaises(asyncio.CancelledError):
            await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(self.rec.blocker_review['status'], 'unknown')
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(self.rec.decision['reasonCode'], 'task_review_unknown')

    async def test_next_iteration_cannot_forget_or_rename_blocked_tasks(self):
        await self.run_blocked()
        next_record = LoopRecord(seq=2, orchestration=[LoopStep(index=1, desc='retry denied read')])
        self.state.loops.append(next_record)
        self.assertFalse(self.bridge._loop_freeze_tasks(self.session, self.state, next_record, {}))
        self.assertTrue(self.state.unresolved_blockers['items'])
        self.assertEqual(next_record.decision['reasonCode'], 'task_scope_unknown')

    async def test_auto_off_budget_and_stop_races(self):
        for change, expected in [('auto', 'auto_off'), ('budget', 'budget_exhausted'), ('risk', 'risk_limit')]:
            await self.run_blocked()
            if change == 'auto': self.state.auto = False
            if change == 'budget': self.state.policy.max_loops = 1
            if change == 'risk': self.state.risk_coefficient = 1
            await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
            self.assertEqual(self.rec.decision['reasonCode'], expected)
        await self.run_blocked()
        async def stopped(*args, **kwargs):
            self.state.control_mode = 'manual'
            return json.dumps(dict(delivery=report(), blockerReview=review())), None
        self.bridge._loop_run_agent = stopped
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(self.rec.blocker_review['status'], 'stale')
        self.assertFalse(self.rec.completed)

    async def test_late_review_failure_overflow_and_backend_change_are_history_only(self):
        for variant in ('failure', 'overflow', 'backend', 'runtime'):
            await self.run_blocked()
            async def stale(*args, **kwargs):
                if variant == 'backend':
                    self.bridge._backend_configs[0].env = {'REVISION': 'new'}
                elif variant == 'runtime':
                    self.rec.runtimes['analysis'] = {'model': 'other'}
                else:
                    self.state.control_revision += 1
                self.state.progress_guard = {'marker': 'new-state'}
                self.rec.decision = {'marker': 'new-decision'}
                if variant == 'failure':
                    raise RuntimeError('stale fake failure')
                return ('x' * 262145 if variant == 'overflow' else json.dumps(dict(delivery=report(), blockerReview=review()))), None
            self.bridge._loop_run_agent = stale
            await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
            self.assertEqual(self.rec.blocker_review['status'], 'stale', variant)
            self.assertEqual(self.state.progress_guard, {'marker': 'new-state'}, variant)
            self.assertEqual(self.rec.decision, {'marker': 'new-decision'}, variant)
            self.assertTrue(self.state.auto)

    async def test_resolution_failure_after_control_change_does_not_pause_new_state(self):
        await self.run_blocked()
        def stale(*args, **kwargs):
            self.state.control_revision += 1
            raise ContractError('stale resolution')
        with patch('src.backend.loop_task_blocker_bridge.resolve_observations', side_effect=stale):
            await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(self.rec.blocker_review['status'], 'stale')
        self.assertTrue(self.state.auto)
        self.assertFalse(self.state.progress_guard.get('pause'))

    async def test_first_blocker_in_regular_analysis_is_retained_without_second_review(self):
        self.setup_fixture()
        async def agent(*args, **kwargs):
            self.calls.append(kwargs)
            return json.dumps(dict(taskBlockers=blocker())), None
        self.bridge._loop_run_agent = agent
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(self.calls[0]['execution_access'], 'read-only')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.rec.call_results['analysis'], 'normal')
        self.assertEqual(self.state.unresolved_blockers['items'][0]['id'], 'baseline')
        self.assertFalse(self.state.auto)
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 1)

    async def test_dependency_blocker_is_not_mislabelled_as_isolation(self):
        self.setup_fixture()
        self.bridge._loop_run_agent = self.agent
        await self.bridge._loop_run_step(self.session, self.state, self.rec, self.rec.orchestration[1], False)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.state.unresolved_blockers['items'][0]['reasonCode'], 'dependency_unverified')

    async def test_concurrent_reads_settle_but_unstarted_write_never_runs(self):
        self.setup_fixture()
        self.rec.orchestration = [LoopStep(index=1, desc='baseline', mode='concurrent', access='read', task_ids=['T']),
            LoopStep(index=2, desc='independent read', mode='concurrent', access='read', task_ids=['U']),
            LoopStep(index=3, desc='dependent write', task_ids=['D'], depends_on=['T'])]
        self.rec.task_plan = freeze_plan(dict(version=1, tasks=tasks()), [s.to_dict() for s in self.rec.orchestration], {}, self.identity)
        started, settled = asyncio.Event(), asyncio.Event()
        async def agent(*args, **kwargs):
            stage = kwargs['sub_stage']
            self.calls.append(stage)
            if stage == 'step1':
                await started.wait()
                return json.dumps(dict(taskBlockers=blocker())), None
            started.set()
            await asyncio.sleep(.01)
            settled.set()
            return 'independent read returned', None
        self.bridge._loop_run_agent = agent
        await self.bridge._loop_do_execute(self.session, self.state, self.rec)
        self.assertTrue(settled.is_set())
        self.assertEqual(set(self.calls), {'step1', 'step2'})
        self.assertEqual(self.rec.orchestration[2].status, 'pending')

    async def test_dispatch_is_deduplicated_and_entry_rechecks_auto(self):
        await self.run_blocked()
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.bridge._loop_state = lambda _: self.state
        self.bridge._schedule_loop_iteration = Mock(return_value=True)
        self.bridge._loop_tasks = {}
        self.bridge._loop_running = set()
        self.bridge._maybe_autocontinue('s')
        self.bridge._maybe_autocontinue('s')
        self.assertEqual(self.bridge._schedule_loop_iteration.call_count, 1)
        self.bridge._active_sessions = {'s': self.session}
        self.state.auto = False
        await self.bridge._run_loop_iteration('s', auto_required=True, decision_id=self.rec.decision['decisionId'])
        self.assertEqual(len(self.state.loops), 1)

    async def test_local_blocker_stops_retries_of_already_started_read_batch(self):
        from src.backend.bridge_ws import _LoopAgentStalledError
        self.setup_fixture()
        self.bridge._emit_loop_progress = Mock()
        self.rec.orchestration = [LoopStep(index=1, desc='baseline', mode='concurrent', access='read', task_ids=['T']),
            LoopStep(index=2, desc='independent read', mode='concurrent', access='read', task_ids=['U'])]
        self.rec.task_plan = freeze_plan(dict(version=1, tasks=tasks()), [s.to_dict() for s in self.rec.orchestration], {}, self.identity)
        started = asyncio.Event()
        async def agent(*args, **kwargs):
            stage = kwargs['sub_stage']
            self.calls.append(stage)
            if stage == 'step1':
                await started.wait()
                return json.dumps(dict(taskBlockers=blocker())), None
            started.set()
            await asyncio.sleep(.01)
            raise _LoopAgentStalledError(30, 'partial read', retryable=True)
        self.bridge._loop_run_agent = agent
        await self.bridge._loop_do_execute(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.rec.orchestration[1].attempts, 1)
        self.assertEqual(self.rec.orchestration[1].call_result, 'timeout')
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.rec.decision['reasonCode'], 'task_review_unavailable')

    async def test_active_runner_and_environment_blocker_prevent_review(self):
        await self.run_blocked()
        self.bridge._loop_has_active_call = lambda _: True
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 1)
        self.assertNotEqual(self.rec.blocker_review['status'], 'done')
        await self.run_blocked()
        self.rec.orchestration[1].status = 'error'
        self.rec.orchestration[1].call_result = 'error'
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.rec.decision['reasonCode'], 'task_review_unavailable')

    async def test_late_response_cannot_register_blocker_on_changed_identity(self):
        self.setup_fixture()
        async def stale(*args, **kwargs):
            self.state.control_revision += 1
            return json.dumps(dict(taskBlockers=blocker())), None
        self.bridge._loop_run_agent = stale
        await self.bridge._loop_run_step(self.session, self.state, self.rec, self.rec.orchestration[0], False)
        self.assertEqual(self.state.unresolved_blockers, {})
        self.assertEqual(self.rec.orchestration[0].task_result, 'unknown')

    async def test_unmapped_legacy_blocker_review_fails_closed(self):
        self.setup_fixture()
        self.rec.task_plan = {}
        self.rec.orchestration = [LoopStep(index=1, desc='legacy')]
        self.bridge._loop_run_agent = self.agent
        await self.bridge._loop_do_execute(self.session, self.state, self.rec)
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(self.state.auto)
        self.assertEqual(self.rec.decision['reasonCode'], 'task_scope_unknown')

    async def test_no_ready_tasks_preserve_explicit_baseline_acceptance(self):
        await self.run_blocked()
        async def only_dependencies(*args, **kwargs):
            return json.dumps(dict(delivery=report(), blockerReview={**review(), 'independentTaskIds': []})), None
        self.bridge._loop_run_agent = only_dependencies
        await self.bridge._loop_do_analysis(self.session, self.state, self.rec)
        self.assertEqual(self.rec.decision['reasonCode'], 'task_blocked')
        self.assertIn('明确基线要求仍保留', self.rec.decision['resumeCondition'])
        self.assertEqual(self.rec.delivery['items'][0]['status'], 'blocked')

    async def test_normal_followup_still_reviews_read_only_and_cannot_erase_blocker(self):
        await self.run_blocked()
        next_record = LoopRecord(seq=2, progress_version=2, outcome_version=1, task_plan=copy.deepcopy(self.rec.task_plan))
        self.state.loops.append(next_record)
        await self.bridge._loop_do_analysis(self.session, self.state, next_record)
        self.assertEqual(self.calls[-1][2]['execution_access'], 'read-only')
        self.assertEqual(self.state.unresolved_blockers['items'][0]['id'], 'baseline')

    async def test_precondition_gate_prevents_test_launch(self):
        self.setup_fixture()
        self.rec.orchestration[0].test_writes_user_data = True
        self.rec.task_plan = freeze_plan(dict(version=1, tasks=tasks()), [s.to_dict() for s in self.rec.orchestration], {}, self.identity)
        self.bridge._loop_run_agent = self.agent
        await self.bridge._loop_do_execute(self.session, self.state, self.rec)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.rec.decision['reasonCode'], 'task_scope_unknown')


class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'test-user').mkdir()
        (self.root / 'evidence.txt').write_text('application mechanism and config revision', encoding='utf-8')
        self.proof = dict(path='evidence.txt', sha256=hashlib.sha256((self.root / 'evidence.txt').read_bytes()).hexdigest())
        self.condition = dict(id='iso', affectedTaskIds=['T'], writeKind='save', isolatedRoot='test-user',
            verificationMethod='inspect actual app data path and links', configRevision='r1', evidenceRefs=['config:1'], baselineBasis='')
        self.steps = [dict(index=1, taskIds=['U'], dependsOn=[], preconditionIds=[], access='write'),
                      dict(index=2, taskIds=['T'], dependsOn=[], preconditionIds=['iso'], access='write', testWritesUserData=True)]
        self.plan = freeze_plan(dict(version=1, tasks=tasks(), preconditions=[self.condition]), self.steps, {}, IDENTITY)
        self.observation = dict(version=1, items=[dict(id='iso', actualRoot='test-user', method=self.condition['verificationMethod'],
            configRevision='r1', evidenceRefs=['evidence.txt:1'], files=[self.proof], baselineEvidenceRefs=[])])

    def test_separate_valid_observation_and_file_revision_gate(self):
        receipts = isolation_receipts(self.observation, self.plan, IDENTITY, self.steps[0], str(self.root))
        self.assertTrue(receipts['valid'], receipts)
        self.assertEqual(receipts['items']['iso']['evidenceLevel'], 'model_observation')
        self.assertEqual(isolation_gate(self.plan, receipts, IDENTITY, self.steps[1], str(self.root)), '')
        self.assertTrue(isolation_gate(self.plan, receipts, {**IDENTITY, 'executor': 'other'}, self.steps[1], str(self.root)))
        (self.root / 'evidence.txt').write_text('changed', encoding='utf-8')
        self.assertTrue(isolation_gate(self.plan, receipts, IDENTITY, self.steps[1], str(self.root)))

    def test_no_proof_env_only_same_call_wrong_policy_and_explicit_baseline(self):
        self.assertTrue(isolation_gate(self.plan, {}, IDENTITY, self.steps[1], str(self.root)))
        self.assertFalse(isolation_receipts(dict(version=1, items=[dict(id='iso', safe=True)]), self.plan, IDENTITY, self.steps[0], str(self.root))['valid'])
        self.assertFalse(isolation_receipts(self.observation, self.plan, IDENTITY, self.steps[1], str(self.root))['valid'])
        readonly = {**self.steps[0], 'access': 'read'}
        receipts = isolation_receipts(self.observation, self.plan, IDENTITY, readonly, str(self.root))
        self.assertTrue(isolation_gate(self.plan, receipts, IDENTITY, self.steps[1], str(self.root)))
        self.plan['preconditions'][0]['baselineBasis'] = '用户明确要求真实基线前后比较'
        self.assertFalse(isolation_receipts(self.observation, self.plan, IDENTITY, self.steps[0], str(self.root))['valid'])

    def test_outside_root_or_alias_never_reads_real_data(self):
        self.observation['items'][0]['actualRoot'] = '..'
        self.assertFalse(isolation_receipts(self.observation, self.plan, IDENTITY, self.steps[0], str(self.root))['valid'])
        with tempfile.TemporaryDirectory() as outside:
            try:
                (self.root / 'alias').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('symlink unavailable on this executor')
            self.observation['items'][0]['actualRoot'] = 'alias'
            self.plan['preconditions'][0]['isolatedRoot'] = 'alias'
            self.assertFalse(isolation_receipts(self.observation, self.plan, IDENTITY, self.steps[0], str(self.root))['valid'])

    def test_resolve_requires_fresh_applicable_evidence_and_never_waives(self):
        import os
        b = normalize_blockers(blocker(), plan(), IDENTITY, boundary='b')
        b['items'][0]['observedAt'] = (self.root / 'evidence.txt').stat().st_mtime + 1
        resolution = dict(version=1, items=[dict(id='baseline', result='resolved', reason='new lawful check evidence',
            evidenceRefs=['evidence.txt:1'], files=[self.proof])])
        with self.assertRaises(ContractError):
            resolve_observations(resolution, b, IDENTITY, str(self.root))
        os.utime(self.root / 'evidence.txt', (b['items'][0]['observedAt'] + 1,) * 2)
        remaining, evidence = resolve_observations(resolution, b, IDENTITY, str(self.root))
        self.assertEqual(remaining, {})
        self.assertEqual(evidence[0]['original']['id'], 'baseline')
        with self.assertRaises(ContractError):
            resolve_observations(resolution, b, {**IDENTITY, 'session': 'other'}, str(self.root))
        resolution['items'][0]['result'] = 'waived'
        with self.assertRaises(ContractError):
            resolve_observations(resolution, b, IDENTITY, str(self.root))


if __name__ == '__main__':
    unittest.main()
