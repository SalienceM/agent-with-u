"""Task-level recovery at existing LOOP call boundaries; no second scheduler."""
from __future__ import annotations

import asyncio
import copy
import json
import os
import time
from typing import Any

from .loop_decisions import digest
from .loop_delivery import (REPORT_INSTRUCTIONS, assess_progress, evidence_packet,
                            normalize_report, planning_context)
from .loop_execution_environment import normalize_environment, EnvironmentPause
from .loop_store import LoopAnalysis, SUB_ANALYSIS, SUB_DONE
from .loop_task_blockers import (freeze_plan, normalize_blockers, merge_blockers,
    reduce_scope, review_scope, protect_report, invalid, REVIEW_INSTRUCTIONS, ContractError, text)
from .loop_task_isolation import isolation_gate, isolation_receipts, resolve_observations


class LoopTaskBlockerBridge:
    def _loop_review_identity(self, session: Any, record: Any) -> dict:
        backend_id = record.backends.get('analysis') or session.backend_id
        config = next((c for c in getattr(self, '_backend_configs', []) if c.id == backend_id), None)
        return {'backend': backend_id, 'access': 'read-only',
            'configuration': digest([str(getattr(config, 'type', '')), getattr(config, 'env', {}) or {},
                                     getattr(config, 'cli_path', ''), record.runtimes.get('analysis', {})])}

    def _loop_task_identity(self, session: Any, state: Any, record: Any) -> dict:
        return {'owner': getattr(session, 'owner_id', 'local'), 'session': session.id,
            'executor': self._loop_environment_executor(),
            'workspace': os.path.normcase(os.path.abspath(getattr(session, 'working_dir', '.') or '.')),
            'environment': self._loop_evidence_environment(session, record),
            'runtime': digest(record.runtimes.get('execute', {})),
            'source': digest([state.task_source.get('binding'), state.task_source.get('revision', 0),
                              state.task_source.get('snapshot', {}).get('scopeDigest'), state.goal]),
            'policy': digest([getattr(session, 'abilities', {}), getattr(session, 'sandbox_enabled', False),
                              getattr(session, 'constraints', ''),
                              getattr(session, 'codex_connection_mode', ''), getattr(session, 'remote_host', '')])}

    def _loop_task_boundary_current(self, session: Any, state: Any, record: Any, identity: dict, control: int) -> bool:
        return (record.round == state.round and (not state.loops or state.loops[-1] is record)
            and state.control_mode == 'loop' and state.control_revision == control
            and session.id not in getattr(self, '_loop_cancel', {})
            and session.id not in getattr(self, '_loop_pending_out', set())
            and not state.progress_guard.get('pause')
            and self._loop_task_identity(session, state, record) == identity)

    def _loop_freeze_tasks(self, session: Any, state: Any, record: Any, parsed: dict) -> bool:
        identity = self._loop_task_identity(session, state, record)
        if not record.task_plan:
            record.task_plan = freeze_plan(parsed.get('taskPlan'), [s.to_dict() for s in record.orchestration],
                state.task_source, identity, state.blocked_task_scope if state.unresolved_blockers else None)
        if not record.task_plan and not state.unresolved_blockers:
            return True  # 旧计划无映射仍沿用旧语义，但不能由局部阻塞推断独立工作。
        scope = reduce_scope(record.task_plan, state.unresolved_blockers, identity)
        if not scope['valid']:
            self._loop_wait(state, record, 'task_scope_unknown', scope['reason'])
            return False
        # 对模型计划做第二次原始步骤校验，持久化字段修改不能借旧 planId 通过。
        fresh = freeze_plan(parsed.get('taskPlan') or {
            'version': 1, 'tasks': record.task_plan['tasks'], 'preconditions': [
                {k: v for k, v in p.items() if k != 'status'} for p in record.task_plan['preconditions']]},
            [s.to_dict() for s in record.orchestration], state.task_source, identity,
            state.blocked_task_scope if state.unresolved_blockers else None)
        if not fresh.get('valid') or fresh['planId'] != record.task_plan['planId']:
            self._loop_wait(state, record, 'task_scope_unknown', '冻结步骤/任务计划发生漂移。')
            return False
        return True

    def _loop_record_task_blockers(self, session: Any, state: Any, record: Any,
                                    raw: Any, identity: dict, step: Any = None) -> None:
        boundary = f'step{step.index}' if step is not None else 'analysis'
        parsed = normalize_blockers(raw, record.task_plan, identity, boundary=f'{record.round}:{record.seq}:{boundary}')
        for item in parsed.get('items', []):
            item['observedAt'] = time.time()
        record.task_blockers = merge_blockers(record.task_blockers, parsed)
        state.unresolved_blockers = merge_blockers(state.unresolved_blockers, parsed)
        if not state.blocked_task_scope:
            state.blocked_task_scope = copy.deepcopy(record.task_plan) or invalid('旧计划没有任务映射')
        record.blocker_review = record.blocker_review or {'status': 'pending', 'boundary': f'{record.round}:{record.seq}:analysis'}
        if step is not None:
            step.task_result = 'blocked'
        record.updated_at = time.time()
        self._loop_save(state)
        self._emit_loop_updated(state)

    async def _loop_task_step_gate(self, session: Any, state: Any, record: Any, step: Any) -> bool:
        if record.blocker_review:
            return False  # 本轮不跳步；包括尚未启动的并发读任务。
        if not record.task_plan and not state.unresolved_blockers and not step.test_writes_user_data:
            return True
        identity = self._loop_task_identity(session, state, record)
        scope = reduce_scope(record.task_plan, state.unresolved_blockers, identity)
        if not scope['valid']:
            self._loop_wait(state, record, 'task_scope_unknown', scope['reason'])
            return False
        if set(step.task_ids) & set(scope['affectedIds']):
            # 规划不能重新安排受阻操作；交给本轮唯一只读评审核对其他独立任务。
            record.task_blockers = copy.deepcopy(state.unresolved_blockers)
            record.blocker_review = {'status': 'pending', 'boundary': f'{record.round}:{record.seq}:analysis'}
            step.task_result = 'blocked'
            self._loop_save(state)
            return False
        control = state.control_revision
        condition = await asyncio.to_thread(isolation_gate, record.task_plan, record.isolation_evidence,
            identity, step.to_dict(), getattr(session, 'working_dir', '.'))
        if record.blocker_review or not self._loop_task_boundary_current(session, state, record, identity, control):
            return False
        verified = {t['id'] for t in record.task_plan['tasks'] if t['status'] == 'verified'}
        for previous in record.orchestration:
            evidence = record.stage_details.get('taskEvidence', {}).get(str(previous.index), [])
            verified.update(t['id'] for t in evidence if t['status'] == 'verified')
        reason_code = 'isolation_unverified'
        resolution = '在原授权内以独立准备调用核对真实测试数据路径及当前配置；不得探测被拒资源。'
        if not set(step.depends_on) <= verified:
            condition = '任务依赖尚未核实：' + '、'.join(sorted(set(step.depends_on) - verified))
            reason_code = 'dependency_unverified'
            resolution = '先提供依赖任务的适用核实证据，不能以正常调用结束代替验收。'
        if condition:
            self._loop_record_task_blockers(session, state, record, {'version': 1, 'items': [{
                'id': reason_code + ':' + digest([step.task_ids, step.precondition_ids, step.depends_on])[:32],
                'affectedTaskIds': step.task_ids, 'reasonCode': reason_code, 'reason': condition[:1200],
                'evidenceRefs': [f'record:{record.seq}:step:{step.index}:boundary'],
                'resolution': resolution}]}, identity, step)
            return False
        return True

    async def _loop_task_result(self, session: Any, state: Any, record: Any, step: Any,
                                output: str, identity: dict, control: int) -> None:
        if not self._loop_task_boundary_current(session, state, record, identity, control):
            # 只在原步骤保留文本；不把迟到结果变成当前身份的放行证据。
            step.task_result = 'unknown'
            return
        obj = self._extract_json_block(output) or {}
        if 'taskEvidence' in obj and record.task_plan.get('valid'):
            try:
                rows = obj['taskEvidence']
                if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
                    raise ContractError('任务证据超限')
                cleaned = []
                for row in rows:
                    if (not isinstance(row, dict) or set(row) != {'id', 'status', 'evidence'}
                            or row['id'] not in step.task_ids or row['status'] not in ('implemented', 'verified')
                            or row['id'] in {r['id'] for r in cleaned}):
                        raise ContractError('任务证据越界')
                    cleaned.append({'id': row['id'], 'status': row['status'], 'evidence': text(row['evidence'])})
                record.stage_details.setdefault('taskEvidence', {})[str(step.index)] = cleaned
            except (ContractError, KeyError, TypeError):
                record.stage_details.setdefault('taskEvidence', {})[str(step.index)] = []
        if 'taskBlockers' in obj:
            self._loop_record_task_blockers(session, state, record, obj['taskBlockers'], identity, step)
        if 'isolationEvidence' in obj and not record.blocker_review:
            receipt = await asyncio.to_thread(isolation_receipts, obj['isolationEvidence'], record.task_plan,
                identity, step.to_dict(), getattr(session, 'working_dir', '.'))
            if self._loop_task_boundary_current(session, state, record, identity, control):
                record.isolation_evidence = {'valid': receipt['valid'],
                    'items': {**record.isolation_evidence.get('items', {}), **receipt['items']},
                    **({'reason': receipt['reason']} if not receipt['valid'] else {})}

    async def _loop_review_blockers(self, session: Any, state: Any, record: Any) -> None:
        review = record.blocker_review
        if not self._loop_task_boundary_current(session, state, record,
                self._loop_task_identity(session, state, record), state.control_revision):
            return
        if review.get('status') == 'done':
            return
        if review.get('status') != 'pending':
            self._loop_wait(state, record, 'task_review_unknown', '上次只读复核的退出/结果未确认，不自动重放。')
            return
        environment = normalize_environment(state.execution_environment)
        if (state.progress_guard.get('pause') or state.control_mode != 'loop'
                or session.id in getattr(self, '_loop_cancel', {})):
            return
        if self._loop_has_active_call(session.id):
            self._loop_wait(state, record, 'call_active', '上一调用未确认退出；未启动只读复核。')
            return
        if environment['blockers'] or environment['incomplete']:
            self._loop_wait(state, record, 'env_unknown', '执行环境仍有未解决门槛，未启动任务复核。')
            return
        if any(step.call_result in ('error', 'timeout', 'unknown') and step.status == 'error' for step in record.orchestration):
            self._loop_wait(state, record, 'task_review_unavailable', '本批次另有未解决执行故障，不以新复核绕过 runner 状态。')
            return
        identity, control = self._loop_task_identity(session, state, record), state.control_revision
        review_identity = self._loop_review_identity(session, record)

        def current() -> bool:
            if (self._loop_task_boundary_current(session, state, record, identity, control)
                    and self._loop_review_identity(session, record) == review_identity):
                return True
            review['status'] = 'stale'
            self._loop_save(state)
            return False

        record.sub_stage = SUB_ANALYSIS
        record.mark_sub(SUB_ANALYSIS)
        review.update(status='running', identity=identity, reviewIdentity=review_identity,
                      evidenceLevel='model_review', access='read-only')
        record.stage_details.setdefault(SUB_ANALYSIS, {}).update(status='running', message='部分任务受阻，正在独立只读复核。')
        record.updated_at = time.time()
        self._loop_save(state)
        writer = getattr(self, '_loop_control_writes', {}).get(session.id)
        if writer is not None:
            await writer.flush()  # 先落盘占用，重启不能重复此复核。
        self._emit_loop_updated(state)
        if not current():
            return
        prompt = (REVIEW_INSTRUCTIONS + '\n' + REPORT_INSTRUCTIONS + '\n' + planning_context(state, record)
            + '\n【本轮原始步骤证据】\n' + evidence_packet(record)
            + '\n【冻结任务图】\n' + json.dumps(record.task_plan, ensure_ascii=False))
        try:
            output, _ = await self._loop_run_agent(session, prompt, SUB_ANALYSIS, record.seq,
                resume=False, indep_session_id=f'{session.id}:loop{record.seq}:blocker-review',
                backend_id=record.backends.get('analysis') or session.backend_id,
                runtime=record.runtimes.get('analysis') or {}, execution_access='read-only')
        except asyncio.CancelledError:
            review['status'] = 'unknown'
            self._loop_save(state)
            raise
        except EnvironmentPause:
            review['status'] = 'failed'
            self._loop_save(state)
            raise
        except Exception as exc:
            review.update(status='failed', reason='只读复核调用失败；未确认独立就绪范围。')
            record.call_results[SUB_ANALYSIS] = 'timeout' if type(exc).__name__ == '_LoopAgentStalledError' else 'error'
            record.stage_details[SUB_ANALYSIS].update(status='error', partialOutput=str(getattr(exc, 'partial_text', ''))[:262144])
            if not current():
                return
            self._loop_wait(state, record, 'task_review_failed', review['reason'])
            return
        if not current():
            record.stage_details[SUB_ANALYSIS].update(rawOutput=output[:262144])
            return
        if len(output) > 262144:
            review['status'] = 'failed'
            self._loop_wait(state, record, 'task_review_failed', '只读复核输出超限，不能据不完整台账调度。')
            return
        record.stage_details[SUB_ANALYSIS].update(rawOutput=output, parsed=self._extract_json_block(output))
        if self._loop_pause_control(state, record, output):
            review['status'] = 'paused'
            self._loop_save(state)
            return
        if not await self._loop_check_source(session, state, record, 'blocker-review', force=True):
            return
        if not current():
            return
        obj = self._extract_json_block(output) or {}
        if 'taskBlockers' in obj:
            incoming = normalize_blockers(obj['taskBlockers'], record.task_plan, identity,
                                          boundary=f'{record.round}:{record.seq}:analysis')
            for item in incoming.get('items', []):
                item['observedAt'] = time.time()
            state.unresolved_blockers = merge_blockers(state.unresolved_blockers, incoming)
        remaining, resolutions = state.unresolved_blockers, []
        try:
            remaining, resolutions = await asyncio.to_thread(resolve_observations, obj.get('blockerResolutions'),
                state.unresolved_blockers, identity, getattr(session, 'working_dir', '.'))
        except (ContractError, OSError, ValueError, KeyError, TypeError) as exc:
            review.update(status='failed', reason=str(exc))
            if not current():
                return
            self._loop_wait(state, record, 'task_resolution_unknown', str(exc))
            return
        if not current():
            return
        report = normalize_report(obj.get('delivery'))
        verified_preconditions: set[str] = set()
        for step in record.task_plan.get('steps', []):
            if step.get('preconditionIds') and not await asyncio.to_thread(isolation_gate,
                    record.task_plan, record.isolation_evidence, identity, step, getattr(session, 'working_dir', '.')):
                verified_preconditions.update(step['preconditionIds'])
        if not current():
            return
        scope = review_scope(obj.get('blockerReview'), report, record.task_plan, remaining, identity, verified_preconditions)
        # 只有完整独立复核通过才提交解除；不能靠半份解析清空保护。
        if scope['valid']:
            state.unresolved_blockers = remaining
            review['resolutions'] = resolutions
            if not remaining:
                state.blocked_task_scope = {}
        review.update(scope, status='done' if scope['valid'] else 'failed')
        record.delivery = protect_report(report, record.task_plan, state.unresolved_blockers, identity) if state.unresolved_blockers else report
        record.call_results[SUB_ANALYSIS] = 'normal'
        record.task_result = 'blocked' if state.unresolved_blockers else 'unknown'
        record.stage_details[SUB_ANALYSIS].update(status='done' if scope['valid'] else 'paused',
            message=('只读复核完成；受阻验收保留。' if state.unresolved_blockers else '阻塞证据已更新；仍需独立验收。') if scope['valid'] else scope['reason'])
        if not scope['valid']:
            self._loop_wait(state, record, 'task_scope_unknown', scope['reason'])
            return
        record.completed, record.terminal_kind, record.sub_stage = True, 'completed', SUB_DONE
        record.outcome_version = 1
        record.mark_sub(SUB_DONE)
        record.analysis = LoopAnalysis(score_observed=False, notes='任务级只读复核；未运行应用或验收测试，未作完成度评分。',
            gaps='受阻任务：' + '、'.join(scope['affectedIds']) if scope['affectedIds'] else '阻塞已解除，验收仍需独立核实。',
            next_focus='独立就绪：' + '、'.join(scope['readyIds']))
        state.progress_guard = assess_progress(state.round_loops(), state.policy.progress_patience)
        state.progress_guard.update(readyIds=scope['readyIds'], affectedIds=scope['affectedIds'], needsReplan=True)
        if not scope['readyIds'] and state.unresolved_blockers:
            resolution = '；'.join(b['resolution'] for b in state.unresolved_blockers.get('items', []))[:1200]
            self._loop_wait(state, record, 'task_blocked', '未确认可继续的独立任务，相关验收保持受阻。', resolution)
            return
        self._loop_reduce(state, record)
        record.updated_at = time.time()
        self._loop_save(state)
        self._emit_loop_updated(state)
