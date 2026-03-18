"""
PyInstaller entry point for the WebSocket backend sidecar.

This file exists because PyInstaller needs a plain script (not a package module).
It simply delegates to ws_main.main().
"""
import asyncio
import sys
import os

# Ensure the project root is on sys.path so `src.*` imports work
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.ws_main import main

if __name__ == "__main__":
    asyncio.run(main())
