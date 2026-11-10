"""协作 sidecar：短事务、CAS 修订和请求去重；不保存任何临时工具授权。"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from typing import Any, Iterator

from . import paths

KINDS = frozenset({'role', 'roleSession', 'roleBinding', 'review', 'report', 'snapshot', 'reference', 'workspace', 'merge', 'interaction', 'kitDelegation', 'projectTransfer'})
SUMMARY_FIELDS = frozenset({'title', 'name', 'status', 'sessionId', 'sourceSessionId', 'parentSessionId',
                            'roleId', 'batchId', 'workspaceId', 'relationKind', 'archived', 'counts',
                            'backendId', 'phase', 'requestId', 'messageId', 'enabled'})
MAX_RECORD_BYTES = 2 * 1024 * 1024


class CollaborationError(ValueError):
    pass


@dataclass(frozen=True)
class CollaborationScope:
    owner: str
    executor: str

    def __post_init__(self) -> None:
        for value in (self.owner, self.executor):
            if not isinstance(value, str) or not value.strip() or len(value) > 256:
                raise CollaborationError('协作身份缺失或无效')


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def identifier(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 200 or any(ord(c) < 32 for c in value):
        raise CollaborationError('协作记录 ID 无效')
    return value


class CollaborationStore:
    """SQLite 是独立 sidecar，不迁移 Session JSON；事务同时提交正文、摘要和回执。"""

    def __init__(self, database: Path | None = None) -> None:
        self.path = database or paths.sub('session-collaboration', 'state.sqlite3')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise CollaborationError('协作存储来自较新版本，不能覆盖')
            db.execute('''CREATE TABLE IF NOT EXISTS records (
                owner TEXT NOT NULL, executor TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
                revision INTEGER NOT NULL, updated REAL NOT NULL, body TEXT NOT NULL, summary TEXT NOT NULL,
                PRIMARY KEY (owner, executor, kind, id))''')
            db.execute('''CREATE TABLE IF NOT EXISTS requests (
                owner TEXT NOT NULL, executor TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
                digest TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
                PRIMARY KEY (owner, executor, id))''')
            db.execute('PRAGMA user_version=1')
            db.execute('''CREATE TABLE IF NOT EXISTS project_gates (
                executor TEXT NOT NULL, root TEXT NOT NULL, body TEXT NOT NULL,
                PRIMARY KEY (executor, root))''')

    def project_gates(self, executor: str) -> list[dict]:
        with self._connection() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT body FROM project_gates WHERE executor=?', (executor,))]

    def project_gate_save(self, executor: str, gate: dict) -> None:
        with self._connection() as db:
            previous = db.execute('SELECT body FROM project_gates WHERE executor=? AND root=?', (executor, gate['root'])).fetchone()
            if previous and any(json.loads(previous[0]).get(key) != gate.get(key) for key in ('operationId', 'owner')):
                raise CollaborationError('目标有未完成操作，不能覆盖预留')
            db.execute('INSERT OR REPLACE INTO project_gates VALUES (?,?,?)', (executor, gate['root'], canonical(gate)))

    def project_gate_remove(self, executor: str, root: str, operation: str) -> None:
        with self._connection() as db:
            db.execute("DELETE FROM project_gates WHERE executor=? AND root=? AND json_extract(body, '$.operationId')=?", (executor, root, operation))

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(str(self.path), timeout=10, isolation_level=None)
        try:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    @staticmethod
    def _keys(scope: CollaborationScope, kind: str, record_id: str) -> tuple[str, str, str, str]:
        if kind not in KINDS:
            raise CollaborationError('不支持的协作记录类型')
        return scope.owner, scope.executor, kind, identifier(record_id)

    def read(self, scope: CollaborationScope, kind: str, record_id: str) -> dict | None:
        with self._connection() as db:
            row = db.execute('SELECT body FROM records WHERE owner=? AND executor=? AND kind=? AND id=?',
                             self._keys(scope, kind, record_id)).fetchone()
        return json.loads(row[0]) if row else None

    def write(self, scope: CollaborationScope, kind: str, record_id: str, body: dict,
              expected_revision: int) -> dict:
        keys = self._keys(scope, kind, record_id)
        if type(expected_revision) is not int or expected_revision < 0 or not isinstance(body, dict):
            raise CollaborationError('协作修订无效')
        result = {**body, 'id': record_id, 'revision': expected_revision + 1, 'updatedAt': time.time()}
        encoded = canonical(result)
        if len(encoded.encode('utf-8')) > MAX_RECORD_BYTES:
            raise CollaborationError('协作记录超过大小限制')
        summary = {key: value[:300] if isinstance(value, str) else value
                   for key, value in result.items() if key in SUMMARY_FIELDS
                   and (isinstance(value, (str, bool, int)) or value is None)}
        if isinstance(result.get('counts'), dict):
            summary['counts'] = {key: value for key, value in list(result['counts'].items())[:12]
                                 if isinstance(key, str) and len(key) <= 30 and type(value) is int and 0 <= value <= 1_000_000}
        summary.update(id=record_id, revision=result['revision'], updatedAt=result['updatedAt'])
        with self._connection() as db:
            row = db.execute('SELECT revision FROM records WHERE owner=? AND executor=? AND kind=? AND id=?', keys).fetchone()
            if (row[0] if row else 0) != expected_revision:
                raise CollaborationError('协作记录已变化，请重新读取')
            db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?,?)',
                       (*keys, result['revision'], result['updatedAt'], encoded, canonical(summary)))
        return result

    def list(self, scope: CollaborationScope, kind: str, *, session_id: str = '',
             offset: int = 0, limit: int = 50, search: str = '') -> dict:
        if kind not in KINDS or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise CollaborationError('协作分页参数无效')
        # 摘要独立列，列表不加载报告/输入正文。按 session 的过滤也在数据库内完成。
        query = 'FROM records WHERE owner=? AND executor=? AND kind=?'
        args: list[Any] = [scope.owner, scope.executor, kind]
        if kind == 'workspace':
            # 已移除的预览保留原 ID/回执供核对，但不占普通列表的分页名额。
            query += " AND coalesce(json_extract(summary, '$.status'), '') != 'discarded'"
        if not isinstance(search, str) or len(search) > 100:
            raise CollaborationError('协作查询过长')
        if search:
            query += " AND instr(lower(coalesce(json_extract(summary, '$.name'), '')), lower(?))>0"
            args.append(search)
        if session_id:
            query += " AND (json_extract(summary, '$.sessionId')=? OR json_extract(summary, '$.sourceSessionId')=?)"
            args.extend([session_id, session_id])
        with self._connection() as db:
            rows = db.execute('SELECT summary ' + query + ' ORDER BY updated DESC, id LIMIT ? OFFSET ?',
                              (*args, limit + 1, offset)).fetchall()
        return {'items': [json.loads(row[0]) for row in rows[:limit]], 'offset': offset,
                'nextOffset': offset + limit if len(rows) > limit else None}

    def merge_operations(self, scope: CollaborationScope, session_id: str, *, source: str = '',
                         target: str = '', offset: int = 0, limit: int = 30) -> dict:
        """旧记录无需迁移；数据库投影有界摘要，不把历史正文载入进程。"""
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise CollaborationError('合并分页参数无效')
        query = "FROM records WHERE owner=? AND executor=? AND kind='merge'"
        args: list[Any] = [scope.owner, scope.executor]
        query += " AND ? IN (json_extract(body,'$.sourceSessionId'),json_extract(body,'$.source.sessionId'),json_extract(body,'$.target.sessionId'),json_extract(body,'$.integration.sessionId'))"
        args.append(session_id)
        for side, value in (('source', source), ('target', target)):
            if value:
                query += f" AND json_extract(body,'$.{side}.sessionId')=?"
                args.append(value)
        fields = {'id': '$.id', 'title': '$.title', 'status': '$.status', 'revision': '$.revision',
                  'updatedAt': '$.updatedAt', 'createdAt': '$.createdAt', 'originSessionId': '$.sourceSessionId',
                  'sourceSessionId': '$.source.sessionId', 'targetSessionId': '$.target.sessionId',
                  'integrationSessionId': '$.integration.sessionId', 'sourceHead': '$.source.head',
                  'targetHead': '$.target.head', 'targetBranch': '$.target.branch', 'finalHead': '$.finalHead',
                  'candidate': '$.candidate'}
        projection = ','.join(f"'{key}',json_extract(body,'{path}')" for key, path in fields.items())
        with self._connection() as db:
            rows = db.execute('SELECT json_object(' + projection + ') ' + query +
                              ' ORDER BY updated DESC,id LIMIT ? OFFSET ?', (*args, limit + 1, offset)).fetchall()
        return {'items': [json.loads(row[0]) for row in rows[:limit]], 'offset': offset,
                'nextOffset': offset + limit if len(rows) > limit else None}

    def begin_request(self, scope: CollaborationScope, request_id: str, kind: str, intent: dict) -> tuple[dict, bool]:
        """返回 (原回执, 是否首次登记)。重试只能查询，不能自动再次执行副作用。"""
        identifier(request_id)
        digest = fingerprint({'kind': kind, 'intent': intent})
        receipt = {'requestId': request_id, 'kind': kind, 'status': 'accepted', 'revision': 1,
                   'createdAt': time.time(), 'intentFingerprint': digest,
                   'sessionId': str(intent.get('sessionId') or '')}
        with self._connection() as db:
            row = db.execute('SELECT digest, body FROM requests WHERE owner=? AND executor=? AND id=?',
                             (scope.owner, scope.executor, request_id)).fetchone()
            if row:
                if row[0] != digest:
                    raise CollaborationError('同一 requestId 不能用于不同操作')
                return json.loads(row[1]), False
            db.execute('INSERT INTO requests VALUES (?,?,?,?,?,?,?)',
                       (scope.owner, scope.executor, request_id, kind, digest, 1, canonical(receipt)))
        return receipt, True

    def request(self, scope: CollaborationScope, request_id: str) -> dict | None:
        with self._connection() as db:
            row = db.execute('SELECT body FROM requests WHERE owner=? AND executor=? AND id=?',
                             (scope.owner, scope.executor, identifier(request_id))).fetchone()
        return json.loads(row[0]) if row else None

    def finish_request(self, scope: CollaborationScope, request_id: str, revision: int, status: str,
                       result: dict | None = None) -> dict:
        if status not in {'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'waiting_approval'}:
            raise CollaborationError('请求状态无效')
        with self._connection() as db:
            keys = (scope.owner, scope.executor, identifier(request_id))
            row = db.execute('SELECT body FROM requests WHERE owner=? AND executor=? AND id=?', keys).fetchone()
            if not row:
                raise CollaborationError('请求不存在')
            receipt = json.loads(row[0])
            if receipt['revision'] != revision or receipt['status'] in {'succeeded', 'failed', 'cancelled'}:
                raise CollaborationError('请求已变化或结束')
            receipt.update(status=status, revision=revision + 1, result=result or {}, updatedAt=time.time())
            encoded = canonical(receipt)
            if len(encoded.encode('utf-8')) > MAX_RECORD_BYTES:
                raise CollaborationError('回执超过大小限制')
            db.execute('UPDATE requests SET revision=?, body=? WHERE owner=? AND executor=? AND id=?',
                       (revision + 1, encoded, *keys))
        return receipt
