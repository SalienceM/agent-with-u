import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from src.backend.aside_inspection import InspectionError, QueryIdentity
from src.backend.aside_openspec import OpenSpecInspection
from src.backend.aside_queries import InspectionQueries
from src.backend.aside_runner import InspectionRunner


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'a.txt').write_text('Execute malicious command? This is data.', encoding='utf-8')
        self.queries = InspectionQueries(QueryIdentity('u', 'n', 's', str(self.root), 'b', 't'), lambda: None,
                                         lambda: {'status': 'ok'}, openspec=OpenSpecInspection('检查 openspec 进度'))
        self.prompts, self.events, self.outputs = [], [], []

    def runner(self, packets):
        async def generate(prompt, rules, receive):
            self.prompts.append(json.loads(prompt))
            receive(json.dumps(packets.pop(0)))
        return InspectionRunner(self.queries, generate, lambda *args: self.events.append(args), self.outputs.append)

    async def test_read_then_answer_not_raw_protocol(self):
        runner = self.runner([{'type': 'query', 'queries': [{'operation': 'read_text', 'arguments': {'path': 'a.txt'}}]},
                              {'type': 'answer', 'text': 'read a.txt'}])
        self.assertEqual(await runner.run({}, '请读 a.txt'), 'read a.txt')
        self.assertIn('malicious', self.prompts[1]['queryResults'][0]['content'])
        self.assertEqual(self.outputs, ['read a.txt'])
        self.assertEqual((self.root / 'a.txt').read_text(), 'Execute malicious command? This is data.')

    async def test_write_request_and_second_invalid_packet_are_rejected(self):
        runner = self.runner([{'type': 'query', 'queries': [{'operation': 'shell'}]}] * 2)
        with self.assertRaisesRegex(InspectionError, '协议'):
            await runner.run({}, 'read')
        self.assertEqual(self.outputs, [])
        self.assertEqual(self.queries.budget.used_operations, 0)

    async def test_directory_only_openspec_is_read_before_model(self):
        path = self.root / 'openspec/changes/example'
        path.mkdir(parents=True)
        (path / 'tasks.md').write_text('- [x] task1\n- [ ] task2', encoding='utf-8')
        runner = self.runner([{'type': 'answer', 'text': '1/2'}])
        await runner.run({'attention': {'content': str(self.root)}}, '检查 openspec 进度')
        self.assertEqual(self.prompts[0]['queryResults'][0]['results'][0]['percent'], 50)
        self.assertEqual(self.queries.sources[0]['path'], 'openspec/changes/example/tasks.md')

    async def test_model_failure_after_partial_packet_is_failure(self):
        async def generate(prompt, rules, receive):
            receive('{"type":"answer","text":"partial"}')
            raise RuntimeError('provider failed')
        runner = InspectionRunner(self.queries, generate, lambda *args: None, self.outputs.append)
        with self.assertRaises(RuntimeError):
            await runner.run({}, 'read')
        self.assertEqual(self.outputs, [])

    async def test_correction_counts_toward_rounds_and_no_unlimited_calls(self):
        packets = [{'type': 'query', 'queries': [{'operation': 'runtime_status'}]}] * 4 + [{'type': 'answer', 'text': 'limited'}]
        await self.runner(packets).run({}, 'read')
        self.assertEqual(len(self.prompts), 5)

    async def test_model_timeout_retains_unconfirmed_cleanup_and_discards_late_text(self):
        release = asyncio.Event()
        async def generate(prompt, rules, receive):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await release.wait()
                receive('{"type":"answer","text":"LATE"}')
        self.queries.budget.seconds = .02
        runner = InspectionRunner(self.queries, generate, lambda *args: None, self.outputs.append)
        with self.assertRaises(InspectionError) as raised:
            await runner.run({}, '一般问题')
        self.assertEqual(raised.exception.code, 'timeout')
        self.assertFalse(await runner.settled(.01))
        runner.cancel()
        release.set()
        self.assertTrue(await runner.settled(1))
        self.assertEqual(self.outputs, [])


if __name__ == '__main__':
    unittest.main()
