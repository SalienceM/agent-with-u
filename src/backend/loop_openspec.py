"""OpenSpec 原任务驱动：只跟踪来源与 verify，不再要求模型重建任务图。"""
from __future__ import annotations

import re
from typing import Any

from .loop_decisions import bounded_object, digest


def user_intent(state: Any, record: Any = None) -> str:
    # 原始想法在前，当前目标/较新补充在后；新的明确安排可覆盖旧指令。
    return '\n'.join([*[idea.prompt for idea in state.ideas], state.goal,
                      *[a.text for a in state.addons if record is None or not getattr(a, 'feedback', {})
                        or not record.aimein_run or a.id in record.aimein_run.get('scopeAddonIds', [a.id])]])[-50_000:]


def requested(state: Any) -> bool:
    if state.task_source.get('binding'):
        return True
    selected = False
    # 仅识别用户明确的来源安排；否定文字不能解除已有绑定或来源保护。
    for clause in re.split(r'[\n。；;.!?，,]', user_intent(state)):
        for mention in re.finditer(r'openspec|/opsx[-: ]', clause, re.I):
            before, after = clause[:mention.start()][-80:], clause[mention.end():][:40]
            double_negative = re.search(
                r'(?:不要|不能|不可|不得|别|do not|don.t|never)\s*(?:跳过|忽略|禁用|skip|ignore|disable)\s*$', before, re.I)
            excluded = re.search(
                r'(?:(?:无需|不需要|不用)\s*(?:(?:使用|采用|启用)\s*)?'
                r'(?:[\w /-]{1,24}(?:、|或|和|及)\s*)*|'
                r'(?:不使用|不采用|不启用|不要(?:使用|采用|启用)?|禁用|跳过)\s*|'
                r'\b(?:without(?: using)?|no need (?:for|to use)|do not use|don.t use|skip)\s*)$', before, re.I)
            # 普通提及保持原行为；同一意图中更新的明确提及覆盖前一项。
            selected = bool(double_negative) or not bool(excluded or re.match(
                r'\s*(?:(?:来源|流程)\s*)?(?:不需要|无需|不用|不使用|is not required\b|is unnecessary\b)', after, re.I))
    return selected


def select_change(intent: str, candidates: list[dict], bound: str = '') -> str:
    names = [c['name'] for c in candidates]
    matches = [name for name in names if re.search(r'(?<![\w-])' + re.escape(name) + r'(?![\w-])', intent)]
    if len(matches) > 1:
        raise ValueError('目标提到多个 OpenSpec change，请在来源中选择一个：' + '、'.join(matches))
    explicit = re.findall(r'(?:openspec-(?:apply-change|verify-change)|opsx[: -](?:apply|verify))\s+([a-z0-9][a-z0-9-]*)', intent, re.I)
    if explicit and any(name not in names for name in explicit):
        raise ValueError('目标指定的 OpenSpec change 不在当前工作区。')
    if bound:
        if bound not in names:
            raise ValueError('原 OpenSpec change 已不存在或归档，不会自动切换来源。')
        if matches and matches[0] != bound:
            raise ValueError('当前目标与已选 OpenSpec change 不同，请选择要执行的来源。')
        return bound
    # 显式命令指定了不存在的名称时，不能采用另一个唯一候选。
    if matches:
        return matches[0]
    if len(names) == 1:
        return names[0]
    raise ValueError('请选择要继续的 OpenSpec change：' + ('、'.join(names[:20]) or '当前没有活动 change'))


def manual_policy(intent: str) -> bool:
    # 只接受明确用户排除语句；禁止从任务错误/Access denied 推断。
    words = r'(?:人工(?:验收|核验|测试|验证)|manual (?:acceptance|verification|testing))'
    skip = r'(?:跳过|忽略|不管|不做|无需|不需要|skip|ignore)'
    selected = False
    for clause in re.split(r'[\n。；;.!?]', intent):
        if not re.search(words, clause, re.I):
            continue
        if re.search(r'(?:不要|不能|不可|不许|不得|禁止|不再|别|do not|don.t|never)\s*' + skip, clause, re.I):
            selected = False
        elif re.search(skip + r'.{0,24}' + words + '|' + words + r'.{0,24}' + skip, clause, re.I):
            selected = True
        elif re.search(r'(?:恢复|需要|必须|执行|保留|include|require).{0,16}' + words, clause, re.I):
            selected = False
    return selected


