"""Kit 委托的无秘密回执。记录仅供展示，永远不参与授权判断。"""
from __future__ import annotations

import json
import time
from typing import Any

from .session_collaboration_store import fingerprint


class KitDelegationFeedback:
    def _record_kit_delegation(self, session_id: str, message_id: str, status: str, **fields: Any) -> dict:
        if not message_id:
            return {}
        scope = self._collaboration_scope(session_id)
        key = fingerprint([session_id, message_id])
        store = self._collaboration_store()
        old = store.read(scope, 'kitDelegation', key) or {}
        # 接收错误不得覆盖已成功绑定/使用的事实；故障后的结果应核对原运行。
        if status == 'unavailable' and old.get('status') in {'bound', 'used'}:
            return old
        body = {**old, 'sessionId': session_id, 'messageId': message_id, 'status': status}
        for field in ('issuedAt', 'expiresAt', 'runId', 'kitId', 'stepId', 'runStatus', 'reason'):
            if field in fields:
                body[field] = fields[field]
        if all(old.get(key) == value for key, value in body.items()):
            return old
        row = store.write(scope, 'kitDelegation', key, body, old.get('revision', 0))
        self._emit_event('kitDelegation', row)
        return row

    def _sync_kit_delegations(self, state: Any) -> None:
        from .workspace_kit_store import FINAL_RUN_STATUSES
        service = getattr(self, '_chat_kit_tools', None)
        if service is None:
            return
        for run in state.runs:
            grant = run.approval_delegation
            if not grant or grant.get('actor') != self._current_owner_id():
                continue
            used = any((step.config.get('capabilityRuntime') or {}).get('approval', {}).get('source') == 'chat-delegated'
                       for step in run.steps)
            reason = service._delegation_error(run)
            status = 'used' if used else 'expired' if time.time() >= float(grant.get('expiresAt') or 0) else 'unavailable' if reason else 'bound'
            step = run.steps[run.current_step] if 0 <= run.current_step < len(run.steps) else None
            if not used and run.status in FINAL_RUN_STATUSES:
                status, reason = 'expired', '运行已结束，未使用的委托已结束。'
            if not reason and run.status == 'waiting_approval':
                reason = '已有委托，仍待 Agent 核对完整计划；也可在 Kit 面板人工确认。'
            self._record_kit_delegation(run.session_id, grant.get('messageId', ''), status,
                issuedAt=grant['issuedAt'], expiresAt=grant['expiresAt'], runId=run.id, kitId=run.kit_id,
                stepId=step.id if step else '', runStatus=run.status, reason=reason)

    async def _rpc_kitDelegationList(self, session_id: str) -> str:
        scope = self._collaboration_scope(session_id)
        state = self._kit_get(session_id)
        self._sync_kit_delegations(state)
        store = self._collaboration_store()
        rows = []
        service = getattr(self, '_chat_kit_tools', None)
        live = {lease.get('messageId') for lease in service.leases.values()
                if lease['session'] == session_id and lease['actor'] == scope.owner} if service else set()
        for item in store.list(scope, 'kitDelegation', session_id=session_id, limit=50)['items']:
            row = store.read(scope, 'kitDelegation', item['id'])
            if row['status'] == 'accepted' and (row['messageId'] not in live or time.time() >= row['expiresAt']):
                row = self._record_kit_delegation(session_id, row['messageId'], 'expired', reason='本轮已结束或委托已过期，未绑定运行。')
            rows.append(row)
        waiting = [{'id': run.id, 'runId': run.id, 'sessionId': session_id,
                    'stepId': run.steps[run.current_step].id if 0 <= run.current_step < len(run.steps) else '',
                    'kitId': run.kit_id, 'status': run.status} for run in state.runs if run.status == 'waiting_approval']
        return json.dumps({'version': 1, 'items': rows, 'waitingRuns': waiting}, ensure_ascii=False)
