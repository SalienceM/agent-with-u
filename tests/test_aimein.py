"""AIMEIN protocols and lifecycle, using temporary workspaces and fake model calls only."""
import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from src.backend.aimein import (AimeinError, normalize_plan, normalize_review, progress_observation,
                               resolve_reviewers, workspace_fingerprint, run_summary)
from src.backend.aimein_bridge import acceptance_complete
from src.backend.loop_store import LoopPolicy, LoopRecord, LoopState, LoopStep, STAGE_EXECUTE
from tests import test_loop_lifecycle as lifecycle


def plan():
    return dict(targets=[dict(id='T1', title='Product flow', acceptance='Flow works with tested storage', dependsOn=[])],
        sprint=dict(title='First usable flow', outcome='Use a saved item', maturityTarget=40,
            maturityMeaning='Happy path works and is tested', flowBuild='Create and reopen item', infra='Local storage',
            deferred=['Polish'], criteria=[dict(id='C1', targetId='T1', lane='flow', acceptance='Saved item can be reopened')]))


def review(passed=True, complete=False):
    def item(key, verified):
        return dict(id=key, status='verified' if verified else 'gap', reason='Inspected product evidence', evidence=['product.txt'] if verified else [])
    return dict(verdict='pass' if passed else 'revise', maturity=40 if passed else 20, summary='Reviewed',
        criteria=[item('C1', passed)], targets=[item('T1', complete)], goalComplete=complete, nextFocus='Next flow')


def configs():
    return [SimpleNamespace(id='b', type='codex-office', model='', base_url='')]


def settings():
    return [dict(backendId='b', model=f'model-{i}', reasoningEffort='') for i in range(3)]


