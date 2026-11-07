"""评议的排版等价引用和有界实时输出；不暴露隐藏推理。"""
from __future__ import annotations

import copy
import asyncio
import re
import time
from typing import Any, Callable


def quote_text(text: str) -> str:
    # 仅消除成对的 Markdown 强调符号。代码、转义、文字与标点均保留，不做模糊匹配。
    parts = re.split(r'(`+[^`]*`+|\\.)', text.replace('\r\n', '\n'))
    for index in range(0, len(parts), 2):
        value = parts[index]
        for marker in (r'\*\*', '__', r'\*', '_'):
            value = re.sub(r'(?<![\w\\])(' + marker + r')(?=\S)(.+?)(?<=\S)\1(?!\w)', r'\2', value)
        # 中文连续文字中的 **加粗** 不依赖英文单词边界。
        value = re.sub(r'(?<![\\*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\*)', r'\1', value)
        parts[index] = value
    return ''.join(parts)


class ReviewOutput:
    """推送最多每 0.5 秒一次，按需核对可读取最新快照，不因每个 token 重读整份报告。"""
    def __init__(self, report: dict, emit: Callable[[dict], None]):
        self.report = report
        self.emit = emit
        self.last_push = 0.0
        self.pending: asyncio.TimerHandle | None = None
        self.value: dict[str, Any] = {
            'sequence': 0, 'startedAt': time.time(), 'updatedAt': time.time(),
            'phase': 'queued', 'message': '等待角色执行', 'round': 0,
            'outputCharacters': 0, 'evidenceCount': 0, 'output': '', 'events': [],
            'roundOutputs': [],
        }

    def change(self, phase: str, message: str, **patch: Any) -> None:
        now = time.time()
        if patch.get('round', self.value['round']) != self.value['round'] and self.value['output']:
            self.value['roundOutputs'] = [*self.value['roundOutputs'], {'round': self.value['round'], 'output': self.value['output']}][-2:]
        self.value.update(phase=phase, message=message, updatedAt=now, **patch)
        self.value['events'] = [*self.value['events'], {'at': now, 'message': message}][-24:]
        self.push(force=True)

    def text(self, text: str, *, replace: bool = False) -> None:
        if not text:
            return
        self.value.update(output=(text if replace else self.value['output'] + text)[-24000:],
                          outputCharacters=len(text) if replace else self.value['outputCharacters'] + len(text),
                          lastOutputAt=time.time(), updatedAt=time.time(),
                          phase='responding', message='正在接收角色输出')
        self.push()

    def signal(self) -> None:
        # 仅记录响应事件的时间，不保存或转发模型隐藏推理正文。
        self.value.update(lastActivityAt=time.time(), updatedAt=time.time())
        if not self.value['output']:
            self.value.update(phase='processing', message='模型已响应，正在处理材料')
        self.push()

    def push(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_push < .5:
            if self.pending is None:
                self.pending = asyncio.get_running_loop().call_later(.5 - (now - self.last_push), self.flush)
            return
        if self.pending:
            self.pending.cancel()
            self.pending = None
        self.last_push = now
        self.value['sequence'] += 1
        self.emit({'kind': 'progress', 'id': self.report['id'], 'revision': self.report['revision'],
                   'batchId': self.report['batchId'], 'sourceSessionId': self.report['sourceSessionId'],
                   # 轮次边界补齐历史；高频正文推送只携带当前轮，避免反复传输证据查询正文。
                   'progress': copy.deepcopy({key: value for key, value in self.value.items() if force or key != 'roundOutputs'})})

    def flush(self) -> None:
        self.pending = None
        self.push()

    def close(self) -> None:
        if self.pending:
            self.pending.cancel()
            self.pending = None
