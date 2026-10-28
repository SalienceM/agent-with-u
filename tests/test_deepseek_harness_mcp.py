"""MCP DTO 与真实本地 runtime 连接检查；不连接生产 MCP/模型。"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from src.backend.deepseek_harness_mcp import normalize_servers


class McpConfigTests(unittest.TestCase):
    def test_transports_keep_names_and_credentials_as_protocol_data(self) -> None:
        with tempfile.TemporaryDirectory(prefix="awu-mcp-config-") as temporary:
            raw = {"stdio": {"command": "fixture", "args": ["one two", "$(not-a-shell)"], "env": {"TOKEN": "test-secret"}},
                   "http": {"type": "http", "url": "http://127.0.0.1:1/mcp", "headers": {"Authorization": "Bearer test-secret"}}}
            servers = normalize_servers(raw, cwd=temporary)
            self.assertEqual(servers[0]["args"], raw["stdio"]["args"])
            self.assertEqual(servers[1]["transport"], "streamable-http")
            self.assertTrue(all(server["failOnStartupError"] for server in servers))
            self.assertTrue(all(server["reconnect"]["enabled"] is False for server in servers))
            for bad in ({"bad name": {"command": "fixture"}}, {"a": {"type": "sse", "url": "http://127.0.0.1"}},
                        {"a": {"command": "fixture", "disabled": "true"}},
                        {"a": {"command": "fixture", "headers": {}}},
                        {"a": {"type": "http", "url": "http://127.0.0.1", "env": {}}},
                        {"a": {"type": "stdio", "transport": "http"}},
                        {"a": {"command": "fixture", "args": "one string"}},
                        {"a": {"type": "http", "url": "file:///private"}}):
                with self.assertRaises(ValueError):
                    normalize_servers(bad, cwd=temporary)


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_DSH") == "1", "Native local runtime check is opt-in")
class NativeMcpTests(unittest.TestCase):
    def test_stdio_tools_and_spawned_descendants_are_owned(self) -> None:
        from src.backend.deepseek_harness import DeepSeekHarnessBackend
        from src.types import BackendType, ModelBackendConfig
        with tempfile.TemporaryDirectory(prefix="awu-native-mcp-") as temporary:
            root = Path(temporary)
            posted = []
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args) -> None:
                    pass

                def do_POST(self) -> None:
                    posted.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                    first = len(posted) == 1
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    block = {"type": "tool_use", "id": "fixture-mcp-call", "name": "mcp__fixture__echo", "input": {}} if first else {"type": "text", "text": ""}
                    delta = {"type": "input_json_delta", "partial_json": '{"text":"local MCP"}'} if first else {"type": "text_delta", "text": "MCP fixture done"}
                    events = [
                        {"type": "message_start", "message": {"id": "mcp-reply-" + str(len(posted)), "model": "smoke-model", "usage": {"input_tokens": 3, "output_tokens": 0}}},
                        {"type": "content_block_start", "index": 0, "content_block": block},
                        {"type": "content_block_delta", "index": 0, "delta": delta},
                        {"type": "content_block_stop", "index": 0},
                        {"type": "message_delta", "delta": {"stop_reason": "tool_use" if first else "end_turn"}, "usage": {"output_tokens": 2}},
                        {"type": "message_stop"},
                    ]
                    for item in events:
                        self.wfile.write(f"event: {item['type']}\ndata: {json.dumps(item)}\n\n".encode())
                        self.wfile.flush()
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(root / "data")}):
                    fixture = Path(__file__).parent / "fixtures/deepseek_harness_mcp.py"
                    record = root / "mcp.jsonl"
                    config = ModelBackendConfig(id="mcp-test", label="test", type=BackendType.DEEPSEEK_HARNESS,
                        model="smoke-model", api_key="isolated-provider-secret", base_url=f"http://127.0.0.1:{server.server_port}",
                        mcp_servers={"fixture": {"command": sys.executable, "args": ["-u", str(fixture.resolve()), "--record", str(record)],
                            "env": {"MCP_ONLY": "fixture-value"}}})
                    backend = DeepSeekHarnessBackend(config)
                    deltas = []
                    result = asyncio.run(backend.send_message([], "local MCP fixture only", None,
                        "sid", "mid", deltas.append, working_dir=str(root)))
                    self.assertTrue(result.get("success"), [item.to_dict() for item in deltas])
                    rows = [json.loads(line) for line in record.read_text().splitlines()]
                    startups = [row for row in rows if "pid" in row]
                    self.assertTrue(startups)
                    self.assertTrue(all(not row["providerKeyPresent"] and row["explicitEnv"] for row in startups))
                    self.assertEqual([row["arguments"] for row in rows if row.get("method") == "tools/call"], [{"text": "local MCP"}])
                    self.assertIn("mcp__fixture__echo", json.dumps(posted[0]))
                    self.assertIn("echo:local MCP", json.dumps(posted[1]))
                    self.assertFalse(backend.has_unconfirmed_activity("sid"))
                    if sys.platform == "linux":
                        self.assertTrue(all(not Path(f"/proc/{row['childPid']}").exists() for row in startups))
                    self.assertTrue(all("isolated-provider-secret" not in file.read_text(encoding="utf-8") for file in (root / "data").rglob("awu.patch.yml")))
                    # 必需服务器准备失败不发送任何模型请求，不退回没有 MCP 的运行。
                    config.mcp_servers = {"missing": {"command": str(root / "does-not-exist")}}
                    rejected = []
                    result = asyncio.run(DeepSeekHarnessBackend(config).send_message([], "must not submit", None,
                        "failed-sid", "mid", rejected.append, working_dir=str(root)))
                    self.assertFalse(result["success"])
                    self.assertEqual(len(posted), 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
