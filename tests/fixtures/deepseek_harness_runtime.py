"""固定 rc.3 JSON-RPC 边界的离线假进程；绝不执行模型/命令或连接网络。"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--scenario", choices=("normal", "malformed-end", "missing-end", "crash", "slow", "oversize", "flood", "tree", "bad-cap", "no-cap", "error", "aborted", "blocked", "max-tokens", "child", "auth"), default="normal")
    parser.add_argument("--identity-patch", type=Path)
    args = parser.parse_args()
    state: dict[str, int] = json.loads(args.state.read_text()) if args.state.exists() else {}
    seq = 0
    identity = {}
    if args.identity_patch:
        rows = json.loads(args.identity_patch.read_text(encoding="utf-8"))
        identity = next(row["insert"][0]["config"] for row in rows if "insert" in row)

    def emit(frame: dict[str, Any]) -> None:
        print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

    def notify(method: str, params: dict[str, Any]) -> None:
        emit({"method": method, "params": params})

    def event(session_id: str, kind: str, data: dict[str, Any]) -> None:
        nonlocal seq
        notify("session.event", {"sessionId": session_id,
               "event": {"type": kind, "seq": seq, "time": 0, "data": data}})
        seq += 1

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request["id"]
        method = request["method"]
        params = request.get("params") or {}
        session_id = params.get("sessionId", "")
        if method == "initialize":
            if args.scenario == "auth":
                emit({"id": request_id, "error": {"code": -32000,
                      "message": "HTTP 401 invalid API key " + os.environ.get("DEEPSEEK_API_KEY", "")}})
                continue
            if args.scenario == "tree":
                child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                                         start_new_session=os.name != "nt")
                args.state.with_suffix(".child").write_text(str(child.pid))
            emit({"id": request_id, "result": {"serverInfo": {"name": "awu-test-fixture", "version": "0.2.1-rc.3"}}})
            if args.scenario == "oversize":
                print("x" * (1024 * 1024 + 5), flush=True)
            if args.scenario == "flood":
                for _index in range(1000):
                    notify("session.status", {"sessionId": "flood", "status": "running"})
        elif method == "awu/capabilities":
            if args.scenario == "no-cap":
                emit({"id": request_id, "error": {"code": -32601, "message": "not supported"}})
            else:
                emit({"id": request_id, "result": {**identity, "protocolVersion": 99 if args.scenario == "bad-cap" else 1,
                      "runtimeVersion": "0.2.1-rc.3", "sourceCommit": "1f81c047fc48fa190a683e469daa699857e9afe8",
                      "realtime": True, "approvals": True}})
        elif method == "awu/configure":
            emit({"id": request_id, "result": {}})
        elif method == "session/resume":
            if session_id not in state:
                emit({"id": request_id, "error": {"code": -32000, "message": "session not found"}})
            else:
                emit({"id": request_id, "result": {}})
        elif method == "session/prompt":
            if not isinstance(params.get("contentBlocks"), list):
                emit({"id": request_id, "error": {"code": -32602, "message": "contentBlocks required"}})
                continue
            message_id = "fixture-input-" + str(state.get(session_id, 0) + 1)
            emit({"id": request_id, "result": {"messageId": message_id}})
            # Receipt 之前的 idle 必须被 SDK 忽略，不能提前终结本次输入。
            notify("session.status", {"sessionId": session_id, "status": "idle"})
            event(session_id, "agent/inbox/spliced", {"inserted": [{"id": message_id}]})
            notify("session.status", {"sessionId": session_id, "status": "running"})
            if args.scenario == "slow":
                time.sleep(0.15)
            state[session_id] = state.get(session_id, 0) + 1
            args.state.write_text(json.dumps(state), encoding="utf-8")
            event(session_id, "assistant/message", {"message": {"id": "fixture-output", "role": "assistant",
                  "content": [{"type": "text", "text": f"reply-{state[session_id]}"}]}, "stream": []})
            if args.scenario == "child":
                notify("subagent.started", {"parentSessionId": session_id, "childSessionId": "fixture-child"})
            if args.scenario == "crash":
                return
            if args.scenario != "missing-end":
                reason = args.scenario if args.scenario in {"error", "aborted", "blocked", "max-tokens"} else "completed"
                event(session_id, "turn/end", {} if args.scenario == "malformed-end" else {"reason": {"kind": reason}})
            notify("session.status", {"sessionId": session_id, "status": "idle"})
        elif method == "session/wait":
            if args.scenario == "child":
                time.sleep(.2)
                notify("subagent.finished", {"parentSessionId": session_id, "childSessionId": "fixture-child",
                       "status": "ok", "stopReason": {"kind": "completed"}})
            emit({"id": request_id, "result": {}})
        elif method == "shutdown":
            emit({"id": request_id, "result": {}})
            return
        else:
            emit({"id": request_id, "error": {"code": -32601, "message": "unsupported fixture method"}})


if __name__ == "__main__":
    main()
