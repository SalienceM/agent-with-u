"""普通输入与队列接收回执：落盘后清稿，未知请求只查不重放。"""
from __future__ import annotations

import asyncio
import json
from .session_collaboration_store import CollaborationError, fingerprint, identifier


class ComposerSubmissionBridge:
    def _composer_view(self, row: dict) -> dict:
        return {'version': 1, 'requestId': row['requestId'], 'sessionId': row['sessionId'],
                'revision': row['revision'], **row.get('result', {})}

    def _finish_composer_submission(self, session_id: str, request_id: str, state: str, reason: str = '') -> dict:
        scope = self._collaboration_scope(session_id)
        store = self._collaboration_store()
        row = store.request(scope, request_id)
        if not row or row['kind'] != 'composer' or row['sessionId'] != session_id:
            raise CollaborationError('输入回执不可用')
        if row['status'] in {'succeeded', 'failed', 'cancelled'}:
            return self._composer_view(row)
        row = store.finish_request(scope, request_id, row['revision'],
            'succeeded' if state in {'accepted', 'queued'} else 'failed' if state == 'rejected' else 'unknown',
            {**row.get('result', {}), 'state': state, 'reason': reason[:500]})
        view = self._composer_view(row)
        self._emit_event('composerSubmission', view)
        return view

    def _rpc_composerSubmit(self, session_id: str, payload_json: str, queue: bool = False) -> str:
        self._window_guard(session_id)
        self._collaboration_session(session_id)
        payload = json.loads(payload_json)
        if not isinstance(payload, dict) or payload.get('sessionId') != session_id or payload.get('version') != 1 or type(queue) is not bool:
            raise CollaborationError('输入提交协议无效')
        request_id = identifier(payload.get('requestId'))
        user_id, message_id = identifier(payload.get('userMessageId')), identifier(payload.get('messageId'))
        if type(payload.get('draftRevision')) is not int or payload['draftRevision'] < 0:
            raise CollaborationError('草稿修订无效')
        scope, store = self._collaboration_scope(session_id), self._collaboration_store()
        row, created = store.begin_request(scope, request_id, 'composer', {'sessionId': session_id, 'queue': queue, 'payloadHash': fingerprint(payload)})
        if not created:
            return self._rpc_composerStatus(session_id, request_id)
        row = store.finish_request(scope, request_id, row['revision'], 'running', {
            'state': 'preparing', 'userMessageId': user_id, 'messageId': message_id, 'draftRevision': payload['draftRevision'], 'queue': queue})
        self._declare_interaction_client(payload.get('userInteractionVersion'))
        try:
            self._require_update_work_allowed()
            if payload.get('deliveryMode') == 'steer' and not queue:
                if payload.get('kitApprovalDelegation') or payload.get('skillInvocation') or payload.get('interactionMode'):
                    raise CollaborationError('插话不接受 Kit 委托、Skill 命令或语音控制字段')
                if str(payload.get('content') or '').lstrip().startswith('/'):
                    raise CollaborationError('斜杠命令不能作为插话发送')
                async def steer() -> None:
                    try:
                        result = json.loads(await self._rpc_steerMessage(session_id, str(payload.get('content') or ''),
                            json.dumps(payload.get('images') or [], ensure_ascii=False),
                            json.dumps(payload.get('textAttachments') or [], ensure_ascii=False), user_id))
                        state = 'accepted' if result.get('status') == 'ok' else 'unknown' if result.get('status') == 'unknown' else 'rejected'
                        self._finish_composer_submission(session_id, request_id, state, str(result.get('message') or '') if state != 'accepted' else '')
                    except BaseException:
                        self._finish_composer_submission(session_id, request_id, 'unknown', '插话回执未能核对，请核对原对话；未重发。')
                tasks = getattr(self, '_composer_steer_tasks', None)
                if tasks is None:
                    tasks = self._composer_steer_tasks = set()
                task = asyncio.create_task(steer(), name='awu-composer-steer')
                tasks.add(task)
                def settled(done: asyncio.Task) -> None:
                    tasks.discard(done)
                    if not done.cancelled(): done.exception()
                task.add_done_callback(settled)
                return json.dumps(self._composer_view(row), ensure_ascii=False)
            if queue:
                if payload.get('kitApprovalDelegation') is True or payload.get('deliveryMode') or payload.get('interactionMode'):
                    raise CollaborationError('队列不接受本次委托、引导或语音控制字段')
                from .chat_extras_store import SeqTask
                images = self._parse_queue_images(session_id, json.dumps(payload.get('images') or []))
                attachments = self._parse_text_attachments_json(json.dumps(payload.get('textAttachments') or [], ensure_ascii=False))
                text = str(payload.get('content') or '').strip()
                if not text and not images and not attachments:
                    raise CollaborationError('输入为空')
                extras = self._chat_extras_get(session_id)
                task = SeqTask(id=request_id, text=text, images=[item.to_dict() for item in images or []], text_attachments=[item.to_dict() for item in attachments or []])
                extras.seq_tasks.append(task)
                try:
                    self._chat_extras_save(extras)
                except BaseException:
                    extras.seq_tasks.remove(task)
                    raise
                view = self._finish_composer_submission(session_id, request_id, 'queued')
                self._emit_seqtask_updated(extras)
                scheduler = getattr(self, '_sequence_scheduler', None)
                if scheduler: scheduler.kick(session_id)
                return json.dumps(view, ensure_ascii=False)
            self._start_chat_turn(payload_json, composer_submission=request_id)
            return json.dumps(self._composer_view(row), ensure_ascii=False)
        except (ValueError, PermissionError) as exc:
            return json.dumps(self._finish_composer_submission(session_id, request_id, 'rejected', str(exc)), ensure_ascii=False)
        except Exception:
            return json.dumps(self._finish_composer_submission(session_id, request_id, 'unknown', '接收结果需核对，未重发。'), ensure_ascii=False)

    def _rpc_composerStatus(self, session_id: str, request_id: str) -> str:
        scope, store = self._collaboration_scope(session_id), self._collaboration_store()
        row = store.request(scope, request_id)
        if not row or row.get('kind') != 'composer' or row.get('sessionId') != session_id:
            raise CollaborationError('输入回执不可用')
        if row['status'] in {'accepted', 'running', 'unknown'}:
            result = row.get('result', {})
            if result.get('queue'):
                extras = self._chat_extras_store.load(session_id)
                persisted = bool(extras and any(task.id == request_id for task in extras.seq_tasks))
            else:
                saved = self._session_store.load(session_id)
                persisted = bool(saved and saved.owner_id == scope.owner and any(message.id == result.get('userMessageId') for message in saved.messages))
            if persisted:
                return json.dumps(self._finish_composer_submission(session_id, request_id, 'queued' if result.get('queue') else 'accepted'), ensure_ascii=False)
            if not self._active_chat_turn_tasks(session_id):
                return json.dumps(self._finish_composer_submission(session_id, request_id, 'unknown', '未能证明原输入已接收；请核对原对话，未重放。'), ensure_ascii=False)
        return json.dumps(self._composer_view(row), ensure_ascii=False)
