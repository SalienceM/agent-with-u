"""Bounded task contracts and dependency gates, never execution permissions.

Model observations are labelled as such. Identity is supplied by the owning call;
invalid or legacy mappings cannot establish independent work. No filesystem I/O.
"""
from __future__ import annotations

import copy
from typing import Any

from .loop_decisions import bounded_object, digest

MAX_TASKS = 100
MAX_BLOCKERS = 50


class ContractError(ValueError):
    pass


def text(value: Any, limit: int = 1200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ContractError('缺失或超限文本')
    return value.strip()


def ids(value: Any, *, nonempty: bool = False, limit: int = MAX_TASKS) -> list[str]:
    if not isinstance(value, list) or len(value) > limit or (nonempty and not value):
        raise ContractError('任务/证据列表缺失或超限')
    result = [text(v, 120) for v in value]
    if len(set(result)) != len(result):
        raise ContractError('重复编号')
    return result


def refs(value: Any) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 16:
        raise ContractError('缺失或超限证据引用')
    return [text(v, 240) for v in value]


def invalid(reason: str) -> dict:
    return {'version': 1, 'valid': False, 'reason': reason, 'items': []}


def task_graph(raw: Any) -> list[dict]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_TASKS:
        raise ContractError('缺少完整有界任务台账')
    result, seen = [], set()
    for row in raw:
        if not isinstance(row, dict):
            raise ContractError('无效任务')
        key = text(row.get('id'), 120)
        if key in seen:
            raise ContractError('任务编号重复')
        seen.add(key)
        deps = ids(row.get('dependsOn'))
        status = row.get('status', 'pending')
        if status not in ('pending', 'implemented', 'verified', 'blocked', 'manual'):
            raise ContractError('未知任务状态')
        evidence = text(row.get('evidence'), 1800) if status in ('implemented', 'verified') else ''
        result.append({'id': key, 'title': text(row.get('title'), 240), 'dependsOn': deps, 'status': status, 'evidence': evidence})
    graph = {r['id']: r['dependsOn'] for r in result}
    visited: set[str] = set()

    def visit(key: str, visiting: set[str]) -> None:
        if key not in graph or key in visiting:
            raise ContractError('缺失或循环依赖')
        if key in visited:
            return
        for dep in graph[key]:
            visit(dep, visiting | {key})
        visited.add(key)

    for key in graph:
        visit(key, set())
    return result


def shape(tasks: list[dict]) -> dict:
    return {r['id']: sorted(r['dependsOn']) for r in tasks}


def scope_shape(tasks: list[dict]) -> dict:
    return {r['id']: [r.get('title', ''), sorted(r['dependsOn'])] for r in tasks}


def freeze_plan(raw: Any, steps: list[dict], source: dict, identity: dict,
                previous: dict | None = None) -> dict:
    """Legacy absence is unknown, but a malformed new contract is not legacy."""
    if raw is None and not any(s.get('taskMappingValid') is False or s.get('taskIds') or s.get('dependsOn') or s.get('preconditionIds') or s.get('testWritesUserData') for s in steps):
        return {}
    try:
        if not isinstance(raw, dict) or set(raw) - {'version', 'tasks', 'preconditions'} or type(raw.get('version')) is not int or raw['version'] != 1:
            raise ContractError('不支持的任务计划协议')
        tasks = task_graph(raw.get('tasks'))
        graph = shape(tasks)
        if source.get('binding'):
            snapshot = source.get('snapshot', {})
            if source.get('status') != 'current' or set(graph) != {t['id'] for t in snapshot.get('tasks', [])}:
                raise ContractError('任务编号与正式来源冲突')
        if previous and (not previous.get('valid') or scope_shape(previous.get('tasks', [])) != scope_shape(tasks)):
            raise ContractError('未解决阻塞的任务编号或依赖漂移')
        preconditions = raw.get('preconditions', [])
        if not isinstance(preconditions, list) or len(preconditions) > 50:
            raise ContractError('前置超限')
        conditions = []
        for p in preconditions:
            if not isinstance(p, dict) or set(p) - {'id', 'affectedTaskIds', 'writeKind', 'isolatedRoot', 'verificationMethod', 'configRevision', 'evidenceRefs', 'baselineBasis'}:
                raise ContractError('未知前置字段/身份')
            affected = ids(p.get('affectedTaskIds'), nonempty=True)
            if not set(affected) <= graph.keys():
                raise ContractError('前置任务越界')
            conditions.append({'id': text(p.get('id'), 120), 'affectedTaskIds': affected,
                **{k: text(p.get(k)) for k in ('writeKind', 'isolatedRoot', 'verificationMethod', 'configRevision')},
                'evidenceRefs': refs(p.get('evidenceRefs')),
                'baselineBasis': text(p['baselineBasis']) if p.get('baselineBasis') else '', 'status': 'unverified'})
        by_id = {p['id']: p for p in conditions}
        if len(by_id) != len(conditions):
            raise ContractError('前置编号重复')
        mappings = []
        for step in steps:
            if step.get('taskMappingValid') is False:
                raise ContractError('步骤原始映射无效')
            task_ids = ids(step.get('taskIds'), nonempty=True)
            deps = ids(step.get('dependsOn'))
            pre_ids = ids(step.get('preconditionIds'))
            if not set(task_ids + deps) <= graph.keys() or not set(pre_ids) <= by_id.keys():
                raise ContractError('步骤任务/依赖/前置越界')
            expected = set().union(*(set(graph[k]) for k in task_ids)) - set(task_ids)
            if set(deps) != expected:
                raise ContractError('步骤依赖与冻结任务图不一致')
            writes_data = step.get('testWritesUserData', False)
            if type(writes_data) is not bool:
                raise ContractError('测试写入类型无效')
            if writes_data and (step.get('access') != 'write' or not pre_ids or
                    not set(task_ids) <= set().union(*(set(by_id[k]['affectedTaskIds']) for k in pre_ids))):
                raise ContractError('用户数据写测试缺少隔离前置')
            mappings.append({'index': step['index'], 'taskIds': task_ids, 'dependsOn': deps,
                'preconditionIds': pre_ids, 'testWritesUserData': writes_data, 'access': step.get('access', 'write')})
        result = {'version': 1, 'valid': True, 'tasks': tasks, 'steps': mappings, 'preconditions': conditions,
                  'identity': copy.deepcopy(identity), 'sourceKind': 'formal' if source.get('binding') else 'model_plan'}
        result['planId'] = digest(result)
        return result
    except (ContractError, KeyError, TypeError, RecursionError) as exc:
        return invalid(str(exc))


def normalize_blockers(raw: Any, plan: dict, identity: dict, *, boundary: str) -> dict:
    try:
        if not isinstance(raw, dict) or set(raw) != {'version', 'items'} or type(raw.get('version')) is not int or raw['version'] != 1:
            raise ContractError('不支持的 taskBlockers 协议/身份字段')
        if not plan.get('valid') or plan.get('identity') != identity:
            raise ContractError('阻塞范围或执行身份未确认')
        rows = raw.get('items')
        if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_BLOCKERS:
            raise ContractError('阻塞列表缺失或超限')
        known, seen, items = set(shape(plan['tasks'])), set(), []
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'id', 'affectedTaskIds', 'reasonCode', 'reason', 'evidenceRefs', 'resolution'}:
                raise ContractError('阻塞字段不完整或含模型身份')
            key = text(row.get('id'), 120)
            affected = ids(row.get('affectedTaskIds'), nonempty=True)
            if key in seen or not set(affected) <= known:
                raise ContractError('重复/越界阻塞编号')
            seen.add(key)
            items.append({'id': key, 'affectedTaskIds': affected, 'reasonCode': text(row.get('reasonCode'), 80),
                'reason': text(row.get('reason')), 'resolution': text(row.get('resolution')),
                'evidenceRefs': refs(row.get('evidenceRefs')), 'evidenceLevel': 'model_observation',
                'identity': copy.deepcopy(identity), 'planId': plan['planId'], 'boundary': boundary})
        return {'version': 1, 'valid': True, 'items': items}
    except (ContractError, KeyError, TypeError) as exc:
        return invalid(str(exc))


