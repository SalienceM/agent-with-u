"""
Claude Shell — Entry point.

Usage:
    python -m src.main          # production (loads frontend/dist)
    python -m src.main --dev    # dev mode (loads from Vite dev server)
"""

import asyncio
import json
import os
import sys
import threading
from pathlib import Path

from PySide6.QtWidgets import QApplication

from .backend.bridge import Bridge
from .backend.clipboard import ClipboardHandler
from .gui.main_window import MainWindow


def load_claude_settings():
    """
    Auto-load env vars from ~/.claude/settings.json
    This is how Claude Code stores its config (including Coding Plan credentials).
    
    Reads the "env" block and sets them as environment variables, e.g.:
      ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL
    
    Also copies ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY if API_KEY is not set,
    because the Agent SDK looks for ANTHROPIC_API_KEY.
    """
    settings_path = Path.home() / ".claude" / "settings.json"
    if not settings_path.exists():
        print(f"[claude-shell] No settings found at {settings_path}")
        return

    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
        env_vars = data.get("env", {})
        for key, value in env_vars.items():
            if key not in os.environ:  # Don't override explicitly set vars
                os.environ[key] = str(value)
                print(f"[claude-shell] Loaded from settings.json: {key}={'***' if 'TOKEN' in key or 'KEY' in key else value}")

        # Agent SDK needs ANTHROPIC_API_KEY — copy from AUTH_TOKEN if not set
        if "ANTHROPIC_API_KEY" not in os.environ and "ANTHROPIC_AUTH_TOKEN" in os.environ:
            os.environ["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_AUTH_TOKEN"]
            print("[claude-shell] Copied ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY")

    except Exception as e:
        print(f"[claude-shell] Failed to load settings.json: {e}")


def run_async_loop(loop: asyncio.AbstractEventLoop):
    """Run asyncio event loop in a background thread."""
    asyncio.set_event_loop(loop)
    loop.run_forever()


def main():
    dev_mode = "--dev" in sys.argv
    
    # ========== 加这段 ==========
    # Windows 下 Python subprocess 找不到 npm 全局命令，手动补 PATH
    if sys.platform == "win32":
        npm_bin = os.path.join(os.environ.get("APPDATA", ""), "npm")
        if npm_bin and npm_bin not in os.environ.get("PATH", ""):
            os.environ["PATH"] = npm_bin + os.pathsep + os.environ.get("PATH", "")
            print(f"[claude-shell] Added npm to PATH: {npm_bin}")
    # ========== 加到这里 ==========
    
    # Load Claude Code settings (Coding Plan credentials, etc.)
    load_claude_settings()

    # ★ 清理超过 24 小时的临时图片文件
    ClipboardHandler.cleanup_old_temp_files()

    # Create Qt application
    app = QApplication(sys.argv)
    app.setApplicationName("Claude Shell")
    app.setOrganizationName("MasterMu")

    # Apply global dark stylesheet
    app.setStyleSheet("""
        QMainWindow {
            background-color: #1a1a2e;
        }
    """)

    # Create asyncio event loop in background thread
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=run_async_loop, args=(loop,), daemon=True)
    thread.start()

    # Create bridge and connect event loop
    bridge = Bridge()
    bridge.set_event_loop(loop)

    # Create and show window
    window = MainWindow(bridge, dev_mode=dev_mode)
    window.show()

    # Run Qt event loop
    exit_code = app.exec()

    # ★ Cleanup: Save session index before exit
    bridge._session_store._save_index_sync()

    # Cleanup asyncio loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=2)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
