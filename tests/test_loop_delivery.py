import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS, _LoopAgentCallError
from src.backend.base import StreamDelta
from src.backend.loop_delivery import (
    assess_progress, completion_ready, evidence_packet, handoff_from_session,
    normalize_report, planning_context, call_scope_constraints,
)
from src.backend.loop_store import (
    DEFAULT_STRATEGY, LEGACY_INCREMENTAL_STRATEGY, LoopPolicy, LoopState, LoopRecord,
    LoopStep, LoopAnalysis, SUB_EXECUTE, SUB_ANALYSIS,
)
from src.types import ChatMessage, Session, BackendType, ModelBackendConfig
from src.backend.codex_office import CodexOfficeBackend
from tests import test_loop_evolution as evolution, test_loop_diagnostics as diagnostics, test_codex_remote as remote


def report(status='pending', **overrides):
    raw = dict(mode='delivery', source='spec/tasks.md', scopeComplete=True,
               items=[dict(id='1.1', title='登录', status=status, dependsOn=[], evidence='src/login.py@abc; test login: passed; isolated home')],
               blockers=[], verification=dict(status='passed', evidence='verify: all passed at abc'))
    raw.update(overrides)
    return normalize_report(raw)


def record(seq, status='pending', **kw):
    return LoopRecord(seq=seq, completed=True, progress_version=1, delivery=report(status, **kw))


