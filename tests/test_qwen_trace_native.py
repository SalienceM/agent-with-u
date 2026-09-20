"""Installed Qwen contract against loopback only; never calls a paid provider."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

from src.backend.call_trace import CallTrace, traced_send, read_trace
from src.backend.qwen_code_cli import QwenCodeSdkBackend
from src.backend.token_usage import record_session_usage
from src.types import BackendType, ModelBackendConfig
from types import SimpleNamespace


@unittest.skipUnless(os.environ.get("AWU_TEST_NATIVE_QWEN_TRACE") == "1", "opt-in installed Qwen contract")
class NativeQwenTraceTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_real_sdk_turns_capture_model_request_and_do_not_repeat_history_usage(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                requests.append(request)
                count = len(requests)
                usage = {"prompt_tokens": 100 + (count - 1) * 20, "completion_tokens": 10,
                         "total_tokens": 110 + (count - 1) * 20, "prompt_tokens_details": {"cached_tokens": 30}}
                response = {"id": f"fake-{count}", "object": "chat.completion", "model": "test-model",
                            "choices": [{"index": 0, "message": {"role": "assistant", "content": "fixture answer"}, "finish_reason": "stop"}], "usage": usage}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if request.get("stream") else "application/json")
                self.end_headers()
                if request.get("stream"):
                    for delta, finish in (({"role": "assistant", "content": "fixture answer"}, None), ({}, "stop")):
                        chunk = {"id": response["id"], "object": "chat.completion.chunk", "model": "test-model",
                                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                        if finish:
                            chunk["usage"] = usage
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                else:
                    self.wfile.write(json.dumps(response).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp, patch("src.backend.call_trace.paths.sub", side_effect=lambda *parts: Path(tmp, "data", *parts)):
                root = Path(tmp)
                home = root / "home"
                home.mkdir()
                workspace = root / "project"
                workspace.mkdir()
                (workspace / "QWEN.md").write_text("Project marker: native-trace-fixture. Do not call tools.", encoding="utf-8")
                settings = root / "empty.json"
                settings.write_text("{}", encoding="utf-8")
                url = f"http://127.0.0.1:{server.server_port}/v1"
                env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
                       "QWEN_CODE_SYSTEM_SETTINGS_PATH": str(settings), "QWEN_CODE_SYSTEM_DEFAULTS_PATH": str(settings),
                       "OPENAI_API_KEY": "fixture-only-key", "OPENAI_BASE_URL": url, "QWEN_AUTH_TYPE": "openai",
                       "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "http_proxy": "", "https_proxy": "", "all_proxy": "",
                       "NO_PROXY": "*", "no_proxy": "*"}
                cli = os.environ.get("AWU_TEST_QWEN_ENTRY") or shutil.which("qwen")
                if not cli:
                    self.skipTest("Qwen CLI not installed")
                js = Path(cli).parent / "node_modules" / "@qwen-code" / "qwen-code" / "cli.js"
                if js.exists() and not os.environ.get("AWU_TEST_QWEN_ENTRY"):
                    cli = str(js)
                if os.name == 'nt' and os.environ.get('AWU_TEST_QWEN_CMD') == '1':
                    wrapper = root / 'qwen.cmd'
                    wrapper.write_text(f'@echo off\r\n"{shutil.which("node")}" "{cli}" %*\r\n', encoding='utf8')
                    cli = str(wrapper)
                native_id = None
                session = SimpleNamespace(token_usage={}, messages=[])
                reply_input = 0
                for index in range(2):
                    request_start = len(requests)
                    backend = QwenCodeSdkBackend(ModelBackendConfig(id="fixture", type=BackendType.QWEN_CODE_CLI,
                        label="fixture", api_key="fixture-only-key", base_url=url, model="test-model", cli_path=cli))
                    backend._build_env = lambda: dict(env)
                    deltas = []
                    result = await asyncio.wait_for(traced_send(backend, {
                        "messages": [], "content": "你是谁" if index == 0 else "再说一次", "images": None,
                        "session_id": "fixture", "message_id": str(index), "on_delta": deltas.append,
                        "working_dir": str(workspace), "agent_session_id": native_id,
                        "constraints": "Do not use tools. Reply directly.",
                    }, CallTrace("fixture", str(index))), 45)
                    previous_id = native_id
                    native_id = result.get("agentSessionId")
                    self.assertTrue(native_id)
                    if previous_id:
                        self.assertEqual(native_id, previous_id, "Resume must keep the original native context")
                    usage = next(delta.usage for delta in reversed(deltas) if delta.type == "done" and delta.usage)
                    record_session_usage(session, usage=usage, event_id=str(index), source="chat", stage="reply", backend_id="fixture")
                    trace = read_trace("fixture", str(index))
                    actual = [item for item in trace["attempts"][0]["sent"] if item["scope"] == "qwen-model-request"]
                    self.assertTrue(actual, f"Installed CLI must expose actual model request: {trace['attempts'][0].get('modelRequestCapture')}")
                    self.assertIn("native-trace-fixture", json.dumps(actual))
                    self.assertEqual(len(actual), len(requests) - request_start, "Every model request must be captured once")
                    self.assertEqual(trace['attempts'][0]['modelRequestCapture']['status'], 'captured')
                    reply_input += sum(entry['body']['message'].get('usage', {}).get('input_tokens', 0)
                                       for entry in trace['attempts'][0]['received']
                                       if entry.get('scope') == 'qwen-sdk' and entry['body'].get('type') == 'assistant')
                    self.assertIn("fixture answer", trace["attempts"][0]["output"])
                    self.assertNotIn("fixture-only-key", json.dumps(trace))
                    await asyncio.gather(*list(backend._cleanup_tasks))
                expected = sum(100 + i * 20 for i in range(len(requests)))
                self.assertEqual(session.token_usage["inputTokens"], reply_input)
                self.assertEqual(sum(e['qwenAccounting']['cumulativeDelta']['inputTokens'] for e in session.token_usage['events']), expected)
                self.assertGreaterEqual(reply_input, 220)
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
