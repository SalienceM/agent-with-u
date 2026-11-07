"""Harness 严格输入边界；不启动生产 Bridge、用户存储或模型。"""
from __future__ import annotations

import base64
from contextlib import redirect_stderr
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatExtras
from src.backend.deepseek_harness_images import ImagePolicyError, MAX_REQUEST_BYTES
from src.types import BackendType, ImageAttachment, ModelBackendConfig, Session
from tests.fixtures.harness_images import ImageWorkspace, image_bytes


class HarnessImageBridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.workspace = ImageWorkspace()
        self.workspace.__enter__()
        self.addCleanup(self.workspace.__exit__, None, None, None)
        self.config = ModelBackendConfig(id="harness", label="fixture", type=BackendType.DEEPSEEK_HARNESS)
        self.session = Session(id="s", title="fixture", created_at=1, updated_at=1, messages=[],
            working_dir=str(self.workspace.project), backend_id="harness")
        self.extras = ChatExtras(session_id="s")
        self.bridge = bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {"s": self.session}
        bridge._backend_configs = [self.config]
        bridge._session_store = SimpleNamespace(load=lambda _sid: self.session, save=Mock(), update_meta=Mock())
        bridge._session_runtime = Mock(return_value={})
        bridge._build_session_reference_context = lambda content, _sid: content
        bridge._build_prov_reference_context = AsyncMock(side_effect=lambda content, _session, images, _display: (content, images))
        bridge._prepare_session_skills = AsyncMock()
        bridge._compose_constraints = Mock(return_value="fixture")
        bridge._emit_session_updated = Mock()
        bridge._emit_delta = Mock()
        bridge._async_send = AsyncMock(return_value=True)
        bridge._chat_extras_get = lambda _sid: self.extras
        bridge._chat_extras_save = Mock()
        bridge._emit_seqtask_updated = Mock()
        self.image = {"id": "image", "base64": base64.b64encode(image_bytes()).decode(), "mime_type": "image/png"}

    async def send(self, images: object, text: str = "fixture") -> bool:
        with redirect_stderr(io.StringIO()):
            return await self.bridge._handle_send_message(json.dumps({"sessionId": "s", "backendId": "harness",
                "content": text, "images": images, "messageId": "reply"}))

    async def test_bad_container_or_one_bad_image_never_submits_remainder(self) -> None:
        for images in ({}, "bad", [self.image, {}], [self.image, {**self.image, "base64": "!"}]):
            self.assertFalse(await self.send(images))
            self.bridge._async_send.assert_not_called()
            self.assertEqual(self.session.messages, [])

    async def test_final_prov_images_and_expanded_text_share_budget_not_visible_attachments(self) -> None:
        prov = ImageAttachment("prov", self.image["base64"])
        self.bridge._build_prov_reference_context = AsyncMock(return_value=("expanded fixture", [prov] * 5))
        self.assertFalse(await self.send([self.image]))
        self.bridge._async_send.assert_not_called()
        self.bridge._build_prov_reference_context = AsyncMock(return_value=("x" * MAX_REQUEST_BYTES, [prov]))
        self.assertFalse(await self.send([self.image]))
        self.bridge._async_send.assert_not_called()
        self.bridge._build_prov_reference_context = AsyncMock(return_value=("expanded fixture", [prov]))
        self.assertTrue(await self.send([self.image]))
        self.assertEqual([image.id for image in self.session.messages[0].images], ["image"])
        self.assertEqual(self.session.messages[0].content, "fixture")
        self.assertEqual(self.bridge._async_send.call_args.args[2], [prov])

    async def test_queue_parser_never_drops_invalid_entry_or_mutates_failed_edit(self) -> None:
        with self.assertRaises(ImagePolicyError):
            self.bridge._rpc_seqtaskAdd("s", "text", json.dumps([self.image, {}]))
        self.bridge._chat_extras_save.assert_not_called()
        self.assertEqual(self.extras.seq_tasks, [])
        self.bridge._rpc_seqtaskAdd("s", "original", json.dumps([self.image]))
        task = self.extras.seq_tasks[0]
        with self.assertRaises(ImagePolicyError):
            self.bridge._rpc_seqtaskEdit("s", task.id, "new", json.dumps([self.image, {}]))
        self.assertEqual(task.text, "original")
        self.assertEqual(task.images, [ImageAttachment(**self.image).to_dict()])

    async def test_other_backend_keeps_legacy_partial_parser(self) -> None:
        self.config.type = BackendType.OPENAI_COMPATIBLE
        self.assertTrue(await self.send([self.image, {}]))
        self.assertEqual(len(self.bridge._async_send.call_args.args[2]), 1)


if __name__ == "__main__":
    unittest.main()
