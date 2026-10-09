"""工作台协议与来源校验；能力声明不启动编辑、语言服务或终端。"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import asyncio
import hashlib
import json
import os
from pathlib import Path
import threading
from typing import Any
import uuid

PROTOCOL_VERSION = 1
ACTIVITY_KINDS = frozenset({'document-save', 'terminal', 'language-write'})


@dataclass(frozen=True)
class EngineeringActivity:
    """仅执行端持有的租约；RPC 不接受客户端伪造的活动/退出声明。"""
    workspace: WorkspaceIdentity
    activity_id: str
    kind: str
    control_revision: int


class WorkbenchError(ValueError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class WorkspaceIdentity:
    ownerId: str
    executorInstance: str
    sessionId: str
    workingDir: str
    workspaceRevision: str

    def to_dict(self) -> dict:
        return asdict(self)

    def require_match(self, expected: Any) -> None:
        # 不接受只有 Session ID 的弱校验，也不将调用方声明当作权威身份。
        if not isinstance(expected, dict) or expected != self.to_dict():
            raise WorkbenchError('stale_workspace')


@dataclass(frozen=True)
class DocumentVersion:
    sha256: str
    byteLength: int
    bufferRevision: int


@dataclass(frozen=True)
class ResourceIdentity:
    workspace: WorkspaceIdentity
    resourceId: str
    generation: str


def canonical_workspace(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or not Path(value).is_absolute():
        raise WorkbenchError('workspace_unavailable')
    return os.path.normcase(str(Path(value).resolve()))


class EngineWorkbenchBridge:
    async def _rpc_workspaceDocumentRead(self, session_id: str, identity_json: str,
                                          relative: str, preview: bool = False, request_id: str = '') -> str:
        from .workspace_documents import read_document
        from .loop_control import ID_PATTERN
        self._require_session_access(session_id)
        try:
            if (not isinstance(identity_json, str) or len(identity_json) > 16384 or type(preview) is not bool
                    or not isinstance(request_id, str) or request_id and not ID_PATTERN.fullmatch(request_id)):
                raise WorkbenchError('invalid_request')
            identity = self._workbench_identity(session_id)
            identity.require_match(json.loads(identity_json))
            if not hasattr(self, '_document_read_slots'):
                self._document_read_slots = asyncio.Semaphore(4)
                self._document_read_count = 0
                self._document_read_tasks: set[asyncio.Task] = set()
                self._document_pending_reads: dict[tuple, threading.Event] = {}
            if self._document_read_count >= 16:
                raise WorkbenchError('read_limit')
            request_key = (identity.workspaceRevision, session_id, request_id or uuid.uuid4().hex)
            if request_key in self._document_pending_reads:
                raise WorkbenchError('read_in_progress')
            cancelled = threading.Event()
            self._document_pending_reads[request_key] = cancelled
            self._document_read_count += 1
            async def owned_read() -> dict:
                try:
                    async with self._document_read_slots:
                        return await asyncio.to_thread(read_document, identity, relative, preview=preview, cancelled=cancelled)
                finally:
                    self._document_read_count -= 1
            task = asyncio.create_task(owned_read())
            self._document_read_tasks.add(task)
            def finished(done: asyncio.Task) -> None:
                self._document_read_tasks.discard(done)
                self._document_pending_reads.pop(request_key, None)
                if not done.cancelled():
                    done.exception()  # 客户端取消等待后也消费 worker 的异常。
            task.add_done_callback(finished)
            result = await asyncio.shield(task)
            if cancelled.is_set():
                raise WorkbenchError('read_cancelled')
            self._workbench_identity(session_id, identity.to_dict())
            session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
            state = self._loop_state(session_id) if session.session_type == 'loop' else None
            result['controlRevision'] = state.control_revision if state else 0
            try:
                self._engineering_check(session_id, identity.to_dict(), result['controlRevision'])
                result['canSave'] = result['editable']
                result['writeReasonCode'] = ''
            except WorkbenchError as error:
                result['canSave'] = False
                result['writeReasonCode'] = error.reason
            return json.dumps(result, ensure_ascii=False)
        except (ValueError, TypeError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode':
                getattr(error, 'reason', 'file_unavailable' if isinstance(error, OSError) else 'invalid_request')},
                ensure_ascii=False)

    def _engineering_registry(self) -> dict[str, EngineeringActivity]:
        # 与 loopControl 的检查/预留在同一事件循环内无 await 地执行。
        # 工作线程只能提交完成事件，不能直接修改登记或解除保护。
        loop = asyncio.get_running_loop()
        if not hasattr(self, '_engineering_event_loop'):
            self._engineering_event_loop = loop
            self._engineering_activities: dict[str, EngineeringActivity] = {}
        if self._engineering_event_loop is not loop:
            raise WorkbenchError('activity_wrong_event_loop')
        return self._engineering_activities

    def _engineering_active(self, session_id: str) -> tuple[EngineeringActivity, ...]:
        return tuple(item for item in getattr(self, '_engineering_activities', {}).values()
                     if item.workspace.sessionId == session_id)

    def _engineering_feedback(self, session_id: str) -> list[dict[str, Any]]:
        """只读的具体活动定位信息；不返回输入、源码、环境或客户端可解除的租约。"""
        result = []
        for lease in self._engineering_active(session_id):
            item = {'activityId': lease.activity_id, 'kind': lease.kind, 'workspace': lease.workspace.to_dict(),
                    'status': 'pending', 'resourceId': '', 'generation': '', 'relativePath': ''}
            manager = getattr(self, '_terminal_manager' if lease.kind == 'terminal' else '_language_manager', None)
            for row in getattr(manager, 'rows', {}).values():
                if row.lease is lease:
                    item.update(status=row.status, resourceId=row.resource_id, generation=row.generation)
                    break
            if lease.kind == 'document-save':
                for job in getattr(self, '_document_save_jobs', {}).values():
                    if job['lease'] is lease:
                        item.update(status=job['receipt']['status'], relativePath=job['receipt']['relativePath'])
                        break
            result.append(item)
        return result

    def _engineering_check(self, session_id: str, expected: Any,
                           control_revision: int) -> WorkspaceIdentity:
        identity = self._workbench_identity(session_id)
        identity.require_match(expected)
        if type(control_revision) is not int or not 0 <= control_revision <= 2**53 - 1:
            raise WorkbenchError('stale_control_revision')
        if self._loop_control_reserved(session_id):
            raise WorkbenchError('handoff_busy')
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        if session.session_type == 'loop':
            state = self._loop_state(session_id)
            if state is None:
                raise WorkbenchError('control_unavailable')
            if state.control_revision != control_revision:
                raise WorkbenchError('stale_control_revision')
            if state.control_mode != 'manual':
                raise WorkbenchError('manual_control_required')
            if self._loop_is_running(session_id) or self._loop_has_active_call(session_id):
                raise WorkbenchError('active_call')
        elif control_revision != 0:
            raise WorkbenchError('stale_control_revision')
        return identity

    def _engineering_admit(self, session_id: str, expected: Any,
                           control_revision: int, kind: str) -> EngineeringActivity:
        registry = self._engineering_registry()
        if kind not in ACTIVITY_KINDS:
            raise WorkbenchError('invalid_activity')
        identity = self._engineering_check(session_id, expected, control_revision)
        if len(registry) >= 1024 or len(self._engineering_active(session_id)) >= 128:
            raise WorkbenchError('activity_limit')
        lease = EngineeringActivity(identity, uuid.uuid4().hex, kind, control_revision)
        registry[lease.activity_id] = lease
        return lease

    def _engineering_recheck(self, lease: EngineeringActivity) -> None:
        registry = self._engineering_registry()
        if registry.get(lease.activity_id) is not lease:
            raise WorkbenchError('stale_activity')
        self._engineering_check(lease.workspace.sessionId, lease.workspace.to_dict(),
                                lease.control_revision)

    def _engineering_confirm_finished(self, lease: EngineeringActivity) -> None:
        """仅在所属写任务终态/所属进程树退出已确认后调用，不能放在 waiter finally。

        允许旧工作区的 owned worker 完成后解除旧租约，不能因此清除新代次活动。
        停止请求、超时、协程取消和客户端断线本身都没有释放入口。
        """
        registry = self._engineering_registry()
        if registry.get(lease.activity_id) is not lease:
            raise WorkbenchError('stale_activity')
        del registry[lease.activity_id]

    def _workbench_identity(self, session_id: str, expected: Any = None) -> WorkspaceIdentity:
        self._require_session_access(session_id)
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        if session is None or getattr(session, 'codex_connection_mode', None) == 'ssh':
            raise WorkbenchError('workspace_unavailable')
        directory = canonical_workspace(session.working_dir)
        if not Path(directory).is_dir():
            raise WorkbenchError('workspace_unavailable')
        if not hasattr(self, '_workbench_executor_instance'):
            self._workbench_executor_instance = str(uuid.uuid4())
        revision = hashlib.sha256(json.dumps(
            [session.owner_id, self._workbench_executor_instance, session.id, directory],
            ensure_ascii=False, separators=(',', ':'),
        ).encode('utf-8')).hexdigest()
        identity = WorkspaceIdentity(session.owner_id, self._workbench_executor_instance,
                                     session.id, directory, revision)
        if expected is not None:
            identity.require_match(expected)
        return identity

    def _rpc_sessionWorkbenchCapabilities(self, session_id: str, expected_workspace: str) -> str:
        from .workspace_terminals import terminal_shells
        self._require_session_access(session_id)
        try:
            identity = self._workbench_identity(session_id)
            if canonical_workspace(expected_workspace) != identity.workingDir:
                raise WorkbenchError('stale_workspace')
        except (WorkbenchError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'workspace_unavailable')}, ensure_ascii=False)
        # 未接入的能力必须保持 0，不能凭存在类型或依赖包宣告可使用。
        return json.dumps({'status': 'ok', 'protocolVersion': PROTOCOL_VERSION,
                           'identity': identity.to_dict(), 'capabilities': {
                               'viewMode': 1, 'windowHandoff': 1,
                               'documents': int(os.name == 'nt' or Path('/proc/self/fd').is_dir()),
                               'languageServices': 1, 'terminal': int(bool(terminal_shells())),
                           }}, ensure_ascii=False)
