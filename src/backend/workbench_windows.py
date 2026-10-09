"""客户端实例内的窗口归属；断线、超时和心跳缺失都不转移归属。"""
from __future__ import annotations

from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass, field
import hashlib
import json
import re
from typing import Any

from .engine_workbench import WorkbenchError, WorkspaceIdentity

WINDOW_REQUEST: ContextVar[dict[str, Any] | None] = ContextVar('awu_window_request', default=None)
_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
_HASH = re.compile(r'^[a-f0-9]{64}$')


def identifier(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise WorkbenchError('invalid_window_identity')
    return value


@dataclass
class WindowRecord:
    workspace: WorkspaceIdentity
    client_id: str
    window_id: str
    generation: int = 1
    revision: int = 1
    pending: dict[str, Any] | None = None
    receipts: OrderedDict[str, dict[str, Any]] = field(default_factory=OrderedDict)

    def snapshot(self) -> dict[str, Any]:
        # 不持有正文、附件、凭据或一次性工具授权。
        return {'status': 'ok', 'workspace': self.workspace.to_dict(), 'clientId': self.client_id,
                'windowId': self.window_id, 'generation': self.generation, 'revision': self.revision,
                'frozen': self.pending is not None, 'pending': dict(self.pending) if self.pending else None}


class WorkbenchWindows:
    """仅事件循环内调用，无 await 的比较/冻结/提交边界。后台重启后原代次不复活。"""
    def __init__(self) -> None:
        self.records: dict[tuple[str, str, str, str], WindowRecord] = {}

    def key(self, workspace: WorkspaceIdentity, client: str) -> tuple[str, str, str, str]:
        return workspace.ownerId, identifier(client), workspace.sessionId, workspace.workspaceRevision

    def get(self, workspace: WorkspaceIdentity, client: str) -> WindowRecord | None:
        record = self.records.get(self.key(workspace, client))
        if record:
            record.workspace.require_match(workspace.to_dict())
        return record

    def register(self, workspace: WorkspaceIdentity, client: str, window: str) -> dict[str, Any]:
        identifier(window)
        record = self.get(workspace, client)
        if record is None:
            if len(self.records) >= 4096:
                raise WorkbenchError('window_registry_full')
            record = WindowRecord(workspace, client, window)
            self.records[self.key(workspace, client)] = record
        # 注册/刷新绝不抢占既有窗口，也不取消未完成操作。
        return record.snapshot()

    def require(self, workspace: WorkspaceIdentity, client: str, window: str, generation: Any,
                *, frozen_ok: bool = False) -> WindowRecord:
        record = self.get(workspace, client)
        if record is None or record.window_id != identifier(window) or type(generation) is not int or generation != record.generation:
            raise WorkbenchError('stale_window_generation')
        if record.pending and not frozen_ok:
            raise WorkbenchError('window_handoff_busy')
        return record

    @staticmethod
    def remember(record: WindowRecord, receipt: dict[str, Any]) -> dict[str, Any]:
        record.receipts[receipt['requestId']] = receipt
        while len(record.receipts) > 64:
            record.receipts.popitem(last=False)
        return dict(receipt)

    def receipt(self, workspace: WorkspaceIdentity, client: str, request: str) -> dict[str, Any]:
        record = self.get(workspace, client)
        row = record.receipts.get(identifier(request)) if record else None
        return dict(row) if row else {'status': 'unknown', 'requestId': request}

    def prepare(self, workspace: WorkspaceIdentity, client: str, window: str, generation: int,
                request: str, target: str, digest: str, version: int, busy: bool = False) -> dict[str, Any]:
        identifier(request); identifier(target)
        if target == window or not isinstance(digest, str) or not _HASH.fullmatch(digest) or type(version) is not int or not 0 <= version < 2**53:
            raise WorkbenchError('invalid_handoff_plan')
        fingerprint = hashlib.sha256(json.dumps([window, generation, target, digest, version]).encode()).hexdigest()
        record = self.get(workspace, client)
        old = record.receipts.get(request) if record else None
        if old:
            if old['fingerprint'] != fingerprint:
                raise WorkbenchError('window_request_conflict')
            return dict(old)
        record = self.require(workspace, client, window, generation)
        if busy:
            raise WorkbenchError('window_operation_in_flight')
        record.pending = {'requestId': request, 'sourceWindow': window, 'targetWindow': target,
                          'generation': generation, 'stateDigest': digest, 'stateVersion': version,
                          'fingerprint': fingerprint, 'status': 'prepared'}
        record.revision += 1
        return self.remember(record, record.pending)

    def ack(self, workspace: WorkspaceIdentity, client: str, window: str, request: str,
            digest: str, version: int) -> dict[str, Any]:
        record = self.get(workspace, client)
        row = record.receipts.get(identifier(request)) if record else None
        if not row or row['targetWindow'] != window or row['stateDigest'] != digest or row['stateVersion'] != version:
            raise WorkbenchError('handoff_ack_mismatch')
        if row['status'] in ('committed', 'cancelled'):
            return dict(row)
        if record.pending is not row:
            raise WorkbenchError('stale_handoff')
        row['status'] = 'acknowledged'; record.revision += 1
        return dict(row)

    def finish(self, workspace: WorkspaceIdentity, client: str, window: str, generation: int,
               request: str, fingerprint: str, commit: bool) -> dict[str, Any]:
        record = self.get(workspace, client)
        row = record.receipts.get(identifier(request)) if record else None
        if not row or row['sourceWindow'] != window or row['generation'] != generation or row['fingerprint'] != fingerprint:
            raise WorkbenchError('stale_handoff')
        if row['status'] in ('committed', 'cancelled'):
            return dict(row)
        self.require(workspace, client, window, generation, frozen_ok=True)
        if record.pending is not row or commit and row['status'] != 'acknowledged':
            raise WorkbenchError('handoff_not_ready')
        if commit:
            record.window_id = row['targetWindow']; record.generation += 1
        record.revision += 1; record.pending = None
        row.update(status='committed' if commit else 'cancelled', committedGeneration=record.generation,
                   ownerWindow=record.window_id, revision=record.revision)
        return dict(row)

    def reclaim(self, workspace: WorkspaceIdentity, client: str, window: str, request: str,
                expected_window: str, generation: int, revision: int, busy: bool = False) -> dict[str, Any]:
        """用户显式收回视图归属；不是证明旧窗口或后台进程已退出。"""
        identifier(window); identifier(request); identifier(expected_window)
        record = self.get(workspace, client)
        fingerprint = hashlib.sha256(json.dumps(['reclaim', window, expected_window, generation, revision]).encode()).hexdigest()
        old = record.receipts.get(request) if record else None
        if old:
            if old.get('fingerprint') != fingerprint:
                raise WorkbenchError('window_request_conflict')
            return dict(old)
        if (not record or type(generation) is not int or type(revision) is not int
                or record.window_id != expected_window or record.generation != generation or record.revision != revision):
            raise WorkbenchError('stale_window_recovery')
        if busy:
            raise WorkbenchError('window_operation_in_flight')
        # 旧交接回执必须变成取消态，迟到 commit/ACK 不能覆盖本次显式恢复。
        if record.pending:
            record.pending.update(status='cancelled', ownerWindow=record.window_id,
                                  committedGeneration=record.generation, revision=record.revision + 1)
        record.pending = None; record.window_id = window
        record.generation += 1; record.revision += 1
        return self.remember(record, {'status': 'reclaimed', 'requestId': request, 'fingerprint': fingerprint,
                                     'windowId': window, 'generation': record.generation, 'revision': record.revision})


class WorkbenchWindowBridge:
    def _windows(self) -> WorkbenchWindows:
        if not hasattr(self, '_window_registry'):
            self._window_registry = WorkbenchWindows()
        return self._window_registry

    def _window_bind_connection(self, websocket: Any, metadata: Any) -> dict[str, Any] | None:
        bindings = getattr(self, '_window_connection_bindings', None)
        if bindings is None:
            bindings = self._window_connection_bindings = {}
        previous = bindings.get(websocket)
        if metadata is None:
            if previous:
                raise WorkbenchError('window_metadata_required')
            return None  # 未加入工作台实例的旧客户端保持既有能力。
        if not isinstance(metadata, dict) or set(metadata) - {'clientId', 'windowId', 'documentId', 'lease'}:
            raise WorkbenchError('invalid_window_identity')
        client, window = identifier(metadata.get('clientId')), identifier(metadata.get('windowId'))
        document = identifier(metadata.get('documentId', 'legacy'))
        identity = (self._current_owner_id(), client, window, document)
        if previous and previous != identity:
            raise WorkbenchError('window_connection_identity_changed')
        if any(sock is not websocket and ident[:3] == identity[:3] and (ident[3] != document or document == 'legacy') for sock, ident in bindings.items()):
            raise WorkbenchError('window_connection_exists')
        bindings[websocket] = identity
        return metadata

    def _window_request_identity(self, session_id: str, identity_json: str) -> tuple[WorkspaceIdentity, dict[str, Any]]:
        metadata = WINDOW_REQUEST.get()
        if not metadata:
            raise WorkbenchError('window_metadata_required')
        if not isinstance(identity_json, str) or len(identity_json) > 16384:
            raise WorkbenchError('invalid_request')
        return self._workbench_identity(session_id, json.loads(identity_json)), metadata

    def _window_guard(self, session_id: str) -> None:
        metadata = WINDOW_REQUEST.get()
        if not metadata:
            return
        if not metadata.get('lease') and not any(key[:3] == (self._current_owner_id(), metadata['clientId'], session_id)
                                                for key in self._windows().records):
            return  # 未登记且无工程目录的普通 Chat 仍可工作，不把窗口协议变成 cwd 限制。
        workspace = self._workbench_identity(session_id)
        lease = metadata.get('lease')
        if lease is not None and (not isinstance(lease, dict) or lease.get('sessionId') != session_id or lease.get('workspaceRevision') != workspace.workspaceRevision):
            raise WorkbenchError('stale_window_generation')
        record = self._windows().get(workspace, metadata['clientId'])
        if record is None:
            return  # 注册前尚无有状态窗口；能力协商不会创建归属。
        if not isinstance(lease, dict) or lease.get('sessionId') != session_id or lease.get('workspaceRevision') != workspace.workspaceRevision:
            raise WorkbenchError('window_lease_required')
        self._windows().require(workspace, metadata['clientId'], metadata['windowId'], lease.get('generation'))

    def _rpc_workbenchWindow(self, session_id: str, identity_json: str, payload_json: str) -> str:
        self._require_session_access(session_id)
        try:
            workspace, meta = self._window_request_identity(session_id, identity_json)
            if not isinstance(payload_json, str) or len(payload_json) > 4096:
                raise WorkbenchError('invalid_request')
            p = json.loads(payload_json)
            if not isinstance(p, dict):
                raise WorkbenchError('invalid_request')
            registry, client, window = self._windows(), meta['clientId'], meta['windowId']
            action = p.get('action')
            if action == 'register':
                result = registry.register(workspace, client, window)
            elif action == 'get':
                record = registry.get(workspace, client)
                result = record.snapshot() if record else {'status': 'unregistered', 'workspace': workspace.to_dict()}
                if p.get('requestId'):
                    result['receipt'] = registry.receipt(workspace, client, p['requestId'])
            elif action == 'prepare':
                busy = any(item.kind == 'document-save' for item in self._engineering_active(session_id))
                result = registry.prepare(workspace, client, window, p.get('generation'), p.get('requestId'),
                    p.get('targetWindow'), p.get('stateDigest'), p.get('stateVersion'), busy)
            elif action == 'ack':
                result = registry.ack(workspace, client, window, p.get('requestId'), p.get('stateDigest'), p.get('stateVersion'))
            elif action in ('commit', 'cancel'):
                result = registry.finish(workspace, client, window, p.get('generation'), p.get('requestId'), p.get('fingerprint'), action == 'commit')
            elif action == 'reclaim':
                busy = any(item.kind == 'document-save' for item in self._engineering_active(session_id))
                result = registry.reclaim(workspace, client, window, p.get('requestId'), p.get('expectedWindow'),
                                          p.get('generation'), p.get('revision'), busy)
            else:
                raise WorkbenchError('invalid_request')
            return json.dumps(result, ensure_ascii=False)
        except (ValueError, TypeError, KeyError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'invalid_request')})
