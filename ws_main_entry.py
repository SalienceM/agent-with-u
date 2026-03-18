"""
PyInstaller entry point for the WebSocket backend sidecar.

IMPORTANT: This file must stay at the project ROOT (not inside src/).
PyInstaller automatically adds the entry script's directory to sys.path.
Placing this inside src/ would shadow the stdlib 'types' module with src/types.py.
"""
import asyncio

from src.ws_main import main

if __name__ == "__main__":
    asyncio.run(main())