class AimeinContracts(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / 'product.txt').write_text('tested product', encoding='utf-8')

    def test_legacy_policy_and_roundtrip(self):
        self.assertEqual(LoopPolicy.from_dict({}).execution_mode, 'loop')
        p = LoopPolicy.from_dict(dict(executionMode='aimein', aimeinReviewers=settings()))
        self.assertEqual(LoopPolicy.from_dict(p.to_dict()), p)
        r = LoopRecord(1, aimein_run={'plan': normalize_plan(plan()), 'reviews': settings()})
        self.assertEqual(LoopRecord.from_dict(r.to_dict()).aimein_run, r.aimein_run)

    def test_progress_ignores_renumbering_scores_and_reworded_reports(self):
        first = {'plan': normalize_plan(plan()), 'reviews': [normalize_review(review(), normalize_plan(plan()), str(self.root)) for _ in range(3)]}
        later = copy.deepcopy(first)
        later['plan']['sprint']['criteria'][0].update(id='new-id', acceptance='Reworded happy path')
        for r in later['reviews']:
            r.update(maturity=90, summary='More optimistic')
            r['criteria'][0]['id'] = 'new-id'
        self.assertEqual(progress_observation(first, [])['noProgress'], 0)
        self.assertEqual(progress_observation(later, [first])['noProgress'], 1)
        self.assertEqual(progress_observation(later, [first, later])['noProgress'], 2)

    def test_progress_requires_new_condition_and_evidence_or_complete_target(self):
        first = {'plan': normalize_plan(plan()), 'reviews': [normalize_review(review(), normalize_plan(plan()), str(self.root)) for _ in range(3)]}
        changed = copy.deepcopy(first)
        (self.root / 'product.txt').write_text('new verified functionality', encoding='utf-8')
        changed['reviews'] = [normalize_review(review(), changed['plan'], str(self.root)) for _ in range(3)]
        self.assertFalse(progress_observation(changed, [first])['advanced'])  # 文件变化本身不是进展。
        changed['plan']['sprint']['criteria'][0]['acceptance'] = 'New functionality works'
        self.assertTrue(progress_observation(changed, [first])['advanced'])
        complete = copy.deepcopy(first)
        complete['reviews'] = [normalize_review(review(True, True), complete['plan'], str(self.root)) for _ in range(3)]
        self.assertEqual(progress_observation(complete, [first])['newTargets'], 1)

    def test_distinct_models_and_no_backend_fallback(self):
        self.assertEqual(len(resolve_reviewers(settings(), configs())), 3)
        for raw in (settings()[:2], [settings()[0]] * 3, [{**v, 'backendId': 'missing'} for v in settings()]):
            with self.assertRaises(AimeinError): resolve_reviewers(raw, configs())
        cfg = configs(); cfg[0].type = 'openai-compatible'; cfg[0].model = 'configured'
        with self.assertRaises(AimeinError): resolve_reviewers(settings(), cfg)
        cfg[0].base_url = 'https://api.poe.com/v1'
        with self.assertRaises(AimeinError): resolve_reviewers(settings(), cfg)
        cfg = configs(); cfg[0].enabled = False
        with self.assertRaises(AimeinError): resolve_reviewers(settings(), cfg)

    def test_plan_is_complete_and_acyclic(self):
        for mutate in (lambda p: p['targets'][0].update(dependsOn=['T1']),
                       lambda p: p['sprint'].update(criteria=[]),
                       lambda p: p['sprint'].update(maturityTarget=float('nan')),
                       lambda p: p['sprint']['criteria'][0].update(targetId='missing')):
            raw = plan(); mutate(raw)
            with self.assertRaises(AimeinError): normalize_plan(raw)

    def test_scores_do_not_replace_conditions_or_whole_goal(self):
        raw = review(False, False); raw.update(verdict='pass', maturity=100, goalComplete=True)
        result = normalize_review(raw, normalize_plan(plan()), str(self.root))
        self.assertFalse(result['passed']); self.assertFalse(result['goalComplete'])
        result = normalize_review(review(True, False), normalize_plan(plan()), str(self.root))
        self.assertTrue(result['passed']); self.assertFalse(result['goalComplete'])

    def test_missing_duplicate_evidence_and_path_escape_fail(self):
        for mutate in (lambda r: r.update(criteria=[]),
                       lambda r: r['criteria'].append(copy.deepcopy(r['criteria'][0])),
                       lambda r: r['criteria'][0].update(evidence=[]),
                       lambda r: r['criteria'][0].update(evidence=['../outside.txt'])):
            raw = review(True, True); mutate(raw)
            with self.assertRaises(AimeinError): normalize_review(raw, normalize_plan(plan()), str(self.root))

    def test_snapshot_detects_unreferenced_artifact_change(self):
        before = workspace_fingerprint(str(self.root))
        (self.root / 'new.txt').write_text('changed', encoding='utf-8')
        self.assertNotEqual(before, workspace_fingerprint(str(self.root)))

    def test_persisted_complete_flag_alone_is_not_acceptance(self):
        self.assertFalse(acceptance_complete(dict(complete=True, accepted=True, reviews=[])))


