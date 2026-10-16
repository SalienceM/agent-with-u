"""俺寻思只读协议：身份和预算属于执行端，模型只能提出有界查询。"""
from __future__ import annotations

import hashlib
import json
import os
import time
import threading
from dataclasses import dataclass, field
from typing import Any


class InspectionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code

    def result(self) -> dict:
        return {'status': self.code, 'message': str(self), 'complete': False}


@dataclass(frozen=True)
class QueryIdentity:
    owner: str
    executor: str
    session_id: str
    root: str
    backend_id: str
    turn_id: str
    transport: str = ''
    restrictions: str = ''

    @classmethod
    def capture(cls, session: Any, *, owner: str, executor: str, backend_id: str,
                turn_id: str) -> QueryIdentity:
        if not session or str(getattr(session, 'owner_id', 'local')) != owner:
            raise InspectionError('identity_changed', '当前用户无权读取此 Session。')
        if not executor or not backend_id or not turn_id:
            raise InspectionError('identity_changed', '执行身份不完整，未切换其他节点或 Backend。')
        restrictions = json.dumps([getattr(session, 'constraints', ''),
                                   getattr(session, 'abilities', None), getattr(session, 'model_override', None),
                                   getattr(session, 'reasoning_effort', None)], sort_keys=True, ensure_ascii=False)
        return cls(owner, executor, session.id, str(session.working_dir or ''), backend_id,
                   turn_id, 'ssh' if getattr(session, 'codex_remote_host', None) else
                   str(getattr(session, 'codex_connection_mode', '') or ''),
                   hashlib.sha256(restrictions.encode()).hexdigest())

    def validate(self, session: Any, *, owner: str, executor: str, backend_id: str) -> None:
        current = self.capture(session, owner=owner, executor=executor,
                               backend_id=backend_id, turn_id=self.turn_id)
        if current != self:
            raise InspectionError('identity_changed', 'Session、工作目录或执行配置已变化，请重新提问。')

    def file_root(self) -> str:
        if self.transport == 'ssh':
            raise InspectionError('unsupported', 'SSH 项目暂不支持此只读查询；未读取本机同名目录。')
        if not self.root or not os.path.isabs(self.root):
            raise InspectionError('unconfigured', '当前 Session 未设置绝对工作目录。')
        return self.root


OPERATIONS = {
    'runtime_status': {},
    'list_directory': {'path': str, 'offset': int, 'limit': int},
    'read_text': {'path': str, 'offset': int, 'limit': int, 'revision': str},
    'search_text': {'path': str, 'query': str, 'limit': int},
    'openspec_tasks': {'change': str, 'all': bool},
}


@dataclass(frozen=True)
class ReadQuery:
    operation: str
    arguments: dict = field(default_factory=dict)

    @classmethod
    def parse(cls, raw: Any) -> ReadQuery:
        if not isinstance(raw, dict) or set(raw) - {'operation', 'arguments'}:
            raise InspectionError('invalid_query', '查询必须是 operation/arguments 对象。')
        operation = raw.get('operation')
        if not isinstance(operation, str) or operation not in OPERATIONS:
            raise InspectionError('invalid_query', '不支持该操作；这里只能查询项目，不执行命令或写入。')
        args = raw.get('arguments', {})
        if not isinstance(args, dict) or set(args) - set(OPERATIONS[operation]):
            raise InspectionError('invalid_query', '查询包含未允许的参数。')
        for key, value in args.items():
            if type(value) is not OPERATIONS[operation][key]:
                raise InspectionError('invalid_query', '查询参数类型不正确。')
            if isinstance(value, str) and (len(value) > 2000 or '\0' in value):
                raise InspectionError('invalid_query', '查询参数过长或包含空字符。')
            if type(value) is int and (value < 0 or value > 262_144):
                raise InspectionError('invalid_query', '查询位置或数量超出限制。')
        if operation in {'read_text', 'search_text'} and not args.get('path'):
            raise InspectionError('invalid_query', '请指定当前工作区内的查询路径。')
        if operation == 'search_text' and not args.get('query'):
            raise InspectionError('invalid_query', '搜索内容不能为空。')
        if operation == 'openspec_tasks' and args.get('all') and args.get('change'):
            raise InspectionError('invalid_query', '不能同时指定 change 和全部汇总。')
        return cls(operation, dict(args))


@dataclass
class QueryBudget:
    seconds: float = 180
    operations: int = 24
    file_bytes: int = 262_144
    total_bytes: int = 1_048_576
    context_chars: int = 64_000
    started: float = field(default_factory=time.monotonic)
    used_operations: int = 0
    used_bytes: int = 0
    used_chars: int = 0
    cancelled: threading.Event = field(default_factory=threading.Event)

    def remaining(self) -> float:
        return max(0, self.seconds - (time.monotonic() - self.started))

    def check(self) -> None:
        if self.cancelled.is_set():
            raise InspectionError('cancelled', '本次旁路查询已停止。')
        if self.remaining() <= 0:
            raise InspectionError('timeout', '本次查询已达到时间上限；未完成的范围没有被核验。')

    def operation(self) -> None:
        self.check()
        if self.used_operations >= self.operations:
            raise InspectionError('limit', '本次只读操作次数已达上限。')
        self.used_operations += 1

    def bytes(self, count: int) -> None:
        self.check()
        if self.used_bytes + count > self.total_bytes:
            raise InspectionError('limit', '本次累计读取量已达上限。')
        self.used_bytes += count

    def context(self, result: dict) -> dict:
        size = len(json.dumps(result, ensure_ascii=False))
        if self.used_chars + size > self.context_chars:
            return InspectionError('limit', '项目证据上下文已达上限，本结果未完整带入。').result()
        self.used_chars += size
        return result


def clean_inspection(raw: Any) -> dict:
    """持久化只保留允许的元数据；任何正文/查询包都不会随字典被复制。"""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for key in ('requestId', 'phase', 'message', 'errorCode'):
        if isinstance(raw.get(key), str):
            out[key] = raw[key][:600]
    for key in ('sampledAt', 'updatedAt', 'sequence'):
        if type(raw.get(key)) in (int, float):
            out[key] = raw[key]
    sources = []
    for item in (raw.get('sources') if isinstance(raw.get('sources'), list) else [])[:24]:
        if not isinstance(item, dict):
            continue
        source = {key: item[key][:500] for key in ('operation', 'path', 'revision', 'status', 'change')
                  if isinstance(item.get(key), str)}
        for key in ('readAt', 'offset', 'end', 'total', 'checked'):
            if type(item.get(key)) in (int, float):
                source[key] = item[key]
        if isinstance(item.get('complete'), bool):
            source['complete'] = item['complete']
        sources.append(source)
    if sources:
        out['sources'] = sources
    return out
