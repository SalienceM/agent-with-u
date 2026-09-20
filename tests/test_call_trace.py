import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from src.backend.call_trace import CallTrace, traced_send, trace_request, trace_response, read_trace, clear_traces


class TraceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patch = patch("src.backend.call_trace.paths.sub", side_effect=lambda *parts: Path(self.tmp.name).joinpath(*parts))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    async def test_opt_in_boundary_raw_events_redaction_and_reload(self):
        class Backend:
            config = SimpleNamespace(id="q", type="qwen-code-cli", model="test", api_key="sensitive-api-secret")

            async def send_message(self, **kwargs):
                trace_request("qwen-sdk", {"prompt": '你是谁 {"token": "lease-token-not-persisted"}', "options": {"resume": "native"}})
                trace_response("qwen-sdk", {"type": "result", "usage": {"input_tokens": 38000}, "api_key": "sensitive-api-secret"})
                for text in ("sensitive-", "api-secret", " answer"):
                    kwargs["on_delta"](SimpleNamespace(type="text_delta", text=text))
                return {"agentSessionId": "native"}

        seen = []
        trace = CallTrace("session", "chat:1")
        await traced_send(Backend(), {"on_delta": seen.append}, trace)
        result = read_trace("session", "chat:1")
        text = json.dumps(result)
        self.assertNotIn("sensitive-api-secret", text)
        self.assertNotIn("lease-token-not-persisted", text)
        self.assertEqual(len(seen), 3)
        self.assertIn("answer", result["attempts"][0]["output"])
        self.assertTrue(result["redacted"])
        self.assertEqual(result["attempts"][0]["sent"][1]["scope"], "qwen-sdk")
        self.assertIsNone(read_trace("other", "chat:1"))
        self.assertIsNone(read_trace("session", "../../secret"))

    async def test_concurrent_sessions_do_not_mix_contextvars(self):
        class Backend:
            config = SimpleNamespace(id="b", type="test")

            async def send_message(self, **kwargs):
                await asyncio.sleep(0)
                trace_request("test", kwargs["content"])
                return {}

        await asyncio.gather(*(traced_send(Backend(), {"content": sid}, CallTrace(sid, "same")) for sid in ("one", "two")))
        for sid in ("one", "two"):
            self.assertEqual(read_trace(sid, "same")["attempts"][0]["sent"][1]["body"], sid)

    async def test_disabled_does_not_record_and_clear_blocks_inflight_write(self):
        started, finish = asyncio.Event(), asyncio.Event()

        class Backend:
            config = SimpleNamespace(id="b", type="test")

            async def send_message(self, **kwargs):
                trace_request("test", "secret content")
                started.set()
                await finish.wait()
                return {}

        trace = CallTrace("session", "1")
        task = asyncio.create_task(traced_send(Backend(), {}, trace))
        await started.wait()
        clear_traces("session")
        finish.set()
        await task
        self.assertIsNone(read_trace("session", "1"))
        await traced_send(Backend(), {}, None)
        self.assertIsNone(read_trace("session", "1"))

    async def test_cancelled_partial_reply_is_saved(self):
        class Backend:
            config = SimpleNamespace(id="b", type="test")

            async def send_message(self, **kwargs):
                kwargs["on_delta"](SimpleNamespace(type="text_delta", text="partial"))
                raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            await traced_send(Backend(), {}, CallTrace("s", "1"))
        attempt = read_trace("s", "1")["attempts"][0]
        self.assertEqual(attempt["status"], "cancelled")
        self.assertEqual(attempt["output"], "partial")

    async def test_retention_and_truncation(self):
        class Backend:
            config = SimpleNamespace(id="b", type="test")

            async def send_message(self, **kwargs):
                trace_request("test", "x" * 1000)
                return {}

        with patch("src.backend.call_trace.MAX_FILES", 2):
            for i in range(3):
                trace = CallTrace("s", str(i))
                trace.remaining = 30
                await traced_send(Backend(), {}, trace)
        self.assertIsNone(read_trace("s", "0"))
        self.assertTrue(read_trace("s", "2")["truncated"])


if __name__ == "__main__":
    unittest.main()