class AimeinLifecycle(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name); (self.root / 'product.txt').write_text('tested product', encoding='utf-8')
        self.state = LoopState('aimein-test', stage=STAGE_EXECUTE, goal='Build a product', auto=True)
        self.state.policy = LoopPolicy.from_dict(dict(executionMode='aimein', aimeinReviewers=settings(), maxLoops=12, intentGuard=False))
        self.bridge, self.session = lifecycle.LoopLifecycleTests._bridge(self.state)
        self.session.working_dir = str(self.root); self.session.owner_id = 'local'; self.session.backend_id = 'b'
        self.session.session_type = 'loop'; self.session.messages = []
        self.bridge._backend_configs = configs()
        self.bridge._loop_check_source = AsyncMock(return_value=True)
        self.bridge._loop_runtime = lambda *_: {}
        self.bridge._loop_original_intent_brief = lambda *_: 'Original product intent'
        self.bridge._runtime_label = lambda *_: 'Fixture model'
        self.bridge._loop_progress_for_record = lambda *_: {}
        self.bridge._schedule_loop_iteration = Mock(return_value=True)
        self.calls = []; self.passed = True; self.complete = False
        async def agent(session, prompt, stage, seq, **kwargs):
            self.calls.append((stage, prompt, kwargs))
            return json.dumps({'aimeinPlan': plan()} if stage == 'aimein-plan' else {'aimeinReview': review(self.passed, self.complete)}), None
        self.bridge._loop_run_agent = agent
        async def prepare(session, state, record, history):
            record.orchestration = [LoopStep(1, desc='Implement flow', status='pending', access='write')]
            record.sub_stage = 'execute'
        async def execute(session, state, record):
            record.orchestration[0].status = 'done'; record.orchestration[0].output = 'Product file and test evidence'
            record.sub_stage = 'analysis'
        self.bridge._loop_do_prepare = AsyncMock(side_effect=prepare)
        self.bridge._loop_do_execute = AsyncMock(side_effect=execute)

    async def run_attempt(self):
        await self.bridge._run_loop_iteration(self.session.id)
        return self.state.loops[-1]

    async def test_dynamic_sprints_and_three_fresh_equal_review_inputs(self):
        first = await self.run_attempt()
        self.assertTrue(first.aimein_run['accepted']); self.assertFalse(first.aimein_run['complete'])
        calls = [c for c in self.calls if c[0].startswith('aimein-review')]
        self.assertEqual(len(calls), 3); self.assertEqual(len({c[1] for c in calls}), 1)
        self.assertEqual(len({c[2]['indep_session_id'] for c in calls}), 3)
        self.assertTrue(all(c[2]['execution_access'] == 'read-only' and not c[2]['resume'] for c in calls))
        self.assertEqual(len({c[2]['runtime']['model'] for c in calls}), 3)
        second = await self.run_attempt()
        self.assertEqual(second.aimein_run['sprintNumber'], 2)
        self.assertEqual(second.aimein_run['attempt'], 1)
        self.assertEqual(self.state.stage, 'loopexecute')

    async def test_explicitly_unneeded_source_uses_generic_execution(self):
        self.state.goal = '建设产品。无需历史存档基线、外部工具或 OpenSpec 来源。'
        self.bridge._loop_openspec_source = AsyncMock(side_effect=AssertionError('unexpected source discovery'))
        rec = await self.run_attempt()
        self.assertTrue(rec.aimein_run['accepted'])
        self.bridge._loop_openspec_source.assert_not_called()
        self.bridge._loop_do_prepare.assert_awaited_once()
        self.bridge._loop_do_execute.assert_awaited_once()

    async def test_real_prepare_execute_and_review_pipeline_with_fake_model_boundary(self):
        # 不替换 prepare/execute/协议门禁；仅在模型边界给确定性响应与临时产物。
        from src.backend.bridge_ws import BridgeWS
        self.state.policy.intent_guard = False
        self.bridge._loop_do_prepare = BridgeWS._loop_do_prepare.__get__(self.bridge)
        self.bridge._loop_do_execute = BridgeWS._loop_do_execute.__get__(self.bridge)
        self.bridge._resolved_runtime = lambda *_: {}
        self.bridge._emit_loop_progress = Mock()
        self.bridge._loop_task_identity = lambda *_: {'workspace': str(self.root), 'session': self.session.id}
        async def agent(session, prompt, stage=None, seq=0, **kwargs):
            stage = stage or kwargs['sub_stage']
            self.calls.append((stage, prompt, kwargs))
            if stage == 'aimein-plan':
                value = {'aimeinPlan': plan()}
            elif stage == 'prepare':
                value = {'goal': 'Implement current flow', 'taskPlan': {'version': 1,
                    'tasks': [{'id': 'T1', 'title': 'Product flow', 'dependsOn': [], 'status': 'pending'}], 'preconditions': []},
                    'orchestration': [{'desc': 'Implement and verify current flow', 'mode': 'sequential', 'access': 'write',
                        'taskIds': ['T1'], 'dependsOn': [], 'preconditionIds': [], 'testWritesUserData': False}]}
            elif stage.startswith('step'):
                (self.root / 'product.txt').write_text(f'Verified fixture artifact {seq}', encoding='utf-8')
                value = {'taskEvidence': [{'id': 'T1', 'status': 'verified', 'evidence': 'product.txt'}]}
            else:
                self.assertTrue(stage.startswith('aimein-review'), stage)
                self.assertEqual((self.root / 'product.txt').read_text(encoding='utf-8'), f'Verified fixture artifact {seq}')
                value = {'aimeinReview': review(True, seq == 2)}
            return json.dumps(value), None
        self.bridge._loop_run_agent = agent
        first = await self.run_attempt()
        self.assertTrue(first.aimein_run['accepted'], first.decision)
        self.assertTrue(first.task_plan['valid'])
        self.assertEqual(first.orchestration[0].status, 'done')
        self.assertEqual(first.stage_details['taskEvidence']['1'][0]['status'], 'verified')
        second = await self.run_attempt()
        self.assertEqual(second.aimein_run['sprintNumber'], 2)
        self.assertTrue(acceptance_complete(second.aimein_run))
        self.assertEqual(self.state.stage, 'loopout')
        self.assertEqual([c[0] for c in self.calls],
                         ['aimein-plan', 'prepare', 'step1', 'aimein-review1', 'aimein-review2', 'aimein-review3'] * 2)

    async def test_repair_keeps_frozen_conditions_and_no_progress_pauses(self):
        self.passed = False
        first = await self.run_attempt(); second = await self.run_attempt(); third = await self.run_attempt()
        self.assertEqual(first.aimein_run['plan'], second.aimein_run['plan'])
        self.assertEqual(second.aimein_run['sprintNumber'], 1); self.assertEqual(second.aimein_run['attempt'], 2)
        self.assertEqual(sum(c[0] == 'aimein-plan' for c in self.calls), 1)
        self.assertTrue(second.aimein_run['repairBasis'])
        self.assertEqual(third.decision['reasonCode'], 'no_progress'); self.assertFalse(self.state.auto)

    async def test_final_acceptance_requires_three_complete_goals(self):
        self.complete = True
        rec = await self.run_attempt()
        self.assertEqual(rec.decision['action'], 'complete'); self.assertEqual(self.state.stage, 'loopout')

    async def test_budget_exhaustion_is_not_success(self):
        self.state.policy.max_loops = 1
        rec = await self.run_attempt()
        self.assertEqual(rec.decision['reasonCode'], 'budget_exhausted'); self.assertEqual(self.state.status, 'aborted')

    async def test_missing_configuration_stops_before_any_model_or_write(self):
        self.state.policy.aimein_reviewers = []
        rec = await self.run_attempt()
        self.assertEqual(rec.terminal_kind, 'paused'); self.assertFalse(self.calls)
        self.bridge._loop_do_execute.assert_not_called()

    async def test_changed_artifacts_reject_review(self):
        original = self.bridge._loop_run_agent
        async def agent(*args, **kwargs):
            result = await original(*args, **kwargs)
            if args[2] == 'aimein-review1': (self.root / 'new.txt').write_text('drift', encoding='utf-8')
            return result
        self.bridge._loop_run_agent = agent
        rec = await self.run_attempt()
        self.assertFalse(rec.aimein_run['accepted']); self.assertEqual(rec.terminal_kind, 'paused')
        self.assertEqual(len([c for c in self.calls if c[0].startswith('aimein-review')]), 1)

    async def test_source_scope_or_goal_change_retains_history_without_acceptance(self):
        original = self.bridge._loop_run_agent
        async def agent(*args, **kwargs):
            result = await original(*args, **kwargs)
            if args[2] == 'aimein-review1': self.state.goal = 'New goal'
            return result
        self.bridge._loop_run_agent = agent
        rec = await self.run_attempt()
        self.assertEqual(rec.aimein_run['status'], 'stale'); self.assertFalse(rec.completed)

    async def test_restart_does_not_replay_finished_execution_or_completed_reviews(self):
        rec = await self.run_attempt()
        rec.completed = False; rec.terminal_kind = ''; rec.sub_stage = 'analysis'; rec.aimein_run['reviews'][2]['status'] = 'pending'
        self.calls.clear(); self.bridge._loop_do_execute.reset_mock()
        await self.run_attempt()
        self.bridge._loop_do_execute.assert_not_called()
        self.assertEqual([c[0] for c in self.calls], ['aimein-review3'])

    async def test_invalid_review_resume_after_roundtrip_only_retries_missing_reviews(self):
        original = self.bridge._loop_run_agent
        fail = True
        async def agent(*args, **kwargs):
            nonlocal fail
            result = await original(*args, **kwargs)
            if args[2] == 'aimein-review2' and fail:
                fail = False
                return '{}', None
            return result
        self.bridge._loop_run_agent = agent
        first = await self.run_attempt()
        self.assertEqual(first.terminal_kind, 'paused')
        self.assertFalse(self.state.auto)
        self.assertEqual(first.orchestration[0].status, 'done')
        first = LoopRecord.from_dict(first.to_dict())
        self.state.loops[-1] = first
        self.assertEqual(self.bridge._loop_iteration_request(self.state)['action'], 'resume')
        resumed = await self.run_attempt()
        self.assertIs(resumed, first)
        self.assertEqual(resumed.aimein_run['attempt'], 1)
        self.bridge._loop_do_prepare.assert_awaited_once()
        self.bridge._loop_do_execute.assert_awaited_once()
        self.assertEqual([c[0] for c in self.calls if c[0].startswith('aimein-review')],
                         ['aimein-review1', 'aimein-review2', 'aimein-review2', 'aimein-review3'])
        retried = [c[2]['indep_session_id'] for c in self.calls if c[0] == 'aimein-review2']
        self.assertEqual(len(set(retried)), 2)
        self.assertEqual([a['status'] for a in resumed.aimein_run['reviews'][1]['attempts']], ['error', 'passed'])
        self.assertNotIn('error', resumed.aimein_run['reviews'][1])
        self.assertTrue(resumed.aimein_run['accepted'])

    async def test_backend_review_failure_keeps_checkpoint_and_waits_for_old_exit(self):
        original = self.bridge._loop_run_agent
        fail = True
        async def agent(*args, **kwargs):
            nonlocal fail
            result = await original(*args, **kwargs)
            if args[2] == 'aimein-review2' and fail:
                fail = False
                raise RuntimeError('fixture reviewer connection failed')
            return result
        self.bridge._loop_run_agent = agent
        first = await self.run_attempt()
        self.assertEqual(first.terminal_kind, 'paused')
        self.assertFalse(self.state.auto)
        calls = len(self.calls)
        self.bridge._loop_active_backends[self.session.id + ':old-review'] = object()
        self.assertFalse(self.bridge._loop_iteration_request(self.state)['canRequest'])
        await self.run_attempt()
        self.assertEqual(len(self.calls), calls)
        self.bridge._loop_active_backends.clear()  # 夹具模拟旧调用已确认退出。
        resumed = await self.run_attempt()
        self.assertIs(resumed, first)
        self.bridge._loop_do_execute.assert_awaited_once()
        self.assertTrue(resumed.aimein_run['accepted'])

    async def test_review_retry_budget_does_not_restart_execution(self):
        original = self.bridge._loop_run_agent
        async def agent(*args, **kwargs):
            result = await original(*args, **kwargs)
            return ('{}', None) if args[2] == 'aimein-review2' else result
        self.bridge._loop_run_agent = agent
        first = await self.run_attempt()
        for _ in range(3):
            self.assertIs(await self.run_attempt(), first)
        self.assertEqual(sum(c[0] == 'aimein-review2' for c in self.calls), 3)
        self.bridge._loop_do_execute.assert_awaited_once()
        self.assertFalse(first.completed)
        self.assertIn('三次', first.aimein_run['message'])

    async def test_review_resume_rechecks_artifact_before_any_call(self):
        first = await self.run_attempt()
        first.completed = False; first.terminal_kind = 'paused'; first.sub_stage = 'analysis'
        first.aimein_run['reviews'][1]['status'] = 'error'
        (self.root / 'product.txt').write_text('changed after pause', encoding='utf-8')
        self.calls.clear()
        await self.run_attempt()
        self.assertFalse(self.calls)
        self.bridge._loop_do_execute.assert_awaited_once()
        self.assertEqual(first.aimein_run['status'], 'stale')

    async def test_repeated_accepted_sprints_pause_across_stage_numbers(self):
        records = [await self.run_attempt() for _ in range(4)]
        self.assertEqual([r.aimein_run['noProgress'] for r in records], [0, 1, 2, 3])
        self.assertEqual([r.aimein_run['sprintNumber'] for r in records], [1, 2, 3, 4])
        self.assertEqual(records[-1].decision['reasonCode'], 'no_progress')
        self.assertFalse(self.state.auto)
        self.assertEqual(self.state.stage, 'loopexecute')
        self.assertFalse(records[-1].aimein_run['complete'])

    async def test_unknown_running_review_is_not_replayed(self):
        rec = await self.run_attempt()
        rec.completed = False; rec.terminal_kind = ''; rec.sub_stage = 'analysis'; rec.aimein_run['reviews'][2]['status'] = 'running'
        self.calls.clear()
        await self.run_attempt()
        self.assertFalse(self.calls); self.assertEqual(rec.terminal_kind, 'paused')
        await self.run_attempt()
        self.assertFalse(self.calls)
        self.bridge._loop_do_execute.assert_awaited_once()

    async def test_source_or_active_call_blocks_entry(self):
        self.bridge._loop_has_active_call = lambda *_: True
        await self.bridge._run_loop_iteration(self.session.id)
        self.assertFalse(self.calls)

    async def test_openspec_uses_native_tasks_and_requires_verify_before_final(self):
        self.complete = True
        self.state.task_source = {'binding': {'change': 'test'}, 'status': 'current', 'snapshot': {'tasks': [], 'scopeDigest': 'scope'}}
        self.bridge._loop_openspec_source = AsyncMock(return_value=True)
        async def native(session, state, record):
            record.contract_required = False
            record.openspec_run = {'phase': 'apply', 'status': 'done'}
            record.orchestration = [LoopStep(1, status='done', desc='Native apply')]
            record.completed = True; record.sub_stage = 'done'
        self.bridge._loop_openspec_iteration = AsyncMock(side_effect=native)
        rec = await self.run_attempt()
        self.bridge._loop_do_prepare.assert_not_called(); self.bridge._loop_do_execute.assert_not_called()
        self.assertFalse(rec.aimein_run['complete']); self.assertEqual(self.state.stage, 'loopexecute')

    async def test_summary_lazy_detail_and_progress_replay(self):
        rec = await self.run_attempt()
        summary = run_summary(rec.aimein_run)
        self.assertNotIn('plan', summary); self.assertNotIn('fingerprints', str(summary))
        result = json.loads(self.bridge._rpc_loopGetRecord(self.session.id, rec.seq))
        self.assertEqual(result['record']['aimeinSummary']['revision'], summary['revision'])
        self.bridge._remember_loop_progress(self.session.id, rec.seq, 'aimein-review1', 'live')
        self.assertEqual(self.bridge._loop_progress_snapshots[self.session.id][f'{rec.seq}:aimein-review1'], 'live')

    async def test_real_prepare_execute_contract_and_task_gate(self):
        from src.backend.bridge_ws import BridgeWS
        self.bridge._loop_do_prepare = BridgeWS._loop_do_prepare.__get__(self.bridge)
        self.bridge._loop_do_execute = BridgeWS._loop_do_execute.__get__(self.bridge)
        self.bridge._loop_environment_executor = lambda: 'fixture-node'
        self.bridge._resolved_runtime = lambda *_: {}
        self.bridge._backend_label = lambda *_: 'fixture'
        self.bridge._emit_loop_progress = Mock()
        original = self.bridge._loop_run_agent
        writes = []
        fail_review = True
        async def agent(session, prompt, stage=None, seq=None, **kwargs):
            nonlocal fail_review
            stage = stage or kwargs.pop('sub_stage', '')
            if stage == 'prepare':
                return json.dumps(dict(goal='Implement saved flow', taskPlan=dict(version=1, tasks=[dict(id='T1', title='Implement saved flow', dependsOn=[], status='pending')]),
                    orchestration=[dict(index=1, desc='Implement saved flow', access='write', mode='sequential', taskIds=['T1'], dependsOn=[], preconditionIds=[])])), None
            if stage == 'step1':
                writes.append(stage)
                (self.root / 'product.txt').write_text('implemented by fake executor', encoding='utf-8')
                return 'Saved flow and its evidence', None
            if stage == 'aimein-review2' and fail_review:
                fail_review = False
                return '{}', None
            return await original(session, prompt, stage, seq, **kwargs)
        self.bridge._loop_run_agent = agent
        rec = await self.run_attempt()
        self.assertEqual(rec.terminal_kind, 'paused')
        self.assertIs(await self.run_attempt(), rec)
        self.assertEqual(writes, ['step1'])
        self.assertFalse(rec.error)
        self.assertTrue(rec.task_plan['valid'])
        self.assertEqual(rec.orchestration[0].status, 'done')
        self.assertTrue(rec.aimein_run['accepted'])

    async def test_changed_connection_does_not_receive_acceptance(self):
        original = self.bridge._loop_run_agent
        async def agent(*args, **kwargs):
            result = await original(*args, **kwargs)
            if args[2] == 'aimein-review1': self.bridge._backend_configs[0].base_url = 'changed'
            return result
        self.bridge._loop_run_agent = agent
        rec = await self.run_attempt()
        self.assertFalse(rec.completed); self.assertEqual(rec.aimein_run['status'], 'stale')

    async def test_new_addon_during_planning_cannot_be_silently_consumed(self):
        original = self.bridge._loop_run_agent
        async def agent(*args, **kwargs):
            result = await original(*args, **kwargs)
            if args[2] == 'aimein-plan':
                self.state.addons.append(SimpleNamespace(id='new', text='Additional requirement', images=[], status='pending'))
            return result
        self.bridge._loop_run_agent = agent
        rec = await self.run_attempt()
        self.bridge._loop_do_execute.assert_not_called()
        self.assertEqual(rec.aimein_run['status'], 'stale')

    async def test_policy_rpc_reports_disk_failure_and_waits_for_save(self):
        self.session.loop_execution_mode = 'aimein'
        self.bridge._ensure_kit_scheduler = Mock()
        self.bridge._authorize_rpc = Mock()
        self.bridge._loop_control_reserved = lambda *_: False
        flush = AsyncMock(side_effect=OSError('fixture disk failure'))
        self.bridge._loop_control_writes = {self.session.id: SimpleNamespace(flush=flush)}
        response = json.loads(await self.bridge._dispatch('loopSetPolicy', [self.session.id, '{}']))
        self.assertEqual(response['status'], 'error')
        flush.assert_awaited_once()
        flush.side_effect = None
        response = json.loads(await self.bridge._dispatch('loopSetPolicy', [self.session.id, '{}']))
        self.assertEqual(response['status'], 'ok')
        self.assertFalse(self.calls)


if __name__ == '__main__': unittest.main()
