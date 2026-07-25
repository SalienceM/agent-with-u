import json
import tempfile
import unittest
from pathlib import Path

from src.backend.bridge_ws import (
    BridgeWS,
    _append_text_attachments,
    compress_messages,
)
from src.backend.chat_extras_store import ChatExtras
from src.backend.session_store import SessionStore
from src.types import ChatMessage, TextAttachment


class TextAttachmentTests(unittest.TestCase):
    def test_model_prompt_expands_attachment_without_changing_visible_content(self):
        attachment = TextAttachment(
            id="text-1",
            name="pasted-text-1.txt",
            content="very long pasted material",
            size=25,
            source="paste",
        )
        message = ChatMessage(
            id="message-1",
            role="user",
            content="请核对",
            text_attachments=[attachment],
        )

        prompt = _append_text_attachments(message.content, message.text_attachments)

        self.assertEqual(message.to_dict()["content"], "请核对")
        self.assertEqual(
            message.to_dict()["textAttachments"][0]["content"],
            "very long pasted material",
        )
        self.assertIn("pasted-text-1.txt", prompt)
        self.assertIn("very long pasted material", prompt)

    def test_compressed_reference_context_keeps_recent_attachment_body(self):
        attachment = TextAttachment(
            id="text-1",
            name="requirements.txt",
            content="important requirement body",
            size=26,
        )
        text = compress_messages([
            ChatMessage(
                id="message-1",
                role="user",
                content="见附件",
                text_attachments=[attachment],
            ),
        ], keep_recent=12)

        self.assertIn("important requirement body", text)

    def test_session_store_restores_text_attachments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.json"
            path.write_text(json.dumps({
                "id": "session-1",
                "title": "demo",
                "createdAt": 1,
                "updatedAt": 2,
                "backendId": "backend-1",
                "workingDir": ".",
                "messages": [{
                    "id": "message-1",
                    "role": "user",
                    "content": "见附件",
                    "textAttachments": [{
                        "id": "text-1",
                        "name": "pasted-text.txt",
                        "content": "body",
                        "size": 4,
                        "source": "paste",
                    }],
                }],
            }), encoding="utf-8")
            store = SessionStore.__new__(SessionStore)
            store._session_path = lambda _sid: path

            session = store.load("session-1")

        self.assertIsNotNone(session)
        attachment = session.messages[0].text_attachments[0]
        self.assertEqual(attachment.name, "pasted-text.txt")
        self.assertEqual(attachment.content, "body")

    def test_sequence_task_preserves_text_attachments(self):
        bridge = BridgeWS.__new__(BridgeWS)
        extras = ChatExtras(session_id="session-1")
        bridge._chat_extras_get = lambda _sid: extras
        bridge._chat_extras_save = lambda _extras: None
        bridge._emit_seqtask_updated = lambda _extras: None
        payload = json.dumps([{
            "id": "text-1",
            "name": "pasted-text.txt",
            "content": "queued body",
            "size": 999,
            "source": "paste",
        }])

        result = json.loads(bridge._rpc_seqtaskAdd(
            "session-1",
            "",
            "",
            payload,
        ))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["seqTasks"][0]["textAttachmentCount"], 1)
        self.assertEqual(
            result["seqTasks"][0]["textAttachments"][0]["content"],
            "queued body",
        )
        self.assertEqual(
            result["seqTasks"][0]["textAttachments"][0]["size"],
            len("queued body"),
        )


if __name__ == "__main__":
    unittest.main()
