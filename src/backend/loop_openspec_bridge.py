"""OpenSpec 专用迭代，复用 LOOP 调度/调用/安全边界，不构造第二套任务图。"""
from __future__ import annotations

import copy
import json
import time
from typing import Any

from .loop_decisions import DecisionFacts, decide_next, digest
from .loop_openspec import (user_intent, select_change, manual_policy,
                           task_progress, normalize_verify, next_phase)
from .loop_store import LoopStep, LoopAnalysis, SUB_PREPARE, SUB_EXECUTE, SUB_ANALYSIS, SUB_DONE
from .loop_task_source import SourceError, scope_diff, source_summary


class LoopOpenSpecBridge:
    async def _loop_openspec_source(self, session: Any, state: Any, record: Any, boundary: str) -> bool:
        previous = state.task_source
        revision, control = previous.get('revision', 0), state.control_revision
        intent = user_intent(state, record)
        try:
            binding, env = self._loop_source_environment(session, state)
            old = previous.get('binding', {})
            if old and any(old.get(k) != value for k, value in binding.items()):
                raise SourceError('environment_changed', '执行节点、工作区或 Backend 环境已变化，请核对实际执行环境。')
            if old and boundary != 'prepare':
                change = select_change(intent, [{'name': old['change']}], old['change'])
            else:
                discovery = await self._loop_source_reader().read(binding, env, 'driver-discover', revision)
                change = select_change(intent, discovery['candidates'], old.get('change', ''))
            snapshot = await self._loop_source_reader().read(binding, env,
                f'driver:{record.round}:{record.seq}:{boundary}', revision, change, force=True)
            if (state.task_source is not previous or state.control_revision != control
                    or user_intent(state, record) != intent or state.control_mode != 'loop'
                    or self._loop_source_environment(session, state)[0] != binding):
                raise SourceError('stale_revision', '来源查询期间目标或执行身份已变化，请重新运行。')
            before = previous.get('snapshot', {})
            changed = bool(before and before.get('scopeDigest') != snapshot['scopeDigest'])
            history = list(previous.get('history', []))[-19:]
            if not old or changed:
                history.append({'action': 'driver-refresh' if old else 'driver-select',
                    'before': source_summary(previous), 'diff': scope_diff(before, snapshot),
                    'revision': revision + 1, 'disposition': '沿当前用户目标推进同一 OpenSpec change；不解除真实阻塞。'})
            state.task_source = {**previous, 'version': 1, 'driver': 'openspec',
                'revision': revision + (1 if not old or changed else 0),
                'scopeRevision': previous.get('scopeRevision', 0) + (1 if not old or changed else 0),
                'binding': {**binding, 'change': change, 'cliVersion': snapshot.get('cliVersion', '')},
                'snapshot': snapshot, 'history': history, 'reason': '', 'code': '',
                'status': 'blocked' if snapshot['cliState'] == 'blocked' else 'current'}
            state.task_source.pop('candidate', None)
            state.task_source.pop('diff', None)
            record.source_snapshots['before' if boundary == 'prepare' else 'after'] = copy.deepcopy(snapshot)
            if snapshot['cliState'] == 'blocked':
                raise SourceError('workflow_blocked', 'OpenSpec 工作流 blocked：' + snapshot.get('instruction', '请补齐必要工件'))
            self._loop_save(state)
            self._emit_loop_updated(state)
            return True
        except (SourceError, ValueError) as exc:
            code = getattr(exc, 'code', 'source_selection')
            state.task_source = {**state.task_source, 'status': 'blocked' if code == 'workflow_blocked' else 'unavailable',
                                 'reason': str(exc), 'code': code}
            self._loop_wait(state, record, code, str(exc), '在来源中选择明确 change 或修复所列条件后运行。')
            return False

    async def _loop_openspec_iteration(self, session: Any, state: Any, record: Any) -> None:
        if state.risk_coefficient >= state.policy.risk_threshold:
            self._loop_wait(state, record, 'risk_limit', '风险系数达到本轮上限；未启动模型。')
            return
        # 已有真实任务阻塞不得通过绕过通用映射而清空；这里只替代冗余计划格式。
        if state.unresolved_blockers:
            self._loop_wait(state, record, 'task_blocked', '仍有未解除的真实任务阻塞，请先处理其证据与解除条件。')
            return
        record.contract_required = False
        record.goal = state.goal
        from .aimein_learning import addon_in_scope
        pending = [a for a in state.addons if a.status == 'pending' and addon_in_scope(a, record)]
        intent = user_intent(state, record)
        intent_digest = digest([intent, state.policy.strategy])
        skip_manual = manual_policy(state.policy.strategy + '\n' + intent)
        policy_digest = digest(state.policy.to_dict())
        snapshot = state.task_source['snapshot']
        progress = task_progress(snapshot, skip_manual)
        prior = next((r.openspec_run for r in reversed(state.round_loops())
                      if r.seq != record.seq and r.openspec_run.get('status') == 'done'), {})
        # 已开始的调用只在未终态的当前记录中恢复；完成步骤不重放。
        existing = record.openspec_run
        phase = existing.get('phase') or next_phase(progress, prior, intent_digest)
        control, environment, goal = state.control_revision, self._loop_source_environment(session, state)[0], state.goal
        labels = {'apply': '推进 OpenSpec 原任务', 'verify': '验证 OpenSpec 实现', 'repair': '修复 verify 必修问题'}
        record.openspec_run = {**existing, 'version': 1, 'change': snapshot['change'], 'phase': phase,
            'status': 'running', 'intentDigest': intent_digest, 'progress': progress,
            'message': labels[phase]}
        record.stage_details[SUB_PREPARE] = {'status': 'done', 'message': '直接使用 OpenSpec tasks；未请求重复拆分任务图。', 'attempts': []}
        record.mark_sub(SUB_PREPARE)
        stage = SUB_ANALYSIS if phase == 'verify' else SUB_EXECUTE
        record.sub_stage = stage
        record.mark_sub(stage)
        step = record.orchestration[0] if record.orchestration else LoopStep(index=1, mode='sequential',
            access='read' if phase == 'verify' else 'write', desc=labels[phase])
        record.orchestration = [step]
        backend_id = state.policy.backend_for('analysis' if phase == 'verify' else 'execute') or session.backend_id
        if not any(c.id == backend_id for c in self._backend_configs):
            self._loop_wait(state, record, 'backend_missing', '所选 Backend 不存在，不会回退其他执行环境。')
            return
        runtime = self._resolved_runtime(backend_id, self._loop_runtime(session, state,
            'analysis' if phase == 'verify' else 'execute', backend_id, backend_id))
        record.backends[stage], record.runtimes[stage] = backend_id, runtime
        manual_text = '、'.join(progress['manualIds']) or '无'
        prompt = (
            f'当前为 LOOP 的 OpenSpec 原生续跑，change={snapshot["change"]}。\n'
            f'【用户目标及补充】\n{intent}\n【策略】\n{state.policy.strategy}\n'
            f'【当前原任务进度】已勾选 {progress["checked"]}/{progress["total"]}；'
            f'剩余自动任务：{", ".join(progress["pendingIds"])}；明确排除的人工任务：{manual_text}。\n'
            '任务来源已明确，无需再次要求用户绑定/确认同一来源。按 OpenSpec 实际 instructions 和任务文件工作。'
            '不要生成 LOOP taskPlan、完整任务图或 1–4 步 JSON，不因单轮结束声称整个项目完成。'
            '保留已完成工作；人工排除项保持未勾选、记录未验收，不把权限拒绝或真实缺陷改称人工任务。'
            '不得归档、发布或改变授权/节点/ACL。必要用户输入或安全阻塞应具体说明并返回 loopControl:{pause:true,reason:...}。'
            '涉及用户数据的测试必须先核实独立测试目录；不要读取或改写真实存档来代替隔离。\n'
        )
        if phase == 'apply':
            prompt += f'使用 Skill openspec-apply-change 执行 {snapshot["change"]}。持续完成当前可实现任务及其验证并按事实勾选；本轮预算耗尽可正常交接，LOOP 会读取原 tasks 继续。'
        elif phase == 'repair':
            defects = [i for i in prior.get('verify', {}).get('issues', []) if i.get('requiresFix')]
            prompt += '本轮只修复上次 verify 的以下必修问题；这是用户授权的同一变更实现整改，即使 tasks 已全勾也要修复这些缺陷。不要为了消除报告降低规格、伪造勾选或处理纯建议。修复后由下一独立轮再次 verify。\n' + json.dumps(defects, ensure_ascii=False)
        else:
            prompt += (
                f'使用 Skill openspec-verify-change 验证 {snapshot["change"]}。本次只读，不编辑项目或任务勾选。'
                '完整报告后附一个精简 JSON 围栏，顶层 openspecVerify:{complete:true,summary:"说明",issues:[...] }。'
                '每个问题包含 severity:"critical|warning|suggestion", summary:"问题", evidence:"文件/测试依据", '
                'requiresFix:true/false, taskIds:[]。critical 必修；warning 中仅纯建议可 requiresFix:false；'
                '仅明确列出的人工任务缺验收用 kind:"manual" 并给 taskIds；不得将实现缺陷归为人工。'
                '尚有无法核实的必要检查时 complete:false；无问题 issues:[]。'
            )
        self._loop_save(state)
        self._emit_loop_updated(state)
        if step.status != 'done':
            if record.aimein_run:
                prompt += ('\n【AIMEIN 阶段执行边界】只推进当前冻结 Sprint 对应的原任务与验证；'
                           '其他就绪任务留给后续阶段。遵循原 tasks 与 apply/verify，不生成第二份任务台账。')
            step.status, step.started_at = 'running', time.time()
            record.stage_details[stage] = {'status': 'running', 'message': labels[phase]}
            self._loop_save(state)
            self._emit_loop_updated(state)
            text, _ = await self._loop_run_agent(session, prompt, stage, record.seq, resume=False,
                indep_session_id=f'{session.id}:loop{record.seq}:openspec:{phase}', backend_id=backend_id,
                runtime=runtime, execution_access='read-only' if phase == 'verify' else 'workspace-write',
                images=[image for a in pending for image in (a.images or [])] or None)
            step.output, step.ended_at = text, time.time()
            step.status, step.call_result = 'done', 'normal'
            record.call_results[stage] = 'normal'
            record.stage_details[stage] = {'status': 'done', 'rawOutput': text, 'message': labels[phase] + '调用结束'}
            # 调用失败不进入这里；本轮补充已送达后标记，迟到补充不一起消费。
            for addon in pending:
                addon.status, addon.applied_seq, addon.updated_at = 'applied', record.seq, time.time()
        else:
            text = step.output
        if self._loop_pause_control(state, record, text):
            return
        if (state.control_revision != control or state.control_mode != 'loop' or state.goal != goal
                or digest(state.policy.to_dict()) != policy_digest
                or self._loop_source_environment(session, state)[0] != environment
                or session.id in self._loop_cancel or session.id in self._loop_pending_out):
            self._loop_wait(state, record, 'execution_changed', '执行期间目标、控制权或运行环境已改变；已保留输出，请重新运行。')
            return
        if not await self._loop_openspec_source(session, state, record, 'after'):
            return
        after = state.task_source['snapshot']
        progress = task_progress(after, skip_manual)
        run = record.openspec_run
        run['progress'] = progress
        if phase == 'verify':
            parsed = self._extract_json_block(text) or {}
            verification = normalize_verify(parsed.get('openspecVerify'), progress['manualIds'])
            run['verify'] = verification
            if not verification['valid'] or snapshot.get('stateDigest') != after.get('stateDigest') or snapshot.get('scopeDigest') != after.get('scopeDigest'):
                self._loop_wait(state, record, 'verify_incomplete', verification.get('reason') or '验证期间任务范围改变，需要重新 verify。')
                return
        checked_before = {t['id']: t for t in snapshot['tasks']}
        advanced = any(t['done'] and t['id'] in checked_before and not checked_before[t['id']]['done']
                       and t['description'] == checked_before[t['id']]['description'] for t in after['tasks'])
        last_verify = next((r.openspec_run.get('verify') for r in reversed(state.round_loops())
                           if r.seq != record.seq and r.openspec_run.get('phase') == 'verify'
                           and r.openspec_run.get('verify', {}).get('valid')), None)
        if phase == 'verify':
            advanced = last_verify is None or run['verify']['remaining'] < last_verify['remaining']
        count = prior.get('noProgress', 0)
        run.update(status='done', noProgress=0 if advanced else count + (0 if phase == 'repair' else 1))
        state.progress_guard = {'pause': False, 'noProgressCount': run['noProgress'],
                                'round': state.round, 'seq': record.seq}
        run['message'] = ('验证仍有必修问题，将进入修复' if run.get('verify', {}).get('remaining') else
                          '本次完成，继续按原任务和 verify 结果推进')
        record.completed, record.terminal_kind, record.task_result = True, 'completed', 'partial'
        record.analysis = LoopAnalysis(score_observed=False, notes=run['message'])
        record.result = labels[phase] + '完成'
        record.sub_stage = SUB_DONE
        record.mark_sub(SUB_DONE)
        record.updated_at = time.time()
        self._loop_save(state)
        self._emit_loop_updated(state)

    def _loop_openspec_reduce(self, state: Any, record: Any) -> dict:
        run, guard = record.openspec_run, state.progress_guard
        progress, verification = run.get('progress', {}), run.get('verify', {})
        complete = (run.get('status') == 'done' and run.get('phase') == 'verify'
                    and verification.get('valid') is True and not verification.get('remaining')
                    and not progress.get('pendingIds') and not any(a.status == 'pending' for a in state.addons))
        failures = 0
        for r in reversed(state.round_loops()):
            if r.terminal_kind != 'failed':
                break
            failures += 1
        facts = DecisionFacts(auto=state.auto, control_mode=state.control_mode,
            user_stop=state.session_id in self._loop_cancel or state.session_id in self._loop_pending_out,
            hard_reason=guard.get('reasonCode', 'human_input') if guard.get('pause') else ('task_blocked' if state.unresolved_blockers else ''),
            reason_text=guard.get('reason', ''), resume_condition=guard.get('resumeCondition', ''),
            source_status=state.task_source.get('status', 'unavailable'), complete=complete,
            manual_remaining=bool(progress.get('manualIds')), budget_exhausted=len(state.round_loops()) >= state.effective_max_loops(),
            risk_limit=state.risk_coefficient >= state.policy.risk_threshold, failure_limit=failures >= 3,
            call_result='error' if record.terminal_kind == 'failed' else 'normal' if record.completed else 'unknown',
            retry_allowed=record.terminal_kind == 'failed', call_still_active=self._loop_has_active_call(state.session_id),
            no_progress_pause=run.get('noProgress', 0) >= state.policy.progress_patience,
            ready_ids=progress.get('pendingIds', []) or (['openspec:verify-or-repair'] if record.completed else []))
        decision = decide_next(facts, f'{record.round}:{record.seq}:terminal', [f'record:{record.seq}', f'openspec:{run.get("change", "")}'])
        self._loop_keep_decision(state, record, decision)
        if decision['action'] in ('complete', 'stop'):
            if decision['action'] == 'complete':
                record.task_result = 'verified'
                run['message'] = '自动范围完成，待人工核验' if progress.get('manualIds') else '原任务完成，verify 无待修复问题'
            self._apply_loop_out(state, decision['reasonText'])
            state.status = 'output' if decision['action'] == 'complete' else 'aborted'
        elif decision['action'] == 'wait' and decision['reasonCode'] != 'auto_off':
            state.auto = False
            state.progress_guard = {**guard, 'pause': True, 'reasonCode': decision['reasonCode'],
                                    'reason': decision['reasonText'], 'resumeCondition': decision['resumeCondition']}
        return decision
