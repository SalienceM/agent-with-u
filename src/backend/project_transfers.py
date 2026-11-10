"""节点交接 RPC：冻结计划、分块暂存、独立项目与基线候选。"""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
import shutil
import time
import uuid
from typing import Any

from . import paths
from .deepseek_harness_state import reject_links
from .project_transfer_snapshot import CHUNK, MAX_ARCHIVE, MAX_FILES, MAX_TOTAL, SHA, export_snapshot, import_snapshot
from .session_collaboration_store import CollaborationError, CollaborationScope, fingerprint, identifier
from .task_git import TaskGit, canonical_path
from ..types import Session


class ProjectTransfers:
    def _transfer_scope(self) -> CollaborationScope:
        return CollaborationScope(self._current_owner_id(), self._loop_environment_executor())

    def _transfer_jobs(self) -> dict[str, asyncio.Task]:
        if not hasattr(self, '_project_transfer_jobs'):
            self._project_transfer_jobs = {}
        return self._project_transfer_jobs

    def _transfer_path(self, scope: CollaborationScope, transfer_id: str) -> Path:
        # 记录 ID 从不直接用作用户控制路径。
        root = paths.sub('project-transfers', fingerprint([scope.owner, scope.executor])[:32], fingerprint(transfer_id)[:32])
        reject_links(root)
        return root

    def _transfer_row(self, transfer_id: str) -> tuple[CollaborationScope, dict]:
        scope = self._transfer_scope()
        row = self._collaboration_store().read(scope, 'projectTransfer', identifier(transfer_id))
        if not row:
            raise CollaborationError('交接记录不属于当前用户或节点')
        sid = row.get('sourceSessionId') if row['direction'] == 'export' else row.get('parentSessionId')
        if sid:
            self._require_session_access(sid)
        return scope, row

    def _transfer_update(self, scope: CollaborationScope, row: dict, **changes: Any) -> dict:
        return self._collaboration_store().write(scope, 'projectTransfer', row['id'], {**row, **changes}, row['revision'])

    def _transfer_origin(self, session_id: str) -> dict | None:
        root_id = self._task_root_id(session_id)
        row = self._collaboration_store().read(self._collaboration_scope(root_id), 'projectTransfer', root_id)
        if not row or row['direction'] != 'receive' or row['status'] != 'succeeded' or row['descriptor']['mode'] != 'project':
            return None
        root = self._task_parent(root_id)
        if canonical_path(root.working_dir) != row['actual']['root']:
            raise CollaborationError('接收项目目录已变化')
        return {'executorId': row['descriptor']['sourceExecutor'], 'sessionId': row['descriptor']['sourceSessionId'],
                'transferId': row['descriptor']['id']}

    def _rpc_projectTransferCapabilities(self, session_id: str = '') -> str:
        scope = self._transfer_scope()
        origin = self._transfer_origin(session_id) if session_id else None
        return json.dumps({'version': 1, 'executorId': scope.executor, 'git': bool(shutil.which('git')),
            'origin': origin, 'chunkBytes': CHUNK, 'maxBytes': MAX_TOTAL, 'maxFiles': MAX_FILES}, ensure_ascii=False)

    async def _rpc_projectTransferExport(self, session_id: str, request_id: str, target_executor: str, mode: str = 'project') -> str:
        self._window_guard(session_id); self._require_update_work_allowed()
        self._project_check_write(session_id)
        source = self._task_parent(session_id) if mode == 'project' else self._task_source(session_id)
        scope = self._collaboration_scope(session_id); store = self._collaboration_store()
        if mode not in {'project', 'return'} or not target_executor or target_executor == scope.executor:
            raise CollaborationError('请选择不同的真实目标节点')
        identifier(target_executor)
        origin = self._transfer_origin(session_id) if mode == 'return' else None
        if mode == 'return' and (not origin or origin['executorId'] != target_executor):
            raise CollaborationError('成果只能回传原项目节点')
        if mode == 'return':
            root_id = self._task_root_id(session_id)
            received = store.read(scope, 'projectTransfer', root_id)
            repository = await asyncio.to_thread(lambda: TaskGit(source.working_dir).repository())
            if repository['repositoryId'] != received['actual']['repositoryId']:
                raise CollaborationError('接收项目仓库身份已变化，不能回传')
        intent = {'sessionId': session_id, 'targetExecutor': target_executor, 'mode': mode}
        receipt, fresh = store.begin_request(scope, request_id, 'projectTransferExport', intent)
        transfer_id = 'export-' + uuid.uuid5(uuid.NAMESPACE_URL, fingerprint([scope.owner, scope.executor, request_id])).hex
        if not fresh:
            return self._rpc_projectTransferStatus(transfer_id)
        row = store.write(scope, 'projectTransfer', transfer_id, {'status': 'exporting', 'direction': 'export',
            'sourceSessionId': session_id, 'sessionId': session_id, 'title': source.title, 'requestId': request_id}, 0)

        async def run() -> None:
            try:
                result = await asyncio.to_thread(export_snapshot, TaskGit(source.working_dir),
                    self._transfer_path(scope, transfer_id) / 'snapshot.zip', 'refs/awu/transfers/' + transfer_id)
                if canonical_path(self._task_source(session_id).working_dir) != result['repository']['root']:
                    raise CollaborationError('来源目录已变化')
                descriptor = {'version': 1, 'id': transfer_id, 'mode': mode, 'sourceExecutor': scope.executor,
                    'sourceSessionId': session_id, 'sourceTitle': source.title, 'targetExecutor': target_executor,
                    'origin': origin, **{key: result[key] for key in ('size', 'sha256', 'files', 'bytes')}}
                self._transfer_update(scope, row, status='exported', descriptor=descriptor, repository=result['repository'], baseline=result['baseline'])
                store.finish_request(scope, request_id, receipt['revision'], 'succeeded', {'transferId': transfer_id})
            except BaseException as error:
                self._transfer_update(scope, row, status='failed', notice=str(error)[:800] or '导出中断；未发送项目')
                store.finish_request(scope, request_id, receipt['revision'], 'failed', {'transferId': transfer_id})
        job = asyncio.create_task(run()); self._transfer_jobs()[transfer_id] = job
        job.add_done_callback(lambda done: self._transfer_jobs().pop(transfer_id, None))
        await asyncio.shield(job)
        return self._rpc_projectTransferStatus(transfer_id)

    def _rpc_projectTransferRead(self, transfer_id: str, offset: int) -> str:
        scope, row = self._transfer_row(transfer_id)
        if row['direction'] != 'export' or row['status'] != 'exported' or type(offset) is not int or not 0 <= offset < row['descriptor']['size']:
            raise CollaborationError('导出分块不可用')
        archive = self._transfer_path(scope, transfer_id) / 'snapshot.zip'; reject_links(archive)
        with archive.open('rb') as stream:
            stream.seek(offset); body = stream.read(CHUNK)
        return json.dumps({'offset': offset, 'data': base64.b64encode(body).decode(), 'nextOffset': offset + len(body)})

    def _transfer_descriptor(self, raw: Any, scope: CollaborationScope) -> dict:
        keys = {'version', 'id', 'mode', 'sourceExecutor', 'sourceSessionId', 'sourceTitle', 'targetExecutor', 'origin', 'size', 'sha256', 'files', 'bytes'}
        if not isinstance(raw, dict) or set(raw) != keys or raw['version'] != 1 or raw['mode'] not in {'project', 'return'}:
            raise CollaborationError('不支持的项目交接描述符')
        for key in ('id', 'sourceExecutor', 'sourceSessionId', 'sourceTitle', 'targetExecutor'):
            identifier(raw[key])
        if raw['targetExecutor'] != scope.executor or raw['sourceExecutor'] == scope.executor:
            raise CollaborationError('交接目标节点不匹配')
        for key, minimum, maximum in [('size', 1, MAX_ARCHIVE), ('files', 0, MAX_FILES), ('bytes', 0, MAX_TOTAL)]:
            if type(raw[key]) is not int or not minimum <= raw[key] <= maximum:
                raise CollaborationError('交接摘要超过预算')
        if not isinstance(raw['sha256'], str) or not SHA.fullmatch(raw['sha256']):
            raise CollaborationError('交接哈希无效')
        if raw['mode'] == 'project' and raw['origin'] is not None:
            raise CollaborationError('新项目来源描述无效')
        if raw['mode'] == 'return':
            origin = raw['origin']
            if not isinstance(origin, dict) or set(origin) != {'executorId', 'sessionId', 'transferId'}:
                raise CollaborationError('回传来源描述无效')
            for value in origin.values(): identifier(value)
        return raw

    def _transfer_return_source(self, scope: CollaborationScope, descriptor: dict) -> tuple[Any, dict]:
        origin = descriptor['origin']
        if origin['executorId'] != scope.executor:
            raise CollaborationError('回传来源节点不匹配')
        source = self._task_parent(origin['sessionId'])
        row = self._collaboration_store().read(scope, 'projectTransfer', origin['transferId'])
        if not row or row['direction'] != 'export' or row['status'] != 'exported' or row['sourceSessionId'] != source.id or row['descriptor']['mode'] != 'project' or row['descriptor']['targetExecutor'] != descriptor['sourceExecutor']:
            raise CollaborationError('无法核验原项目交接记录')
        return source, row

    def _transfer_check_repo(self, source: Any, origin: dict) -> None:
        actual = TaskGit(source.working_dir).repository()
        if any(actual[key] != origin['repository'][key] for key in ('root', 'gitDir', 'commonDir', 'repositoryId')):
            raise CollaborationError('原项目仓库身份已变化')
        git = TaskGit(source.working_dir)
        if git.run('rev-parse', '--verify', 'refs/awu/transfers/' + origin['id']).decode().strip() != origin['baseline']:
            raise CollaborationError('原交接基线已变化')

    async def _rpc_projectTransferPlan(self, request_id: str, descriptor_json: str, title: str, backend_id: str) -> str:
        self._require_update_work_allowed(); self._require_agent_execution_enabled()
        scope = self._transfer_scope(); store = self._collaboration_store()
        if len(descriptor_json) > 16384:
            raise CollaborationError('交接描述超限')
        descriptor = self._transfer_descriptor(json.loads(descriptor_json), scope)
        if not isinstance(title, str) or not title.strip() or len(title) > 120:
            raise CollaborationError('请填写 120 字以内的标题')
        backend = next((item for item in self._backend_configs if item.id == backend_id and item.enabled), None)
        if not backend or not shutil.which('git'):
            raise CollaborationError('目标 Backend 不可用或本节点未安装 Git')
        parent_id = ''
        if descriptor['mode'] == 'return':
            source, origin = self._transfer_return_source(scope, descriptor)
            self._window_guard(source.id)
            await asyncio.to_thread(self._transfer_check_repo, source, origin)
            parent_id = source.id
        intent = {'descriptor': descriptor, 'title': title.strip(), 'backendId': backend_id}
        receipt, fresh = store.begin_request(scope, request_id, 'projectTransferPlan', intent)
        transfer_id = 'node-' + uuid.uuid5(uuid.NAMESPACE_URL, fingerprint([scope.owner, scope.executor, descriptor['id']])).hex
        if not fresh:
            return self._rpc_projectTransferStatus(transfer_id)
        if store.read(scope, 'projectTransfer', transfer_id):
            store.finish_request(scope, request_id, receipt['revision'], 'failed', {'notice': '该快照已有接收计划'})
            raise CollaborationError('该快照已有接收计划，请核对原操作')
        root = paths.sub('task-workspaces' if parent_id else 'node-projects', fingerprint([scope.owner, scope.executor])[:32], transfer_id)
        plan = {'direction': 'receive', 'status': 'preview', 'descriptor': descriptor, 'title': title.strip(),
            'backendId': backend_id, 'backendFingerprint': fingerprint(backend.to_dict()), 'parentSessionId': parent_id,
            'sessionId': transfer_id, 'root': str(root), 'offset': 0, 'planRequestId': request_id}
        plan['planFingerprint'] = fingerprint(plan)
        row = store.write(scope, 'projectTransfer', transfer_id, plan, 0)
        store.finish_request(scope, request_id, receipt['revision'], 'succeeded', {'transferId': transfer_id})
        return json.dumps(row, ensure_ascii=False)

    def _rpc_projectTransferAccept(self, transfer_id: str, request_id: str, plan_fingerprint: str) -> str:
        self._require_update_work_allowed(); self._require_agent_execution_enabled()
        scope, row = self._transfer_row(transfer_id); store = self._collaboration_store()
        if row['direction'] != 'receive' or row['planFingerprint'] != plan_fingerprint:
            raise CollaborationError('交接计划已变化')
        intent = {'transferId': transfer_id, 'fingerprint': plan_fingerprint}
        if store.request(scope, request_id):
            store.begin_request(scope, request_id, 'projectTransferAccept', intent)
            return self._rpc_projectTransferStatus(transfer_id)
        if row['status'] != 'preview':
            raise CollaborationError('交接已经提交，请查询原请求')
        self._transfer_recheck(scope, row)
        receipt, _ = store.begin_request(scope, request_id, 'projectTransferAccept', intent)
        archive = self._transfer_path(scope, transfer_id) / 'received.zip'
        archive.parent.mkdir(parents=True, exist_ok=True); reject_links(archive)
        try:
            with archive.open('xb'): pass
            row = self._transfer_update(scope, row, status='receiving', requestId=request_id)
        except BaseException as error:
            self._transfer_update(scope, row, status='unknown', requestId=request_id,
                notice=str(error)[:800] or '暂存创建结果未确认，未重放写入')
            store.finish_request(scope, request_id, receipt['revision'], 'unknown', {'transferId': transfer_id})
            raise
        return json.dumps(row, ensure_ascii=False)

    def _transfer_recheck(self, scope: CollaborationScope, row: dict) -> None:
        backend = next((item for item in self._backend_configs if item.id == row['backendId'] and item.enabled), None)
        if not backend or fingerprint(backend.to_dict()) != row['backendFingerprint']:
            raise CollaborationError('目标 Backend 配置已变化，请重新准备交接')
        if row['parentSessionId']:
            self._window_guard(row['parentSessionId'])
            self._transfer_return_source(scope, row['descriptor'])

    def _rpc_projectTransferChunk(self, transfer_id: str, request_id: str, offset: int, data: str) -> str:
        self._require_update_work_allowed()
        scope, row = self._transfer_row(transfer_id)
        if row['direction'] != 'receive' or row['status'] != 'receiving' or row.get('requestId') != request_id or type(offset) is not int or offset != row['offset']:
            raise CollaborationError('交接分块顺序或请求身份不匹配；请核对原操作')
        if not isinstance(data, str) or len(data) > (CHUNK + 2) // 3 * 4:
            raise CollaborationError('分块超过预算')
        body = base64.b64decode(data, validate=True)
        if not body or len(body) > CHUNK or offset + len(body) > row['descriptor']['size']:
            raise CollaborationError('分块长度无效')
        archive = self._transfer_path(scope, transfer_id) / 'received.zip'; reject_links(archive)
        with archive.open('r+b') as stream:
            stream.seek(0, 2)
            if stream.tell() != offset: raise CollaborationError('暂存大小不一致；请核对原操作')
            stream.write(body); stream.flush()
        row = self._transfer_update(scope, row, offset=offset + len(body))
        return json.dumps({'offset': row['offset'], 'status': row['status']})

    async def _rpc_projectTransferFinish(self, transfer_id: str, request_id: str) -> str:
        self._require_update_work_allowed(); self._require_agent_execution_enabled()
        scope, row = self._transfer_row(transfer_id)
        if row['direction'] != 'receive' or row.get('requestId') != request_id:
            raise CollaborationError('交接请求身份不匹配')
        if row['status'] != 'receiving':
            return self._rpc_projectTransferStatus(transfer_id)
        if row['offset'] != row['descriptor']['size']:
            raise CollaborationError('项目尚未完整接收')
        self._transfer_recheck(scope, row)
        row = self._transfer_update(scope, row, status='importing')
        job = asyncio.create_task(self._transfer_import_owned(scope, row))
        self._transfer_jobs()[transfer_id] = job
        job.add_done_callback(lambda done: self._transfer_jobs().pop(transfer_id, None))
        await asyncio.shield(job)
        return self._rpc_projectTransferStatus(transfer_id)

    async def _transfer_import_owned(self, scope: CollaborationScope, row: dict) -> None:
        store = self._collaboration_store()
        receipt = store.request(scope, row['requestId'])
        try:
            source_root = ''; baseline = ''
            if row['parentSessionId']:
                source, origin = self._transfer_return_source(scope, row['descriptor'])
                self._project_check_write(source.id)
                await asyncio.to_thread(self._transfer_check_repo, source, origin)
                source_root, baseline = source.working_dir, origin['baseline']
            root = paths.sub('task-workspaces' if row['parentSessionId'] else 'node-projects', fingerprint([scope.owner, scope.executor])[:32], row['id'])
            if canonical_path(root) != canonical_path(row['root']):
                raise CollaborationError('接收目录归属变化')
            result = await asyncio.to_thread(import_snapshot, self._transfer_path(scope, row['id']) / 'received.zip',
                row['descriptor'], root, 'awu/task/' + row['id'], source_root, baseline)
            self._transfer_recheck(scope, row)
            if row['parentSessionId']:
                source, origin = self._transfer_return_source(scope, row['descriptor'])
                await asyncio.to_thread(self._transfer_check_repo, source, origin)
            child = Session(id=row['sessionId'], title=row['title'], created_at=time.time(), updated_at=time.time(),
                messages=[], working_dir=str(root), backend_id=row['backendId'], owner_id=scope.owner, skip_permissions=False,
                parent_session_id=row['parentSessionId'] or None, relation_kind='task' if row['parentSessionId'] else None,
                project_group_id=row['parentSessionId'] or None, workspace_id=row['id'] if row['parentSessionId'] else None)
            if row['parentSessionId']:
                store.write(scope, 'workspace', row['id'], {'sourceSessionId': row['parentSessionId'], 'parentSessionId': row['parentSessionId'],
                    'sessionId': child.id, 'title': child.title, 'status': 'ready', 'root': str(root), 'branch': result['branch'],
                    'actual': result, 'relationKind': 'task', 'config': {'goal': '', 'backendId': child.backend_id}, 'planFingerprint': row['planFingerprint']}, 0)
            await asyncio.to_thread(self._session_store.save, child, async_=False)
            verified = self._session_store.load(child.id)
            if not verified or verified.working_dir != str(root) or verified.owner_id != scope.owner:
                raise CollaborationError('接收 Session 落盘核验失败')
            self._active_sessions[child.id] = child
            row = self._transfer_update(scope, row, status='succeeded', actual=result)
            store.finish_request(scope, row['requestId'], receipt['revision'], 'succeeded',
                {'sessionId': child.id, 'verifiedFiles': result['verifiedFiles'], 'verifiedBytes': result['verifiedBytes'], 'head': result['head']})
            self._emit_session_updated({'type': 'session_created', 'sessionId': child.id, 'summary': child.meta_dict()})
        except BaseException as error:
            current = store.read(scope, 'projectTransfer', row['id'])
            self._transfer_update(scope, current, status='unknown', notice=str(error)[:800] or '接收退出未确认；原目录保留')
            store.finish_request(scope, row['requestId'], receipt['revision'], 'unknown', {'notice': str(error)[:800]})

    def _rpc_projectTransferStatus(self, transfer_id: str) -> str:
        scope, row = self._transfer_row(transfer_id)
        if row['status'] in {'exporting', 'importing'} and row['id'] not in self._transfer_jobs():
            row = {**row, 'status': 'unknown', 'notice': '原进程已结束但未确认完成；保留目录，未重放写入'}
        receipt = self._collaboration_store().request(scope, row.get('requestId', row.get('planRequestId', '')))
        return json.dumps({**row, 'receipt': receipt}, ensure_ascii=False)

    def _rpc_projectTransferList(self, session_id: str) -> str:
        scope = self._collaboration_scope(session_id)
        # 源记录保留每次交接的目标与描述符；UI 只在打开时读取。
        return json.dumps(self._collaboration_store().list(scope, 'projectTransfer', session_id=session_id, limit=30), ensure_ascii=False)

    def _rpc_projectTransferFind(self, export_id: str) -> str:
        scope = self._transfer_scope(); identifier(export_id)
        transfer_id = 'node-' + uuid.uuid5(uuid.NAMESPACE_URL, fingerprint([scope.owner, scope.executor, export_id])).hex
        if not self._collaboration_store().read(scope, 'projectTransfer', transfer_id):
            return 'null'
        return self._rpc_projectTransferStatus(transfer_id)
