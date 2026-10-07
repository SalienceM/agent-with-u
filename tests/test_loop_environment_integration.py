"""Environment waits/rechecks use isolated state, no real sessions or model requests."""
import asyncio
import json
import os
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import LoopRecord, LoopState, LoopStep
from src.backend.loop_execution_environment import ExecutionIdentity, EnvironmentPause, new_check, normalize_environment
from src.backend.codex_environment import effective_probe_policy, probe_policy
from src.backend.codex_office import CodexOfficeBackend
from src.types import Session, ModelBackendConfig, BackendType


def fixture():
    bridge = BridgeWS.__new__(BridgeWS)
    session = Session(id='env-fixture', title='fixture', created_at=1, updated_at=1, messages=[],
                      session_type='loop', working_dir=str(Path.cwd()), backend_id='fake')
    record = LoopRecord(seq=1)
    state = LoopState(session_id=session.id, goal='fixture', loops=[record])
    bridge._loop_states = {session.id: state}
    bridge._active_sessions = {session.id: session}
    bridge._backend_configs = []
    bridge._loop_save = Mock()
    bridge._emit_loop_updated = Mock()
    bridge._require_session_access = Mock()
    bridge._loop_is_running = lambda _: False
    bridge._session_destroy_busy_reason = lambda _: ''
    bridge._loop_runtime = lambda *args: {}
    bridge._add_runtime_kwargs = lambda *args: None
    backend = SimpleNamespace(_build_env=lambda: {}, execution_environment_capabilities=lambda _: {'supported': True})
    bridge._new_backend_instance = lambda _: backend
    identity = ExecutionIdentity('local', 'fixture', session.id, session.working_dir, 'fake', 'app-server', 'prepare', 'read-only')
    bridge._loop_execution_identity = lambda _s, _b, bid, role, access, _kwargs: replace(identity, backend_id=bid, role=role, access=access)
    return bridge, session, state, record, backend, identity


class EnvironmentGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_pre_spawn_failure_can_be_rechecked_without_phantom_orphan(self):
        bridge, session, state, record, _, identity = fixture()
        backend = CodexOfficeBackend(ModelBackendConfig(id='fake', type=BackendType.CODEX_OFFICIAL, label='fixture'))
        gate, observer = bridge._loop_environment_hooks(session, backend, identity, 1, explicit=True)
        with patch('src.backend.codex_app_server.asyncio.create_subprocess_exec',
                   AsyncMock(side_effect=FileNotFoundError('synthetic missing runner'))):
            with self.assertRaises(EnvironmentPause):
                await backend.check_execution_environment(identity, gate, observer)
        self.assertFalse(bridge._loop_has_active_call(session.id))
        self.assertFalse(getattr(bridge, '_loop_environment_orphans', {}).get(session.id))
        self.assertTrue(state.execution_environment['blockers'][0]['quiesced'])
        # 修复后的显式复查必须能够进入正常检查，而不是永远只尝试清理空连接。
        async def recovered(_session, _state):
            check = new_check(identity, status='passed', coverage='native_policy',
                scope=bridge._loop_environment_scope(identity), probePath='command/exec', quiesced=True)
            bridge._loop_environment_record(state, record, check, clear=True)
        bridge._loop_environment_recheck = AsyncMock(side_effect=recovered)
        reply = json.loads(await bridge._rpc_loopExecutionEnvironmentCheck(session.id, state.execution_environment['revision']))
        bridge._loop_environment_recheck.assert_awaited_once()
        self.assertEqual(reply['status'], 'ok')
        self.assertFalse(state.execution_environment['blockers'])
        self.assertFalse(state.auto)

    async def test_late_timeout_and_cancel_are_history_only_after_goal_or_config_change(self):
        import copy
        for fault in (asyncio.TimeoutError, asyncio.CancelledError):
            for change in ('goal', 'config'):
                with self.subTest(fault=fault.__name__, change=change):
                    bridge, session, state, record, backend, identity = fixture()
                    backend.config = SimpleNamespace(id='fake', model='old')
                    bridge._backend_configs = [backend.config]
                    state.execution_environment = normalize_environment({'revision': 7, 'status': 'unknown'})
                    before = copy.deepcopy(state.execution_environment)
                    gate, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
                    async def delayed(*_):
                        if change == 'goal':
                            state.goal = 'new goal'
                        else:
                            backend.config.model = 'new'
                        raise fault()
                    conn = SimpleNamespace(server_version='0.154.0', close=AsyncMock(), cleanup_confirmed=True)
                    with patch('src.backend.codex_environment.effective_probe_policy', side_effect=delayed):
                        with self.assertRaises((EnvironmentPause, asyncio.CancelledError)):
                            await gate(conn)
                    observer('preflight', record.environment_checks[-1])
                    self.assertEqual(state.execution_environment, before)
                    self.assertEqual(record.environment_checks[-1]['status'], 'stale')
                    self.assertEqual(len(record.environment_checks), 1)
                    self.assertTrue(record.environment_checks[-1]['quiesced'])
                    self.assertFalse(bridge._loop_has_active_call(session.id))

    async def test_late_workflow_failure_updates_history_only(self):
        from src.backend.loop_environment_workflow import WorkflowSelectionError
        bridge, session, state, record, backend, identity = fixture()
        async def delayed(*_):
            state.goal = 'new goal'
            raise WorkflowSelectionError('fixture changed')
        bridge._loop_environment_dependencies = AsyncMock(side_effect=delayed)
        gate, observer = bridge._loop_environment_hooks(session, backend, identity, 1, explicit=True)
        with self.assertRaises(EnvironmentPause) as paused:
            await gate()
        observer('preflight', paused.exception.check)
        self.assertFalse(state.execution_environment)
        self.assertEqual(len(record.environment_checks), 1)
        self.assertEqual(record.environment_checks[0]['status'], 'stale')
        bridge._emit_loop_updated.assert_called()

    async def test_cache_cannot_bypass_goal_change_during_policy_read(self):
        bridge, session, state, record, backend, identity = fixture()
        conn = SimpleNamespace(server_version='0.154.0')
        async def probe(_conn, active, **_kwargs):
            return new_check(active, status='passed', coverage='native_policy', probePath='command/exec', quiesced=True)
        gate, _ = bridge._loop_environment_hooks(session, backend, identity, 1)
        with patch('src.backend.codex_environment.effective_probe_policy', AsyncMock(return_value={})), \
             patch('src.backend.codex_environment.probe_environment', side_effect=probe) as mocked:
            await gate(conn)
            before = state.execution_environment.copy()
            async def changed(*_):
                state.goal = 'new goal'
                return {}
            with patch('src.backend.codex_environment.effective_probe_policy', side_effect=changed):
                with self.assertRaises(EnvironmentPause) as paused:
                    await gate(conn)
            self.assertEqual(paused.exception.check['status'], 'stale')
            self.assertEqual(state.execution_environment, before)
            self.assertEqual(mocked.await_count, 1)

    async def test_stale_standalone_preflight_stops_before_next_role(self):
        bridge, session, state, record, backend, identity = fixture()
        async def failed(_identity, _gate, observer):
            state.goal = 'new goal'
            check = new_check(_identity, status='blocked', reason='env_probe_failed', quiesced=True)
            observer('preflight', check)
            raise EnvironmentPause(check)
        backend.check_execution_environment = AsyncMock(side_effect=failed)
        await bridge._loop_environment_recheck(session, state)
        self.assertFalse(state.execution_environment)
        self.assertEqual(record.environment_checks[-1]['status'], 'stale')
        self.assertEqual(backend.check_execution_environment.await_count, 1)

    async def test_stale_cleanup_updates_detail_revision_without_current_environment_write(self):
        bridge, session, state, record, backend, identity = fixture()
        _, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
        state.goal = 'new goal'
        check = new_check(identity, status='blocked', reason='env_probe_failed', quiesced=False)
        observer('preflight', check)
        first_revision = record.environment_checks[-1]['revision']
        check['quiesced'] = True
        observer('preflight', check)
        final_revision = record.environment_checks[-1]['revision']
        self.assertGreater(final_revision, first_revision)
        self.assertTrue(record.environment_checks[-1]['quiesced'])
        bridge._emit_loop_updated.reset_mock()
        observer('preflight', check)
        self.assertEqual(len(record.environment_checks), 1)
        self.assertEqual(record.environment_checks[-1]['revision'], final_revision)
        bridge._emit_loop_updated.assert_not_called()
        self.assertFalse(state.execution_environment)

    async def test_late_outer_timeout_does_not_replace_current_environment(self):
        bridge, session, state, record, backend, identity = fixture()
        async def delayed(*_):
            state.goal = 'new goal'
            raise asyncio.TimeoutError()
        backend.check_execution_environment = AsyncMock(side_effect=delayed)
        backend.environment_cleanup_confirmed = True
        await bridge._loop_environment_recheck(session, state)
        self.assertFalse(state.execution_environment)
        self.assertEqual(record.environment_checks[-1]['status'], 'stale')
        self.assertEqual(backend.check_execution_environment.await_count, 1)

    async def test_stale_wait_retains_unconfirmed_owned_process_lock(self):
        bridge, session, state, record, backend, identity = fixture()
        gate, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
        async def delayed(*_):
            state.goal = 'new goal'
            raise asyncio.TimeoutError()
        conn = SimpleNamespace(server_version='0.154.0', close=AsyncMock(), cleanup_confirmed=False)
        with patch('src.backend.codex_environment.effective_probe_policy', side_effect=delayed):
            with self.assertRaises(EnvironmentPause):
                await gate(conn)
        self.assertEqual(record.environment_checks[-1]['status'], 'stale')
        observer('cleanup', {'connection': conn, 'quiesced': False})
        self.assertTrue(bridge._loop_has_active_call(session.id))
        self.assertFalse(state.execution_environment['blockers'][0]['quiesced'])

    async def test_actual_fault_preserves_normal_blocked_or_one_real_failure(self):
        from tests.test_loop_diagnostics import LoopDiagnosticsTests
        from src.backend.bridge_ws import _LoopAgentCallError
        from src.backend.base import StreamDelta
        for model_error in (False, True):
            calls = []
            class Backend:
                def _build_env(self): return dict(os.environ)
                def execution_environment_capabilities(self, _): return {'supported': True}
                def clear_cancelled(self, _): pass
                async def send_message(self, **kwargs):
                    calls.append(1)
                    await kwargs['environment_gate'](SimpleNamespace(server_version='0.154.0'))
                    kwargs['environment_observer']('nativeError', {'message': 'orchestrator_helper_incomplete fake-key'})
                    kwargs['on_delta'](StreamDelta('s', 'm', 'text_delta', text='task blocked'))
                    if model_error:
                        kwargs['on_delta'](StreamDelta('s', 'm', 'error', error='fixture runner failure'))
                    return {}
            bridge, session, record = LoopDiagnosticsTests().bridge_case(Backend())
            state = bridge._loop_states['s']
            async def probe(_conn, identity, **kwargs):
                return new_check(identity, status='passed', coverage='native_policy', quiesced=True)
            with patch('src.backend.codex_environment.effective_probe_policy', AsyncMock(return_value={})), \
                 patch('src.backend.codex_environment.probe_environment', side_effect=probe):
                if model_error:
                    with self.assertRaises(_LoopAgentCallError):
                        await bridge._loop_run_agent(session, 'fixture', 'prepare', 1)
                else:
                    await bridge._loop_run_agent(session, 'fixture', 'prepare', 1)
                    self.assertEqual(record.task_result, 'blocked')
                for _ in range(2):
                    with self.assertRaises(EnvironmentPause):
                        await bridge._loop_run_agent(session, 'fixture', 'prepare', 1)
            self.assertEqual(calls, [1])
            self.assertEqual(record.call_results['prepare'], 'error' if model_error else 'normal')
            self.assertEqual(sum(d.get('hadError', False) for d in record.call_diagnostics), int(model_error))
            self.assertNotIn('fake-key', json.dumps(state.execution_environment))

    async def test_protocol_or_effective_policy_changes_cannot_reuse_success(self):
        bridge, session, state, record, backend, identity = fixture()
        conn = SimpleNamespace(server_version='0.154.0')
        async def probe(_conn, active, **kw):
            return new_check(active, status='passed', coverage='native_policy', probePath='command/exec', quiesced=True)
        with patch('src.backend.codex_environment.effective_probe_policy', AsyncMock(side_effect=[
                {'type': 'readOnly', 'networkAccess': False}, {'type': 'readOnly', 'networkAccess': True}])), \
             patch('src.backend.codex_environment.probe_environment', side_effect=probe) as mocked:
            gate, _ = bridge._loop_environment_hooks(session, backend, identity, 1)
            await gate(conn); await gate(conn)
            self.assertEqual(mocked.call_count, 2)
        self.assertNotEqual(record.environment_checks[0]['identity'], record.environment_checks[1]['identity'])

    async def test_persistent_block_does_not_create_new_loop_or_poll_on_auto(self):
        from tests.test_loop_lifecycle import LoopLifecycleTests
        bridge, session, state, record, backend, identity = fixture()
        lifecycle, _ = LoopLifecycleTests._bridge(state)
        state.auto, state.stage = True, 'loopexecute'
        record.terminal_kind = 'paused'
        state.execution_environment = normalize_environment({'status': 'blocked', 'blockers': [new_check(identity,
            status='blocked', reason='env_runner_setup_failed', quiesced=True)]})
        lifecycle._loop_environment_recheck = AsyncMock()
        lifecycle._loop_do_prepare = AsyncMock()
        for _ in range(3):
            await lifecycle._run_loop_iteration(session.id, auto_required=True)
        self.assertEqual(len(state.loops), 1)
        lifecycle._loop_environment_recheck.assert_not_called()
        lifecycle._loop_do_prepare.assert_not_called()
        self.assertFalse(record.call_results)
        self.assertFalse(state.auto)
        self.assertTrue(state.progress_guard['resumeCondition'])

    async def test_explicit_resume_rechecks_before_new_prepare_and_does_not_replay_old_writes(self):
        from tests.test_loop_lifecycle import LoopLifecycleTests
        bridge, session, state, record, backend, identity = fixture()
        lifecycle, session = LoopLifecycleTests._bridge(state)
        session.working_dir = str(Path.cwd())
        state.stage = 'loopexecute'
        record.terminal_kind = 'paused'
        old_step = LoopStep(index=1, status='done', desc='already verified')
        record.orchestration = [old_step]
        state.execution_environment = normalize_environment({'status': 'blocked', 'blockers': [new_check(identity,
            status='blocked', reason='env_access_denied', quiesced=True)]})
        order = []
        async def recheck(*_):
            order.append('check')
            state.execution_environment = normalize_environment({})
        async def prepare(_session, _state, _record, _history):
            order.append('prepare')
            state.progress_guard = {'pause': True}
        lifecycle._loop_environment_recheck = recheck
        lifecycle._loop_do_prepare = prepare
        lifecycle._loop_check_source = AsyncMock(return_value=True)
        lifecycle._maybe_autocontinue = Mock()
        with patch('src.backend.bridge_ws.git_snapshot', return_value='fixture-snapshot'):
            await lifecycle._run_loop_iteration(session.id)
        self.assertEqual(order, ['check', 'prepare'])
        self.assertEqual(len(state.loops), 2)
        self.assertEqual(record.orchestration[0].status, 'done')
        self.assertEqual(old_step.attempts, 0)

    async def test_cleanup_recheck_only_releases_owned_activity_not_environment_block(self):
        bridge, session, state, record, backend, identity = fixture()
        conn = SimpleNamespace(cleanup_confirmed=False)
        async def close():
            conn.cleanup_confirmed = True
        conn.close = AsyncMock(side_effect=close)
        _, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
        observer('cleanup', {'connection': conn, 'quiesced': False})
        revision = state.execution_environment['revision']
        result = json.loads(await bridge._rpc_loopExecutionEnvironmentCheck(session.id, revision))
        self.assertEqual(result['status'], 'ok')
        self.assertTrue(state.execution_environment['blockers'][0]['quiesced'])
        self.assertEqual(state.execution_environment['status'], 'blocked')
        self.assertFalse(bridge._loop_has_active_call(session.id))
        self.assertFalse(state.auto)

    async def test_generic_dependency_cache_coalescing_and_boundary(self):
        bridge, session, state, record, backend, identity = fixture()
        conn = SimpleNamespace(server_version='0.154.0')
        entered, release = asyncio.Event(), asyncio.Event()
        async def probe(_conn, active, **kw):
            self.assertEqual(kw['dependencies'], [])
            entered.set(); await release.wait()
            return new_check(active, status='passed', coverage='native_policy', probePath='command/exec', quiesced=True)
        with patch('src.backend.codex_environment.effective_probe_policy', AsyncMock(return_value=probe_policy('read-only', '.'))), \
             patch('src.backend.codex_environment.probe_environment', side_effect=probe) as mocked:
            gate, _ = bridge._loop_environment_hooks(session, backend, identity, 1)
            first = asyncio.create_task(gate(conn)); await entered.wait()
            second = asyncio.create_task(gate(conn)); release.set()
            await asyncio.gather(first, second)
            self.assertEqual(mocked.call_count, 1)
            state.round += 1
            gate2, _ = bridge._loop_environment_hooks(session, backend, identity, 1)
            await gate2(conn)
            self.assertEqual(mocked.call_count, 2)
        self.assertFalse(bridge._loop_environment_locks)

    async def test_confirmed_fault_waits_without_probe_and_does_not_block_other_backend(self):
        bridge, session, state, record, backend, identity = fixture()
        gate, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
        observer('nativeError', {'message': 'orchestrator_helper_incomplete fake-secret'})
        self.assertEqual(state.execution_environment['latest']['reasonCode'], 'env_runner_setup_failed')
        with patch('src.backend.codex_environment.probe_environment') as probe:
            with self.assertRaises(EnvironmentPause):
                await gate(SimpleNamespace(server_version='0.154.0'))
            probe.assert_not_called()
        self.assertIsNone(bridge._loop_environment_blocker(state, replace(identity, backend_id='independent')))
        self.assertIsNotNone(bridge._loop_environment_blocker(state, replace(identity, role='step1')))
        self.assertNotIn('fake-secret', json.dumps(state.execution_environment))

    async def test_project_stdout_cannot_forge_fault_and_native_success_cannot_clear_actual_fault(self):
        bridge, session, state, record, backend, identity = fixture()
        gate, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
        observer('commandExecution', {'id': 'i', 'status': 'failed', 'exitCode': 1,
                    'aggregatedOutput': 'Access denied orchestrator_helper_incomplete fake-key'})
        self.assertFalse(state.execution_environment['blockers'])
        self.assertEqual(state.execution_environment['latest']['status'], 'stale')
        observer('nativeError', {'message': 'orchestrator_helper_incomplete'})
        active = replace(identity, runner_version='0.154.0')
        success = new_check(active, status='passed', coverage='native_policy', probePath='command/exec', quiesced=True)
        with patch('src.backend.codex_environment.effective_probe_policy', AsyncMock(return_value=probe_policy('read-only', '.'))), \
             patch('src.backend.codex_environment.probe_environment', AsyncMock(return_value=success)):
            gate, _ = bridge._loop_environment_hooks(session, backend, identity, 1, explicit=True)
            with self.assertRaises(EnvironmentPause):
                await gate(SimpleNamespace(server_version='0.154.0'))
        self.assertEqual(state.execution_environment['blockers'][0]['coverage'], 'actual_tool')

    async def test_same_policy_explicit_success_clears_native_block_only_and_keeps_pause(self):
        bridge, session, state, record, backend, identity = fixture()
        state.progress_guard = {'pause': True, 'reasonCode': 'env_access_denied'}
        state.auto = False
        block = new_check(identity, status='blocked', reason='env_access_denied', coverage='native_policy',
            scope=bridge._loop_environment_scope(identity), probePath='command/exec', quiesced=True)
        bridge._loop_environment_record(state, record, block)
        success = new_check(replace(identity, runner_version='0.154.0'), status='passed', coverage='native_policy', probePath='command/exec', quiesced=True)
        with patch('src.backend.codex_environment.effective_probe_policy', AsyncMock(return_value=probe_policy('read-only', '.'))), \
             patch('src.backend.codex_environment.probe_environment', AsyncMock(return_value=success)):
            gate, _ = bridge._loop_environment_hooks(session, backend, identity, 1, explicit=True)
            await gate(SimpleNamespace(server_version='0.154.0'))
        self.assertFalse(state.execution_environment['blockers'])
        self.assertTrue(state.progress_guard['pause'])
        self.assertFalse(state.auto)

    async def test_late_goal_response_cannot_replace_current_environment(self):
        bridge, session, state, record, backend, identity = fixture()
        async def probe(_conn, active, **kw):
            state.goal = 'new scope'
            return new_check(active, status='passed', coverage='native_policy', quiesced=True)
        with patch('src.backend.codex_environment.effective_probe_policy', AsyncMock(return_value={})), \
             patch('src.backend.codex_environment.probe_environment', side_effect=probe):
            gate, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
            with self.assertRaises(EnvironmentPause) as paused:
                await gate(SimpleNamespace(server_version='0.154.0'))
            observer('preflight', paused.exception.check)
        self.assertEqual(record.environment_checks[-1]['status'], 'stale')
        self.assertFalse(state.execution_environment)

    async def test_environment_wait_is_not_model_failure_or_attempt(self):
        bridge, session, state, record, backend, identity = fixture()
        bridge._send_for_session = AsyncMock()
        bridge._loop_cancel = {}
        bridge._loop_check_source = AsyncMock(return_value=True)
        exc = EnvironmentPause(new_check(identity, status='blocked', reason='env_access_denied', quiesced=True))
        bridge._loop_run_agent_impl = AsyncMock(side_effect=exc)
        step = LoopStep(index=1, desc='fixture')
        record.orchestration = [step]
        with self.assertRaises(EnvironmentPause):
            await bridge._loop_run_step(session, state, record, step, False)
        self.assertEqual(step.attempts, 0)
        self.assertEqual(step.status, 'pending')
        self.assertFalse(record.call_results)
        self.assertEqual(record.call_diagnostics[-1]['status'], 'environment_wait')
        self.assertNotIn('hadError', record.call_diagnostics[-1])

    async def test_check_rpc_coalesces_routes_and_never_starts_work(self):
        bridge, session, state, record, backend, identity = fixture()
        entered, release = asyncio.Event(), asyncio.Event()
        count = 0
        async def recheck(_session, _state):
            nonlocal count
            count += 1; entered.set(); await release.wait()
        bridge._loop_environment_recheck = recheck
        first = asyncio.create_task(bridge._rpc_loopExecutionEnvironmentCheck(session.id, 0))
        await entered.wait()
        second = asyncio.create_task(bridge._rpc_loopExecutionEnvironmentCheck(session.id, 0))
        await asyncio.sleep(0)
        self.assertTrue(bridge._loop_has_active_call(session.id))
        release.set()
        result = await asyncio.gather(first, second)
        self.assertEqual(count, 1)
        self.assertEqual(result[0], result[1])
        self.assertFalse(state.auto)
        self.assertEqual(len(state.loops), 1)
        self.assertFalse(bridge._loop_has_active_call(session.id))
        for revision, mode in ((2, 'loop'), (0, 'manual')):
            state.control_mode = mode
            self.assertEqual(json.loads(await bridge._rpc_loopExecutionEnvironmentCheck(session.id, revision))['status'], 'error')
        bridge._require_session_access.side_effect = PermissionError('fixture')
        with self.assertRaises(PermissionError):
            await bridge._rpc_loopExecutionEnvironmentCheck(session.id, 0)

    async def test_get_and_check_enforce_real_owner_boundary(self):
        bridge, session, state, record, backend, identity = fixture()
        bridge._require_session_access = BridgeWS._require_session_access.__get__(bridge)
        bridge._current_owner_id = lambda: 'owner-a'
        session.owner_id = 'owner-a'
        bridge._skill_store = SimpleNamespace(command_sources=lambda: {'installed': [], 'profiles': []}, get_skill=lambda _: None)
        bridge._loop_environment_recheck = AsyncMock()
        result = json.loads(await bridge._rpc_loopExecutionEnvironmentGet(session.id))
        self.assertEqual(result['sessionId'], session.id)
        bridge._loop_environment_recheck.assert_not_called()
        session.owner_id = 'owner-b'
        for action in (bridge._rpc_loopExecutionEnvironmentGet(session.id),
                       bridge._rpc_loopExecutionEnvironmentCheck(session.id, 0)):
            with self.assertRaises(PermissionError):
                await action
        bridge._loop_environment_recheck.assert_not_called()

    async def test_unconfirmed_cleanup_keeps_activity(self):
        bridge, session, state, record, backend, identity = fixture()
        _, observer = bridge._loop_environment_hooks(session, backend, identity, 1)
        observer('cleanup', {'connection': object(), 'quiesced': False})
        self.assertTrue(bridge._loop_has_active_call(session.id))
        self.assertFalse(state.execution_environment['blockers'][0]['quiesced'])


class EffectivePolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_settings_and_versions_return_unsupported_not_looser_probe(self):
        from src.backend.loop_execution_environment import EnvironmentError
        bridge, session, state, record, backend, identity = fixture()
        for config in ({'shell_environment_policy': {'inherit': 'none'}}, {'permissions': {'profile': 'custom'}}):
            conn = SimpleNamespace(server_version='0.154.0', request=AsyncMock(return_value={'config': config}))
            with self.assertRaises(EnvironmentError) as error:
                await effective_probe_policy(conn, identity)
            self.assertEqual(error.exception.code, 'env_probe_unsupported')
        conn = SimpleNamespace(server_version='unknown', request=AsyncMock())
        with self.assertRaises(EnvironmentError):
            await effective_probe_policy(conn, identity)
        conn.request.assert_not_called()
    async def test_read_config_only_and_preserve_workspace_network_temp_roots(self):
        bridge, session, state, record, backend, identity = fixture()
        conn = SimpleNamespace(server_version='0.154.0', request=AsyncMock(side_effect=[{'config': {
            'sandbox_workspace_write': {'network_access': True, 'exclude_tmpdir_env_var': True,
              'exclude_slash_tmp': True, 'writable_roots': [str(Path.cwd())]}}}, {'requirements': None}]))
        policy = await effective_probe_policy(conn, replace(identity, access='workspace-write'))
        self.assertTrue(policy['networkAccess'])
        self.assertTrue(policy['excludeTmpdirEnvVar'])
        self.assertEqual([c.args[0] for c in conn.request.call_args_list], ['config/read', 'configRequirements/read'])
        conn.request = AsyncMock(return_value={'config': {}})
        returned = {'type': 'readOnly', 'networkAccess': False}
        self.assertEqual(await effective_probe_policy(conn, identity, {'cwd': session.working_dir, 'sandbox': returned}), returned)


class AdapterGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_and_resumed_context_get_current_hint_without_changing_manual(self):
        from tests.test_codex_remote import _FakeAppServer
        class Fake(_FakeAppServer):
            cleanup_confirmed = True
        backend = CodexOfficeBackend(ModelBackendConfig(id='fake', type=BackendType.CODEX_OFFICIAL, label='fixture'))
        for thread in (None, 'remote-thread-1'):
            gate = AsyncMock(return_value='fixture verified absolute entry')
            with patch('src.backend.codex_environment.ProbeAppServerProcess', Fake):
                await backend.send_message([], 'task only', None, 'fixture', 'm', lambda _: None,
                    working_dir='.', agent_session_id=thread, app_server_local=True,
                    execution_access='read-only', environment_gate=gate, environment_observer=Mock())
            requests = Fake.instances[-1].requests
            turn = next(params for method, params in requests if method == 'turn/start')
            self.assertIn('fixture verified absolute entry', turn['input'][0]['text'])
            self.assertEqual(requests[0][1]['sandbox'], 'read-only')
            self.assertEqual(gate.await_count, 1)
