import asyncio
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import LoopState, LoopRecord, LoopStep, LoopAnalysis, STAGE_EXECUTE
from src.backend.loop_task_source import SourceError, TaskSourceReader, reconcile
from src.backend.loop_delivery import assess_progress, completion_ready, scope_key
from src.backend.loop_milestones import register_plan, review_milestones
from tests import test_loop_lifecycle as lifecycle
from tests.test_loop_task_source import Project
from tests.test_loop_delivery import report


def bridge_fixture(state, project):
    bridge, session = lifecycle.LoopLifecycleTests._bridge(state)
    session.working_dir, session.backend_id, session.session_type, session.owner_id = str(project.root), 'b', 'loop', 'local'
    session.messages = []
    bridge._backend_configs = [SimpleNamespace(id='b')]
    bridge._runtime_label = lambda *_: 'fixture'
    bridge._resolved_runtime = lambda *_: {}
    bridge._loop_runtime = lambda *_: {}
    bridge._backend_label = lambda *_: 'fixture'
    bridge._model_ledger = Mock()
    bridge._emit_loop_progress = Mock()
    bridge._loop_progress_for_record = lambda *_: {}
    binding = project.binding()
    bridge._loop_source_environment = lambda *_: (binding, {})
    async def runner(cli, args, cwd, env):
        if args == ['--version']:
            return '1.13.1'
        if args == ['list', '--json']:
            return json.dumps({'root': {'path': str(project.root)}, 'changes': [{'name': 'test-change'}]})
        return json.dumps(project.payloads()[0 if args[0] == 'status' else 1])
    bridge._loop_task_reader = TaskSourceReader(runner)
    bridge._schedule_loop_iteration = Mock(return_value=True)
    return bridge, session


class ContinuationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Project(self.tmp.name)
        self.state = LoopState('s', stage=STAGE_EXECUTE, goal='deliver', auto=True)
        self.state.policy.intent_guard = False
        self.bridge, self.session = bridge_fixture(self.state, self.project)

    async def bind(self):
        discovery = json.loads(await self.bridge._rpc_loopTaskSourceDiscover('s'))
        self.assertEqual(discovery['status'], 'ok')
        self.assertFalse(self.state.task_source)
        result = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'bind', 0, 'fixture-node', 'test-change', discovery['discoveryId']))
        self.assertEqual(result['status'], 'ok')
        self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_explicit_single_choice_revision_node_and_omitted_policy(self):
        self.state.auto = False
        await self.bind()
        before = copy.deepcopy(self.state.task_source)
        for revision, executor in [(0, 'fixture-node'), (1, 'other-node')]:
            result = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'refresh', revision, executor))
            self.assertEqual(result['status'], 'error')
        self.bridge._rpc_loopSetPolicy('s', '{}')
        self.assertEqual(self.state.task_source, before)
        self.assertFalse(self.state.auto)
        self.state.loops.append(LoopRecord(1))
        result = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'unbind', 1, 'fixture-node', disposition='explicit'))
        self.assertEqual(result['code'], 'resumable')

    async def test_source_failure_keeps_snapshot_pauses_without_backend_error(self):
        await self.bind()
        old = copy.deepcopy(self.state.task_source['snapshot'])
        record = LoopRecord(1, outcome_version=1)
        self.state.loops.append(record)
        self.bridge._loop_task_reader.read = AsyncMock(side_effect=SourceError('timeout', 'fixture unavailable'))
        self.assertFalse(await self.bridge._loop_check_source(self.session, self.state, record, 'prepare', force=True))
        self.assertEqual(self.state.task_source['snapshot'], old)
        self.assertEqual(record.error, '')
        self.assertEqual(record.terminal_kind, 'paused')
        self.assertEqual(record.decision['reasonCode'], 'source_unavailable')
        self.assertFalse(self.bridge._loop_payload(self.state, compact=True)['resumable'])
        self.bridge._maybe_autocontinue('s')
        self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_cli_blocked_and_old_environment_never_allow_write(self):
        await self.bind()
        original = self.bridge._loop_task_reader.runner
        async def blocked(cli, args, cwd, env):
            if args[:2] == ['instructions', 'apply']:
                payload = self.project.payloads()[1]
                payload.update(state='blocked', instruction='Missing required artifact', missingArtifacts=['design'])
                return json.dumps(payload)
            return await original(cli, args, cwd, env)
        self.bridge._loop_task_reader = TaskSourceReader(blocked)
        rec = LoopRecord(1, outcome_version=1)
        self.state.loops.append(rec)
        self.assertFalse(await self.bridge._loop_check_source(self.session, self.state, rec, 'prepare', force=True))
        self.assertEqual(rec.decision['reasonCode'], 'workflow_blocked')
        self.assertEqual(self.state.task_source['status'], 'blocked')
        self.assertEqual(rec.error, '')
        binding = {**self.project.binding(), 'environmentDigest': 'changed-env'}
        self.bridge._loop_source_environment = lambda *_: (binding, {})
        self.assertFalse(await self.bridge._loop_check_source(self.session, self.state, rec, 'write:1'))
        self.assertEqual(self.state.task_source['code'], 'environment_changed')

    async def test_user_stop_authorization_no_progress_auto_and_budget_match_scheduler(self):
        for case in ('stop', 'authorization', 'idle', 'auto_off', 'budget'):
            with self.subTest(case=case):
                state = LoopState('s', stage=STAGE_EXECUTE, auto=case != 'auto_off')
                rec = LoopRecord(1, completed=True, outcome_version=1, terminal_kind='completed', delivery=report())
                state.loops = [rec]
                state.progress_guard = {'readyIds': ['1.1']}
                bridge, _ = bridge_fixture(state, self.project)
                if case == 'stop':
                    bridge._loop_pending_out.add('s')
                elif case == 'authorization':
                    rec.delivery['blockers'] = [dict(id='grant', kind='authorization', reason='new permission required', resolution='user grant')]
                elif case == 'idle':
                    state.progress_guard['noProgressCount'] = 3
                elif case == 'budget':
                    state.policy.max_loops = 1
                bridge._maybe_autocontinue('s')
                bridge._schedule_loop_iteration.assert_not_called()
                self.assertEqual(rec.decision['reasonCode'], {'stop': 'user_stop', 'authorization': 'authorization', 'idle': 'no_progress', 'auto_off': 'auto_off', 'budget': 'budget_exhausted'}[case])

    async def test_scope_drift_write_gate_confirmation_and_refresh(self):
        await self.bind()
        rec = LoopRecord(1, outcome_version=1)
        self.state.loops.append(rec)
        self.project.tasks.write_text('- [ ] 1.1 Changed acceptance\n', encoding='utf-8')
        self.assertFalse(await self.bridge._loop_check_source(self.session, self.state, rec, 'write:1'))
        self.assertEqual(self.state.task_source['status'], 'conflict')
        revision = self.state.task_source['revision']
        reply = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'confirm', revision, 'fixture-node', disposition='User narrows task; old losses still documented'))
        self.assertEqual(reply['status'], 'ok')
        self.assertEqual(self.state.task_source['scopeRevision'], 2)
        self.assertTrue(self.state.progress_guard['pause'])
        self.assertFalse(self.state.auto)
        self.assertTrue(self.state.task_source['history'][-1]['unresolved'])
        self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_refresh_and_confirm_reject_changed_environment_until_explicit_rebind(self):
        await self.bind()
        original = copy.deepcopy(self.state.task_source)
        base_binding = self.project.binding()
        original_runner = self.bridge._loop_task_reader.runner
        for action in ('refresh', 'confirm'):
            for field in ('backendId', 'environmentDigest', 'cli', 'cliVersion'):
                with self.subTest(action=action, field=field):
                    self.state.task_source = copy.deepcopy(original)
                    if action == 'confirm':
                        self.state.task_source.update(status='conflict', candidate=copy.deepcopy(original['snapshot']))
                    before = copy.deepcopy(self.state.task_source)
                    self.state.auto = False
                    self.state.progress_guard = {'pause': True, 'reasonCode': 'authorization', 'reason': 'unresolved grant'}
                    guard = copy.deepcopy(self.state.progress_guard)
                    binding = {**base_binding, **({field: 'changed-value'} if field != 'cliVersion' else {})}
                    self.bridge._loop_source_environment = lambda *_: (binding, {})
                    async def runner(cli, args, cwd, env):
                        if args == ['--version'] and field == 'cliVersion':
                            return '1.14.0'
                        return await original_runner(cli, args, cwd, env)
                    self.bridge._loop_task_reader = TaskSourceReader(runner)
                    reply = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', action, 1,
                        'fixture-node', disposition='Accept task scope, not a different environment'))
                    self.assertEqual(reply.get('code'), 'environment_changed')
                    self.assertEqual(self.state.task_source['status'], 'unavailable')
                    for key in ('binding', 'snapshot', 'history', 'revision', 'scopeRevision', 'candidate'):
                        self.assertEqual(self.state.task_source.get(key), before.get(key), key)
                    discovery = json.loads(await self.bridge._rpc_loopTaskSourceDiscover('s'))
                    self.assertEqual(discovery['status'], 'ok')
                    rebound = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'bind', 1, 'fixture-node',
                        'test-change', discovery['discoveryId'], 'Explicit rebind; unresolved grant still required'))
                    self.assertEqual(rebound['status'], 'ok')
                    for key, value in binding.items():
                        self.assertEqual(self.state.task_source['binding'][key], value)
                    self.assertEqual(self.state.task_source['binding']['cliVersion'], '1.14.0' if field == 'cliVersion' else '1.13.1')
                    self.assertEqual(self.state.task_source['scopeRevision'], 2)
                    self.assertEqual(self.state.task_source['history'][:-1], original['history'])
                    self.assertEqual(self.state.task_source['history'][-1]['unresolved'], guard)
                    self.assertEqual(self.state.progress_guard, guard)
                    self.assertFalse(self.state.auto)
                    self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_bind_rejects_cli_upgrade_since_discovery_and_accepts_fresh_discovery(self):
        original_runner = self.bridge._loop_task_reader.runner
        version = '1.13.1'
        async def runner(cli, args, cwd, env):
            if args == ['--version']:
                return version
            return await original_runner(cli, args, cwd, env)
        self.bridge._loop_task_reader = TaskSourceReader(runner)
        discovery = json.loads(await self.bridge._rpc_loopTaskSourceDiscover('s'))
        version = '1.14.0'
        rejected = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'bind', 0, 'fixture-node',
            'test-change', discovery['discoveryId']))
        self.assertEqual(rejected.get('code'), 'environment_changed')
        self.assertFalse(self.state.task_source)
        # 再次升级后重新发现，不能沿用前一次失败绑定所缓存的版本。
        version = '1.15.0'
        discovery = json.loads(await self.bridge._rpc_loopTaskSourceDiscover('s'))
        result = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'bind', 0, 'fixture-node',
            'test-change', discovery['discoveryId']))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.state.task_source['binding']['cliVersion'], version)
        self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_refresh_same_environment_updates_snapshot_without_rebinding(self):
        await self.bind()
        before = copy.deepcopy(self.state.task_source)
        self.project.tasks.write_text('- [x] 1.1 Build login shell and verify behavior\n'
                                      '- [ ] 1.2 Attributes and skills\n', encoding='utf-8')
        result = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'refresh', 1, 'fixture-node'))
        self.assertEqual(result['status'], 'ok')
        self.assertTrue(self.state.task_source['snapshot']['tasks'][0]['done'])
        self.assertEqual(self.state.task_source['binding'], before['binding'])
        self.assertEqual(self.state.task_source['scopeRevision'], before['scopeRevision'])
        self.assertEqual(self.state.task_source['history'], before['history'])
        self.assertTrue(self.state.auto)
        self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_explicit_refresh_rechecks_cli_after_failed_query_at_same_revision(self):
        await self.bind()
        before = copy.deepcopy(self.state.task_source)
        original_runner = self.bridge._loop_task_reader.runner
        version = '1.14.0'
        async def runner(cli, args, cwd, env):
            if args == ['--version']:
                return version
            return await original_runner(cli, args, cwd, env)
        self.bridge._loop_task_reader = TaskSourceReader(runner)
        result = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'refresh', 1, 'fixture-node'))
        self.assertEqual(result.get('code'), 'environment_changed')
        # 原环境已恢复，同一修订的显式核对必须重新查询，不能被失败查询的缓存锁住。
        version = '1.13.1'
        result = json.loads(await self.bridge._rpc_loopTaskSourceSet('s', 'refresh', 1, 'fixture-node'))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.state.task_source['binding'], before['binding'])
        self.assertEqual(self.state.task_source['scopeRevision'], before['scopeRevision'])
        self.bridge._schedule_loop_iteration.assert_not_called()

    async def test_late_discovery_environment_or_execution_change_is_not_adopted(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.bridge._loop_task_reader.runner
        async def slow(*args):
            entered.set()
            await release.wait()
            return await original(*args)
        self.bridge._loop_task_reader = TaskSourceReader(slow)
        task = asyncio.create_task(self.bridge._rpc_loopTaskSourceDiscover('s'))
        await entered.wait()
        self.bridge._loop_running.add('s')
        release.set()
        result = json.loads(await task)
        self.assertEqual(result['code'], 'busy')
        self.assertFalse(self.state.task_source)

    async def test_pause_resume_replans_dedup_and_unknown_old_call(self):
        rec = LoopRecord(1, outcome_version=1, sub_stage='execute')
        self.state.loops.append(rec)
        self.bridge._loop_pause_control(self.state, rec, '{"loopControl":{"pause":true}}')
        self.assertEqual(rec.decision['reasonCode'], 'unclassified_pause')
        self.assertEqual(rec.error, '')
        self.bridge._loop_active_backends['s:old'] = object()
        self.assertEqual(json.loads(self.bridge._rpc_loopRunIteration('s'))['status'], 'error')
        self.bridge._loop_active_backends.clear()
        self.assertEqual(json.loads(self.bridge._rpc_loopRunIteration('s'))['status'], 'ok')
        self.bridge._loop_do_prepare = AsyncMock()
        self.bridge._loop_do_execute = AsyncMock()
        async def finish(_s, _st, record):
            record.completed = True
        self.bridge._loop_do_analysis = finish
        with patch('src.backend.bridge_ws.git_snapshot', return_value='fixture'), patch('src.backend.bridge_ws.dir_snapshot', return_value=None):
            await self.bridge._run_loop_iteration('s')
        self.assertEqual(len(self.state.loops), 2)
        self.bridge._loop_do_prepare.assert_awaited_once()
        self.assertEqual(rec.terminal_kind, 'paused')
        latest = self.state.loops[-1]
        latest.delivery = report()
        self.state.progress_guard = assess_progress([latest])
        self.state.auto = True
        latest.progress_version = 2
        self.state.progress_guard['readyIds'] = ['1.1']
        self.bridge._schedule_loop_iteration.reset_mock()
        self.bridge._maybe_autocontinue('s')
        self.bridge._maybe_autocontinue('s')
        self.bridge._schedule_loop_iteration.assert_called_once()

    async def test_complete_on_last_budget_and_manual_handoff_not_checkbox_acceptance(self):
        self.state.policy.max_loops = 1
        self.state.policy.independent_eval = False
        rec = LoopRecord(1, outcome_version=1, completed=True, terminal_kind='completed',
            delivery=report('verified'), analysis=LoopAnalysis(score=95, outputtable=True, optimization_potential=.01))
        self.state.loops.append(rec)
        self.assertEqual(self.bridge._loop_reduce(self.state, rec)['action'], 'complete')
        rec.delivery = report(items=[dict(id='1.1', status='manual', manualBasis='User requests hardware acceptance')])
        self.state.stage = STAGE_EXECUTE
        self.assertEqual(self.bridge._loop_reduce(self.state, rec)['completionScope'], 'automatic')

    async def test_auto_pause_between_scheduling_and_coroutine_entry_starts_no_work(self):
        self.bridge._loop_do_prepare = AsyncMock()
        self.state.auto = False
        await self.bridge._run_loop_iteration('s', auto_required=True, decision_id='stale')
        self.assertEqual(self.state.loops, [])
        self.bridge._loop_do_prepare.assert_not_awaited()
        self.state.loops = [LoopRecord(1, outcome_version=1, terminal_kind='paused')]
        self.state.policy.max_loops = 1
        await self.bridge._run_loop_iteration('s')
        self.assertEqual(len(self.state.loops), 1)
        self.bridge._loop_do_prepare.assert_not_awaited()

    async def test_invalid_mode_or_source_cannot_leave_verified_task_result(self):
        await self.bind()
        for case in ('mode', 'source', 'missing_task'):
            with self.subTest(case=case):
                self.state.policy.work_mode = 'delivery'
                candidate = report('verified', mode='explore' if case == 'mode' else 'delivery',
                    source='other-change' if case == 'source' else 'openspec/changes/test-change/tasks.md',
                    items=[dict(id=t['id'], status='verified', evidence='fixture evidence')
                           for t in self.state.task_source['snapshot']['tasks']])
                if case == 'missing_task':
                    candidate['items'].pop()
                rec = LoopRecord(len(self.state.loops) + 1, outcome_version=1, progress_version=2,
                                 task_result='verified')
                self.state.loops.append(rec)
                self.bridge._loop_run_agent = AsyncMock(return_value=(json.dumps({
                    'score': 99, 'optimizationPotential': 0, 'delivery': candidate}), None))
                with patch('src.backend.bridge_ws.git_snapshot', return_value='fixture'):
                    await self.bridge._loop_do_analysis(self.session, self.state, rec)
                self.assertFalse(rec.delivery['valid'])
                self.assertEqual(rec.task_result, 'unknown')
                self.assertFalse(rec.analysis.outputtable)
                self.assertEqual(self.state.progress_guard['noProgressCount'], len(self.state.loops))

    async def test_degraded_execution_preserves_children_and_cannot_false_complete(self):
        for reviewed in (False, True):
            with self.subTest(reviewed=reviewed):
                state = LoopState('s', stage=STAGE_EXECUTE, goal='deliver', auto=True)
                state.policy.intent_guard = False
                bridge, session = bridge_fixture(state, self.project)
                scope = scope_key(state.goal)
                plan = register_plan({'milestones': [{'id': 'shell', 'parentId': '1.1',
                    'originRef': '1.1', 'acceptance': 'login shell', 'deliverable': 'operable shell',
                    'status': 'pending'}]}, [{'id': '1.1', 'description': 'Build login shell'}],
                    scope, 1, session.working_dir)
                prior = LoopRecord(1, progress_version=2, progress_scope=scope, completed=True,
                    milestone_plan=plan, delivery=report(), analysis=LoopAnalysis(score=60))
                if reviewed:
                    prior.delivery['milestoneReview'] = review_milestones([], plan, session.working_dir,
                        bridge._loop_evidence_environment(session, prior))
                record = LoopRecord(2, outcome_version=1, progress_version=2, progress_scope=scope)
                state.loops = [prior, record]
                async def model(_session, _prompt, sub_stage, seq, **kwargs):
                    if sub_stage == 'analysis':
                        return json.dumps({'score': 99, 'optimizationPotential': 0,
                                           'delivery': report('verified')}), None
                    return 'No valid plan; diagnostic only.', None
                bridge._loop_run_agent = model
                await bridge._loop_do_execute(session, state, record)
                with patch('src.backend.bridge_ws.git_snapshot', return_value='fixture'):
                    await bridge._loop_do_analysis(session, state, record)
                self.assertFalse(completion_ready(record.delivery))
                self.assertEqual(record.stage_details['prepare']['status'], 'degraded')
                self.assertEqual([m['id'] for m in record.milestone_plan['milestones']], ['shell'])
                self.assertEqual(record.orchestration[0].access, 'read')
                self.assertFalse(record.analysis.outputtable)
                self.assertNotEqual(record.decision['action'], 'complete')
                self.assertEqual(state.stage, STAGE_EXECUTE)

    async def test_full_25_task_replay_keeps_two_checked_and_continues_ready_batch(self):
        p = self.project
        descriptions = ['Bootstrap workspace', 'Load data', 'Build login shell and verify behavior', 'Attributes and skills'] + [f'Acceptance task {i}' for i in range(5, 26)]
        p.tasks.write_text(''.join(f'- [{"x" if i < 3 else " "}] 1.{i} {text}\n' for i, text in enumerate(descriptions, 1)), encoding='utf-8')
        await self.bind()
        chosen = []
        async def model(session, prompt, sub_stage, seq, **kwargs):
            if sub_stage == 'prepare':
                task = '1.3 login shell' if seq == 1 else '1.4 Attributes and skills'
                chosen.append(task)
                return json.dumps({'goal': task, 'orchestration': [{'desc': task, 'mode': 'sequential', 'access': 'write'}],
                    'milestonePlan': {'milestones': [{'id': 'shell', 'parentId': '1.3', 'originRef': '1.3',
                        'acceptance': 'login shell', 'deliverable': 'operable shell', 'status': 'pending'}]}}), None
            if sub_stage.startswith('step'):
                (p.root / 'shell.py').write_text('stable shell', encoding='utf-8')
                return 'Local batch finished; overall acceptance remains incomplete.', 'thread'
            items = [dict(id=f'1.{i}', title=text, status='verified' if i < 3 else 'pending', evidence='fixture baseline' if i < 3 else '', dependsOn=[]) for i, text in enumerate(descriptions, 1)]
            raw = dict(mode='delivery', source='openspec/changes/test-change/tasks.md', scopeComplete=True, items=items, blockers=[], verification={})
            raw['milestones'] = [{'id': 'shell', 'status': 'implemented', 'mappingConfirmed': True, 'evidenceRefs': [{
                'path': 'shell.py', 'fingerprint': hashlib.sha256((p.root / 'shell.py').read_bytes()).hexdigest(),
                'environment': self.bridge._loop_evidence_environment(self.session, self.state.loops[-1]), 'command': 'fixture isolated test', 'result': 'passed'}]}]
            return json.dumps({'score': 65, 'optimizationPotential': .8, 'delivery': raw}), None
        self.bridge._loop_run_agent = model
        with patch('src.backend.bridge_ws.git_snapshot', return_value='fixture'):
            for _ in range(3):
                await self.bridge._run_loop_iteration('s')
        self.assertEqual(chosen, ['1.3 login shell', '1.4 Attributes and skills', '1.4 Attributes and skills'])
        first, second, third = self.state.loops
        self.assertEqual(first.delivery['milestoneSummary']['credited'], ['shell'])
        self.assertEqual(second.delivery['milestoneSummary']['credited'], [])
        self.assertEqual(third.delivery['milestoneSummary']['credited'], [])
        self.assertEqual(self.state.progress_guard['noProgressCount'], 2)
        for rec in self.state.loops:
            self.assertEqual(rec.delivery['reconciliation']['checked'], 2)
            self.assertEqual(rec.delivery['reconciliation']['total'], 25)
            self.assertFalse(completion_ready(rec.delivery))
            self.assertIn(rec.decision['action'], ('continue', 'replan'))
            self.assertEqual(rec.orchestration[0].call_result, 'normal')
            self.assertEqual(rec.orchestration[0].task_result, 'unknown')
        self.assertTrue(self.state.auto)
        self.assertEqual(self.bridge._schedule_loop_iteration.call_count, 3)
        compact = self.bridge._loop_payload(self.state, compact=True)
        self.assertNotIn('snapshot', compact['taskSource'])
        self.assertEqual(compact['loops'][-1]['sourceSnapshots'], {})
        self.assertEqual(compact['loops'][-1]['milestonePlan'], {})
        self.assertNotIn('stable shell', json.dumps(compact))


if __name__ == '__main__':
    unittest.main()
