import base64
import hashlib
import io
import json
import tarfile
import unittest
from pathlib import Path

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID


class _BackendStore:
    def export_json(self, *, configs, envelope):
        return json.dumps({"configs": list(configs), "envelope": envelope})


class _LibraryStore:
    def __init__(self, name: str):
        self.name = name

    def export_library(self, target: str) -> None:
        payload = f"{self.name}-payload".encode()
        info = tarfile.TarInfo(f"{self.name}.txt")
        info.size = len(payload)
        with tarfile.open(target, "w:gz") as archive:
            archive.addfile(info, io.BytesIO(payload))


class DataExportTransferTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._backend_store = _BackendStore()
        self.bridge._backend_configs = [{"id": "fixture"}]
        self.bridge._prompt_store = _LibraryStore("prompt")
        self.bridge._skill_store = _LibraryStore("skill")
        self.bridge._data_export_transfers = {}

    async def test_export_is_chunked_and_temporary_file_is_removed(self):
        started = json.loads(await self.bridge._rpc_exportDataStart())
        self.assertEqual(started["status"], "ok")
        transfer_id = started["transferId"]
        temp_path = Path(self.bridge._data_export_transfers[transfer_id]["path"])
        self.assertTrue(temp_path.is_file())

        received = bytearray()
        offset = 0
        while offset < started["size"]:
            chunk = json.loads(self.bridge._rpc_exportDataChunk(transfer_id, offset, 97))
            self.assertEqual(chunk["status"], "ok")
            data = base64.b64decode(chunk["data"])
            received.extend(data)
            offset += len(data)

        self.assertEqual(len(received), started["size"])
        self.assertEqual(hashlib.sha256(received).hexdigest(), started["sha256"])
        with tarfile.open(fileobj=io.BytesIO(received), mode="r:gz") as archive:
            self.assertEqual(
                set(archive.getnames()),
                {"backends.json", "prompt-library.tar.gz", "skill-library.tar.gz"},
            )

        finished = json.loads(self.bridge._rpc_exportDataFinish(transfer_id))
        self.assertEqual(finished["status"], "ok")
        self.assertFalse(temp_path.exists())
        self.assertNotIn(transfer_id, self.bridge._data_export_transfers)

    async def test_transfer_is_bound_to_authenticated_owner(self):
        owner = _REQUEST_OWNER_ID.set("owner-a")
        try:
            started = json.loads(await self.bridge._rpc_exportDataStart())
        finally:
            _REQUEST_OWNER_ID.reset(owner)

        other = _REQUEST_OWNER_ID.set("owner-b")
        try:
            denied = json.loads(self.bridge._rpc_exportDataChunk(started["transferId"], 0, 16))
            self.assertEqual(denied["status"], "error")
            self.assertIn("不存在或已过期", denied["message"])
        finally:
            _REQUEST_OWNER_ID.reset(other)

        owner = _REQUEST_OWNER_ID.set("owner-a")
        try:
            self.bridge._rpc_exportDataFinish(started["transferId"])
        finally:
            _REQUEST_OWNER_ID.reset(owner)


if __name__ == "__main__":
    unittest.main()
