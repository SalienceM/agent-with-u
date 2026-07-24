from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path

from src.backend.bridge_ws import BridgeWS


class FileTransferTests(unittest.TestCase):
    def setUp(self) -> None:
        # 分块 RPC 不依赖 BridgeWS 的运行态成员，绕过昂贵的完整后端初始化。
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def parsed(raw: str) -> dict:
        return json.loads(raw)

    def test_chunk_upload_keeps_old_file_until_finish(self) -> None:
        target = self.root / "nested" / "large.bin"
        target.parent.mkdir()
        target.write_bytes(b"old")
        transfer = "transfer_12345678"
        payload = b"A" * 700_000 + b"B" * 300_000

        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteStart(str(self.root), "nested/large.bin", transfer))["status"], "ok")
        self.assertEqual(target.read_bytes(), b"old")

        first = payload[:700_000]
        second = payload[700_000:]
        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteChunk(
            str(self.root), "nested/large.bin", transfer, 0, base64.b64encode(first).decode()
        ))["written"], len(first))
        self.assertEqual(target.read_bytes(), b"old")
        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteChunk(
            str(self.root), "nested/large.bin", transfer, len(first), base64.b64encode(second).decode()
        ))["status"], "ok")
        self.assertEqual(self.parsed(self.bridge._rpc_syncWriteFinish(
            str(self.root), "nested/large.bin", transfer, len(payload)
        ))["status"], "ok")
        self.assertEqual(target.read_bytes(), payload)

    def test_chunk_read_and_invalid_offset(self) -> None:
        payload = bytes(range(256)) * 6000
        target = self.root / "data.bin"
        target.write_bytes(payload)
        first = self.parsed(self.bridge._rpc_syncReadChunk(str(self.root), "data.bin", 0, 700_000))
        second = self.parsed(self.bridge._rpc_syncReadChunk(str(self.root), "data.bin", first["size"], 700_000))
        restored = base64.b64decode(first["data"]) + base64.b64decode(second["data"])
        self.assertEqual(restored, payload[:1_400_000])
        self.assertEqual(first["total"], len(payload))

        transfer = "transfer_abcdefgh"
        self.bridge._rpc_syncWriteStart(str(self.root), "new.bin", transfer)
        error = self.parsed(self.bridge._rpc_syncWriteChunk(
            str(self.root), "new.bin", transfer, 12, base64.b64encode(b"bad").decode()
        ))
        self.assertEqual(error["status"], "error")
        self.assertFalse((self.root / "new.bin").exists())
        self.bridge._rpc_syncWriteAbort(str(self.root), "new.bin", transfer)


if __name__ == "__main__":
    unittest.main()
