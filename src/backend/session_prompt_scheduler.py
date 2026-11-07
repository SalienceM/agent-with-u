"""执行端定时服务：有界后台账本、持久 outbox 与普通序列调度交接。"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import functools
import os
from pathlib import Path
import sys
import time
from typing import Any, Callable

from .chat_extras_store import SeqTask
from .session_schedule_rules import ScheduleError
from .session_schedule_store import PENDING, SessionScheduleStore


class ScheduleLease:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = path.open('a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                self.stream.seek(0, os.SEEK_END)
                if not self.stream.tell():
                    self.stream.write(b'\0')
                    self.stream.flush()
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            raise ScheduleError('另一执行进程持有定时调度锁，本进程不能派发') from exc

    def close(self) -> None:
        self.stream.close()


class ScheduleIO:
    """取消 RPC 等待者不取消已提交磁盘工作；未决数含正在运行的工作。"""
    def __init__(self) -> None:
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='session-schedule')
        self.pending: set[asyncio.Future] = set()
        self.closed = False

    async def run(self, fn: Callable, *args: Any, **kwargs: Any) -> Any:
        if self.closed or len(self.pending) >= 64:
            raise ScheduleError('定时存储繁忙，请稍后核对状态')
        future = asyncio.get_running_loop().run_in_executor(self.pool, functools.partial(fn, *args, **kwargs))
        self.pending.add(future)
        def finished(done: asyncio.Future) -> None:
            self.pending.discard(done)
            if not done.cancelled():
                done.exception()
        future.add_done_callback(finished)
        return await asyncio.shield(future)

    async def close(self) -> None:
        self.closed = True
        await asyncio.gather(*list(self.pending), return_exceptions=True)
        self.pool.shutdown(wait=False)


class SessionPromptScheduler:
    def __init__(self, bridge: Any, path: Path, *, clock: Callable[[], float] = time.time) -> None:
        self.bridge = bridge
        self.store = SessionScheduleStore(path)
        self.io = ScheduleIO()
        self.clock = clock
        self.ready = False
        self.error = ''
        self.lease: ScheduleLease | None = None
        self.task: asyncio.Task | None = None
        self.wake = asyncio.Event()
        self.lock = asyncio.Lock()
        self.unknown: set[str] = set()
        self.orphans: set[str] = set()
        self.running: dict[str, dict] = {}
        self.closed = False
        self.last_archive = 0.0
        self.dispatch_cursor = ''

    async def start(self, *, background: bool = True) -> None:
        try:
            await self.io.run(self.store.initialize)
            self.lease = await self.io.run(ScheduleLease, self.store.path.with_suffix('.lock'))
            await self.io.run(self.store.recover)
            await self.audit_queue()
            while await self.io.run(self.store.work):
                await self.reconcile()
            self.ready = True
            if background:
                self.task = asyncio.create_task(self._loop())
        except Exception as exc:
            self.error = str(exc)
            print(f'[session-schedule] {self.error}', file=sys.stderr)

    async def stop(self) -> None:
        self.closed = True
        self.ready = False
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.io.close()
        if self.lease:
            self.lease.close()

    async def _loop(self) -> None:
        while not self.closed:
            self.wake.clear()
            try:
                await self.tick()
                self.error = ''
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.error = str(exc)[:500]
                print(f'[session-schedule] {self.error}', file=sys.stderr)
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass

    async def tick(self) -> None:
        if not self.ready:
            return
        async with self.lock:
            changed = await self.io.run(self.store.consume, self.clock())
            await self.reconcile()
            if self.clock() - self.last_archive >= 3600:
                await self.io.run(self.store.archive, self.clock() - 90 * 86400)
                self.last_archive = self.clock()
            for row in changed:
                self.emit(row)
            targets = await self.io.run(self.store.dispatch_targets, self.dispatch_cursor)
            self.dispatch_cursor = targets[-1] if targets else ''
            for sid in targets:
                self.bridge._sequence_scheduler.kick(sid)

    def emit(self, row: dict) -> None:
        if self.bridge._session_owner_id(row['sessionId']) != row['owner']:
            return
        self.bridge._emit_event('sessionScheduleUpdated', {
            'version': 1, 'sessionId': row['sessionId'], 'executorId': row['executor'],
            'id': row['id'], 'revision': row.get('revision', 0), 'state': row.get('state'),
            'updatedAt': row.get('updatedAt', self.clock()),
        })

    def session(self, row: dict) -> Any:
        session = self.bridge._active_sessions.get(row['sessionId']) or self.bridge._session_store.load(row['sessionId'])
        if (not session or session.owner_id != row['owner'] or session.session_type != 'normal'
                or getattr(session, 'relation_kind', '') == 'review'
                or row['executor'] != self.bridge._loop_environment_executor()):
            raise ScheduleError('原 Session 已删除、归属变化或不支持定时运行')
        self.bridge._active_sessions.setdefault(session.id, session)
        return session

    def runtime_session(self, row: dict) -> Any:
        session = self.session(row)
        if not any(c.id == session.backend_id and c.enabled for c in getattr(self.bridge, '_backend_configs', [])):
            raise ScheduleError('当前 Session Backend 已禁用或不存在')
        return session

    async def audit_queue(self) -> None:
        """账本缺失不能把旧定时项降级为普通队列项；保留原文件供恢复核对。"""
        sids = await asyncio.to_thread(self.bridge._chat_extras_store.session_ids)
        for sid in set(sids) | set(self.bridge._chat_extras):
            ex = self.bridge._chat_extras_get(sid)
            for task in ex.seq_tasks:
                if not task.schedule_ref and not task.id.startswith('schedule-'):
                    continue
                try:
                    if not task.schedule_ref:
                        raise ScheduleError('定时来源损坏')
                    scope = (self.bridge._session_owner_id(sid), self.bridge._loop_environment_executor())
                    await self.io.run(self.store.get, scope, sid, task.schedule_ref['occurrenceId'], occurrence=True)
                except ScheduleError:
                    self.orphans.add(sid)
                    self.unknown.add(sid)
                    task.status = 'error'
                    task.error = '定时来源或账本缺失，结果未知；请恢复原记录并核对聊天，不能自动重试'
                    ex.seq_auto, ex.seq_error = False, task.error
                    self.bridge._chat_extras_save(ex)

    async def reconcile(self) -> None:
        for row in await self.io.run(self.store.work):
            scope = (row['owner'], row['executor'])
            sid = row['sessionId']
            try:
                self.session(row)
            except ScheduleError as exc:
                if row['state'] in PENDING:
                    row = await self.io.run(self.store.transition, scope, row['id'], 'failed', error=str(exc))
                await self.io.run(self.store.acknowledge, scope, row['id'], row['revision'])
                self.emit(row)
                continue
            ex = self.bridge._chat_extras_get(sid)
            task = next((t for t in ex.seq_tasks if t.id == row['taskId']), None)
            modified = False
            if row['state'] in PENDING:
                if task and (task.text != row['promptSnapshot'] or task.schedule_ref != self.reference(row)):
                    row = await self.io.run(self.store.transition, scope, row['id'], 'unknown', error='队列与定时账本不一致，结果未知，已停止派发')
                elif task and task.status not in {'pending'}:
                    row = await self.io.run(self.store.transition, scope, row['id'], 'unknown', error='队列状态不一致，不能判定尚未执行')
                else:
                    if not task:
                        task = SeqTask(id=row['taskId'], text=row['promptSnapshot'], schedule_ref=self.reference(row))
                        ex.seq_tasks.append(task)
                        modified = True
                    if modified:
                        self.bridge._chat_extras_save(ex)
                    if row['state'] == 'prepared':
                        row = await self.io.run(self.store.transition, scope, row['id'], 'queued')
            if row['state'] == 'unknown':
                self.unknown.add(sid)
                ex.seq_auto = False
                ex.seq_error = row['error']
                if task:
                    task.status, task.error = 'error', row['error']
                modified = True
            elif row['state'] == 'cancelled':
                if task and task.status not in {'running', 'steering'}:
                    ex.seq_tasks = [t for t in ex.seq_tasks if t.id != task.id]
                    modified = True
            elif row['state'] in {'failed', 'interrupted', 'completed'}:
                if sid in self.unknown and sid not in self.orphans and not await self.io.run(self.store.has_unknown, scope, sid):
                    self.unknown.discard(sid)
                if task:
                    task.status = 'interrupted' if row.get('resolved') else 'done' if row['state'] == 'completed' else 'error'
                    task.error = row.get('error', '')
                    modified = True
                if row['state'] != 'completed':
                    ex.seq_auto = False
                    ex.seq_error = row.get('error', '')
                    modified = True
            if row.get('retryOf') and row['state'] == 'queued':
                for old in ex.seq_tasks:
                    if old.schedule_ref and old.schedule_ref['occurrenceId'] == row['retryOf'] and old.status == 'error':
                        old.status = 'interrupted'
                        modified = True
            if modified:
                self.bridge._chat_extras_save(ex)
                self.bridge._emit_seqtask_updated(ex)
            await self.io.run(self.store.acknowledge, scope, row['id'], row['revision'])
            self.emit(row)
            if self.ready:
                self.bridge._sequence_scheduler.kick(sid)

    @staticmethod
    def reference(row: dict) -> dict:
        return {k: row[k] for k in ('scheduleId', 'scheduleRevision', 'scheduledAt')} | {'occurrenceId': row['id']}

    async def claim(self, sid: str, task: SeqTask) -> dict | None:
        if not self.ready or self.error or sid in self.unknown:
            raise ScheduleError(self.error or '定时恢复尚未完成或有结果未知，请核对原运行')
        async with self.lock:
            owner = self.bridge._session_owner_id(sid)
            scope = (owner, self.bridge._loop_environment_executor())
            row = await self.io.run(self.store.get, scope, sid, task.schedule_ref['occurrenceId'], occurrence=True)
            if row['state'] == 'cancelled':
                await self.reconcile()
                return None
            self.runtime_session(row)
            if task.text != row['promptSnapshot'] or task.schedule_ref != self.reference(row):
                raise ScheduleError('定时指令与冻结记录不一致')
            self.bridge._check_chat_turn_allowed(sid)
            row = await self.io.run(self.store.transition, scope, row['id'], 'claimed')
            self.running[sid] = row
            self.emit(row)
            return row

    async def started(self, row: dict, session: Any) -> dict:
        row = await self.io.run(self.store.transition, (row['owner'], row['executor']), row['id'], 'running',
                                runtime={'backendId': session.backend_id, 'model': session.model_override,
                                         'reasoningEffort': session.reasoning_effort,
                                         'workingDir': session.working_dir, 'executor': row['executor']})
        self.running[row['sessionId']] = row
        self.emit(row)
        return row

    async def finish(self, row: dict, state: str, error: str = '') -> None:
        sid = row['sessionId']
        result = await self.io.run(self.store.transition, (row['owner'], row['executor']), row['id'], state, error=error)
        self.running.pop(sid, None)
        if state == 'unknown':
            self.unknown.add(sid)
        self.emit(result)
        self.wake.set()

    async def reject(self, sid: str, task: SeqTask, error: str) -> None:
        scope = (self.bridge._session_owner_id(sid), self.bridge._loop_environment_executor())
        row = await self.io.run(self.store.get, scope, sid, task.schedule_ref['occurrenceId'], occurrence=True)
        if row['state'] in PENDING:
            await self.finish(row, 'failed', error)
        elif row['state'] in {'claimed', 'running'}:
            await self.finish(row, 'unknown', error)

    async def mutate(self, scope: tuple[str, str], sid: str, intent: dict) -> dict:
        if not self.ready or self.error:
            raise ScheduleError(self.error or '定时调度尚未就绪')
        async with self.lock:
            # RPC 被取消仍完成账本写；脏 outbox 将由后续 tick 恢复。
            result = await self.io.run(self.store.mutate, scope, sid, intent, self.clock())
            try:
                self.emit(result.get('schedule') or result['occurrence'])
                await self.reconcile()
                if intent.get('action') == 'retry':
                    ex = self.bridge._chat_extras_get(sid)
                    if not any(t.status == 'error' for t in ex.seq_tasks):
                        ex.seq_auto, ex.seq_error = True, ''
                        try:
                            self.bridge._chat_extras_save(ex)
                        except Exception:
                            ex.seq_auto = False
                            raise
                        self.bridge._emit_seqtask_updated(ex)
                        self.bridge._sequence_scheduler.kick(sid)
            except Exception as exc:
                # 已有事务回执不能因展示/队列清理失败被报告成“未提交”。
                self.error = str(exc)[:500]
                self.wake.set()
                return result
            self.wake.set()
            return result
