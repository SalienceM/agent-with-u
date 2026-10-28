"""Bounded, session-owned reviewer documents and feedback observations."""
from __future__ import annotations

import copy
import json
import re
import time
import uuid
from typing import Any

from .aimein import AimeinError, text, rows, resolve_reviewers, reviewer_revision
from .loop_decisions import digest
from .codex_reasoning import normalize_reasoning_effort


def memory(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return {'revision': 0, 'profiles': [], 'calibrations': []}
    # 不修复损坏的文档，也不从模型回复接受新档案。
    if raw.get('valid') is False:
        raise AimeinError('已保存档案无效，请核对存储文件，不能覆盖为新空档案')
    if len(json.dumps(raw, ensure_ascii=False, allow_nan=False).encode('utf-8')) > 900_000:
        raise AimeinError('评委档案超过存储上限')
    return {'revision': max(0, int(raw.get('revision', 0))),
            'profiles': copy.deepcopy(rows(raw.get('profiles', []), 24, 0)),
            'calibrations': copy.deepcopy(rows(raw.get('calibrations', []), 96, 0))}


def memory_summary(raw: dict) -> dict:
    return {'revision': raw.get('revision', 0), 'profiles': len(raw.get('profiles', [])),
            'calibrations': len(raw.get('calibrations', []))}


def document(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise AimeinError('档案必须是结构化文档')
    result = {key: text(raw.get(key), size) for key, size in
              (('name', 120), ('backendId', 200), ('model', 200), ('domain', 500), ('flavor', 1200), ('focus', 1200))}
    effort = raw.get('reasoningEffort', '') or ''
    if effort and not normalize_reasoning_effort(effort):
        raise AimeinError('推理档位必须是有效的配置 token')
    result['reasoningEffort'] = normalize_reasoning_effort(effort)
    result['revision'] = digest(result)
    return result


def backend_revision(doc: dict, configs: list) -> str:
    return reviewer_revision([doc], configs) if any(c.id == doc['backendId'] for c in configs) else ''


def profile_snapshot(reviewer: dict, raw: dict, configs: list | None = None) -> dict:
    if not reviewer.get('profileId'):
        return {}
    profile = next((p for p in raw.get('profiles', []) if p['id'] == reviewer['profileId']), None)
    if not profile:
        raise AimeinError('选用的评委档案不存在，请重新选择')
    doc = profile['document']
    if any(doc.get(key, '') != reviewer.get(key, '') for key in ('backendId', 'model', 'reasoningEffort')):
        raise AimeinError('档案与评委模型配置不一致，请重新选用档案')
    connection = backend_revision(doc, configs or [])
    notes = [c for c in raw.get('calibrations', [])
             if c.get('profileId') == profile['id'] and c.get('revision') == doc['revision']
             and connection and c.get('backendRevision') == connection][-12:]
    return copy.deepcopy({'id': profile['id'], **doc, 'backendRevision': connection, 'calibrations': notes})


def available(doc: dict, configs: list) -> bool:
    cfg = next((c for c in configs if c.id == doc['backendId']), None)
    if cfg is None or getattr(cfg, 'enabled', True) is False:
        return False
    from .poe_api import is_poe_api_base_url
    if is_poe_api_base_url(getattr(cfg, 'base_url', '')):
        return False
    kind = str(getattr(getattr(cfg, 'type', ''), 'value', getattr(cfg, 'type', '')))
    return bool(doc['model'] and (kind in ('codex-office', 'qwen-code-cli', 'deepseek-harness')
                                 or doc['model'] == getattr(cfg, 'model', '')))


def recommendations(raw: dict, task: str, configs: list) -> list[dict]:
    ranked = []
    for profile in raw.get('profiles', []):
        doc = profile['document']
        tokens = set(re.findall(r'[\w\u4e00-\u9fff]+', doc['domain'] + ' ' + doc['focus']))
        # 中文连续短语按二字片段匹配，避免只有整段逐字相同才能命中。
        tokens |= {word[i:i+2] for word in list(tokens) if re.search(r'[\u4e00-\u9fff]', word) for i in range(len(word)-1)}
        matches = sorted(t for t in tokens if len(t) > 1 and t.casefold() in task.casefold())[:8]
        connection = backend_revision(doc, configs)
        notes = [c for c in raw.get('calibrations', []) if c['profileId'] == profile['id'] and c['revision'] == doc['revision']
                 and connection and c.get('backendRevision') == connection]
        counts = {k: sum(c['kind'] == k for c in notes) for k in ('preference', 'confirmed', 'false_positive', 'missed', 'unsuitable')}
        evidence = len(notes) - counts['preference']
        score = len(matches) + min(3, counts['confirmed']) - 2 * (counts['false_positive'] + counts['missed']) - 8 * counts['unsuitable']
        reasons = [('任务匹配：' + '、'.join(matches)) if matches else '尚无明确领域匹配']
        reasons.append(f'同版本用户校准 {evidence} 条（确认 {counts["confirmed"]} / 误报 {counts["false_positive"]} / 漏报 {counts["missed"]} / 不适配 {counts["unsuitable"]}）')
        if evidence < 3:
            reasons.append('样本不足，不能据此认定专业能力')
        ranked.append({'profileId': profile['id'], 'name': doc['name'], 'model': doc['model'],
                       'available': available(doc, configs), 'score': score, 'reasons': reasons, 'samples': evidence,
                       'caution': bool(counts['unsuitable']), 'recommended': False})
    ranked.sort(key=lambda r: (not r['available'], -r['score'], r['name']))
    models: set[str] = set()
    for item in ranked:
        if item['available'] and not item['caution'] and len(models) < 3 and item['model'].casefold() not in models:
            item['recommended'] = True
            models.add(item['model'].casefold())
    return ranked


def update_memory(state: Any, command: dict, configs: list) -> dict:
    current = memory(state.aimein_memory)
    if type(command.get('expectedRevision')) is not int or command['expectedRevision'] != current['revision']:
        raise AimeinError('档案已在其他窗口更新，请重新读取后再保存；草稿保留')
    action = command.get('action')
    if action in ('save', 'import'):
        doc = document(command.get('document'))
        ident = str(command.get('profileId', '')) if action == 'save' else ''
        existing = next((p for p in current['profiles'] if p['id'] == ident), None)
        if ident and not existing:
            raise AimeinError('原档案不存在')
        if existing:
            if doc != existing['document']:
                existing['history'] = [*existing.get('history', []), existing['document']][-8:]
                existing['document'] = doc
        else:
            if len(current['profiles']) >= 24:
                raise AimeinError('本会话最多保存 24 个评委档案')
            current['profiles'].append({'id': str(uuid.uuid4()), 'document': doc, 'history': [], 'imported': action == 'import'})
    elif action == 'calibrate':
        kind = command.get('kind')
        if kind not in ('preference', 'confirmed', 'false_positive', 'missed', 'unsuitable'):
            raise AimeinError('请选择校准类型')
        record = next((r for r in state.loops if r.seq == command.get('seq')), None)
        review = next((r for r in record.aimein_run.get('reviews', []) if r['id'] == command.get('reviewId')), {}) if record else {}
        snapshot = review.get('profile', {})
        if not record or not record.completed or not snapshot or review.get('status') not in ('passed', 'changes_requested'):
            raise AimeinError('需要一份使用档案的已完成评审作为校准来源')
        # 一份评审只保留一条当前校准，修改时显式版本检查；防止重复点击刷高推荐。
        previous = next((c for c in current['calibrations'] if c['seq'] == record.seq and c['reviewId'] == review['id']), None)
        entry = {'profileId': snapshot['id'], 'revision': snapshot['revision'], 'model': review['model'],
                 'seq': record.seq, 'reviewId': review['id'], 'kind': kind, 'note': text(command.get('note'), 1600),
                 'createdAt': time.time(), 'source': 'user', 'backendRevision': snapshot.get('backendRevision', '')}
        if previous:
            entry['previous'] = {k: previous[k] for k in ('kind', 'note', 'createdAt')}
            current['calibrations'][current['calibrations'].index(previous)] = entry
        else:
            current['calibrations'] = [*current['calibrations'], entry][-96:]
    elif action == 'select':
        ids = rows(command.get('profileIds'), 3, 3)
        chosen = [next((p for p in current['profiles'] if p['id'] == ident), None) for ident in ids]
        if any(p is None for p in chosen):
            raise AimeinError('选择的档案不存在')
        reviewers = [{key: p['document'].get(key, '') for key in ('backendId', 'model', 'reasoningEffort')} | {'profileId': p['id']} for p in chosen]
        resolve_reviewers(reviewers, configs)
        state.policy.aimein_reviewers = reviewers
    else:
        raise AimeinError('未知档案操作')
    current['revision'] += 1
    return memory(current)


def feedback_anchor(state: Any, raw: dict) -> dict:
    if not isinstance(raw, dict) or raw.get('kind') not in ('goal', 'flow', 'infra', 'artifact', 'review'):
        raise AimeinError('建议来源无效')
    seq = raw.get('seq', 0)
    if type(seq) is not int:
        raise AimeinError('建议来源阶段无效')
    record = next((r for r in state.loops if r.seq == seq and r.aimein_run), None)
    if seq and not record:
        raise AimeinError('建议来源阶段不存在')
    review_id = raw.get('reviewId', '')
    if raw['kind'] == 'review' and (not record or review_id not in [r['id'] for r in record.aimein_run.get('reviews', [])]):
        raise AimeinError('建议来源评审不存在')
    return {'kind': raw['kind'], 'seq': seq, 'reviewId': review_id, 'goalRevision': digest(state.goal),
            'status': 'pending', 'history': []}


def feedback_plan(raw: Any, basis: list[dict], plan: dict) -> list[dict]:
    if not basis:
        return []
    ids = {b['id'] for b in basis}
    criteria = {c['id'] for c in plan['sprint']['criteria']}
    result = []
    for item in rows(raw, 40, len(ids)):
        if item.get('addonId') not in ids or item.get('disposition') not in ('planned', 'deferred'):
            raise AimeinError('意见处理必须覆盖冻结清单并说明纳入或延后')
        refs = rows(item.get('criteriaIds'), 24, 0)
        if any(i not in criteria for i in refs) or bool(refs) != (item['disposition'] == 'planned'):
            raise AimeinError('纳入的意见必须关联有效阶段条件；延后项不关联条件')
        result.append({'addonId': item['addonId'], 'disposition': item['disposition'], 'criteriaIds': refs,
                       'reason': text(item.get('reason'))})
    if len(result) != len(ids) or {r['addonId'] for r in result} != ids:
        raise AimeinError('意见处理清单重复或遗漏')
    return result


def apply_feedback(state: Any, record: Any, verified: set[str] | None = None) -> None:
    for item in record.aimein_run.get('feedbackPlan', []):
        addon = next((a for a in state.addons if a.id == item['addonId']), None)
        if not addon:
            continue
        status = 'deferred' if item['disposition'] == 'deferred' else 'planned' if verified is None else (
            'verified' if set(item['criteriaIds']) <= verified else 'needs_work')
        event = {**item, 'status': status, 'resultSeq': record.seq}
        history = addon.feedback.setdefault('history', [])
        if not history or history[-1] != event:
            kept = [*history, event][-6:]
            while len(kept) > 1 and len(json.dumps(kept, ensure_ascii=False).encode('utf-8')) > 24000:
                kept.pop(0)
            addon.feedback['history'] = kept
        addon.feedback.update(event)


def addon_in_scope(addon: Any, record: Any) -> bool:
    run = record.aimein_run
    if any(item['addonId'] == addon.id and item['disposition'] == 'deferred' for item in run.get('feedbackPlan', [])):
        return False
    return not getattr(addon, 'feedback', {}) or not run or addon.id in run.get('scopeAddonIds', [addon.id])


class AimeinLearningBridge:
    def _rpc_loopAimeinGet(self, session_id: str, task: str = '') -> str:
        state = self._loop_state(session_id)
        if not state or state.policy.execution_mode != 'aimein':
            return json.dumps({'status': 'error', 'message': '不是 AIMEIN 会话'}, ensure_ascii=False)
        raw = memory(state.aimein_memory)
        return json.dumps({'status': 'ok', 'memory': raw, 'recommendations': recommendations(raw, (task or state.goal)[:8000], self._backend_configs)}, ensure_ascii=False)

    def _rpc_loopAimeinUpdate(self, session_id: str, command_json: str) -> str:
        state = self._loop_state(session_id)
        try:
            if not state or state.policy.execution_mode != 'aimein':
                raise AimeinError('不是 AIMEIN 会话')
            if state.control_mode != 'loop' or self._loop_is_running(session_id) or self._loop_has_active_call(session_id):
                raise AimeinError('请等待当前执行及调用退出后再修改评委档案')
            if len(command_json) > 20_000:
                raise AimeinError('档案操作超过长度上限')
            command = json.loads(command_json)
            state.aimein_memory = update_memory(state, command, self._backend_configs)
            self._loop_save(state)
            self._emit_loop_updated(state)
            return json.dumps({'status': 'ok', 'revision': state.aimein_memory['revision']}, ensure_ascii=False)
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            return json.dumps({'status': 'error', 'message': str(exc)[:600]}, ensure_ascii=False)
