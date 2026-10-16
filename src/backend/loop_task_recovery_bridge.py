"""Task-contract correction at the existing LOOP boundaries, not a scheduler."""
from __future__ import annotations

import copy
import asyncio
import json
import re
import time
from typing import Any

from .loop_decisions import digest
from .loop_delivery import planning_context
from .loop_execution_environment import normalize_environment
from .loop_task_blockers import validate_candidate, invalid, PLAN_INSTRUCTIONS, BLOCKER_INSTRUCTIONS
from .loop_task_recovery import (diagnostic, PLAN_ATTEMPTS, REPAIR_ATTEMPTS, REPAIR_TERMINAL,
                                 repair_active, repair_candidate, receipt_summary, receipts)
from .loop_control_persistence import OrderedLoopWrites


class LoopTaskRecoveryBridge:
    def _loop_contract_pending(self, state: Any) -> bool:
        last = state.loops[-1] if state.loops else None
        return bool(last and last.round == state.round and last.terminal_kind == 'paused'
                    and last.contract_validation.get('status') != 'repaired'
                    and last.contract_validation.get('origin') not in ('identity', 'source')
                    and last.decision.get('reasonCode') in ('task_contract_invalid', 'task_scope_unknown'))

    def _loop_repair_eligibility(self, state: Any) -> dict:
        env = normalize_environment(state.execution_environment)
        last = state.loops[-1] if state.loops else None
        code, message = '', ''
        if repair_active(state.contract_repairs) or state.session_id in getattr(self, '_loop_contract_jobs', {}):
            code, message = 'repair_active', '修复结果尚未确认，请查看原请求回执。'
        elif state.control_mode != 'loop' or self._loop_control_reserved(state.session_id):
            code, message = 'control_busy', '控制权不允许修复。'
        elif self._loop_is_running(state.session_id) or self._loop_has_active_call(state.session_id):
            code, message = 'call_active', '当前调用或旧调用尚未退出。'
        elif env['blockers'] or env['incomplete']:
            code, message = 'environment_blocked', '先处理运行诊断中的实际故障或未确认退出。'
        elif state.stage != 'loopexecute' or not self._loop_contract_pending(state):
            code, message = 'no_contract_issue', '当前没有可修复的任务协议暂停。'
        elif state.progress_guard.get('reasonCode') not in ('task_contract_invalid', 'task_scope_unknown'):
            code, message = 'hard_pause', '当前暂停并非任务协议问题，修复不能解除它。'
        elif state.task_source.get('binding') and state.task_source.get('status') != 'current':
            code, message = 'source_unavailable', '先核对正式任务来源。'
        elif last and last.contract_validation.get('origin') in ('identity', 'source'):
            code, message = 'boundary_changed', '先核对已变化的来源或执行身份，不能通过重写映射解除。'
        elif len(state.round_loops()) > state.effective_max_loops() or state.risk_coefficient >= state.policy.risk_threshold:
            code, message = 'budget_or_risk', '当前预算或风险边界不允许新修复调用。'
        issue = last.contract_validation if last else {}
        # 旧对象只能从原决定身份定向，不能从相同文字推测关联。
        cause = issue.get('causeRef') or ('decision:' + last.decision.get('decisionId', '') if last else '')
        return {'canRequest': not code, 'reasonCode': code, 'message': message,
                'causeRef': cause, 'causeRevision': issue.get('causeRevision', 0),
                'round': state.round, 'seq': last.seq if last else 0,
                'controlRevision': state.control_revision}

    @staticmethod
    def _repair_error(message: str) -> str:
        return json.dumps({'status': 'error', 'message': message}, ensure_ascii=False)

    async def _rpc_loopTaskContractRepairGet(self, session_id: str, request_id: str = '') -> str:
        self._require_session_access(session_id)
        state = self._loop_state(session_id)
        if not state:
            return self._repair_error('Session 不存在。')
        receipt = next((v for v in reversed(state.contract_repairs)
                        if not request_id or v.get('requestId') == request_id), {})
        summary = receipt_summary(receipt)
        if receipt and receipt.get('status') not in REPAIR_TERMINAL and session_id not in getattr(self, '_loop_contract_jobs', {}):
            summary.update(status='unknown', reason='原修复调用结果尚未确认，不自动重放或释放保护。')
        return json.dumps({'status': 'ok', 'operation': summary,
                           'eligibility': self._loop_repair_eligibility(state)}, ensure_ascii=False)

    async def _rpc_loopCancelTaskContractRepair(self, session_id: str, request_id: str) -> str:
        self._require_session_access(session_id)
        job = getattr(self, '_loop_contract_jobs', {}).get(session_id)
        if not job or job['requestId'] != request_id:
            return self._repair_error('没有匹配的在途修复；请查询原回执。')
        job['cancel'] = True
        # 取消只发给已登记的模型调用；提交任务不被 UI 取消所截断。
        self._abort_loop_backend_calls(session_id)
        call = job.get('call')
        if call and not call.done():
            call.cancel()
        return json.dumps({'status': 'accepted', 'message': '已请求停止，需等待调用退出确认。'}, ensure_ascii=False)

    async def _rpc_loopRepairTaskContract(self, session_id: str, payload_json: str) -> str:
        self._require_session_access(session_id)
        try:
            if not isinstance(payload_json, str) or len(payload_json) > 4096:
                raise ValueError()
            payload = json.loads(payload_json)
            if not isinstance(payload, dict) or set(payload) != {'requestId', 'causeRef', 'causeRevision', 'round', 'seq', 'controlRevision'}:
                raise ValueError()
            rid = payload['requestId']
            if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', rid):
                raise ValueError()
            if not isinstance(payload['causeRef'], str) or not 1 <= len(payload['causeRef']) <= 100:
                raise ValueError()
            if any(type(payload[k]) is not int for k in ('causeRevision', 'round', 'seq', 'controlRevision')):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            return self._repair_error('修复请求格式无效。')
        session = self._active_sessions.get(session_id) or self._session_store.load(session_id)
        state = self._loop_state(session_id)
        if not session or not state or getattr(session, 'session_type', '') != 'loop':
            return self._repair_error('仅当前 LOOP 支持修复。')
        identity = digest([getattr(session, 'owner_id', 'local'), self._loop_environment_executor(), session_id])
        fingerprint = digest(payload)
        previous = next((v for v in state.contract_repairs if v.get('requestId') == rid), None)
        if previous:
            if previous.get('inputDigest') != fingerprint or previous.get('ownerDigest') != identity:
                return self._repair_error('请求身份冲突。')
            return await self._rpc_loopTaskContractRepairGet(session_id, rid)
        eligibility = self._loop_repair_eligibility(state)
        if not eligibility['canRequest']:
            return self._repair_error(eligibility['message'])
        if any(payload[k] != eligibility[k] for k in ('causeRef', 'causeRevision', 'round', 'seq', 'controlRevision')):
            return self._repair_error('问题身份或修订已变化，请刷新后查看。')
        jobs = getattr(self, '_loop_contract_jobs', None)
        if jobs is None:
            jobs = self._loop_contract_jobs = {}
        _, writers = self._control_maps()
        # 普通保存也有队列；修复接收排在其后，不把队列存在误判成修复预留。
        # 真正控制权/修复未知状态已由 eligibility 阻止。
        job = {'requestId': rid, 'cancel': False}
        jobs[session_id] = job  # 无 await 的预留；同 Session 第二次提交不能进入。
        writers.setdefault(session_id, OrderedLoopWrites(self._loop_store.save_frozen))
        operation = {'version': 1, **payload, 'status': 'accepted', 'attemptCount': 0,
                     'ownerDigest': identity, 'inputDigest': fingerprint,
                     'basis': self._loop_contract_context(session, state, state.loops[-1]),
                     'reason': '只修复任务映射，不运行项目步骤或开启 Auto。'}
        state.contract_repairs = [*state.contract_repairs[-15:], operation]
        # 接收落盘也由自己的任务拥有，断开 RPC 不取消它。
        task = asyncio.create_task(self._loop_repair_run(session, state, state.loops[-1], job, operation))
        job['task'] = task
        task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        return json.dumps({'status': 'accepted', 'operation': receipt_summary(operation)}, ensure_ascii=False)

    async def _loop_repair_save(self, state: Any, job: dict, patch: dict | None = None,
                                commit: Any = None) -> None:
        writer = self._loop_control_writes[state.session_id]
        job['writing'] = writer.enqueue(state.to_dict(), commit_patch=patch, on_commit=commit)
        await asyncio.shield(job['writing'])

    def _loop_repair_current(self, session: Any, state: Any, record: Any, job: dict, operation: dict) -> bool:
        return (not job.get('cancel') and state.stage == 'loopexecute' and state.control_mode == 'loop'
                and state.loops and state.loops[-1] is record and record.round == state.round
                and self._loop_contract_context(session, state, record) == operation['basis']
                and (record.contract_validation.get('causeRef') or 'decision:' + record.decision.get('decisionId', '')) == operation['causeRef']
                and record.contract_validation.get('causeRevision', 0) == operation['causeRevision']
                and len(state.round_loops()) <= state.effective_max_loops()
                and state.risk_coefficient < state.policy.risk_threshold
                and not self._loop_has_active_call(session.id)
                and state.progress_guard.get('reasonCode') in ('task_contract_invalid', 'task_scope_unknown')
                and not normalize_environment(state.execution_environment)['blockers']
                and not normalize_environment(state.execution_environment)['incomplete'])

    def _loop_repair_evidence(self, state: Any, record: Any, identity: dict) -> tuple[dict, list[dict], bool]:
        basis = state.blocked_task_scope or record.task_plan
        observations = []
        had_execution = any(s.started_at or s.status != 'pending' or s.output for s in record.orchestration)
        # 有效聚合已经是权威保留集合，不能从旧输出重新引入已明确解除的阻塞。
        if state.unresolved_blockers.get('valid'):
            return basis, [], had_execution
        for item in state.loops:
            if item.seq > record.seq:
                continue
            if item.task_plan.get('identity') != identity:
                if item.task_blockers and not item.task_blockers.get('valid'):
                    return basis, [], had_execution
                continue
            before = len(observations)
            for step in item.orchestration:
                parsed = self._extract_json_block(step.output) or {}
                if 'taskBlockers' in parsed:
                    observations.append({'raw': parsed['taskBlockers'], 'boundary': f'{item.round}:{item.seq}:step{step.index}'})
                    if len(observations) > 64:
                        return basis, [], had_execution  # 无法完整有界核对时保留未知，不截断放行。
            parsed = self._extract_json_block(item.stage_details.get('analysis', {}).get('rawOutput', '')) or {}
            if 'taskBlockers' in parsed:
                observations.append({'raw': parsed['taskBlockers'], 'boundary': f'{item.round}:{item.seq}:analysis'})
                if len(observations) > 64:
                    return basis, [], had_execution
            if item.task_blockers and not item.task_blockers.get('valid') and len(observations) == before:
                return basis, [], had_execution
        # 无已执行/受阻范围时，可以依据当前完整正式来源重新规划；不复用未知旧验收。
        if not basis.get('valid') and not had_execution and not state.unresolved_blockers:
            basis = {}
        return basis, observations, had_execution

    async def _loop_repair_run(self, session: Any, state: Any, record: Any,
                                job: dict, operation: dict) -> None:
        sid = session.id
        try:
            await self._loop_repair_save(state, job)
            if state.task_source.get('binding') and not await self._loop_check_source(session, state, record, 'contract-repair', force=True):
                operation.update(status='blocked', reason='正式来源核对未通过，未修复。')
                return
            if not self._loop_repair_current(session, state, record, job, operation):
                operation.update(status='stale', reason='问题或控制身份已变化，未修复。')
                return
            operation.update(status='running')
            basis, observations, executed = self._loop_repair_evidence(state, record, operation['basis']['identity'])
            operation['original'] = {'taskPlan': copy.deepcopy(record.task_plan),
                'blockers': copy.deepcopy(state.unresolved_blockers), 'scope': copy.deepcopy(state.blocked_task_scope)}
            attempts = record.stage_details.get('prepare', {}).get('attempts', [])
            parsed = next((a.get('parsed') for a in reversed(attempts) if isinstance(a.get('parsed'), dict)), {})
            candidate = parsed or {}
            result: dict = {}
            for attempt in range(REPAIR_ATTEMPTS + 1):
                raw_steps = candidate.get('orchestration') or candidate.get('steps') or candidate.get('plan') or []
                steps = self._loop_parse_orchestration(raw_steps)
                result = repair_candidate(candidate.get('taskPlan'), [s.to_dict() for s in steps], state.task_source,
                    operation['basis']['identity'], basis, state.unresolved_blockers, observations, had_execution=executed)
                if result.get('valid') or not result.get('repairable') or attempt == REPAIR_ATTEMPTS:
                    break
                if not self._loop_repair_current(session, state, record, job, operation):
                    operation.update(status='stale', reason='修复依据已变化。')
                    return
                operation.update(attemptCount=attempt + 1)
                await self._loop_repair_save(state, job)
                self._emit_loop_updated(state)
                prompt = ('显式只读任务映射修复。仅纠正完整候选计划，不运行应用、构建、测试，不重试被拒资源。'
                    '不得解除/删除旧阻塞或改变任务原义/依赖，修复不算任务进展。\n'
                    + json.dumps(diagnostic(result), ensure_ascii=False) + '\n' + planning_context(state, record)
                    + '\n原任务图：' + json.dumps(basis, ensure_ascii=False) + PLAN_INSTRUCTIONS + BLOCKER_INSTRUCTIONS)
                job['call'] = asyncio.create_task(self._loop_run_agent(session, prompt, 'contractRepair', record.seq,
                    resume=False, indep_session_id=f'{sid}:repair:{operation["requestId"]}:{attempt + 1}',
                    backend_id=record.backends.get('prepare'), runtime=record.runtimes.get('prepare'),
                    execution_access='read-only'))
                output, _ = await job['call']
                if len(output) > 262_144:
                    operation.update(status='blocked', reason='修复输出超限，不采纳截断计划。')
                    return
                candidate = self._extract_json_block(output) or {}
                operation.setdefault('attempts', []).append({'rawOutput': output,
                                                             'validation': diagnostic(result)})
                if not self._loop_repair_current(session, state, record, job, operation):
                    operation.update(status='stale', reason='修复结果迟到，仅保留原记录。')
                    return
                pause = candidate.get('loopControl')
                if isinstance(pause, dict) and pause.get('pause') is True:
                    kind = pause.get('kind') if pause.get('kind') in ('safety', 'authorization', 'human_input', 'workflow_blocked') else 'unclassified_pause'
                    reason = pause.get('reason') if isinstance(pause.get('reason'), str) else '修复调用要求暂停，原因待补充。'
                    self._loop_wait(state, record, kind, reason[:1200])
                    operation.update(status='blocked', reason='模型明确请求暂停，未提交修复。')
                    return
            if not result.get('valid'):
                operation.update(status='blocked', reason=result.get('reason', '修复未成功。'),
                                 validation=diagnostic(result))
                return
            if not self._loop_repair_current(session, state, record, job, operation):
                operation.update(status='stale', reason='修复提交前依据变化。')
                return
            repaired = diagnostic({**record.contract_validation, 'status': 'repaired', 'valid': True})
            receipt = {**copy.deepcopy(operation), 'status': 'succeeded', 'reason': '映射已修复，尚未运行。',
                       'replacement': result}
            history = [receipt if v['requestId'] == operation['requestId'] else v for v in state.contract_repairs]
            if receipts(history)[-1].get('status') != 'succeeded':
                operation.update(status='blocked', reason='修复审计超出存储上限，未提交。')
                return
            loops = [r.to_dict() for r in state.loops]
            loops[-1]['contractValidation'] = repaired
            patch = {'contractRepairs': history, 'contractRepairActive': False, 'loops': loops,
                     'unresolvedBlockers': result['blockers'],
                     'blockedTaskScope': result['plan'] if result['blockers'] else state.blocked_task_scope}
            def committed() -> None:
                state.contract_repairs = history
                record.contract_validation = repaired
                state.unresolved_blockers = result['blockers']
                if result['blockers']:
                    state.blocked_task_scope = result['plan']
            await self._loop_repair_save(state, job, patch, committed)
            operation.update(status='succeeded', reason=receipt['reason'])
        except asyncio.CancelledError:
            operation.update(status='unknown' if self._loop_has_active_call(sid) else 'cancelled',
                             reason='修复已取消；未确认退出时保持保护。')
        except Exception:
            operation.update(status='unknown' if self._loop_has_active_call(sid) else 'failed',
                             reason='修复调用或保存失败；保留原记录，请查看诊断。')
        finally:
            writer = self._loop_control_writes.get(sid)
            try:
                if operation['status'] != 'succeeded':
                    await self._loop_repair_save(state, job)
                if writer:
                    await writer.flush()
            except (Exception, asyncio.CancelledError):
                operation.update(status='unknown', reason='持久化结果未确认，保留保护。')
            if operation['status'] in REPAIR_TERMINAL and not self._loop_has_active_call(sid):
                if self._loop_control_writes.get(sid) is writer:
                    self._loop_control_writes.pop(sid, None)
                self._loop_contract_jobs.pop(sid, None)
            self._emit_loop_updated(state)

    def _loop_contract_context(self, session: Any, state: Any, record: Any) -> dict:
        return {'identity': self._loop_task_identity(session, state, record),
                'controlRevision': state.control_revision, 'round': state.round,
                'seq': record.seq}

    def _loop_contract_boundary(self, session: Any, state: Any, record: Any, basis: dict) -> dict:
        if (session.id in getattr(self, '_loop_cancel', {})
                or session.id in getattr(self, '_loop_pending_out', set())
                or state.control_mode != 'loop' or state.control_revision != basis['controlRevision']):
            return invalid('用户停止或控制权已改变', code='user_stop', origin='identity')
        if state.progress_guard.get('pause'):
            return invalid('当前暂停尚未解除', code='paused', origin='history')
        if record.round != state.round or (state.loops and state.loops[-1] is not record):
            return invalid('规划结果已不属于当前迭代', code='stale', origin='identity')
        if self._loop_task_identity(session, state, record) != basis['identity']:
            result = invalid('规划期间执行身份或任务来源发生变化', code='identity_mismatch', origin='identity')
            current = self._loop_task_identity(session, state, record)
            result['identityDimensions'] = [k for k in current if current[k] != basis['identity'].get(k)][:16]
            return result
        environment = normalize_environment(state.execution_environment)
        if environment['blockers'] or environment['incomplete']:
            return invalid('执行环境有未解除的实际故障或不完整证据', code='environment_blocked', origin='identity')
        if self._loop_has_active_call(session.id):
            return invalid('旧调用退出尚未确认', code='call_active', origin='identity')
        if len(state.round_loops()) > state.effective_max_loops() or state.risk_coefficient >= state.policy.risk_threshold:
            return invalid('达到当前轮次预算或风险边界', code='budget_or_risk', origin='identity')
        return {}

    def _loop_contract_audit(self, session: Any, state: Any, record: Any,
                             parsed: dict, steps: list[Any]) -> dict:
        if 'taskPlan' in parsed or any(s.task_ids or not s.task_mapping_valid for s in steps):
            record.contract_required = True
        basis = record.stage_details.setdefault('contractContext', self._loop_contract_context(session, state, record))
        boundary = self._loop_contract_boundary(session, state, record, basis)
        result = boundary or validate_candidate(parsed.get('taskPlan'), [s.to_dict() for s in steps],
            state.task_source, basis['identity'], state.blocked_task_scope if state.unresolved_blockers else None,
            state.unresolved_blockers, required=record.contract_required or bool(state.task_source.get('binding')))
        record.contract_validation = diagnostic({**result, 'attemptCount': record.plan_attempt_count,
            'status': 'valid' if result.get('valid') else 'retrying' if result.get('repairable') else 'paused'})
        if result.get('valid'):
            record.task_plan = copy.deepcopy(result.get('plan', {}))
        return result

    def _loop_contract_wait(self, state: Any, record: Any, result: dict) -> None:
        # 明确每次暂停的处理对象；模型不能提供 causeRef 或解除用户控制。
        detail = diagnostic({**result, 'attemptCount': record.plan_attempt_count,
                             'status': 'exhausted' if result.get('repairable') else 'paused'})
        detail.pop('causeRef', None)
        detail.pop('causeRevision', None)
        basis = record.stage_details.get('contractContext', {})
        fingerprint = digest([state.session_id, record.round, record.seq, basis, detail])[:32]
        old = record.contract_validation
        detail.update(causeRef='contract:' + fingerprint,
                      causeRevision=old.get('causeRevision', 0) + (old.get('causeRef') != 'contract:' + fingerprint))
        record.contract_validation = detail
        if (record.round != state.round or state.loops and state.loops[-1] is not record
                or state.control_mode != 'loop'
                or basis and state.control_revision != basis.get('controlRevision')):
            record.contract_validation['status'] = 'stale'
            self._loop_save(state)
            return
        conditions = {'source': '核对正式来源和范围差异；不要重新绑定正常来源。',
                      'identity': '核对变化的执行身份、控制权及旧调用状态后显式恢复。',
                      'history': '打开此问题的任务映射详情，核对原始证据并显式修复。',
                      'output': '打开此问题的任务映射详情；可显式修复，不必重新绑定正常来源。'}
        self._loop_wait(state, record, 'task_contract_invalid', detail['reason'],
                        conditions.get(detail['origin'], '查看原始证据，补充无法核对的任务映射。'))
        record.stage_details.setdefault('prepare', {}).update(status='paused', message=detail['reason'])
        self._loop_save(state)

    async def _loop_correct_contract(self, session: Any, state: Any, record: Any) -> bool:
        """只消费当前规划剩余额度；调用前计数使重启不能重复获得预算。"""
        basis = record.stage_details.setdefault('contractContext', self._loop_contract_context(session, state, record))
        detail = record.stage_details.setdefault('prepare', {})
        while not record.orchestration:
            boundary = self._loop_contract_boundary(session, state, record, basis)
            if boundary:
                if not state.progress_guard.get('pause'):
                    self._loop_contract_wait(state, record, boundary)
                return False
            validation = record.contract_validation
            if not validation.get('repairable') or record.plan_attempt_count >= PLAN_ATTEMPTS:
                self._loop_contract_wait(state, record, validation)
                return False
            prompt = ('只纠正本次计划协议，不执行项目修改/构建/测试，不访问已被拒资源。'
                '保留完整任务台账、原义、依赖和未解决阻塞；只输出完整候选 JSON。\n'
                + json.dumps(diagnostic(validation), ensure_ascii=False)
                + '\n' + planning_context(state, record) + '\n全局目标：' + state.goal
                + '\n本次冻结依据：' + record.evolution_basis + PLAN_INSTRUCTIONS + BLOCKER_INSTRUCTIONS)
            record.plan_attempt_count += 1
            detail.update(status='retrying', attemptCount=record.plan_attempt_count,
                          message=f'正在纠正任务映射（第 {record.plan_attempt_count}/{PLAN_ATTEMPTS} 次）')
            record.updated_at = time.time()
            self._loop_save(state)
            self._emit_loop_updated(state)
            output, _ = await self._loop_run_agent(session, prompt, 'prepare', record.seq,
                resume=False, indep_session_id=f'{session.id}:loop{record.seq}:contract:{record.plan_attempt_count}',
                backend_id=record.backends.get('prepare'), runtime=record.runtimes.get('prepare'),
                execution_access='read-only')
            boundary = self._loop_contract_boundary(session, state, record, basis)
            if boundary:
                detail.setdefault('attempts', []).append({'kind': 'correction', 'rawOutput': output,
                    'parsed': self._extract_json_block(output), 'valid': False, 'stale': True,
                    'validation': [boundary['reason']]})
                if not state.progress_guard.get('pause'):
                    self._loop_contract_wait(state, record, boundary)
                self._loop_save(state)
                return False
            if self._loop_pause_control(state, record, output):
                return False
            record.orchestration = self._loop_audit_plan(record, output, 'correction', session=session, state=state)
        return True
