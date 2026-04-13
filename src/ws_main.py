"""
AgentWithU — WebSocket server 入口（Tauri sidecar 模式）。

Tauri 启动时自动拉起此进程，前端通过 ws://127.0.0.1:44321 连接。

独立运行（开发调试）：
    python -m src.ws_main
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

import websockets

from .backend.bridge_ws import BridgeWS
from .backend.clipboard import ClipboardHandler

try:
    from ._version import __version__ as APP_VERSION
except Exception:
    APP_VERSION = "0.0.0-dev"

WS_HOST = "127.0.0.1"
WS_PORT = 44321


def setup_logging() -> Path:
    """
    把日志同时输出到文件和 stderr。
    日志文件：%APPDATA%/AgentWithU/logs/backend.log（Windows）
              ~/.agent-with-u/logs/backend.log（其他平台）
    只保留最近 1 MB，超出后轮转 3 份。
    """
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home())) / "AgentWithU"
    else:
        base = Path.home() / ".agent-with-u"
    log_dir = base / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "backend.log"

    from logging.handlers import RotatingFileHandler

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    # 第三方库日志降噪
    for noisy in ("websockets", "httpx", "httpcore", "urllib3", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    fh = RotatingFileHandler(log_file, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)

    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    root.addHandler(sh)

    # 把裸 print(..., file=sys.stderr) 也重定向到 logging
    class _StderrToLog:
        def write(self, msg: str):
            msg = msg.rstrip()
            if msg:
                logging.info(msg)
        def flush(self): pass

    sys.stderr = _StderrToLog()  # type: ignore[assignment]

    return log_file


def find_bundled_claude() -> Optional[str]:
    """
    自动寻找可用的 claude CLI 路径，优先级：
    1. PyInstaller 打包环境：sys._MEIPASS 下的 claude/claude.exe
    2. claude_agent_sdk 内置路径（SDK 自带 CLI）
    3. None（交给 SDK 自己去 PATH 里找）
    """
    exe = "claude.exe" if sys.platform == "win32" else "claude"

    # ── 1. PyInstaller frozen 环境 ──
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidate = Path(meipass) / exe
        if candidate.exists():
            print(f"[ws_main] Using bundled claude: {candidate}", file=sys.stderr)
            return str(candidate)

    # ── 2. claude_agent_sdk 包内置路径 ──
    try:
        import claude_agent_sdk
        sdk_dir = Path(claude_agent_sdk.__file__).parent
        # 常见子目录：bin/, cli/, _bin/
        for sub in ("bin", "cli", "_bin", "."):
            candidate = sdk_dir / sub / exe
            if candidate.exists():
                print(f"[ws_main] Using SDK-bundled claude: {candidate}", file=sys.stderr)
                return str(candidate)
        # SDK 可能通过 __path__ 暴露多个目录
        for sdk_path in getattr(claude_agent_sdk, "__path__", []):
            for sub in ("bin", "cli", "_bin", "."):
                candidate = Path(sdk_path) / sub / exe
                if candidate.exists():
                    print(f"[ws_main] Using SDK-bundled claude: {candidate}", file=sys.stderr)
                    return str(candidate)
    except Exception:
        pass

    # ── 3. 让 SDK 自己从 PATH 找 ──
    return None


def load_claude_settings():
    """从 ~/.claude/settings.json 自动加载环境变量（与 main.py 相同逻辑）。"""
    settings_path = Path.home() / ".claude" / "settings.json"
    if not settings_path.exists():
        return
    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
        for key, value in data.get("env", {}).items():
            if key not in os.environ:
                os.environ[key] = str(value)
        if "ANTHROPIC_API_KEY" not in os.environ and "ANTHROPIC_AUTH_TOKEN" in os.environ:
            os.environ["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_AUTH_TOKEN"]
    except Exception as e:
        print(f"[ws_main] Failed to load settings.json: {e}", file=sys.stderr)


def patch_npm_path():
    """Windows 下补全 npm 全局路径（与 main.py 相同逻辑）。"""
    if sys.platform == "win32":
        npm_bin = os.path.join(os.environ.get("APPDATA", ""), "npm")
        if npm_bin and npm_bin not in os.environ.get("PATH", ""):
            os.environ["PATH"] = npm_bin + os.pathsep + os.environ.get("PATH", "")


def _get_pid_file(port: int) -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home())) / "AgentWithU"
    else:
        base = Path.home() / ".agent-with-u"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"backend_{port}.pid"


def _kill_pid(pid: int, reason: str) -> bool:
    """发送强制终止信号，返回是否成功。"""
    try:
        if sys.platform == "win32":
            import subprocess
            ret = subprocess.call(
                ["taskkill", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if ret == 0:
                logging.warning(f"[ws_main] Killed PID {pid} ({reason})")
                return True
        else:
            import signal as _signal
            os.kill(pid, _signal.SIGTERM)
            logging.warning(f"[ws_main] Sent SIGTERM to PID {pid} ({reason})")
            return True
    except (ProcessLookupError, PermissionError):
        pass  # 进程已经不存在
    except Exception as e:
        logging.warning(f"[ws_main] Failed to kill PID {pid}: {e}")
    return False


def _is_pid_alive(pid: int) -> bool:
    """检查进程是否还活着。"""
    try:
        if sys.platform == "win32":
            import subprocess
            ret = subprocess.call(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return ret == 0
        else:
            os.kill(pid, 0)  # 发送 signal 0 仅检查存在性
            return True
    except (ProcessLookupError, PermissionError):
        return False
    except Exception:
        return True  # 不确定时保守处理


def _ensure_single_instance(port: int) -> None:
    """
    单实例锁（PID 文件）：
    1. 读旧 PID 文件 → 如果旧进程仍在运行则杀掉，等待端口释放
    2. 写入当前 PID
    3. 注册 atexit 自动清理
    """
    import atexit
    import time

    pid_file = _get_pid_file(port)

    if pid_file.exists():
        try:
            old_pid = int(pid_file.read_text(encoding="utf-8").strip())
            if old_pid != os.getpid() and _is_pid_alive(old_pid):
                logging.info(f"[ws_main] Found running instance PID={old_pid}, terminating it…")
                _kill_pid(old_pid, f"old instance on port {port}")
                # 等待端口真正释放（最多 3s）
                for _ in range(6):
                    time.sleep(0.5)
                    if not _is_pid_alive(old_pid):
                        break
                logging.info(f"[ws_main] Old instance gone, proceeding.")
        except ValueError:
            pass  # PID 文件损坏，直接覆盖
        except Exception as e:
            logging.warning(f"[ws_main] Could not process stale PID file: {e}")

    pid_file.write_text(str(os.getpid()), encoding="utf-8")
    atexit.register(lambda: pid_file.unlink(missing_ok=True))
    logging.info(f"[ws_main] Single-instance lock acquired (PID={os.getpid()}, port={port})")


async def main():
    # 初始化日志系统
    log_file = setup_logging()
    logging.info(f"[ws_main] AgentWithU backend v{APP_VERSION} starting")
    logging.info(f"[ws_main] Log file: {log_file}")

    patch_npm_path()
    load_claude_settings()

    # 单实例保证：杀旧实例 → 写 PID → 绑定端口
    _ensure_single_instance(WS_PORT)

    ClipboardHandler.cleanup_old_temp_files()

    cli_path = find_bundled_claude()
    bridge = BridgeWS(cli_path=cli_path)

    logging.info(f"[ws_main] Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}")
    try:
        server = await websockets.serve(
            bridge.handle_client, WS_HOST, WS_PORT,
            max_size=50 * 1024 * 1024,   # 50MB，支持大图片 base64
            ping_interval=30,             # 每 30 秒发送 ping
            ping_timeout=300,             # 允许 5 分钟无 pong（系统休眠/后台标签页节流）
        )
        # ★ Backend Skill HTTP API（供 SKILL.md 通过 curl 回调）
        http_server = await bridge.start_http_api()
    except OSError as e:
        logging.error(f"[ws_main] Cannot bind port {WS_PORT} even after clearing old instance: {e}")
        sys.exit(1)

    logging.info("[ws_main] Ready.")
    async with server:
        await asyncio.Future()  # 永久运行直到进程被终止


if __name__ == "__main__":
    asyncio.run(main())
