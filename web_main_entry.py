"""PyInstaller entry point for the authenticated portable web binary."""

import asyncio
import os
import sys

from src.ws_main import main


if __name__ == "__main__":
    if "--web" not in sys.argv:
        sys.argv.append("--web")
    if "--bind" not in sys.argv and not os.environ.get("AGENT_WITH_U_BIND"):
        sys.argv.extend(["--bind", "0.0.0.0"])
    asyncio.run(main())
