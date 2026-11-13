"""复用 owning SDK client；只收响应，不消费第二份通知或重放插话。"""
from __future__ import annotations

import asyncio
import hashlib
import threading
from typing import Any

from pydantic import BaseModel, ConfigDict


class SteerReply(BaseModel):
    model_config = ConfigDict(extra="allow")


class HarnessSteering:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.identity: dict[str, str] = {}
        self.supported = False
        self.turn: int | None = None
        self.closed = False
        self.pending = 0
        self.results: dict[str, tuple[str, asyncio.Task[dict]]] = {}
        self.dispatch_lock = asyncio.Lock()

    def configure(self, identity: dict[str, str], capability: Any) -> None:
        with self.lock:
            self.identity = dict(identity)
            self.supported = (isinstance(capability, dict) and type(capability.get('version')) is int and capability.get('version') == 1
                              and capability.get('text') is True and capability.get('images') is False)

    def observe_turn(self, turn: int | None) -> None:
        with self.lock:
            self.turn = turn

    def finish(self) -> bool:
        with self.lock:
            if self.pending:
                return False
            self.closed = True
            return True

    async def send(self, worker: Any, content: str, request_id: str) -> dict:
        if not request_id or len(request_id) > 200 or not content.strip() or len(content.encode('utf-8')) > 1024 * 1024:
            return {'status': 'error', 'message': '引导内容为空或超过限额'}
        digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
        prior = self.results.get(request_id)
        if prior:
            if prior[0] != digest:
                return {'status': 'error', 'message': '同一引导请求的内容不能变化'}
            return await asyncio.shield(prior[1])
        with self.lock:
            if not self.supported:
                return {'status': 'unsupported', 'message': '当前 DSH 桥未就绪或不支持引导，请等待启动完成或更新桥接制品'}
            if self.closed or self.turn is None or worker.stop_requested.is_set():
                return {'status': 'turn_finished', 'message': '当前回答已经结束或正在停止，未执行引导'}
            if len(self.results) >= 256:
                return {'status': 'error', 'message': '本轮引导数量超过限额'}
            params = {**self.identity, 'expectedTurn': self.turn, 'requestId': request_id, 'content': content}
            self.pending += 1

        def request() -> dict:
            try:
                try:
                    reply = worker.client.request('awu/steer', params, response_model=SteerReply,
                                                  timeout_seconds=10).model_dump()
                except Exception:
                    # 最多一次只读核对；同一连接的 reader 仍由 SDK 独占。
                    reply = worker.client.request('awu/steerStatus', {**self.identity, 'requestId': request_id},
                                                  response_model=SteerReply, timeout_seconds=5).model_dump()
                if any(reply.get(key) != value for key, value in {**self.identity, 'requestId': request_id}.items()):
                    raise ValueError('Steer receipt identity mismatch')
                if reply.get('status') == 'accepted' and reply.get('turn') == params['expectedTurn'] and isinstance(reply.get('messageId'), str) and reply['messageId']:
                    return {'status': 'ok', 'nativeMessageId': reply['messageId']}
                if reply.get('status') in {'turn_finished', 'rejected', 'unsupported', 'limit', 'conflict', 'not_found'}:
                    return {'status': 'turn_finished' if reply['status'] == 'turn_finished' else 'error',
                            'message': '当前回答已经结束，未执行引导' if reply['status'] == 'turn_finished' else 'DSH 未接收这条引导，内容已保留'}
            except Exception:
                pass
            return {'status': 'unknown', 'message': '引导接收回执未能核对，请核对原对话；未自动重发或排队'}

        async def dispatch() -> dict:
            try:
                # 与 Codex control_queue 的交互顺序一致；并行线程写锁不能保证
                # 两条用户修正按接收顺序到达。串行回执不占用 SDK 的通知 reader。
                async with self.dispatch_lock:
                    with self.lock:
                        if self.closed or self.turn != params['expectedTurn'] or worker.stop_requested.is_set():
                            return {'status': 'turn_finished', 'message': '当前回答已经结束或正在停止，未执行引导'}
                    return await asyncio.to_thread(request)
            finally:
                with self.lock:
                    self.pending -= 1

        task = asyncio.create_task(dispatch(), name='awu-dsh-steer')
        self.results[request_id] = (digest, task)
        return await asyncio.shield(task)
