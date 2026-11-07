"""真实字节预算与 SDK 单 reader 接缝；所有 stdin/stdout 均为隔离内存管道。"""
from __future__ import annotations

import io
import queue
from types import SimpleNamespace
import unittest

from src.backend.deepseek_harness_images import MAX_FRAME_BYTES, MAX_PENDING_BYTES, MAX_REQUEST_BYTES, encode_frame
from src.backend.deepseek_harness_sdk import MAX_NOTIFICATIONS, NotificationBudgetQueue, create_client, create_harness_config


class HarnessByteBudgetTests(unittest.TestCase):
    def client(self):
        return create_client(config=create_harness_config(), owner=SimpleNamespace())

    def test_queue_accounts_full_frame_bytes_and_releases_on_consume(self) -> None:
        pending = NotificationBudgetQueue()
        first, second, third = object(), object(), object()
        pending.put_sized(first, MAX_FRAME_BYTES)
        pending.put_sized(second, MAX_FRAME_BYTES)
        self.assertEqual(pending.pending_bytes, MAX_PENDING_BYTES)
        with self.assertRaises(queue.Full):
            pending.put_sized(third, 1)
        self.assertEqual(pending.qsize(), 2)
        self.assertIs(pending.get_nowait(), first)
        self.assertEqual(pending.pending_bytes, MAX_FRAME_BYTES)
        pending.put_sized(third, MAX_FRAME_BYTES)
        self.assertIs(pending.get_nowait(), second)
        self.assertIs(pending.get_nowait(), third)
        self.assertEqual(pending.pending_bytes, 0)
        for _ in range(MAX_NOTIFICATIONS):
            pending.put_sized(first, 1)
        with self.assertRaises(queue.Full):
            pending.put_sized(second, 1)

    def test_write_measures_actual_utf8_envelope_and_lf_at_exact_limit(self) -> None:
        client = self.client()
        stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="\r\n")
        client._proc = SimpleNamespace(stdin=stream)
        try:
            message = {"jsonrpc": "2.0", "id": "id", "method": "fixture", "params": {"value": "图片😀"}}
            client._write_message(message)
            self.assertEqual(stream.buffer.getvalue(), encode_frame(message))
            self.assertNotIn(b"\\u", stream.buffer.getvalue())
            self.assertFalse(stream.buffer.getvalue().endswith(b"\r\n"))
            stream.buffer.seek(0); stream.buffer.truncate()
            message["params"]["value"] = ""
            message["params"]["value"] = "x" * (MAX_FRAME_BYTES - len(encode_frame(message)))
            client._write_message(message)
            self.assertEqual(len(stream.buffer.getvalue()), MAX_FRAME_BYTES)
            message["params"]["value"] += "x"
            with self.assertRaisesRegex(ValueError, "限额"):
                client._write_message(message)
            self.assertEqual(len(stream.buffer.getvalue()), MAX_FRAME_BYTES)
        finally:
            client._proc = None
            stream.close()

    def test_full_prompt_limit_includes_extension_and_envelope(self) -> None:
        client = self.client()
        stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        client._proc = SimpleNamespace(stdin=stream)
        try:
            message = {"jsonrpc": "2.0", "id": "id", "method": "session/prompt", "params": {
                "sessionId": "test", "contentBlocks": [{"type": "text", "text": ""}], "awuImageAdmission": {"token": "fixture"}}}
            message["params"]["contentBlocks"][0]["text"] = "x" * (MAX_REQUEST_BYTES - len(encode_frame(message)))
            client._write_message(message)
            self.assertEqual(len(stream.buffer.getvalue()), MAX_REQUEST_BYTES)
            message["params"]["contentBlocks"][0]["text"] += "x"
            with self.assertRaisesRegex(ValueError, "12 MiB"):
                client._write_message(message)
        finally:
            client._proc = None
            stream.close()

    def test_reader_uses_wire_bytes_not_character_count_and_rejects_truncation(self) -> None:
        for data, expected_count in [
            (encode_frame({"method": "fixture", "params": {"text": "图" * (MAX_FRAME_BYTES // 3)}}), 0),
            (b'{"method":"fixture","params":{}}', 0),
            (b'{"method":"fixture","params":{"text":"\xff"}}\n', 0),
            (encode_frame({"method": "fixture", "params": {"text": "ok"}}), 1),
        ]:
            client = self.client()
            source = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")
            client._proc = SimpleNamespace(stdout=source)
            try:
                client._reader_loop()
                self.assertIsNotNone(client.fatal)
                self.assertEqual(client._notifications.qsize(), expected_count)
                if expected_count:
                    self.assertEqual(client._notifications.pending_bytes, len(data))
                    client.next_owned_notification()
                    self.assertEqual(client._notifications.pending_bytes, 0)
            finally:
                client._proc = None
                source.close()

    def test_queue_byte_overflow_is_fatal_not_dropped_notification(self) -> None:
        client = self.client()
        small = {"method": "fixture", "params": {}}
        client._handle_message(small, frame_bytes=MAX_FRAME_BYTES)
        client._handle_message(small, frame_bytes=MAX_FRAME_BYTES)
        with self.assertRaisesRegex(RuntimeError, "队列溢出"):
            client._handle_message(small, frame_bytes=1)
        self.assertEqual(client._notifications.pending_bytes, MAX_PENDING_BYTES)
        self.assertEqual(client._notifications.qsize(), 2)


if __name__ == "__main__":
    unittest.main()
