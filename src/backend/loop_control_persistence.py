"""Handoff-local ordered writes; workers never receive a mutable LoopState."""
from __future__ import annotations

import asyncio
import copy
from typing import Any, Callable


class OrderedLoopWrites:
    """由事件循环拥有。普通保存与控制权提交在同一会话队列内排序。

    commit_patch 仅包含被转交预留保护的字段；其它字段保留每次保存冻结的
    最新值。提交成功后排队的旧模式保存也必须应用该 patch，不能恢复旧控制权。
    """

    def __init__(self, write: Callable[[dict], None]) -> None:
        self._write = write
        self.tail: asyncio.Task | None = None
        self.committed_patch: dict = {}

    @property
    def unsettled(self) -> bool:
        # 被取消的写任务也不能证明 to_thread 已结束，必须继续保留预留。
        return self.tail is not None and (not self.tail.done() or self.tail.cancelled())

    def enqueue(self, payload: dict, *, commit_patch: dict | None = None,
                on_commit: Callable[[], None] | None = None) -> asyncio.Task:
        frozen = copy.deepcopy(payload)
        patch = copy.deepcopy(commit_patch) if commit_patch is not None else None
        previous = self.tail

        async def run() -> None:
            if previous is not None:
                # 前一次失败不阻止后续保存原模式/独立 Addon；各自 waiter 仍会
                # 收到自己的错误。失败提交绝不安装目标 patch。
                try:
                    await asyncio.shield(previous)
                except Exception:
                    pass
            merged = {**frozen, **copy.deepcopy(self.committed_patch)}
            if patch is not None:
                merged.update(patch)
            await asyncio.to_thread(self._write, merged)
            if patch is not None:
                self.committed_patch.update(patch)
            if on_commit is not None:
                # 与落盘属于同一个被拥有的任务；回到事件循环后无 await 地安装
                # 内存字段，原 RPC/worker 等待者取消不能跳过这一步。
                on_commit()

        self.tail = asyncio.create_task(run())
        # 即使原请求断线也持有 task，且取走未等待的异常；await 仍照常抛错。
        self.tail.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        return self.tail

    async def flush(self) -> None:
        while self.tail is not None:
            task = self.tail
            error = None
            try:
                await asyncio.shield(task)
            except Exception as exc:
                error = exc
            if self.tail is task:
                if error is not None:
                    raise error
                return