def merge_blockers(previous: dict, incoming: dict) -> dict:
    """Omission never clears a blocker; duplicate observations consume no new slots."""
    if previous and not previous.get('valid'):
        return copy.deepcopy(previous)
    if not incoming.get('valid'):
        return {**copy.deepcopy(incoming), 'items': copy.deepcopy(previous.get('items', []))}
    items = copy.deepcopy(previous.get('items', []))
    for item in incoming['items']:
        old = next((v for v in items if v['id'] == item['id']), None)
        if old:
            if old['identity'] != item['identity'] or set(old['affectedTaskIds']) != set(item['affectedTaskIds']):
                return invalid('同一阻塞身份/范围改变，旧问题保留待核对') | {'items': items}
        else:
            items.append(copy.deepcopy(item))
    if len(items) > MAX_BLOCKERS:
        return invalid('未解决阻塞容量耗尽') | {'items': items[:MAX_BLOCKERS]}
    return {'version': 1, 'valid': True, 'items': items}


def closure(tasks: list[dict], affected: set[str]) -> set[str]:
    frozen = set(affected)
    while True:
        expanded = frozen | {t['id'] for t in tasks if set(t['dependsOn']) & frozen}
        if expanded == frozen:
            return frozen
        frozen = expanded


def reduce_scope(plan: dict, blockers: dict, identity: dict, report: dict | None = None) -> dict:
    try:
        if not plan.get('valid') or plan.get('identity') != identity or (blockers and not blockers.get('valid')):
            raise ContractError('任务映射/阻塞身份未确认')
        tasks = task_graph((report or {}).get('items', plan['tasks']))
        if scope_shape(tasks) != scope_shape(plan['tasks']):
            raise ContractError('评审遗漏任务或改写依赖')
        if any(b.get('identity') != identity for b in blockers.get('items', [])):
            raise ContractError('历史阻塞身份/来源修订改变，需核对而不是丢弃')
        affected = set().union(*(set(b['affectedTaskIds']) for b in blockers.get('items', []))) if blockers.get('items') else set()
        if not affected <= shape(tasks).keys():
            raise ContractError('历史阻塞任务被遗漏')
        frozen = closure(tasks, affected)
        verified = {t['id'] for t in tasks if t['status'] == 'verified' and t['id'] not in frozen}
        ready = [t['id'] for t in tasks if t['id'] not in frozen and t['status'] in ('pending', 'implemented')
                 and set(t['dependsOn']) <= verified]
        return {'valid': True, 'affectedIds': sorted(frozen), 'readyIds': ready}
    except (ContractError, KeyError, TypeError, RecursionError) as exc:
        return {'valid': False, 'affectedIds': [], 'readyIds': [], 'reason': str(exc)}


