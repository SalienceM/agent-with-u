"""原生问答与执行审批：完整请求身份、单次答案和可见跳过状态。"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import inspect
import time
from typing import Any, Callable

from .session_collaboration_store import CollaborationError, CollaborationScope, CollaborationStore, fingerprint


def normalize_questions(raw: Any) -> list[dict]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 10:
        raise CollaborationError('问题数量必须为 1–10')
    result, ids = [], set()
    for index, row in enumerate(raw):
        if not isinstance(row, dict):
            raise CollaborationError('问题格式无效')
        qid = row.get('id', f'q{index + 1}')
        question = row.get('question')
        if not isinstance(qid, str) or not qid or len(qid) > 200 or qid in ids:
            raise CollaborationError('问题 ID 缺失或重复')
        if not isinstance(question, str) or not question.strip() or len(question) > 8000:
            raise CollaborationError('问题正文无效或超限')
        ids.add(qid)
        options = row.get('options') or []
        if not isinstance(options, list) or len(options) > 30:
            raise CollaborationError('问题选项过多或无效')
        choices, seen = [], set()
        for option in options:
            if not isinstance(option, dict):
                raise CollaborationError('问题选项无效')
            label = option.get('label')
            value = option.get('id', label)
            if not isinstance(label, str) or not label or len(label) > 500 or not isinstance(value, str) or not value or value in seen:
                raise CollaborationError('问题选项缺失或重复')
            description = option.get('description', '')
            if not isinstance(description, str) or len(description) > 2000:
                raise CollaborationError('问题选项说明无效')
            seen.add(value)
            choices.append({'id': value, 'label': label, 'description': description})
        result.append({'id': qid, 'question': question, 'header': str(row.get('header') or '')[:100],
                       'options': choices, 'multiple': row.get('multiSelect') is True or row.get('multiple') is True,
                       'allowOther': not choices or row.get('isOther') is True or row.get('allowOther') is True,
                       'secret': row.get('isSecret') is True or row.get('secret') is True,
                       'required': row.get('required', True) is not False})
    return result


@dataclass
class UserInteractionRequest:
    session_id: str
    message_id: str
    native_request_id: str
    questions: list[dict] = field(default_factory=list)
    kind: str = 'question'
    native_turn_id: str = ''
    native_thread_id: str = ''
    title: str = ''
    detail: str = ''
    # 仅适配器构造，不接受 UI/模型传入的批准或 skip 能力。
    skip_response: dict | None = None
    timeout: float = 300
    cancelled: Callable[[], bool] = field(default=lambda: False, repr=False)
    acknowledge: Any = field(default=None, repr=False)
    receipt_level: str = 'transport_write'

    async def delivered(self, success: bool) -> None:
        if self.acknowledge:
            result = self.acknowledge(success)
            if inspect.isawaitable(result):
                await result


class UserInteractionRegistry:
    def __init__(self, store: CollaborationStore, emit: Callable[[dict], None]) -> None:
        self.store, self.emit = store, emit
        self.pending: dict[str, dict] = {}
        self.registering: set[str] = set()
        self.delivering: set[str] = set()

    async def ask(self, scope: CollaborationScope, request: UserInteractionRequest, *, skip: bool = False) -> dict:
        if request.kind not in {'question', 'approval'}:
            raise CollaborationError('独立产品操作必须使用原确认渠道')
        questions = normalize_questions(request.questions) if request.kind == 'question' else []
        if not request.native_request_id or not request.session_id or not request.message_id:
            raise CollaborationError('交互缺少原生关联')
        key = fingerprint([scope.owner, scope.executor, request.session_id, request.message_id,
                           request.native_thread_id, request.native_turn_id, request.native_request_id])
        old = await asyncio.to_thread(self.store.read, scope, 'interaction', key)
        if old:
            raise CollaborationError('原生交互已登记，不自动重放')
        future = asyncio.get_running_loop().create_future()
        can_skip = request.kind == 'approval' or request.skip_response is not None
        body = {'sessionId': request.session_id, 'messageId': request.message_id, 'kind': request.kind,
                'nativeRequestId': request.native_request_id, 'nativeTurnId': request.native_turn_id,
                'nativeThreadId': request.native_thread_id, 'title': request.title[:500], 'detail': request.detail[:16000],
                'questions': questions, 'status': 'pending', 'deadline': time.time() + min(600, max(1, request.timeout)),
                'canSkip': can_skip, 'skipRequested': skip,
                'notice': '此问题仍需回答：原生协议没有已验证的跳过方式' if skip and not can_skip else ''}
        self.registering.add(key)
        try:
            row = await asyncio.to_thread(self.store.write, scope, 'interaction', key, body, 0)
            entry = {'scope': scope, 'request': request, 'row': row, 'future': future, 'response': None,
                     'lock': asyncio.Lock()}
            self.pending[key] = entry
        finally:
            self.registering.discard(key)
        self.emit(row)

        async def ack(success: bool) -> None:
            async with entry['lock']:
                if entry['row']['status'] == 'responding':
                    await self._transition(entry, 'unknown' if not success else 'cancelled'
                                           if entry.get('response', {}).get('kind') == 'cancelled' else
                                           'auto_handled' if entry.get('automatic') else 'answered',
                                           receiptLevel=request.receipt_level if success else 'unknown')
                self.delivering.discard(key)
        request.acknowledge = ack
        try:
            if skip and can_skip:
                entry['automatic'] = True
                decision = {'kind': 'approved', 'approved': True} if request.kind == 'approval' else {'kind': 'skipped'}
                await self._accept(entry, decision)
            while not future.done():
                remaining = entry['row']['deadline'] - time.time()
                if request.cancelled() or remaining <= 0:
                    async with entry['lock']:
                        if not future.done():
                            await self._transition(entry, 'cancelled' if request.cancelled() else 'expired')
                            future.set_result({'kind': 'cancelled', 'reason': entry['row']['status']})
                    break
                try:
                    await asyncio.wait_for(asyncio.shield(future), min(.2, remaining))
                except asyncio.TimeoutError:
                    pass
            self.delivering.add(key)
            return future.result()
        except asyncio.CancelledError:
            async def settle() -> None:
                async with entry['lock']:
                    if entry['row']['status'] in {'pending', 'responding'}:
                        await self._transition(entry, 'unknown' if entry['response'] else 'cancelled')
            await asyncio.shield(settle())
            raise
        finally:
            # 回传确认 closure 仍拥有记录；收到答案后也不接受第二份响应。
            self.pending.pop(key, None)
            if not future.done():
                future.cancel()

    async def _transition(self, entry: dict, status: str, **extra: Any) -> None:
        row = entry['row']
        next_row = await asyncio.to_thread(self.store.write, entry['scope'], 'interaction', row['id'],
                                          {**row, **extra, 'status': status}, row['revision'])
        entry['row'] = next_row
        self.emit(next_row)

    @staticmethod
    def _validate(entry: dict, response: dict) -> dict:
        row = entry['row']
        if response.get('kind') == 'cancelled':
            return {'kind': 'cancelled'}
        if row['kind'] == 'approval':
            if response.get('kind') != 'approved' or type(response.get('approved')) is not bool:
                raise CollaborationError('审批响应必须为明确的允许或拒绝')
            return {'kind': 'approved', 'approved': response['approved']}
        if response.get('kind') == 'skipped':
            if entry['request'].skip_response is None:
                raise CollaborationError('原生问题不能跳过')
            return {'kind': 'skipped'}
        answers = response.get('answers')
        if response.get('kind') != 'answers' or not isinstance(answers, dict):
            raise CollaborationError('请填写问题答案')
        if set(answers) - {q['id'] for q in row['questions']}:
            raise CollaborationError('响应包含未知问题')
        clean = {}
        for q in row['questions']:
            values = answers.get(q['id'], [])
            if not isinstance(values, list) or len(values) > 30 or any(not isinstance(v, str) or not v.strip() or len(v) > 8000 for v in values):
                raise CollaborationError('问题答案格式无效或超限')
            if q['required'] and not values:
                raise CollaborationError(f'请回答：{q["header"] or q["question"][:60]}')
            if not q['multiple'] and len(values) > 1:
                raise CollaborationError('此问题只允许一个答案')
            if not q['allowOther'] and any(v not in {o['id'] for o in q['options']} for v in values):
                raise CollaborationError('请选择有效选项')
            clean[q['id']] = list(dict.fromkeys(values))
        return {'kind': 'answers', 'answers': clean}

    async def _accept(self, entry: dict, response: dict) -> dict:
        async with entry['lock']:
            decision = self._validate(entry, response)
            if entry['response'] is not None:
                if decision != entry['response']:
                    raise CollaborationError('此问题已由另一份答案响应')
                return entry['row']
            if entry['row']['status'] != 'pending':
                raise CollaborationError('原生问题已结束')
            if entry['request'].cancelled() or time.time() >= entry['row']['deadline']:
                raise CollaborationError('原生问题已取消或过期')
            # 不把密码类答案写入普通 sidecar；只存有限的非秘密答案和决定摘要。
            saved = {key: value for key, value in decision.get('answers', {}).items()
                     if not next(q for q in entry['row']['questions'] if q['id'] == key)['secret']}
            await self._transition(entry, 'responding', disposition='automatic' if entry.get('automatic') else 'user',
                                   responseKind=decision['kind'], answers=saved, approved=decision.get('approved'))
            entry['response'] = decision
            entry['future'].set_result(decision)
            return entry['row']

    async def respond(self, scope: CollaborationScope, session_id: str, request_id: str, response: dict) -> dict:
        entry = self.pending.get(request_id)
        if entry is None:
            row = await asyncio.to_thread(self.store.read, scope, 'interaction', request_id)
            if row and row.get('sessionId') == session_id:
                if row['status'] == 'pending':
                    return {**row, 'status': 'interrupted', 'notice': '原生等待已不可恢复，没有重发答案。'}
                if row['status'] == 'responding' and request_id not in self.delivering:
                    return {**row, 'status': 'unknown', 'notice': '回传结果未知，没有重发答案。'}
                return row  # 已结束/已发送/重启遗留只回原状态，不重放到新调用。
            raise CollaborationError('交互不可用')
        if entry['scope'] != scope or entry['row']['sessionId'] != session_id:
            raise PermissionError('交互不可用')
        return await self._accept(entry, response)
