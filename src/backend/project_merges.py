"""汇合先在独立空间准备；只有冻结计划与真实 Git 条件均满足才快进目标。"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import time
import uuid
from typing import Any

from . import paths
from .task_git import TaskGit, canonical_path
from .session_collaboration_store import CollaborationError, fingerprint
from .project_merge_workflow import ProjectMergeWorkflow
from .project_merge_repair import ProjectMergeRepair
from ..types import Session

FINAL = {'succeeded', 'cancelled', 'error'}


class ProjectMerges(ProjectMergeRepair, ProjectMergeWorkflow):
    def _merge_job_key(self, scope: Any, operation: str) -> str:
        return fingerprint([scope.owner, scope.executor, operation])

    def _merge_identity(self, session_id: str) -> dict:
        session = self._task_source(session_id)
        state = self._loop_state(session_id) if session.session_type == 'loop' else None
        return {'workspace': self._workbench_identity(session_id).to_dict(), 'backendId': session.backend_id,
            'runtime': {'model': session.model_override, 'reasoningEffort': session.reasoning_effort},
            'constraints': session.constraints, 'skills': session.abilities, 'skipPermissions': session.skip_permissions,
            'controlRevision': state.control_revision if state else 0, 'controlMode': state.control_mode if state else 'manual'}

    def _merge_recheck_identity(self, row: dict) -> None:
        if row.get('integrationParentId') and self._task_root_id(row['target']['sessionId']) != row['integrationParentId']:
            raise CollaborationError('主 Session 关系已变化，请重新预览')
        for key in ('source', 'target'):
            if self._merge_identity(row[key]['sessionId']) != row[key]['identity']:
                raise CollaborationError('来源/目标身份、运行配置或控制权已变化，请重新预览')

    def _rpc_projectMergeDiscover(self, origin: str, query: str = '') -> str:
        source = self._task_source(origin)
        if not isinstance(query, str) or len(query) > 120: raise CollaborationError('查询过长')
        items = []
        for row in self._session_store.list():
            if row.get('ownerId', 'local') != self._current_owner_id() or not row.get('workingDir'): continue
            if query and query.casefold() not in str(row.get('title', '')).casefold() and row['id'] != query: continue
            if row.get('relationKind') == 'review' or row.get('codexConnectionMode') == 'ssh': continue
            items.append({key: row.get(key) for key in ('id', 'title', 'workingDir', 'parentSessionId', 'relationKind')})
        return json.dumps({'items': items[:100], 'truncated': len(items) > 100,
            'notice': '仅本节点真实 Session；预览时核对同一仓库，重名必须明确 ID。'}, ensure_ascii=False)

    def _merge_jobs(self) -> dict[str, asyncio.Task]:
        if not hasattr(self, '_project_merge_jobs'): self._project_merge_jobs = {}
        return self._project_merge_jobs

    def _merge_row(self, origin: str, operation: str) -> tuple[Any, Any, dict]:
        scope, store = self._collaboration_scope(origin), self._collaboration_store()
        row = store.read(scope, 'merge', operation)
        if not row or row['sourceSessionId'] != origin: raise CollaborationError('汇合请求不属于本会话')
        self._require_session_access(row['source']['sessionId']); self._require_session_access(row['target']['sessionId'])
        return scope, store, row

    def _merge_update(self, scope: Any, row: dict, **changes: Any) -> dict:
        updated = self._collaboration_store().write(scope, 'merge', row['id'], {**row, **changes}, row['revision'])
        self._emit_event('projectMergeUpdated', {**{key: updated[key] for key in ('id', 'revision', 'sourceSessionId', 'status', 'title')},
            'actualSourceSessionId': updated['source']['sessionId'], 'targetSessionId': updated['target']['sessionId'],
            'integrationSessionId': (updated.get('integration') or {}).get('sessionId', '')})
        if updated.get('integration'):
            self._emit_session_updated({'type': 'merge_updated', 'sessionId': updated['integration']['sessionId']})
        return updated

    async def _rpc_projectMergePreview(self, origin: str, source_id: str, target_id: str, request_id: str) -> str:
        self._window_guard(origin)
        source, target = self._task_source(source_id), self._task_source(target_id)
        if source_id == target_id or canonical_path(source.working_dir) == canonical_path(target.working_dir):
            raise CollaborationError('请选择不同的来源和目标工作区')
        scope, store = self._collaboration_scope(origin), self._collaboration_store()
        identities = {'source': self._merge_identity(source_id), 'target': self._merge_identity(target_id)}
        receipt, fresh = store.begin_request(scope, request_id, 'mergePreview', {'sessionId': origin, 'sourceId': source_id, 'targetId': target_id})
        if not fresh: return await self._rpc_projectMergeStatus(origin, request_id)
        try:
            source_repo, target_repo = await asyncio.gather(asyncio.to_thread(lambda: TaskGit(source.working_dir).inspect()), asyncio.to_thread(lambda: TaskGit(target.working_dir).inspect()))
            if self._merge_identity(source_id) != identities['source'] or self._merge_identity(target_id) != identities['target']:
                raise CollaborationError('核对期间 Session 身份变化')
            if source_repo['repositoryId'] != target_repo['repositoryId']: raise CollaborationError('来源和目标不是同一真实 Git 仓库')
            blockers = []
            if source_repo['dirty']: blockers.append('来源有未提交内容；请在来源提交或显式创建选定路径快照任务')
            if target_repo['dirty']: blockers.append('目标有未提交内容，请先处理')
            if not target_repo['branch']: blockers.append('目标处于游离 HEAD，请明确选择目标分支')
            activity = self._project_activity(target_repo['root'])
            source_activity = self._project_activity(source_repo['root'])
            blockers.extend(row['reason'] for row in activity)
            blockers.extend('来源：' + row['reason'] for row in source_activity)
            for identity in identities.values():
                if identity['controlMode'] != 'manual': blockers.append('LOOP 仍持有控制权，请先明确接管')
            def changes() -> list[str]:
                git = TaskGit(target_repo['root']); git.disable_filters()
                raw = git.run('diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', target_repo['head'] + '...' + source_repo['head'])
                names = [value.decode('utf-8') for value in raw.split(b'\0') if value]
                if len(names) > 1000: raise CollaborationError('变化超过1000个路径，请拆分汇合范围')
                return names
            files = await asyncio.to_thread(changes)
            syncing = (target.parent_session_id == source_id and target.relation_kind == 'task'
                       and origin == target_id)
            fast_forward = syncing and await asyncio.to_thread(lambda:
                TaskGit(target_repo['root']).run('merge-base', target_repo['head'], source_repo['head']).decode().strip() == target_repo['head'])
            plan = {'sourceSessionId': origin, 'createdAt': time.time(), 'title': f'{source.title} → {target.title}', 'status': 'blocked' if blockers else 'preview',
                'direction': 'sync_main' if syncing else 'merge', 'fastForward': bool(fast_forward),
                'source': {'sessionId': source_id, 'title': source.title, **source_repo, 'identity': identities['source']}, 'target': {'sessionId': target_id, 'title': target.title, **target_repo, 'identity': identities['target']},
                'files': files, 'blockers': blockers, 'activity': activity, 'sourceActivity': source_activity,
                'integrationParentId': self._task_root_id(target_id),
                'integrationConfig': {'backendId': target.backend_id, 'model': target.model_override, 'reasoningEffort': target.reasoning_effort, 'skipPermissions': False},
                'policy': '独立整合空间准备，实际检查冲突后仅快进目标；不自动 push、stash、硬重置或清理。',
                'verification': {'status': 'not_run', 'notice': '尚未运行项目测试；Git 合并不代表功能验收。'}}
            plan['planFingerprint'] = fingerprint(plan)
            row = store.write(scope, 'merge', request_id, plan, 0)
            store.finish_request(scope, request_id, receipt['revision'], 'succeeded', {'operationId': request_id})
            return json.dumps(row, ensure_ascii=False)
        except BaseException as error:
            store.finish_request(scope, request_id, receipt['revision'], 'failed', {'notice': str(error)[:600]})
            raise

    def _rpc_projectMergePrepare(self, origin: str, operation: str, request_id: str, plan_fingerprint: str) -> str:
        self._window_guard(origin); self._require_update_work_allowed()
        scope, store, row = self._merge_row(origin, operation)
        intent = {'sessionId': origin, 'operation': operation, 'fingerprint': plan_fingerprint}
        if store.request(scope, request_id):
            store.begin_request(scope, request_id, 'mergePrepare', intent)
            return json.dumps(row, ensure_ascii=False)
        if row['status'] != 'preview' or row['planFingerprint'] != plan_fingerprint: raise CollaborationError('计划不可执行或已变化，请重新预览')
        self._merge_recheck_identity(row)
        receipt, _ = store.begin_request(scope, request_id, 'mergePrepare', intent)
        row = self._merge_update(scope, row, status='preparing', prepareRequestId=request_id)
        task = asyncio.create_task(self._merge_prepare_owned(scope, row, receipt))
        job_key = self._merge_job_key(scope, operation)
        self._merge_jobs()[job_key] = task
        task.add_done_callback(lambda done: self._merge_jobs().pop(job_key, None))
        return json.dumps(row, ensure_ascii=False)

    async def _merge_prepare_owned(self, scope: Any, row: dict, receipt: dict) -> None:
        store = self._collaboration_store()
        try:
            sid = 'integration-' + uuid.uuid5(uuid.NAMESPACE_URL, fingerprint([scope.owner, scope.executor, row['id']])).hex
            parent_id = row.get('integrationParentId') or self._task_root_id(row['target']['sessionId'])
            root = paths.sub('task-workspaces', fingerprint([scope.owner, scope.executor])[:32], sid)
            row = self._merge_update(scope, row, integration={'sessionId': sid, 'root': str(root), 'conflicts': []})
            workspace = store.write(scope, 'workspace', sid, {'sourceSessionId': row['sourceSessionId'], 'parentSessionId': parent_id,
                'sessionId': sid, 'title': '整合 · ' + row['title'], 'root': str(root), 'branch': 'awu/integration/' + sid,
                'status': 'creating', 'relationKind': 'integration', 'repository': row['target'], 'mergeOperationId': row['id'],
                'planFingerprint': row['planFingerprint'], 'config': {'title': '整合 · ' + row['title'], 'goal': '',
                    'backendId': row['integrationConfig']['backendId'], 'runtime': {}, 'constraints': '', 'skills': [], 'skipPermissions': False, 'includePaths': []}}, 0)
            self._merge_recheck_identity(row)
            if self._project_activity(row['source']['root']) or self._project_activity(row['target']['root']):
                raise CollaborationError('来源或目标开始活动，请等待空闲并重新预览')
            def prepare() -> dict:
                source = TaskGit(row['source']['root']).inspect()
                target_git = TaskGit(row['target']['root']); target = target_git.inspect()
                if source['fingerprint'] != row['source']['fingerprint'] or target['fingerprint'] != row['target']['fingerprint']:
                    raise CollaborationError('来源或目标已变化，请重新预览；目标未修改')
                actual = target_git.create(target, root, 'awu/integration/' + sid, [], root.parent / '.scratch')
                git = TaskGit(str(root)); git.disable_filters()
                git.merge(row['source']['head'], fast_forward=row.get('fastForward', False))
                conflicts = [item.decode('utf-8') for item in git.run('diff', '--name-only', '--diff-filter=U', '-z').split(b'\0') if item]
                final = git.inspect()
                if not conflicts and final['dirty']: raise CollaborationError('整合未形成干净候选，保留独立空间')
                if not conflicts and git.run('merge-base', row['source']['head'], final['head']).decode().strip() != row['source']['head']:
                    raise CollaborationError('Git 未形成包含来源的候选，保留空间等待处理')
                return {'sessionId': sid, 'root': str(root), 'actual': final, 'baseline': actual['head'], 'conflicts': conflicts}
            result = await asyncio.to_thread(prepare)
            self._merge_row(row['sourceSessionId'], row['id'])
            self._merge_recheck_identity(row)
            target = self._task_source(row['target']['sessionId'])
            child = Session(id=result['sessionId'], title='整合 · ' + row['title'], created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=result['root'], backend_id=target.backend_id, owner_id=scope.owner,
                parent_session_id=parent_id, relation_kind='integration', project_group_id=parent_id, workspace_id=result['sessionId'],
                model_override=target.model_override, reasoning_effort=target.reasoning_effort, skip_permissions=False)
            workspace = store.write(scope, 'workspace', child.id, {'sourceSessionId': row['sourceSessionId'], 'parentSessionId': parent_id,
                'sessionId': child.id, 'title': child.title, 'root': child.working_dir, 'branch': result['actual']['branch'], 'status': 'ready',
                'relationKind': 'integration', 'actual': result['actual'], 'repository': row['target'], 'mergeOperationId': row['id'],
                'planFingerprint': row['planFingerprint'], 'config': {'title': child.title, 'goal': '', 'backendId': child.backend_id, 'runtime': {},
                    'constraints': '', 'skills': [], 'skipPermissions': False, 'includePaths': []}}, workspace['revision'])
            await asyncio.to_thread(self._session_store.save, child, async_=False)
            if not self._session_store.load(child.id): raise CollaborationError('整合 Session 落盘失败')
            self._active_sessions[child.id] = child
            row = self._merge_update(scope, row, status='conflict' if result['conflicts'] else 'candidate', integration=result,
                candidate=result['actual']['head'] if not result['conflicts'] else '', notice='原目标保持不变。请在整合会话中明确启动修复/测试，并核对候选。')
            store.finish_request(scope, receipt['requestId'], receipt['revision'], 'succeeded', {'operationId': row['id'], 'integrationSessionId': child.id})
            self._emit_session_updated({'type': 'session_created', 'sessionId': child.id, 'summary': child.meta_dict()})
        except BaseException as error:
            self._merge_failed(scope, row, receipt, str(error) or '整合准备退出未知', unknown=isinstance(error, asyncio.CancelledError))

    def _merge_failed(self, scope: Any, row: dict, receipt: dict, notice: str, *, unknown: bool = False) -> None:
        try:
            store = self._collaboration_store(); current = store.read(scope, 'merge', row['id'])
            self._merge_update(scope, current, status='unknown' if unknown else 'error', notice=notice[:1000] + '；原成果保留，未自动重试。')
            saved = store.request(scope, receipt['requestId'])
            if saved['status'] not in {'succeeded', 'failed', 'cancelled'}:
                store.finish_request(scope, saved['requestId'], saved['revision'], 'unknown' if unknown else 'failed', {'notice': notice[:1000]})
        except Exception: pass

    async def _rpc_projectMergeVerify(self, origin: str, operation: str) -> str:
        self._window_guard(origin)
        scope, store, row = self._merge_row(origin, operation)
        recovering = row['status'] == 'error' and bool(row.get('applyRequestId'))
        if recovering:
            # 只恢复已落盘的确定失败；未知退出/持久写入预留绝不能借 Verify 解除。
            receipt = store.request(scope, row['applyRequestId'])
            if (not receipt or receipt['kind'] != 'mergeApply' or receipt['status'] != 'failed'
                    or receipt['sessionId'] != origin or not row.get('integration') or not row.get('candidate')
                    or self._merge_job_key(scope, operation) in self._merge_jobs()
                    or any(gate['operationId'] == operation and gate['owner'] == scope.owner
                           for gate in store.project_gates(scope.executor))):
                raise CollaborationError('上次应用尚未确认失败或退出，请查询原操作，不能重新启用候选')
            self._merge_recheck_identity(row)
        elif row['status'] not in {'conflict', 'candidate'}:
            raise CollaborationError('当前汇合不在候选核对阶段')
        integration = row['integration']; self._require_session_access(integration['sessionId'])
        if self._project_activity(integration['root']): raise CollaborationError('整合会话仍在活动，请等待实际退出后核对')
        def verify() -> dict:
            if recovering:
                for side in ('source', 'target'):
                    if TaskGit(row[side]['root']).inspect()['fingerprint'] != row[side]['fingerprint']:
                        raise CollaborationError('来源或目标已变化，不能恢复旧候选，请重新预览')
            git = TaskGit(integration['root']); result = git.inspect()
            conflicts = git.run('diff', '--name-only', '--diff-filter=U', '-z')
            if conflicts or result['dirty']: raise CollaborationError('仍有冲突或未提交修改，可在本请求继续修复并生成候选提交')
            for original in (row['source']['head'], row['target']['head']):
                ancestor = git.run('merge-base', original, result['head']).decode().strip()
                if ancestor != original: raise CollaborationError('候选没有保留来源与目标历史，不能应用')
            if result['repositoryId'] != row['target']['repositoryId']: raise CollaborationError('整合仓库身份变化')
            return result
        result = await asyncio.to_thread(verify)
        self._merge_row(origin, operation)
        if self._project_activity(integration['root']): raise CollaborationError('核对期间整合会话开始活动，请等待后再核对')
        current = store.read(scope, 'merge', operation)
        if current['revision'] != row['revision']: raise CollaborationError('汇合状态已变化，请重新核对')
        recovery_notice = {'notice': '已重新核对原候选；上次失败回执保留，仍需单独确认应用。'} if recovering else {}
        row = self._merge_update(scope, row, **recovery_notice, status='candidate', candidate=result['head'], integration={**integration, 'actual': result, 'conflicts': []},
            verification={'status': 'git_verified', 'head': result['head'], 'notice': '已核对无冲突、干净工作树及双亲历史；项目测试结果请在整合会话查看，本检查不声明功能通过。'})
        return json.dumps(row, ensure_ascii=False)

    async def _rpc_projectMergeStatus(self, origin: str, operation: str) -> str:
        scope, store, row = self._merge_row(origin, operation)
        job_key = self._merge_job_key(scope, operation)
        if row.get('applyRequestId') and row['status'] in {'applying', 'unknown'} and job_key not in self._merge_jobs():
            gate = next((gate for gate in store.project_gates(scope.executor) if gate['operationId'] == operation and gate['owner'] == scope.owner), None)
            exited = gate and gate.get('exitConfirmed')
            if gate and not exited and gate.get('pid'):
                exited = process_exited(gate['pid'])
            if gate and exited:
                actual = await asyncio.to_thread(lambda: TaskGit(row['target']['root']).inspect())
                if actual['repositoryId'] == row['target']['repositoryId'] and actual['branch'] == row['target']['branch'] and not actual['dirty'] and actual['head'] in {row['candidate'], row['target']['head']}:
                    applied = actual['head'] == row['candidate']
                    row = self._merge_update(scope, row, status='succeeded' if applied else 'error', finalHead=actual['head'], notice='已只读核实最终提交，未重放合并。' if applied else '已确认 Git 退出且目标未应用；可重新预览。')
                    receipt = store.request(scope, row['applyRequestId'])
                    if receipt and receipt['status'] not in {'succeeded', 'failed', 'cancelled'}:
                        store.finish_request(scope, receipt['requestId'], receipt['revision'], 'succeeded' if applied else 'failed', {'head': actual['head'], 'reconciled': True})
                    store.project_gate_remove(scope.executor, gate['root'], operation)
                    lease = self._project_state()['reservations'].get(gate['root'])
                    if lease: await self._project_release(lease, committed=applied)
        if row['status'] in {'preparing', 'applying'} and job_key not in self._merge_jobs():
            row = {**row, 'status': 'unknown', 'notice': '原操作结果未知，请核对最终 OID；没有自动重放。'}
        return json.dumps(row, ensure_ascii=False)

    def _rpc_projectMergeApply(self, origin: str, operation: str, request_id: str, candidate: str, plan_fingerprint: str) -> str:
        self._window_guard(origin); self._require_update_work_allowed()
        scope, store, row = self._merge_row(origin, operation)
        intent = {'sessionId': origin, 'operation': operation, 'candidate': candidate, 'fingerprint': plan_fingerprint}
        if store.request(scope, request_id):
            store.begin_request(scope, request_id, 'mergeApply', intent)
            return json.dumps(row, ensure_ascii=False)
        if row['status'] != 'candidate' or row.get('candidate') != candidate or row['planFingerprint'] != plan_fingerprint or row['verification'].get('head') != candidate:
            raise CollaborationError('请先核对并确认当前候选，不能使用过期计划')
        self._merge_recheck_identity(row)
        receipt, _ = store.begin_request(scope, request_id, 'mergeApply', intent)
        row = self._merge_update(scope, row, status='applying', applyRequestId=request_id)
        task = asyncio.create_task(self._merge_apply_owned(scope, row, receipt))
        job_key = self._merge_job_key(scope, operation)
        self._merge_jobs()[job_key] = task
        task.add_done_callback(lambda done: self._merge_jobs().pop(job_key, None))
        return json.dumps(row, ensure_ascii=False)

    async def _merge_apply_owned(self, scope: Any, row: dict, receipt: dict) -> None:
        lease = None; started = False; committed = False; unknown = False
        store = self._collaboration_store()
        try:
            lease = await self._project_reserve(row['target']['sessionId'], row['id'])
            self._merge_recheck_identity(row)
            if self._project_activity(row['source']['root']) or self._project_activity(row['integration']['root']):
                raise CollaborationError('来源或整合空间仍有活动')
            def apply() -> dict:
                target_git = TaskGit(row['target']['root'])
                for key, expected in (('source', row['source']), ('target', row['target']), ('integration', row['integration']['actual'])):
                    actual = TaskGit(row[key]['root']).inspect()
                    if actual['fingerprint'] != expected['fingerprint']: raise CollaborationError('提交或工作树已变化，未应用旧计划')
                gate = {'root': lease['root'], 'owner': scope.owner, 'operationId': row['id'], 'phase': 'applying', 'exitConfirmed': False}
                store.project_gate_save(scope.executor, gate)
                def lifecycle(pid: int, exited: bool) -> None:
                    store.project_gate_save(scope.executor, {**gate, 'pid': pid, 'exitConfirmed': exited})
                target_git.merge(row['candidate'], fast_forward=True, lifecycle=lifecycle)
                return target_git.inspect()
            started = True
            worker = asyncio.create_task(asyncio.to_thread(apply))
            # 断开请求或取消等待者不取消实际 Git 工作线程。
            result = await asyncio.shield(worker)
            if result['head'] != row['candidate'] or result['dirty'] or result['branch'] != row['target']['branch'] or result['repositoryId'] != row['target']['repositoryId']:
                raise CollaborationError('写入后状态不一致，保留预留；请核对原操作')
            committed = True
            row = self._merge_update(scope, row, status='succeeded', finalHead=result['head'], notice='已快进目标，来源和整合空间保留；没有推送或清理。')
            store.finish_request(scope, receipt['requestId'], receipt['revision'], 'succeeded', {'head': result['head'], 'targetSessionId': row['target']['sessionId']})
        except BaseException as error:
            gate = next((gate for gate in store.project_gates(scope.executor) if gate['operationId'] == row['id'] and gate['owner'] == scope.owner), None)
            unknown = started and (isinstance(error, asyncio.CancelledError) or bool(gate and gate['phase'] == 'applying'))
            self._merge_failed(scope, row, receipt, str(error) or '应用退出未知', unknown=unknown)
        finally:
            if lease and not unknown: await self._project_release(lease, committed=committed)

    def _rpc_projectMergeCancel(self, origin: str, operation: str, request_id: str) -> str:
        self._window_guard(origin)
        scope, store, row = self._merge_row(origin, operation)
        if row['status'] in {'applying', 'unknown', 'succeeded'} or self._merge_job_key(scope, operation) in self._merge_jobs():
            raise CollaborationError('操作已可能执行，不能宣称撤回；请查询原回执，成果保留')
        receipt, fresh = store.begin_request(scope, request_id, 'mergeCancel', {'sessionId': origin, 'operation': operation})
        if fresh:
            row = self._merge_update(scope, row, status='cancelled', notice='已取消后续应用；保留来源、目标和整合空间。')
            store.finish_request(scope, request_id, receipt['revision'], 'cancelled', {'operationId': operation})
        return json.dumps(row, ensure_ascii=False)

def process_exited(pid: int) -> bool:
    """只读退出核对；PID 复用只会保守保留预留，不用于终止进程。"""
    if type(pid) is not int or pid <= 0: return False
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]; kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]; kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle: return ctypes.get_last_error() == 87
        try: return kernel.WaitForSingleObject(handle, 0) == 0
        finally: kernel.CloseHandle(handle)
    try: os.kill(pid, 0)
    except ProcessLookupError: return True
    except OSError: return False
    return False
