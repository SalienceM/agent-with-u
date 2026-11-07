"""定时计划的事务账本。只在有界后台线程中调用，不访问聊天内存。"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from typing import Any, Iterator

from .session_schedule_rules import GRACE_SECONDS, ScheduleError, due_range, next_due, normalize_config

PENDING = ('prepared', 'queued')
LIVE = (*PENDING, 'claimed', 'running', 'unknown')


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def identity(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 160 or any(ord(c) < 32 for c in value):
        raise ScheduleError('定时记录身份无效')
    return value


class SessionScheduleStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise ScheduleError('定时存储来自较新版本，不能覆盖')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS schedules (
                    owner TEXT, executor TEXT, session TEXT, id TEXT, revision INTEGER,
                    enabled INTEGER, due REAL, body TEXT,
                    PRIMARY KEY(owner,executor,id));
                CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled,due);
                CREATE INDEX IF NOT EXISTS schedules_session ON schedules(owner,executor,session);
                CREATE TABLE IF NOT EXISTS occurrences (
                    owner TEXT, executor TEXT, session TEXT, id TEXT, schedule TEXT,
                    state TEXT, created REAL, dirty INTEGER, body TEXT,
                    PRIMARY KEY(owner,executor,id));
                CREATE INDEX IF NOT EXISTS occurrences_work ON occurrences(state,dirty);
                CREATE INDEX IF NOT EXISTS occurrences_session ON occurrences(owner,executor,session,created);
                CREATE TABLE IF NOT EXISTS requests (
                    owner TEXT, executor TEXT, session TEXT, id TEXT, digest TEXT, body TEXT,
                    PRIMARY KEY(owner,executor,id));
                CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, revision INTEGER);
                INSERT OR IGNORE INTO metadata VALUES (1,0);
                PRAGMA user_version=1;
            ''')

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=0.2, isolation_level=None)
        try:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            yield db
            if db.in_transaction:
                db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    @staticmethod
    def _bump(db: sqlite3.Connection) -> int:
        db.execute('UPDATE metadata SET revision=revision+1 WHERE id=1')
        return db.execute('SELECT revision FROM metadata WHERE id=1').fetchone()[0]

    @staticmethod
    def _row(db: sqlite3.Connection, table: str, scope: tuple[str, str], record_id: str) -> dict | None:
        result = db.execute(f'SELECT body FROM {table} WHERE owner=? AND executor=? AND id=?', (*scope, record_id)).fetchone()
        return json.loads(result[0]) if result else None

    @staticmethod
    def _schedule(db: sqlite3.Connection, row: dict) -> None:
        db.execute('INSERT OR REPLACE INTO schedules VALUES (?,?,?,?,?,?,?,?)',
                   (row['owner'], row['executor'], row['sessionId'], row['id'], row['revision'],
                    int(row['enabled'] and not row.get('deleted')), row['nextDueAt'], encoded(row)))

    @staticmethod
    def _occurrence(db: sqlite3.Connection, row: dict, *, dirty: bool = True) -> None:
        row['updatedAt'] = time.time()
        row['revision'] = row.get('revision', 0) + 1
        db.execute('INSERT OR REPLACE INTO occurrences VALUES (?,?,?,?,?,?,?,?,?)',
                   (row['owner'], row['executor'], row['sessionId'], row['id'], row['scheduleId'],
                    row['state'], row['createdAt'], int(dirty), encoded(row)))

    @staticmethod
    def _scope(scope: tuple[str, str], sid: str) -> None:
        for part in (*scope, sid):
            identity(part)

    def request(self, scope: tuple[str, str], sid: str, rid: str) -> dict:
        self._scope(scope, sid)
        with self.connection() as db:
            row = self._row(db, 'requests', scope, identity(rid))
            if row and row['sessionId'] != sid:
                raise ScheduleError('请求不属于当前 Session')
            return row or {'status': 'not_found', 'requestId': rid, 'sessionId': sid}

    def mutate(self, scope: tuple[str, str], sid: str, intent: dict, now: float) -> dict:
        self._scope(scope, sid)
        rid = identity(intent.get('requestId'))
        digest = hashlib.sha256(encoded(intent).encode()).hexdigest()
        with self.connection() as db:
            prior = db.execute('SELECT session,digest,body FROM requests WHERE owner=? AND executor=? AND id=?', (*scope, rid)).fetchone()
            if prior:
                if prior[:2] != (sid, digest):
                    raise ScheduleError('同一 requestId 不能用于不同操作')
                return json.loads(prior[2])
            action = intent.get('action')
            key = identity(intent.get('id'))
            if action in {'cancel', 'retry', 'resolve'}:
                result = self._attempt_action(db, scope, sid, key, action, rid, now)
            else:
                old = self._row(db, 'schedules', scope, key)
                revision = intent.get('expectedRevision')
                if type(revision) is not int or revision != (old['revision'] if old else 0):
                    raise ScheduleError('计划已变化，请读取当前版本；本地草稿已保留')
                if old and (old['sessionId'] != sid or old.get('deleted')):
                    raise ScheduleError('计划不可用')
                if action == 'save':
                    config = normalize_config(intent.get('config'), now)
                elif action in {'enable', 'delete'} and old:
                    config = {k: old[k] for k in ('version', 'title', 'prompt', 'timezone', 'rule', 'misfirePolicy', 'enabled')}
                    if action == 'enable':
                        if type(intent.get('enabled')) is not bool:
                            raise ScheduleError('启用状态无效')
                        config['enabled'] = intent['enabled']
                        if config['enabled']:
                            normalize_config(config, now)
                    else:
                        config['enabled'] = False
                else:
                    raise ScheduleError('计划操作无效')
                row = {**config, 'id': key, 'owner': scope[0], 'executor': scope[1], 'sessionId': sid,
                       'revision': revision + 1, 'createdAt': old['createdAt'] if old else now, 'updatedAt': now,
                       'nextDueAt': next_due(config, now) if config['enabled'] else None,
                       'consumedThrough': now, 'deleted': action == 'delete'}
                self._schedule(db, row)
                active = []
                for item in db.execute('SELECT body FROM occurrences WHERE owner=? AND executor=? AND schedule=? AND state IN (?,?,?,?,?)',
                                       (*scope, key, *PENDING, 'claimed', 'running', 'unknown')).fetchall():
                    occ = json.loads(item[0])
                    if occ['state'] in PENDING:
                        occ.update(state='cancelled', error='计划已修改或停用，原待执行实例已取消')
                        self._occurrence(db, occ)
                    else:
                        active.append({'id': occ['id'], 'state': occ['state']})
                result = {'schedule': row, 'active': active}
            serial = self._bump(db)
            receipt = {'status': 'succeeded', 'requestId': rid, 'sessionId': sid, 'revision': serial, **result}
            db.execute('INSERT INTO requests VALUES (?,?,?,?,?,?)', (*scope, sid, rid, digest, encoded(receipt)))
            return receipt

    def _attempt_action(self, db: sqlite3.Connection, scope: tuple[str, str], sid: str, key: str,
                        action: str, rid: str, now: float) -> dict:
        old = self._row(db, 'occurrences', scope, key)
        if not old or old['sessionId'] != sid:
            raise ScheduleError('触发记录不可用')
        if action == 'resolve':
            if old['state'] != 'unknown':
                raise ScheduleError('仅可核对结果未知的原运行')
            old.update(state='interrupted', resolved=True, error='用户核对后结束本次；不代表任务成功，也未重试')
            self._occurrence(db, old)
            return {'occurrence': old}
        if action == 'cancel':
            if old['state'] not in (*PENDING, 'failed', 'interrupted'):
                raise ScheduleError('本次已启动或结果未知；请先核对聊天运行')
            old.update(state='cancelled', error='用户取消本次；原输出保留')
            self._occurrence(db, old)
            return {'occurrence': old}
        if old['state'] not in {'failed', 'interrupted'}:
            raise ScheduleError('仅可显式重试已确认结束的失败项；结果未知不能重试')
        schedule = self._row(db, 'schedules', scope, old['scheduleId'])
        if not schedule or not schedule['enabled'] or schedule.get('deleted') or schedule['revision'] != old['scheduleRevision']:
            raise ScheduleError('计划已经停用或修改，请核对原输出并使用当前指令')
        pending = db.execute('SELECT 1 FROM occurrences WHERE owner=? AND executor=? AND schedule=? AND state IN (?,?)',
                             (*scope, old['scheduleId'], *PENDING)).fetchone()
        if pending:
            raise ScheduleError('该计划已有待执行项，请先处理后再重试')
        fresh = self._new_occurrence(schedule, old['scheduledAt'], old['coveredThrough'], old['coalescedCount'], now,
                                     suffix=rid)
        fresh['retryOf'] = old['id']
        self._occurrence(db, fresh)
        return {'occurrence': fresh}

    @staticmethod
    def _new_occurrence(schedule: dict, first: float, last: float, count: int, now: float, suffix: str = '') -> dict:
        key = hashlib.sha256(encoded([schedule['owner'], schedule['executor'], schedule['id'], schedule['revision'], first, suffix]).encode()).hexdigest()
        return {'id': key, 'owner': schedule['owner'], 'executor': schedule['executor'], 'sessionId': schedule['sessionId'],
                'scheduleId': schedule['id'], 'scheduleRevision': schedule['revision'], 'title': schedule['title'],
                'scheduledAt': first, 'coveredThrough': last, 'coalescedCount': count, 'promptSnapshot': schedule['prompt'],
                'state': 'prepared', 'createdAt': now, 'taskId': f'schedule-{key}',
                'userMessageId': f'schedule-user-{key}', 'assistantMessageId': f'schedule-assistant-{key}', 'error': ''}

    def consume(self, now: float, limit: int = 32) -> list[dict]:
        changed = []
        with self.connection() as db:
            schedules = db.execute('SELECT body FROM schedules WHERE enabled=1 AND due<=? ORDER BY due,id LIMIT ?', (now, limit)).fetchall()
            for record in schedules:
                row = json.loads(record[0])
                first = row['nextDueAt']
                total, last = due_range(row, first, now)
                if not total:
                    continue
                skip_count = 0
                if row['misfirePolicy'] == 'skip' and first < now - GRACE_SECONDS:
                    skip_count, skipped_last = due_range(row, first, now - GRACE_SECONDS - .00001)
                    if skip_count:
                        skipped = self._new_occurrence(row, first, skipped_last, skip_count, now)
                        skipped.update(state='skipped', error='超过调度宽限，按计划跳过')
                        self._occurrence(db, skipped, dirty=False)
                        first = next_due(row, skipped_last)
                if total > skip_count and first is not None:
                    existing = db.execute('SELECT body FROM occurrences WHERE owner=? AND executor=? AND schedule=? AND state IN (?,?)',
                                          (row['owner'], row['executor'], row['id'], *PENDING)).fetchone()
                    occ = json.loads(existing[0]) if existing else self._new_occurrence(row, first, last, 0, now)
                    occ.update(coveredThrough=last, coalescedCount=occ['coalescedCount'] + total - skip_count)
                    self._occurrence(db, occ)
                row.update(nextDueAt=next_due(row, last), consumedThrough=last)
                self._schedule(db, row)
                changed.append(row)
            if schedules:
                self._bump(db)
        return changed

    def work(self, limit: int = 128) -> list[dict]:
        with self.connection() as db:
            return [json.loads(row[0]) for row in db.execute(
                "SELECT body FROM occurrences WHERE dirty=1 ORDER BY json_extract(body,'$.scheduledAt'),schedule,created,id LIMIT ?", (limit,))]

    def dispatch_targets(self, after: str, limit: int = 128) -> list[str]:
        with self.connection() as db:
            return [row[0] for row in db.execute("SELECT DISTINCT session FROM occurrences WHERE state='queued' AND session>? ORDER BY session LIMIT ?", (after, limit))]

    def recover(self) -> None:
        with self.connection() as db:
            for value in db.execute('SELECT body FROM occurrences WHERE state IN (?,?)', ('claimed', 'running')).fetchall():
                row = json.loads(value[0])
                row.update(state='unknown', error='执行端重启，原轮次结果未确认；未自动重试')
                self._occurrence(db, row)
            db.execute("UPDATE occurrences SET dirty=1 WHERE state IN ('prepared','queued','unknown')")
            self._bump(db)

    def acknowledge(self, scope: tuple[str, str], key: str, revision: int) -> None:
        with self.connection() as db:
            # 新合并/取消不能被迟到队列回写清除。
            row = self._row(db, 'occurrences', scope, key)
            if row and row['revision'] == revision:
                db.execute('UPDATE occurrences SET dirty=0 WHERE owner=? AND executor=? AND id=?', (*scope, key))

    def transition(self, scope: tuple[str, str], key: str, state: str, *, error: str = '', runtime: dict | None = None) -> dict:
        with self.connection() as db:
            row = self._row(db, 'occurrences', scope, key)
            if row is None:
                raise ScheduleError('触发账本缺失；不能重新创建执行')
            previous = row['state']
            allowed = {'queued': PENDING, 'claimed': ('queued',), 'running': ('claimed',),
                       'completed': ('claimed', 'running'), 'failed': (*LIVE,),
                       'interrupted': ('claimed', 'running'), 'unknown': (*PENDING, 'claimed', 'running')}
            if previous == state:
                return row
            if previous not in allowed.get(state, ()):
                raise ScheduleError(f'触发状态已变化：{previous}')
            if state == 'claimed':
                schedule = self._row(db, 'schedules', scope, row['scheduleId'])
                if not schedule or not schedule['enabled'] or schedule.get('deleted') or schedule['revision'] != row['scheduleRevision']:
                    raise ScheduleError('计划已变更，不能领取旧实例')
                unresolved = db.execute("SELECT 1 FROM occurrences WHERE owner=? AND executor=? AND session=? AND state='unknown'", (*scope, row['sessionId'])).fetchone()
                if unresolved:
                    raise ScheduleError('本 Session 有定时执行结果未知，请先核对原运行')
            row.update(state=state, error=error[:500])
            if state == 'running':
                row['startedAt'] = time.time()
            if state in {'completed', 'failed', 'interrupted'}:
                row['endedAt'] = time.time()
            if runtime:
                row['runtime'] = runtime
            self._occurrence(db, row)
            self._bump(db)
            return row

    def get(self, scope: tuple[str, str], sid: str, key: str, *, occurrence: bool = False) -> dict:
        self._scope(scope, sid)
        with self.connection() as db:
            row = self._row(db, 'occurrences' if occurrence else 'schedules', scope, identity(key))
            if not row or row['sessionId'] != sid:
                raise ScheduleError('记录不可用')
            return row

    def listing(self, scope: tuple[str, str], sid: str, *, history: bool = False, offset: int = 0, limit: int = 30) -> dict:
        self._scope(scope, sid)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise ScheduleError('分页无效')
        with self.connection() as db:
            table = 'occurrences' if history else 'schedules'
            order = 'created DESC,id' if history else 'id'
            rows = db.execute(f'SELECT body FROM {table} WHERE owner=? AND executor=? AND session=? ORDER BY {order} LIMIT ? OFFSET ?',
                              (*scope, sid, limit + 1, offset)).fetchall()
            items = []
            for record in rows[:limit]:
                row = json.loads(record[0])
                items.append({key: value for key, value in row.items() if key not in {'prompt', 'promptSnapshot', 'owner'}})
            serial = db.execute('SELECT revision FROM metadata WHERE id=1').fetchone()[0]
            enabled_count = db.execute('SELECT count(*) FROM schedules WHERE owner=? AND executor=? AND session=? AND enabled=1', (*scope, sid)).fetchone()[0]
            latest = db.execute("SELECT body FROM occurrences WHERE owner=? AND executor=? AND session=? ORDER BY CASE WHEN state IN ('claimed','running','unknown') THEN 0 ELSE 1 END, created DESC,id LIMIT 1", (*scope, sid)).fetchone()
            activity = {k: v for k, v in json.loads(latest[0]).items() if k in {'id', 'revision', 'state', 'assistantMessageId', 'updatedAt'}} if latest else None
        return {'version': 1, 'sessionId': sid, 'executorId': scope[1], 'revision': serial, 'items': items,
                'enabledCount': enabled_count, 'activity': activity, 'nextOffset': offset + limit if len(rows) > limit else None}

    def archive(self, before: float) -> int:
        """只移除旧终态的大文本；身份、状态、消息 ID 和去重游标永久保留。"""
        with self.connection() as db:
            rows = db.execute("SELECT body FROM occurrences WHERE created<? AND state NOT IN ('prepared','queued','claimed','running','unknown') AND json_extract(body,'$.promptSnapshot') IS NOT NULL LIMIT 100", (before,)).fetchall()
            for value in rows:
                row = json.loads(value[0])
                row.pop('promptSnapshot', None)
                # 显式重试仍须核对原计划启用且修订相同，不能借当前文本覆盖原指令。
                row['archived'] = True
                self._occurrence(db, row, dirty=False)
            return len(rows)

    def has_unknown(self, scope: tuple[str, str], sid: str) -> bool:
        with self.connection() as db:
            return db.execute("SELECT 1 FROM occurrences WHERE owner=? AND executor=? AND session=? AND state='unknown'", (*scope, sid)).fetchone() is not None