def review_scope(raw: Any, report: dict, plan: dict, blockers: dict, identity: dict,
                 verified_preconditions: set[str] | None = None) -> dict:
    scope = reduce_scope(plan, blockers, identity, report)
    try:
        if not scope['valid'] or not report.get('valid') or not report.get('scopeComplete'):
            raise ContractError(scope.get('reason', '评审台账不完整'))
        if not isinstance(raw, dict) or set(raw) != {'version', 'confirmedBlockerIds', 'independentTaskIds', 'evidenceRefs'} or type(raw.get('version')) is not int or raw['version'] != 1:
            raise ContractError('缺少独立阻塞复核')
        if set(ids(raw['confirmedBlockerIds'])) != {b['id'] for b in blockers.get('items', [])}:
            raise ContractError('复核遗漏未解决阻塞')
        ready = ids(raw['independentTaskIds'])
        isolation_pending = {key for p in plan.get('preconditions', []) if p['id'] not in (verified_preconditions or set())
                             for key in p['affectedTaskIds']}
        isolation_pending = closure(plan['tasks'], isolation_pending)
        scope['readyIds'] = [key for key in scope['readyIds'] if key not in isolation_pending]
        if not set(ready) <= set(scope['readyIds']):
            raise ContractError('独立性与任务依赖冲突')
        scope.update(readyIds=ready, evidenceRefs=refs(raw['evidenceRefs']), evidenceLevel='model_review')
        return scope
    except (ContractError, KeyError, TypeError) as exc:
        return {'valid': False, 'affectedIds': scope['affectedIds'], 'readyIds': [], 'reason': str(exc)}


def protect_report(report: dict, plan: dict, blockers: dict, identity: dict) -> dict:
    result = copy.deepcopy(report)
    scope = reduce_scope(plan, blockers, identity, report)
    if not scope['valid']:
        result.update(valid=False, scopeComplete=False)
    for item in result.get('items', []):
        if item['id'] in scope['affectedIds']:
            item['status'] = 'blocked'
            item['evidence'] = ''  # 阻塞复述、虚假 verified 不能增加进展。
    result['blockers'] = result.get('blockers', []) + [
        {'id': b['id'], 'kind': 'local', 'affected': b['affectedTaskIds'], 'reason': b['reason'], 'resolution': b['resolution']}
        for b in blockers.get('items', []) if b['id'] not in {v['id'] for v in result.get('blockers', [])}]
    result['verification'] = {'status': 'blocked', 'evidence': '未解决的任务级前置/验收阻塞'}
    return result


def persisted(raw: Any) -> dict:
    """Bounded persistence preserves unknown/invalid instead of treating it as empty."""
    return bounded_object(raw, 262_144)


