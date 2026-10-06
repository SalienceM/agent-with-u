"""Bounded child acceptance observations; never changes formal parent checkboxes."""
from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from .loop_decisions import bounded_object, digest, short
from .loop_task_source import SourceError, confined, read_bytes, normalized

RANK = {'pending': 0, 'blocked': 0, 'invalid': 0, 'implemented': 1, 'verified': 2}


MILESTONE_INSTRUCTIONS = '''
可选子里程碑协议（不得改变正式父任务分母）：prepare JSON 可附加
"milestonePlan":{"parents":[{"id":"1.1","description":"原任务完整验收条文"}],
"milestones":[{"id":"shell","parentId":"1.1","originRef":"1.1",
"acceptance":"原任务条文中可单独验收的条件原文","status":"pending",
"deliverable":"该条件对应的独立可验收结果"}]}。
绑定来源时 parents 以系统清单为准；通用模式需先清点真实父任务来源和原验收条件，不能发明新条件。
acceptance 必须是 originRef 所指原验收条文的一段原文；originRef 也可用本次来源工件路径。
没有合适的独立条件就不拆分；禁止登记查日志、改措辞、重复测试等活动量。
analysis 的 delivery.milestones 沿用计划 id，并返回 status、mappingConfirmed:true、
evidenceRefs:[{path:"工作区相对产物路径",fingerprint:"SHA256 文件内容",
command:"实际运行的有界验证命令（只记录不重跑）",result:"实际结果",environment:"适用环境身份"}]。
评审须实际核实原条件映射及文件/测试证据；未核实 mappingConfirmed 不得为 true。
子项只能 pending/implemented/verified/blocked/invalid；首次执行后发现的成果不是本轮新增信用。
子项全部 verified 也不等于父任务集成验收。重复/改名/别名/恢复历史高水位不得重复算进展。
'''


def validate_plan(raw: Any) -> dict:
    plan = bounded_object(raw)
    if not plan:
        return {}
    rows = plan.get('milestones')
    if not isinstance(rows, list) or len(rows) > 200:
        return {'version': 2, 'valid': False, 'issues': ['子项容量/协议无效'], 'milestones': []}
    valid = plan.get('valid', True) is True
    parents = plan.get('parents', [])
    parent_ids = {p.get('id') for p in parents if isinstance(p, dict) and isinstance(p.get('id'), str)} if isinstance(parents, list) else set()
    valid = valid and isinstance(parents, list) and len(parents) <= 100 and len(parent_ids) == len(parents)
    ids: set[str] = set()
    count: Counter = Counter()
    for row in rows:
        if not isinstance(row, dict):
            valid = False
            continue
        key, parent = row.get('id'), row.get('parentId')
        if (not isinstance(key, str) or not key or key in ids or len(key) > 120
                or not isinstance(parent, str) or not parent or len(parent) > 120 or parent not in parent_ids):
            valid = False
            continue
        ids.add(key)
        count[parent] += 1
        if (count[parent] > 20 or not isinstance(row.get('status'), str) or row['status'] not in RANK
                or any(not isinstance(row.get(k), str) or not row[k] or len(row[k]) > limit
                       for k, limit in (('originRef', 500), ('acceptanceDigest', 80), ('acceptance', 1800), ('scopeRevision', 120)))
                or type(row.get('registeredSeq')) is not int or row['registeredSeq'] < 1):
            valid = False
    plan['valid'] = valid
    if not valid:
        plan['issues'] = ['子项身份、容量或原条件引用未通过核对；不计新增信用。']
    return plan


