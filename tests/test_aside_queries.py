import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from src.backend.aside_inspection import InspectionError, QueryBudget, QueryIdentity
from src.backend.aside_queries import InspectionQueries


class QueryOwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.identity = QueryIdentity('u', 'n', 's', str(self.root), 'b', 't')
        self.validator = Mock()
        self.service = InspectionQueries(self.identity, self.validator, lambda: {'status': 'ok'})

    async def test_queries_and_failed_reads_have_specific_results(self):
        result = await self.service.execute({'operation': 'read_text', 'arguments': {'path': 'missing'}})
        self.assertEqual(result['status'], 'missing')
        with self.assertRaises(InspectionError):
            await self.service.execute({'operation': 'write_file'})
        self.validator.side_effect = InspectionError('identity_changed', 'changed')
        with self.assertRaises(InspectionError):
            await self.service.execute({'operation': 'runtime_status'})

    async def test_slow_read_does_not_block_heartbeat_and_cancel_retains_owner(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def slow(**kwargs):
            entered.set()
            release.wait(2)
            return {'status': 'ok', 'content': 'LATE'}
        self.service.files.text = slow
        task = asyncio.create_task(self.service.execute({'operation': 'read_text', 'arguments': {'path': 'a'}}))
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(.005)
        self.assertTrue(entered.is_set())
        ticks = 0
        for _ in range(4):
            await asyncio.sleep(.005)
            ticks += 1
        self.assertEqual(ticks, 4)
        self.service.cancel()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(await self.service.settled(.01))
        release.set()
        self.assertTrue(await self.service.settled(1))
        self.assertEqual(self.service.sources, [])

    async def test_timeout_and_context_budget(self):
        self.service.budget.context_chars = 3
        self.assertEqual((await self.service.execute({'operation': 'runtime_status'}))['status'], 'limit')
        self.service.budget.seconds = 0
        with self.assertRaisesRegex(InspectionError, '时间'):
            await self.service.execute({'operation': 'runtime_status'})


if __name__ == '__main__':
    unittest.main()
