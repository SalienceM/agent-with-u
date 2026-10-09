"""Session-local control handoff. Mutation and publication stay on the event loop."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time
import uuid
from typing import Any

from .loop_control import (ID_PATTERN, PROTOCOL_VERSION, REASONS, TERMINAL_STATUSES,
                           normalize_operation, operation_public)
from .loop_control_persistence import OrderedLoopWrites
from .loop_control_snapshot import snapshot_handoff
from .loop_store import LoopState, LoopRecord, STAGE_OUT, SUB_EXECUTE, SUB_DONE

# 只有这些字段受转交事务控制；Addon/aside 等必须保留当前单例中的并发更新。
CONTROL_FIELDS = {
    'controlMode': 'control_mode', 'controlRevision': 'control_revision',
    'controlOperation': 'control_operation', 'controlReceipts': 'control_receipts',
    'loops': 'loops', 'auto': 'auto', 'stage': 'stage', 'round': 'round',
    'goal': 'goal', 'goalHistory': 'goal_history', 'status': 'status',
    'stopReason': 'stop_reason', 'riskCoefficient': 'risk_coefficient',
    'bestSeq': 'best_seq', 'riskFactors': 'risk_factors', 'progressGuard': 'progress_guard',
}


class LoopControlBridge:
    def _control_maps(self) -> tuple[dict, dict]:
        if not hasattr(self, '_loop_control_jobs'):
            self._loop_control_jobs = {}
            self._loop_control_writes = {}
        return self._loop_control_jobs, self._loop_control_writes

    def _control_summary(self, state: LoopState, session: Any, request_id: str = '') -> dict:
        operation = state.control_operation
        if request_id and operation.get('requestId') != request_id:
            operation = next((item for item in reversed(state.control_receipts)
                              if item.get('requestId') == request_id), {})
        return {'protocolVersion': PROTOCOL_VERSION, 'sessionId': state.session_id,
                'controlMode': state.control_mode, 'controlRevision': state.control_revision,
                'auto': state.auto, 'stage': state.stage, 'round': state.round,
                'eligibility': self._loop_control_eligibility(state, session),
                'engineeringActivities': self._engineering_feedback(state.session_id),
                'currentOperation': operation_public(state.control_operation),
                'operation': operation_public(operation)}

    async def _rpc_loopControlGet(self, session_id: str, request_id: str = '') -> str:
        self._require_session_access(session_id)
        if not isinstance(request_id, str) or (request_id and not ID_PATTERN.fullmatch(request_id)):
            return self._control_error('invalid_request')
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        state = self._loop_state(session_id)
        if not state or not session or session.session_type != 'loop':
            return self._control_error('unavailable')
        jobs, writers = self._control_maps()
        operation = state.control_operation
        job = jobs.get(session_id)
        owner_task = (job.get('task') or job.get('acceptTask')) if job else None
        writer = writers.get(session_id)
        writing = writer is not None and writer.unsettled
        safely_interrupted = not job and operation.get('phase') in ('validating', 'manual_record', 'committing')
        if job and owner_task is not None and owner_task.done():
            orphan, io_task = job.get('orphan'), job.get('io')
            if orphan is not None and getattr(orphan, 'exit_confirmed', lambda: False)():
                orphan.release()
                safely_interrupted = True
            elif 'orphan' not in job and io_task is None and (
                    not job.get('workerStarted') or job.get('workerExited')):
                safely_interrupted = True
            elif io_task is not None and io_task.done() and not io_task.cancelled():
                try:
                    safely_interrupted = io_task.result().exit_confirmed
                except Exception:
                    safely_interrupted = False
        # 快照退出和等待任务结束不代表磁盘提交结束；不能用旧内存收口在途写。
        if writing:
            safely_interrupted = False
        if operation and operation['status'] not in TERMINAL_STATUSES and safely_interrupted:
            # 这些阶段要么还未启动 worker，要么已确认 worker 退出。
            # snapshot 阶段即使进程表为空也绝不走此分支。
            _, writers = self._control_maps()
            jobs[session_id] = {'requestId': operation['requestId'], 'task': asyncio.current_task()}
            writers.setdefault(session_id, OrderedLoopWrites(self._loop_store.save_frozen))
            draft = copy.deepcopy(state)
            draft.finish_control_operation({**operation, 'status': 'interrupted', 'phase': 'done',
                'committed': False, 'reasonCode': 'interrupted', 'updatedAt': time.time(),
                'revision': operation['revision'] + 1})
            try:
                await self._control_persist(state, draft, ['controlOperation', 'controlReceipts'])
            except Exception:
                pass
            else:
                await self._control_close_writer(session_id)
                jobs.pop(session_id, None)
            operation, job = state.control_operation, jobs.get(session_id)
        if (operation.get('status') in TERMINAL_STATUSES and job
                and owner_task is not None and owner_task.done() and not writing):
            # 原等待者可能在提交后、清理前取消；只收口已完成提交，不重放转交。
            await self._control_close_writer(session_id)
            if jobs.get(session_id) is job:
                jobs.pop(session_id, None)
        if operation and operation['status'] not in TERMINAL_STATUSES and (
                not job or owner_task is not None and owner_task.done()):
            # 进程重启/任务丢失不证明旧 worker 已退出；只读核对不重放写操作。
            result = self._control_summary(state, session, request_id)
            result['currentOperation'].update(status='unresolved', phase='recovery',
                reasonCode='worker_unresolved', message=REASONS['worker_unresolved'][0])
            if result['operation'].get('requestId') == operation['requestId']:
                result['operation'] = dict(result['currentOperation'])
            return json.dumps({'status': 'ok', **result}, ensure_ascii=False)
        if operation.get('committed'):
            try:
                self._mirror_loop_control_mode(session, state.control_mode)
            except Exception:
                pass
        return json.dumps({'status': 'ok', **self._control_summary(state, session, request_id)}, ensure_ascii=False)

    @staticmethod
    def _control_error(reason: str, **extra: Any) -> str:
        return json.dumps({'status': 'error', 'reasonCode': reason,
                           'message': REASONS[reason][0], **extra}, ensure_ascii=False)

    async def _control_persist(self, state: LoopState, draft: LoopState, fields: tuple | list) -> None:
        _, writers = self._control_maps()
        payload = state.to_dict()
        proposed = draft.to_dict()
        patch = {key: proposed[key] for key in fields}
        values = {CONTROL_FIELDS[key]: copy.deepcopy(getattr(draft, CONTROL_FIELDS[key])) for key in fields}
        def committed() -> None:
            # 持久化后仅合并受保护字段，不能用 draft 替换单例。
            for name, value in values.items():
                setattr(state, name, value)
        await asyncio.shield(writers[state.session_id].enqueue(payload, commit_patch=patch, on_commit=committed))

    async def _control_phase(self, state: LoopState, phase: str, *, unresolved: bool = False) -> None:
        draft = copy.deepcopy(state)
        draft.control_operation.update(phase=phase, status='unresolved' if unresolved else 'running',
            revision=draft.control_operation['revision'] + 1, updatedAt=time.time(),
            reasonCode='worker_unresolved' if unresolved else 'ready')
        await self._control_persist(state, draft, ['controlOperation'])
        self._emit_loop_updated(state)

    async def _rpc_loopControlRequest(self, session_id: str, payload_json: str) -> str:
        self._require_session_access(session_id)
        try:
            if not isinstance(payload_json, str) or len(payload_json) > 20_000:
                raise ValueError()
            payload = json.loads(payload_json)
            if not isinstance(payload, dict) or set(payload) - {'requestId', 'action', 'expectedControlRevision', 'goal'}:
                raise ValueError()
            rid, action, expected = payload['requestId'], payload['action'], payload['expectedControlRevision']
            goal = payload.get('goal', '')
            if (not isinstance(rid, str) or not ID_PATTERN.fullmatch(rid)
                    or action not in ('takeover', 'release') or type(expected) is not int
                    or not 0 <= expected < 2**53 - 2 or not isinstance(goal, str) or len(goal) > 16_000):
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            return self._control_error('invalid_request')
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        state = self._loop_state(session_id)
        if not state or not session or session.session_type != 'loop':
            return self._control_error('unavailable')
        digest = hashlib.sha256(json.dumps([action, expected, goal], ensure_ascii=False).encode()).hexdigest()
        identity = hashlib.sha256(json.dumps([self._current_owner_id(), self._loop_environment_executor(),
                                             session_id], ensure_ascii=False).encode()).hexdigest()
        existing = next((op for op in [state.control_operation, *reversed(state.control_receipts)]
                         if op.get('requestId') == rid), None)
        if existing:
            if existing.get('inputDigest') != digest or existing.get('identityDigest') != identity:
                return self._control_error('request_conflict')
            return json.dumps({'status': 'ok', **self._control_summary(state, session, rid)}, ensure_ascii=False)
        jobs, writers = self._control_maps()
        accepting = jobs.get(session_id, {}).get('acceptTask')
        if accepting is not None and not accepting.done() and jobs[session_id]['requestId'] == rid:
            if jobs[session_id]['inputDigest'] != digest or jobs[session_id]['identityDigest'] != identity:
                return self._control_error('request_conflict')
            return await asyncio.shield(accepting)
        if session_id in jobs or self._loop_control_reserved(session_id):
            return self._control_error('handoff_busy', **self._control_summary(state, session))
        if expected != state.control_revision:
            return self._control_error('stale_revision', **self._control_summary(state, session))
        if goal and (action != 'takeover' or state.stage != STAGE_OUT):
            return self._control_error('invalid_request')
        allowed = self._loop_control_eligibility(state, session)[action]
        if not allowed['allowed']:
            return self._control_error(allowed['reasonCode'], **self._control_summary(state, session))
        source = (state.control_revision, state.stage, state.round, session.working_dir, len(session.messages))
        jobs[session_id] = {'requestId': rid, 'inputDigest': digest, 'identityDigest': identity,
                            'action': action, 'goal': goal, 'task': None, 'source': source}
        writers[session_id] = OrderedLoopWrites(self._loop_store.save_frozen)
        draft = copy.deepcopy(state)
        now = time.time()
        draft.accept_control_operation({'requestId': rid, 'action': action, 'status': 'accepted',
            'phase': 'validating', 'sourceMode': state.control_mode,
            'targetMode': 'manual' if action == 'takeover' else 'loop', 'revision': 1,
            'sourceControlRevision': expected, 'startedAt': now, 'updatedAt': now,
            'reasonCode': 'ready', 'committed': False, 'inputDigest': digest, 'identityDigest': identity})
        async def accept() -> str:
            try:
                await self._control_persist(state, draft, ['controlRevision', 'controlOperation'])
            except Exception:
                await self._control_close_writer(session_id)
                jobs.pop(session_id, None)
                return self._control_error('persistence_failed')
            jobs[session_id]['task'] = asyncio.create_task(self._control_run(session, state, action, goal, source))
            self._emit_loop_updated(state)
            return json.dumps({'status': 'accepted', **self._control_summary(state, session)}, ensure_ascii=False)

        task = asyncio.create_task(accept())
        jobs[session_id]['acceptTask'] = task
        return await asyncio.shield(task)

    async def _control_close_writer(self, sid: str) -> None:
        _, writers = self._control_maps()
        writer = writers.get(sid)
        if writer:
            try:
                await writer.flush()
            except Exception:
                pass
            if writers.get(sid) is writer:
                writers.pop(sid, None)

    async def _control_run(self, session: Any, state: LoopState, action: str, goal: str, source: tuple) -> None:
        jobs, _ = self._control_maps()
        sid = state.session_id
        try:
            await self._control_phase(state, 'snapshot')
            budget = float(getattr(self, '_loop_control_snapshot_budget', 60))
            git_checkpoint = None
            dir_checkpoint = None
            # 已处于目标模式的幂等申请不需要快照或伪造人工轮。
            target = 'manual' if action == 'takeover' else 'loop'
            if state.control_mode != target:
                jobs[sid]['workerStarted'] = True
                work = asyncio.create_task(snapshot_handoff(source[3], action, budget))
                jobs[sid]['io'] = work
                try:
                    snapshot = await asyncio.wait_for(asyncio.shield(work), budget)
                except asyncio.TimeoutError:
                    await self._control_phase(state, 'snapshot', unresolved=True)
                    snapshot = await asyncio.shield(work)
                jobs[sid].pop('io', None)
                if not snapshot.exit_confirmed:
                    jobs[sid]['orphan'] = snapshot.owner
                    await self._control_phase(state, 'snapshot', unresolved=True)
                    return
                jobs[sid]['workerExited'] = True
                git_checkpoint, dir_checkpoint = snapshot.git, snapshot.directory
            await self._control_phase(state, 'manual_record')
            if ((state.control_revision, state.stage, state.round, session.working_dir, len(session.messages))
                    != (source[0] + 1, *source[1:])):
                raise ValueError('stale_revision')
            allowed = self._loop_control_eligibility(state, session, ignore_reservation=True)[action]
            if not allowed['allowed']:
                raise ValueError(allowed['reasonCode'])
            self._require_session_access(sid)
            draft = copy.deepcopy(state)
            if action == 'takeover' and state.control_mode != target:
                if draft.stage == STAGE_OUT:
                    last = draft.loops[-1] if draft.loops else None
                    if last and last.round == draft.round and not last.completed and not last.error:
                        self._mark_loop_interrupted(last, '上一轮未完成，开启人工轮时已封存')
                    self._apply_loop_continue(draft, goal)
                record = LoopRecord(seq=max((r.seq for r in draft.loops), default=0) + 1,
                    kind='manual', sub_stage=SUB_EXECUTE, round=draft.round, goal='人工接管',
                    manual_start_index=source[4], manual_context=self._loop_context_digest(draft),
                    agent_checkpoint=session.agent_session_id or '', git_checkpoint=git_checkpoint,
                    dir_checkpoint=dir_checkpoint)
                record.mark_sub(SUB_EXECUTE)
                record.backends['execute'] = session.backend_id
                record.runtimes['execute'] = self._resolved_runtime(session.backend_id, self._session_runtime(session))
                draft.loops.append(record)
            elif action == 'release' and state.control_mode != target:
                record = self._loop_manual_record(draft)
                if record:
                    self._build_manual_loop_record(session, record, finalize=True)
                    if not record.manual_messages:
                        draft.loops.remove(record)
                    else:
                        record.completed = True
                        record.mark_sub(SUB_DONE)
                        record.artifact_checkpoint = git_checkpoint
            if action == 'takeover':
                draft.auto = False
            draft.control_mode = target
            await self._control_phase(state, 'committing')
            operation = {**state.control_operation, 'status': 'succeeded', 'phase': 'done',
                'committed': True, 'checkpointAvailable': bool(git_checkpoint or dir_checkpoint),
                'revision': state.control_operation['revision'] + 1, 'updatedAt': time.time(),
                'reasonCode': 'ready' if git_checkpoint or dir_checkpoint else 'snapshot_unavailable'}
            draft.finish_control_operation(operation)
            await self._control_persist(state, draft, list(CONTROL_FIELDS))
            try:
                self._mirror_loop_control_mode(session, target)
            except Exception:
                pass  # 模式已提交；Get 负责修复 mirror，不能再次执行转交。
        except asyncio.CancelledError:
            # 服务关闭时不把取消等待当作 worker 退出，不发布终态或解除预留。
            return
        except Exception as exc:
            work = jobs.get(sid, {}).get('io')
            if work is not None and not work.done() or 'orphan' in jobs.get(sid, {}):
                # 即使阶段日志落盘也失败，活线程仍持有预留，绝不能写入 failed 解锁。
                return
            draft = copy.deepcopy(state)
            reason = str(exc) if isinstance(exc, ValueError) and str(exc) in REASONS else 'persistence_failed'
            op = {**draft.control_operation, 'status': 'failed', 'phase': 'done',
                  'reasonCode': reason, 'committed': False,
                  'revision': draft.control_operation.get('revision', 0) + 1, 'updatedAt': time.time()}
            try:
                draft.finish_control_operation(op)
                await self._control_persist(state, draft, ['controlOperation', 'controlReceipts'])
            except Exception:
                return  # 持久化结果不明，保留预留；Get 只读展示待核对。
        if state.control_operation.get('status') in TERMINAL_STATUSES:
            await self._control_close_writer(sid)
            jobs.pop(sid, None)
        self._emit_loop_updated(state)

    async def _control_legacy(self, session_id: str, action: str, goal: str = '') -> str:
        self._require_session_access(session_id)
        state = self._loop_state(session_id)
        if not state:
            return self._control_error('unavailable')
        jobs, _ = self._control_maps()
        active = jobs.get(session_id)
        if active and active.get('action') == action:
            if active.get('goal', '') != goal:
                return self._control_error('request_conflict')
            accepting = active.get('acceptTask')
            if accepting:
                accepted = json.loads(await asyncio.shield(accepting))
                if accepted.get('status') == 'error':
                    return json.dumps(accepted, ensure_ascii=False)
            task = active.get('task')
            if task:
                await asyncio.shield(task)
        else:
            response = json.loads(await self._rpc_loopControlRequest(session_id, json.dumps({
                'requestId': uuid.uuid4().hex, 'action': action,
                'expectedControlRevision': state.control_revision, 'goal': goal})))
            if response.get('status') == 'error':
                return json.dumps(response, ensure_ascii=False)
            active = jobs.get(session_id)
            if active and active.get('task'):
                await asyncio.shield(active['task'])
        operation = state.control_operation
        if operation.get('status') != 'succeeded':
            return self._control_error(operation.get('reasonCode', 'worker_unresolved'))
        return json.dumps({'status': 'ok', 'controlMode': state.control_mode,
            'stage': state.stage, 'round': state.round,
            'seq': state.loops[-1].seq if state.loops else 0}, ensure_ascii=False)
