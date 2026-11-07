"""锁定 SDK 的唯一私有接缝：启动、单 reader、有界队列与归属退出。

不修改全局 subprocess/SDK；SDK 缺失不影响其他 Backend 的 import/factory。
"""
from __future__ import annotations

import importlib.metadata
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .deepseek_harness_config import VERSION
from .deepseek_harness_state import reject_links
from .owned_process_tree import OwnedProcessTree
from .deepseek_harness_images import MAX_FRAME_BYTES, MAX_PENDING_BYTES, check_request_budget, encode_frame

MAX_NOTIFICATIONS = 256


class _QueuedNotification:
    def __init__(self, value: Any, size: int) -> None:
        self.value, self.size = value, size


class NotificationBudgetQueue(queue.Queue):
    """保留 SDK 的 Queue 接口；计量与入队/出队共用同一把锁。"""
    def __init__(self) -> None:
        super().__init__(maxsize=MAX_NOTIFICATIONS)
        self._pending_bytes = 0

    def put_sized(self, notification: Any, frame_bytes: int) -> None:
        self.put_nowait(_QueuedNotification(notification, frame_bytes))

    @property
    def pending_bytes(self) -> int:
        with self.mutex:
            return self._pending_bytes

    def _put(self, item: Any) -> None:
        if not isinstance(item, _QueuedNotification):
            item = _QueuedNotification(item, len(encode_frame({"jsonrpc": "2.0", "method": item.method, "params": item.payload})))
        if not 0 < item.size <= MAX_FRAME_BYTES or self._pending_bytes + item.size > MAX_PENDING_BYTES:
            raise queue.Full
        super()._put(item)
        self._pending_bytes += item.size

    def _get(self) -> Any:
        item = super()._get()
        self._pending_bytes -= item.size
        return item.value


def bridge_path(*, require_images: bool = False) -> Path:
    from .deepseek_harness_distribution import bundle_directory, verify_image_bridge
    path = bundle_directory() / "bridge/lib/index.mjs"
    if not path.is_file():
        raise RuntimeError("缺少版本匹配的 Harness AWU 桥；请准备发行依赖，不会在聊天时下载")
    if require_images:
        verify_image_bridge(path)
    return path.resolve()


class SyncOwner:
    def __init__(self, *, generation: str, receipt: Path) -> None:
        self.generation = generation
        self.receipt = receipt
        self.process: subprocess.Popen[str] | None = None
        self.tree: OwnedProcessTree | None = None
        self.spawn_attempted = False
        self.confirmed = False
        self._process_exit_confirmed = False
        self.cancelled = threading.Event()

    def spawn(self, args: list[str], *, cwd: str | None, env: dict[str, str]) -> subprocess.Popen[str]:
        if self.spawn_attempted:
            raise RuntimeError("Harness 归属对象不能重复启动")
        self.spawn_attempted = True
        if self.cancelled.is_set():
            self.confirmed = True
            raise RuntimeError("Harness 启动前已取消")
        flags = 0
        if os.name == "nt":
            flags = subprocess.CREATE_NO_WINDOW | 0x00000004  # CREATE_SUSPENDED
        elif sys.platform == "linux":
            helper = ([sys.executable, "--agentwithu-harness-supervisor"] if getattr(sys, "frozen", False)
                      else [sys.executable, str(Path(__file__).with_name("deepseek_harness_supervisor.py"))])
            args = [*helper, str(self.receipt), self.generation, str(os.getpid()), "--", *args]
        else:
            self.confirmed = True
            raise RuntimeError("Harness 归属清理尚未验证此平台")
        try:
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding="utf-8", errors="strict", cwd=cwd, env=env,
                                    bufsize=1, creationflags=flags, start_new_session=os.name != "nt")
        except OSError:
            self.confirmed = True  # OS 明确未创建进程；与引用意外缺失不同。
            raise
        self.process = proc
        if os.name == "nt":
            try:
                self.tree = OwnedProcessTree(proc, suspended_root=True)
                if not self.tree.complete or not self.tree.job:
                    raise RuntimeError("Harness 启动前无法取得 Windows Job 归属")
                if self.cancelled.is_set():
                    raise RuntimeError("Harness Job 内恢复前已取消")
                import ctypes
                from ctypes import wintypes
                resume = ctypes.WinDLL("ntdll").NtResumeProcess
                resume.argtypes, resume.restype = [wintypes.HANDLE], ctypes.c_long
                if resume(int(proc._handle)) != 0:
                    raise RuntimeError("Harness 挂起进程无法在 Job 内恢复")
            except BaseException:
                proc.kill()
                proc.wait(timeout=3)
                # 尚未恢复主线程，不可能派生后代。
                self.confirmed = True
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream:
                        stream.close()
                if self.tree:
                    self.tree.release()
                raise
        elif self.cancelled.is_set():
            self.terminate()
        return proc

    def terminate(self) -> None:
        self.cancelled.set()
        proc = self.process
        if not proc:
            return
        if self.tree and self.tree.job:
            self.tree.kernel.TerminateJobObject(self.tree.job, 1)
        elif sys.platform == "linux" and proc.poll() is None:
            proc.terminate()  # supervisor 收养/kill/reap 后代；不 SIGKILL supervisor。

    def settle(self, timeout: float = 7) -> bool:
        if self.confirmed or self._process_exit_confirmed:
            # Job/监督进程已经给出的退出证明不可因 reader 较慢而丢失；
            # 完整 confirmed 仍由 close 的线程收口检查约束，不据此释放活动保护。
            self.confirmed = True
            return True
        proc = self.process
        if proc is None:
            return False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return False
        if self.tree:
            deadline = time.monotonic() + 2
            while not self.tree.exit_confirmed() and time.monotonic() < deadline:
                time.sleep(.02)
            self.confirmed = self.tree.exit_confirmed()
            if self.confirmed:
                self._process_exit_confirmed = True
                self.tree.release()
        elif sys.platform == "linux":
            reject_links(self.receipt)
            if self.receipt.exists() and self.receipt.stat().st_size < 4096:
                data = json.loads(self.receipt.read_text(encoding="utf-8"))
                self.confirmed = (data.get("generation") == self.generation
                                  and data.get("supervisorPid") == proc.pid
                                  and data.get("exitConfirmed") is True)
                self._process_exit_confirmed = self.confirmed
        return self.confirmed


