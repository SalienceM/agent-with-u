import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    async def test_total_budget_exhaustion_stops_batch_and_gets_one_final_answer(self):
        self.queries.budget.total_bytes = 1
        runner = self.runner([
            {'type': 'query', 'queries': [
                {'operation': 'read_text', 'arguments': {'path': 'a.txt'}},
                {'operation': 'runtime_status'}]},
            {'type': 'answer', 'text': '未取得文件正文，不能确定接入入口。'}])
        answer = await runner.run({}, '入口在哪里')
        self.assertIn('未覆盖部分尚未核验', answer)
        self.assertEqual(len(self.prompts), 2)
        self.assertEqual(self.queries.budget.used_operations, 1)
        self.assertEqual(self.prompts[-1]['finishReason'], 'total_bytes')

    async def test_context_and_operations_limits_finalize(self):
        for field, amount, reason in [('context_chars', 1, 'context_chars'), ('operations', 1, 'operations')]:
            with self.subTest(field=field):
                await self.asyncSetUp()
                setattr(self.queries.budget, field, amount)
                await self.runner([
                    {'type': 'query', 'queries': [{'operation': 'runtime_status'}]},
                    {'type': 'answer', 'text': '仅能说明已有资料。'}]).run({}, 'q')
                self.assertEqual(self.prompts[-1]['finishReason'], reason)
                self.assertEqual(len(self.prompts), 2)

    async def test_local_limit_can_select_other_file_and_search_limit_allows_targeted_read(self):
        (self.root / 'huge.txt').write_bytes(b'x' * 262145)
        self.queries.budget.search_bytes = 1
        runner = self.runner([
            {'type': 'query', 'queries': [{'operation': 'search_text', 'arguments': {'path': '.', 'query': 'data'}}]},
            {'type': 'query', 'queries': [{'operation': 'read_text', 'arguments': {'path': 'huge.txt'}}]},
            {'type': 'query', 'queries': [{'operation': 'read_text', 'arguments': {'path': 'a.txt'}}]},
            {'type': 'answer', 'text': '已读取 a.txt；搜索和大文件未完整覆盖。'}])
        await runner.run({}, '问代码')
        self.assertFalse(self.prompts[1]['budget']['searchAvailable'])
        self.assertIn('content', self.prompts[-1]['queryResults'][-1])
        self.assertEqual(len(self.prompts), 4)

    async def test_clock_crosses_discovery_boundary_before_next_query(self):
        with patch.object(self.queries.budget, 'remaining') as clock:
            clock.return_value = 180
            calls = []
            async def model(prompt, rules, receive):
                calls.append(json.loads(prompt))
                if len(calls) == 1:
                    clock.return_value = 59
                    receive(json.dumps({'type': 'query', 'queries': [{'operation': 'runtime_status'}]}))
                else:
                    receive(json.dumps({'type': 'answer', 'text': '还未查到实现，不能确定。'}))
            runner = InspectionRunner(self.queries, model, lambda *args: None, self.outputs.append)
            await runner.run({}, 'q')
            self.assertEqual(calls[-1]['finishReason'], 'answer_reserve')
            self.assertEqual(self.queries.budget.used_operations, 0)

    async def test_slow_discovery_confirmed_exit_can_summarize_without_resetting_cancel(self):
        self.queries.budget.seconds = .3
        calls = []
        async def model(prompt, rules, receive):
            calls.append(json.loads(prompt))
            if len(calls) == 1:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    receive('LATE PACKET')
                    raise
            receive(json.dumps({'type': 'answer', 'text': '没有取得文件，不能给出代码结论。'}))
        runner = InspectionRunner(self.queries, model, lambda *args: None, self.outputs.append)
        await runner.run({}, 'q')
        self.assertEqual(len(calls), 2)
        self.assertFalse(self.queries.budget.cancelled.is_set())
        self.assertNotIn('LATE PACKET', str(calls))

    async def test_native_unknown_prevents_second_generation(self):
        ready = True
        async def model(prompt, rules, receive):
            nonlocal ready
            ready = False
            receive(json.dumps({'type': 'query', 'queries': [{'operation': 'runtime_status'}]}))
        runner = InspectionRunner(self.queries, model, lambda *args: None, self.outputs.append, lambda: ready)
        with self.assertRaises(InspectionError):
            await runner.run({}, 'q')
        self.assertEqual(self.outputs, [])

    async def test_user_cancel_and_identity_change_do_not_trigger_final_answer(self):
        for kind in ('cancel', 'identity'):
            with self.subTest(kind=kind):
                await self.asyncSetUp()
                calls = []
                async def model(prompt, rules, receive):
                    calls.append(prompt)
                    if kind == 'cancel':
                        self.queries.cancel()
                    else:
                        self.queries.validate = lambda: (_ for _ in ()).throw(InspectionError('identity_changed', 'changed'))
                    receive(json.dumps({'type': 'query', 'queries': [{'operation': 'runtime_status'}]}))
                runner = InspectionRunner(self.queries, model, lambda *args: None, self.outputs.append)
                with self.assertRaises(InspectionError):
                    await runner.run({}, 'q')
                self.assertEqual(len(calls), 1)
                self.assertEqual(self.outputs, [])

    async def test_final_protocol_error_and_provider_timeout_never_claim_success(self):
        self.queries.budget.operations = 0
        with self.assertRaises(InspectionError) as caught:
            await self.runner([{'type': 'query', 'queries': [{'operation': 'runtime_status'}]}]).run({}, 'q')
        self.assertEqual(caught.exception.code, 'invalid_query')
        async def fail(prompt, rules, receive):
            receive('{"type":"answer","text":"partial"}')
            raise asyncio.TimeoutError()
        with self.assertRaises(InspectionError) as caught:
            await InspectionRunner(self.queries, fail, lambda *args: None, self.outputs.append).run({}, 'q')
        self.assertEqual(caught.exception.code, 'timeout')
        self.assertEqual(self.outputs, [])

    async def test_multi_directory_search_then_targeted_reads_produce_bounded_answer(self):
        for name in ('docs', 'base', 'cloud'):
            (self.root / name).mkdir()
            (self.root / name / 'entry.txt').write_text('plugin config entry', encoding='utf-8')
        self.queries.budget.search_bytes = 20
        packets = [
            {'type': 'query', 'queries': [{'operation': 'list_directory', 'arguments': {'path': name}}
                                         for name in ('docs', 'base', 'cloud')]},
            {'type': 'query', 'queries': [{'operation': 'search_text', 'arguments': {'path': '.', 'query': 'plugin'}}]},
            {'type': 'query', 'queries': [{'operation': 'read_text', 'arguments': {'path': 'base/entry.txt'}}]},
            {'type': 'answer', 'text': '已知入口见 base/entry.txt；其余模块尚未核验。'}]
        await self.runner(packets).run({}, '配置和代码入口在哪里')
        self.assertIn('plugin config', self.prompts[-1]['queryResults'][-1]['content'])
        self.assertFalse(self.prompts[-1]['budget']['searchAvailable'])
        self.assertEqual(len(self.outputs), 1)

    async def test_final_deadline_cancels_once_and_never_retries(self):
        self.queries.budget.seconds = .06
        self.queries.budget.operations = 0
        calls, cancellations = [], []
        async def slow(prompt, rules, receive):
            calls.append(prompt)
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancellations.append(True)
                raise
        runner = InspectionRunner(self.queries, slow, lambda *args: None, self.outputs.append)
        with self.assertRaises(InspectionError) as caught:
            await runner.run({}, 'q')
        self.assertEqual(caught.exception.code, 'timeout')
        self.assertTrue(await runner.settled(1))
        self.assertEqual((len(calls), len(cancellations)), (1, 1))
        self.assertEqual(self.outputs, [])


if __name__ == '__main__':
    unittest.main()