def register_plan(raw: Any, parents: list[dict], scope: str, seq: int,
                  workspace: str, artifacts: dict | None = None) -> dict:
    if not raw:
        return {}
    if not isinstance(raw, dict) or not isinstance(raw.get('milestones'), list):
        return {'version': 2, 'valid': False, 'milestones': [], 'issues': ['里程碑协议无效']}
    rows = raw['milestones']
    if len(rows) > 200:
        return {'version': 2, 'valid': False, 'milestones': [], 'issues': ['子项超过 200 项容量']}
    if (not isinstance(parents, list) or len(parents) > 100 or any(not isinstance(p, dict)
            or not isinstance(p.get('id'), str) or not isinstance(p.get('description', p.get('title', '')), str) for p in parents)):
        return {'version': 2, 'valid': False, 'milestones': [], 'issues': ['父任务清单无效']}
    parent_map = {p['id']: p.get('description', p.get('title', '')) for p in parents}
    if len(parent_map) != len(parents):
        return {'version': 2, 'valid': False, 'milestones': [], 'issues': ['父任务编号重复']}
    root = Path(workspace).resolve()
    result, issues, seen_conditions = [], [], set()
    for item in rows:
        if not isinstance(item, dict):
            issues.append('子项格式无效')
            continue
        parent = short(item.get('parentId'), 120)
        origin = short(item.get('originRef'), 500)
        acceptance = normalized(short(item.get('acceptance'), 1800))
        original = parent_map.get(parent, '') if origin == parent else ''
        if origin in (artifacts or {}):
            try:
                original = read_bytes(root, origin).decode('utf-8-sig')
            except (SourceError, UnicodeError):
                pass
        if parent not in parent_map or len(acceptance) < 4 or acceptance not in normalized(original) or not item.get('deliverable'):
            issues.append(f'{short(item.get("id"), 120)}：缺少父任务/原验收条件映射或可验收结果')
            continue
        identity = digest([scope, parent, acceptance])
        if identity in seen_conditions:
            issues.append('同一验收条件的别名/重复拆分不获得信用')
            continue
        seen_conditions.add(identity)
        result.append({'id': short(item.get('id'), 120), 'parentId': parent, 'originRef': origin,
                       'acceptance': acceptance, 'acceptanceDigest': identity, 'scopeRevision': scope,
                       'deliverable': short(item.get('deliverable'), 600), 'registeredSeq': seq,
                       'status': item.get('status') if isinstance(item.get('status'), str) and item['status'] in RANK else 'pending',
                       'baseline': True, 'evidenceRefs': [], 'validity': 'unknown'})
    plan = validate_plan({'version': 2, 'valid': not issues, 'milestones': result,
                          'parents': [{'id': k, 'description': v[:2000]} for k, v in parent_map.items()],
                          'scopeRevision': scope, 'registeredSeq': seq, 'issues': issues})
    return plan


def verify_evidence(refs: Any, workspace: str, environment: str) -> tuple[list[dict], str]:
    if not isinstance(refs, list) or not refs or len(refs) > 20:
        return [], 'missing'
    clean = []
    import hashlib
    for ref in refs:
        if not isinstance(ref, dict):
            return clean, 'unknown'
        path = short(ref.get('path'), 500)
        expected = short(ref.get('fingerprint'), 64)
        env = short(ref.get('environment'), 120)
        if not path or Path(path).is_absolute() or not expected or not ref.get('result') or env != environment:
            return clean, 'environment' if env != environment else 'missing'
        try:
            actual = hashlib.sha256(read_bytes(Path(workspace).resolve(), path)).hexdigest()
        except SourceError:
            return clean, 'missing'
        clean.append({'path': path, 'fingerprint': expected, 'environment': env,
                      'command': short(ref.get('command'), 600), 'result': short(ref.get('result'), 1200)})
        if actual != expected:
            return clean, 'changed'
    return clean, 'current'


def inherit_plan(plan: dict, records: list, scope: str, seq: int, workspace: str, environment: str) -> dict:
    """Cumulative scope cap and evidence baseline survive planner omission/renaming."""
    plan = validate_plan(plan)
    current = {m['acceptanceDigest']: m for m in plan.get('milestones', [])} if plan.get('valid') else {}
    parents = {p['id']: p for p in plan.get('parents', [])}
    valid = plan.get('valid', True)
    historical: dict[str, dict] = {}
    reviewed: set[str] = set()
    for rec in records:
        if rec.progress_scope != scope or rec.seq == seq:
            continue
        registered = validate_plan(rec.milestone_plan)
        if not registered.get('valid'):
            continue
        for p in registered.get('parents', []):
            parents.setdefault(p['id'], p)
        # 登记即形成待验范围；缺失或无效评审不能使它在下一轮消失。
        for item in registered.get('milestones', []):
            historical.setdefault(item['acceptanceDigest'], item)
        review = rec.delivery.get('milestoneReview', {})
        # 子评审有效不足以证明整体报告可用（模式/来源/范围可能已核对失败）。
        if rec.delivery.get('valid') and review.get('valid'):
            for item in review.get('milestones', []):
                if item['acceptanceDigest'] in historical:
                    historical[item['acceptanceDigest']] = item
                    reviewed.add(item['acceptanceDigest'])
    for key, item in historical.items():
        refs, validity = verify_evidence(item.get('evidenceRefs'), workspace, environment)
        status = item['status']
        # 未评审的首次清点仍是基线而非新增成果；后续 review 会拒绝无证据的验收。
        # 已评审（含先前继承）的通过状态则必须按当前证据撤销有效性。
        if (key in reviewed or item.get('mappingConfirmed')) and status in ('implemented', 'verified') and (
                validity != 'current' or not item.get('mappingConfirmed')):
            status = 'invalid'
        # 原条件的新别名沿用旧身份和有效基线，不重新开始 pending 刷信用。
        current[key] = {**item, 'registeredSeq': seq, 'baseline': True, 'validity': validity,
                        'status': status, 'evidenceRefs': refs}
    if not current and not plan:
        return {}
    return validate_plan({'version': 2, 'valid': valid, 'milestones': list(current.values()),
                          'parents': list(parents.values()), 'scopeRevision': scope, 'registeredSeq': seq})


