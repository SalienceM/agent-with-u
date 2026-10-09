"""Workspace-only revision checks for task observations, not a native sandbox probe."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

from .loop_task_blockers import ContractError, refs, text


def local_path(workspace: str, value: str) -> Path:
    root = Path(workspace).resolve(strict=True)
    candidate = Path(value)
    candidate = candidate if candidate.is_absolute() else root / candidate
    resolved = candidate.resolve(strict=True)
    # 禁止工作区根、外部路径、逃逸链接/别名；不读取真实用户目录。
    if resolved == root or not resolved.is_relative_to(root):
        raise ContractError('测试证据/数据根不在独立工作区子目录')
    return resolved


def file_revisions(workspace: str, raw: Any) -> list[dict]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 16:
        raise ContractError('缺少有界文件修订')
    result = []
    for row in raw:
        if not isinstance(row, dict) or set(row) != {'path', 'sha256'}:
            raise ContractError('无效文件修订')
        name, expected = text(row['path'], 240), text(row['sha256'], 64)
        path = local_path(workspace, name)
        with path.open('rb') as handle:
            data = handle.read(32768)
        if len(data) >= 32768 or hashlib.sha256(data).hexdigest() != expected:
            raise ContractError('配置/核对证据过期或超限')
        result.append({'path': name, 'sha256': expected})
    return result


def isolation_receipts(raw: Any, plan: dict, identity: dict, step: dict, workspace: str) -> dict:
    """Accept bounded model observations only after a separate preparation call."""
    try:
        if not isinstance(raw, dict) or set(raw) != {'version', 'items'} or type(raw.get('version')) is not int or raw['version'] != 1:
            raise ContractError('隔离观察协议无效')
        if not plan.get('valid') or plan.get('identity') != identity or step.get('testWritesUserData'):
            raise ContractError('准备/测试未分离或执行身份改变')
        rows = raw.get('items')
        if not isinstance(rows, list) or not 1 <= len(rows) <= 50:
            raise ContractError('隔离观察数量无效')
        conditions = {p['id']: p for p in plan['preconditions']}
        result = {}
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'id', 'actualRoot', 'method', 'configRevision', 'evidenceRefs', 'files', 'baselineEvidenceRefs'}:
                raise ContractError('隔离观察字段无效')
            p = conditions.get(row['id'])
            if not p or row['id'] in step.get('preconditionIds', []) or row['id'] in result:
                raise ContractError('未知/重复前置或同次准备与消费')
            root = local_path(workspace, text(row['actualRoot']))
            declared = local_path(workspace, p['isolatedRoot'])
            if not root.is_dir() or root != declared:
                raise ContractError('实际路径与隔离根不一致')
            if text(row['method']) != p['verificationMethod'] or text(row['configRevision']) != p['configRevision']:
                raise ContractError('核对机制或配置修订改变')
            baseline = refs(row['baselineEvidenceRefs']) if p['baselineBasis'] else []
            result[p['id']] = {'id': p['id'], 'actualRoot': os.path.normcase(str(root)),
                'method': row['method'], 'configRevision': row['configRevision'], 'evidenceRefs': refs(row['evidenceRefs']),
                'files': file_revisions(workspace, row['files']), 'baselineEvidenceRefs': baseline,
                'identity': identity, 'planId': plan['planId'], 'preparedStep': step['index'],
                'access': 'workspace-write' if step['access'] == 'write' else 'read-only',
                'evidenceLevel': 'model_observation', 'revisionCheck': 'workspace_file_sha256'}
        return {'valid': True, 'items': result}
    except (ContractError, OSError, ValueError, TypeError, KeyError) as exc:
        return {'valid': False, 'items': {}, 'reason': str(exc)}


def isolation_gate(plan: dict, receipts: dict, identity: dict, step: dict, workspace: str) -> str:
    if not step.get('preconditionIds'):
        return '用户数据写测试缺少前置' if step.get('testWritesUserData') else ''
    try:
        conditions = {p['id']: p for p in plan['preconditions']}
        for key in step['preconditionIds']:
            receipt = receipts.get('items', {}).get(key, {}) if receipts.get('valid') else {}
            p = conditions[key]
            if (receipt.get('identity') != identity or receipt.get('planId') != plan['planId']
                    or receipt.get('preparedStep', step['index']) >= step['index']
                    or receipt.get('access') != ('read-only' if step['access'] == 'read' else 'workspace-write')
                    or receipt.get('configRevision') != p['configRevision']):
                raise ContractError('隔离前置未核实或访问策略/身份/修订不适用')
            if os.path.normcase(str(local_path(workspace, p['isolatedRoot']))) != receipt['actualRoot']:
                raise ContractError('实际数据根/别名已改变')
            file_revisions(workspace, receipt['files'])
        return ''
    except (ContractError, OSError, ValueError, KeyError, TypeError) as exc:
        return str(exc)


def resolve_observations(raw: Any, blockers: dict, identity: dict, workspace: str) -> tuple[dict, list[dict]]:
    """Independent reviewer + fresh workspace evidence, not model permission grants."""
    import copy
    if raw is None:
        return copy.deepcopy(blockers), []
    if not isinstance(raw, dict) or set(raw) != {'version', 'items'} or type(raw.get('version')) is not int or raw['version'] != 1:
        raise ContractError('无效阻塞解除协议')
    rows = raw.get('items')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 50:
        raise ContractError('无效阻塞解除数量')
    known = {b['id']: b for b in blockers.get('items', [])}
    resolved = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'id', 'result', 'reason', 'evidenceRefs', 'files'}:
            raise ContractError('解除字段不完整或含外部身份')
        b = known.get(row['id'])
        if not b or b.get('identity') != identity or row['result'] != 'resolved' or row['id'] in {r['id'] for r in resolved}:
            raise ContractError('旧身份/重复/豁免不能解除任务阻塞')
        files = file_revisions(workspace, row['files'])
        if not b.get('observedAt') or any(local_path(workspace, f['path']).stat().st_mtime <= b['observedAt'] for f in files):
            raise ContractError('不是阻塞之后的新增证据，不能解除')
        resolved.append({'id': b['id'], 'reason': text(row['reason']), 'evidenceRefs': refs(row['evidenceRefs']),
            'files': files, 'evidenceLevel': 'model_review', 'identity': identity, 'original': copy.deepcopy(b)})
    remaining = [b for b in blockers.get('items', []) if b['id'] not in {r['id'] for r in resolved}]
    return ({**blockers, 'items': remaining} if remaining else {}), resolved
