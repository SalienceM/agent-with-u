"""只读导航 RPC：绑定原工作区，取消只作用于对应请求，没有节点回退。"""
from __future__ import annotations

import asyncio
import json
import threading

from .engine_workbench import WorkbenchError
from .loop_control import ID_PATTERN
from .workspace_search import MAX_RESULTS, git_comparison, search_workspace


class WorkspaceSearchBridge:
    def _rpc_workspaceSearchCancel(self, session_id: str, identity_json: str, request_id: str) -> str:
        self._require_session_access(session_id)
        try:
            identity = self._search_identity(session_id, identity_json, request_id)
            event = getattr(self, '_workspace_searches', {}).get((identity.workspaceRevision, request_id))
            if event is not None:
                event.set()
            return json.dumps({'status': 'ok', 'requestId': request_id, 'cancelRequested': event is not None})
        except (ValueError, TypeError, OSError) as error:
            return self._search_error(error)

    def _search_identity(self, session_id: str, identity_json: str, request_id: str):
        if (not isinstance(identity_json, str) or len(identity_json) > 16384
                or not isinstance(request_id, str) or not ID_PATTERN.fullmatch(request_id)):
            raise WorkbenchError('invalid_request')
        return self._workbench_identity(session_id, json.loads(identity_json))

    @staticmethod
    def _search_error(error: Exception) -> str:
        return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'search_unavailable')})

    async def _rpc_workspaceSearch(self, session_id: str, identity_json: str, request_id: str,
                                    mode: str, query: str, limit: int = 200) -> str:
        self._require_session_access(session_id)
        try:
            identity = self._search_identity(session_id, identity_json, request_id)
            if (mode not in ('files', 'content') or not isinstance(query, str) or len(query) > 512
                    or '\0' in query or mode == 'content' and not query
                    or type(limit) is not int or not 1 <= limit <= MAX_RESULTS):
                raise WorkbenchError('invalid_request')
            patterns = tuple(self._sync_ignore_patterns())
            return await self._search_owned(identity, request_id, search_workspace, mode, query, limit, patterns)
        except (ValueError, TypeError, OSError) as error:
            return self._search_error(error)

    async def _rpc_workspaceGitComparison(self, session_id: str, identity_json: str,
                                           request_id: str, relative: str) -> str:
        self._require_session_access(session_id)
        try:
            identity = self._search_identity(session_id, identity_json, request_id)
            return await self._search_owned(identity, request_id, git_comparison, relative)
        except (ValueError, TypeError, OSError) as error:
            return self._search_error(error)

    async def _search_owned(self, identity, request_id: str, operation, *args) -> str:
        if not hasattr(self, '_workspace_searches'):
            self._workspace_searches = {}
            self._workspace_search_tasks = set()
            self._workspace_search_slots = asyncio.Semaphore(2)
        if len(self._workspace_searches) >= 8:
            raise WorkbenchError('search_limit')
        key = (identity.workspaceRevision, request_id)
        if key in self._workspace_searches:
            raise WorkbenchError('search_in_progress')
        event = threading.Event()
        self._workspace_searches[key] = event
        async def owned():
            try:
                async with self._workspace_search_slots:
                    if event.is_set():
                        raise WorkbenchError('search_cancelled')
                    return await asyncio.to_thread(operation, identity, *args, event)
            finally:
                self._workspace_searches.pop(key, None)
        task = asyncio.create_task(owned())
        self._workspace_search_tasks.add(task)
        def finished(done):
            self._workspace_search_tasks.discard(done)
            if not done.cancelled():
                done.exception()
        task.add_done_callback(finished)
        try:
            result = await asyncio.shield(task)
        except asyncio.CancelledError:
            event.set()  # 等待者放弃触发只读取消，但占用名额持续到 worker 实际结束。
            raise
        if event.is_set():
            raise WorkbenchError('search_cancelled')
        self._workbench_identity(identity.sessionId, identity.to_dict())
        result['requestId'] = request_id
        return json.dumps(result, ensure_ascii=False)
