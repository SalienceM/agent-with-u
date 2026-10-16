"""Bounded task-contract diagnostics/receipts. No I/O and no execution authority."""
from __future__ import annotations

from typing import Any

from .loop_decisions import bounded_object, short
from .loop_task_blockers import validate_candidate, freeze_plan, normalize_blockers, merge_blockers, invalid

PLAN_ATTEMPTS = 3
REPAIR_ATTEMPTS = 2
REPAIR_TERMINAL = frozenset({'succeeded', 'blocked', 'failed', 'stale', 'cancelled'})


def repair_active(items: list[dict]) -> bool:
    return any(item.get('status') not in REPAIR_TERMINAL for item in receipts(items))


def count(value: Any, maximum: int = PLAN_ATTEMPTS) -> int:
    return min(maximum, max(0, value)) if type(value) is int else 0


def diagnostic(raw: Any) -> dict:
    if raw is None or raw == {}:
        return {}
    raw = bounded_object(raw, 32_768)
    result = {'version': 1, 'valid': raw.get('valid') is True,
              'reasonCode': short(raw.get('reasonCode'), 80) or 'unknown',
              'reason': short(raw.get('reason')),
              'origin': raw.get('origin') if raw.get('origin') in
              ('output', 'source', 'history', 'identity') else 'unknown',
              'repairable': raw.get('repairable') is True,
              'scopeUnknown': raw.get('scopeUnknown', True) is not False or
                  isinstance(raw.get('affectedIds'), list) and len(raw['affectedIds']) > 100,
              'causeRef': short(raw.get('causeRef'), 100),
              'causeRevision': count(raw.get('causeRevision'), 1_000_000),
              'attemptCount': count(raw.get('attemptCount')),
              'status': raw.get('status') if raw.get('status') in
              ('retrying', 'valid', 'exhausted', 'paused', 'repaired', 'stale') else 'unknown'}
    for key, limit, width in (('fields', 16, 160), ('affectedIds', 100, 120),
                              ('evidenceRefs', 16, 240), ('identityDimensions', 16, 80)):
        result[key] = [short(v, width) for v in raw.get(key, [])[:limit] if isinstance(v, str)] \
            if isinstance(raw.get(key), list) else []
    return result


def receipts(raw: Any) -> list[dict]:
    if raw is None or raw == []:
        return []
    if not isinstance(raw, list) or len(raw) > 16:
        return [{'version': 1, 'status': 'unknown', 'reason': '修复回执无法核对'}]
    result = []
    for value in raw:
        item = bounded_object(value, 4_194_304)
        if not item or item.get('version') != 1:
            item = {'version': 1, 'status': 'unknown', 'reason': '修复回执无法核对'}
        if item.get('status') not in REPAIR_TERMINAL | {'accepted', 'running', 'unknown'}:
            item['status'] = 'unknown'
        item['attemptCount'] = count(item.get('attemptCount'), REPAIR_ATTEMPTS)
        result.append(item)
    return result


def receipt_summary(raw: Any) -> dict:
    if not isinstance(raw, dict) or not raw:
        return {}
    return {'version': 1, **{k: short(raw.get(k), 1200 if k == 'reason' else 120)
            for k in ('requestId', 'status', 'reason', 'causeRef')},
            **{k: count(raw.get(k), 1_000_000) for k in ('round', 'seq', 'causeRevision', 'controlRevision')},
            'attemptCount': count(raw.get('attemptCount'), REPAIR_ATTEMPTS)}


def repair_audit(raw: dict) -> dict:
    def public(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: public(v) for k, v in value.items() if k != 'identity'}
        return [public(v) for v in value] if isinstance(value, list) else value
    return {**receipt_summary(raw), **{key: public(raw[key]) for key in
        ('original', 'attempts', 'validation', 'replacement') if key in raw}}


def repair_candidate(raw: Any, steps: list[dict], source: dict, identity: dict,
                     basis_plan: dict, retained: dict, observations: list[dict],
                     *, had_execution: bool = False) -> dict:
    """重建表达，不解除阻塞。observations 必须由执行端从原始记录定位，不能来自候选模型。"""
    if (had_execution or retained) and (not basis_plan.get('valid') or basis_plan.get('identity') != identity):
        return invalid('缺少匹配原执行身份的有效任务图，不能重建已执行/受阻范围',
                       code='repair_evidence_missing', origin='history')
    if not basis_plan and not source.get('binding'):
        return invalid('缺少正式来源或原始完整任务图，无法确认修复范围',
                       code='repair_evidence_missing', origin='history')
    # 缺证据不是候选输出错误，在启动模型纠正之前就拒绝。
    if retained and not retained.get('valid'):
        boundaries = {item.get('boundary') for item in observations}
        if not observations or any(item.get('boundary') not in boundaries for item in retained.get('items', [])):
            return invalid('原始阻塞观察不完整，无法核对全部影响范围',
                           code='repair_evidence_missing', origin='history')
        if any(not normalize_blockers(item.get('raw'), basis_plan, identity,
                   boundary=item.get('boundary', 'unknown'))['valid'] for item in observations):
            return invalid('原始阻塞观察无法完整核对，需补充证据或明确范围处置',
                           code='repair_evidence_missing', origin='history')
    candidate = validate_candidate(raw, steps, source, identity, basis_plan or None)
    if not candidate['valid']:
        return candidate
    plan = candidate['plan']
    if basis_plan and plan.get('preconditions', []) != basis_plan.get('preconditions', []):
        return invalid('修复候选改变了原测试隔离前置，需另行核对范围，不能作为映射修复提交',
                       code='repair_precondition_changed', origin='history', field='taskPlan.preconditions')
    # 协议修复不产生已实现/已验收信用，只保留可核对的原任务状态。
    old_tasks = {t['id']: t for t in basis_plan.get('tasks', [])}
    for task in plan['tasks']:
        old = old_tasks.get(task['id'], {})
        task.update(status=old.get('status', 'pending'), evidence=old.get('evidence', ''))
    clean_raw = {'version': 1, 'tasks': plan['tasks'], 'preconditions': raw.get('preconditions', [])}
    plan = freeze_plan(clean_raw, steps, source, identity, basis_plan or None, required=True)
    rebuilt: dict = {}
    # 无效聚合必须能逐次重建全部原始观察，否则保守保留未知影响。
    if retained and not retained.get('valid') and not observations:
        return invalid('缺少导致无效阻塞的原始输出，不能仅保留已解析的部分',
                       code='repair_evidence_missing', origin='history')
    for observation in observations:
        item = normalize_blockers(observation.get('raw'), plan, identity,
                                  boundary=observation.get('boundary', 'unknown'))
        if not item['valid']:
            return invalid('原始阻塞观察无法完整核对，需补充证据或明确范围处置',
                           code='repair_evidence_missing', origin='history')
        rebuilt = merge_blockers(rebuilt, item)
        if not rebuilt['valid']:
            return rebuilt
    for item in retained.get('items', []):
        if item.get('identity') != identity:
            return invalid('旧阻塞身份变化，不能以协议修复解除', code='identity_mismatch', origin='identity')
        raw_item = {k: item.get(k) for k in ('id', 'affectedTaskIds', 'reasonCode', 'reason', 'evidenceRefs', 'resolution')}
        checked = normalize_blockers({'version': 1, 'items': [raw_item]}, plan, identity,
                                     boundary=item.get('boundary', 'unknown'))
        if not checked['valid']:
            return checked
        rebuilt = merge_blockers(rebuilt, checked)
        if not rebuilt['valid']:
            return rebuilt
    return {'version': 1, 'valid': True, 'plan': plan, 'blockers': rebuilt}