def stored_ids(raw: Any) -> list[str]:
    try:
        return ids(raw)
    except ContractError:
        return ['<invalid-task-mapping>']


def mapping_valid(raw: dict) -> bool:
    try:
        for key in ('taskIds', 'dependsOn', 'preconditionIds'):
            ids(raw.get(key, []))
        return raw.get('taskMappingValid', True) is True and type(raw.get('testWritesUserData', False)) is bool
    except ContractError:
        return False


PLAN_INSTRUCTIONS = """
【任务级冻结协议 v1】新计划在同一顶层 JSON 增加 taskPlan:{version:1,tasks:[
{id:"T",title:"稳定任务原义",dependsOn:[],status:"pending",evidence:""}],preconditions:[]}。
tasks 必须是完整稳定台账（最多100项）；正式来源必须逐项对应，不得换编号或删任务。
title 保持任务原义和稳定文本，评审 delivery.items 必须使用相同 title，不通过改写标题替换受阻任务。
每个 orchestration 步增加 taskIds、dependsOn（外部任务依赖）、preconditionIds 数组，以及
testWritesUserData 布尔值。依赖只引用真实任务；写测试必须 sequential/write。
会写用户数据的测试前置：{id,affectedTaskIds,writeKind,isolatedRoot,verificationMethod,
configRevision,evidenceRefs,baselineBasis}。初始未核实，独立的准备/路径核对步骤先返回，
后续测试调用才能消费 preconditionIds；同次调用不能自行宣布安全然后启动应用。
准备步骤本身不能消费该前置或启动应用。实际路径应在本工作区已授权独立测试根，核对链接/别名、
应用真实机制及配置修订；只有变量/目录名或 safe=true 不算证据。不知道隔离方式就报告任务阻塞。
准备结果可返回 isolationEvidence:{version:1,items:[{id,actualRoot,method,configRevision,
evidenceRefs,files:[{path,sha256}],baselineEvidenceRefs:[]}]}；files 是工作区内核对记录/配置的 SHA256。
这是有限模型观察和文件修订核对，不是操作系统隔离证明；不得伪造工具观察。
准备/实现步骤可返回 taskEvidence:[{id,status:"verified|implemented",evidence:"已核实的产物修订与结果"}]，
只报告本步 taskIds。依赖尚未 verified 时不得调度依赖任务，正常调用结束不等于依赖已验收。
"""

BLOCKER_INSTRUCTIONS = """
【局部任务阻塞】单项检查不可用但没有全局安全/授权问题时，在同一顶层 JSON 返回：
"taskBlockers":{"version":1,"items":[{"id":"稳定问题编号","affectedTaskIds":["T"],
"reasonCode":"check_unavailable","reason":"实际失败及已执行情况，不猜测沙箱/ACL根因",
"evidenceRefs":["本步输出或产物定位"],"resolution":"解除该项所需条件"}]}。
不提供用户/节点/Session/权限身份，不把此信号作为授权。停止本次剩余操作，由系统只读复核并重规划。
显式 loopControl.pause=true 仍是硬暂停，不能同时请求暂停又用 local 绕过。
保护用户数据不等于默认读取真实存档；仅用户/项目规则/正式规格明确要求时建立真实基线并保留依据。
必要基线不可读则相关验收受阻，不伪造、不豁免；不得换宿主/节点/通道、改ACL或复制被拒资源重试。
"""

REVIEW_INSTRUCTIONS = """
【一次独立只读阻塞复核】本次 execution_access=read-only。只核对当前授权内已有文件和步骤证据、
冻结任务图及未解决阻塞，不修改文件、不运行应用/构建/测试、不探测已被拒资源，不恢复权限。
固定原生环境检查通过不代表测试隔离或写策略可用。此评审不能解除原生安全/授权门槛。
返回完整 delivery 台账及 blockerReview:{version:1,confirmedBlockerIds:["阻塞编号"],
independentTaskIds:["经证据确认独立且就绪的任务"],evidenceRefs:["依赖与独立性证据"]}。
受阻任务及传递依赖保持未验收。不能重写编号、遗漏阻塞或通过高分宣告完成。
只有核实新增、适用且确实满足原解除条件的证据时，可返回 blockerResolutions:{version:1,items:[
{id:"阻塞编号",result:"resolved",reason:"原解除条件如何满足，不能用豁免代替",evidenceRefs:["证据定位"],
files:[{path:"工作区内新核对记录",sha256:"内容SHA256"}]}]}。不能凭用户一句继续、重命名、旧证据
或较弱的模型意见解除原生环境/授权门槛；合法访问恢复仍必须遵守原生策略。未知则不解除。
"""
