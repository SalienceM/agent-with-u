import asyncio
import sys
import types
import unittest

sys.modules.setdefault("httpx", types.ModuleType("httpx"))

from src.backend.qwen_code_cli import QwenCodeSdkBackend
from src.types import BackendType, ModelBackendConfig


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


if __name__ == "__main__":
    unittest.main()
