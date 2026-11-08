"""主 Session 和普通副本的有界 Git 提交图，只读取本执行节点。"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from .session_collaboration_store import CollaborationError, fingerprint
from .task_git import TaskGit


class GraphGit(TaskGit):
    def __init__(self, root: str, deadline: float) -> None:
        super().__init__(root)
        self.deadline = deadline

    def run(self, *args: str, **kwargs: Any) -> bytes:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise CollaborationError('分支图读取超时，请稍后刷新')
        return super().run(*args, **{**kwargs, 'timeout': min(10, remaining)})


def read_graph(entries: list[dict], limit: int) -> dict:
    deadline = time.monotonic() + 20
    branches: list[dict] = []
    main: dict[str, Any] = {}
    for entry in entries:
        branch = {key: entry[key] for key in ('sessionId', 'title', 'main')}
        try:
            if entry.get('error'):
                raise CollaborationError(entry['error'])
            git = GraphGit(entry['root'], deadline)
            actual = git.repository()
            expected = entry.get('authority')
            if expected and any(actual[key] != expected[key] for key in ('root', 'gitDir', 'commonDir', 'repositoryId', 'branch')):
                raise CollaborationError('副本目录或 Git 分支与登记不符')
            if main and actual['repositoryId'] != main['repositoryId']:
                raise CollaborationError('副本不属于主 Session 的真实仓库')
            if entry['main']:
                main = actual
            counts = git.run('rev-list', '--left-right', '--count', main['head'] + '...' + actual['head']).decode().split()
            branch.update(state='known', head=actual['head'], branch=actual['branch'],
                          behind=int(counts[0]), ahead=int(counts[1]),
                          dirty=bool(git.run('status', '--porcelain=v1', '-z', '--untracked-files=normal')))
        except (ValueError, OSError, RuntimeError) as error:
            if entry['main']:
                raise
            branch.update(state='unknown', notice=str(error)[:300])
        branches.append(branch)
    tips = list(dict.fromkeys(row['head'] for row in branches if row['state'] == 'known'))
    git = GraphGit(entries[0]['root'], deadline)
    raw = git.run('log', '--topo-order', f'-n{limit + 1}',
                  '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00', *tips, '--')
    commits = []
    for block in raw.split(b'\x00\n'):
        if not block: continue
        fields = block.split(b'\x00')
        if len(fields) != 5:
            raise CollaborationError('Git 提交记录格式不可读取')
        sha, parents, author, date, message = [field.decode('utf-8', errors='replace') for field in fields]
        commits.append({'hash': sha, 'parents': parents.split(), 'author': author[:160],
                        'date': date, 'message': message[:500]})
    # 分支在读取过程中推进时丢弃混合快照，不能用旧曲线表示新 HEAD。
    for entry, row in zip(entries, branches):
        if row['state'] != 'known': continue
        repo = GraphGit(entry['root'], deadline)
        actual = repo.run('rev-parse', 'HEAD').decode().strip()
        branch = repo.run('symbolic-ref', '--quiet', '--short', 'HEAD', allowed=(0, 1)).decode('utf-8').strip()
        if actual != row['head'] or branch != row['branch']:
            raise CollaborationError('读取期间分支已推进，请刷新分支图')
    return {'version': 1, 'snapshot': fingerprint([[row.get('head'), row['sessionId']] for row in branches]),
            'checkedAt': time.time(), 'branches': branches, 'commits': commits[:limit],
            'hasMore': len(commits) > limit, 'limit': limit, 'root': main['root'], 'repositoryId': main['repositoryId']}


class ProjectBranchGraph:
    async def _rpc_projectBranchGraph(self, session_id: str, limit: int = 80) -> str:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise CollaborationError('提交图范围须为 1–200 条')
        scope = self._collaboration_scope(session_id)
        parent_id = self._task_root_id(session_id)
        parent = self._task_source(parent_id)
        candidates = [row for row in self._session_store.list()
                      if row.get('ownerId', 'local') == scope.owner and row.get('parentSessionId') == parent_id
                      and row.get('relationKind') == 'task']
        candidates.sort(key=lambda row: (row['id'] != session_id, row['id']))
        entries = []
        for sid in [parent.id, *[row['id'] for row in candidates[:15]]]:
            source = self._collaboration_session(sid)
            entry = {'sessionId': sid, 'title': source.title, 'root': source.working_dir, 'main': sid == parent_id}
            try:
                self._task_source(sid)
                entry['authority'] = self._task_git_authority(sid)
            except (ValueError, OSError, RuntimeError) as error:
                if entry['main']: raise
                entry['error'] = str(error)[:300]
            entries.append(entry)
        value = await asyncio.to_thread(read_graph, entries, limit)
        if self._collaboration_scope(session_id) != scope or self._task_root_id(session_id) != parent_id:
            raise CollaborationError('读取期间执行身份或主 Session 已变化')
        for entry in entries:
            source = self._collaboration_session(entry['sessionId'])
            if source.working_dir != entry['root'] or (source.parent_session_id if not entry['main'] else source.id) != parent_id:
                raise CollaborationError('读取期间 Session 工作区已变化')
        return json.dumps({**value, 'omittedBranches': max(0, len(candidates) - 15)}, ensure_ascii=False)
