"""PyInstaller-safe entry point for the standalone Relay binary."""

import asyncio

from src.relay_server import _main


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass

