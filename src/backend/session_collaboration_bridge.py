"""协作 RPC 的统一 Session/执行器边界。"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from .session_collaboration_store import CollaborationError, CollaborationScope, CollaborationStore
from .user_interactions import UserInteractionRegistry, UserInteractionRequest
from .kit_delegation_feedback import KitDelegationFeedback
from .composer_submission_bridge import ComposerSubmissionBridge
from .followup_suggestions import FollowupSuggestions
from .session_roles import SessionRoles
from .role_reviews import RoleReviews
from .task_workspaces import TaskWorkspaces
from .project_write_gate import ProjectWriteGate
from .project_merges import ProjectMerges
from .session_schedule_bridge import SessionScheduleBridge


class SessionCollaborationBridge(SessionScheduleBridge, KitDelegationFeedback, ComposerSubmissionBridge, FollowupSuggestions, SessionRoles, RoleReviews, TaskWorkspaces, ProjectWriteGate, ProjectMerges):
    def _declare_interaction_client(self, version: Any) -> None:
        # 这里只声明呈现能力，不授予任何执行权限；断开时由 transport 删除 meta。
        client = self._current_request_client()
        meta = getattr(self, '_client_meta', {}).get(client)
        if meta is not None and type(version) is int and version == 1:
            meta['userInteractionsVersion'] = 1

    def _has_interaction_client(self) -> bool:
        return any(meta.get('userInteractionsVersion') == 1
                   and self._owner_id_for_client(client) == self._current_owner_id()
                   for client, meta in getattr(self, '_client_meta', {}).items()
                   if client in getattr(self, '_clients', set()))

    async def _await_bool_interaction(self, req: Any, cancelled: Any) -> bool:
        """旧 Backend bool 回调只适配普通执行审批，产品计划仍用其独立确认门。"""
        if not self._has_interaction_client():
            session = self._collaboration_session(req.session_id)
            if cancelled():
                return False
            if session.skip_permissions or self._check_skip_permission(session.id):
                return True
            from ..types import ToolCallInfo
            return await self._await_permission_grant(req.session_id, req.message_id,
                [ToolCallInfo(id=req.tool_id, name=req.tool_name, input=req.tool_input)])
        request = UserInteractionRequest(req.session_id, req.message_id, req.native_request_id, kind='approval',
                                         title=req.tool_name, detail=req.tool_input, cancelled=cancelled,
                                         receipt_level='callback_return')
        response = await self._await_user_interaction(request)
        await request.delivered(True)
        return response.get('kind') == 'approved' and response.get('approved') is True

    def _user_interactions(self) -> UserInteractionRegistry:
        registry = getattr(self, '_user_interaction_registry', None)
        if registry is None:
            registry = self._user_interaction_registry = UserInteractionRegistry(
                self._collaboration_store(), lambda row: self._emit_event('userInteraction', row))
        return registry

    async def _await_user_interaction(self, request: UserInteractionRequest) -> dict:
        session = self._collaboration_session(request.session_id)
        if not self._has_interaction_client():
            raise CollaborationError('当前没有支持原生问答的在线客户端。请更新客户端；本请求未自动允许，答案可在普通下一轮回复。')
        return await self._user_interactions().ask(self._collaboration_scope(session.id), request,
                                                  skip=session.skip_permissions or session.id in getattr(self, '_skip_rest_sessions', set()))

    async def _rpc_userInteractionList(self, session_id: str, client_version: int = 0) -> str:
        scope = self._collaboration_scope(session_id)
        self._declare_interaction_client(client_version)
        registry = self._user_interactions()
        listing = await asyncio.to_thread(self._collaboration_store().list, scope, 'interaction', session_id=session_id, limit=30)
        rows = []
        for item in listing['items']:
            row = await asyncio.to_thread(self._collaboration_store().read, scope, 'interaction', item['id'])
            if row and row.get('status') in {'pending', 'responding'} and row['id'] not in registry.pending and row['id'] not in registry.registering and row['id'] not in registry.delivering:
                row = {**row, 'status': 'interrupted' if row['status'] == 'pending' else 'unknown',
                       'notice': '原生等待已不可恢复，请核对原运行；没有重发答案。'}
            if row:
                rows.append(row)
        self._collaboration_scope(session_id)
        from .interaction_capabilities import interaction_capability
        session = self._collaboration_session(session_id)
        config = next((item for item in self._backend_configs if item.id == session.backend_id), None)
        capability = interaction_capability(config, session) if config else None
        if capability is not None:
            capability['permissionNotice'] = ('已设置跳过执行确认。原生 never/yolo 未上报的审批不生成逐项批准记录；必要问题仍需回答。'
                                              if session.skip_permissions else '')
        return json.dumps({'version': 1, 'items': rows, 'capability': capability}, ensure_ascii=False)

    def _pending_interaction_summaries(self, session_id: str) -> list[dict]:
        registry = getattr(self, '_user_interaction_registry', None)
        if registry is None:
            return []
        return [{key: entry['row'][key] for key in ('id', 'sessionId', 'revision', 'status')}
                for entry in registry.pending.values() if entry['row']['sessionId'] == session_id
                and entry['scope'].owner == self._current_owner_id() and entry['row']['status'] == 'pending']

    async def _rpc_userInteractionRespond(self, session_id: str, request_id: str, response_json: str) -> str:
        self._window_guard(session_id)
        response = json.loads(response_json)
        if not isinstance(response, dict):
            raise CollaborationError('交互响应无效')
        result = await self._user_interactions().respond(self._collaboration_scope(session_id), session_id, request_id, response)
        return json.dumps(result, ensure_ascii=False)

    def _collaboration_scope(self, session_id: str) -> CollaborationScope:
        self._require_session_access(session_id)
        return CollaborationScope(self._current_owner_id(), self._loop_environment_executor())

    def _collaboration_store(self) -> CollaborationStore:
        store = getattr(self, '_session_collaboration_store', None)
        if store is None:
            store = self._session_collaboration_store = CollaborationStore()
        return store

    def _collaboration_session(self, session_id: str) -> Any:
        self._require_session_access(session_id)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        if session is None or session.owner_id != self._current_owner_id():
            raise PermissionError('Session 不可用')
        self._active_sessions.setdefault(session_id, session)
        return session

    def _rpc_sessionCollaborationCapabilities(self, session_id: str) -> str:
        scope = self._collaboration_scope(session_id)
        return json.dumps({'version': 1, 'executorId': scope.executor,
                           'sessionId': session_id, 'records': True, 'mergeWorkflow': 1, 'branchGraph': 1, 'branchSync': 1}, ensure_ascii=False)

    async def _rpc_sessionCollaborationList(self, session_id: str, kind: str, offset: int = 0,
                                           limit: int = 50, search: str = '') -> str:
        scope = self._collaboration_scope(session_id)
        result = await asyncio.to_thread(self._collaboration_store().list, scope, kind,
                                         session_id='' if kind == 'role' else session_id,
                                         offset=offset, limit=limit, search=search)
        self._collaboration_scope(session_id)  # 等待期间删除/身份变化不能返回旧来源。
        return json.dumps(result, ensure_ascii=False)

    async def _rpc_sessionCollaborationGet(self, session_id: str, kind: str, record_id: str,
                                          expected_revision: int = 0) -> str:
        scope = self._collaboration_scope(session_id)
        row = await asyncio.to_thread(self._collaboration_store().read, scope, kind, record_id)
        self._collaboration_scope(session_id)
        if row is None or kind != 'role' and session_id not in {row.get('sessionId'), row.get('sourceSessionId')}:
            raise CollaborationError('协作记录不可用')
        if expected_revision and row['revision'] != expected_revision:
            raise CollaborationError('协作记录已变化，请重新读取列表')
        return json.dumps(row, ensure_ascii=False)

    async def _rpc_sessionCollaborationRequestStatus(self, session_id: str, request_id: str) -> str:
        scope = self._collaboration_scope(session_id)
        row = await asyncio.to_thread(self._collaboration_store().request, scope, request_id)
        if not row or row.get('sessionId') != session_id:
            raise CollaborationError('请求不可用')
        return json.dumps(row, ensure_ascii=False)
