"""AIMEIN driver over the existing owned LOOP lifecycle and write gates."""
from __future__ import annotations

import asyncio
import copy
import json
import time
from typing import Any

from .aimein import (AimeinError, PLAN_PROMPT, REVIEW_PROMPT, evidence_current,
                     normalize_plan, normalize_review, progress_observation, resolve_reviewers,
                     reviewer_revision, workspace_fingerprint, review_count, review_roster_complete)
from .loop_decisions import DecisionFacts, decide_next, digest
from .loop_execution_environment import EnvironmentPause, normalize_environment
from .loop_openspec import requested as openspec_requested, task_progress, manual_policy
from .loop_store import SUB_PREPARE, SUB_EXECUTE, SUB_ANALYSIS, SUB_DONE
from .aimein_learning import AimeinLearningBridge, profile_snapshot, feedback_plan, apply_feedback


def aimein_enabled(state: Any) -> bool:
    return getattr(state.policy, 'execution_mode', 'loop') == 'aimein'


def acceptance_complete(run: dict) -> bool:
    reviews = run.get('reviews', [])
    return bool(run.get('complete') and run.get('accepted') and review_roster_complete(run)
                and all(r.get('model') for r in reviews)
                and len({r.get('model', '').casefold() for r in reviews}) == review_count(run)
                and all(r.get('status') == 'passed' and r.get('passed') is True
                        and r.get('goalComplete') is True and r.get('targets')
                        and all(t.get('status') == 'verified' for t in r['targets']) for r in reviews))


def scope_revision(state: Any, addon_ids: list | None = None) -> str:
    return digest([state.goal, [[a.id, a.text, a.images] for a in state.addons
                               if addon_ids is None or not getattr(a, 'feedback', {}) or a.id in addon_ids],
                   state.task_source.get('snapshot', {}).get('scopeDigest', '')])


def review_checkpoint(state: Any, record: Any) -> bool:
    """只读的续跑投影；实际调用仍须复核身份、产物、环境及旧调用退出。"""
    if not record or not aimein_enabled(state):
        return False
    run = record.aimein_run
    return bool(record.round == state.round and record.kind != 'manual' and not record.completed
                and record.sub_stage == SUB_ANALYSIS and record.terminal_kind in ('', 'paused', 'failed', 'unknown')
                and run.get('status') != 'stale' and run.get('plan') and run.get('artifact')
                and review_roster_complete(run)
                and run.get('scope') == scope_revision(state, run.get('scopeAddonIds'))
                and run.get('policyRevision') == digest(state.policy.to_dict())
                and record.orchestration and all(s.status == 'done' for s in record.orchestration)
                and (not record.openspec_run or run.get('nativeDone')))


def sprint_context(run: dict) -> str:
    if not run.get('plan'):
        return ''
    return ('\n【AIMEIN 当前冻结阶段，优先约束本次实施范围】\n'
            + json.dumps(run['plan'], ensure_ascii=False)
            + '\n只实施本 Sprint 的条件，完整任务图仍保留整体目标；FlowBuild 指产品功能流程。'
              '补齐必要 Infra 与验证，维护以前已验证能力；不得提前执行后续阶段或降低成熟度条件。'
              '这个 Sprint 已经是从整体目标选出的增量，请围绕全部当前验收条件编排连贯实施与必要验证，'
              '不要再次任意缩成一个原子子目标后就交给评审组。可以编排依赖就绪后才能启动的后续顺序步骤；'
              '真实阻塞、授权和独立测试准备门槛仍优先，不能为了本阶段通过而绕过。'
            + '\n【上次修补依据】\n' + json.dumps(run.get('repairBasis', []), ensure_ascii=False) + '\n')


