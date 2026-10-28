import asyncio
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.loop_openspec import (requested, select_change, manual_policy, task_progress,
                                      normalize_verify, next_phase, run_summary)
from src.backend.loop_store import LoopRecord, LoopState, STAGE_EXECUTE
from tests import test_loop_lifecycle as lifecycle
from tests.test_loop_continuation import bridge_fixture
from tests.test_loop_task_source import Project
import tempfile


def snapshot(done=False):
    return {'valid': True, 'change': 'example-change', 'cliState': 'all_done' if done else 'ready',
            'scopeDigest': 'scope', 'stateDigest': str(done),
            'tasks': [{'id': '1.1', 'done': done, 'description': '实现功能', 'sourcePath': 'tasks.md', 'line': 1},
                      {'id': '1.2', 'done': False, 'description': '人工验收页面', 'sourcePath': 'tasks.md', 'line': 2}]}


class DriverModelTests(unittest.TestCase):
    def test_source_request_excludes_explicit_negation_but_not_binding(self):
        for goal in ('普通实现', '无需 OpenSpec 来源', '不要使用 OpenSpec',
                     '无需历史存档基线、外部工具或 OpenSpec 来源。',
                     'Implement without OpenSpec', 'OpenSpec is not required',
                     '使用 OpenSpec。现在不用 OpenSpec'):
            state = LoopState('s', goal=goal)
            self.assertFalse(requested(state), goal)
            state.task_source = {'binding': {'change': 'keep'}}
            self.assertTrue(requested(state), goal)
        for goal in ('使用 OpenSpec', '/opsx:apply example', '不要跳过 OpenSpec',
                     "don't skip OpenSpec", '不用 OpenSpec。现在使用 OpenSpec',
                     '不要删除项目，使用 OpenSpec', '不要修改代码而是使用 OpenSpec',
                     '不需要重新安装 OpenSpec', '不要删除 OpenSpec'):
            self.assertTrue(requested(LoopState('s', goal=goal)), goal)

    def test_selection_is_explicit_or_unique_not_latest(self):
        candidates = [{'name': 'first'}, {'name': 'second'}]
        self.assertEqual(select_change('openspec first', candidates), 'first')
        self.assertEqual(select_change('继续 openspec', candidates, 'second'), 'second')
        self.assertEqual(select_change('openspec', candidates[:1]), 'first')
        for text in ('openspec', 'openspec first second', '/openspec-apply-change absent'):
            with self.assertRaises(ValueError):
                select_change(text, candidates)
        with self.assertRaises(ValueError):
            select_change('/openspec-apply-change absent', candidates[:1])
        with self.assertRaises(ValueError):
            select_change('/openspec-apply-change absent', candidates, 'first')

    def test_manual_exclusion_needs_explicit_user_disposition(self):
        self.assertTrue(manual_policy('那些人工验收的不管它'))
        self.assertTrue(manual_policy('跳过人工验收'))
        self.assertFalse(manual_policy('执行人工验收，Access denied'))
        for text in ('不要跳过人工验收', '人工验收不能忽略', "don't skip manual acceptance", '跳过人工验收。恢复人工验收'):
            self.assertFalse(manual_policy(text), text)
        self.assertTrue(manual_policy('必须执行人工验收。现在跳过人工验收'))
        self.assertEqual(task_progress(snapshot(), False)['pendingIds'], ['1.1', '1.2'])
        progress = task_progress(snapshot(True), True)
        self.assertEqual(progress['manualIds'], ['1.2'])
        self.assertEqual(progress['checked'], 1)
        self.assertEqual(progress['pendingIds'], [])
        mixed = snapshot()
        mixed['tasks'][0]['description'] = '实现功能并进行人工验收'
        self.assertIn('1.1', task_progress(mixed, True)['pendingIds'])

    def test_verify_critical_warning_suggestion_and_manual(self):
        issues = [dict(severity=s, summary=s, evidence='file:1', requiresFix=False) for s in ('critical', 'warning', 'suggestion')]
        issues += [dict(severity='critical', summary='人工未验', evidence='tasks.md', kind='manual', taskIds=['1.2']),
                   dict(severity='critical', summary='不能伪装人工', evidence='file:2', kind='manual', taskIds=['1.1'])]
        result = normalize_verify({'complete': True, 'issues': issues}, ['1.2'])
        self.assertTrue(result['valid'])
        self.assertEqual(result['remaining'], 2)
        self.assertTrue(result['issues'][3]['manual'])
        self.assertTrue(normalize_verify({'complete': True, 'issues': []}, [])['valid'])
        for raw in ({}, {'complete': False, 'issues': []}, {'complete': True, 'issues': [{}]}):
            self.assertFalse(normalize_verify(raw, [])['valid'])

    def test_phase_and_bounded_persistence(self):
        progress = task_progress(snapshot(True), True)
        previous = dict(phase='verify', verify={'valid': True, 'remaining': 1}, intentDigest='intent', progress=progress)
        self.assertEqual(next_phase(progress, previous, 'intent'), 'repair')
        self.assertEqual(next_phase(progress, previous, 'changed'), 'verify')
        self.assertEqual(next_phase(task_progress(snapshot(), True), previous, 'intent'), 'apply')
        rec = LoopRecord(1, openspec_run=previous)
        self.assertEqual(LoopRecord.from_dict(rec.to_dict()).openspec_run, previous)
        self.assertNotIn('issues', run_summary(previous))
        self.assertEqual(LoopRecord.from_dict({'seq': 1}).openspec_run, {})


class DriverIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Project(self.tmp.name)
        self.state = LoopState('s', stage=STAGE_EXECUTE, goal='按 OpenSpec test-change 完成任务；跳过人工验收', auto=True)
        self.bridge, self.session = bridge_fixture(self.state, self.project)
        self.record = LoopRecord(1, outcome_version=1)
        self.state.loops = [self.record]

    async def test_source_auto_select_and_same_change_update_without_confirmation(self):
        self.assertTrue(await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare'))
        self.assertEqual(self.state.task_source['binding']['change'], 'test-change')
        before = self.state.task_source['scopeRevision']
        self.project.tasks.write_text('- [ ] 1.1 Changed acceptance\n', encoding='utf-8')
        self.assertTrue(await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'after'))
        self.assertEqual(self.state.task_source['status'], 'current')
        self.assertGreater(self.state.task_source['scopeRevision'], before)
        self.assertTrue(self.state.task_source['history'][-1]['diff'])

    async def test_source_rejects_wrong_environment_and_workflow_blocked(self):
        self.assertTrue(await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare'))
        self.bridge._loop_source_environment = lambda *_: ({**self.project.binding(), 'workspace': 'other'}, {})
        self.assertFalse(await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'after'))
        self.assertEqual(self.state.task_source['code'], 'environment_changed')
        self.assertFalse(self.state.auto)

    async def test_cli_blocked_and_missing_source_never_run_model(self):
        self.bridge._loop_run_agent = AsyncMock()
        reader = self.bridge._loop_task_reader
        reader.read = AsyncMock(side_effect=[{'candidates': [{'name': 'test-change'}]},
            {**self.project.snapshot(), 'cliState': 'blocked', 'instruction': 'tasks missing'}])
        self.assertFalse(await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare'))
        self.assertEqual(self.state.task_source['status'], 'blocked')
        self.assertIn('tasks missing', self.state.task_source['reason'])
        reader.read = AsyncMock(return_value={'candidates': []})
        self.assertFalse(await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare'))
        self.assertEqual(self.state.task_source['binding']['change'], 'test-change')
        self.bridge._loop_run_agent.assert_not_called()

    async def test_manual_task_remains_unchecked_and_suggestion_finishes_auto_scope(self):
        self.project.tasks.write_text('- [x] 1.1 实现功能\n- [ ] 1.2 人工验收页面\n', encoding='utf-8')
        await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare')
        report = {'complete': True, 'issues': [{'severity': 'critical', 'kind': 'manual',
            'taskIds': ['1.2'], 'summary': '人工未验收', 'evidence': 'tasks.md:2'}]}
        self.bridge._loop_run_agent = AsyncMock(return_value=(json.dumps({'openspecVerify': report}), ''))
        await self.bridge._loop_openspec_iteration(self.session, self.state, self.record)
        self.assertEqual(self.record.openspec_run['phase'], 'verify')
        self.assertEqual(self.record.openspec_run['progress']['manualIds'], ['1.2'])
        self.assertIn('- [ ] 1.2', self.project.tasks.read_text(encoding='utf-8'))
        self.assertEqual(self.bridge._loop_reduce(self.state, self.record)['action'], 'complete')
        self.assertIn('人工', self.state.stop_reason)

    async def test_old_contract_pause_can_execute_but_active_repair_cannot(self):
        self.state.loops = [LoopRecord(1, terminal_kind='paused', contract_required=True)]
        self.bridge._loop_contract_pending = Mock(return_value=True)
        self.state.progress_guard = {'pause': True, 'reasonCode': 'task_contract_invalid'}
        self.bridge._loop_run_agent = AsyncMock(return_value=('本轮未完成全部任务', ''))
        await self.bridge._run_loop_iteration('s')
        self.assertEqual(self.bridge._loop_run_agent.await_count, 1)
        self.assertEqual(self.state.loops[-1].openspec_run['phase'], 'apply')
        self.bridge._loop_control_reserved = Mock(return_value=True)
        await self.bridge._run_loop_iteration('s')
        self.assertEqual(self.bridge._loop_run_agent.await_count, 1)

    async def test_budget_stop_goal_change_and_failure_do_not_pass(self):
        self.state.loops = []
        self.state.policy.max_loops = 1
        self.bridge._loop_run_agent = AsyncMock(return_value=('只做了一部分', ''))
        await self.bridge._run_loop_iteration('s')
        self.assertNotEqual(self.state.loops[-1].decision['action'], 'complete')
        self.bridge._schedule_loop_iteration.assert_not_called()
        self.state.policy.max_loops = 10
        self.state.stage = STAGE_EXECUTE
        self.state.auto = True
        self.bridge._loop_run_agent = AsyncMock(side_effect=RuntimeError('fake backend failed'))
        await self.bridge._run_loop_iteration('s')
        self.assertFalse(self.state.loops[-1].completed)
        self.assertEqual(self.state.loops[-1].terminal_kind, 'failed')
        async def changed(*args, **kwargs):
            self.state.goal = '更改目标'
            return '没有假通过', ''
        self.bridge._loop_run_agent = AsyncMock(side_effect=changed)
        await self.bridge._run_loop_iteration('s')
        self.assertFalse(self.state.loops[-1].completed)
        self.assertEqual(self.state.loops[-1].decision['reasonCode'], 'execution_changed')

    async def test_late_addon_remains_pending_and_blocks_completion(self):
        from src.backend.loop_store import Addon
        self.project.tasks.write_text('- [x] 1.1 已完成\n', encoding='utf-8')
        await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare')
        async def verify(*args, **kwargs):
            self.state.addons.append(Addon(id='new', text='增加一个自动测试'))
            return json.dumps({'openspecVerify': {'complete': True, 'issues': []}}), ''
        self.bridge._loop_run_agent = AsyncMock(side_effect=verify)
        await self.bridge._loop_openspec_iteration(self.session, self.state, self.record)
        self.assertEqual(self.state.addons[-1].status, 'pending')
        self.assertNotEqual(self.bridge._loop_reduce(self.state, self.record)['action'], 'complete')

    async def test_risk_and_repeated_no_progress_have_a_terminal_pause(self):
        self.state.loops = []
        self.bridge._loop_run_agent = AsyncMock(return_value=('仅输出，未勾选任何任务', ''))
        for _ in range(self.state.policy.progress_patience):
            await self.bridge._run_loop_iteration('s')
        self.assertFalse(self.state.auto)
        self.assertTrue(self.state.progress_guard['pause'])
        self.assertNotEqual(self.state.loops[-1].decision['action'], 'complete')
        self.state.risk_coefficient = 1.0
        self.bridge._loop_run_agent.reset_mock()
        await self.bridge._run_loop_iteration('s')
        self.bridge._loop_run_agent.assert_not_called()
        self.assertEqual(self.state.loops[-1].decision['reasonCode'], 'risk_limit')

    def test_auto_can_be_enabled_during_owned_run_but_not_unknown_call(self):
        self.bridge._loop_running.add('s')
        self.bridge._loop_active_backends['s:loop1:execute'] = Mock()
        self.assertEqual(json.loads(self.bridge._rpc_loopSetAuto('s', True))['status'], 'ok')
        self.bridge._schedule_loop_iteration.assert_not_called()
        self.bridge._loop_running.clear()
        self.assertEqual(json.loads(self.bridge._rpc_loopSetAuto('s', True))['status'], 'error')

    def test_compact_summary_preserves_full_verify_audit_without_broadcasting_it(self):
        self.record.openspec_run = {'change': 'test-change', 'phase': 'verify', 'verify': {'valid': True, 'remaining': 1,
            'issues': [{'summary': 'private-audit' * 1000}]}}
        full = copy.deepcopy(self.record.openspec_run)
        payload = self.bridge._loop_payload(self.state, compact=True)
        self.assertEqual(payload['loops'][0]['openspecSummary']['fixes'], 1)
        self.assertNotIn('private-audit', json.dumps(payload))
        self.assertEqual(self.record.openspec_run, full)

    async def test_apply_reads_actual_tasks_without_model_task_plan(self):
        await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare')
        async def apply(*args, **kwargs):
            self.assertEqual(kwargs['execution_access'], 'workspace-write')
            self.assertIn('openspec-apply-change', args[1])
            self.project.tasks.write_text('- [x] 1.1 Build login shell and verify behavior\n- [x] 1.2 Attributes and skills\n', encoding='utf-8')
            return '任务已完成，无 taskPlan JSON', ''
        self.bridge._loop_run_agent = AsyncMock(side_effect=apply)
        await self.bridge._loop_openspec_iteration(self.session, self.state, self.record)
        self.assertTrue(self.record.completed)
        self.assertFalse(self.record.task_plan)
        self.assertEqual(self.record.openspec_run['progress']['checked'], 2)
        decision = self.bridge._loop_reduce(self.state, self.record)
        self.assertEqual(decision['action'], 'continue')

    async def test_verify_fix_verify_completion_and_suggestions(self):
        self.project.tasks.write_text('- [x] 1.1 Build login shell and verify behavior\n- [x] 1.2 Attributes and skills\n', encoding='utf-8')
        await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare')
        replies = [dict(complete=True, issues=[dict(severity='critical', summary='bug', evidence='app:3')]),
                   None, dict(complete=True, issues=[dict(severity='suggestion', summary='nice', evidence='app:4')])]
        phases = []
        for seq, reply in enumerate(replies, 1):
            record = self.record if seq == 1 else LoopRecord(seq, outcome_version=1)
            if seq != 1:
                self.state.loops.append(record)
            self.bridge._loop_run_agent = AsyncMock(return_value=(json.dumps({'openspecVerify': reply}) if reply else 'fixed', ''))
            await self.bridge._loop_openspec_source(self.session, self.state, record, 'prepare')
            await self.bridge._loop_openspec_iteration(self.session, self.state, record)
            phases.append(record.openspec_run['phase'])
            decision = self.bridge._loop_reduce(self.state, record)
            self.assertEqual(decision['action'], 'complete' if seq == 3 else 'continue')
        self.assertEqual(phases, ['verify', 'repair', 'verify'])
        self.assertEqual(self.state.status, 'output')

    async def test_unknown_verify_and_real_blocker_never_pass(self):
        self.project.tasks.write_text('- [x] 1.1 Build login shell and verify behavior\n- [x] 1.2 Attributes and skills\n', encoding='utf-8')
        await self.bridge._loop_openspec_source(self.session, self.state, self.record, 'prepare')
        self.bridge._loop_run_agent = AsyncMock(return_value=('looks good', ''))
        await self.bridge._loop_openspec_iteration(self.session, self.state, self.record)
        self.assertFalse(self.record.completed)
        self.assertEqual(self.record.decision['reasonCode'], 'verify_incomplete')
        self.state.unresolved_blockers = {'valid': True, 'items': [{'id': 'permission'}]}
        self.bridge._loop_run_agent.reset_mock()
        await self.bridge._loop_openspec_iteration(self.session, self.state, LoopRecord(2))
        self.bridge._loop_run_agent.assert_not_called()


if __name__ == '__main__':
    unittest.main()
