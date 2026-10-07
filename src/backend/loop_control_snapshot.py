"""Gated, owned snapshot worker (also supported by the frozen sidecar)."""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .owned_process_tree import OwnedProcessTree


@dataclass
class SnapshotResult:
    git: str | None = None
    directory: str | None = None
    exit_confirmed: bool = True
    owner: Any = None


class _GatedRoot:
    """放行前没有快照子进程；此时只需证明本次 root 退出。"""
    def __init__(self, process: Any) -> None:
        self.process = process

    def exit_confirmed(self) -> bool:
        return self.process.returncode is not None

    def release(self) -> None:
        transport = getattr(self.process, '_transport', None)
        if transport is not None:
            transport.close()


async def snapshot_handoff(working_dir: str | None, action: str, budget: float = 60) -> SnapshotResult:
    """先取得进程树拥有权再放行 I/O；结果返回前确认退出，不依赖超时推断。"""
    args = ([sys.executable, '--agentwithu-control-snapshot'] if getattr(sys, 'frozen', False)
            else [sys.executable, '-m', 'src.backend.loop_control_snapshot'])
    process = await asyncio.create_subprocess_exec(*args, cwd=str(Path(__file__).resolve().parents[2]),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        limit=16_384, **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt'
                        else {'start_new_session': True}))
    try:
        owner = OwnedProcessTree(process)
    except Exception:
        # 门尚未开启；不能把构造拥有关系失败等同于 spawn 前失败而直接解锁。
        gate = _GatedRoot(process)
        try:
            process.kill()
            await asyncio.wait_for(process.wait(), 3)
        except (OSError, asyncio.TimeoutError):
            pass
        confirmed = gate.exit_confirmed()
        if confirmed:
            gate.release()
        return SnapshotResult(exit_confirmed=confirmed, owner=None if confirmed else gate)
    data: dict = {}

    async def cleanup() -> bool:
        try:
            if os.name != 'nt':
                # helper 在结果后仍等待父进程，保持本次进程组 leader 存活。
                # 意外退出不凭一个已被回收的 PID 猜测整组状态。
                if process.returncode is not None:
                    return False
                os.killpg(process.pid, signal.SIGKILL)
            confirmed = await owner.stop()
            if confirmed and os.name != 'nt':
                # signal 已发送不等于整组已退出；仍存活（包括待回收）则保留保护。
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    return True
                return False
            return confirmed
        except BaseException:
            return False  # 保留本次 owner，不能用清理异常当作退出证据。

    try:
        if os.name == 'nt' and not owner.complete:
            confirmed = await cleanup()
            if confirmed:
                owner.release()
            return SnapshotResult(exit_confirmed=confirmed, owner=None if confirmed else owner)
        process.stdin.write((json.dumps({'cwd': working_dir, 'action': action,
                                         'budget': budget}, ensure_ascii=False) + '\n').encode())
        await process.stdin.drain()
        try:
            line = await asyncio.wait_for(process.stdout.readline(), budget)
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                data = parsed
        except (asyncio.TimeoutError, ValueError, json.JSONDecodeError):
            pass
        confirmed = await cleanup()
        result = SnapshotResult(
            git=data.get('git') if isinstance(data.get('git'), str) else None,
            directory=data.get('directory') if isinstance(data.get('directory'), str) else None,
            exit_confirmed=confirmed, owner=None if confirmed else owner)
        if confirmed:
            owner.release()
        return result
    except BaseException:
        # 调用方取消也不能遗失拥有关系。收口未确认时由上层保留该 task/结果；
        # 正常调用始终 shield，此分支只处理服务停止。
        confirmed = await cleanup()
        if confirmed:
            owner.release()
        return SnapshotResult(exit_confirmed=confirmed, owner=None if confirmed else owner)


def run_worker() -> int:
    """只有父进程放行后才导入快照实现；不创建 Bridge 或读取用户 Session。"""
    line = sys.stdin.buffer.readline(20_001)
    if len(line) > 20_000:
        return 2
    request = json.loads(line)
    cwd, action = request.get('cwd'), request.get('action')
    if (cwd is not None and not isinstance(cwd, str)) or action not in ('takeover', 'release'):
        return 2
    budget = min(60.0, max(.01, float(request.get('budget', 60))))
    from .bridge_ws import git_snapshot, dir_snapshot
    deadline = time.monotonic() + budget
    checkpoint = git_snapshot(cwd, command_deadline=deadline)
    directory = dir_snapshot(cwd) if action == 'takeover' and not checkpoint and time.monotonic() < deadline else None
    sys.stdout.write(json.dumps({'git': checkpoint, 'directory': directory}, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    # 父进程确认/清理整棵树之前不退出，避免 POSIX 进程组身份重用。
    sys.stdin.buffer.readline(1)
    return 0


if __name__ == '__main__':
    raise SystemExit(run_worker())
