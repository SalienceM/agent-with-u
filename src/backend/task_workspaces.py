"""项目任务创建与回执。浏览/预览不运行模型，确认后由 owned job 建立真实 worktree。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import time
import uuid
from typing import Any

from . import paths
from .session_collaboration_store import CollaborationError, fingerprint, identifier
from .task_git import TaskGit, canonical_path
from ..types import Session


class TaskWorkspaces:
    def _rpc_taskWorkspaceArchive(self, session_id: str, workspace_id: str, request_id: str) -> str:
        self._window_guard(session_id)
        scope, store, row = self._task_workspace(session_id, workspace_id)
        if row['status'] not in {'ready', 'archived'}: raise CollaborationError('任务状态尚未确认，不能归档')
        receipt, fresh = store.begin_request(scope, request_id, 'taskArchive', {'sessionId': session_id, 'workspaceId': workspace_id})
        if fresh:
            row = self._task_update(scope, row, status='archived', notice='已归档登记；会话、分支和目录保留，运行不会被停止。')
            store.finish_request(scope, request_id, receipt['revision'], 'succeeded', {'workspaceId': workspace_id})
        return json.dumps(row, ensure_ascii=False)

    def _task_cleanup_inspect(self, scope: Any, row: dict) -> dict:
        expected_root = paths.sub('task-workspaces', fingerprint([scope.owner, scope.executor])[:32], row['id'])
        if canonical_path(expected_root) != canonical_path(row['root']) or row['status'] != 'archived' or not row.get('actual'):
            raise CollaborationError('只可清理已归档且登记可核验的本任务目录')
        actual = TaskGit(row['root']).inspect()
        if any(actual[key] != row['actual'][key] for key in ('root', 'gitDir', 'commonDir', 'repositoryId', 'branch')):
            raise CollaborationError('托管目录或分支身份变化，未清理')
        if actual['dirty']: raise CollaborationError('工作区仍有未提交内容，必须保留')
        git = TaskGit(row['root'])
        if git.run('ls-files', '--others', '--ignored', '--exclude-standard', '-z'):
            raise CollaborationError('工作区仍有忽略文件；请显式处理后再清理，未自动删除')
        if git.run('rev-parse', '--verify', 'MERGE_HEAD', allowed=(0, 1, 128)):
            raise CollaborationError('工作区仍处于未完成合并，必须保留')
        parent = self._task_source(row['parentSessionId'])
        target = TaskGit(parent.working_dir).inspect()
        if target['repositoryId'] != actual['repositoryId'] or git.run('merge-base', actual['head'], target['head']).decode().strip() != actual['head']:
            raise CollaborationError('该任务成果尚未合入父项目，必须保留')
        return {'workspace': actual, 'parent': target, 'workspaceId': row['id'],
            'notice': '仅移除已合入父项目的本任务 worktree 与分支；保留会话历史、操作回执和父项目。'}

    async def _rpc_taskWorkspaceCleanupPlan(self, session_id: str, workspace_id: str) -> str:
        self._window_guard(session_id)
        scope, store, row = self._task_workspace(session_id, workspace_id)
        if self._project_activity(row['root']): raise CollaborationError('任务仍有活动或未知退出，不能清理')
        plan = await asyncio.to_thread(self._task_cleanup_inspect, scope, row)
        self._task_workspace(session_id, workspace_id)
        plan['fingerprint'] = fingerprint(plan)
        row = self._task_update(scope, row, cleanupPlan=plan)
        return json.dumps(row, ensure_ascii=False)

    def _rpc_taskWorkspaceCleanup(self, session_id: str, workspace_id: str, request_id: str, plan_fingerprint: str) -> str:
        self._window_guard(session_id); self._require_update_work_allowed()
        scope, store, row = self._task_workspace(session_id, workspace_id)
        intent = {'sessionId': session_id, 'workspaceId': workspace_id, 'fingerprint': plan_fingerprint}
        if store.request(scope, request_id):
            store.begin_request(scope, request_id, 'taskCleanup', intent)
            return self._rpc_taskWorkspaceStatus(session_id, workspace_id)
        if row['status'] != 'archived' or row.get('cleanupPlan', {}).get('fingerprint') != plan_fingerprint:
            raise CollaborationError('请先预览并确认清理计划')
        receipt, _ = store.begin_request(scope, request_id, 'taskCleanup', intent)
        row = self._task_update(scope, row, status='cleaning', cleanupRequestId=request_id)
        job = asyncio.create_task(self._task_cleanup_owned(scope, row, receipt))
        self._task_jobs()[row['id']] = job
        job.add_done_callback(lambda done: self._task_jobs().pop(row['id'], None))
        return json.dumps(row, ensure_ascii=False)

    async def _task_cleanup_owned(self, scope: Any, row: dict, receipt: dict) -> None:
        lease = None; uncertain = False
        store = self._collaboration_store()
        try:
            lease = await self._project_reserve(row['sessionId'], 'cleanup-' + row['id'])
            def clean() -> None:
                current = self._task_cleanup_inspect(scope, {**row, 'status': 'archived'})
                if fingerprint(current) != row['cleanupPlan']['fingerprint']: raise CollaborationError('清理范围已变化，请重新预览')
                parent = TaskGit(current['parent']['root']); parent.disable_filters()
                parent.run('worktree', 'remove', '--', current['workspace']['root'], timeout=60)
                # 使用旧 OID 的 compare-and-delete；分支后来更新则拒绝删除。
                parent.run('update-ref', '-d', 'refs/heads/' + current['workspace']['branch'], current['workspace']['head'])
            uncertain = True
            await asyncio.shield(asyncio.create_task(asyncio.to_thread(clean)))
            row = self._task_update(scope, row, status='cleaned', notice='本任务 worktree 和已合并分支已清理；会话历史保留。')
            store.finish_request(scope, receipt['requestId'], receipt['revision'], 'succeeded', {'workspaceId': row['id']})
            uncertain = False
        except BaseException as error:
            self._task_update(scope, row, status='unknown' if uncertain else 'archived', notice=str(error) or '清理退出未知，未自动重试')
            store.finish_request(scope, receipt['requestId'], receipt['revision'], 'unknown' if uncertain else 'failed', {'notice': str(error)[:500]})
        finally:
            if lease and not uncertain: await self._project_release(lease, committed=True)

    def _task_git_authority(self, session_id: str) -> dict | None:
        source = self._collaboration_session(session_id)
        if not source.workspace_id:
            return None
        scope = self._collaboration_scope(session_id)
        row = self._collaboration_store().read(scope, 'workspace', source.workspace_id)
        if not row or row['sessionId'] != session_id or not row.get('actual') or canonical_path(source.working_dir) != canonical_path(row['root']):
            raise CollaborationError('托管任务工作区登记不可核验')
        return {**row['actual'], 'ownerId': scope.owner, 'sessionId': session_id}

    def _task_jobs(self) -> dict[str, asyncio.Task]:
        if not hasattr(self, '_task_workspace_jobs'):
            self._task_workspace_jobs = {}
        return self._task_workspace_jobs

    def _task_source(self, session_id: str) -> Any:
        source = self._collaboration_session(session_id)
        if source.codex_connection_mode == 'ssh' or source.relation_kind == 'review':
            raise CollaborationError('当前 Session 不支持本节点项目任务；未切换节点')
        if not source.working_dir:
            raise CollaborationError('请先为 Session 选择项目目录')
        return source

    def _task_config(self, source: Any, raw: Any) -> dict:
        if not isinstance(raw, dict) or set(raw) - {'title', 'goal', 'backendId', 'runtime', 'constraints', 'skills', 'skipPermissions', 'includePaths'}:
            raise CollaborationError('任务配置无效，不接受目录、原生线程或委托字段')
        config = {}
        for key, maximum in [('title', 120), ('goal', 16000), ('constraints', 8000), ('backendId', 200)]:
            value = raw.get(key, '')
            if not isinstance(value, str) or len(value) > maximum or '\0' in value:
                raise CollaborationError('任务配置无效：' + key)
            config[key] = value.strip()
        if not config['title']: raise CollaborationError('请填写任务标题')
        config['backendId'] = config['backendId'] or source.backend_id
        backend = next((row for row in self._backend_configs if row.id == config['backendId'] and row.enabled), None)
        if backend is None: raise CollaborationError('任务 Backend 在本节点不可用')
        from .session_roles import role_profile
        role = role_profile({'name': 'task', 'instructions': 'task', 'backendId': config['backendId'], 'runtime': raw.get('runtime', {})})
        config['runtime'] = role['runtime']
        from .poe_api import is_poe_api_base_url
        kind = getattr(backend.type, 'value', backend.type)
        if config['runtime'].get('model') and kind not in {'codex-office', 'qwen-code-cli', 'deepseek-harness'} and not (kind == 'openai-compatible' and is_poe_api_base_url(backend.base_url)):
            raise CollaborationError('该 Backend 不支持 Session 模型覆盖')
        if config['runtime'].get('reasoningEffort') and kind not in {'codex-office', 'deepseek-harness'}:
            raise CollaborationError('该 Backend 不支持推理档位')
        if kind == 'deepseek-harness' and config['runtime'].get('reasoningEffort'):
            from .deepseek_harness_config import REASONING_EFFORTS
            if config['runtime']['reasoningEffort'] not in REASONING_EFFORTS:
                raise CollaborationError('Harness 不支持该推理档位')
        for key, maximum in [('skills', 100), ('includePaths', 100)]:
            value = raw.get(key, [])
            if not isinstance(value, list) or len(value) > maximum or any(not isinstance(item, str) or len(item) > 500 or '\0' in item for item in value):
                raise CollaborationError('任务列表配置无效：' + key)
            config[key] = list(dict.fromkeys(value))
        if type(raw.get('skipPermissions', False)) is not bool: raise CollaborationError('任务权限选项无效')
        config['skipPermissions'] = raw.get('skipPermissions', False)
        return config

    async def _rpc_taskWorkspaceInspect(self, session_id: str) -> str:
        source = self._task_source(session_id)
        try:
            view = await asyncio.to_thread(lambda: TaskGit(source.working_dir).inspect())
            self._collaboration_scope(session_id)
            return json.dumps({'status': 'ready', **view, 'notice': '默认仅包含提交 ' + view['head'][:12] + '；未提交内容须明确选定。'}, ensure_ascii=False)
        except (ValueError, OSError) as error:
            return json.dumps({'status': 'unavailable', 'notice': str(error), 'preparation': '请在本项目终端显式初始化 Git 并完成首个提交，再重新检查；不会自动初始化或换节点。'}, ensure_ascii=False)

    async def _rpc_taskWorkspacePlan(self, session_id: str, request_id: str, config_json: str) -> str:
        self._window_guard(session_id)
        source = self._task_source(session_id)
        scope, store = self._collaboration_scope(session_id), self._collaboration_store()
        config = self._task_config(source, json.loads(config_json))
        receipt, fresh = store.begin_request(scope, request_id, 'taskPlan', {'sessionId': session_id, 'config': config})
        workspace_id = 'task-' + uuid.uuid5(uuid.NAMESPACE_URL, fingerprint([scope.owner, scope.executor, session_id, request_id])).hex
        if not fresh:
            old = store.read(scope, 'workspace', workspace_id)
            if old: return json.dumps(old, ensure_ascii=False)
            raise CollaborationError('原预览未完成；请核对原请求，没有自动重建')
        try:
            repo = await asyncio.to_thread(lambda: TaskGit(source.working_dir).inspect())
            self._task_source(session_id)
            if canonical_path(source.working_dir) != repo['root']: raise CollaborationError('源目录已变化')
            for name in config['includePaths']:
                row = next((row for row in repo['dirty'] if row['path'] == name), None)
                if row is None or row['blocked']: raise CollaborationError('路径不可快照：' + name)
            root = paths.sub('task-workspaces', fingerprint([scope.owner, scope.executor])[:32], workspace_id)
            plan = {'sourceSessionId': session_id, 'parentSessionId': session_id, 'sessionId': workspace_id,
                'title': config['title'], 'status': 'preview', 'config': config, 'repository': repo,
                'root': str(root), 'branch': 'awu/task/' + workspace_id, 'relationKind': 'task',
                'notice': '仅创建独立 Session、分支和 worktree；不会启动模型、push 或删除源内容。'}
            backend = next(item for item in self._backend_configs if item.id == config['backendId'])
            plan['backendFingerprint'] = fingerprint(backend.to_dict())
            plan['planFingerprint'] = fingerprint(plan)
            row = store.write(scope, 'workspace', workspace_id, plan, 0)
            store.finish_request(scope, request_id, receipt['revision'], 'succeeded', {'workspaceId': workspace_id})
            return json.dumps(row, ensure_ascii=False)
        except BaseException as error:
            store.finish_request(scope, request_id, receipt['revision'], 'failed', {'notice': str(error)[:500]})
            raise

    def _task_workspace(self, session_id: str, workspace_id: str) -> tuple[Any, Any, dict]:
        scope, store = self._collaboration_scope(session_id), self._collaboration_store()
        row = store.read(scope, 'workspace', identifier(workspace_id))
        if not row or session_id not in {row['sourceSessionId'], row['sessionId']}:
            raise CollaborationError('任务不属于此 Session')
        return scope, store, row

    def _task_update(self, scope: Any, row: dict, **patch: Any) -> dict:
        updated = self._collaboration_store().write(scope, 'workspace', row['id'], {**row, **patch}, row['revision'])
        self._emit_event('taskWorkspaceUpdated', {key: updated[key] for key in ('id', 'revision', 'sourceSessionId', 'sessionId', 'status', 'title')})
        return updated

    def _rpc_taskWorkspaceCreate(self, session_id: str, workspace_id: str, request_id: str, plan_fingerprint: str) -> str:
        self._window_guard(session_id)
        self._require_update_work_allowed()
        scope, store, row = self._task_workspace(session_id, workspace_id)
        if row['planFingerprint'] != plan_fingerprint: raise CollaborationError('任务计划已变化，请重新预览')
        previous = store.request(scope, request_id)
        if previous:
            store.begin_request(scope, request_id, 'taskCreate', {'sessionId': session_id, 'workspaceId': workspace_id, 'fingerprint': plan_fingerprint})
            return self._rpc_taskWorkspaceStatus(session_id, workspace_id)
        if row['status'] != 'preview': raise CollaborationError('任务已提交，不能重复创建；请查询原请求')
        self._task_config(self._task_source(session_id), row['config'])
        backend = next(item for item in self._backend_configs if item.id == row['config']['backendId'])
        if fingerprint(backend.to_dict()) != row['backendFingerprint']:
            raise CollaborationError('Backend 配置已变化，请重新预览任务计划')
        receipt, _ = store.begin_request(scope, request_id, 'taskCreate', {'sessionId': session_id, 'workspaceId': workspace_id, 'fingerprint': plan_fingerprint})
        row = self._task_update(scope, row, status='creating', requestId=request_id)
        task = asyncio.create_task(self._task_create_owned(scope, row, receipt))
        self._task_jobs()[workspace_id] = task
        task.add_done_callback(lambda done: self._task_jobs().pop(workspace_id, None))
        return self._rpc_taskWorkspaceStatus(session_id, workspace_id)

    async def _task_create_owned(self, scope: Any, row: dict, receipt: dict) -> None:
        store = self._collaboration_store()
        try:
            root = paths.sub('task-workspaces', fingerprint([scope.owner, scope.executor])[:32], row['id'])
            if canonical_path(root) != canonical_path(row['root']): raise CollaborationError('任务目录归属变化')
            source = self._task_source(row['sourceSessionId'])
            if canonical_path(source.working_dir) != row['repository']['root']: raise CollaborationError('源目录已变化')
            result = await asyncio.to_thread(lambda: TaskGit(source.working_dir).create(row['repository'], root,
                row['branch'], row['config']['includePaths'], root.parent / '.scratch'))
            self._task_source(row['sourceSessionId'])
            config = row['config']
            child = Session(id=row['sessionId'], title=config['title'], created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=str(root), backend_id=config['backendId'], owner_id=scope.owner,
                parent_session_id=row['parentSessionId'], relation_kind='task', project_group_id=row['sourceSessionId'],
                workspace_id=row['id'], model_override=config['runtime'].get('model'), reasoning_effort=config['runtime'].get('reasoningEffort'),
                constraints=config['constraints'], abilities={'skills': config['skills'], 'prompts': []}, skip_permissions=config['skipPermissions'])
            await asyncio.to_thread(self._session_store.save, child, async_=False)
            verified = self._session_store.load(child.id)
            if not verified or verified.working_dir != str(root) or verified.workspace_id != row['id']:
                raise CollaborationError('任务 Session 落盘核验失败')
            self._active_sessions[child.id] = child
            row = self._task_update(scope, row, status='ready', actual=result)
            store.finish_request(scope, receipt['requestId'], receipt['revision'], 'succeeded', {'workspaceId': row['id'], 'sessionId': child.id, 'head': result['head']})
            self._emit_session_updated({'type': 'session_created', 'sessionId': child.id, 'summary': child.meta_dict()})
        except BaseException as error:
            try:
                current = store.read(scope, 'workspace', row['id'])
                self._task_update(scope, current, status='unknown' if isinstance(error, asyncio.CancelledError) else 'error', notice=str(error)[:1000] or '创建退出未知；原目录保留')
                current_receipt = store.request(scope, receipt['requestId'])
                if current_receipt['status'] not in {'failed', 'succeeded'}:
                    store.finish_request(scope, receipt['requestId'], current_receipt['revision'], 'unknown', {'workspaceId': row['id'], 'notice': '创建未确认完成；原目录保留，未重试'})
            except Exception: pass

    def _rpc_taskWorkspaceStatus(self, session_id: str, workspace_id: str) -> str:
        scope, store, row = self._task_workspace(session_id, workspace_id)
        if row['status'] in {'creating', 'cleaning'} and row['id'] not in self._task_jobs():
            row = {**row, 'status': 'unknown', 'notice': '原创建进程不可恢复；保留工作区，未自动重放'}
        receipt = store.request(scope, row['requestId']) if row.get('requestId') else None
        start_receipt = store.request(scope, row['startRequestId']) if row.get('startRequestId') else None
        return json.dumps({**row, 'receipt': receipt, 'startReceipt': start_receipt}, ensure_ascii=False)

    def _rpc_taskWorkspaceStart(self, session_id: str, workspace_id: str, request_id: str) -> str:
        self._window_guard(session_id)
        scope, store, row = self._task_workspace(session_id, workspace_id)
        if row['status'] != 'ready' or not row['config'].get('goal'):
            raise CollaborationError('任务未就绪或没有初始需求，请打开子 Session 输入')
        if row.get('startRequestId') and row['startRequestId'] != request_id:
            original = store.request(scope, row['startRequestId'])
            return json.dumps(original, ensure_ascii=False)
        receipt, fresh = store.begin_request(scope, request_id, 'taskStart', {'sessionId': session_id, 'workspaceId': workspace_id})
        if fresh:
            try:
                self._check_chat_turn_allowed(row['sessionId'])
                row = self._task_update(scope, row, startRequestId=request_id)
                self._start_chat_turn(json.dumps({'sessionId': row['sessionId'], 'content': row['config']['goal'], 'backendId': row['config']['backendId']}))
                receipt = store.finish_request(scope, request_id, receipt['revision'], 'succeeded', {'sessionId': row['sessionId'], 'notice': '已接收任务启动，不代表需求完成'})
            except Exception as error:
                receipt = store.finish_request(scope, request_id, receipt['revision'], 'failed', {'notice': str(error)[:500]})
        return json.dumps(receipt, ensure_ascii=False)
