"""可取消、有拥有权的启动快照；不在共享 asyncio 线程跑 Git/copytree。"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from .loop_control_snapshot import snapshot_handoff


class LoopStartupBridge:
    async def _loop_flush(self, session_id: str) -> None:
        writer = getattr(self, '_loop_control_writes', {}).get(session_id)
        if writer is not None:
            await writer.flush()

    async def _loop_startup_snapshot(self, session: Any, state: Any, record: Any, *, artifact: bool = False) -> bool:
        if not hasattr(self, '_loop_startup_jobs'):
            self._loop_startup_jobs = {}
        sid = session.id
        state.startup = {'status': 'running', 'phase': 'artifact' if artifact else 'snapshot', 'seq': record.seq,
                         'message': '正在保存本轮成果快照…' if artifact else '正在准备工作区快照…', 'startedAt': time.time()}
        self._loop_save(state)
        self._emit_loop_updated(state)
        try:
            await self._loop_flush(sid)
        except BaseException:
            # 尚未启动 worker，保存/等待失败不能制造一个不存在的进程锁。
            state.startup = {**state.startup, 'status': 'failed', 'message': '准备状态保存未完成，尚未启动快照。'}
            raise
        io = asyncio.create_task(snapshot_handoff(getattr(session, 'working_dir', None), 'release' if artifact else 'takeover'))
        self._loop_startup_jobs[sid] = io

        def finished(task: asyncio.Task) -> None:
            # waiter 取消仍持有 worker；只采纳此任务的真实退出结果。
            if self._loop_startup_jobs.get(sid) is not task:
                return
            try:
                result = task.result()
            except BaseException:
                result = None
            if result is not None and result.exit_confirmed:
                self._loop_startup_jobs.pop(sid, None)
                state.startup = {**state.startup, 'status': 'done', 'message': '工作区准备已结束'}
            else:
                state.startup = {**state.startup, 'status': 'unknown', 'message': '工作区准备进程退出未确认；不会启动模型或再次快照。'}
            self._loop_save(state)
            self._emit_loop_updated(state)

        io.add_done_callback(finished)
        try:
            result = await asyncio.shield(io)
        except asyncio.CancelledError:
            io.cancel()  # helper 负责确认 owned process tree 已退出，不靠发送取消就解锁。
            state.startup = {**state.startup, 'message': '正在停止工作区准备…'}
            self._loop_save(state)
            self._emit_loop_updated(state)
            try:
                await asyncio.shield(io)
            except asyncio.CancelledError:
                pass
            raise
        if not result.exit_confirmed:
            self._loop_wait(state, record, 'startup_unknown', state.startup['message'], '确认旧工作区准备进程退出后再运行。')
            return False
        if not artifact and not result.git and not result.directory and getattr(session, 'working_dir', None):
            self._loop_wait(state, record, 'snapshot_failed', '工作区快照未完成；未启动模型。', '核对目录可读性、大小和快照时限后重试。')
            return False
        if artifact:
            record.artifact_checkpoint = result.git  # 成果快照可缺省，不替换开跑前恢复点。
        else:
            record.git_checkpoint, record.dir_checkpoint = result.git, result.directory
        self._loop_save(state)
        await self._loop_flush(sid)
        return True
