"""Session-owned execution environment integration (no host-side task execution)."""
from __future__ import annotations

import copy
import asyncio
import json
import os
import platform
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

from .loop_execution_environment import (ExecutionIdentity, digest, toolchain_revision,
    normalize_environment, normalize_workflow, normalize_check, normalize_history, new_check,
    discover_openspec, entry_hint, EnvironmentError, EnvironmentPause, check_matches, path_identity)
from .loop_environment_workflow import workflow_choices, select_workflow, resolve_workflow, WorkflowSelectionError


class LoopEnvironmentBridge:
    async def _loop_environment_recheck(self, session: Any, state: Any) -> None:
        """运行配置来自与自动调用相同的路由器；没有模型、工作流动作或 Auto 写入。"""
        checks = getattr(self, '_loop_environment_checks', None)
        if checks is None:
            checks = self._loop_environment_checks = {}
        if session.id in checks:
            raise WorkflowSelectionError('环境检查仍在进行。')
        checks[session.id] = asyncio.current_task()
        self._loop_environment_cache = {}
        started_at = time.monotonic()
        self._emit_loop_updated(state)
        try:
            requested_execute = state.policy.backend_for('execute') or session.backend_id
            if not any(c.id == requested_execute for c in self._backend_configs):
                requested_execute = session.backend_id
            targets = [('prepare', 'read-only'), ('execute', 'workspace-write'), ('analysis', 'workspace-write')]
            # 执行器上的只读步骤可能与 prepare 使用不同 Backend。
            last = state.loops[-1] if state.loops else None
            if last and any(s.access == 'read' and s.status != 'done' for s in last.orchestration):
                targets.append(('execute', 'read-only'))
            for role, access in targets:
                if state.control_mode != 'loop':
                    break
                requested = state.policy.backend_for(role) or session.backend_id
                try:
                    backend = self._new_backend_instance(requested)
                    backend_id = requested
                except Exception:
                    backend_id = session.backend_id
                    backend = self._new_backend_instance(backend_id)
                runtime = self._loop_runtime(session, state, role, backend_id, requested_execute)
                kwargs = {'working_dir': session.working_dir}
                self._add_runtime_kwargs(backend, kwargs, runtime, session)
                identity = self._loop_execution_identity(session, backend, backend_id, role, access, kwargs)
                gate, observer = self._loop_environment_hooks(session, backend, identity, last.seq if last else 0, explicit=True)
                try:
                    if getattr(backend, 'execution_environment_capabilities', lambda _: {})(identity).get('supported'):
                        remaining = 30 - (time.monotonic() - started_at)
                        if remaining <= 0:
                            check = new_check(identity, status='blocked', reason='env_probe_timeout', quiesced=True,
                                scope=self._loop_environment_scope(identity), probePath='command/exec')
                            observer('preflight', check)
                            break
                        await asyncio.wait_for(backend.check_execution_environment(identity, gate, observer), remaining)
                    else:
                        await gate()
                except asyncio.TimeoutError:
                    check = new_check(identity, status='blocked', reason='env_probe_timeout',
                        quiesced=getattr(backend, 'environment_cleanup_confirmed', False),
                        scope=self._loop_environment_scope(identity), probePath='command/exec')
                    observer('preflight', check)
                    break
                except EnvironmentPause as exc:
                    # 证据已保存；旧配置的检查到此为止，不再检查下一角色。
                    if exc.check['status'] == 'stale':
                        break
                if getattr(self, '_loop_environment_orphans', {}).get(session.id):
                    break
        finally:
            checks.pop(session.id, None)
            self._emit_loop_updated(state)

    async def _rpc_loopExecutionEnvironmentCheck(self, session_id: str, expected_revision: int) -> str:
        self._require_session_access(session_id)
        if self._loop_control_reserved(session_id):
            return self._control_error('handoff_busy')
        if type(expected_revision) is not int:
            return json.dumps({'status': 'error', 'message': '环境修订无效。'}, ensure_ascii=False)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        state = self._loop_state(session_id)
        inflight = getattr(self, '_loop_environment_requests', None)
        if inflight is None:
            inflight = self._loop_environment_requests = {}
        key = (session_id, expected_revision)
        if key in inflight:
            return await asyncio.shield(inflight[key])
        orphans = getattr(self, '_loop_environment_orphans', {}).get(session_id, [])
        if (orphans and state and state.control_mode == 'loop' and not self._loop_is_running(session_id)
                and not any(k == session_id or k.startswith(session_id + ':') for k in getattr(self, '_loop_active_backends', {}))
                and expected_revision == normalize_environment(state.execution_environment)['revision']):
            # 只收口仍持有句柄的本次进程；不靠 PID 猜测，也不启动探测/任务。
            async def cleanup() -> str:
                try:
                    for item in orphans:
                        await item['connection'].close()
                    stopped = {item['scope'] for item in orphans if item['connection'].cleanup_confirmed}
                    self._loop_environment_orphans[session_id] = [item for item in orphans if not item['connection'].cleanup_confirmed]
                    still_active = {item['scope'] for item in self._loop_environment_orphans[session_id]}
                    previous = normalize_environment(state.execution_environment)
                    for check in previous['blockers']:
                        if check.get('scope') in stopped - still_active:
                            check['quiesced'] = True
                    previous['revision'] += 1
                    state.execution_environment = previous
                    self._loop_save(state)
                    return json.dumps({'status': 'ok', 'sessionId': session_id, 'environment': previous,
                        'message': '仅核对旧进程退出；尚未重新探测，环境阻塞保留。'}, ensure_ascii=False)
                finally:
                    inflight.pop(key, None)
                    self._emit_loop_updated(state)
            task = asyncio.create_task(cleanup())
            inflight[key] = task
            return await asyncio.shield(task)
        try:
            self._loop_environment_editable(session, state, expected_revision)
        except WorkflowSelectionError as exc:
            return json.dumps({'status': 'error', 'message': str(exc)}, ensure_ascii=False)

        async def run() -> str:
            try:
                await self._loop_environment_recheck(session, state)
                return json.dumps({'status': 'ok', 'sessionId': session_id,
                    'environment': normalize_environment(state.execution_environment)}, ensure_ascii=False)
            except WorkflowSelectionError as exc:
                return json.dumps({'status': 'error', 'message': str(exc)}, ensure_ascii=False)
            finally:
                inflight.pop(key, None)
                self._emit_loop_updated(state)
        task = asyncio.create_task(run())
        inflight[key] = task
        return await asyncio.shield(task)

    def _loop_environment_scope(self, identity: ExecutionIdentity) -> str:
        # 修复配置后仍能对照原故障，但另一节点/工作区/权限不能解除它。
        return digest([identity.owner, identity.executor, identity.session_id,
                       path_identity(identity.workspace), identity.backend_id, identity.transport, identity.access])

    def _loop_environment_record(self, state: Any, record: Any, check: dict, *, clear: bool = False) -> dict:
        previous = normalize_environment(state.execution_environment)
        check = normalize_check({**check, 'revision': previous['revision'] + 1})
        blockers = previous['blockers']
        if clear and check['status'] == 'passed' and check['quiesced'] and not check['incomplete']:
            ranks = {'host_discovery': 0, 'native_policy': 1, 'actual_tool': 2}
            blockers = [old for old in blockers if not (
                old.get('scope') == check.get('scope') and old.get('scope')
                and (old.get('probePath') == check['probePath'] or old.get('probePath') == 'host' and check['probePath'] == 'command/exec')
                and (not old.get('dependencyId') or old.get('dependencyId') == check['dependencyId']
                     or old.get('dependencyId') == 'node' and check['dependencyId'] == 'openspec')
                and old.get('quiesced') and ranks[old['coverage']] <= ranks[check['coverage']])]
        if check['status'] == 'blocked':
            key = lambda item: (item.get('scope'), item.get('access'), item.get('dependencyId'), item.get('probePath'), item.get('reasonCode'))
            blockers = [old for old in blockers if key(old) != key(check)] + [check]
        state.execution_environment = normalize_environment({**previous,
            'revision': check['revision'], 'latest': check, 'blockers': blockers,
            'status': 'blocked' if blockers else check['status']})
        if record:
            record.environment_checks = normalize_history([*record.environment_checks, check])
        self._loop_save(state)
        self._emit_loop_updated(state)
        return check

    def _loop_environment_blocker(self, state: Any, identity: ExecutionIdentity) -> dict | None:
        env = normalize_environment(state.execution_environment)
        if env.get('incomplete'):
            return new_check(identity, status='blocked', reason='env_probe_failed', incomplete=True)
        scope = self._loop_environment_scope(identity)
        return next((v for v in env['blockers'] if v.get('scope') == scope
                     or not v.get('scope') or not v.get('quiesced')), None)

    async def _loop_environment_dependencies(self, session: Any, state: Any) -> list[str]:
        reference = normalize_environment(state.execution_environment)['workflowRef']
        if reference:
            await asyncio.to_thread(resolve_workflow, session, self._skill_store, reference, state.goal)
            return ['openspec']
        # 当前正式来源适配器仅 OpenSpec；绑定依赖不等于猜选 change。
        return ['openspec'] if (state.task_source or {}).get('binding') else []

    def _loop_environment_hooks(self, session: Any, backend: Any, identity: ExecutionIdentity,
                                seq: int, diagnostic: Any = None, *, explicit: bool = False):
        state = self._loop_state(session.id)
        record = next((r for r in state.loops if r.seq == seq), None) if state else None
        active_identity = identity
        dispatch_basis = digest([state.goal, normalize_environment(state.execution_environment)['workflowRef'],
                                 state.control_mode, session.working_dir])
        config_basis = copy.deepcopy(vars(backend.config)) if getattr(backend, 'config', None) else None
        boundary = f'{state.round}:{seq}:{identity.role}'

        def unchanged() -> bool:
            configured = next((c for c in getattr(self, '_backend_configs', []) if c.id == identity.backend_id), None)
            return (dispatch_basis == digest([state.goal, normalize_environment(state.execution_environment)['workflowRef'],
                                             state.control_mode, session.working_dir])
                    and (not identity.toolchain_revision or not hasattr(backend, '_build_env')
                         or toolchain_revision(backend._build_env()) == identity.toolchain_revision)
                    and (configured is None or config_basis is None or vars(configured) == config_basis))

        def record_check(check: dict, *, clear: bool = False) -> dict:
            check = normalize_check({**check, 'scope': self._loop_environment_scope(active_identity), 'boundary': boundary})
            if check['status'] == 'stale' or not unchanged():
                # 所有预检出口共用新鲜度校验；迟到结果只更新原记录历史。
                check = normalize_check({**check, 'status': 'stale', 'reasonCode': check['reasonCode'] or 'env_unknown'})
                if record:
                    history = normalize_history(record.environment_checks)
                    previous = next((old for old in history if old['id'] == check['id']), None)
                    if previous:
                        check['revision'] = previous['revision']
                        if check == previous:
                            return check
                    # 收尾改变 quiesced 时更新详情修订，但不触碰当前环境修订。
                    check['revision'] = max([check['revision'], *[old['revision'] for old in history]]) + 1
                    record.environment_checks = normalize_history([*[old for old in history if old['id'] != check['id']], check])
                    self._loop_save(state)
                    self._emit_loop_updated(state)
                return check
            return self._loop_environment_record(state, record, check, clear=clear)

        def require_current(check: dict | None = None) -> None:
            if not unchanged():
                raise EnvironmentPause(record_check(check or new_check(active_identity,
                    status='stale', reason='env_unknown', quiesced=True)))

        async def probe_gate(conn: Any = None, bootstrap: Any = None) -> str:
            nonlocal active_identity
            from .codex_environment import probe_environment, effective_probe_policy
            active_identity = replace(identity, runner_version=getattr(conn, 'server_version', ''))
            scope = self._loop_environment_scope(active_identity)
            if diagnostic:
                diagnostic.mark('environment_check', environmentCheckStartedAt=time.time())
            try:
                dependencies = await self._loop_environment_dependencies(session, state)
            except WorkflowSelectionError:
                check = new_check(active_identity, status='blocked', reason='env_unknown',
                                  dependencyId='workflow', probePath='host', quiesced=True, scope=scope, boundary=boundary)
                raise EnvironmentPause(record_check(check)) from None
            require_current()
            if explicit and any(b.get('dependencyId') == 'workflow' and b.get('scope') == scope
                                for b in normalize_environment(state.execution_environment)['blockers']):
                record_check(new_check(active_identity, status='passed',
                    dependencyId='workflow', probePath='host', scope=scope, quiesced=True, boundary=boundary), clear=True)
            old_block = self._loop_environment_blocker(state, active_identity)
            # 自动入口不重复试探持续故障；显式检查/恢复才核对修复证据。
            if old_block and not explicit:
                raise EnvironmentPause(old_block)
            check = None
            supported = getattr(backend, 'execution_environment_capabilities', lambda _i: {})(active_identity).get('supported')
            policy = None
            if conn is not None and supported:
                try:
                    policy = await effective_probe_policy(conn, active_identity, bootstrap)
                    active_identity = replace(active_identity, config_revision=digest([identity.config_revision, policy]))
                except EnvironmentError as exc:
                    check = new_check(active_identity, status='unsupported' if exc.code == 'env_probe_unsupported' else 'blocked',
                        reason=exc.code, coverage='native_policy', probePath='command/exec', quiesced=exc.quiesced)
            require_current(check)
            cache = getattr(self, '_loop_environment_cache', {})
            cache_key = (active_identity.fingerprint, boundary)
            cached = check is None and not explicit and not old_block and check_matches(cache.get(cache_key, {}), active_identity)
            if cached:
                check = cache[cache_key]
            else:
                if check is not None:
                    pass
                elif conn is None or not supported:
                    check = new_check(active_identity, status='unsupported', reason='env_probe_unsupported', quiesced=True)
                else:
                    try:
                        candidate = discover_openspec(identity.workspace, backend._build_env()) if dependencies else {}
                        # host discovery 只选入口，不把“未找到”当作原生拒绝。
                        if candidate.get('reasonCode') in ('env_access_denied', 'env_probe_failed'):
                            check = new_check(active_identity, status='blocked', reason=candidate['reasonCode'],
                                              dependencyId='openspec', probePath='host', quiesced=True)
                        else:
                            check = await probe_environment(conn, active_identity, dependencies=dependencies,
                                entry=candidate.get('entry', ''), policy=policy,
                                system_root=backend._build_env().get('SYSTEMROOT', ''))
                    except EnvironmentError as exc:
                        check = new_check(active_identity, status='unsupported' if exc.code == 'env_probe_unsupported' else 'blocked',
                            reason=exc.code, coverage='native_policy', probePath='command/exec', quiesced=exc.quiesced)
                check = record_check(check, clear=explicit)
                if check['status'] == 'stale':
                    raise EnvironmentPause(check)
                if check['status'] == 'passed':
                    cache[cache_key] = check
                    self._loop_environment_cache = dict(list(cache.items())[-128:])
            if diagnostic:
                diagnostic.mark('environment_checked', environmentCheckId=check['id'],
                                environmentCheckEndedAt=time.time(), executionEnvironment=active_identity.summary())
            blocker = self._loop_environment_blocker(state, active_identity)
            if check['status'] == 'blocked' or blocker:
                raise EnvironmentPause(blocker or check)
            if conn is not None and getattr(conn, 'proc', True) is None:
                raise EnvironmentPause(check)
            return entry_hint(check, active_identity)

        async def gate(conn: Any = None, bootstrap: Any = None) -> str:
            locks = getattr(self, '_loop_environment_locks', None)
            if locks is None:
                locks = self._loop_environment_locks = {}
            key = (identity.fingerprint, boundary)
            lock, users = locks.get(key, (asyncio.Lock(), 0))
            locks[key] = (lock, users + 1)
            try:
                async with lock:
                    return await asyncio.wait_for(probe_gate(conn, bootstrap), 30)
            except asyncio.TimeoutError:
                if conn is not None:
                    await conn.close()
                check = new_check(active_identity, status='blocked', reason='env_probe_timeout',
                    coverage='native_policy', probePath='command/exec', scope=self._loop_environment_scope(active_identity),
                    quiesced=conn is None or getattr(conn, 'cleanup_confirmed', False), boundary=boundary)
                raise EnvironmentPause(record_check(check)) from None
            except asyncio.CancelledError as exc:
                if conn is not None:
                    await conn.close()
                check = new_check(active_identity, status='blocked', reason='env_probe_failed',
                    probePath='command/exec', scope=self._loop_environment_scope(active_identity),
                    quiesced=getattr(exc, 'probe_quiesced', False) or conn is None or getattr(conn, 'cleanup_confirmed', False), boundary=boundary)
                record_check(check)
                raise
            finally:
                _, users = locks[key]
                if users == 1:
                    locks.pop(key)
                else:
                    locks[key] = (lock, users - 1)

        def observer(kind: str, data: dict) -> None:
            from .codex_environment import native_error_code
            if kind == 'cleanup':
                if data.get('quiesced') is not True:
                    if not hasattr(self, '_loop_environment_orphans'):
                        self._loop_environment_orphans = {}
                    self._loop_environment_orphans.setdefault(session.id, []).append({
                        'connection': data['connection'], 'scope': self._loop_environment_scope(active_identity)})
                    self._loop_environment_record(state, record, new_check(active_identity, status='blocked',
                        reason='env_probe_failed', scope=self._loop_environment_scope(active_identity),
                        probePath='command/exec', quiesced=False, boundary=boundary))
                return
            if kind == 'preflight':
                # 回写异常携带的检查，使外层复查也能识别 stale 并停止旧流程。
                data.update(record_check(data))
                return
            if not unchanged():
                return
            reason = native_error_code(data) if kind == 'nativeError' else ''
            if kind == 'nativeError' and reason not in ('env_access_denied', 'env_runner_setup_failed'):
                return
            if kind == 'commandExecution' and data.get('exitCode') == 0 and data.get('status') == 'completed':
                status = 'passed'
            elif kind == 'commandExecution':
                status, reason = 'stale', 'env_unknown'  # 任意业务 stdout/失败不能伪造确定环境分类
            else:
                status = 'blocked'
            check = new_check(active_identity, status=status, reason=reason, coverage='actual_tool',
                probePath='commandExecution', scope=self._loop_environment_scope(active_identity), boundary=boundary,
                basisRefs=[str(data.get('id', 'native-error'))[:120]], quiesced=True)
            self._loop_environment_cache = {}
            self._loop_environment_record(state, record, check)

        return gate, observer

    def _loop_environment_editable(self, session: Any, state: Any, expected_revision: int, *, select: bool = False) -> None:
        if not state or getattr(session, 'session_type', '') != 'loop':
            raise WorkflowSelectionError('仅 LOOP 支持此操作。')
        if self._loop_control_reserved(session.id):
            raise WorkflowSelectionError('控制权正在转交，执行环境仅可查看。')
        if (self._loop_is_running(session.id) or self._loop_has_active_call(session.id)
                or any(key[0] == session.id for key in getattr(self, '_loop_environment_requests', {}))
                or self._session_destroy_busy_reason(session.id) or state.control_mode != 'loop'):
            raise WorkflowSelectionError('运行中或人工接管中，执行环境仅可查看。')
        if not select and any(not b['quiesced'] for b in normalize_environment(state.execution_environment)['blockers']):
            raise WorkflowSelectionError('旧检查进程退出尚未确认，不能启动新检查或更换工作流。')
        if type(expected_revision) is not int or expected_revision != normalize_environment(state.execution_environment)['revision']:
            raise WorkflowSelectionError('环境修订已变化，请刷新后重试。')
        last = state.loops[-1] if state.loops else None
        if select and last and not last.completed and not last.error and not last.terminal_kind:
            raise WorkflowSelectionError('仍有可恢复记录，不能改变其工作流依赖。')

    async def _rpc_loopExecutionEnvironmentGet(self, session_id: str) -> str:
        self._require_session_access(session_id)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        if not session:
            return json.dumps({'status': 'error', 'message': 'Session 不存在。'}, ensure_ascii=False)
        state = self._loop_state(session_id)
        choices = await asyncio.to_thread(workflow_choices, session, self._skill_store)
        return json.dumps({'status': 'ok', 'sessionId': session_id,
                           'environment': normalize_environment(state.execution_environment if state else {}),
                           'choices': choices}, ensure_ascii=False)

    async def _rpc_loopExecutionEnvironmentSelectWorkflow(self, session_id: str, command: str,
                                                         declaration_digest: str, expected_revision: int) -> str:
        self._require_session_access(session_id)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        state = self._loop_state(session_id)
        try:
            self._loop_environment_editable(session, state, expected_revision, select=True)
            goal = state.goal
            reference = await asyncio.to_thread(select_workflow, session, self._skill_store,
                command, declaration_digest, goal, revision=expected_revision + 1)
            self._loop_environment_editable(session, state, expected_revision, select=True)
            if goal != state.goal:
                raise WorkflowSelectionError('目标已变化，请刷新后重新选择。')
            previous = normalize_environment(state.execution_environment)
            # 选择不清除历史阻塞，不开启 Auto，不绑定 change。
            state.execution_environment = {**previous, 'workflowRef': reference,
                                           'revision': expected_revision + 1, 'status': 'stale'}
            self._loop_save(state)
            self._emit_loop_updated(state)
            return json.dumps({'status': 'ok', 'sessionId': session_id,
                               'environment': normalize_environment(state.execution_environment)}, ensure_ascii=False)
        except WorkflowSelectionError as exc:
            return json.dumps({'status': 'error', 'message': str(exc)}, ensure_ascii=False)

    def _loop_environment_executor(self) -> str:
        manager = getattr(self, '_relay_runtime_manager', None)
        return (manager.status().get('deviceId') if manager else '') or (
            'local:' + digest([platform.node(), str(Path.home())])[:20])

    def _loop_execution_identity(self, session: Any, backend: Any, backend_id: str,
                                 stage: str, access: str, kwargs: dict) -> ExecutionIdentity:
        from .codex_office import CodexOfficeBackend, resolve_codex_cli
        config = getattr(backend, 'config', None)
        # 配置值只在已有执行进程内比较；持久化的是不含凭据摘要的随机修订。
        if not hasattr(self, '_loop_environment_config_versions'):
            self._loop_environment_config_versions = {}
        versions = self._loop_environment_config_versions
        snapshot = copy.deepcopy(vars(config)) if config else {}
        old = versions.get(backend_id)
        if old is None or old[0] != snapshot:
            if len(versions) >= 256:
                versions.pop(next(iter(versions)))
            versions[backend_id] = (snapshot, uuid.uuid4().hex)
        native = isinstance(backend, CodexOfficeBackend)
        env = backend._build_env() if native else {
            **os.environ, **{k: str(v) for k, v in (getattr(config, 'env', None) or {}).items() if v is not None}}
        transport = ('ssh' if kwargs.get('remote_host') else 'app-server' if kwargs.get('app_server_local') else 'exec') if native else 'api'
        runner = resolve_codex_cli(getattr(config, 'cli_path', None)) if native and transport != 'ssh' else ''
        state = self._loop_state(session.id)
        workflow = (getattr(state, 'execution_environment', {}) or {}).get('workflowRef', {})
        return ExecutionIdentity(
            owner=getattr(session, 'owner_id', 'local'), executor=self._loop_environment_executor(),
            session_id=session.id, workspace=kwargs['working_dir'] or getattr(config, 'working_dir', None) or '.',
            backend_id=backend_id, transport=transport, role=stage, access=access,
            config_revision=versions[backend_id][1], runner=runner,
            toolchain_revision=toolchain_revision(env), workflow_revision=digest(workflow),
            control_mode=getattr(state, 'control_mode', 'loop'))