def task_progress(snapshot: dict, skip_manual: bool) -> dict:
    tasks = snapshot.get('tasks', [])
    manual = [t['id'] for t in tasks if not t['done'] and skip_manual and
              re.search(r'^\s*(?:\d+(?:\.\d+)*\s+)?(?:人工(?:验收|核验|测试|验证)|manual (?:acceptance|verification|testing))', t['description'], re.I)]
    pending = [t['id'] for t in tasks if not t['done'] and t['id'] not in manual]
    return {'total': len(tasks), 'checked': sum(t['done'] for t in tasks),
            'pendingIds': pending, 'manualIds': manual, 'skipManual': skip_manual,
            'scopeDigest': snapshot.get('scopeDigest', ''), 'stateDigest': snapshot.get('stateDigest', '')}


def normalize_verify(raw: Any, manual_ids: list[str]) -> dict:
    raw = bounded_object(raw, 131_072)
    if raw.get('complete') is not True or not isinstance(raw.get('issues'), list) or len(raw['issues']) > 100:
        return {'valid': False, 'reason': 'verify 未返回完整结论；未判定通过。', 'issues': []}
    issues, seen = [], set()
    for row in raw['issues']:
        if not isinstance(row, dict):
            return {'valid': False, 'reason': 'verify 问题缺少有效说明。', 'issues': []}
        severity = str(row.get('severity', '')).lower()
        summary, evidence = row.get('summary'), row.get('evidence')
        if severity not in ('critical', 'warning', 'suggestion') or not isinstance(summary, str) or not summary.strip() or not isinstance(evidence, str) or not evidence.strip():
            return {'valid': False, 'reason': 'verify 问题缺少严重性或依据。', 'issues': []}
        task_ids = row.get('taskIds', [])
        if not isinstance(task_ids, list) or len(task_ids) > 100 or any(not isinstance(v, str) for v in task_ids):
            return {'valid': False, 'reason': 'verify 人工项定位无效。', 'issues': []}
        manual = row.get('kind') == 'manual' and bool(task_ids) and set(task_ids) <= set(manual_ids)
        # warning 默认需要修复；只有明确建议才不进入修复队列。
        fix = not manual and (severity == 'critical' or severity == 'warning' and row.get('requiresFix') is not False)
        key = digest([summary.strip(), evidence.strip()])[:24]
        if key in seen:
            continue
        seen.add(key)
        issues.append({'id': key, 'severity': severity, 'summary': summary[:2000], 'evidence': evidence[:2000],
                       'manual': manual, 'requiresFix': fix, 'taskIds': task_ids})
    return {'valid': True, 'issues': issues, 'remaining': sum(i['requiresFix'] for i in issues),
            'summary': str(raw.get('summary', ''))[:2000]}


def next_phase(progress: dict, previous: dict, intent_digest: str) -> str:
    if progress['pendingIds']:
        return 'apply'
    if (previous.get('phase') == 'verify' and previous.get('verify', {}).get('valid')
            and previous.get('verify', {}).get('remaining') and previous.get('intentDigest') == intent_digest
            and previous.get('progress', {}).get('scopeDigest') == progress['scopeDigest']):
        return 'repair'
    return 'verify'


def run_summary(run: dict) -> dict:
    if not run:
        return {}
    progress = run.get('progress', {})
    verification = run.get('verify', {})
    return {'version': 1, 'change': run.get('change', ''), 'phase': run.get('phase', ''),
            'status': run.get('status', ''), 'total': progress.get('total', 0),
            'checked': progress.get('checked', 0), 'pending': len(progress.get('pendingIds', [])),
            'manual': len(progress.get('manualIds', [])), 'fixes': verification.get('remaining', 0),
            'verified': verification.get('valid') is True, 'message': run.get('message', '')[:1200]}
