"""显式同步审阅 RPC；每次校验 Session 所属身份，worker 与回执不依赖视图寿命。"""
from __future__ import annotations

import asyncio
import base64
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
import contextvars
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .engine_workbench import WorkbenchError, WorkspaceIdentity, canonical_workspace
from .loop_control import ID_PATTERN
from .sync_review import MAX_BYTES, MAX_LINES, MAX_LINE_LENGTH, read_review, apply_review


def response_error(error: Exception) -> str:
    return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason',
        'permission_denied' if isinstance(error, PermissionError) else 'file_unavailable' if isinstance(error, OSError) else 'invalid_request')})


class SyncReviewBridge:
    def _review_identity(self, session_id: str, identity_json: str) -> WorkspaceIdentity:
        if not isinstance(identity_json, str) or len(identity_json) > 16384:
            raise WorkbenchError('invalid_request')
        return self._workbench_identity(session_id, json.loads(identity_json))

    def _rpc_syncReviewCapabilities(self, session_id: str, expected_workspace: str) -> str:
        self._require_session_access(session_id)
        try:
            identity = self._workbench_identity(session_id)
            if canonical_workspace(expected_workspace) != identity.workingDir:
                raise WorkbenchError('stale_workspace')
            supported = os.name == 'nt' or Path('/proc/self/fd').is_dir()
            session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
            state = self._loop_state(session_id) if session.session_type == 'loop' else None
            revision = state.control_revision if state else 0
            reason = ''
            try:
                self._engineering_check(session_id, identity.to_dict(), revision)
            except WorkbenchError as error:
                reason = error.reason
            return json.dumps({'status': 'ok', 'protocolVersion': 1, 'workspace': identity.to_dict(),
                'read': supported, 'apply': supported and not reason, 'writeReasonCode': reason,
                'controlRevision': revision, 'maxBytes': MAX_BYTES, 'maxLines': MAX_LINES, 'maxLineLength': MAX_LINE_LENGTH})
        except (ValueError, TypeError, OSError) as error:
            return response_error(error)

    async def _review_read(self, session_id: str, identity_json: str, relative: str, include_data: bool) -> str:
        self._require_session_access(session_id)
        try:
            identity = self._review_identity(session_id, identity_json)
            if not hasattr(self, '_review_read_tasks'):
                self._review_read_tasks: set[asyncio.Task] = set()
                self._review_read_slots = asyncio.Semaphore(4)
            if len(self._review_read_tasks) >= 16:
                raise WorkbenchError('read_limit')
            async def owned() -> dict:
                async with self._review_read_slots:
                    return await asyncio.to_thread(read_review, identity, relative, include_data)
            task = asyncio.create_task(owned())
            self._review_read_tasks.add(task)
            def finished(done: asyncio.Task) -> None:
                self._review_read_tasks.discard(done)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
            result = await asyncio.shield(task)
            self._workbench_identity(session_id, identity.to_dict())
            return json.dumps(result, ensure_ascii=False)
        except (ValueError, TypeError, OSError) as error:
            return response_error(error)

    async def _rpc_syncReviewRead(self, session_id: str, identity_json: str, relative: str) -> str:
        return await self._review_read(session_id, identity_json, relative, True)

    async def _rpc_syncReviewCheck(self, session_id: str, identity_json: str, relative: str) -> str:
        return await self._review_read(session_id, identity_json, relative, False)

    def _review_jobs(self) -> OrderedDict:
        if not hasattr(self, '_sync_review_jobs'):
            self._sync_review_jobs = OrderedDict()
            self._sync_review_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='awu-sync-review')
        return self._sync_review_jobs

    def _review_trim(self) -> None:
        jobs = self._review_jobs()
        terminal = [key for key, job in jobs.items() if job['receipt']['status'] in ('succeeded', 'failed')]
        for key in terminal[:-256]:
            del jobs[key]

    async def _rpc_syncReviewApply(self, session_id: str, identity_json: str, payload_json: str) -> str:
        self._require_session_access(session_id)
        job = None
        try:
            identity = self._review_identity(session_id, identity_json)
            if not isinstance(payload_json, str) or len(payload_json) > MAX_BYTES * 2 + 32768:
                raise WorkbenchError('invalid_request')
            payload = json.loads(payload_json)
            if not isinstance(payload, dict) or set(payload) != {'requestId', 'relativePath', 'baseVersion',
                    'data', 'sourceHash', 'scopeKey', 'controlRevision'}:
                raise WorkbenchError('invalid_request')
            rid = payload['requestId']
            if (not isinstance(rid, str) or not ID_PATTERN.fullmatch(rid)
                    or not isinstance(payload['relativePath'], str) or len(payload['relativePath']) > 4096
                    or not isinstance(payload['scopeKey'], str) or len(payload['scopeKey']) > 16384
                    or not isinstance(payload['data'], str) or len(payload['data']) > ((MAX_BYTES + 2) // 3) * 4):
                raise WorkbenchError('invalid_request')
            data = base64.b64decode(payload['data'], validate=True)
            if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != payload['sourceHash']:
                raise WorkbenchError('invalid_source')
            digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
            jobs = self._review_jobs()
            key = (identity.ownerId, identity.workspaceRevision, session_id, rid)
            existing = jobs.get(key)
            if existing:
                if existing['digest'] != digest:
                    raise WorkbenchError('request_conflict')
                return json.dumps(existing['receipt'], ensure_ascii=False)
            if sum(j['receipt']['status'] not in ('succeeded', 'failed') for j in jobs.values()) >= 32:
                raise WorkbenchError('review_limit')
            if any(j['receipt']['status'] not in ('succeeded', 'failed') and j['lease'].workspace.workingDir == identity.workingDir
                   for j in jobs.values()):
                raise WorkbenchError('review_busy')
            lease = self._engineering_admit(session_id, identity.to_dict(), payload['controlRevision'], 'sync-review')
            loop = asyncio.get_running_loop()
            job = {'digest': digest, 'lease': lease, 'completed': loop.create_future(), 'receipt': {
                'status': 'accepted', 'requestId': rid, 'workspace': identity.to_dict(),
                'relativePath': payload['relativePath'], 'scopeKey': payload['scopeKey'], 'direction': 'push',
                'sourceHash': payload['sourceHash']}}
            jobs[key] = job
            async def check() -> None:
                self._engineering_recheck(lease)
            def gate() -> None:
                pending = asyncio.run_coroutine_threadsafe(check(), loop)
                try:
                    pending.result(timeout=12)
                except WorkbenchError:
                    raise
                except BaseException:
                    pending.cancel()
                    raise WorkbenchError('commit_check_unavailable')
            try:
                worker = self._sync_review_executor.submit(contextvars.copy_context().run, apply_review,
                    identity, payload['relativePath'], payload['baseVersion'], data, gate)
            except Exception:
                self._engineering_confirm_finished(lease)
                job['receipt'].update(status='failed', reasonCode='worker_unavailable')
                job['completed'].set_result(None)
            else:
                job['worker'] = worker
                def finished(done: Future) -> None:
                    try:
                        loop.call_soon_threadsafe(self._review_finished, job, done)
                    except RuntimeError:
                        pass
                worker.add_done_callback(finished)
            self._review_trim()
            return json.dumps(job['receipt'], ensure_ascii=False)
        except (ValueError, TypeError, KeyError, OSError) as error:
            # 已登记的请求只能返回其真实回执，不得让客户端误判为尚未提交。
            if job is not None:
                return json.dumps(job['receipt'], ensure_ascii=False)
            return response_error(error)

    def _review_finished(self, job: dict[str, Any], worker: Future) -> None:
        try:
            job['receipt'].update(worker.result())
        except Exception as error:
            reason = getattr(error, 'reason', 'write_failed')
            job['receipt'].update(status='unresolved' if reason == 'review_result_unverified' else 'failed', reasonCode=reason)
        if job['receipt']['status'] in ('succeeded', 'failed'):
            self._engineering_confirm_finished(job['lease'])
        if not job['completed'].done():
            job['completed'].set_result(None)
        self._review_trim()

    async def _rpc_syncReviewGet(self, session_id: str, identity_json: str, request_id: str, wait_seconds: int = 0) -> str:
        self._require_session_access(session_id)
        try:
            identity = self._review_identity(session_id, identity_json)
            if (not isinstance(request_id, str) or not ID_PATTERN.fullmatch(request_id)
                    or type(wait_seconds) is not int or not 0 <= wait_seconds <= 10):
                raise WorkbenchError('invalid_request')
            job = self._review_jobs().get((identity.ownerId, identity.workspaceRevision, session_id, request_id))
            if not job:
                return json.dumps({'status': 'unknown', 'requestId': request_id, 'reasonCode': 'receipt_unavailable'})
            if wait_seconds and not job['completed'].done():
                try:
                    await asyncio.wait_for(asyncio.shield(job['completed']), wait_seconds)
                except asyncio.TimeoutError:
                    pass
            self._workbench_identity(session_id, identity.to_dict())
            return json.dumps(job['receipt'], ensure_ascii=False)
        except (ValueError, TypeError, OSError) as error:
            return response_error(error)
