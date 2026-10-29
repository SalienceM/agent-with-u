"""AIMEIN contracts and bounded artifact observations; no model calls or writes."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time
from typing import Any

from .loop_decisions import digest, short


class AimeinError(ValueError):
    """An incomplete/invalid contract cannot authorize the next stage."""


def text(value: Any, limit: int = 1600) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise AimeinError('字段为空或超过长度限制')
    return value.strip()


def rows(value: Any, maximum: int = 40, minimum: int = 1) -> list:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise AimeinError('清单缺失或超过容量限制')
    return value


def percent(value: Any) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 100:
        raise AimeinError('成熟度必须是 0–100 的有限数值')
    return float(value)


def reviewer_settings(raw: Any) -> list[dict]:
    if not isinstance(raw, list):
        return []
    return [{key: short(item.get(key), 200).strip() for key in ('backendId', 'model', 'reasoningEffort', 'profileId')}
            for item in raw[:3] if isinstance(item, dict)]


def resolve_reviewers(raw: Any, configs: list) -> list[dict]:
    settings = reviewer_settings(raw)
    if not isinstance(raw, list) or not 1 <= len(raw) <= 3 or len(settings) != len(raw):
        raise AimeinError('请在评审设置中配置 1–3 位评委')
    result, identities = [], set()
    for index, item in enumerate(settings, 1):
        cfg = next((c for c in configs if c.id == item['backendId']), None)
        if cfg is None or getattr(cfg, 'enabled', True) is False:
            raise AimeinError(f'评审 {index} 的 Backend 不可用，请重新选择')
        kind = str(getattr(getattr(cfg, 'type', ''), 'value', getattr(cfg, 'type', '')))
        from .poe_api import is_poe_api_base_url
        if is_poe_api_base_url(getattr(cfg, 'base_url', '')):
            raise AimeinError('Poe 仅支持聊天，不能用于 AIMEIN 评审')
        model = item['model'] or getattr(cfg, 'model', '')
        if not model:
            raise AimeinError(f'评审 {index} 需要明确模型，不能使用未知的 Backend 默认')
        if kind not in ('codex-office', 'qwen-code-cli', 'deepseek-harness') and model != getattr(cfg, 'model', ''):
            raise AimeinError(f'评审 {index} 的 Backend 不支持模型覆盖，请使用其已配置模型')
        identity = model.strip().casefold()
        if identity in identities:
            raise AimeinError('启用的评委必须使用不同模型；不同账号或推理档位不算不同模型')
        identities.add(identity)
        result.append({**item, 'model': model.strip(), 'id': f'review{index}'})
    return result


def reviewer_revision(reviewers: list[dict], configs: list) -> str:
    """Only a digest is persisted; credentials and connection details stay private."""
    return digest([json.dumps(vars(next(c for c in configs if c.id == r['backendId'])),
                             sort_keys=True, default=str) for r in reviewers])


def normalize_plan(raw: Any) -> dict:
    try:
        targets, criteria = [], []
        for item in rows(raw['targets']):
            targets.append({'id': text(item['id'], 80), 'title': text(item['title'], 200),
                            'acceptance': text(item['acceptance']),
                            'dependsOn': [text(v, 80) for v in rows(item.get('dependsOn', []), 40, 0)]})
        ids = {t['id'] for t in targets}
        if len(ids) != len(targets):
            raise AimeinError('子目标编号重复')
        pending = {t['id']: set(t['dependsOn']) for t in targets}
        if any(not deps <= ids for deps in pending.values()):
            raise AimeinError('子目标依赖指向未知编号')
        while pending:
            ready = {key for key, deps in pending.items() if not deps}
            if not ready:
                raise AimeinError('子目标存在循环依赖')
            pending = {key: deps - ready for key, deps in pending.items() if key not in ready}
        sprint = raw['sprint']
        for item in rows(sprint['criteria'], 24):
            target = text(item['targetId'], 80)
            if target not in ids or item['lane'] not in ('flow', 'infra'):
                raise AimeinError('验收条件缺少有效子目标或建设方向')
            criteria.append({'id': text(item['id'], 80), 'targetId': target,
                             'lane': item['lane'], 'acceptance': text(item['acceptance'])})
        if len({c['id'] for c in criteria}) != len(criteria):
            raise AimeinError('阶段条件编号重复')
        result = {'targets': targets, 'sprint': {
            'title': text(sprint['title'], 200), 'outcome': text(sprint['outcome']),
            'maturityTarget': percent(sprint['maturityTarget']), 'maturityMeaning': text(sprint['maturityMeaning']),
            'flowBuild': text(sprint['flowBuild']), 'infra': text(sprint['infra']),
            'deferred': [text(v, 500) for v in rows(sprint.get('deferred', []), 20, 0)], 'criteria': criteria}}
        result['revision'] = digest(result)
        return result
    except (KeyError, TypeError, AttributeError) as exc:
        raise AimeinError('阶段计划字段不完整，请核对 targets / sprint 协议') from exc


def file_fingerprint(root: Path, relative: str) -> str:
    path = root / relative
    if Path(relative).is_absolute() or ':' in relative or not path.resolve().is_relative_to(root.resolve()):
        raise AimeinError('证据路径超出当前工作区')
    # 不沿符号链接或 junction 获取其他目录内容。
    for part in (path, *path.parents):
        if part == root:
            break
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise AimeinError('证据包含链接目录，无法确认固定版本')
    if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise AimeinError('证据文件不存在或超过 16 MiB 核对上限')
    before = path.stat()
    result = hashlib.sha256(path.read_bytes()).hexdigest()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise AimeinError('读取期间证据已变化')
    return result


def workspace_fingerprint(workspace: str) -> dict:
    """Git nonignored files; non-Git skips only known generated directories."""
    root = Path(workspace).resolve()
    if not root.is_dir():
        raise AimeinError('工作目录不可读取')
    started = time.monotonic()
    skipped = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', 'dist', 'build', 'target'}
    mode = 'workspace'
    try:
        try:
            check = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'],
                capture_output=True, timeout=5, check=False)
        except FileNotFoundError:
            check = None
        if check is not None and check.returncode == 0 and Path(os.fsdecode(check.stdout).strip()).resolve() == root:
            process = subprocess.run(['git', '-C', str(root), 'ls-files', '-co', '--exclude-standard', '-z'],
                capture_output=True, timeout=10, check=True)
            if len(process.stdout) > 4 * 1024 * 1024:
                raise AimeinError('工作区清单超限，无法固定评审版本')
            files = sorted({os.fsdecode(v) for v in process.stdout.split(b'\0') if v})
            mode = 'git-nonignored'
        else:
            files = []
            for base, dirs, names in os.walk(root):
                dirs[:] = [d for d in dirs if d not in skipped]
                for d in dirs:
                    path = Path(base) / d
                    if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
                        raise AimeinError('工作区有链接目录，无法完整固定评审版本')
                files.extend((Path(base) / name).relative_to(root).as_posix() for name in names)
                if len(files) > 12000 or time.monotonic() - started > 20:
                    raise AimeinError('工作区扫描超限，无法固定评审版本')
            files.sort()
        if len(files) > 12000:
            raise AimeinError('工作区超过 12000 个文件的核对上限')
        result, total = [], 0
        for relative in files:
            path = root / relative
            if not path.exists():
                result.append([relative, 'deleted'])
                continue
            total += path.stat().st_size
            if total > 128 * 1024 * 1024 or time.monotonic() - started > 20:
                raise AimeinError('工作区核对超过 128 MiB / 20 秒上限')
            result.append([relative, file_fingerprint(root, relative)])
        return {'digest': digest(result), 'files': len(result), 'coverage': mode}
    except (OSError, subprocess.SubprocessError) as exc:
        raise AimeinError('无法固定工作区版本：' + str(exc)[:300]) from exc


def normalize_review(raw: Any, plan: dict, workspace: str) -> dict:
    try:
        report: dict = {'maturity': percent(raw['maturity']), 'summary': text(raw['summary']),
                        'goalComplete': raw.get('goalComplete') is True, 'nextFocus': short(raw.get('nextFocus'), 1600)}
        for key, expected in (('criteria', plan['sprint']['criteria']), ('targets', plan['targets'])):
            observed, ids = [], {r['id'] for r in expected}
            for item in rows(raw[key], 40):
                identity = text(item['id'], 80)
                status = item['status']
                if identity not in ids or status not in ('verified', 'gap', 'unknown'):
                    raise AimeinError('评审条件或状态不匹配冻结计划')
                evidence = [text(v, 500) for v in rows(item.get('evidence', []), 8, 0)]
                hashes = {p: file_fingerprint(Path(workspace), p) for p in evidence}
                if status == 'verified' and not evidence:
                    raise AimeinError('通过条件缺少可核对的工作区证据')
                observed.append({'id': identity, 'status': status, 'reason': text(item['reason']),
                                 'evidence': evidence, 'fingerprints': hashes})
            if len(observed) != len(ids) or {i['id'] for i in observed} != ids:
                raise AimeinError('评审遗漏或重复条件')
            report[key] = observed
        if raw.get('verdict') not in ('pass', 'revise'):
            raise AimeinError('评审 verdict 必须为 pass 或 revise')
        report['passed'] = (raw['verdict'] == 'pass' and report['maturity'] >= plan['sprint']['maturityTarget']
                            and all(r['status'] == 'verified' for r in report['criteria']))
        report['goalComplete'] = report['goalComplete'] and report['passed'] and all(r['status'] == 'verified' for r in report['targets'])
        report['status'] = 'passed' if report['passed'] else 'changes_requested'
        return report
    except (KeyError, TypeError, AttributeError) as exc:
        raise AimeinError('评审字段不完整或格式不正确') from exc


def evidence_current(reviews: list[dict], workspace: str) -> bool:
    return all(file_fingerprint(Path(workspace), path) == fingerprint
        for review in reviews for key in ('criteria', 'targets') for item in review.get(key, [])
        for path, fingerprint in item.get('fingerprints', {}).items())


def review_count(run: dict) -> int:
    """旧记录仍要求三份报告；不能把丢失报告误当成减少席位。"""
    count = run.get('reviewerCount', 3)
    return count if type(count) is int and 1 <= count <= 3 else 0


def review_roster_complete(run: dict) -> bool:
    count = review_count(run)
    reviews = run.get('reviews', [])
    return bool(count and isinstance(reviews, list) and len(reviews) == count)


def progress_observation(run: dict, previous: list[dict]) -> dict:
    """同范围跨阶段累计；新编号、评分及无新证据的报告改写不产生进展。"""
    seen_conditions: set[str] = set()
    seen_targets: set[str] = set()
    seen_evidence: set[str] = set()
    count = 0
    observation: dict = {}
    for item in [*previous, run]:
        plan, reviews = item.get('plan', {}), item.get('reviews', [])
        targets = {t['id']: t for t in plan.get('targets', [])}
        conditions, verified_targets, evidence = set(), set(), set()
        if review_roster_complete(item) and all(r.get('status') in ('passed', 'changes_requested') for r in reviews):
            for key, expected in (('criteria', plan.get('sprint', {}).get('criteria', [])),
                                  ('targets', list(targets.values()))):
                for criterion in expected:
                    reports = [next((v for v in r.get(key, []) if v.get('id') == criterion['id']), {}) for r in reviews]
                    if not all(v.get('status') == 'verified' and v.get('fingerprints') for v in reports):
                        continue
                    if key == 'targets':
                        verified_targets.add(digest([criterion['id'], criterion['acceptance']]))
                    else:
                        # 阶段条件编号可变，完整子目标在同范围内冻结。
                        conditions.add(digest([criterion['targetId'], criterion['lane'], criterion['acceptance']]))
                        evidence.update(digest([path, fingerprint]) for v in reports
                                        for path, fingerprint in v['fingerprints'].items())
        new_targets = verified_targets - seen_targets
        new_conditions = conditions - seen_conditions
        new_evidence = evidence - seen_evidence
        advanced = bool(new_targets or new_conditions and new_evidence)
        count = 0 if advanced else count + 1
        observation = {'noProgress': count, 'advanced': advanced,
                       'newTargets': len(new_targets),
                       'newConditions': len(new_conditions) if new_evidence else 0}
        seen_conditions.update(conditions)
        seen_targets.update(verified_targets)
        seen_evidence.update(evidence)
    return observation


def run_summary(run: dict) -> dict:
    if not run:
        return {}
    plan = run.get('plan', {})
    sprint = plan.get('sprint', {})
    return {key: run.get(key) for key in ('version', 'sprintId', 'sprintNumber', 'attempt', 'status', 'accepted',
                                        'complete', 'message', 'noProgress', 'scopeChanged')} | {
        'reviewerCount': review_count(run), 'revision': digest(run), 'title': short(sprint.get('title'), 200), 'outcome': short(sprint.get('outcome'), 500),
        'maturityTarget': sprint.get('maturityTarget'), 'maturityMeaning': short(sprint.get('maturityMeaning'), 500),
        'flowBuild': short(sprint.get('flowBuild'), 800), 'infra': short(sprint.get('infra'), 800),
        'criteria': [{k: c[k] for k in ('id', 'lane', 'acceptance')} for c in sprint.get('criteria', [])],
        'reviews': [{**{key: r.get(key) for key in ('id', 'model', 'backendId', 'status', 'maturity', 'summary', 'error')},
                     'profileName': r.get('profile', {}).get('name'), 'profileRevision': r.get('profile', {}).get('revision'),
                     'attemptCount': len(r.get('attempts', []))}
                    for r in run.get('reviews', [])],
        'issues': run.get('issues', [])[:24], 'targetCount': len(plan.get('targets', [])),
        'artifact': run.get('artifact', {}), 'nextFocus': short(run.get('nextFocus'), 800)}


PLAN_PROMPT = '''你是 AIMEIN 的 StepSplitter 与 SprintAggregator。只读核实产品现状，拆出完整目标及依赖，
选择下一组可独立验收的功能流程与必要 Infra。Sprint 数量动态；成熟度仅描述本阶段范围，不是全局完成率。
文字标准必须与目标成熟度对应，保留既有能力；禁止为了通过缩小用户目标。
完整返回 JSON：{"aimeinPlan":{"targets":[{"id":"T1","title":"子目标","acceptance":"完整验收条件","dependsOn":[]}],
"sprint":{"title":"本阶段名称","outcome":"可用的产品结果","maturityTarget":40,"maturityMeaning":"40%在当前范围内具体代表什么",
"flowBuild":"需要建设的产品功能流程","infra":"所需基础设施；无新增时说明复用",
"deferred":["后续阶段的内容"],"criteria":[{"id":"C1","targetId":"T1","lane":"flow","acceptance":"本阶段可核实条件"}]}}}。
targets 最多40项，criteria 最多24项。已有目标图必须保留原编号与条件，除非用户修改了目标或补充。
只规划当前阶段，后续阶段不硬编码；不运行构建、测试或写文件。
'''

REVIEW_PROMPT = '''你是 AIMEIN 的独立评审。新会话只读核对当前工作区产物与已经产生的验证证据，不执行构建/测试/应用或写文件。
逐条评估冻结的阶段条件和整体目标；默认未核实，不能采信执行者的乐观总结。
成熟度表示当前 Sprint 范围的成熟程度。一般建议放 nextFocus，不以纯建议阻止通过。
请返回 JSON：{"aimeinReview":{"verdict":"pass或revise","maturity":40,"summary":"评审结论",
"criteria":[{"id":"C1","status":"verified或gap或unknown","reason":"依据/缺口","evidence":["工作区相对文件路径"]}],
"targets":[{"id":"T1","status":"verified或gap或unknown","reason":"整体目标条件的依据/缺口","evidence":[]}],
"goalComplete":false,"nextFocus":"剩余目标或后续建议"}}。
criteria 与 targets 必须逐项覆盖计划全部编号；verified 必须引用真实文件，路径不带行号且不得越出工作区。
证据存在不等于行为正确，请检查内容、环境与适用性。只有完整当前目标及必要验证均已成立才标 goalComplete。
'''
