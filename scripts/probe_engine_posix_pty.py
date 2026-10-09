"""Linux PTY 原生原型：固定隔离子程序、输入/resize、所属组及 pidfd 退出证明。"""
from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time
from typing import Any

from scripts.probe_engine_providers import isolated_env


def pidfd_open(pid: int) -> int:
    if hasattr(os, 'pidfd_open'):
        return os.pidfd_open(pid)
    # 独立 CPython 可按旧 glibc 构建而不暴露 os.pidfd_open；直接调用已验证 Linux
    # x86_64 内核 ABI，不回退为仅检查 PID，也不改变系统 Python/权限。
    if sys.platform != 'linux' or os.uname().machine != 'x86_64':
        raise RuntimeError('Verified pidfd ABI unavailable')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    fd = libc.syscall(ctypes.c_long(434), ctypes.c_int(pid), ctypes.c_uint(0))
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'pidfd_open failed')
    return fd


def run_probe() -> int:
    if sys.platform != 'linux' or sys.version_info < (3, 10):
        raise RuntimeError('Linux with pidfd and CPython >= 3.10 is required')
    os.close(pidfd_open(os.getpid()))  # 生成测试进程前先验证内核能力。
    temporary = tempfile.TemporaryDirectory(prefix='awu-engine-pty-')
    temp = Path(temporary.name).resolve()
    if temp.parent != Path(tempfile.gettempdir()).resolve():
        raise RuntimeError('Not an exclusively owned test root')
    home = temp / 'home'
    home.mkdir()
    child = temp / 'terminal_child.py'
    shutil.copyfile(Path(__file__).resolve().parents[1] / 'tests/fixtures/engine/terminal_child.py', child)
    env = isolated_env(home)
    env['TERM'] = 'xterm-256color'
    env['LANG'] = 'C.UTF-8'
    # 仅当前独立探针成为 subreaper，收养并回收测试子进程；不修改系统设置。
    libc = ctypes.CDLL(None, use_errno=True)
    old_subreaper = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(old_subreaper), 0, 0, 0) or libc.prctl(36, 1, 0, 0, 0):
        raise OSError(ctypes.get_errno(), 'Cannot own fixture descendants')
    gate_read, gate_write = os.pipe()
    ready_read, ready_write = os.pipe()
    handles: dict[int, int] = {}
    master: int | None = None
    pid: int | None = None
    result: dict[str, Any] = {'platform': 'linux', 'python': sys.version.split()[0],
        'adapter': 'stdlib-forkpty-termios-pidfd', 'interactiveInput': False,
        'resize': False, 'childTracked': False, 'exitConfirmed': False, 'allHandlesExited': False}
    tail = b''
    output_bytes = 0

    def expect(pattern: bytes) -> re.Match[bytes]:
        nonlocal tail, output_bytes
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if select.select([master], [], [], min(.1, max(0, deadline - time.monotonic())))[0]:
                try:
                    data = os.read(master, 4096)
                except OSError as error:
                    if error.errno in (errno.EAGAIN, errno.EIO):
                        data = b''
                    else:
                        raise
                output_bytes += len(data)
                if output_bytes > 1024 * 1024:
                    raise RuntimeError('Fixture output budget exceeded')
                tail = (tail + data)[-65536:]
            match = re.search(pattern, tail)
            if match:
                return match
        raise TimeoutError('PTY fixture did not acknowledge operation')

    try:
        pid, master = os.forkpty()
        if pid == 0:
            try:
                os.close(gate_write)
                os.close(ready_read)
                os.write(ready_write, b'R')
                os.close(ready_write)
                # 父进程获得所属 pidfd 前不运行测试程序，也不允许产生后代。
                if os.read(gate_read, 1) != b'G':
                    os._exit(125)
                os.close(gate_read)
                os.chdir(temp)
                os.execve(sys.executable, [sys.executable, '-I', str(child)], env)
            finally:
                os._exit(126)
        os.close(gate_read)
        gate_read = -1
        os.close(ready_write)
        ready_write = -1
        if not select.select([ready_read], [], [], 5)[0] or os.read(ready_read, 1) != b'R':
            raise RuntimeError('PTY ownership gate not ready')
        handles[pid] = pidfd_open(pid)
        if os.getsid(pid) != pid or os.getpgid(pid) != pid:
            raise RuntimeError('Fixture did not create its own session and process group')
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        os.set_blocking(master, False)
        os.write(gate_write, b'G')
        os.close(gate_write)
        gate_write = -1
        await_ready = expect(b'FIXTURE_READY')
        assert await_ready
        os.write(master, b'hello\n')
        expect(b'FIXTURE_ECHO_OK')
        result['interactiveInput'] = True
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 37, 103, 0, 0))
        os.write(master, b'size\n')
        expect(b'FIXTURE_SIZE_103_37')
        result['resize'] = True
        os.write(master, b'child\n')
        worker = int(expect(rb'FIXTURE_CHILD_(\d+)').group(1))
        # 固定 worker 在整个探针中阻塞存活，不执行任意项目代码、不自行 daemonize。
        handles[worker] = pidfd_open(worker)
        if os.getpgid(worker) != pid or os.getsid(worker) != pid:
            raise RuntimeError('Fixture child escaped its owned process group')
        result['childTracked'] = True
    finally:
        for fd in (gate_read, gate_write, ready_read, ready_write):
            if fd >= 0:
                os.close(fd)
        if pid is not None and pid > 0:
            # 根进程在本函数 waitpid 前绝不被回收，组长 PID 不会复用；不是历史 PID 接管。
            # pidfd 负责准确退出证明。实际任意 Shell 的脱组/daemon 生命周期仍属任务 9.4。
            try:
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGKILL)
                else:
                    os.kill(pid, signal.SIGKILL)  # 本次尚未回收的直接子进程，gate 前失败。
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            reaped: set[int] = set()
            empty = False
            while time.monotonic() < deadline:
                try:
                    found, _ = os.waitpid(-pid, os.WNOHANG)
                except ChildProcessError:
                    empty = True
                    break
                if found:
                    reaped.add(found)
                else:
                    time.sleep(.02)
            result['allHandlesExited'] = bool(handles) and all(select.select([fd], [], [], 0)[0] for fd in handles.values())
            result['exitConfirmed'] = empty and pid in reaped and set(handles) <= reaped and result['allHandlesExited']
        if master is not None:
            os.close(master)
        if pid is None or result['exitConfirmed']:
            for fd in handles.values():
                os.close(fd)
            temporary.cleanup()
            libc.prctl(36, old_subreaper.value, 0, 0, 0)
        else:
            # 未核对退出就保留测试数据；绝不报告发送 SIGKILL 等于清理完成。
            temporary._finalizer.detach()
        print(json.dumps(result, indent=2))
    return 0 if all(result.get(key) is True for key in (
        'interactiveInput', 'resize', 'childTracked', 'exitConfirmed', 'allHandlesExited')) else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-native', action='store_true')
    args = parser.parse_args()
    if not args.run_native:
        parser.error('Explicit --run-native is required')
    raise SystemExit(run_probe())
