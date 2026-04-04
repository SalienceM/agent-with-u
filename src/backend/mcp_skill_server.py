"""
MCP Skill Server: 为 CLI 类 backend（ClaudeAgent/ClaudeCode）提供 Backend Skill 能力。

工作原理：
  - 作为 MCP stdio server 运行，由 Claude CLI 子进程通过 --mcp-config 启动
  - 接收 --skills-json 参数，包含各 Backend Skill 的工具定义和目标 backend 配置
  - 当 Claude 调用 Backend Skill 工具时，实例化目标 backend 并执行
  - 将执行结果（累积的文本）返回给 Claude

使用方式（由 bridge_ws 自动生成 MCP 配置）：
  python <this_file> --skills-json '<json>'
"""

import asyncio
import json
import sys
import os
from typing import Optional


# ── 全局状态 ──────────────────────────────────────────────────────

_skills: list[dict] = []
# 格式: [{"name": "...", "description": "...", "input_schema": {...},
#          "backend_config": {...(ModelBackendConfig 序列化)}}]


def _create_target_backend(backend_config_dict: dict):
    """从序列化的配置字典创建 backend 实例。"""
    # 延迟导入，确保 PYTHONPATH 已设置
    from src.types import ModelBackendConfig, BackendType
    from src.backend.factory import create_backend

    config = ModelBackendConfig(
        id=backend_config_dict["id"],
        type=BackendType(backend_config_dict["type"]),
        label=backend_config_dict.get("label", ""),
        base_url=backend_config_dict.get("baseUrl"),
        model=backend_config_dict.get("model"),
        api_key=backend_config_dict.get("apiKey"),
        working_dir=backend_config_dict.get("workingDir"),
        allowed_tools=backend_config_dict.get("allowedTools"),
        skip_permissions=backend_config_dict.get("skipPermissions", True),
        env=backend_config_dict.get("env"),
        extra_headers=backend_config_dict.get("extraHeaders"),
        mcp_servers=backend_config_dict.get("mcpServers"),
    )
    return create_backend(config)


async def _execute_skill(skill_def: dict, tool_input: dict) -> str:
    """执行一个 Backend Skill：实例化目标 backend，发送请求，收集结果。"""
    from src.backend.base import StreamDelta

    backend_config = skill_def["backend_config"]
    backend = _create_target_backend(backend_config)

    # 构建发送内容：优先使用 prompt 字段，否则序列化整个 input
    prompt = tool_input.get("prompt", "") or json.dumps(tool_input, ensure_ascii=False)

    result_parts: list[str] = []

    def on_delta(delta: StreamDelta):
        if delta.type == "text_delta" and delta.text:
            result_parts.append(delta.text)

    try:
        await backend.send_message(
            messages=[],
            content=prompt,
            images=None,
            session_id="mcp-skill-exec",
            message_id="mcp-skill-msg",
            on_delta=on_delta,
        )
    except Exception as e:
        return f"Backend execution error: {e}"

    result = "".join(result_parts)
    return result if result else "(no output)"


async def handle_request(req: dict) -> Optional[dict]:
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
        for s in _skills:
            mcp_tools.append({
                "name": s["name"],
                "description": s.get("description", ""),
                "inputSchema": s.get("input_schema", {"type": "object", "properties": {}}),
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

        # 查找对应的 skill 定义
        skill_def = next((s for s in _skills if s["name"] == tool_name), None)
        if not skill_def:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Unknown skill: {tool_name}"}],
                    "isError": True,
                },
            }

        try:
            result_text = await _execute_skill(skill_def, tool_args)
        except Exception as e:
            result_text = f"Error executing backend skill '{tool_name}': {e}"

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [{"type": "text", "text": result_text}],
            },
        }

    # 未知方法 — 返回 error
    if req_id is not None:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    return None  # notification


async def main():
    """MCP stdio 主循环。"""
    global _skills

    # 解析命令行参数
    import argparse
    parser = argparse.ArgumentParser(description="MCP Backend Skill Server")
    parser.add_argument("--skills-json", type=str, required=True,
                        help="JSON array of skill definitions with backend configs")
    args = parser.parse_args()

    _skills = json.loads(args.skills_json)

    print(f"[MCP Skill Server] Started with {len(_skills)} skills: "
          f"{[s['name'] for s in _skills]}", file=sys.stderr, flush=True)

    # MCP stdio 协议：从 stdin 读 JSON-RPC，写到 stdout
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
        line_str = line.decode("utf-8").strip()
        if not line_str:
            continue
        try:
            req = json.loads(line_str)
        except json.JSONDecodeError:
            continue

        response = await handle_request(req)
        if response is not None:
            out = json.dumps(response, ensure_ascii=False) + "\n"
            writer.write(out.encode("utf-8"))
            await writer.drain()


if __name__ == "__main__":
    asyncio.run(main())
