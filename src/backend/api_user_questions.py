"""应用管理的工具聊天问答；纯聊天和 text_only 不注入此工具。"""
from __future__ import annotations

import json
from typing import Any, Callable

from .user_interactions import UserInteractionRequest, normalize_questions

QUESTION_TOOL = {
    'name': 'awu_ask_user',
    'description': '向当前用户提出结构化问题。只收集信息，不能用答案授权 Kit、安装或跨工作区操作。返回 skipped/cancelled 时不要编造答案，不要用 shell 等待输入；需要答案则结束本轮等待下一轮回复。',
    'input_schema': {'type': 'object', 'additionalProperties': False, 'required': ['questions'], 'properties': {
        'questions': {'type': 'array', 'minItems': 1, 'maxItems': 10, 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['id', 'question'], 'properties': {
                'id': {'type': 'string'}, 'header': {'type': 'string'}, 'question': {'type': 'string'},
                'multiple': {'type': 'boolean'}, 'allowOther': {'type': 'boolean'}, 'required': {'type': 'boolean'},
                'options': {'type': 'array', 'maxItems': 30, 'items': {'type': 'object', 'additionalProperties': False,
                    'required': ['id', 'label'], 'properties': {'id': {'type': 'string'}, 'label': {'type': 'string'}, 'description': {'type': 'string'}}},
            }}}}}},
}


class ApiQuestionTool:
    def __init__(self, session_id: str, message_id: str, callback: Any, cancelled: Callable[[], bool]) -> None:
        self.session_id, self.message_id = session_id, message_id
        self.callback, self.cancelled = callback, cancelled

    async def execute(self, call_id: str, params: dict) -> str:
        questions = normalize_questions(params.get('questions'))
        if any(question['secret'] for question in questions):
            raise ValueError('此工具聊天通道不收集保密答案')
        request = UserInteractionRequest(self.session_id, self.message_id, call_id, questions=questions,
            title='Agent 需要你回答', cancelled=self.cancelled, skip_response={'status': 'skipped'},
            receipt_level='tool_result_ready')
        try:
            response = await self.callback(request)
            result = {'status': 'answered', 'answers': response['answers']} if response['kind'] == 'answers' else {
                'status': 'skipped' if response['kind'] == 'skipped' else 'cancelled'}
            await request.delivered(True)
            return json.dumps(result, ensure_ascii=False)
        except BaseException:
            await request.delivered(False)
            raise
