import asyncio
import sys
import types
import unittest

sys.modules.setdefault("httpx", types.ModuleType("httpx"))

from src.backend.qwen_code_cli import QwenCodeSdkBackend, _materialize_qwen_images
from src.types import BackendType, ImageAttachment, ModelBackendConfig


class _FakeQuery:
    def __init__(self):
        self.closed = False
        self.finished = asyncio.Event()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        await asyncio.sleep(0.05)
        self.finished.set()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()


class QwenCodeCliTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.backend = QwenCodeSdkBackend(ModelBackendConfig(
            id="qwen-test",
            label="Qwen test",
            type=BackendType.QWEN_CODE_CLI,
        ))

    async def test_terminal_cleanup_is_detached_and_tracked(self):
        query = _FakeQuery()
        self.backend._detach_query_cleanup(query)
        await asyncio.sleep(0)
        self.assertTrue(query.closed)
        self.assertEqual(len(self.backend._cleanup_tasks), 1)
        await query.finished.wait()
        await asyncio.sleep(0)
        self.assertEqual(len(self.backend._cleanup_tasks), 0)

    async def test_context_exit_does_not_repeat_detached_cleanup_wait(self):
        query = _FakeQuery()
        loop = asyncio.get_running_loop()
        started = loop.time()
        async with query as result:
            self.backend._detach_query_cleanup(result)
            await asyncio.sleep(0)
        elapsed = loop.time() - started
        self.assertLess(elapsed, 0.025)
        await query.finished.wait()

    async def test_image_is_materialized_inside_working_dir_for_at_reference(self):
        import base64
        import os
        import shutil
        import tempfile

        cwd = tempfile.mkdtemp()
        temp_dir = None
        try:
            image = ImageAttachment(
                id="image-1",
                base64=base64.b64encode(b"fake-png").decode("ascii"),
                mime_type="image/png",
            )
            refs, temp_dir = _materialize_qwen_images([image], cwd, "message/1")
            self.assertEqual(len(refs), 1)
            self.assertTrue(refs[0].startswith("awu-qwen-attachments/awu-message-1-"))
            self.assertNotIn("/.qwen/", f"/{refs[0]}")
            target = os.path.abspath(os.path.join(cwd, refs[0]))
            self.assertEqual(os.path.commonpath((os.path.abspath(cwd), target)), os.path.abspath(cwd))
            with open(target, "rb") as saved:
                self.assertEqual(saved.read(), b"fake-png")
        finally:
            if temp_dir:
                shutil.rmtree(temp_dir, ignore_errors=True)
            shutil.rmtree(cwd, ignore_errors=True)

    async def test_image_turn_enables_qwen_image_modality(self):
        import json
        import os
        import shutil
        import tempfile

        cwd = tempfile.mkdtemp()
        try:
            settings_dir = os.path.join(cwd, ".qwen")
            os.makedirs(settings_dir, exist_ok=True)
            with open(os.path.join(settings_dir, "settings.json"), "w", encoding="utf-8") as target:
                json.dump({
                    "model": {
                        "generationConfig": {"timeout": 90000},
                    },
                }, target)
            self.backend._ensure_project_auth_settings(
                cwd, "openai", "qwen3.7-plus", enable_image_input=True,
            )
            settings_path = os.path.join(cwd, ".qwen", "settings.json")
            with open(settings_path, "r", encoding="utf-8") as source:
                settings = json.load(source)
            self.assertEqual(settings["model"]["name"], "qwen3.7-plus")
            self.assertTrue(
                settings["model"]["generationConfig"]["modalities"]["image"],
            )
            self.assertEqual(settings["model"]["generationConfig"]["timeout"], 90000)
        finally:
            shutil.rmtree(cwd, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
