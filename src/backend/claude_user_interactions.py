"""Claude AskUserQuestion 的 updatedInput 契约（SDK 与 CLI 共用）。"""
from __future__ import annotations

from typing import Any, Callable

from .user_interactions import UserInteractionRequest, normalize_questions


async def claude_question_input(tool_input: dict, tool_id: str, *, session_id: str, message_id: str,
                                callback: Any, cancelled: Callable[[], bool], deliver: Any = None) -> dict | None:
    raw = tool_input.get('questions')
    if not isinstance(raw, list) or not 1 <= len(raw) <= 4:
        raise ValueError('Claude 问题数量必须为 1–4')
    texts = [q.get('question') for q in raw if isinstance(q, dict)]
    if len(texts) != len(raw) or any(not isinstance(text, str) for text in texts) or len(set(texts)) != len(texts):
        raise ValueError('Claude 问题正文必须完整且唯一')
    questions = [{**q, 'id': f'q{index + 1}', 'allowOther': True} for index, q in enumerate(raw)]
    normalize_questions(questions)
    if callback is None:
        return None
    request = UserInteractionRequest(session_id, message_id, tool_id, questions=questions,
        title='Claude 需要你回答', cancelled=cancelled, receipt_level='transport_write' if deliver else 'callback_return')
    try:
        decision = await callback(request)
        updated = None
        if decision.get('kind') == 'answers':
            # CLI 2.1.85 的输出 schema 明确为 question text -> string，多选用逗号分隔。
            updated = {**tool_input, 'answers': {q['question']: ', '.join(decision['answers'][q['id']]) for q in questions}}
        if deliver:
            await deliver(updated)
        await request.delivered(True)
        return updated
    except BaseException:
        await request.delivered(False)
        raise
