"""保存由执行端拥有；RPC 等待者取消不会取消磁盘任务或解除 LOOP 准入。"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
import contextvars
import hashlib
import json
from typing import Any

from .engine_workbench import EngineeringActivity, WorkbenchError
from .loop_control import ID_PATTERN
from .workspace_documents import MAX_DOCUMENT_BYTES, atomic_save_document, read_document


class WorkspaceDocumentBridge:
    def _rpc_workspaceDocumentReadCancel(self, session_id: str, identity_json: str, request_id: str) -> str:
        self._require_session_access(session_id)
        try:
            if (not isinstance(identity_json, str) or len(identity_json) > 16384
                    or not isinstance(request_id, str) or not ID_PATTERN.fullmatch(request_id)):
                raise WorkbenchError('invalid_request')
            identity = self._workbench_identity(session_id)
            identity.require_match(json.loads(identity_json))
            pending = getattr(self, '_document_pending_reads', {}).get((identity.workspaceRevision, session_id, request_id))
            if pending is not None:
                pending.set()
            return json.dumps({'status': 'ok', 'requestId': request_id, 'cancelRequested': pending is not None})
        except (ValueError, TypeError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'invalid_request')})

    async def _rpc_workspaceDocumentRefresh(self, session_id: str, identity_json: str, documents_json: str) -> str:
        """只按用户打开的有界列表核对，不安装 watch、不遍历或后台轮询工作区。"""
        self._require_session_access(session_id)
        try:
            if not isinstance(identity_json, str) or len(identity_json) > 16384:
                raise WorkbenchError('invalid_request')
            identity = self._workbench_identity(session_id)
            identity.require_match(json.loads(identity_json))
            if not isinstance(documents_json, str) or len(documents_json) > 65536:
                raise WorkbenchError('invalid_request')
            documents = json.loads(documents_json)
            if not isinstance(documents, list) or len(documents) > 16 or any(
                    not isinstance(item, dict) or set(item) != {'relativePath', 'version'}
                    or not isinstance(item['relativePath'], str) for item in documents):
                raise WorkbenchError('invalid_request')
            result = []
            for item in documents:
                read = json.loads(await self._rpc_workspaceDocumentRead(session_id, identity_json, item['relativePath']))
                result.append({'relativePath': item['relativePath'], 'status': 'error' if read['status'] != 'ok'
                    else 'unchanged' if read['version'] is not None and read['version'] == item['version'] else 'changed',
                    'version': read.get('version'), 'reasonCode': read.get('reasonCode', ''),
                    'complete': read.get('complete', False), 'canSave': read.get('canSave', False),
                    'controlRevision': read.get('controlRevision')})
            self._workbench_identity(session_id, identity.to_dict())
            return json.dumps({'status': 'ok', 'workspace': identity.to_dict(), 'documents': result}, ensure_ascii=False)
        except (ValueError, TypeError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'invalid_request')})

    def _document_save_registry(self) -> OrderedDict:
        if not hasattr(self, '_document_save_jobs'):
            self._document_save_jobs = OrderedDict()
            self._document_save_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='awu-document')
        return self._document_save_jobs

    def _document_trim_receipts(self) -> None:
        jobs = self._document_save_registry()
        completed = [key for key, job in jobs.items() if job['receipt']['status'] in ('succeeded', 'failed')]
        for key in completed[:-256]:
            del jobs[key]

    async def _rpc_workspaceDocumentSave(self, session_id: str, identity_json: str, payload_json: str) -> str:
        self._require_session_access(session_id)
        try:
            if (not isinstance(identity_json, str) or len(identity_json) > 16384
                    or not isinstance(payload_json, str) or len(payload_json) > MAX_DOCUMENT_BYTES * 6 + 32768):
                raise WorkbenchError('invalid_request')
            identity = self._workbench_identity(session_id)
            identity.require_match(json.loads(identity_json))
            payload = json.loads(payload_json)
            if not isinstance(payload, dict) or set(payload) != {
                    'requestId', 'relativePath', 'baseVersion', 'bufferRevision', 'controlRevision', 'text'}:
                raise WorkbenchError('invalid_request')
            rid = payload['requestId']
            if (not isinstance(rid, str) or not ID_PATTERN.fullmatch(rid)
                    or not isinstance(payload['relativePath'], str) or len(payload['relativePath']) > 4096
                    or not isinstance(payload['text'], str) or len(payload['text']) > MAX_DOCUMENT_BYTES
                    or type(payload['bufferRevision']) is not int or not 0 <= payload['bufferRevision'] < 2**53):
                raise WorkbenchError('invalid_request')
            digest = hashlib.sha256(json.dumps(payload, ensure_ascii=True, sort_keys=True).encode()).hexdigest()
            jobs = self._document_save_registry()
            key = (identity.ownerId, identity.workspaceRevision, session_id, rid)
            existing = jobs.get(key)
            if existing:
                if existing['digest'] != digest:
                    raise WorkbenchError('request_conflict')
                return json.dumps(existing['receipt'], ensure_ascii=False)
            if sum(job['receipt']['status'] not in ('succeeded', 'failed') for job in jobs.values()) >= 32:
                raise WorkbenchError('save_limit')
            lease = self._engineering_admit(session_id, identity.to_dict(), payload['controlRevision'], 'document-save')
            loop = asyncio.get_running_loop()
            job = {'digest': digest, 'lease': lease, 'completed': loop.create_future(),
                   'receipt': {'status': 'accepted', 'requestId': rid,
                               'workspace': identity.to_dict(), 'relativePath': payload['relativePath'],
                               'bufferRevision': payload['bufferRevision']}}
            jobs[key] = job
            async def check() -> None:
                self._engineering_recheck(lease)
            def commit_gate() -> None:
                gate = asyncio.run_coroutine_threadsafe(check(), loop)
                try:
                    gate.result(timeout=12)
                except WorkbenchError:
                    raise
                except BaseException:
                    gate.cancel()
                    raise WorkbenchError('commit_check_unavailable')
            context = contextvars.copy_context()
            try:
                worker = self._document_save_executor.submit(context.run, atomic_save_document,
                    identity, payload['relativePath'], payload['baseVersion'], payload['text'], commit_gate)
            except Exception:
                self._engineering_confirm_finished(lease)  # 尚未提交到 worker，不存在未确认 I/O。
                job['receipt'].update(status='failed', reasonCode='worker_unavailable')
                job['completed'].set_result(None)
            else:
                job['worker'] = worker
                def finished(done: Future) -> None:
                    try:
                        loop.call_soon_threadsafe(self._document_finish_save, job, done)
                    except RuntimeError:
                        pass  # 事件循环关闭不构成清理证明；不能发布虚假的完成。
                worker.add_done_callback(finished)
            self._document_trim_receipts()
            return json.dumps(job['receipt'], ensure_ascii=False)
        except (ValueError, TypeError, KeyError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'invalid_request')}, ensure_ascii=False)

    def _document_finish_save(self, job: dict[str, Any], worker: Future) -> None:
        receipt = job['receipt']
        try:
            result = worker.result()
        except Exception as error:
            reason = getattr(error, 'reason', 'save_failed')
            receipt.update(status='unresolved' if reason == 'save_result_unverified' else 'failed', reasonCode=reason)
            job['savedHash'] = getattr(error, 'saved_hash', None)
        else:
            receipt.update(result)
        if receipt['status'] in ('succeeded', 'failed'):
            self._engineering_confirm_finished(job['lease'])
        if not job['completed'].done():
            job['completed'].set_result(None)
        self._document_trim_receipts()

    async def _rpc_workspaceDocumentSaveGet(self, session_id: str, identity_json: str,
                                            request_id: str, wait_seconds: int = 0) -> str:
        self._require_session_access(session_id)
        try:
            if (not isinstance(identity_json, str) or len(identity_json) > 16384
                    or not isinstance(request_id, str) or not ID_PATTERN.fullmatch(request_id)
                    or type(wait_seconds) is not int or not 0 <= wait_seconds <= 10):
                raise WorkbenchError('invalid_request')
            identity = self._workbench_identity(session_id)
            identity.require_match(json.loads(identity_json))
            job = getattr(self, '_document_save_jobs', {}).get(
                (identity.ownerId, identity.workspaceRevision, session_id, request_id))
            if not job:
                return json.dumps({'status': 'unknown', 'requestId': request_id, 'reasonCode': 'receipt_unavailable'})
            if wait_seconds and not job['completed'].done():
                try:
                    await asyncio.wait_for(asyncio.shield(job['completed']), wait_seconds)
                except asyncio.TimeoutError:
                    pass
            self._workbench_identity(session_id, identity.to_dict())
            if job['receipt']['status'] == 'unresolved' and job.get('savedHash'):
                if not job.get('reconcile') or job['reconcile'].done():
                    async def reconcile() -> None:
                        try:
                            observed = json.loads(await self._rpc_workspaceDocumentRead(
                                session_id, identity_json, job['receipt']['relativePath']))
                            version = observed.get('version') or {}
                            if observed.get('status') == 'ok' and version.get('sha256') == job['savedHash']:
                                job['receipt'].update(status='succeeded', reasonCode='', reconciled=True,
                                    document=observed['document'], version=version,
                                    encoding=observed['encoding'], bom=observed['bom'], eol=observed['eol'])
                                self._engineering_confirm_finished(job['lease'])
                        except (ValueError, OSError, PermissionError):
                            pass
                    job['reconcile'] = asyncio.create_task(reconcile())
                await asyncio.shield(job['reconcile'])
                self._workbench_identity(session_id, identity.to_dict())
            return json.dumps(job['receipt'], ensure_ascii=False)
        except (ValueError, TypeError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'invalid_request')})