class DeliveryTests(unittest.TestCase):
    def test_read_only_planning_is_not_a_global_permission_blocker(self):
        for stage in ('prepare', 'intent'):
            text = call_scope_constraints(stage, 'read-only', native_codex=True)
            self.assertIn('请求原生沙箱 read-only', text)
            self.assertIn('当前只负责只读核实并产出计划', text)
            self.assertIn('不得仅因当前规划调用只读就返回全局 pause', text)
            self.assertIn('access=write、mode=sequential', text)
            self.assertIn('不能绕过拒绝', text)
            self.assertIn('真实全局、安全或授权阻塞仍需暂停', text)

    def test_non_codex_scope_is_advisory_and_never_promises_native_isolation(self):
        text = call_scope_constraints('step1', 'workspace-write', native_codex=False)
        self.assertIn('未接入同等原生沙箱', text)
        self.assertNotIn('本次 Codex 调用请求原生沙箱', text)
        self.assertNotIn('当前只负责只读核实并产出计划', text)
        self.assertIn('不自动豁免历史损失或验收', text)

    def test_completion_requires_evidence_scope_verify_and_no_blockers(self):
        self.assertTrue(completion_ready(report('verified')))
        for candidate in [report('pending'), report('implemented'), report('verified', scopeComplete=False),
                          report('verified', source=''), report('verified', verification={}),
                          report('verified', blockers=[dict(id='b', kind='local', reason='未验收')]),
                          report(items=[]), report(items=[dict(id='1', status='verified')]),
                          report(items=[dict(id='1', status='manual')])]:
            self.assertFalse(completion_ready(candidate), candidate)

    def test_manual_exemption_requires_explicit_basis(self):
        candidate = report(items=[dict(id='1', status='manual', manualBasis='用户要求实机人工验收')])
        self.assertTrue(completion_ready(candidate))

    def test_invalid_duplicate_missing_or_cyclic_dependencies_fail_closed(self):
        for items in [[dict(id='a', status='verified', evidence='x')]*2,
                      [dict(id='a', status='verified', evidence='x', dependsOn=['missing'])],
                      [dict(id='a', status='verified', evidence='x', dependsOn=['b']),
                       dict(id='b', status='verified', evidence='y', dependsOn=['a'])],
                      [dict(id=str(i), status='verified', evidence='x') for i in range(101)]]:
            self.assertFalse(completion_ready(report(items=items)))
        self.assertEqual(normalize_report('no report'), {})
        self.assertFalse(report('verified', blockers='invalid')['valid'])

    def test_reworded_evidence_and_scores_are_not_task_progress(self):
        records = [record(i) for i in range(1, 5)]
        for index, rec in enumerate(records):
            rec.analysis = LoopAnalysis(score=40+index*10)
            rec.delivery['items'][0]['evidence'] += str(index)
        guard = assess_progress(records)
        self.assertEqual(guard['noProgressCount'], 3)
        self.assertTrue(guard['pause'])
        records.append(record(5, 'implemented'))
        self.assertEqual(assess_progress(records)['noProgressCount'], 0)
        self.assertFalse(assess_progress(records)['pause'])

    def test_old_records_are_unknown_not_retroactively_stuck(self):
        self.assertFalse(assess_progress([LoopRecord(seq=i, completed=True) for i in range(10)])['pause'])
        records = [LoopRecord(seq=i, completed=True, progress_version=1) for i in range(3)]
        self.assertTrue(assess_progress(records)['pause'])

    def test_first_valid_report_after_missing_reports_establishes_baseline(self):
        records = [LoopRecord(seq=i, completed=True, progress_version=1) for i in range(2)]
        records.append(record(3, verification={}))
        self.assertEqual(assess_progress(records)['noProgressCount'], 0)

    def test_overall_verification_advances_once_without_item_changes(self):
        records = [record(i, 'verified', verification={}) for i in range(1, 4)]
        records.append(record(4, 'verified'))
        self.assertEqual(assess_progress(records)['noProgressCount'], 0)
        self.assertFalse(assess_progress(records)['pause'])
        records.extend([record(5, 'verified', verification={}), record(6, 'verified')])
        self.assertEqual(assess_progress(records)['noProgressCount'], 2)

    def test_local_blockers_do_not_block_independent_work(self):
        items = [dict(id='a', status='blocked'), dict(id='b', status='pending'),
                 dict(id='c', status='pending', dependsOn=['a'])]
        rec = record(1, items=items, blockers=[dict(id='block', kind='local', affected=['a'], reason='missing fixture')])
        guard = assess_progress([rec])
        self.assertEqual(guard['readyIds'], ['b'])
        self.assertFalse(guard['pause'])

    def test_global_safety_and_unavoidable_human_blockers_pause(self):
        for kind in ('global', 'safety', 'human'):
            rec = record(1, 'blocked', blockers=[dict(id='b', kind=kind, affected=['1.1'], reason='need isolation')])
            self.assertTrue(assess_progress([rec])['pause'])

    def test_deleted_tasks_and_changed_source_cannot_fake_completion(self):
        first = record(1)
        second = record(2, items=[dict(id='replacement', status='verified', evidence='proof')])
        self.assertTrue(assess_progress([first, second])['scopeLost'])
        self.assertTrue(assess_progress([first, record(2, 'verified', source='different.md')])['scopeLost'])
        self.assertTrue(assess_progress([first, record(2, 'verified', mode='explore')])['scopeLost'])

    def test_changed_goal_starts_new_progress_basis(self):
        records = [record(i) for i in range(1, 5)]
        records[-1].progress_scope = 'new-goal'
        self.assertEqual(assess_progress(records)['noProgressCount'], 0)
        self.assertFalse(assess_progress(records)['pause'])

    def test_handoff_is_bounded_redacted_and_has_no_tool_grants(self):
        session = Session(id='s', title='x', created_at=1, updated_at=1, working_dir='.', backend_id='executor', messages=[
            ChatMessage(id='a', role='user', content='【当前 Session 的 Kit 调用工具】 token=old-grant\n【用户本轮请求】继续 change x'),
            ChatMessage(id='b', role='assistant', content='password="private"\n已经完成 task 1'),
            ChatMessage(id='c', role='assistant', content='large' * 20000),
        ])
        handoff = handoff_from_session(session)
        serialized = json.dumps(handoff, ensure_ascii=False)
        self.assertIn('继续 change x', serialized)
        self.assertNotIn('old-grant', serialized)
        self.assertNotIn('private', serialized)
        self.assertLess(len(serialized), 14000)
        self.assertEqual(session.messages[0].content.count('old-grant'), 1)

    def test_evidence_keeps_late_failures_and_never_invents_missing_outputs(self):
        rec = LoopRecord(seq=1, orchestration=[LoopStep(index=1, output='header'+'x'*12000+'FAILED: real user file changed'), LoopStep(index=2)])
        packet = evidence_packet(rec)
        self.assertIn('FAILED: real user file changed', packet)
        self.assertIn('中段省略', packet)
        self.assertIn('无执行输出', packet)

    def test_policy_migration_preserves_custom_suffix_and_state_roundtrip(self):
        for old in (LEGACY_INCREMENTAL_STRATEGY, LEGACY_INCREMENTAL_STRATEGY.replace('**', '')):
            policy = LoopPolicy.from_dict(dict(strategy=old+'\n额外：不改协议', progressPatience=100, workMode='delivery'))
            self.assertTrue(policy.strategy.startswith(DEFAULT_STRATEGY))
            self.assertTrue(policy.strategy.endswith('额外：不改协议'))
            self.assertEqual(policy.progress_patience, 8)
        self.assertEqual(LoopPolicy.from_dict(dict(strategy='custom')).strategy, 'custom')
        state = LoopState(session_id='s', handoff={'source':'conversion'}, loops=[record(1)], progress_guard={'pause':True})
        restored = LoopState.from_dict(state.to_dict())
        self.assertEqual(restored.loops[0].delivery, state.loops[0].delivery)
        self.assertEqual(restored.progress_guard, state.progress_guard)

    def test_prompt_and_compact_payload_are_bounded(self):
        previous = record(1, items=[dict(id=str(i), status='pending', evidence='x'*2000) for i in range(100)])
        current = LoopRecord(seq=2)
        state = LoopState(session_id='s', loops=[previous,current], handoff={'messages':['secret reference']})
        self.assertLess(len(planning_context(state, current)), 38000)
        bridge = evolution.LoopEvolutionTests._bridge()
        bridge._loop_is_running = lambda _: False
        compact = bridge._loop_payload(state, compact=True)
        self.assertEqual(compact['loops'][0]['delivery'], {})
        self.assertNotIn('secret reference', json.dumps(compact))
        self.assertEqual(len(previous.delivery['items']), 100)


class DeliveryIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def bridge(self):
        bridge = evolution.LoopEvolutionTests._bridge()
        bridge._loop_cancel = {}
        bridge._model_ledger = SimpleNamespace(record=Mock())
        bridge._backend_label = lambda value: value
        bridge._recompute_risk = Mock()
        return bridge

    async def test_prepare_blocked_does_not_retry_or_execute(self):
        bridge = self.bridge()
        state = LoopState(session_id='s', auto=True, loops=[LoopRecord(seq=1)])
        session = SimpleNamespace(id='s', backend_id='executor')
        calls = []
        async def agent(*args, **kwargs):
            calls.append(args)
            return json.dumps(dict(loopControl=dict(pause=True, reason='OpenSpec workflow blocked'))), None
        bridge._loop_run_agent = agent
        await bridge._loop_do_prepare(session, state, state.loops[0], '')
        self.assertEqual(len(calls), 1)
        self.assertFalse(state.auto)
        self.assertTrue(state.progress_guard['pause'])
        self.assertEqual(state.loops[0].orchestration, [])

    async def test_step_safety_signal_skips_following_steps_and_summary(self):
        bridge = self.bridge()
        rec = LoopRecord(seq=1, sub_stage=SUB_EXECUTE, orchestration=[LoopStep(index=1, desc='test'), LoopStep(index=2, desc='write')])
        state = LoopState(session_id='s', auto=True, loops=[rec])
        calls = []
        async def agent(*args, **kwargs):
            calls.append(kwargs)
            return json.dumps(dict(loopControl=dict(pause=True, reason='用户数据未隔离'))), None
        bridge._loop_run_agent = agent
        await bridge._loop_do_execute(SimpleNamespace(id='s', backend_id='executor'), state, rec)
        self.assertEqual(len(calls), 1)
        self.assertTrue(state.progress_guard['pause'])
        self.assertEqual(rec.orchestration[1].status, 'pending')

    async def test_intent_safety_signal_pauses_before_execution(self):
        bridge = self.bridge()
        rec = LoopRecord(seq=1, sub_stage=SUB_EXECUTE)
        state = LoopState(session_id='s', auto=True, loops=[rec])
        async def agent(*args, **kwargs):
            return json.dumps(dict(loopControl=dict(pause=True, reason='missing required authorization'))), None
        bridge._loop_run_agent = agent
        await bridge._intent_check(SimpleNamespace(id='s', backend_id='executor'), state, rec)
        self.assertTrue(state.progress_guard['pause'])
        self.assertFalse(state.auto)

    async def test_execute_replan_keeps_batch_and_handoff_context(self):
        bridge = self.bridge()
        rec = LoopRecord(seq=1, sub_stage=SUB_EXECUTE)
        state = LoopState(session_id='s', loops=[rec], handoff={'notice': 'existing workflow'})
        calls = []
        async def agent(_session, prompt, *args, **kwargs):
            calls.append(prompt)
            return json.dumps(dict(loopControl=dict(pause=True, reason='no safe ready work'))), None
        bridge._loop_run_agent = agent
        await bridge._loop_do_execute(SimpleNamespace(id='s', backend_id='executor'), state, rec)
        self.assertEqual(len(calls), 1)
        self.assertIn('一组相关就绪任务', calls[0])
        self.assertIn('existing workflow', calls[0])
        self.assertTrue(state.progress_guard['pause'])

    async def analyze(self, data, previous=None):
        bridge = self.bridge()
        rec = LoopRecord(seq=2, sub_stage=SUB_ANALYSIS, progress_version=1,
                         orchestration=[LoopStep(index=1, output='proof-prefix'+'x'*9000+'FAILED at tail')])
        state = LoopState(session_id='s', auto=True, stage='loopexecute', loops=[*(previous or []), rec])
        calls = []
        async def agent(_session, prompt, *args, **kwargs):
            calls.append(prompt)
            return json.dumps(dict(score=99, optimizationPotential=0, **data)), None
        bridge._loop_run_agent = agent
        with patch('src.backend.bridge_ws.git_snapshot', return_value=None), patch('src.backend.bridge_ws.git_restore_snapshot') as restore:
            await bridge._loop_do_analysis(SimpleNamespace(id='s', backend_id='executor', working_dir='.'), state, rec)
            restore.assert_not_called()
        self.assertIn('FAILED at tail', calls[0])
        return state, rec

    async def test_score_alone_cannot_declare_new_delivery_complete(self):
        state, rec = await self.analyze({})
        self.assertFalse(rec.analysis.outputtable)
        self.assertEqual(state.stage, 'loopexecute')
        self.assertIn('缺少有效', rec.stage_details['analysis']['validation'][-1])

    async def test_verified_full_scope_can_complete_without_restoring_old_snapshot(self):
        old = record(1, 'implemented')
        old.analysis = LoopAnalysis(score=100)
        old.artifact_checkpoint = 'old-snapshot'
        state, rec = await self.analyze(dict(delivery=report('verified')), [old])
        self.assertTrue(rec.analysis.outputtable)
        self.assertEqual(state.stage, 'loopout')

    async def test_safety_blocker_pauses_not_completes(self):
        state, rec = await self.analyze(dict(delivery=report('blocked', blockers=[dict(id='b', kind='safety', reason='still damaging real data')])) )
        self.assertFalse(state.auto)
        self.assertEqual(state.stage, 'loopexecute')
        self.assertFalse(rec.analysis.outputtable)

    async def test_constraints_and_skills_stay_in_loop_call(self):
        captured = []
        class Backend:
            async def send_message(self, **kw):
                captured.append(kw)
                return {}
            def clear_cancelled(self, _): pass
        bridge, session, _ = diagnostics.LoopDiagnosticsTests().bridge_case(Backend())
        session.constraints = '保持协议不变'
        session.abilities = {'skills':['apply']}
        bridge._skill_runtime = SimpleNamespace(hint=lambda _: 'Skill: apply instructions')
        await bridge._loop_run_agent(session, 'do task', 'prepare', 1, resume=False)
        self.assertIn('保持协议不变', captured[0]['constraints'])
        self.assertIn('Skill: apply', captured[0]['constraints'])
        self.assertIn('不是文件沙箱', captured[0]['constraints'])
        self.assertIn('当前只负责只读核实并产出计划', captured[0]['constraints'])
        self.assertNotIn('execution_access', captured[0])

    async def test_backend_failure_after_partial_text_is_not_success(self):
        class Backend:
            async def send_message(self, **kw):
                kw['on_delta'](StreamDelta('s', 'm', 'text_delta', text='starting'))
                kw['on_delta'](StreamDelta('s', 'm', 'error', error='sandbox unavailable'))
                return {}
            def clear_cancelled(self, _): pass
        bridge, session, _ = diagnostics.LoopDiagnosticsTests().bridge_case(Backend())
        with self.assertRaises(_LoopAgentCallError) as caught:
            await bridge._loop_run_agent(session, 'do task', 'prepare', 1, resume=False)
        self.assertEqual(caught.exception.partial_text, 'starting')

    async def test_progress_pause_survives_reload_and_blocks_autocontinue(self):
        state = LoopState.from_dict(LoopState(session_id='s', auto=True, stage='loopexecute',
            progress_guard={'pause': True, 'reason': 'need human'}, loops=[record(1)]).to_dict())
        bridge = self.bridge()
        bridge._loop_state = lambda _: state
        bridge._schedule_loop_iteration = Mock()
        bridge._maybe_autocontinue('s')
        bridge._schedule_loop_iteration.assert_not_called()

    async def test_codex_loop_routes_sandbox_by_role_and_step_access(self):
        backend = CodexOfficeBackend(ModelBackendConfig(id='codex', type=BackendType.CODEX_OFFICIAL, label='test'))
        captured = []
        async def send(**kwargs):
            captured.append(kwargs)
            return {}
        backend.send_message = send
        bridge, session, _ = diagnostics.LoopDiagnosticsTests().bridge_case(backend)
        await bridge._loop_run_agent(session, 'plan', 'prepare', 1, resume=False)
        await bridge._loop_run_agent(session, 'test', 'analysis', 1, resume=False)
        await bridge._loop_run_agent(session, 'inspect', 'step1', 1, resume=False, execution_access='read-only')
        self.assertEqual([call['execution_access'] for call in captured], ['read-only', 'workspace-write', 'read-only'])
        for call in captured:
            self.assertIn('请求原生沙箱 ' + call['execution_access'], call['constraints'])
        self.assertIn('当前只负责只读核实并产出计划', captured[0]['constraints'])
        self.assertNotIn('当前只负责只读核实并产出计划', captured[1]['constraints'])
        self.assertNotIn('当前只负责只读核实并产出计划', captured[2]['constraints'])

    async def test_non_iteration_calls_do_not_inherit_automatic_access_claims(self):
        calls = []
        class Backend:
            async def send_message(self, **kwargs):
                calls.append(kwargs)
                return {}
            def clear_cancelled(self, _): pass
        bridge, session, _ = diagnostics.LoopDiagnosticsTests().bridge_case(Backend())
        await bridge._loop_run_agent(session, 'idea', 'idea', 0, resume=False)
        self.assertNotIn('【本次 LOOP 调用范围', calls[0]['constraints'])
        self.assertNotIn('execution_access', calls[0])

    async def test_real_execution_wrapper_retains_sequential_context_and_constraints(self):
        calls = []
        class Backend:
            async def send_message(self, **kwargs):
                calls.append(kwargs)
                kwargs['on_delta'](StreamDelta('s', 'm', 'text_delta', text='完成步骤，证据在测试日志'))
                return {'agentSessionId': 'isolated-thread'}
            def clear_cancelled(self, _): pass
        bridge, session, rec = diagnostics.LoopDiagnosticsTests().bridge_case(Backend())
        bridge._backend_configs = [SimpleNamespace(id='worker')]
        bridge._resolved_runtime = lambda *args: {}
        bridge._loop_runtime = lambda *args: {}
        bridge._loop_cancel = {}
        rec.orchestration = [LoopStep(index=1, desc='inspect', access='read'), LoopStep(index=2, desc='implement')]
        await bridge._loop_do_execute(session, bridge._loop_states['s'], rec)
        self.assertEqual(len(calls), 2)
        self.assertIsNone(calls[0]['agent_session_id'])
        self.assertEqual(calls[1]['agent_session_id'], 'isolated-thread')
        self.assertIn('不是文件沙箱', calls[1]['constraints'])
        self.assertNotIn('【工作流交接', calls[1]['content'])
        self.assertTrue(all(step.status == 'done' for step in rec.orchestration))

    async def test_codex_uses_native_sandbox_on_fresh_and_resumed_turns(self):
        backend = CodexOfficeBackend(ModelBackendConfig(id='codex', type=BackendType.CODEX_OFFICIAL, label='test'))
        for native_id, access in [(None, 'read-only'), ('thread-1', 'workspace-write')]:
            with patch('src.backend.codex_office.CodexAppServerProcess', remote._FakeAppServer):
                await backend.send_message([], 'verify', None, 's', 'm', lambda _: None,
                    agent_session_id=native_id, working_dir='.', skip_permissions=True,
                    sandbox_enabled=False, remote_host='fake', execution_access=access)
            calls = remote._FakeAppServer.instances[-1].requests
            thread_request = next(params for method, params in calls if method in ('thread/start', 'thread/resume'))
            self.assertEqual(thread_request['sandbox'], access)
            self.assertEqual(thread_request['approvalPolicy'], 'never')


if __name__ == '__main__':
    unittest.main()
