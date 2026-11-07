"""Codex app-server 原生输入请求；只写响应，不拥有 stdout reader。"""
from __future__ import annotations

import asyncio
from typing import Any, Callable

from .user_interactions import UserInteractionRequest, normalize_questions


async def answer_codex_question(conn: Any, request_id: Any, params: dict, *, session_id: str,
                                message_id: str, thread_id: str, turn_id: str,
                                callback: Any, cancelled: Callable[[], bool], emit: Any,
                                abort: Callable[[], None]) -> None:
    if params.get('threadId') != thread_id or params.get('turnId') != turn_id:
        await conn.respond(request_id, error={'code': -32602, 'message': '用户问题的原生运行身份不匹配'})
        return
    request = UserInteractionRequest(session_id, message_id, str(request_id), questions=params.get('questions'),
        native_thread_id=thread_id, native_turn_id=turn_id, title='Codex 需要你回答', cancelled=cancelled)
    try:
        normalize_questions(request.questions)
        if callback is None:
            raise ValueError('当前调用没有用户问答通道；请在普通下一轮回复。')
        decision = await callback(request)
        if decision.get('kind') == 'answers':
            await conn.respond(request_id, result={'answers': {key: {'answers': value}
                for key, value in decision['answers'].items()}})
        else:
            # 0.166.0 schema 无 skip/default；不能把取消包装成空答案成功。
            await conn.respond(request_id, error={'code': -32000, 'message': '用户未提供答案或请求已取消'})
        await request.delivered(True)
    except asyncio.CancelledError:
        await request.delivered(False)
        raise
    except Exception as exc:
        await request.delivered(False)
        emit('error', error=f'Codex 用户问答失败：{exc}')
        # 写入失败不重发同一答案；本次原生运行将由 owning loop 关闭。
        if request.acknowledge is None:
            await conn.respond(request_id, error={'code': -32602, 'message': str(exc)})
        else:
            abort()
