"""仅投影可见运行事实；不序列化工具全文、阶段原文或隐藏思维。"""
from __future__ import annotations

import time
from itertools import islice
from typing import Any


def _fields(value: Any, keys: tuple[str, ...]) -> dict:
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in keys:
        item = value.get(key)
        if isinstance(item, str):
            result[key] = item[:1200]
        elif item is None or isinstance(item, (bool, int, float)):
            result[key] = item
    return result


def runtime_evidence(session: Any = None, state: Any = None, *, running: bool | None = None) -> dict:
    result = {'status': 'ok', 'sampledAt': time.time(), 'source': 'current-session-state',
              'complete': True, 'running': running}
    if session is not None:
        result.update(sessionId=session.id, title=session.title,
                      workingDirectory=session.working_dir)
    if state is None:
        result['kind'] = 'normal'
        result['recentVisibleMessages'] = [
            {'role': message.role, 'text': (message.content or '')[:1600]}
            for message in (getattr(session, 'messages', []) or [])[-6:]
            if message.role in ('user', 'assistant')]
        return result
    result.update(kind='loop', round=state.round, stage=state.stage, goal=state.goal[:4000],
                  auto=state.auto, state=state.status, stopReason=state.stop_reason[:1600])
    result['ideas'] = [{'status': idea.status, 'prompt': idea.prompt[:1000]} for idea in state.ideas[-8:]]
    source = getattr(state, 'task_source', {})
    result['taskSource'] = {**_fields(source, ('status', 'reason', 'revision')),
                            'change': source.get('binding', {}).get('change')}
    result['startup'] = _fields(getattr(state, 'startup', {}), ('status', 'message'))
    result['progressGuard'] = _fields(getattr(state, 'progress_guard', {}), ('pause', 'reason', 'noProgressCount'))
    blockers = getattr(state, 'unresolved_blockers', {})
    rows = blockers.get('items', blockers.get('blockers', [])) if isinstance(blockers, dict) else []
    if isinstance(rows, dict):
        rows = list(islice(rows.values(), 20))
    result['blockers'] = [_fields(row, ('id', 'kind', 'scope', 'reason', 'reasonCode', 'message', 'status'))
                          for row in rows[:20] if isinstance(row, dict)]
    records = list(islice((record for record in reversed(state.loops) if record.round == state.round), 8))
    result['recentIterations'] = []
    result['openspec'] = None
    result['latestVerify'] = None
    for record in records:
        row = {'seq': record.seq, 'phase': record.sub_stage, 'completed': record.completed,
               'error': record.error[:1200], 'updatedAt': record.updated_at,
               'result': record.result[:1200],
               'steps': [{'index': step.index, 'description': step.desc[:500], 'status': step.status,
                          'startedAt': step.started_at, 'endedAt': step.ended_at}
                         for step in record.orchestration[:20]]}
        if record.analysis:
            row['assessment'] = {key: str(getattr(record.analysis, key, '') or '')[:1200]
                                 for key in ('verified', 'gaps', 'next_focus', 'notes')}
        result['recentIterations'].append(row)
        run = record.openspec_run
        if run and result['openspec'] is None:
            progress = run.get('progress', {})
            result['openspec'] = {**_fields(run, ('change', 'phase', 'status', 'message')),
                'seq': record.seq, 'updatedAt': record.updated_at,
                'progress': {**_fields(progress, ('total', 'checked', 'skipManual', 'scopeDigest', 'stateDigest')),
                             'pending': len(progress['pendingIds']) if 'pendingIds' in progress else None,
                             'manual': len(progress['manualIds']) if 'manualIds' in progress else None}}
        verify = run.get('verify')
        if verify and result['latestVerify'] is None:
            result['latestVerify'] = {**_fields(verify, ('valid', 'remaining', 'reason', 'summary')),
                'seq': record.seq, 'updatedAt': record.updated_at,
                'issues': [_fields(issue, ('id', 'severity', 'summary', 'evidence', 'manual', 'requiresFix'))
                           for issue in verify.get('issues', [])[:20]], 'modelAssessment': True}
    result['historyLimited'] = len(state.loops) > len(records)
    return result
