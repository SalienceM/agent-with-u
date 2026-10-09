"""独立工程进程宿主。仅父端放行后创建 PTY/服务，不加载应用日志或用户配置。"""
from __future__ import annotations

import base64
import ctypes
import errno
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import threading
import time
from typing import Any

FRAME_LIMIT = 256 * 1024
CHUNK = 8192


def pidfd_open(pid: int) -> int:
    if hasattr(os, 'pidfd_open'):
        return os.pidfd_open(pid)
    # 已验证 Linux x86_64；不以 PID 探测降级替代句柄。
    import platform
    if not sys.platform.startswith('linux') or platform.machine() != 'x86_64':
        raise OSError('pidfd unsupported')
    fd = ctypes.CDLL(None, use_errno=True).syscall(434, pid, 0)
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'pidfd_open')
    return fd


def pidfd_signal(fd: int, sig: int) -> None:
    if hasattr(signal, 'pidfd_send_signal'):
        signal.pidfd_send_signal(fd, sig)
    elif ctypes.CDLL(None, use_errno=True).syscall(424, fd, sig, 0, 0) < 0:
        raise OSError(ctypes.get_errno(), 'pidfd_send_signal')


class LinuxChildren:
    """仅此专用 subreaper 的后代。通过 pidfd 停止，不接管历史 PID/进程名。"""
    def __init__(self) -> None:
        self.handles: dict[int, int] = {}
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0):
            raise OSError('subreaper unavailable')
        fd = pidfd_open(os.getpid()); os.close(fd)

    @staticmethod
    def parent(pid: int) -> int:
        try:
            stat = Path(f'/proc/{pid}/stat').read_text()
            return int(stat[stat.rfind(')') + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            return -1

    def capture(self) -> None:
        pairs = {}
        for entry in Path('/proc').iterdir():
            if entry.name.isdigit():
                pid = int(entry.name); pairs[pid] = self.parent(pid)
        owned = {os.getpid()}
        while True:
            more = {pid for pid, parent in pairs.items() if parent in owned} - owned
            if not more:
                break
            owned.update(more)
        for pid in owned - {os.getpid()} - self.handles.keys():
            try:
                fd = pidfd_open(pid)
                # 持有句柄后再验父链；已退出/换父者下次从 subreaper 重新发现。
                if self.parent(pid) in owned:
                    self.handles[pid] = fd
                else:
                    os.close(fd)
            except OSError:
                pass

    def stop(self, seconds: float = 5) -> bool:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.capture()
            for fd in self.handles.values():
                for sig in (signal.SIGSTOP, signal.SIGKILL):
                    try:
                        pidfd_signal(fd, sig)
                    except OSError as error:
                        if error.errno != errno.ESRCH:
                            return False
            # 子进程退出后，其脱组/双 fork 后代归本宿主；继续核对到 ECHILD。
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                if all(select.select([fd], [], [], 0)[0] for fd in self.handles.values()):
                    for fd in self.handles.values():
                        os.close(fd)
                    self.handles.clear()
                    return True
            time.sleep(.02)
        return False


class Host:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.stop_read = threading.Event()
        self.process: Any = None
        self.pty: Any = None
        self.master: int | None = None
        self.children = LinuxChildren() if sys.platform.startswith('linux') else None
        self.threads: list[threading.Thread] = []

    def emit(self, value: dict[str, Any]) -> None:
        data = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode() + b'\n'
        if len(data) > FRAME_LIMIT:
            raise ValueError('host frame too large')
        with self.lock:
            sys.stdout.buffer.write(data); sys.stdout.buffer.flush()

    def output(self, stream: str, reader: Any) -> None:
        try:
            while not self.stop_read.is_set():
                data = reader()
                if data is None:
                    time.sleep(.01); continue
                if not data:
                    break
                if isinstance(data, str):
                    data = data.encode('utf-8')
                self.emit({'event': 'data', 'stream': stream, 'data': base64.b64encode(data).decode('ascii')})
        except (OSError, EOFError, BrokenPipeError):
            pass
        finally:
            try:
                self.emit({'event': 'eof', 'stream': stream})
            except (OSError, BrokenPipeError):
                pass

    def start(self, p: dict[str, Any]) -> None:
        argv, cwd, env = p['argv'], p['cwd'], p['env']
        if self.process is not None or self.pty is not None or self.master is not None:
            raise ValueError('already started')
        if (not isinstance(argv, list) or not argv or len(argv) > 64 or not all(isinstance(a, str) for a in argv)
                or not isinstance(env, dict) or not Path(cwd).is_dir() or not Path(argv[0]).is_absolute()):
            raise ValueError('invalid launch')
        readers = []
        if p['mode'] == 'pipe':
            self.process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, bufsize=0, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            readers = [('stdout', lambda: self.process.stdout.read(CHUNK)), ('stderr', lambda: self.process.stderr.read(CHUNK))]
        elif p['mode'] == 'pty' and os.name == 'nt':
            from winpty import PTY
            from winpty.enums import Backend
            # CREATE_NO_WINDOW 宿主可能继承忽略 Ctrl+C 的属性；该属性会继续
            # 传给 ConPTY Shell 及其子进程。只在独立宿主放行 PTY 前恢复。
            if not ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False):
                raise OSError('console control initialization failed')
            self.pty = PTY(p['cols'], p['rows'], backend=Backend.ConPTY)
            self.pty.spawn(argv[0], cwd=cwd, env='\0'.join(f'{k}={v}' for k, v in env.items()) + '\0',
                           cmdline=' ' + subprocess.list2cmdline(argv[1:]))
            def read_windows() -> str | None:
                data = self.pty.read(CHUNK, False)
                return data if data else None if self.pty.isalive() else ''
            readers = [('stdout', read_windows)]
        elif p['mode'] == 'pty' and self.children:
            import fcntl
            import termios
            # fork 在启动 reader 线程前；exec 前只有固定系统调用。
            pid, self.master = os.forkpty()
            if pid == 0:
                try:
                    os.chdir(cwd); os.execve(argv[0], argv, env)
                finally:
                    os._exit(126)
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', p['rows'], p['cols'], 0, 0))
            readers = [('stdout', lambda: os.read(self.master, CHUNK))]
        else:
            raise ValueError('unsupported PTY')
        for stream, reader in readers:
            thread = threading.Thread(target=self.output, args=(stream, reader), daemon=True)
            self.threads.append(thread); thread.start()
        if self.process is not None:
            def wait_pipe() -> None:
                code = self.process.wait()
                for reader_thread in self.threads:
                    reader_thread.join()
                try:
                    self.emit({'event': 'exit', 'code': code})
                except (OSError, BrokenPipeError):
                    pass
            threading.Thread(target=wait_pipe, daemon=True).start()

    def command(self, p: dict[str, Any]) -> bool:
        action = p.get('action')
        if action == 'start':
            self.start(p)
        elif action == 'write':
            data = base64.b64decode(p['data'], validate=True)
            if len(data) > 65536:
                raise ValueError('input too large')
            if self.pty is not None:
                self.pty.write(data.decode('utf-8', errors='strict'))
            else:
                fd = self.master if self.master is not None else self.process.stdin.fileno()
                while data:
                    data = data[os.write(fd, data):]
        elif action == 'resize':
            cols, rows = p['cols'], p['rows']
            if not all(type(n) is int and 2 <= n <= 500 for n in (cols, rows)):
                raise ValueError('invalid size')
            if self.pty is not None:
                self.pty.set_size(cols, rows)
            elif self.master is not None:
                import fcntl
                import termios
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            else:
                raise ValueError('not PTY')
        elif action == 'closeInput' and self.process:
            self.process.stdin.close()
        elif action == 'stop':
            # Windows 由父进程 Job 处理；Linux 宿主独占 subreaper 后代。
            if not self.children:
                raise ValueError('Windows stop requires parent Job')
            confirmed = self.children.stop()
            self.emit({'id': p['id'], 'ok': confirmed, 'cleanupConfirmed': confirmed})
            return confirmed
        else:
            raise ValueError('invalid host operation')
        self.emit({'id': p['id'], 'ok': True})
        return False


def run_worker() -> int:
    host = Host()
    try:
        while True:
            line = sys.stdin.buffer.readline(FRAME_LIMIT + 1)
            if not line:
                break
            if len(line) > FRAME_LIMIT or not line.endswith(b'\n'):
                raise ValueError('host input limit')
            p = json.loads(line)
            try:
                if host.command(p):
                    return 0
            except (OSError, ValueError, KeyError, TypeError, ImportError):
                # 不回传 argv、环境、输入或原生异常正文。
                host.emit({'id': p.get('id'), 'ok': False, 'reasonCode': 'host_operation_failed'})
    except (OSError, ValueError, BrokenPipeError):
        pass
    finally:
        host.stop_read.set()
        if host.children and not host.children.stop():
            return 2
    return 0
