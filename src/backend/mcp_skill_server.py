"""
MCP Skill Server: 为 CLI 类 backend（ClaudeAgent/ClaudeCode）提供 Backend Skill 能力。

工作原理：
  - 作为 MCP stdio server 运行，由 bridge_ws 动态启动
  - 监听来自 Claude CLI 的 tool 调用请求
  - 将请求转发给目标 backend（通过 HTTP 回调到 bridge_ws）
  - 返回执行结果给 Claude CLI

使用方式：
  python -m src.backend.mcp_skill_server --port <bridge_port> --session <session_id>

协议：MCP over stdio (JSON-RPC)
"""

import asyncio
import json
import sys
from typing import Optional

import httpx


# ── 配置 ──────────────────────────────────────────────────────────

_bridge_port: int = 0
_session_id: str = ""
_tools: list[dict] = []


async def handle_request(req: dict) -> dict:
    """处理 MCP JSON-RPC 请求。"""
    method = req.get("method", "")
    req_id = req.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "agent-with-u-backend-skills",
                    "version": "1.0.0",
                },
            },
        }

    if method == "notifications/initialized":
        return None  # notification, no response

    if method == "tools/list":
        mcp_tools = []
        for t in _tools:
            mcp_tools.append({
                "name": t["name"],
                "description": t.get("description", ""),
                "inputSchema": t.get("input_schema", {"type": "object", "properties": {}}),
            })
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": mcp_tools},
        }

    if method == "tools/call":
        params = req.get("params", {})
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})

        try:
            # 回调 bridge_ws 执行 Backend Skill
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"http://127.0.0.1:{_bridge_port}/mcp-skill-call",
                    json={
                        "sessionId": _session_id,
                        "toolName": tool_name,
                        "toolInput": tool_args,
                    },
                )
                result_data = resp.json()
                result_text = result_data.get("result", "(no output)")
        except Exception as e:
            result_text = f"Error executing backend skill: {e}"

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [{"type": "text", "text": result_text}],
            },
        }

    # 未知方法
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


async def main():
    """MCP stdio 主循环。"""
    global _bridge_port, _session_id, _tools

    # 解析命令行参数
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--session", type=str, required=True)
    parser.add_argument("--tools-json", type=str, default="[]")
    args = parser.parse_args()

    _bridge_port = args.port
    _session_id = args.session
    _tools = json.loads(args.tools_json)

    print(f"[MCP Skill Server] Started: port={_bridge_port}, session={_session_id}, "
          f"tools={[t['name'] for t in _tools]}", file=sys.stderr, flush=True)

    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    writer_transport, writer_protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout
    )
    writer = asyncio.StreamWriter(writer_transport, writer_protocol, None, loop)

    while True:
        line = await reader.readline()
        if not line:
            break
        line = line.decode("utf-8").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        response = await handle_request(req)
        if response is not None:
            out = json.dumps(response, ensure_ascii=False) + "\n"
            writer.write(out.encode("utf-8"))
            await writer.drain()


if __name__ == "__main__":
    asyncio.run(main())
