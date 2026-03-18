"""
PyInstaller entry point for the WebSocket backend sidecar.

IMPORTANT: This file must stay at the project ROOT (not inside src/).
PyInstaller automatically adds the entry script's directory to sys.path.
Placing this inside src/ would shadow the stdlib 'types' module with src/types.py.
"""
import asyncio
import sys
import os
from pathlib import Path

# 将 stderr 输出到日志文件，方便在 Tauri sidecar 模式下排查问题
# 日志路径：~/.agent-with-u/backend.log
_log_dir = Path.home() / ".agent-with-u"
_log_dir.mkdir(parents=True, exist_ok=True)
_log_file = open(_log_dir / "backend.log", "a", encoding="utf-8", buffering=1)
sys.stderr = _log_file
sys.stdout = _log_file

from src.ws_main import main

if __name__ == "__main__":
    asyncio.run(main())
