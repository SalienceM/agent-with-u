"""Pure LOOP decisions. Model prose is neither a terminal event nor permission."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

CALL_RESULTS = frozenset({'normal', 'error', 'timeout', 'cancelled', 'unknown'})
TASK_RESULTS = frozenset({'partial', 'implemented', 'verified', 'blocked', 'unknown'})
TERMINALS = frozenset({'', 'completed', 'paused', 'failed', 'cancelled', 'unknown'})
ACTIONS = frozenset({'continue', 'replan', 'retry', 'wait', 'stop', 'complete'})


def short(value: Any, limit: int = 1200) -> str:
    return value[:limit] if isinstance(value, str) else ''


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode('utf-8')).hexdigest()


def enum_value(value: Any, allowed: frozenset[str], fallback: str = 'unknown') -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def bounded_object(value: Any, max_bytes: int = 1_048_576) -> dict:
    """Invalid persisted new data stays explicitly invalid, never silently unbound."""
    if value is None or value == {}:
        return {}
    if not isinstance(value, dict):
        return {'valid': False, 'status': 'invalid'}
    try:
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(raw.encode('utf-8')) > max_bytes:
            raise ValueError('oversized')
        return json.loads(raw)
    except (ValueError, TypeError, RecursionError):
        return {'valid': False, 'status': 'invalid'}


def normalize_decision(raw: Any) -> dict:
    if not raw:
        return {}
    raw = raw if isinstance(raw, dict) else {}
    action = enum_value(raw.get('action'), ACTIONS, 'wait')
    valid = raw.get('action') in ACTIONS if isinstance(raw.get('action'), str) else False
    return {
        'version': 1, 'decisionId': short(raw.get('decisionId'), 80),
        'action': action, 'reasonCode': short(raw.get('reasonCode'), 80) if valid else 'unknown',
        'reasonText': short(raw.get('reasonText')) if valid else '调度结果未确认，请核对原始记录。',
        'nextStep': short(raw.get('nextStep')), 'resumeCondition': short(raw.get('resumeCondition')),
        'affectedIds': [short(v, 120) for v in raw.get('affectedIds', [])[:100] if isinstance(v, str)]
        if isinstance(raw.get('affectedIds'), list) else [],
        'basisRefs': [short(v, 240) for v in raw.get('basisRefs', [])[:100] if isinstance(v, str)]
        if isinstance(raw.get('basisRefs'), list) else [],
        'completionScope': raw.get('completionScope', '') if action == 'complete'
        and raw.get('completionScope') in ('automatic', 'full') else '',
        'boundary': short(raw.get('boundary'), 120),
        **{key: raw.get(key, 0) if isinstance(raw.get(key, 0), int) else 0
           for key in ('revision', 'round', 'seq')},
    }


@dataclass
class DecisionFacts:
    auto: bool = False
    control_mode: str = 'loop'
    user_stop: bool = False
    hard_reason: str = ''
    reason_text: str = ''
    resume_condition: str = ''
    source_status: str = 'unbound'
    complete: bool = False
    manual_remaining: bool = False
    budget_exhausted: bool = False
    risk_limit: bool = False
    failure_limit: bool = False
    call_result: str = 'unknown'
    retry_allowed: bool = False
    call_still_active: bool = False
    no_progress_pause: bool = False
    needs_replan: bool = False
    needs_review: bool = False
    ready_ids: list[str] = field(default_factory=list)
    affected_ids: list[str] = field(default_factory=list)


def decide_next(facts: DecisionFacts, boundary: str, basis: list[str] | None = None) -> dict:
    """Order safety before completion; budgets prohibit new work, not real success."""
    action, code, message, next_step, condition = 'wait', 'unknown', '尚无可确认的后续工作。', '核对任务与执行记录。', '补充可执行任务或必要条件。'
    if facts.user_stop or facts.control_mode != 'loop':
        action, code, message = 'stop', 'user_stop', '用户停止或控制权已转交，未自动续跑。'
    elif facts.call_still_active:
        code, message, condition = 'call_active', '上一调用尚未确认退出。', '确认旧调用退出后显式恢复。'
    elif facts.hard_reason:
        code, message = facts.hard_reason, facts.reason_text or '执行已暂停，原因待补充。'
        condition = facts.resume_condition or '核对暂停依据并补充条件后显式恢复；恢复不扩大授权。'
    elif facts.source_status not in ('unbound', 'current'):
        code = 'scope_conflict' if facts.source_status == 'conflict' else (
            'workflow_blocked' if facts.source_status == 'blocked' else 'source_unavailable')
        message, condition = '任务来源暂不可核对或存在范围冲突。', '修复或确认来源后重新核对，再显式恢复。'
    elif facts.complete:
        action, code = 'complete', 'acceptance_passed'
        message = '自动范围完成，待人工核验。' if facts.manual_remaining else '完整范围及必要验收已通过。'
        next_step, condition = ('按明确人工依据完成核验。' if facts.manual_remaining else '查看验收记录。'), ''
    elif facts.budget_exhausted or facts.risk_limit or facts.failure_limit:
        action = 'stop'
        code = 'budget_exhausted' if facts.budget_exhausted else 'risk_limit' if facts.risk_limit else 'failure_limit'
        message = {'budget_exhausted': '达到最大 loop 约束，任务尚未完成。',
                   'risk_limit': '达到风险止损边界，任务尚未完成。',
                   'failure_limit': '连续执行故障达到上限，任务尚未完成。'}[code]
    elif not facts.auto:
        code, message, next_step, condition = 'auto_off', '自动执行未开启。', '可手动执行下一次或开启 Auto。', '用户显式运行或开启 Auto。'
    elif facts.no_progress_pause:
        code, message = 'no_progress', '连续评审未确认实质推进，自动执行已暂停。'
        condition = '补充条件、调整策略或人工接管后显式恢复。'
    elif facts.call_result in ('error', 'timeout') and facts.retry_allowed:
        action, code, message = 'retry', 'bounded_retry', '保留成果，按既有重试预算重新核对并恢复。'
        next_step, condition = '检查已落盘成果，使用有限重试。', ''
    elif facts.ready_ids or facts.needs_review:
        action = 'replan' if facts.needs_replan or facts.needs_review else 'continue'
        code = 'review_required' if facts.needs_review else 'ready_work'
        message = '需要重新核对任务与证据。' if facts.needs_review else '目标未完成，存在安全就绪任务。'
        next_step, condition = ('重新规划并核对剩余范围。' if action == 'replan' else '继续下一批就绪任务。'), ''
    else:
        code = 'human_input'
    result = normalize_decision(dict(action=action, reasonCode=code, reasonText=message,
        nextStep=next_step, resumeCondition=condition, boundary=boundary,
        affectedIds=facts.affected_ids or facts.ready_ids, basisRefs=basis or [],
        completionScope=('automatic' if facts.manual_remaining else 'full') if action == 'complete' else ''))
    result['decisionId'] = digest(result)[:32]
    return result
