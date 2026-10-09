"""有界、只读的流交接窗口；保留事件位置，不重跑模型或处理确认。"""
from __future__ import annotations

from collections import OrderedDict, deque
from dataclasses import dataclass, field
import json
from typing import Any
import uuid

from .engine_workbench import WorkbenchError


@dataclass
class StreamWindow:
    epoch: str = field(default_factory=lambda: uuid.uuid4().hex)
    sequence: int = 0
    size: int = 0
    message_id: str | None = None
    events: deque[tuple[dict[str, Any], int]] = field(default_factory=deque)


class WorkbenchStreamJournal:
    def __init__(self, per_session: int = 4 * 1024 * 1024, total: int = 32 * 1024 * 1024,
                 max_sessions: int = 128, max_events: int = 4096) -> None:
        self.per_session, self.total, self.max_sessions, self.max_events = per_session, total, max_sessions, max_events
        self.windows: OrderedDict[tuple[str, str], StreamWindow] = OrderedDict()

    def append(self, owner: str, session: str, event: dict[str, Any]) -> dict[str, Any]:
        key = (owner, session)
        window = self.windows.setdefault(key, StreamWindow())
        self.windows.move_to_end(key)
        window.sequence += 1
        message_id = event.get('messageId')
        starts = isinstance(message_id, str) and bool(message_id) and message_id != window.message_id
        if starts:
            window.message_id = message_id
        row = {**event, 'streamEpoch': window.epoch, 'streamSequence': window.sequence, 'streamMessageStart': starts}
        serialized = json.dumps(row, ensure_ascii=False)
        size = len(serialized.encode('utf-8'))
        # 单帧超过预算仍正常推送，但恢复必须报告缺口，不能伪造完整历史。
        if size <= self.per_session:
            window.events.append((json.loads(serialized), size)); window.size += size
        else:
            window.events.clear(); window.size = 0
        while window.size > self.per_session or len(window.events) > self.max_events:
            _, removed = window.events.popleft(); window.size -= removed
        while len(self.windows) > self.max_sessions or sum(item.size for item in self.windows.values()) > self.total:
            self.windows.popitem(last=False)
        return row

    def read(self, owner: str, session: str, epoch: str, after: int) -> dict[str, Any]:
        if not isinstance(epoch, str) or len(epoch) > 128 or type(after) is not int or not 0 <= after < 2**53:
            raise WorkbenchError('invalid_stream_position')
        window = self.windows.get((owner, session))
        if window is None:
            return {'status': 'unavailable', 'sessionId': session, 'gap': True, 'reasonCode': 'stream_window_unavailable'}
        earliest = window.events[0][0]['streamSequence'] if window.events else window.sequence + 1
        gap = (bool(epoch) and epoch != window.epoch) or after < earliest - 1 or after > window.sequence
        return {'status': 'ok', 'sessionId': session, 'streamEpoch': window.epoch,
                'earliestSequence': earliest, 'lastSequence': window.sequence, 'gap': gap,
                'events': [] if gap else [dict(row) for row, _ in window.events if row['streamSequence'] > after]}


class WorkbenchStreamBridge:
    def _stream_window_journal(self) -> WorkbenchStreamJournal:
        if not hasattr(self, '_workbench_stream_journal'):
            self._workbench_stream_journal = WorkbenchStreamJournal()
        return self._workbench_stream_journal

    def _rpc_workbenchStreamGet(self, session_id: str, identity_json: str, epoch: str, after: int) -> str:
        self._require_session_access(session_id)
        try:
            if not isinstance(identity_json, str) or len(identity_json) > 16384:
                raise WorkbenchError('invalid_request')
            workspace = self._workbench_identity(session_id, json.loads(identity_json))
            result = self._stream_window_journal().read(workspace.ownerId, session_id, epoch, after)
            result['workspace'] = workspace.to_dict()
            return json.dumps(result, ensure_ascii=False)
        except (ValueError, TypeError, OSError) as error:
            return json.dumps({'status': 'error', 'reasonCode': getattr(error, 'reason', 'invalid_request')})
