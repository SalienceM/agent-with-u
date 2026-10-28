"""离线 MCP stdio fixture；只记录测试事实，不导出环境或凭据。"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--record", required=True)
    args = parser.parse_args()

    def record(value: dict) -> None:
        with open(args.record, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(value) + "\n")

    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=os.name != "nt")
    record({"pid": os.getpid(), "childPid": child.pid, "providerKeyPresent": bool(os.environ.get("DEEPSEEK_API_KEY")),
            "explicitEnv": os.environ.get("MCP_ONLY") == "fixture-value"})
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        method, params = request.get("method"), request.get("params", {})
        if method == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "awu-fixture", "version": "1"}, "instructions": "Local fixture data only."}
        elif method == "tools/list":
            result = {"tools": [{"name": "echo", "description": "Local echo fixture.",
                "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}
        elif method == "tools/call":
            record({"method": method, "name": params.get("name"), "arguments": params.get("arguments")})
            result = {"content": [{"type": "text", "text": "echo:" + params.get("arguments", {}).get("text", "")}]}
        elif method == "ping":
            result = {}
        else:
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "not implemented"}}), flush=True)
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


if __name__ == "__main__":
    main()