def review_milestones(raw: Any, plan: dict, workspace: str, environment: str) -> dict:
    """Execution-after discoveries have no pre-execution baseline, hence no credit."""
    plan = validate_plan(plan)
    known = {m.get('id') for m in plan.get('milestones', []) if isinstance(m, dict)}
    discoveries = [{'id': short(r.get('id'), 120), 'parentId': short(r.get('parentId'), 120),
                    'acceptance': short(r.get('acceptance'), 1800), 'baseline': True,
                    'status': 'unknown', 'reportedStatus': short(r.get('status'), 40), 'validity': 'unmapped',
                    'reason': '执行后发现：需下次规划核对原条件，不能计为本轮新增成果'}
                   for r in raw[:200] if isinstance(r, dict) and isinstance(r.get('id'), str) and r['id'] not in known] if isinstance(raw, list) else []
    if not plan:
        return {'version': 2, 'valid': not raw, 'milestones': [], 'credited': [],
                'discoveries': discoveries,
                'issues': ['执行后发现的子项仅作基线，不获得本轮信用'] if raw else []}
    reports = raw if isinstance(raw, list) and len(raw) <= 200 else []
    valid = plan.get('valid') is True and isinstance(raw, list) and len(raw) <= 200
    by_id = {r.get('id'): r for r in reports if isinstance(r, dict) and isinstance(r.get('id'), str)}
    valid = valid and len(by_id) == len(reports) and not (by_id.keys() - {m['id'] for m in plan['milestones']})
    reviewed = []
    for base in plan['milestones']:
        report = by_id.get(base['id'], base)
        evidence, validity = verify_evidence(report.get('evidenceRefs'), workspace, environment)
        mapped = report.get('mappingConfirmed') is True
        status = report.get('status') if isinstance(report.get('status'), str) and report['status'] in RANK else 'pending'
        if status in ('implemented', 'verified') and (not mapped or validity != 'current'):
            status = 'invalid'
        reviewed.append({**base, 'status': status, 'baselineStatus': base['status'], 'baseline': False,
                         'mappingConfirmed': mapped, 'validity': validity, 'evidenceRefs': evidence})
    return {'version': 2, 'valid': bool(valid), 'milestones': reviewed, 'discoveries': discoveries, 'issues': plan.get('issues', [])}


def milestone_progress(records: list) -> dict:
    high: dict[str, int] = {}
    credited, restored = [], []
    current = []
    for record in records:
        data = record.delivery.get('milestoneReview', {})
        plan = getattr(record, 'milestone_plan', {})
        credited, restored = [], []
        if not record.delivery.get('valid') or not data.get('valid') or not plan.get('valid'):
            continue
        current = data.get('milestones', [])
        for item in current:
            identity = item['acceptanceDigest']
            baseline = RANK.get(item.get('baselineStatus'), 0)
            prior = high.get(identity, baseline)
            rank = RANK.get(item['status'], 0) if item.get('validity') == 'current' and item.get('mappingConfirmed') else 0
            if rank > prior:
                credited.append(item['id'])
            elif rank > baseline and rank <= prior:
                restored.append(item['id'])
            high[identity] = max(prior, rank)
    return {'credited': credited, 'restored': restored, 'counts': dict(Counter(m['status'] for m in current)),
            'invalid': [m['id'] for m in current if m.get('validity') != 'current'],
            'basis': '评审核实的子条件推进；不是父任务完成率或机器正确性证明'}
