"""Opt-in CLI contract tests, with a loopback fake provider (no real model calls).

Run with AWU_TEST_NATIVE_TEXT_ONLY=1 when Codex / Qwen / Claude CLI are installed.
The provider records actual model-facing tool schemas, not just our SDK options.
"""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from src.backend.codex_office import CodexOfficeBackend
from src.backend.qwen_code_cli import QwenCodeSdkBackend
from src.backend.claude_agent import ClaudeAgentBackend
from src.backend.text_only import send_text_only
from src.types import BackendType, ModelBackendConfig


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_TEXT_ONLY") == "1", "opt-in installed CLI contract")
class NativeTextOnlyTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_codex(self):
        await self.check_backend(BackendType.CODEX_OFFICIAL, CodexOfficeBackend, "gpt-5.5")

    async def test_native_qwen(self):
        await self.check_backend(BackendType.QWEN_CODE_CLI, QwenCodeSdkBackend, "test-model")

    async def test_native_claude(self):
        await self.check_backend(BackendType.CLAUDE_AGENT_SDK, ClaudeAgentBackend, "claude-sonnet-4-5")

    async def check_backend(self, kind, cls, model):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[],"models":[]}')

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Content-Encoding") == "zstd":
                    import zstandard
                    raw = zstandard.ZstdDecompressor().decompress(raw, max_output_size=4*1024*1024)
                request = json.loads(raw)
                if "responses" in self.path or "completions" in self.path or "messages" in self.path:
                    requests.append(request)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                def send(event, data):
                    prefix = f"event: {event}\n" if event else ""
                    self.wfile.write((prefix + "data: " + json.dumps(data) + "\n\n").encode())
                if "responses" in self.path:
                    item = {"id": "m1", "type": "message", "role": "assistant", "status": "completed",
                            "content": [{"type": "output_text", "text": "Document explanation", "annotations": []}]}
                    response = {"id": "r1", "object": "response", "status": "completed", "output": [item],
                                "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}
                    send("response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}})
                    send("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}})
                    send("response.output_text.delta", {"type": "response.output_text.delta", "item_id": "m1", "output_index": 0, "content_index": 0, "delta": "Document explanation"})
                    send("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item})
                    send("response.completed", {"type": "response.completed", "response": response})
                elif "messages" in self.path:
                    message = {"id": "m1", "type": "message", "role": "assistant", "model": model,
                               "content": [], "stop_reason": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
                    send("message_start", {"type": "message_start", "message": message})
                    send("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
                    send("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Document explanation"}})
                    send("content_block_stop", {"type": "content_block_stop", "index": 0})
                    send("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 2}})
                    send("message_stop", {"type": "message_stop"})
                else:
                    send(None, {"id": "c1", "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Document explanation"}, "finish_reason": None}]})
                    send(None, {"id": "c1", "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}})
                    self.wfile.write(b'data: [DONE]\n\n')
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/v1"
        config = ModelBackendConfig("native-test", kind, "native-test", api_key="test-not-a-real-key", base_url=url, model=model,
            env={"AGENTWITHU_CODEX_PROXY_MODE": "direct", "AGENTWITHU_CODEX_FORCE_HTTP": "1", "QWEN_PROVIDER": "openai",
                 "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "127.0.0.1,localhost"})
        deltas = []
        backend = cls(config)
        build_env = backend._build_env if hasattr(backend, "_build_env") else None
        if build_env:
            # Windows 可能有系统代理；测试只能访问本机假接口。
            def local_env():
                env = build_env()
                env.update(NO_PROXY="*", no_proxy="*")
                if kind == BackendType.CODEX_OFFICIAL:
                    env.update(HTTP_PROXY=url[:-3], HTTPS_PROXY=url[:-3], ALL_PROXY=url[:-3],
                               http_proxy=url[:-3], https_proxy=url[:-3], all_proxy=url[:-3],
                               NO_PROXY="", no_proxy="")
                return env
            backend._build_env = local_env
        try:
            with tempfile.TemporaryDirectory() as empty_auth, patch.dict(os.environ, {
                "CODEX_HOME": empty_auth, "CLAUDE_CONFIG_DIR": empty_auth,
                "OPENAI_API_KEY": "test-not-a-real-key", "OPENAI_BASE_URL": url,
                "ANTHROPIC_API_KEY": "test-not-a-real-key", "ANTHROPIC_BASE_URL": url[:-3],
                "ANTHROPIC_AUTH_TOKEN": "", "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "",
                "http_proxy": "", "https_proxy": "", "all_proxy": "", "NO_PROXY": "127.0.0.1,localhost",
            }):
                await asyncio.wait_for(send_text_only(backend,
                    content='{"skillMarkdown":"Explain this documentation; do not run anything."}',
                    constraints="Explain the provided document. No tools.", session_id="test-job", message_id="m1",
                    on_delta=deltas.append), 45)
            self.assertEqual("".join(delta.text for delta in deltas), "Document explanation")
            self.assertTrue(requests, "CLI must reach the local fake provider")
            for request in requests:
                tools = request.get("tools") or []
                if kind == BackendType.CODEX_OFFICIAL:
                    # Codex 新版固定声明目录查询；runner 在发起模型请求前
                    # 通过 skills/list 验证目录为空，且拒绝任何工具调用事件。
                    self.assertTrue(all(tool.get("type") == "namespace" and tool.get("name") == "skills"
                        and {t.get("name") for t in tool.get("tools", [])} <= {"list", "read"} for tool in tools))
                else:
                    self.assertFalse(tools, f"Unexpected native tool schemas: {tools}")
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
