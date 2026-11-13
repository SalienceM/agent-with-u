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
    parser.add_argument("--scenario", choices=("normal", "malformed-end", "missing-end", "crash", "slow", "oversize", "large-frame", "unterminated", "flood", "tree", "bad-cap", "no-cap", "error", "aborted", "blocked", "max-tokens", "child", "auth",
        "http-401", "http-403", "http-404", "http-429", "http-503", "stale-end", "child-end", "duplicate-end",
        "continuation", "continuation-error", "continuation-recovery", "continuation-missing-end",
        "continuation-wrong-end", "continuation-repeated-start", "continuation-stall", "duplicate-new-seq",
        "wait-stall", "compaction"), default="normal")
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

    def event(session_id: str, kind: str, data: dict[str, Any], **metadata: Any) -> None:
        nonlocal seq
        notify("session.event", {"sessionId": session_id,
               "event": {"type": kind, "seq": seq, "time": 0, "data": data, **metadata}})
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
                print("x" * (16 * 1024 * 1024 + 5), flush=True)
            if args.scenario == "large-frame":
                notify("fixture.large", {"value": "x" * (2 * 1024 * 1024)})
            if args.scenario == "unterminated":
                sys.stdout.write("x" * (16 * 1024 * 1024 + 1))
                sys.stdout.flush()
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
            event(session_id, "turn/start", {"turn": 14})
            notify("session.status", {"sessionId": session_id, "status": "running"})
            if args.scenario == "compaction":
                event(session_id, "compaction/prune", {"shadowedRange": {"start": 0, "end": 0},
                    "shadowedSeqs": [0], "shadowedTokenCount": 100})
                # 来源位于本轮 receipt 之前，不会在本次订阅中出现对应的 tool/call。
                event(session_id, "tool/result", {"turn": 1, "step": 1, "message": {
                    "role": "tool", "id": "historic-result", "toolCallId": "historic-call", "isError": False,
                    "content": [{"type": "text", "text": "pruned historic output"}]}},
                    surfaceOp={"op": "replace", "startSeq": 0, "endSeq": 0}, sourceEventSeqs=[0])
            if args.scenario == "slow":
                time.sleep(0.15)
            state[session_id] = state.get(session_id, 0) + 1
            args.state.write_text(json.dumps(state), encoding="utf-8")
            event(session_id, "assistant/message", {"message": {"id": "fixture-output", "role": "assistant",
                  "content": [{"type": "text", "text": f"reply-{state[session_id]}"}]}, "stream": []})
            if args.scenario == "child":
                notify("subagent.started", {"parentSessionId": session_id, "childSessionId": "fixture-child"})
            if args.scenario == "stale-end":
                notify("session.event", {"sessionId": session_id, "event": {"type": "turn/end", "seq": 0,
                    "data": {"reason": {"kind": "error", "error": {"code": "AUTH", "status": 401}}}}})
            if args.scenario == "child-end":
                notify("subagent.started", {"parentSessionId": session_id, "childSessionId": "fixture-child"})
                event("fixture-child", "turn/end", {"reason": {"kind": "error", "error": {"status": 401}}})
                notify("subagent.finished", {"parentSessionId": session_id, "childSessionId": "fixture-child",
                    "status": "error", "stopReason": {"kind": "error"}})
            if args.scenario == "crash":
                return
            if args.scenario != "missing-end":
                reason = args.scenario if args.scenario in {"error", "aborted", "blocked", "max-tokens"} else "completed"
                end = {"kind": reason}
                if args.scenario == "continuation-recovery":
                    end = {"kind": "error", "error": {"status": 429}}
                if args.scenario.startswith("http-"):
                    end = {"kind": "error", "error": {"status": int(args.scenario[5:]), "code": "INVALID_REQUEST",
                        "message": "PRIVATE_PROVIDER_BODY " + os.environ.get("DEEPSEEK_API_KEY", ""),
                        "requestId": "PRIVATE_PROVIDER_REQUEST", "url": "https://fixture.invalid/?token=PRIVATE"}}
                event(session_id, "turn/end", {"turn": 14} if args.scenario == "malformed-end" else {"turn": 14, "reason": end})
                if args.scenario == "duplicate-end":
                    notify("session.event", {"sessionId": session_id, "event": {"type": "turn/end", "seq": seq - 1,
                        "data": {"reason": {"kind": "error", "error": {"status": 401}}}}})
                if args.scenario == "duplicate-new-seq":
                    event(session_id, "turn/end", {"turn": 14, "reason": end})
            notify("session.status", {"sessionId": session_id, "status": "idle"})
        elif method == "session/wait":
            if args.scenario == "wait-stall":
                continue
            if args.scenario.startswith("continuation"):
                # rc.3 原生 goal 在短暂 idle 后自行续跑；不需要第二次 session/prompt。
                for turn in (15, 16):
                    event(session_id, "agent/inbox/spliced", {"target": "next-turn", "inserted": [
                        {"id": f"fixture-goal-{turn}", "source": {"kind": "goal"}}]})
                    event(session_id, "turn/start", {"turn": turn})
                    notify("session.status", {"sessionId": session_id, "status": "running"})
                    if args.scenario == "continuation-repeated-start":
                        event(session_id, "turn/start", {"turn": turn})
                    event(session_id, "assistant/message", {"message": {"id": f"fixture-output-{turn}",
                        "role": "assistant", "content": [{"type": "text", "text": f"continued-{turn}"}]}, "stream": []})
                    time.sleep(.3)
                    if args.scenario == "continuation-stall":
                        break
                    end = ({"kind": "error", "error": {"status": 503}}
                           if args.scenario == "continuation-error" else {"kind": "completed"})
                    if args.scenario != "continuation-missing-end":
                        event(session_id, "turn/end", {"turn": 14 if args.scenario == "continuation-wrong-end" else turn,
                            "reason": end})
                    notify("session.status", {"sessionId": session_id, "status": "idle"})
                if args.scenario == "continuation-stall":
                    continue
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
