"""只从可见消息建立有界评议材料；工具、思考和历史授权不参与。"""
from __future__ import annotations

import copy
from typing import Any

from .session_collaboration_store import CollaborationError, fingerprint

CONTROL_PREFIXES = ('【当前 Session 的 Kit 调用工具】', '【AWU 应用操作工具】')
USER_BOUNDARY = '【用户本轮请求】'
MAX_MESSAGES = 20
MAX_CHARACTERS = 64_000


def visible_text(content: str) -> str:
    """仅拆已知首部控制封套；不把普通正文里的引用材料当成新指令。"""
    text = content.strip()
    for _ in range(8):
        if text.startswith('<user_request>'):
            text = text[len('<user_request>'):].strip()
            if text.endswith('</user_request>'):
                text = text[:-len('</user_request>')].rstrip()
        if not text.startswith(CONTROL_PREFIXES):
            break
        if USER_BOUNDARY not in text:
            return ''
        text = text.split(USER_BOUNDARY, 1)[1].strip()
    # 残留嵌套控制封套不能因达到上限而转为可见材料。
    return '' if text.startswith(CONTROL_PREFIXES) else text


def context_snapshot(session: Any, target_ids: list[str] | None = None) -> dict:
    messages = [m for m in session.messages if m.role in {'user', 'assistant'} and not m.streaming
                and isinstance(m.content, str) and visible_text(m.content)]
    assistants = {m.id for m in messages if m.role == 'assistant'}
    targets = list(dict.fromkeys(target_ids or ([m.id for m in messages if m.role == 'assistant'][-1:])))
    if not targets or len(targets) > MAX_MESSAGES or any(mid not in assistants for mid in targets):
        raise CollaborationError('请选择可见且已完成的助手回答')
    end = max(i for i, m in enumerate(messages) if m.id in targets)
    candidates = messages[:end + 1]
    selected = {m.id for m in candidates if m.id in targets}
    for m in reversed(candidates):
        if len(selected) >= MAX_MESSAGES:
            break
        selected.add(m.id)
    rows = [{'id': m.id, 'role': m.role, 'text': visible_text(m.content),
             'sourceRevision': fingerprint({'role': m.role, 'content': visible_text(m.content)})}
            for m in candidates if m.id in selected]
    count = sum(len(row['text']) for row in rows)
    if count > MAX_CHARACTERS:
        raise CollaborationError('评议材料超过 64000 字符，请缩小范围或明确选择摘要')
    body = {'sourceSessionId': session.id, 'targetMessageIds': targets, 'mode': 'visible',
            'messages': rows, 'characters': count, 'omittedMessageCount': len(candidates) - len(rows),
            'excluded': ['thinking', 'tools', 'control-envelopes', 'attachments', 'permissions']}
    body['fingerprint'] = fingerprint(body)
    return body


def opinion_reference(report: dict, claim_ids: list[str] | None = None) -> dict:
    if report.get('status') != 'done' or not report.get('id') or not report.get('revision'):
        raise CollaborationError('只能引用已完成的意见')
    claims = report.get('claims', [])
    if claim_ids:
        selected = set(claim_ids)
        claims = [item for item in claims if item.get('id') in selected]
        if len(claims) != len(selected):
            raise CollaborationError('意见要点已变化或不可用')
    result = {'reportId': report['id'], 'reportRevision': report['revision'],
              'roleId': report.get('roleId'), 'roleName': report.get('roleName', ''),
              'sourceSessionId': report.get('sourceSessionId'), 'snapshotId': report.get('snapshotId'),
              'summary': report.get('summary', ''), 'claims': copy.deepcopy(claims)}
    result['fingerprint'] = fingerprint(result)
    return result
