"""PyInstaller entry point for the authenticated portable web binary."""

import asyncio
import os
import sys

if "--agentwithu-update-helper" in sys.argv:
    from src.backend.update_helper import run_update_helper

    _index = sys.argv.index("--agentwithu-update-helper")
    _plan = sys.argv[_index + 1] if _index + 1 < len(sys.argv) else ""
    raise SystemExit(run_update_helper(_plan))

from src.ws_main import main


if __name__ == "__main__":
    if "--web" not in sys.argv:
        sys.argv.append("--web")
    if "--bind" not in sys.argv and not os.environ.get("AGENT_WITH_U_BIND"):
        sys.argv.extend(["--bind", "0.0.0.0"])
    asyncio.run(main())
