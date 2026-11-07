"""按真实目录冻结 AWU 写入方与编辑缓冲；外部程序仍由 Git 前后核对保护。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import os
from typing import Any
import uuid

from .session_collaboration_store import CollaborationError
from .task_git import canonical_path
from .workbench_windows import WINDOW_REQUEST


class ProjectWriteGate:
    def _project_state(self) -> dict:
        if not hasattr(self, '_project_writes'):
            self._project_writes = {'reservations': {}, 'buffers': {}, 'probes': {}, 'external': {}}
        return self._project_writes

    def _project_check_write(self, session_id: str = '', working_dir: str = '') -> None:
        state = self._project_state()
        persisted = self._collaboration_store().project_gates(self._loop_environment_executor())
        targets = set(state['reservations']) | {row['root'] for row in persisted}
        if not targets: return
        if session_id:
            session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
            working_dir = session.working_dir if session else ''
        if not working_dir: return
        root = canonical_path(working_dir)
        if any(root == target or Path(target) in Path(root).parents or Path(root) in Path(target).parents for target in targets):
            raise CollaborationError('目标目录正在应用汇合或清理，暂不能开始新的写入；请查询原操作')

    def _project_activity(self, working_dir: str) -> list[dict]:
        root = canonical_path(working_dir); result = []
        sessions = {row['id']: row for row in self._session_store.list()}
        sessions.update({sid: session.meta_dict() for sid, session in self._active_sessions.items()})
        for sid, row in sessions.items():
            directory = row.get('workingDir')
            if not directory: continue
            try:
                candidate = canonical_path(directory)
                if candidate != root and Path(root) not in Path(candidate).parents and Path(candidate) not in Path(root).parents: continue
            except (ValueError, OSError): continue
            reason = getattr(self, '_session_destroy_busy_reason', lambda value: '')(sid)
            if not reason and getattr(self, '_has_native_session_activity', lambda value: False)(sid): reason = '原生进程退出尚未确认'
            if not reason and getattr(self, '_loop_control_reserved', lambda value: False)(sid): reason = '控制操作尚未完成'
            extras = getattr(self, '_chat_extras_get', lambda value: None)(sid)
            if not reason and extras and extras.pending_tasks(): reason = '目标仍有待派发的序列任务'
            if reason:
                result.append({'sessionId': sid if row.get('ownerId', 'local') == self._current_owner_id() else '', 'reason': reason})
        for row in self._project_state()['buffers'].values():
            if (row['root'] == root or Path(root) in Path(row['root']).parents or Path(row['root']) in Path(root).parents) and row['opened']:
                if row.get('owner') != self._current_owner_id():
                    result.append({'sessionId': '', 'reason': '其他用户仍打开目标文件，不能核对其缓冲'})
                elif row['client'] not in getattr(self, '_clients', set()):
                    result.append({'sessionId': row['sessionId'], 'reason': '曾打开目标文件的窗口已断线，编辑缓冲状态未知'})
                elif row['dirty']:
                    result.append({'sessionId': row['sessionId'], 'reason': '目标窗口有未保存或待核对的文件缓冲'})
        if any(value == root or Path(value) in Path(root).parents or Path(root) in Path(value).parents for value in self._project_state()['external'].values()):
            result.append({'sessionId': '', 'reason': '目标仍有应用文件/Git 写入未完成'})
        return result[:50]

    async def _project_guarded_call(self, working_dir: str, operation: Any) -> Any:
        try:
            self._project_check_write(working_dir=working_dir)
        except BaseException:
            operation.close()
            raise
        key = uuid.uuid4().hex; state = self._project_state()
        state['external'][key] = canonical_path(working_dir)
        task = asyncio.create_task(operation)
        def finished(done: asyncio.Task) -> None:
            # waiter 的取消不取消 worker；未确认 worker 退出时继续阻止后续合并。
            if not done.cancelled():
                state['external'].pop(key, None)
                done.exception()
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    def _rpc_projectBufferState(self, session_id: str, identity_json: str, opened: bool, dirty: bool) -> str:
        if type(opened) is not bool or type(dirty) is not bool:
            raise CollaborationError('缓冲状态无效')
        identity = self._workbench_identity(session_id, json.loads(identity_json))
        meta = WINDOW_REQUEST.get()
        if not meta: raise CollaborationError('文件缓冲需要真实窗口身份')
        key = (identity.ownerId, meta['clientId'], meta['windowId'], session_id, identity.workingDir)
        buffers = self._project_state()['buffers']
        if not opened:
            buffers.pop(key, None)
        else:
            if key not in buffers and len(buffers) >= 2048: raise CollaborationError('文件缓冲登记超过上限')
            buffers[key] = {'root': canonical_path(identity.workingDir), 'sessionId': session_id, 'owner': identity.ownerId,
                'opened': opened, 'dirty': dirty, 'client': self._current_request_client()}
        return json.dumps({'status': 'recorded'})

    def _rpc_projectBufferReply(self, probe_id: str, clean: bool) -> str:
        probe = self._project_state()['probes'].get(probe_id)
        client = self._current_request_client()
        if not probe or type(clean) is not bool or self._current_owner_id() != probe['owner'] or client not in probe['pending']:
            raise CollaborationError('编辑缓冲核对已结束或不属于本窗口')
        probe['pending'].remove(client)
        probe['clean'] = probe['clean'] and clean
        if not probe['pending'] and not probe['future'].done(): probe['future'].set_result(probe['clean'])
        return json.dumps({'status': 'received'})

    def _rpc_projectBufferStatus(self, session_id: str, identity_json: str, operation_id: str) -> str:
        identity = self._workbench_identity(session_id, json.loads(identity_json))
        root = canonical_path(identity.workingDir)
        if any(gate['root'] == root or Path(root) in Path(gate['root']).parents or Path(gate['root']) in Path(root).parents
               for gate in self._collaboration_store().project_gates(self._loop_environment_executor())):
            return json.dumps({'state': 'frozen'})
        # 即使原完成回执不可见，也必须让旧缓冲显式重读后才可保存。
        return json.dumps({'state': 'released', 'committed': True})

    async def _project_reserve(self, session_id: str, operation_id: str) -> dict:
        identity = self._workbench_identity(session_id)
        root = canonical_path(identity.workingDir)
        self._project_check_write(working_dir=root)
        busy = self._project_activity(root)
        if busy: raise CollaborationError('目标尚不可写入：' + '；'.join(row['reason'] for row in busy))
        owner = self._current_owner_id()
        clients = {client for client in getattr(self, '_clients', set()) if self._owner_id_for_client(client) == owner}
        if not clients: raise CollaborationError('没有在线窗口可核对目标编辑缓冲')
        state = self._project_state(); probe_id = uuid.uuid4().hex
        lease = {'root': root, 'operationId': operation_id, 'probeId': probe_id, 'clients': clients, 'workspace': identity.to_dict()}
        state['reservations'][root] = lease
        self._collaboration_store().project_gate_save(self._loop_environment_executor(), {
            'root': root, 'operationId': operation_id, 'owner': owner, 'ownerPid': os.getpid(), 'phase': 'checking', 'exitConfirmed': True})
        probe = {'pending': set(clients), 'owner': owner, 'clean': True, 'future': asyncio.get_running_loop().create_future()}
        state['probes'][probe_id] = probe
        try:
            await asyncio.gather(*(client.send(json.dumps({'event': 'projectBufferFreeze', 'data': {
                'probeId': probe_id, 'operationId': operation_id, 'workspace': identity.to_dict()}}, ensure_ascii=False)) for client in clients))
            clean = await asyncio.wait_for(probe['future'], 10)
            if not clean: raise CollaborationError('目标有未保存编辑缓冲，未开始写入')
            if not clients.issubset(self._clients): raise CollaborationError('核对期间窗口断线，未开始写入')
            busy = self._project_activity(root)
            if busy: raise CollaborationError('核对期间目标活动已变化，未开始写入')
            return lease
        except BaseException:
            await self._project_release(lease)
            raise
        finally:
            state['probes'].pop(probe_id, None)

    async def _project_release(self, lease: dict, *, committed: bool = False) -> None:
        state = self._project_state()
        if state['reservations'].get(lease['root']) is not lease: return
        state['reservations'].pop(lease['root'], None)
        self._collaboration_store().project_gate_remove(self._loop_environment_executor(), lease['root'], lease['operationId'])
        await asyncio.gather(*(client.send(json.dumps({'event': 'projectBufferRelease', 'data': {
            'probeId': lease['probeId'], 'operationId': lease['operationId'], 'committed': committed,
            'workspace': lease['workspace']}}, ensure_ascii=False)) for client in lease['clients']), return_exceptions=True)
