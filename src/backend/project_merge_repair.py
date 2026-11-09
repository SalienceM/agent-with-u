"""原合并请求内的托管修复；接收回执、运行结果和 Git 验证分别记录。"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from .session_collaboration_store import CollaborationError
from .task_git import canonical_path


class ProjectMergeRepair:
    def _merge_repair_jobs(self) -> dict[str, asyncio.Future]:
        if not hasattr(self, '_project_merge_repair_jobs'):
            self._project_merge_repair_jobs: dict[str, asyncio.Future] = {}
        return self._project_merge_repair_jobs

    def _merge_repair_child(self, row: dict) -> Any:
        integration = row.get('integration') or {}
        child = self._task_source(integration.get('sessionId', ''))
        if (child.relation_kind != 'integration'
                or canonical_path(child.working_dir) != canonical_path(integration.get('root', ''))):
            raise CollaborationError('整合工作区关联已变化，不能操作原修复')
        scope = self._collaboration_scope(child.id)
        workspace = self._collaboration_store().read(scope, 'workspace', child.workspace_id)
        if not workspace or workspace.get('mergeOperationId') != row['id']:
            raise CollaborationError('整合工作区不属于当前合并请求')
        return child

    def _merge_repair_view(self, scope: Any, row: dict) -> dict:
        repair = dict(row.get('repair') or {})
        if not row['integration'].get('sessionId') or not row['integration'].get('root'):
            return {'status': 'unknown', 'canStart': False, 'notice': '整合详情不可用'}
        activity = self._project_activity(row['integration']['root'])
        owned = self._merge_job_key(scope, row['id']) in self._merge_repair_jobs()
        if owned:
            repair.update(status='running', notice='正在处理本次合并；需要你的确认时会显示在这里。')
        elif activity:
            repair.update(status='unknown', notice='运行或退出状态尚未确认，请等待并核对。')
        elif repair.get('status') in {'running', 'unknown'} or row.get('startRequestId') and not repair:
            repair.update(status='needs_attention', notice='原运行已不再活动，结果尚未核对；可核对候选或显式继续处理。')
        return {**repair, 'status': repair.get('status', 'idle'),
                'canStart': row['status'] in {'conflict', 'candidate'} and not owned and not activity}

    def _rpc_projectMergeRepairRead(self, session: str, operation: str) -> str:
        scope, row = self._merge_readable(session, operation)
        child = self._merge_repair_child(row)
        messages: list[dict] = []
        remaining = 48000
        clipped = False
        # 只读近期可见正文，不序列化隐藏思考、附件或整个 Session。
        for message in reversed(child.messages[-20:]):
            if message.role not in {'user', 'assistant'}:
                continue
            content = (message.content or '')[-min(12000, remaining):]
            clipped = clipped or len(content) < len(message.content or '')
            messages.append({'id': message.id, 'role': message.role, 'content': content})
            remaining -= len(content)
            if remaining <= 0:
                break
        permission = json.loads(self._rpc_workbenchPermissionGet(child.id)) if session == row['sourceSessionId'] else {'status': 'ok'}
        if permission.get('status') != 'ok':
            raise CollaborationError('无法读取当前执行确认计划')
        return json.dumps({'operationId': operation, 'sessionId': child.id, 'revision': row['revision'],
            'repair': self._merge_repair_view(scope, row), 'messages': list(reversed(messages)),
            'truncated': clipped or len(child.messages) > len(messages) or remaining <= 0,
            'permission': permission.get('pending')}, ensure_ascii=False)

    def _rpc_projectMergeRepairPermission(self, origin: str, operation: str, request_id: str, granted: bool) -> str:
        self._window_guard(origin)
        _, _, row = self._merge_row(origin, operation)
        child = self._merge_repair_child(row)
        if not request_id or type(granted) is not bool:
            raise CollaborationError('请响应当前确认计划')
        self._rpc_grantPermission(child.id, granted, False, request_id)
        return json.dumps({'status': 'succeeded'})

    async def _merge_repair_finished(self, scope: Any, operation: str, request_id: str, completed: asyncio.Future) -> None:
        succeeded = not completed.cancelled() and completed.exception() is None and completed.result() is not False
        store = self._collaboration_store()
        row = store.read(scope, 'merge', operation)
        if not row or row.get('startRequestId') != request_id or row['status'] not in {'conflict', 'candidate'}:
            return
        try:
            self._merge_repair_child(row)
            if self._project_activity(row['integration']['root']):
                status, notice = 'unknown', '运行退出尚未确认，未推进候选。'
            elif not succeeded:
                status, notice = 'failed', '本次修复未完成，已保留成果；可在此继续处理。'
            else:
                try:
                    await self._rpc_projectMergeVerify(row['sourceSessionId'], operation)
                    status, notice = 'ready', '候选提交已核对，等待你确认合并；项目测试结论请审阅执行记录。'
                except (ValueError, OSError, RuntimeError) as error:
                    status, notice = 'needs_attention', str(error)[:500]
        except (ValueError, OSError, RuntimeError) as error:
            status, notice = 'unknown', str(error)[:500]
        current = store.read(scope, 'merge', operation)
        if current and current.get('startRequestId') == request_id and current['status'] in {'conflict', 'candidate'}:
            self._merge_update(scope, current, repair={'requestId': request_id, 'status': status, 'notice': notice})

    def _rpc_projectMergeStart(self, origin: str, operation: str, request_id: str) -> str:
        self._window_guard(origin)
        scope, store, row = self._merge_row(origin, operation)
        intent = {'sessionId': origin, 'operation': operation}
        if store.request(scope, request_id):
            receipt, _ = store.begin_request(scope, request_id, 'mergeStart', intent)
            return json.dumps(receipt, ensure_ascii=False)
        if row['status'] not in {'conflict', 'candidate'}:
            raise CollaborationError('当前没有可启动的合并修复')
        child = self._merge_repair_child(row)
        if not self._merge_repair_view(scope, row)['canStart']:
            raise CollaborationError('原修复仍在运行或退出未知，请核对原操作')
        self._merge_recheck_identity(row)
        self._check_chat_turn_allowed(child.id)
        receipt, _ = store.begin_request(scope, request_id, 'mergeStart', intent)
        key = self._merge_job_key(scope, operation)
        try:
            row = self._merge_update(scope, row, startRequestId=request_id,
                repair={'requestId': request_id, 'status': 'running', 'notice': '修复请求已接收'})
            prompt = ('处理本条合并请求：保留双方成果，解决冲突，执行项目相关验证，并在当前整合工作区提交候选。'
                '已有正确成果继续保留；无需让用户再手工提交中间分支。若不能完成，说明具体阻塞，不声称成功。'
                '只修改当前整合工作区；不要更新原目标、推送、删除分支、清理其他目录或创建另一条合并请求。'
                '\n冻结来源：' + row['source']['head'] + '\n冻结目标：' + row['target']['head']
                + '\n冲突路径：' + json.dumps(row['integration']['conflicts'], ensure_ascii=False))
            turn = self._start_chat_turn(json.dumps({'sessionId': child.id, 'content': prompt, 'backendId': child.backend_id}))
            self._merge_repair_jobs()[key] = turn

            def finished(completed: asyncio.Future) -> None:
                # 注册表的释放回调先执行；后处理独立于窗口和前端是否挂载。
                followup = asyncio.create_task(self._merge_repair_finished(scope, operation, request_id, completed))
                self._merge_repair_jobs()[key] = followup

                def settled(done: asyncio.Future) -> None:
                    if self._merge_repair_jobs().get(key) is done:
                        self._merge_repair_jobs().pop(key, None)
                    if not done.cancelled():
                        done.exception()  # 失败保留原 running 记录，恢复时只读核对，绝不重放。
                    self._emit_session_updated({'type': 'merge_activity', 'sessionId': child.id})

                followup.add_done_callback(settled)

            turn.add_done_callback(finished)
            receipt = store.finish_request(scope, request_id, receipt['revision'], 'succeeded',
                {'sessionId': child.id, 'notice': '已接收修复；完成后仍须单独确认合并。'})
        except Exception as error:
            if key not in self._merge_repair_jobs():
                current = store.read(scope, 'merge', operation)
                self._merge_update(scope, current, repair={'requestId': request_id, 'status': 'failed', 'notice': str(error)[:500]})
                receipt = store.finish_request(scope, request_id, receipt['revision'], 'failed', {'notice': str(error)[:500]})
            else:
                raise  # 运行已启动但回执保存失败：保留原预留，不能报告可重试。
        return json.dumps(receipt, ensure_ascii=False)
