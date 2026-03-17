"""PyInstaller entry point for the WebSocket backend sidecar."""
import asyncio
from src.ws_main import main

if __name__ == "__main__":
    asyncio.run(main())