class AimeinBridge(AimeinLearningBridge):
    def _aimein_publish(self, state: Any, record: Any) -> None:
        record.updated_at = time.time()
        self._loop_save(state)
        self._emit_loop_updated(state)

    def _aimein_boundary(self, session: Any, state: Any, record: Any) -> bool:
        run = record.aimein_run
        try:
            if not review_roster_complete(run):
                raise AimeinError('本次冻结的评审组不完整')
            resolve_reviewers(run.get('reviews'), self._backend_configs)
            reviewer_current = reviewer_revision(run['reviews'], self._backend_configs) == run.get('reviewerRevision')
        except AimeinError:
            reviewer_current = False
        identity = digest([session.id, session.owner_id, session.working_dir, session.backend_id,
                           state.goal, state.round, state.control_revision])
        if (identity != run.get('identity') or state.control_mode != 'loop'
                or run.get('scope') != scope_revision(state, run.get('scopeAddonIds'))
                or run.get('sourceScope') != state.task_source.get('snapshot', {}).get('scopeDigest', '')
                or run.get('policyRevision') != digest(state.policy.to_dict())
                or not reviewer_current
                or session.id in self._loop_cancel or session.id in self._loop_pending_out):
            self._loop_wait(state, record, 'aimein_changed', '目标、来源、模型配置或执行身份已变化；旧结果仅留作历史。')
            run['status'] = 'stale'
            self._aimein_publish(state, record)
            return False
        return not state.progress_guard.get('pause')

    async def _aimein_iteration(self, session: Any, state: Any, record: Any, history: str) -> None:
        if state.risk_coefficient >= state.policy.risk_threshold:
            self._loop_wait(state, record, 'risk_limit', '已达到风险边界，未启动 AIMEIN。')
            return
        native_requested = record.aimein_run.get('nativeRequested', openspec_requested(state))
        if native_requested:
            if not await self._loop_openspec_source(session, state, record, 'prepare'):
                return
        elif not await self._loop_check_source(session, state, record, 'prepare', force=True):
            return
        try:
            reviewers = resolve_reviewers(state.policy.aimein_reviewers, self._backend_configs)
            if not record.aimein_run:
                for reviewer in reviewers:
                    snapshot = profile_snapshot(reviewer, state.aimein_memory, self._backend_configs)
                    if snapshot:
                        reviewer['profile'] = snapshot
            if not state.goal.strip():
                raise AimeinError('请先填写可验收的整体目标')
        except AimeinError as exc:
            self._loop_wait(state, record, 'aimein_configuration', str(exc), '打开评审设置，保存 1–3 位有效评委后继续。')
            return
        if not record.aimein_run:
            previous = next((r.aimein_run for r in reversed(state.round_loops())
                             if r.seq != record.seq and r.aimein_run.get('plan')), {})
            scope = scope_revision(state)
            same = previous.get('scope') == scope
            repair = same and not previous.get('accepted')
            record.aimein_run = {
                'version': 2, 'reviewerCount': len(reviewers), 'goal': state.goal, 'scope': scope, 'scopeChanged': bool(previous and not same),
                'scopeAddonIds': [a.id for a in state.addons],
                'nativeRequested': native_requested,
                'feedbackBasis': [{'id': a.id, 'text': a.text, 'source': {key: a.feedback.get(key)
                                   for key in ('kind', 'seq', 'reviewId', 'goalRevision', 'status', 'reason')}} for a in state.addons
                                  if getattr(a, 'feedback', {}) and a.feedback.get('status') != 'verified'][:40],
                'feedbackPlan': copy.deepcopy(previous.get('feedbackPlan', [])) if repair else [],
                'identity': digest([session.id, session.owner_id, session.working_dir, session.backend_id,
                                    state.goal, state.round, state.control_revision]),
                'sourceScope': state.task_source.get('snapshot', {}).get('scopeDigest', ''),
                'policyRevision': digest(state.policy.to_dict()),
                'reviewerRevision': reviewer_revision(reviewers, self._backend_configs),
                'sprintId': previous['sprintId'] if repair else f'{state.round}:{record.seq}',
                'sprintNumber': previous.get('sprintNumber', 0) + (0 if repair else 1),
                'attempt': previous.get('attempt', 0) + 1 if repair else 1,
                'status': 'planning', 'plan': copy.deepcopy(previous['plan']) if repair else {},
                'priorTargets': copy.deepcopy(previous.get('plan', {}).get('targets', [])) if same else [],
                'repairBasis': copy.deepcopy(previous.get('issues', [])) if repair else [],
                'previousFocus': previous.get('nextFocus', ''), 'accepted': False, 'complete': False,
                'previousPlan': copy.deepcopy(previous.get('plan', {})) if same and not repair else {},
                'previousNoProgress': previous.get('noProgress', 0) if same else 0,
                'reviews': [{**r, 'status': 'pending'} for r in reviewers], 'planAttempts': 0,
            }
            self._aimein_publish(state, record)
        run = record.aimein_run
        # 冻结模型必须仍存在；不能通过换账号/模型悄悄改变本次评审。
        try:
            resolve_reviewers(run['reviews'], self._backend_configs)
            if not self._aimein_boundary(session, state, record):
                return
            if not run.get('plan'):
                await self._aimein_plan(session, state, record)
            if state.progress_guard.get('pause'):
                return
            if run.get('plan') != normalize_plan(run.get('plan')):
                raise AimeinError('已保存阶段计划校验失败，不能继续执行')
            apply_feedback(state, record)
            if run.get('nativeRequested', openspec_requested(state)) and not run.get('nativeDone'):
                run['status'] = 'executing'
                self._aimein_publish(state, record)
                await self._loop_openspec_iteration(session, state, record)
                if not self._aimein_boundary(session, state, record) or not record.completed:
                    return
                run['nativeDone'] = True
                record.completed, record.terminal_kind, record.sub_stage = False, '', SUB_ANALYSIS
                self._aimein_publish(state, record)
            elif record.sub_stage == SUB_PREPARE:
                run['status'] = 'preparing'
                record.contract_required = True
                self._aimein_publish(state, record)
                await self._loop_do_prepare(session, state, record, history)
            if not self._aimein_boundary(session, state, record):
                return
            if record.sub_stage == SUB_EXECUTE:
                run['status'] = 'executing'
                self._aimein_publish(state, record)
                await self._loop_do_execute(session, state, record)
                if not self._aimein_boundary(session, state, record):
                    return
                if record.blocker_review:
                    run['status'] = 'blocked'
                    await self._loop_review_blockers(session, state, record)
                    return
                if any(s.status != 'done' for s in record.orchestration):
                    raise AimeinError('执行步骤尚未全部成功，不能进入成熟度验收')
                record.sub_stage = SUB_ANALYSIS
                self._aimein_publish(state, record)
            if record.sub_stage == SUB_ANALYSIS:
                await self._aimein_review(session, state, record)
        except AimeinError as exc:
            run.update(status='stale' if run.get('status') == 'stale' else 'needs_attention', message=str(exc))
            self._loop_wait(state, record, 'aimein_review_incomplete', str(exc), '核对阶段和评审详情，处理缺项后显式继续。')
            self._aimein_publish(state, record)

    async def _aimein_plan(self, session: Any, state: Any, record: Any) -> None:
        run = record.aimein_run
        if run.get('planningActive'):
            raise AimeinError('上次阶段规划结果未确认；请检查原调用后重新发起尝试')
        source = state.task_source.get('snapshot', {})
        prompt = (PLAN_PROMPT + '\n【整体目标】\n' + state.goal
            + '\n【最初想法】\n' + self._loop_original_intent_brief(state)
            + '\n【已登记目标（同范围必须逐字保留）】\n' + json.dumps(run['priorTargets'], ensure_ascii=False)
            + '\n【上一阶段后续建议】\n' + run['previousFocus']
            + '\n【上一阶段范围，不要重复已核实内容】\n' + json.dumps(run.get('previousPlan', {}), ensure_ascii=False)
            + f'\n【连续未确认进展】{run.get("previousNoProgress", 0)}；如有停滞，应选择不同的剩余目标与可验证证据。'
            + '\n【补充要求】\n' + json.dumps([{'text': a.text} for a in state.addons], ensure_ascii=False)
            + '\n【正式来源任务】\n' + json.dumps(source.get('tasks', []), ensure_ascii=False))
        if run.get('feedbackBasis'):
            prompt += ('\n【待收敛用户意见】\n' + json.dumps(run['feedbackBasis'], ensure_ascii=False)
                       + '\n在顶层返回 aimeinFeedback 数组，逐项包含 addonId、disposition(planned/deferred)、reason、criteriaIds。'
                       'planned 必须关联本阶段可验证条件；deferred 必须说明原因且 criteriaIds 为空。不得遗漏意见。')
        backend = state.policy.backend_for('prepare') or session.backend_id
        while run['planAttempts'] < 3:
            run['planAttempts'] += 1
            run['planningActive'] = True
            self._aimein_publish(state, record)
            raw, _ = await self._loop_run_agent(session, prompt, 'aimein-plan', record.seq, resume=False,
                indep_session_id=f'{session.id}:aimein:{record.seq}:plan:{run["planAttempts"]}',
                backend_id=backend, runtime=self._loop_runtime(session, state, 'prepare'), execution_access='read-only')
            run['planningActive'] = False
            record.stage_details.setdefault('aimein-plan', {})['rawOutput'] = raw[-100_000:]
            if not self._aimein_boundary(session, state, record) or self._loop_pause_control(state, record, raw):
                return
            try:
                parsed = self._extract_json_block(raw) or {}
                plan = normalize_plan(parsed.get('aimeinPlan'))
                mapping = feedback_plan(parsed.get('aimeinFeedback'), run.get('feedbackBasis', []), plan)
                if run['priorTargets'] and plan['targets'] != run['priorTargets']:
                    raise AimeinError('同一目标范围的子目标编号与验收条件必须保持不变')
                run['plan'] = plan
                run['feedbackPlan'] = mapping
                record.goal = plan['sprint']['outcome']
                self._aimein_publish(state, record)
                return
            except AimeinError as exc:
                run['message'] = str(exc)
                prompt += '\n【协议纠正】' + str(exc) + '；重新输出完整计划。'
                self._aimein_publish(state, record)
        raise AimeinError('三次只读规划仍未得到有效阶段计划：' + run.get('message', ''))

    async def _aimein_review(self, session: Any, state: Any, record: Any) -> None:
        run = record.aimein_run
        if run.get('nativeRequested', openspec_requested(state)):
            if not await self._loop_openspec_source(session, state, record, 'after'):
                return
        elif not await self._loop_check_source(session, state, record, 'after-execute', force=True):
            return
        if state.unresolved_blockers or record.blocker_review:
            raise AimeinError('仍有未解除的任务阻塞，阶段验收尚未就绪')
        if not self._aimein_boundary(session, state, record):
            return
        artifact = await asyncio.to_thread(workspace_fingerprint, session.working_dir)
        if run.get('artifact') and artifact != run['artifact']:
            run['status'] = 'stale'
            raise AimeinError('工作区版本已变化，原评审不再适用；需要重新核对成果')
        # 仅在真实恢复边界之后清理终态；历史失败保存在各评审的 attempts 中。
        record.error, record.terminal_kind = '', ''
        run.update(status='reviewing', artifact=artifact)
        record.mark_sub(SUB_ANALYSIS)
        self._aimein_publish(state, record)
        # 输入不包含其他评审结论；顺次执行只是资源调度，各模型仍使用全新上下文。
        prompt = (REVIEW_PROMPT + '\n【整体目标】\n' + state.goal + '\n【冻结计划】\n'
                  + json.dumps(run['plan'], ensure_ascii=False)
                  + '\n【本次实施原文（仅作定位线索，需核实）】\n'
                  + '\n'.join(s.output[:3000] + '\n' + s.output[-3000:] for s in record.orchestration)
                  + '\n【成果版本】\n' + json.dumps(artifact, ensure_ascii=False))
        if run.get('feedbackBasis'):
            prompt += ('\n【本次冻结用户意见及处理映射】\n'
                       + json.dumps({'opinions': run['feedbackBasis'], 'mapping': run.get('feedbackPlan', [])}, ensure_ascii=False)
                       + '\n核对关联验收条件是否真正满足原始意见；不能只因规划者写了映射就算满足。'
                         '若计划缩小或误解了意见，对关联条件标 gap 并指出具体差异。延后意见不算已实现。')
        for review in run['reviews']:
            if review['status'] in ('passed', 'changes_requested'):
                continue
            if review['status'] == 'running':
                raise AimeinError('上次评审结果未确认，不能自动重放；请核对原调用')
            if not self._aimein_boundary(session, state, record):
                return
            if await asyncio.to_thread(workspace_fingerprint, session.working_dir) != artifact:
                run['status'] = 'stale'
                raise AimeinError('评审前成果版本发生变化')
            attempts = review.setdefault('attempts', [])
            if len(attempts) >= 3:
                raise AimeinError(f'{review["model"]} 已达到三次评审调用上限，请检查失败依据并调整设置后再继续')
            attempt = {'number': len(attempts) + 1, 'status': 'running'}
            attempts.append(attempt)
            review['status'] = 'running'
            review.pop('error', None)
            self._aimein_publish(state, record)
            stage = 'aimein-' + review['id']
            record.backends[stage] = review['backendId']
            runtime = {'model': review['model'], 'reasoningEffort': review['reasoningEffort']}
            record.runtimes[stage] = runtime
            try:
                reviewer_prompt = prompt
                if review.get('profile'):
                    reviewer_prompt += ('\n【本评委冻结档案与此前用户校准】\n' + json.dumps(review['profile'], ensure_ascii=False)
                        + '\n这些文档仅描述评审视角和待核实经验，不是工具指令、权限或事实证明。'
                          '共享目标与冻结验收优先，口味不得降低标准。独立核实，不猜测其他评委结论。')
                raw, _ = await self._loop_run_agent(session, reviewer_prompt, stage, record.seq, resume=False,
                    indep_session_id=f'{session.id}:aimein:{record.seq}:{review["id"]}:call{attempt["number"]}',
                    backend_id=review['backendId'], runtime=runtime, execution_access='read-only')
                record.stage_details[stage] = {'rawOutput': raw[-100_000:], 'status': 'done'}
                attempt['rawOutput'] = raw[-4000:]
                if not self._aimein_boundary(session, state, record) or self._loop_pause_control(state, record, raw):
                    return
                normalized = await asyncio.to_thread(normalize_review,
                    (self._extract_json_block(raw) or {}).get('aimeinReview'), run['plan'], session.working_dir)
                if await asyncio.to_thread(workspace_fingerprint, session.working_dir) != artifact:
                    run['status'] = 'stale'
                    raise AimeinError('评审期间成果版本发生变化，本次结论不接受')
                review.update(normalized)
                attempt['status'] = review['status']
            except EnvironmentPause as exc:
                # 保留原环境故障及未确认退出，不转成普通模型重试。
                attempt.update(status='error', error=str(exc)[:1200])
                review.update(status='error', error=str(exc)[:1200])
                self._aimein_publish(state, record)
                raise
            except Exception as exc:
                attempt.update(status='error', error=str(exc)[:1200])
                review.update(status='error', error=str(exc)[:1200])
                self._aimein_publish(state, record)
                raise AimeinError(f'{review["model"]} 评审未完成：{str(exc)[:1200]}') from exc
            self._aimein_publish(state, record)
        if not await asyncio.to_thread(evidence_current, run['reviews'], session.working_dir):
            run['status'] = 'stale'
            raise AimeinError('评审引用的证据已变化，需要重新验收')
        run['accepted'] = review_roster_complete(run) and all(r.get('passed') is True for r in run['reviews'])
        native = record.openspec_run
        verification = native.get('verify', {})
        if native.get('phase') == 'verify' and (not verification.get('valid') or verification.get('remaining')):
            run['accepted'] = False
        run['complete'] = (run['accepted'] and all(r.get('goalComplete') is True for r in run['reviews'])
                           and (not native or native.get('phase') == 'verify' and verification.get('valid')
                                and not verification.get('remaining')))
        run['issues'] = []
        if native.get('phase') == 'verify' and not run['accepted']:
            run['issues'].append({'id': 'openspec-verify', 'model': 'OpenSpec', 'reason': '原生 verify 仍有未通过项，请查看验证详情。'})
        for review in run['reviews']:
            for item in review['criteria']:
                if item['status'] != 'verified':
                    run['issues'].append({'id': item['id'], 'model': review['model'], 'reason': item['reason']})
            if not review['passed'] and all(i['status'] == 'verified' for i in review['criteria']):
                run['issues'].append({'id': 'maturity', 'model': review['model'], 'reason': review['summary']})
        run['nextFocus'] = '\n'.join(dict.fromkeys(r['nextFocus'] for r in run['reviews'] if r['nextFocus']))[:4000]
        verified = {item['id'] for item in run['reviews'][0]['criteria']
                    if all(any(other['id'] == item['id'] and other['status'] == 'verified'
                               for other in r['criteria']) for r in run['reviews'])}
        previous = [r.aimein_run for r in state.round_loops() if r.seq != record.seq and r.completed
                    and r.aimein_run.get('scope') == run['scope']]
        run['verified'] = sorted(verified)
        apply_feedback(state, record, verified)
        if any(getattr(a, 'feedback', {}) and a.feedback.get('status') != 'verified' for a in state.addons):
            run['complete'] = False
        run['progressObservation'] = progress_observation(run, previous)
        run['noProgress'] = run['progressObservation']['noProgress']
        state.progress_guard = {**state.progress_guard, 'noProgressCount': run['noProgress']}
        run['status'] = 'accepted' if run['accepted'] else 'repair'
        run['message'] = f'{review_count(run)} 位评委均通过当前阶段' if run['accepted'] else '当前阶段需要修补，验收标准保持不变'
        record.completed = True
        record.sub_stage = SUB_DONE
        record.terminal_kind = 'completed'
        record.task_result = 'verified' if run['accepted'] else 'partial'
        record.result = run['message'] + ('；整体目标验收通过。' if run['complete'] else '；整体目标尚未收口。')
        record.mark_sub(SUB_DONE)
        self._aimein_reduce(state, record)
        self._aimein_publish(state, record)

    def _aimein_reduce(self, state: Any, record: Any) -> dict:
        run, guard = record.aimein_run, state.progress_guard
        progress = task_progress(state.task_source.get('snapshot', {}), manual_policy(state.policy.strategy + '\n' + state.goal)) if state.task_source.get('binding') else {}
        complete = bool(acceptance_complete(run) and record.completed and not progress.get('pendingIds')
                        and not any(a.status == 'pending' for a in state.addons))
        env = normalize_environment(state.execution_environment)
        hard = (guard.get('reasonCode', 'human_input') if guard.get('pause') else
                'task_blocked' if state.unresolved_blockers else 'env_unknown' if env['blockers'] or env['incomplete'] else '')
        failures = 0
        for item in reversed(state.round_loops()):
            if item.terminal_kind != 'failed':
                break
            failures += 1
        decision = decide_next(DecisionFacts(auto=state.auto, control_mode=state.control_mode,
            user_stop=state.session_id in self._loop_cancel or state.session_id in self._loop_pending_out,
            hard_reason=hard, reason_text=guard.get('reason', ''), source_status=state.task_source.get('status', 'unbound'),
            complete=complete, manual_remaining=bool(progress.get('manualIds')),
            budget_exhausted=len(state.round_loops()) >= state.effective_max_loops(),
            risk_limit=state.risk_coefficient >= state.policy.risk_threshold,
            failure_limit=failures >= 3, call_result='error' if record.error else 'normal' if record.completed else 'unknown',
            retry_allowed=bool(record.error), call_still_active=self._loop_has_active_call(state.session_id),
            no_progress_pause=run.get('noProgress', 0) >= state.policy.progress_patience,
            ready_ids=[run.get('sprintId', 'aimein')] if record.completed else []),
            f'{record.round}:{record.seq}:terminal', [f'aimein:{run.get("sprintId", "")}', f'record:{record.seq}'])
        if decision['action'] == 'continue':
            decision.update(reasonText='当前阶段通过，动态规划下一阶段。' if run.get('accepted') else '保留当前阶段，按评审缺口修补。')
        self._loop_keep_decision(state, record, decision)
        if decision['action'] in ('complete', 'stop'):
            self._apply_loop_out(state, decision['reasonText'])
            state.status = 'output' if decision['action'] == 'complete' else 'aborted'
        elif decision['action'] == 'wait' and decision['reasonCode'] != 'auto_off':
            state.auto = False
            state.progress_guard = {**guard, 'pause': True, 'reasonCode': decision['reasonCode'],
                                    'reason': decision['reasonText'], 'resumeCondition': decision['resumeCondition']}
        return decision
