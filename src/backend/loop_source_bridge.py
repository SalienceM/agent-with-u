"""Session-routed LOOP source operations, hosted by the existing BridgeWS owner."""
from __future__ import annotations

import copy
import json
import platform
from pathlib import Path
from typing import Any

from .loop_decisions import digest
from .loop_task_source import (TaskSourceReader, SourceError, environment, snapshot_fresh,
                               scope_diff, source_summary)


class LoopSourceBridge:
    def _loop_source_reader(self) -> TaskSourceReader:
        if not hasattr(self, '_loop_task_reader'):
            self._loop_task_reader = TaskSourceReader()
        return self._loop_task_reader

    def _loop_source_environment(self, session: Any, state: Any) -> tuple[dict, dict]:
        backend_id = state.policy.backend_for('execute') or session.backend_id
        config = next((c for c in self._backend_configs if c.id == backend_id), None)
        if config is None:
            raise SourceError('backend_missing', '指定的 execute Backend 已不存在，不会静默借用其他来源环境。')
        manager = getattr(self, '_relay_runtime_manager', None)
        executor = (manager.status().get('deviceId') if manager else '') or ('local:' + digest([platform.node(), str(Path.home())])[:20])
        return environment(session, config, executor)

    def _loop_source_editable(self, state: Any, expected_revision: int) -> None:
        if self._loop_is_running(state.session_id) or state.control_mode != 'loop':
            raise SourceError('busy', 'LOOP 运行中或人工接管中，任务来源仅可查看。')
        last = state.loops[-1] if state.loops else None
        if last and not last.completed and not last.error and not last.terminal_kind:
            raise SourceError('resumable', '尚有可恢复执行，请先处理未完成记录再变更来源。')
        if type(expected_revision) is not int or expected_revision != state.task_source.get('revision', 0):
            raise SourceError('stale_revision', '来源修订已变化，请刷新后重新确认。')

    async def _rpc_loopTaskSourceDiscover(self, session_id: str) -> str:
        self._require_session_access(session_id)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        state = self._loop_state(session_id)
        try:
            if not state or session.session_type != 'loop':
                raise SourceError('session', '仅 LOOP 支持此来源入口。')
            revision = state.task_source.get('revision', 0)
            self._loop_source_editable(state, revision)
            binding, env = self._loop_source_environment(session, state)
            result = await self._loop_source_reader().read(binding, env, 'discover', revision)
            self._loop_source_editable(state, revision)
            if self._loop_source_environment(session, state)[0] != binding:
                raise SourceError('environment_changed', '执行环境已变化，请重新发现。')
            result.update(sessionId=session_id, revision=revision)
            result['discoveryId'] = digest(result)
            if not hasattr(self, '_loop_source_discoveries'):
                self._loop_source_discoveries = {}
            if len(self._loop_source_discoveries) >= 64:
                self._loop_source_discoveries.pop(next(iter(self._loop_source_discoveries)))
            self._loop_source_discoveries[session_id] = copy.deepcopy(result)
            return json.dumps({'status': 'ok', **result}, ensure_ascii=False)
        except SourceError as exc:
            return json.dumps({'status': 'error', 'code': exc.code, 'message': str(exc)}, ensure_ascii=False)

    def _rpc_loopTaskSourceGet(self, session_id: str) -> str:
        self._require_session_access(session_id)
        state = self._loop_state(session_id)
        return json.dumps({'status': 'ok', 'sessionId': session_id, 'source': state.task_source if state else {}}, ensure_ascii=False)

    async def _rpc_loopTaskSourceSet(self, session_id: str, action: str, expected_revision: int,
                                     executor: str, change: str = '', discovery_id: str = '', disposition: str = '') -> str:
        self._require_session_access(session_id)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        state = self._loop_state(session_id)
        try:
            if not state or session.session_type != 'loop' or action not in ('bind', 'unbind', 'confirm', 'refresh'):
                raise SourceError('arguments', '来源操作或 Session 无效。')
            self._loop_source_editable(state, expected_revision)
            previous = copy.deepcopy(state.task_source)
            if action == 'unbind':
                binding = previous.get('binding') or {}
                if executor != binding.get('executor') or not disposition.strip():
                    raise SourceError('disposition', '解除需核对执行节点并填写未完成范围处置依据。')
                updated = {'version': 1, 'status': 'unbound', 'revision': expected_revision + 1,
                           'scopeRevision': previous.get('scopeRevision', 0) + 1}
            else:
                binding, env = self._loop_source_environment(session, state)
                if executor != binding['executor']:
                    raise SourceError('executor_mismatch', '请求不属于当前执行节点。')
                if action == 'bind':
                    discovery = getattr(self, '_loop_source_discoveries', {}).get(session_id, {})
                    expected_binding = discovery.get('binding', {})
                    if (not discovery_id or discovery.get('discoveryId') != discovery_id
                            or discovery.get('revision') != expected_revision
                            or any(expected_binding.get(k) != value for k, value in binding.items())
                            or change not in [c['name'] for c in discovery.get('candidates', [])]):
                        raise SourceError('discovery_stale', '请先重新发现并确认真实候选。')
                    if previous.get('binding') and not disposition.strip():
                        raise SourceError('disposition', '改绑需说明旧范围及未解决问题的处置。')
                else:
                    expected_binding = previous.get('binding', {})
                    change = expected_binding.get('change', '')
                    if not change:
                        raise SourceError('unbound', '当前没有绑定来源。')
                    if any(expected_binding.get(k) != value for k, value in binding.items()):
                        raise SourceError('environment_changed', 'execute Backend/工作区/CLI 环境变化，需重新发现并确认绑定；刷新或确认范围不能改绑。')
                    if action == 'confirm' and not disposition.strip():
                        raise SourceError('disposition', '确认范围修订需填写处置依据，不代表豁免旧问题。')
                    if action == 'confirm' and previous.get('status') != 'conflict':
                        raise SourceError('no_conflict', '当前没有待确认的范围差异。')
                # 显式操作重查 CLI 版本；文件未变不等于环境未变，仍合并同边界在途查询。
                snapshot = await self._loop_source_reader().read(
                    binding, env, f'{action}:{expected_revision}', expected_revision, change, force=True)
                self._loop_source_editable(state, expected_revision)
                if self._loop_source_environment(session, state)[0] != binding:
                    raise SourceError('environment_changed', '查询期间执行环境已变化，请重新确认。')
                if expected_binding.get('cliVersion') and snapshot.get('cliVersion') != expected_binding['cliVersion']:
                    raise SourceError('environment_changed', 'OpenSpec CLI 版本变化，需重新发现并确认绑定；未采纳此次快照。')
                if action == 'confirm' and snapshot.get('scopeDigest') != previous.get('candidate', {}).get('scopeDigest'):
                    raise SourceError('scope_changed_again', '确认期间来源范围再次变化，请重新核对差异后确认。')
                changed = bool(previous.get('snapshot') and previous['snapshot'].get('scopeDigest') != snapshot['scopeDigest'])
                if action == 'refresh' and changed:
                    updated = {**previous, 'status': 'conflict', 'candidate': snapshot,
                               'diff': scope_diff(previous['snapshot'], snapshot), 'revision': expected_revision + 1}
                else:
                    updated = {'version': 1, 'revision': expected_revision + 1,
                               'scopeRevision': previous.get('scopeRevision', 0) + (1 if action in ('bind', 'confirm') else 0),
                               'binding': {**binding, 'change': change, 'cliVersion': snapshot['cliVersion']},
                               'snapshot': snapshot, 'status': 'blocked' if snapshot['cliState'] == 'blocked' else 'current'}
            # History stays bounded, carries unresolved issues and references, never erases the transcript.
            history = list(previous.get('history', []))[-19:]
            if action != 'refresh':
                history.append({'action': action, 'revision': expected_revision + 1, 'disposition': disposition[:1200],
                                'before': source_summary(previous), 'after': source_summary(updated),
                                'unresolved': copy.deepcopy(state.progress_guard),
                                'diff': scope_diff(previous.get('snapshot', {}), updated.get('snapshot', {}))})
            updated['history'] = history
            state.task_source = updated
            # Source changes do not turn on Auto, schedule work or clear other guards.
            self._loop_save(state)
            self._emit_loop_updated(state)
            return json.dumps({'status': 'ok', 'sessionId': session_id, 'source': source_summary(updated)}, ensure_ascii=False)
        except SourceError as exc:
            if (state and action in ('refresh', 'confirm') and state.task_source.get('binding')
                    and expected_revision == state.task_source.get('revision')
                    and exc.code in ('timeout', 'cli_exit', 'cli_unavailable', 'protocol', 'file_unavailable', 'change_missing', 'environment_changed', 'output_limit')):
                state.task_source.update(status='unavailable', reason=str(exc), code=exc.code)
                self._loop_save(state)
                self._emit_loop_updated(state)
            return json.dumps({'status': 'error', 'code': exc.code, 'message': str(exc)}, ensure_ascii=False)

    async def _loop_check_source(self, session: Any, state: Any, record: Any, boundary: str, *, force: bool = False) -> bool:
        source = state.task_source
        if not source or source.get('status') == 'unbound':
            return True
        revision = source.get('revision', 0)
        try:
            binding, env = self._loop_source_environment(session, state)
            original = source.get('binding', {})
            if any(binding.get(k) != original.get(k) for k in binding):
                raise SourceError('environment_changed', 'execute Backend/工作区/CLI 环境变化，需重新发现并确认来源。')
            if source.get('status') == 'conflict':
                raise SourceError('scope_conflict', '正式任务范围变化尚未确认。')
            previous = source.get('snapshot', {})
            if not force and source.get('status') == 'current' and snapshot_fresh(previous):
                snapshot = previous
            else:
                snapshot = await self._loop_source_reader().read(binding, env, f'{record.round}:{record.seq}:{boundary}', revision, original['change'])
            if (state.task_source is not source or source.get('revision', 0) != revision
                    or self._loop_source_environment(session, state)[0] != binding):
                raise SourceError('stale_revision', '查询结果属于旧来源/执行环境，未采纳。')
            if original.get('cliVersion') and snapshot.get('cliVersion') != original['cliVersion']:
                raise SourceError('environment_changed', 'OpenSpec CLI 版本变化，需重新发现并确认来源。')
            if previous and previous.get('scopeDigest') != snapshot['scopeDigest']:
                source.update(status='conflict', candidate=snapshot, diff=scope_diff(previous, snapshot), revision=revision + 1)
                raise SourceError('scope_conflict', '正式任务或验收依据变化；请空闲时确认范围差异。')
            source.update(snapshot=snapshot, status='blocked' if snapshot['cliState'] == 'blocked' else 'current', reason='', code='')
            record.source_snapshots['before' if boundary == 'prepare' else 'after'] = copy.deepcopy(snapshot)
            if snapshot['cliState'] == 'blocked':
                raise SourceError('workflow_blocked', 'OpenSpec 工作流 blocked：' + snapshot.get('instruction', '请补齐必要工件。'))
            return True
        except (SourceError, KeyError) as error:
            exc = error if isinstance(error, SourceError) else SourceError('protocol', '绑定记录不完整，请重新核对。')
            source.update(status='conflict' if exc.code == 'scope_conflict' else 'blocked' if exc.code == 'workflow_blocked' else 'unavailable',
                          reason=str(exc), code=exc.code)
            self._loop_wait(state, record, exc.code if exc.code in ('scope_conflict', 'workflow_blocked') else 'source_unavailable',
                            str(exc), '修复来源或确认范围差异后，显式恢复；不会自动解绑。')
            return False
