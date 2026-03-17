"""
AgentWithU — WebSocket server 入口（Tauri sidecar 模式）。

Tauri 启动时自动拉起此进程，前端通过 ws://127.0.0.1:44321 连接。

独立运行（开发调试）：
    python -m src.ws_main
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import websockets

from .backend.bridge_ws import BridgeWS
from .backend.clipboard import ClipboardHandler

WS_HOST = "127.0.0.1"
WS_PORT = 44321


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
    patch_npm_path()
    load_claude_settings()
    ClipboardHandler.cleanup_old_temp_files()

    bridge = BridgeWS()

    print(f"[ws_main] Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}", file=sys.stderr, flush=True)

    async with websockets.serve(bridge.handle_client, WS_HOST, WS_PORT):
        print(f"[ws_main] Ready.", file=sys.stderr, flush=True)
        await asyncio.Future()  # 永久运行直到进程被终止


if __name__ == "__main__":
    asyncio.run(main())