def require_locked_versions(*, runtime: bool = False) -> None:
    distributions = ("deepseek-harness-sdk", "deepseek-harness-runtime-bin") if runtime else ("deepseek-harness-sdk",)
    for distribution in distributions:
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError as exc:
            raise RuntimeError("缺少锁定的 Harness SDK/runtime；请安装配套发行依赖") from exc
        if version != VERSION:
            raise RuntimeError("Harness SDK/runtime 版本不匹配，禁止混配或自动降级")


def create_harness_config(**kwargs: Any) -> Any:
    require_locked_versions()
    if getattr(sys, "frozen", False):
        from .deepseek_harness_distribution import verify_adapter
        verify_adapter()
    from deepseek_harness.client import HarnessConfig
    return HarnessConfig(**kwargs)


def default_model() -> str:
    require_locked_versions()
    from deepseek_harness.api import DeepSeekHarnessConfig
    return DeepSeekHarnessConfig().model


def create_client(*, config: Any, owner: SyncOwner, launch_args: tuple[str, ...] | None = None) -> Any:
    require_locked_versions()
    from deepseek_harness.client import HarnessClient
    from deepseek_harness.errors import SdkProtocolError, TransportClosedError
    from deepseek_harness.models import Notification

    class OwnedClient(HarnessClient):
        def __init__(self) -> None:
            super().__init__(config, _launch_args=launch_args)
            self._notifications = NotificationBudgetQueue()
            self.fatal: BaseException | None = None
            self.closing = False
            self.owner = owner

        def start(self) -> None:
            if self._proc is not None:
                raise RuntimeError("Harness client 不能重复启动")
            env = os.environ.copy()
            # 固定内部运行变量，不继承用户其他 Harness/Node 安装的注入配置。
            for key in list(env):
                if key.startswith("DSH_") or key in {"NODE_OPTIONS", "NODE_PATH"}:
                    env.pop(key)
            env.update(self.config.env or {})
            if self._launch_args is not None:
                args = list(self._launch_args)  # 显式内部测试接缝，不来自聊天参数。
            elif self.config.dsh_bin and Path(self.config.dsh_bin).name.startswith("deepseek-harness-sdk-runtime-"):
                from .deepseek_harness_distribution import verify_runtime_override
                selected = verify_runtime_override(Path(self.config.dsh_bin))
                args = [str(selected), "--profile", self.config.profile]
                for overlay in self.config.patches:
                    args.extend(("--patch", overlay))
            elif self.config.dsh_bin or getattr(sys, "frozen", False):
                from .deepseek_harness_cli import resolve_external_cli
                selected = resolve_external_cli(self.config.dsh_bin, environment=env)
                args = list(selected.argv(self.config.profile, self.config.patches))
            else:
                # 旧源码/Docker 配套模式；冻结默认绝不进入这一分支。
                from .deepseek_harness_distribution import verify_bundle
                require_locked_versions(runtime=True)
                verify_bundle()
                args = list(self._default_launch_args(env))
            if self.config.dsh_home:
                env["DSH_HOME"] = self.config.dsh_home
            env.update(DSH_TELEMETRY_DISABLED="1", DSH_PRIMARY_RUNTIME="", DSH_BUNDLED_OFFICE_CLI="")
            self._proc = owner.spawn(args, cwd=self.config.cwd, env=env)
            self._start_reader_thread()
            self._start_stderr_thread()

        def _runtime_diagnostics(self) -> str:
            # 上游 stderr 可能有 URL、环境或凭据；从不拼入用户错误。
            return ""

        def _reader_loop(self) -> None:
            try:
                while self._proc and self._proc.stdout:
                    # 单 reader 直接读取底层 bytes，不能先读取 16 MiB 字符再扩成 64 MiB。
                    line = self._proc.stdout.buffer.readline(MAX_FRAME_BYTES + 1)
                    if not line:
                        break
                    if not line.endswith(b"\n") or len(line) > MAX_FRAME_BYTES:
                        raise RuntimeError("Harness 协议帧超出限额或被截断")
                    message = json.loads(line.decode("utf-8", errors="strict"))
                    if not isinstance(message, dict):
                        raise RuntimeError("Harness 协议帧不是对象")
                    self._handle_message(message, frame_bytes=len(line))
            except BaseException:
                self._fail_waiters(SdkProtocolError("Harness 协议读取失败"))
            finally:
                self._fail_waiters(TransportClosedError("Harness 协议连接已关闭"))

        def _stderr_loop(self) -> None:
            try:
                while self._proc and self._proc.stderr and self._proc.stderr.readline(8192):
                    pass  # 消费但不保留未经脱敏的原始诊断。
            except (OSError, ValueError, UnicodeError):
                pass

        def _handle_message(self, message: object, *, frame_bytes: int | None = None) -> None:
            if not isinstance(message, dict):
                raise RuntimeError("Harness 无效协议对象")
            method = message.get("method")
            if isinstance(method, str):
                if "id" in message:
                    raise RuntimeError("Harness 不支持未声明的反向 RPC")
                payload = message.get("params")
                if not isinstance(payload, dict):
                    raise RuntimeError("Harness 通知缺少 params")
                try:
                    self._notifications.put_sized(Notification(method=method, payload=payload),
                        frame_bytes if frame_bytes is not None else len(encode_frame(message)))
                except queue.Full as exc:
                    raise RuntimeError("Harness 事件队列溢出，运行失败") from exc
            else:
                super()._handle_message(message)

        def _fail_waiters(self, exc: BaseException) -> None:
            self.fatal = self.fatal or exc
            with self._lock:
                waiters = list(self._responses.values())
                self._responses.clear()
            for waiter in waiters:
                try:
                    waiter.put_nowait(exc)
                except queue.Full:
                    pass

        def _write_message(self, message: dict) -> None:
            if self.fatal:
                raise self.fatal
            frame = encode_frame(message)
            if len(frame) > MAX_FRAME_BYTES:
                raise ValueError("Harness 输入超出协议限额")
            if message.get("method") == "session/prompt":
                check_request_budget(message)
            proc = self._proc
            if proc is None or proc.stdin is None:
                raise TransportClosedError("Harness 协议连接未启动")
            try:
                with self._write_lock:
                    # 不调用 SDK 的 ensure_ascii 序列化，也不经过 Windows 文本换行转换。
                    proc.stdin.buffer.write(frame)
                    proc.stdin.buffer.flush()
            except (OSError, ValueError):
                raise TransportClosedError("Harness 协议写入失败") from None

        def next_owned_notification(self, timeout: float = .1) -> Any:
            try:
                return self._notifications.get_nowait()
            except queue.Empty:
                pass
            if self.fatal:
                raise self.fatal
            return self._notifications.get(timeout=timeout)

        def close(self) -> None:
            self.closing = True
            proc = self._proc
            if proc is None:
                return
            from pydantic import BaseModel
            class Empty(BaseModel):
                pass

            def shutdown() -> None:
                try:
                    self.request("shutdown", None, response_model=Empty, timeout_seconds=1)
                except BaseException:
                    pass

            closer = threading.Thread(target=shutdown, name="awu-dsh-shutdown", daemon=True)
            closer.start()
            closer.join(timeout=1.2)
            try:
                proc.wait(timeout=.5)
            except subprocess.TimeoutExpired:
                owner.terminate()
            if not owner.settle():
                # root 正常退出仍可能遗留 shell/MCP 后代；只升级终止已拥有的 Job/树。
                owner.terminate()
                if not owner.settle():
                    return  # 保留进程引用/reader/归属；调用方不能释放 reservation。
            for thread in (closer, self._reader_thread, self._stderr_thread):
                if thread and thread is not threading.current_thread():
                    thread.join(timeout=1)
            if any(thread and thread.is_alive() for thread in (closer, self._reader_thread, self._stderr_thread)):
                owner.confirmed = False
                return
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream:
                    stream.close()
            self._proc = None

    return OwnedClient()
