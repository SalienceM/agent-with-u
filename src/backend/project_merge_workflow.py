"""合并工作流的只读关联与显示投影；不改变原写入归属或授予执行权限。"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from .session_collaboration_store import CollaborationError, CollaborationScope
from .task_git import TaskGit, canonical_path
from .project_branch_graph import GraphGit, ProjectBranchGraph


def compare_current_tips(source: dict, target: dict) -> dict:
    """只读比较当前提交；旧成功回执不代表分支仍然同步。"""
    if source['repositoryId'] != target['repositoryId']:
        raise CollaborationError('当前双方不属于同一仓库')
    deadline = time.monotonic() + 10
    counts = GraphGit(source['root'], deadline).run(
        'rev-list', '--left-right', '--count', source['head'] + '...' + target['head']).decode().split()
    for saved in (source, target):
        actual = GraphGit(saved['root'], deadline).repository()
        if any(actual[key] != saved[key] for key in ('root', 'gitDir', 'commonDir', 'repositoryId', 'head', 'branch')):
            raise CollaborationError('读取期间分支已变化，请刷新当前状态')
    return {'state': 'known', 'sourceHead': source['head'], 'targetHead': target['head'],
            'sourceAhead': int(counts[0]), 'targetAhead': int(counts[1])}


class ProjectMergeWorkflow(ProjectBranchGraph):
    def _merge_readable(self, session: str, operation: str) -> tuple[Any, dict]:
        scope = self._collaboration_scope(session)
        row = self._collaboration_store().read(scope, 'merge', operation)
        if not row or session not in {row.get('sourceSessionId'), row['source']['sessionId'],
                                     row['target']['sessionId'], (row.get('integration') or {}).get('sessionId')}:
            raise CollaborationError('当前会话没有关联的合并记录')
        for sid in {row['sourceSessionId'], row['source']['sessionId'], row['target']['sessionId']}:
            self._require_session_access(sid)
        return scope, row

    async def _rpc_projectMergeOperations(self, session: str, source: str = '', target: str = '',
                                          offset: int = 0, limit: int = 30) -> str:
        scope = self._collaboration_scope(session)
        for sid in (source, target):
            if sid: self._require_session_access(sid)
        result = await asyncio.to_thread(self._collaboration_store().merge_operations, scope, session,
                                         source=source, target=target, offset=offset, limit=limit)
        if self._collaboration_scope(session) != scope: raise CollaborationError('执行身份已变化')
        items = []
        for row in result['items']:
            try:
                for key in ('originSessionId', 'sourceSessionId', 'targetSessionId'):
                    self._require_session_access(row[key])
                row['displayTitle'] = (self._collaboration_session(row['sourceSessionId']).title + ' → '
                                       + self._collaboration_session(row['targetSessionId']).title)
            except (PermissionError, ValueError):
                continue
            items.append(row)
        return json.dumps({**result, 'version': 1, 'items': items}, ensure_ascii=False)

    async def _rpc_projectMergeInspect(self, session: str, operation: str) -> str:
        scope, row = self._merge_readable(session, operation)
        value = await self._merge_workflow_view(row)
        if row.get('integration'):
            value['repair'] = self._merge_repair_view(scope, value)
            if value['repair']['status'] in {'running', 'unknown'}:
                value['workflow']['canAutoVerify'] = False
        current_scope, current = self._merge_readable(session, operation)
        if scope != current_scope or current['revision'] != row['revision']:
            raise CollaborationError('读取期间合并已变化，请重新核对原操作')
        return json.dumps(value, ensure_ascii=False)

    async def _merge_workflow_view(self, row: dict) -> dict:
        row = dict(row)
        sides: dict[str, dict] = {}
        actuals: dict[str, dict] = {}
        diagnostics: list[dict] = []

        async def inspect_side(saved: dict) -> dict:
            session = self._collaboration_session(saved['sessionId'])
            if canonical_path(session.working_dir) != canonical_path(saved['root']):
                raise CollaborationError('Session 工作目录已变化')
            actual = await asyncio.to_thread(lambda: TaskGit(saved['root']).inspect())
            self._require_session_access(saved['sessionId'])
            if canonical_path(self._collaboration_session(saved['sessionId']).working_dir) != canonical_path(saved['root']):
                raise CollaborationError('读取期间 Session 工作目录已变化')
            return actual

        # 最多三个独立工作区并行读取；每个仍执行完整 Git/权限核对，不缓存验收结果。
        names = [side for side in ('source', 'target', 'integration') if row.get(side)]
        inspections = dict(zip(names, await asyncio.gather(
            *(inspect_side(row[side]) for side in names), return_exceptions=True)))
        for side in ('source', 'target', 'integration'):
            saved = row.get(side)
            if not saved: continue
            item = {'sessionId': saved['sessionId'], 'root': saved['root'], 'state': 'unknown',
                    'dirty': [], 'activity': [], 'fresh': None}
            try:
                actual = inspections[side]
                if isinstance(actual, BaseException): raise actual
                self._require_session_access(saved['sessionId'])
                if canonical_path(self._collaboration_session(saved['sessionId']).working_dir) != canonical_path(saved['root']):
                    raise CollaborationError('读取期间 Session 工作目录已变化')
                activity = self._project_activity(saved['root'])
                expected = saved.get('actual', {}) if side == 'integration' else saved
                fresh = actual['fingerprint'] == expected.get('fingerprint') if expected.get('fingerprint') else None
                dirty = [{**entry, 'index': entry['status'][0] not in {' ', '?'},
                          'worktree': entry['status'][1] not in {' ', '?'},
                          'untracked': entry['status'] == '??'} for entry in actual['dirty']]
                item.update(state='known', title=self._collaboration_session(saved['sessionId']).title,
                            dirty=dirty, activity=activity, fresh=fresh,
                            head=actual['head'], branch=actual['branch'], fingerprint=actual['fingerprint'])
                if side != 'integration' and all(actual[key] == saved.get(key) for key in ('repositoryId', 'branch')):
                    actuals[side] = actual
                if actual['dirty']:
                    diagnostics.append({'side': side, 'code': 'git_dirty', 'sessionId': saved['sessionId'],
                                        'root': saved['root'], 'paths': dirty, 'notice': '有 Git 未提交文件'})
                if side != 'integration' and not fresh and row['status'] != 'succeeded':
                    diagnostics.append({'side': side, 'code': 'changed', 'sessionId': saved['sessionId'],
                                        'root': saved['root'], 'notice': '提交、分支或工作树已变化，需要重新预览'})
                for entry in activity:
                    diagnostics.append({'side': side, 'code': entry.get('code', 'activity'),
                                        'sessionId': entry.get('sessionId', ''), 'root': entry.get('root', saved['root']),
                                        'paths': entry.get('paths', []), 'notice': entry['reason']})
            except (ValueError, OSError, PermissionError, RuntimeError) as error:
                # 权限错误不能带出目录/路径；普通失败保持未知，不能显示干净。
                permitted = True
                try: self._require_session_access(saved['sessionId'])
                except (ValueError, PermissionError): permitted = False
                item.update(root=saved['root'] if permitted else '', notice=str(error)[:300] if permitted else '详情无访问权限')
                if not permitted:
                    item['sessionId'] = ''
                    row[side] = {'sessionId': '', 'root': '', 'conflicts': []}
                diagnostics.append({'side': side, 'code': 'unknown', 'sessionId': saved['sessionId'] if permitted else '',
                                    'notice': item['notice']})
            sides[side] = item
        comparison: dict[str, Any] = {'state': 'unknown', 'notice': '当前分支状态尚未核对'}
        if row['status'] == 'succeeded' and all(side in actuals for side in ('source', 'target')):
            try:
                comparison = await asyncio.to_thread(compare_current_tips, actuals['source'], actuals['target'])
                for side in ('source', 'target'):
                    current = self._collaboration_session(row[side]['sessionId'])
                    if canonical_path(current.working_dir) != actuals[side]['root']:
                        raise CollaborationError('读取期间 Session 工作区已变化')
            except (ValueError, OSError, PermissionError, RuntimeError) as error:
                comparison = {'state': 'unknown', 'notice': '当前分支状态核对失败，请刷新'}
        candidate = row.get('candidate', '')
        integration = sides.get('integration', {})
        verified = (row['verification'].get('status') == 'git_verified' and bool(candidate)
                    and row['verification'].get('head') == candidate)
        if row['status'] != 'succeeded':
            verified = (verified and integration.get('head') == candidate and integration.get('fresh') is True
                        and not integration.get('dirty') and not integration.get('activity'))
        # 本期没有测试执行器。只接纳持久化的、带来源且绑定提交的执行证据，不解析聊天文字。
        tests = []
        evidence_rows = row.pop('testEvidence', [])
        if not integration.get('sessionId'): evidence_rows = []
        for evidence in (evidence_rows if isinstance(evidence_rows, list) else [])[:30]:
            if not isinstance(evidence, dict): continue
            required = ('candidate', 'name', 'logRef', 'finishedAt')
            if (not all(evidence.get(k) for k in required) or not all(isinstance(evidence[k], str) and len(evidence[k]) <= 1000 for k in required[:-1]) or type(evidence.get('exitCode')) is not int
                    or evidence.get('source') != 'executor' or not isinstance(evidence['finishedAt'], (int, float))):
                continue
            tests.append({key: evidence[key] for key in (*required, 'exitCode', 'source')})
        evidence_candidate = candidate if row['status'] == 'succeeded' else integration.get('head', '')
        evidence_fresh = row['status'] == 'succeeded' or integration.get('state') == 'known' and not integration.get('dirty') and not integration.get('activity')
        for test in tests:
            test['state'] = 'stale' if not evidence_fresh or test['candidate'] != evidence_candidate else 'passed' if test['exitCode'] == 0 else 'failed'
        tests_state = ('failed' if any(t['state'] == 'failed' for t in tests) else
                       'stale' if any(t['state'] == 'stale' for t in tests) else 'passed' if tests else 'unknown')
        return {**row, 'workflow': {'version': 1, 'checkedAt': time.time(), 'sides': sides,
                'diagnostics': diagnostics, 'gitVerified': bool(verified), 'comparison': comparison,
                'canAutoVerify': row['status'] in {'candidate', 'conflict'} and integration.get('state') == 'known'
                    and not integration.get('activity') and not integration.get('dirty'),
                'tests': {'state': tests_state, 'items': tests}}}

    def _merge_session_links(self, rows: list[dict]) -> list[dict]:
        """仅整合项做精确索引查询；无关联/缺权限的旧项保留原样供恢复。"""
        by_id = {row['id']: row for row in rows}
        scope = CollaborationScope(self._current_owner_id(), self._loop_environment_executor())
        result = []
        for meta in rows:
            value = dict(meta)
            if meta.get('relationKind') == 'integration' and meta.get('workspaceId'):
                try:
                    workspace = self._collaboration_store().read(scope, 'workspace', meta['workspaceId'])
                    row = self._collaboration_store().read(scope, 'merge', workspace['mergeOperationId']) if workspace and workspace.get('mergeOperationId') else None
                    if (row and (row.get('integration') or {}).get('sessionId') == meta['id']
                            and all(sid in by_id for sid in (row['sourceSessionId'], row['source']['sessionId'], row['target']['sessionId']))
                            and canonical_path(row['integration']['root']) == canonical_path(meta.get('workingDir', ''))):
                        value['mergeLink'] = {'operationId': row['id'], 'originSessionId': row['sourceSessionId'],
                            'sourceSessionId': row['source']['sessionId'], 'targetSessionId': row['target']['sessionId'],
                            'status': row['status'], 'createdAt': row.get('createdAt')}
                except (ValueError, OSError, KeyError, TypeError):
                    # 旧/缺失关联不阻断整个 Session 列表，也不隐藏待恢复空间。
                    pass
            result.append(value)
        return result
