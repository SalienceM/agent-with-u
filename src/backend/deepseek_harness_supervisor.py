"""Linux 专属 subreaper。stdio 原样交给 runtime；本进程不是协议 reader。

上游会建立新的 shell PGID，不能只 killpg(runtime)。所有孤儿后代必须先被
本次 supervisor 收养、退出并 reap，才写退出证明。没有证明则父进程保留锁。
"""
from __future__ import annotations

import ctypes
import json
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path


def run_worker(arguments: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if arguments is None else arguments)
    if args and args[0] == "--agentwithu-harness-supervisor":
        args.pop(0)
    if sys.platform != "linux" or len(args) < 5 or args[3] != "--":
        return 125
    receipt, generation, parent = Path(args[0]), args[1], int(args[2])
    stopped = False

    def record_exit(*, spawned: bool) -> None:
        temporary = receipt.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump({"generation": generation, "supervisorPid": os.getpid(),
                       "exitConfirmed": True, "runtimeSpawned": spawned}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, receipt)

    def stop(_number: int, _frame: object) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    if platform.machine().lower() not in {"x86_64", "amd64"}:
        record_exit(spawned=False)
        return 125

    def pidfd_open(pid: int) -> int:
        # manylinux Python 3.10 的构建头文件可能没有 os.pidfd_open；使用同一
        # Linux x86_64 syscall，而不是退回存在 PID 复用竞态的 os.kill。
        descriptor = libc.syscall(434, pid, 0)
        if descriptor < 0:
            number = ctypes.get_errno()
            raise OSError(number, os.strerror(number))
        return int(descriptor)

    try:
        probe = pidfd_open(os.getpid())
        os.close(probe)
    except OSError:
        record_exit(spawned=False)
        return 125
    # 在 runtime 创建前建立收养与父进程死亡通知；失败不得启动 runtime。
    if libc.prctl(36, 1, 0, 0, 0) != 0 or libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        record_exit(spawned=False)
        return 125
    if os.getppid() != parent:
        record_exit(spawned=False)
        return 125
    proc: subprocess.Popen | None = None
    result = 125
    confirmed = False
    try:
        proc = subprocess.Popen(args[4:], stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
        while proc.poll() is None and not stopped:
            time.sleep(.02)
        if proc.returncode is not None:
            result = proc.returncode
    finally:
        # 只持有本次 supervisor 的直接子进程 pidfd；父进程先退出后孤儿自动收养。
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                while True:
                    child, _status = os.waitpid(-1, os.WNOHANG)
                    if child == 0:
                        break
            except ChildProcessError:
                confirmed = True
                break
            children = Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()
            for child in children:
                descriptor = None
                try:
                    descriptor = pidfd_open(int(child))
                    if libc.syscall(424, descriptor, signal.SIGKILL, 0, 0) < 0:
                        number = ctypes.get_errno()
                        raise OSError(number, os.strerror(number))
                except ProcessLookupError:
                    pass
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
            time.sleep(.02)
        if confirmed:
            if proc is not None:
                proc.poll()  # waitpid 可能已收割根进程，更新 Popen 状态后才销毁。
            record_exit(spawned=proc is not None)
    return result if confirmed else 125


if __name__ == "__main__":
    raise SystemExit(run_worker())
