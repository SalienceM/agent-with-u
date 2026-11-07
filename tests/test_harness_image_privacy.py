"""只用合成敏感标记；失败断言也不得打印完整夹具输入。"""
from __future__ import annotations

import asyncio
from contextlib import redirect_stderr
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from src.backend.bridge_ws import BridgeWS
from src.backend.deepseek_harness_images import ImagePolicyError
from src.backend.harness_image_errors import harness_error_text, harness_event_metadata
from src.backend.loop_diagnostics import error_evidence


class ImagePrivacyTests(unittest.IsolatedAsyncioTestCase):
    def test_error_and_trace_metadata_are_allowlisted_not_module_trusted(self) -> None:
        marker = 'PRIVATE_FIXTURE_PAYLOAD' * 200
        for error in (RuntimeError(marker), ValueError(marker), TimeoutError(marker)):
            output = json.dumps({"error": harness_error_text(error), "diagnostic": error_evidence(error),
                "trace": harness_event_metadata({"type": marker, "seq": marker, "data": marker})})
            self.assertFalse(marker in output, "敏感测试内容泄露")
            self.assertLess(len(output), 1800)
        controlled = ImagePolicyError("corrupt_image")
        controlled.args = (marker,)
        self.assertFalse(marker in harness_error_text(controlled), "不得信任可变的异常正文")

    async def test_actual_websocket_rpc_error_and_log_do_not_echo_raw_exception(self) -> None:
        marker = 'PRIVATE_FIXTURE_RPC_BODY'
        class Client:
            identity = "local"
            identity_src = "loopback"
            can_claim_legacy = False
            def __init__(self):
                self.rows = iter([json.dumps({"id": 1, "method": "harnessImageSubmit", "params": []})])
                self.sent = []
            def __aiter__(self):
                return self
            async def __anext__(self):
                try:
                    return next(self.rows)
                except StopIteration:
                    raise StopAsyncIteration
            async def send(self, raw):
                self.sent.append(json.loads(raw))
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._clients, bridge._client_meta = set(), {}
        bridge._update_manager = SimpleNamespace(journal=SimpleNamespace(active=lambda: {}))
        bridge._owner_id_for_client = lambda client: client.identity
        bridge._emit_clients_changed = Mock()
        bridge._window_bind_connection = Mock(return_value=None)
        bridge._dispatch = AsyncMock(side_effect=RuntimeError(marker))
        client, logs = Client(), io.StringIO()
        with redirect_stderr(logs):
            await asyncio.wait_for(bridge.handle_client(client), 2)
        self.assertEqual(len(client.sent), 1)
        self.assertIn("error", client.sent[0])
        self.assertFalse(marker in json.dumps(client.sent) + logs.getvalue(), "RPC／日志泄露原始异常")


if __name__ == "__main__":
    unittest.main()
