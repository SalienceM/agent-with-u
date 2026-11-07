"""定时 RPC：只路由原 Session，配置回执不等于聊天执行成功。"""
from __future__ import annotations

import json
import time

from .session_schedule_rules import ScheduleError, normalize_config, preview


class SessionScheduleBridge:
    def _schedule_waiting(self, session_id: str, message_id: str) -> bool:
        registry = getattr(self, '_user_interaction_registry', None)
        if registry and any(entry['row'].get('messageId') == message_id
                            and entry['row']['sessionId'] == session_id
                            and entry['scope'].owner == self._current_owner_id()
                            and entry['row']['status'] in {'pending', 'responding'}
                            for entry in registry.pending.values()):
            return True
        gate = getattr(self, '_permission_gates', {}).get(session_id)
        payload = getattr(self, '_permission_payloads', {}).get(session_id, {})
        return bool(gate and not gate.done() and payload.get('messageId') == message_id)

    def _schedule_session(self, session_id: str):
        scope = self._collaboration_scope(session_id)
        session = self._collaboration_session(session_id)
        if session.session_type != 'normal' or session.relation_kind == 'review':
            raise ScheduleError('定时指令仅支持普通 Session，不支持 LOOP 或角色评议 Session')
        return (scope.owner, scope.executor), session

    async def _rpc_sessionScheduleList(self, session_id: str, offset: int = 0) -> str:
        scope, session = self._schedule_session(session_id)
        service = self._session_prompt_scheduler
        result = await service.io.run(service.store.listing, scope, session_id, offset=offset)
        self._schedule_session(session_id)
        ex = self._chat_extras_get(session_id)
        result.update(ready=service.ready, error=service.error, queuePaused=not ex.seq_auto,
                      queueError=ex.seq_error, unknown=session_id in service.unknown, observedAt=time.time())
        activity = result.get('activity')
        if activity:
            activity['waitingForInput'] = activity['state'] == 'running' and self._schedule_waiting(session_id, activity['assistantMessageId'])
        if not activity or activity['state'] not in {'running', 'claimed'}:
            try:
                self._check_chat_turn_allowed(session_id)
            except (ValueError, PermissionError) as exc:
                result['blockedReason'] = str(exc)[:500]
        return json.dumps(result, ensure_ascii=False)

    async def _rpc_sessionScheduleGet(self, session_id: str, schedule_id: str) -> str:
        scope, _ = self._schedule_session(session_id)
        service = self._session_prompt_scheduler
        result = await service.io.run(service.store.get, scope, session_id, schedule_id)
        self._schedule_session(session_id)
        return json.dumps(result, ensure_ascii=False)

    def _rpc_sessionSchedulePreview(self, session_id: str, config_json: str) -> str:
        self._schedule_session(session_id)
        now = time.time()
        config = normalize_config(json.loads(config_json), now)
        return json.dumps(preview(config, now), ensure_ascii=False)

    async def _rpc_sessionScheduleSave(self, session_id: str, intent_json: str) -> str:
        self._window_guard(session_id)
        scope, _ = self._schedule_session(session_id)
        intent = json.loads(intent_json)
        if not isinstance(intent, dict):
            raise ScheduleError('定时操作无效')
        service = self._session_prompt_scheduler
        if intent.get('action') in {'retry', 'resolve'} and (self._active_chat_turn_tasks(session_id) or self._has_native_session_activity(session_id)):
            raise ScheduleError('原执行尚未退出，不能核对结束或重试')
        if intent.get('action') == 'resolve' and intent.get('confirmed') is not True:
            raise ScheduleError('请先查看原聊天，明确确认已核对本次结果')
        result = await service.mutate(scope, session_id, intent)
        return json.dumps(result, ensure_ascii=False)

    async def _rpc_sessionScheduleRequestStatus(self, session_id: str, request_id: str) -> str:
        scope, _ = self._schedule_session(session_id)
        service = self._session_prompt_scheduler
        result = await service.io.run(service.store.request, scope, session_id, request_id)
        self._schedule_session(session_id)
        return json.dumps(result, ensure_ascii=False)

    async def _rpc_sessionScheduleOccurrences(self, session_id: str, offset: int = 0) -> str:
        scope, _ = self._schedule_session(session_id)
        service = self._session_prompt_scheduler
        result = await service.io.run(service.store.listing, scope, session_id, history=True, offset=offset)
        self._schedule_session(session_id)
        for row in result['items']:
            row['waitingForInput'] = row['state'] == 'running' and self._schedule_waiting(session_id, row['assistantMessageId'])
        return json.dumps(result, ensure_ascii=False)

    async def _rpc_sessionScheduleOutput(self, session_id: str, occurrence_id: str, offset: int = 0) -> str:
        scope, session = self._schedule_session(session_id)
        if type(offset) is not int or offset < 0:
            raise ScheduleError('输出分页无效')
        service = self._session_prompt_scheduler
        row = await service.io.run(service.store.get, scope, session_id, occurrence_id, occurrence=True)
        self._schedule_session(session_id)
        message = next((m for m in session.messages if m.id == row['assistantMessageId']), None)
        text = message.content if message else ''
        return json.dumps({'messageId': row['assistantMessageId'], 'text': text[offset:offset + 8000],
                           'nextOffset': offset + 8000 if offset + 8000 < len(text) else None}, ensure_ascii=False)
