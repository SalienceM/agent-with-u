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
    root.setLevel(logging.DEBUG)

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


async def main():
    log_file = setup_logging()
    logging.info(f"[ws_main] Log file: {log_file}")
    patch_npm_path()
    load_claude_settings()
    ClipboardHandler.cleanup_old_temp_files()

    cli_path = find_bundled_claude()
    bridge = BridgeWS(cli_path=cli_path)

    print(f"[ws_main] Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}", file=sys.stderr, flush=True)

    async with websockets.serve(bridge.handle_client, WS_HOST, WS_PORT):
        print(f"[ws_main] Ready.", file=sys.stderr, flush=True)
        await asyncio.Future()  # 永久运行直到进程被终止


if __name__ == "__main__":
    asyncio.run(main())
