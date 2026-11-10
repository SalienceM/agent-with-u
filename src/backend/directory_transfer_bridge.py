"""受 Session 身份与工程写门禁保护的目录传输 RPC。"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from .directory_transfer import DirectoryTransfers
from .engine_workbench import canonical_workspace


class DirectoryTransferBridge:
    def _directory_transfers(self) -> DirectoryTransfers:
        if not hasattr(self, '_directory_transfer_manager'):
            self._directory_transfer_manager = DirectoryTransfers()
        return self._directory_transfer_manager

    @staticmethod
    def _directory_response(result: dict) -> str:
        return json.dumps({'status': 'ok', **result}, ensure_ascii=False)

    @staticmethod
    def _directory_error(error: Exception) -> str:
        return json.dumps({'status': 'error', 'message': str(error)}, ensure_ascii=False)

    def _directory_identity(self, session_id: str, identity_json: str) -> dict:
        self._require_session_access(session_id)
        return self._workbench_identity(session_id, json.loads(identity_json)).to_dict()

    def _rpc_syncTransferConfig(self, session_id: str, working_dir: str) -> str:
        try:
            self._require_session_access(session_id)
            identity = self._workbench_identity(session_id)
            if canonical_workspace(working_dir) != identity.workingDir:
                raise ValueError('工作目录变化')
            return self._directory_response({'version': 1, 'workspace': identity.to_dict(), 'ignore': self._sync_ignore_patterns()})
        except Exception as error:
            return self._directory_error(error)

    async def _rpc_syncTransferPlan(self, session_id: str, identity_json: str, payload_json: str) -> str:
        try:
            identity = self._directory_identity(session_id, identity_json)
            if not isinstance(payload_json, str) or len(payload_json) > 8 * 1024 * 1024:
                raise ValueError('传输清单过大')
            result = await asyncio.to_thread(self._directory_transfers().plan, identity, json.loads(payload_json), self._sync_ignore_patterns())
            self._workbench_identity(session_id, identity)
            return self._directory_response(result)
        except Exception as error:
            return self._directory_error(error)

    async def _rpc_syncTransferChunk(self, session_id: str, identity_json: str, plan_id: str, relative: str, offset: int, data: str) -> str:
        try:
            identity = self._directory_identity(session_id, identity_json)
            result = await asyncio.to_thread(self._directory_transfers().chunk, identity, plan_id, relative, offset, data)
            return self._directory_response(result)
        except Exception as error:
            return self._directory_error(error)

    async def _rpc_syncTransferCommit(self, session_id: str, identity_json: str, working_dir: str, plan_id: str) -> str:
        lease: Any = None
        try:
            identity = self._directory_identity(session_id, identity_json)
            if canonical_workspace(working_dir) != identity['workingDir']:
                raise ValueError('工作目录变化')
            manager = self._directory_transfers()
            row = manager.get(identity, plan_id)
            if row['state'] != 'preview':
                return self._directory_response(manager.public(row))
            if self._project_activity(working_dir):
                raise ValueError('目标项目仍在运行、写入或有未保存/未确认缓冲，请先处理')
            session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
            state = self._loop_state(session_id) if session.session_type == 'loop' else None
            lease = self._engineering_admit(session_id, identity, state.control_revision if state else 0, 'directory-transfer')
            loop = asyncio.get_running_loop()
            async def check() -> None:
                self._workbench_identity(session_id, identity)
                self._engineering_recheck(lease)
                self._project_check_write(working_dir=working_dir)
            def gate() -> None:
                future = asyncio.run_coroutine_threadsafe(check(), loop)
                try:
                    future.result(timeout=12)
                except BaseException:
                    future.cancel()
                    raise
            async def owned() -> str:
                return self._directory_response(await asyncio.to_thread(manager.commit, identity, plan_id, gate))
            async def guarded() -> str:
                try:
                    return await self._project_guarded_call(working_dir, owned())
                finally:
                    self._engineering_confirm_finished(lease)
                    self._project_branch_changed(working_dir)
            # 外层等待取消不取消磁盘提交，也不提前释放已有工程预留。
            task = asyncio.create_task(guarded())
            if not hasattr(self, '_directory_transfer_tasks'):
                self._directory_transfer_tasks = set()
            self._directory_transfer_tasks.add(task)
            def completed(done: asyncio.Task) -> None:
                self._directory_transfer_tasks.discard(done)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(completed)
            return await asyncio.shield(task)
        except Exception as error:
            return self._directory_error(error)

    def _rpc_syncTransferStatus(self, session_id: str, identity_json: str, plan_id: str) -> str:
        try:
            manager = self._directory_transfers()
            return self._directory_response(manager.public(manager.get(self._directory_identity(session_id, identity_json), plan_id)))
        except Exception as error:
            return self._directory_error(error)

    async def _rpc_syncTransferCancel(self, session_id: str, identity_json: str, plan_id: str) -> str:
        try:
            result = await asyncio.to_thread(self._directory_transfers().cancel, self._directory_identity(session_id, identity_json), plan_id)
            return self._directory_response(result)
        except Exception as error:
            return self._directory_error(error)
