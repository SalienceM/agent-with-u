import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from src.backend.session_collaboration_bridge import SessionCollaborationBridge
from src.backend.session_collaboration_store import CollaborationStore, CollaborationScope, CollaborationError
from src.backend.session_store import SessionStore
from src.backend.role_reviews import parse_report
from src.backend.role_review_output import ReviewOutput, quote_text
from src.backend.sync_review_bridge import SyncReviewBridge
from src.backend.token_usage import record_session_usage
from src.backend.base import StreamDelta
from src.types import Session, ChatMessage, ModelBackendConfig, BackendType


class ReviewBridge(SessionCollaborationBridge, SyncReviewBridge):
    def _current_owner_id(self): return 'tester'
    def _loop_environment_executor(self): return 'test-node'
    def _require_session_access(self, sid):
        value = self._active_sessions.get(sid) or self._session_store.load(sid)
        if not value or value.owner_id != 'tester': raise PermissionError('denied')
    def _window_guard(self, sid): self._require_session_access(sid)
    def _require_agent_execution_enabled(self): pass
    def _require_update_work_allowed(self): pass
    def _session_runtime(self, session): return {}
    def _record_session_usage(self, session, **kwargs): return record_session_usage(session, **kwargs)


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict('os.environ', {'AGENT_WITH_U_DATA_ROOT': self.temp.name}); self.env.start()
        self.bridge = ReviewBridge()
        self.bridge._session_store = SessionStore()
        self.bridge._session_collaboration_store = CollaborationStore()
        self.bridge._active_sessions = {}
        self.bridge._backend_configs = [ModelBackendConfig('api', BackendType.OPENAI_COMPATIBLE, 'fake', base_url='https://fixture.invalid')]
        self.bridge._emit_event = Mock(); self.bridge._emit_session_updated = Mock()
        self.project = Path(self.temp.name) / 'project'; self.project.mkdir()
        (self.project / 'proof.txt').write_text('actual evidence', encoding='utf-8')
        self.source = Session('main', 'source', 1, 1, [ChatMessage('u', 'user', '请检查证据'), ChatMessage('answer', 'assistant', '实现已完成')], str(self.project), 'api', owner_id='tester', agent_session_id='main-native')
        self.bridge._active_sessions['main'] = self.source
        self.bridge._session_store.save(self.source, async_=False)
        self.roles = [self.role('first'), self.role('second')]
        self.scope = CollaborationScope('tester', 'test-node')
        self.calls = []
        self.send = patch('src.backend.role_reviews.send_text_only', side_effect=self.answer); self.send.start()

    async def asyncTearDown(self):
        await asyncio.gather(*self.bridge._review_runtime()['tasks'].values(), return_exceptions=True)
        self.send.stop()
        store = self.bridge._session_store
        store._save_index_debounced = Mock()
        store._io_running = False
        store._io_thread.join(timeout=2)
        if store._index_save_timer:
            store._index_save_timer.cancel()
            store._index_save_timer.join(timeout=2)
        with store._index_write_lock: pass
        self.env.stop(); self.temp.cleanup()

    def role(self, name):
        return json.loads(self.bridge._rpc_roleProfileSave('main', 'create-' + name,
            json.dumps({'name': name, 'instructions': '评估事实', 'backendId': '', 'runtime': {}})))['role']

    def submit(self, request='batch', roles=None, source='main', **extra):
        snapshot = json.loads(self.bridge._rpc_reviewSnapshot(source))
        intent = {'snapshotId': snapshot['id'], 'fingerprint': snapshot['fingerprint'],
            'roles': [{'id': row['id'], 'revision': row['revision']} for row in roles or self.roles], 'question': '这些判断可靠么？', **extra}
        return json.loads(self.bridge._rpc_reviewSubmit(source, request, json.dumps(intent)))

    async def wait(self):
        await asyncio.gather(*list(self.bridge._review_runtime()['tasks'].values()), return_exceptions=False)
        await asyncio.sleep(0)

    def report(self, id): return self.bridge._collaboration_store().read(self.scope, 'report', id)

    async def answer(self, backend, **kwargs):
        payload = json.loads(kwargs['content']); self.calls.append((payload, kwargs))
        stance = 'agree' if payload['role']['name'] == 'first' else 'disagree'
        output = {'summary': stance, 'claims': [{'sourceMessageId': 'answer', 'quote': '实现已完成', 'stance': stance, 'reason': '独立评议', 'suggestion': '', 'evidenceRefs': []}], 'limits': ['未验证运行'], 'confidence': None}
        kwargs['on_delta'](StreamDelta(kwargs['session_id'], kwargs['message_id'], 'text_delta', text=json.dumps(output)))

    async def test_frozen_batch_contexts_opposition_and_reference(self):
        batch = self.submit()
        self.source.messages.append(ChatMessage('later', 'assistant', 'later answer'))
        await self.wait()
        reports = [self.report(key) for key in batch['reports']]
        self.assertEqual([row['status'] for row in reports], ['done', 'done'])
        self.assertEqual(reports[0]['counts']['agree'], 1)
        self.assertEqual(reports[1]['counts']['disagree'], 1)
        self.assertIsNone(reports[0]['confidence'])
        self.assertEqual(self.calls[0][0]['snapshot'], self.calls[1][0]['snapshot'])
        self.assertNotIn('later', json.dumps(self.calls[0][0]['snapshot']))
        self.assertEqual(self.source.agent_session_id, 'main-native')
        self.assertNotEqual(reports[0]['sessionId'], reports[1]['sessionId'])
        for report in reports:
            child = self.bridge._session_store.load(report['sessionId'])
            self.assertNotEqual(child.working_dir, str(self.project))
            self.assertFalse(child.followup_suggestions_enabled)
            self.assertIsNone(child.agent_session_id)
            self.assertTrue(Path(report['outputPath']).is_file())
        ref = json.loads(self.bridge._rpc_reviewReference('main', reports[0]['id'], reports[0]['revision'], '["claim-1"]'))
        self.assertEqual(ref['claims'][0]['stance'], 'agree')

    async def test_role_and_sync_review_registries_coexist(self):
        sync_jobs = self.bridge._review_jobs()
        try:
            batch = self.submit(roles=self.roles[:1])
            self.assertEqual(batch['status'], 'running')
            await self.wait()
            self.assertEqual(self.report(batch['reports'][0])['status'], 'done')
            self.assertIs(self.bridge._review_jobs(), sync_jobs)
            self.assertFalse(sync_jobs)
            self.assertEqual(len(self.calls), 1)
        finally:
            self.bridge._sync_review_executor.shutdown(wait=True)

    async def test_preparation_failure_has_cause_counts_and_no_model_or_orphan_task(self):
        original = self.bridge._review_child
        def prepare(source, role, *args):
            if role['id'] == self.roles[1]['id']:
                raise CollaborationError('测试配置不可用')
            return original(source, role, *args)
        with patch.object(self.bridge, '_review_child', side_effect=prepare):
            batch = self.submit()
        self.assertEqual(batch['status'], 'error')
        self.assertEqual(batch['notice'], '测试配置不可用')
        self.assertEqual(batch['counts'], {'total': 2, 'done': 0, 'failed': 2})
        self.assertEqual(batch['targets'], [{'id': 'answer', 'text': '实现已完成'}])
        self.assertFalse(self.bridge._review_runtime()['tasks'])
        self.assertFalse(self.calls)
        self.assertEqual(self.report(batch['reports'][0])['status'], 'error')
        self.assertEqual(self.submit()['id'], batch['id'])
        self.assertFalse(self.calls)

    def test_direct_old_answer_has_preview_without_loading_all_history(self):
        self.source.messages.extend(ChatMessage(f'later-{i}', 'assistant', f'第 {i} 条回答') for i in range(60))
        recent = json.loads(self.bridge._rpc_reviewTargets('main'))
        self.assertEqual(len(recent), 50)
        selected = json.loads(self.bridge._rpc_reviewTargets('main', '["answer"]'))
        self.assertEqual(len(selected), 51)
        self.assertEqual(selected[0]['id'], 'answer')
        self.assertEqual(selected[-1]['id'], 'later-59')
        self.assertFalse(self.calls)

    async def test_rejection_is_queryable_and_never_replayed(self):
        self.roles[0]['revision'] = 900
        result = self.submit()
        self.assertEqual(result['status'], 'error')
        self.assertIn('角色已变化', result['notice'])
        self.assertEqual(self.submit()['status'], 'error')
        self.assertEqual(json.loads(self.bridge._rpc_reviewStatus('main', 'batch'))['status'], 'error')
        self.assertFalse(self.calls)

    async def test_fixed_reference_never_resolves_deleted_source_or_same_name_role(self):
        batch = self.submit(); await self.wait()
        report = self.report(batch['reports'][0])
        reference = json.loads(self.bridge._rpc_reviewReference('main', report['id'], report['revision']))
        child = self.bridge._session_store.load(report['sessionId'])
        available = json.loads(self.bridge._rpc_reviewReferenceLookup(child.id, 'main', report['id'], report['revision']))
        self.assertEqual(available['status'], 'available')
        self.bridge._active_sessions.pop('main')
        original = self.bridge._require_session_access
        self.bridge._require_session_access = lambda sid: (_ for _ in ()).throw(PermissionError('deleted')) if sid == 'main' else original(sid)
        missing = json.loads(self.bridge._rpc_reviewReferenceLookup(child.id, 'main', report['id'], report['revision']))
        self.assertEqual(missing['status'], 'unavailable')
        self.assertIn('源已不可访问', missing['notice'])
        self.assertEqual(reference['claims'][0]['stance'], 'agree')

    async def test_cancel_before_start_and_partial_failure_are_independent(self):
        batch = self.submit()
        self.bridge._rpc_reviewStop('main', batch['id'], batch['reports'][0])
        results = await asyncio.gather(*list(self.bridge._review_runtime()['tasks'].values()), return_exceptions=True)
        self.assertTrue(all(value is None or isinstance(value, asyncio.CancelledError) for value in results))
        await asyncio.sleep(0)
        self.assertEqual(self.report(batch['reports'][0])['status'], 'cancelled')
        self.assertEqual(self.report(batch['reports'][1])['status'], 'done')
        result = json.loads(self.bridge._rpc_reviewStatus('main', batch['id']))
        self.assertEqual(result['counts']['failed'], 1)
        self.assertEqual(result['counts']['agree'], 0)
        self.assertEqual(result['counts']['disagree'], 1)

    async def test_source_deleted_before_run_never_calls_model(self):
        batch = self.submit()
        self.bridge._active_sessions.clear()
        with patch.object(self.bridge._session_store, 'load', return_value=None):
            await self.wait()
        self.assertFalse(self.calls)
        self.assertTrue(all(self.report(key)['status'] == 'error' for key in batch['reports']))

    async def test_lost_final_persistence_blocks_context_reuse_and_restart_does_not_replay(self):
        store = self.bridge._collaboration_store(); write = store.write
        def fail_final(scope, kind, key, body, revision):
            if kind == 'report' and body.get('status') == 'done': raise OSError('disk failure')
            return write(scope, kind, key, body, revision)
        with patch.object(store, 'write', side_effect=fail_final):
            batch = self.submit(roles=self.roles[:1]); await self.wait()
        status = json.loads(self.bridge._rpc_reviewStatus('main', batch['id']))
        self.assertEqual(status['status'], 'unknown')
        self.assertEqual(self.submit('after-failure', self.roles[:1])['status'], 'error')
        self.bridge._role_review_runtime_state = {'tasks': {}, 'locks': {}, 'semaphore': asyncio.Semaphore(3)}
        self.assertEqual(self.submit(roles=self.roles[:1])['status'], 'unknown')
        self.assertEqual(len(self.calls), 1)

    async def test_same_source_reuses_child_history_other_source_isolated_and_no_repeat(self):
        batch = self.submit(roles=self.roles[:1]); await self.wait()
        again = self.submit(roles=self.roles[:1])
        self.assertEqual(again['reports'], batch['reports']); self.assertEqual(len(self.calls), 1)
        second = self.submit('batch2', self.roles[:1]); await self.wait()
        self.assertEqual(self.report(second['reports'][0])['sessionId'], self.report(batch['reports'][0])['sessionId'])
        self.assertTrue(self.calls[-1][0]['priorVisibleHistory'])
        other = Session('other', 'other', 1, 1, list(self.source.messages), str(self.project), 'api', owner_id='tester')
        self.bridge._active_sessions['other'] = other; self.bridge._session_store.save(other, async_=False)
        third = self.submit('batch3', self.roles[:1], source='other'); await self.wait()
        self.assertNotEqual(self.report(third['reports'][0])['sessionId'], self.report(batch['reports'][0])['sessionId'])
        self.assertFalse(self.calls[-1][0]['priorVisibleHistory'])

    async def test_readonly_evidence_queries_cannot_write_or_escape(self):
        count = 0
        async def query(backend, **kwargs):
            nonlocal count
            count += 1
            if count == 1:
                packet = {'type': 'query', 'queries': [{'operation': 'read_text', 'arguments': {'path': 'proof.txt', 'offset': 0, 'limit': 1000}},
                    {'operation': 'read_text', 'arguments': {'path': '../secret', 'offset': 0, 'limit': 1000}}]}
                kwargs['on_delta'](StreamDelta('x', 'x', 'text_delta', text=json.dumps(packet)))
            else:
                data = json.loads(kwargs['content'])
                self.assertIn('actual evidence', json.dumps(data['evidence']))
                self.assertFalse(data['evidence'][1]['result']['complete'])
                await self.answer(backend, **kwargs)
        with patch('src.backend.role_reviews.send_text_only', side_effect=query):
            batch = self.submit(roles=self.roles[:1]); await self.wait()
        self.assertEqual(self.report(batch['reports'][0])['status'], 'done')
        self.assertEqual((self.project / 'proof.txt').read_text(encoding='utf-8'), 'actual evidence')

    async def test_role_serial_and_node_bounded_parallelism_stop_is_local(self):
        roles = [self.role('extra-' + str(i)) for i in range(5)]
        active = set(); maximum = 0; release = asyncio.Event()
        async def slow(backend, **kwargs):
            nonlocal maximum
            sid = kwargs['session_id']; self.assertNotIn(sid, active)
            active.add(sid); maximum = max(maximum, len(active))
            try: await release.wait(); await self.answer(backend, **kwargs)
            finally: active.remove(sid)
        with patch('src.backend.role_reviews.send_text_only', side_effect=slow):
            first = self.submit(roles=roles)
            second = self.submit('second-batch', roles[:1])
            for _ in range(30):
                if len(active) == 3: break
                await asyncio.sleep(.01)
            self.assertEqual(len(active), 3)
            self.bridge._rpc_reviewStop('main', first['id'], first['reports'][0])
            release.set(); await self.wait()
        self.assertLessEqual(maximum, 3)
        self.assertEqual(self.report(first['reports'][0])['status'], 'cancelled')
        self.assertEqual(self.report(second['reports'][0])['status'], 'done')

    async def test_invalid_reports_do_not_count_as_agree_and_unknown_is_not_replayed(self):
        async def invalid(backend, **kwargs): kwargs['on_delta'](StreamDelta('x', 'x', 'text_delta', text='not json'))
        with patch('src.backend.role_reviews.send_text_only', side_effect=invalid):
            batch = self.submit(); await self.wait()
        self.assertEqual(self.report(batch['reports'][0])['counts'], {})
        self.assertEqual(self.report(batch['reports'][0])['status'], 'invalid')
        self.bridge._role_review_runtime_state = {'tasks': {}, 'locks': {}, 'semaphore': asyncio.Semaphore(3)}
        self.submit(); self.assertFalse(self.calls)

    def test_report_contract_rejects_unknown_claim_evidence_and_invalid_confidence(self):
        snapshot = json.loads(self.bridge._rpc_reviewSnapshot('main'))
        report = {'summary': 'x', 'claims': [{'sourceMessageId': 'answer', 'stance': 'unknown', 'reason': 'no proof'}], 'limits': []}
        self.assertIsNone(parse_report(json.dumps(report), snapshot, [])['confidence'])
        with self.assertRaises(CollaborationError): parse_report(json.dumps({**report, 'confidence': True}), snapshot, [])
        report['claims'][0]['evidenceRefs'] = ['invented']
        with self.assertRaises(CollaborationError): parse_report(json.dumps(report), snapshot, [])

    def test_quote_across_bold_boundary_matches_without_fuzzy_acceptance(self):
        self.source.messages[-1].content = '**数据已找到，但关联仍待核对**：需要验证。'
        snapshot = json.loads(self.bridge._rpc_reviewSnapshot('main'))
        output = {'summary': '需要验证', 'confidence': .72, 'limits': [], 'claims': [
            {'sourceMessageId': 'answer', 'quote': '数据已找到，但关联仍待核对：需要验证', 'stance': 'partial', 'reason': '尚未验证'}]}
        result = parse_report(json.dumps(output), snapshot, [])
        self.assertEqual('markdown', result['claims'][0]['quoteMatch'])
        self.assertEqual(1, result['counts']['partial'])
        for quote in ('数据已找到，关联已经核对：需要验证', '数据已找到，但关联仍待核对：不需要验证'):
            output['claims'][0]['quote'] = quote
            with self.assertRaisesRegex(CollaborationError, '第 1 条'):
                parse_report(json.dumps(output), snapshot, [])
        self.assertEqual('`**literal**`', quote_text('`**literal**`'))
        self.assertEqual(r'\*literal\*', quote_text(r'\*literal\*'))
        self.assertEqual('value_with_underscore', quote_text('value_with_underscore'))

    async def test_live_output_is_queryable_before_model_completion_and_does_not_expose_thinking(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def slow(backend, **kwargs):
            kwargs['on_delta'](StreamDelta('child', 'report', 'thinking', text='PRIVATE REASONING'))
            kwargs['on_delta'](StreamDelta('child', 'report', 'text_delta', text='{"summary":'))
            entered.set()
            await finish.wait()
        with patch('src.backend.role_reviews.send_text_only', side_effect=slow):
            batch = self.submit(roles=self.roles[:1])
            await entered.wait()
            status = json.loads(self.bridge._rpc_reviewStatus('main', batch['id']))
            progress = status['reportSummaries'][0]['progress']
            self.assertEqual('running', status['reportSummaries'][0]['status'])
            self.assertEqual('{"summary":', progress['output'])
            self.assertNotIn('PRIVATE', json.dumps(progress))
            await asyncio.sleep(.55)
            events = [call.args[1] for call in self.bridge._emit_event.call_args_list if call.args[0] == 'reviewUpdated' and call.args[1].get('kind') == 'progress']
            self.assertTrue(any(row['progress']['output'] == '{"summary":' for row in events))
            finish.set()
            await self.wait()
        report = self.report(batch['reports'][0])
        self.assertEqual('{"summary":', report['progress']['output'])
        self.assertEqual('invalid', report['status'])
        self.assertFalse(self.bridge._review_runtime().get('progress'))

    async def test_reparse_old_invalid_opinion_preserves_artifact_and_uses_no_model(self):
        batch = self.submit(roles=self.roles[:1]); await self.wait()
        report = self.report(batch['reports'][0])
        output = Path(report['outputPath']).read_bytes()
        store = self.bridge._collaboration_store()
        old = {**report, 'status': 'invalid', 'notice': '意见引文与目标回答不符', 'counts': {}}
        old.pop('validationVersion', None)
        old = store.write(self.scope, 'report', report['id'], old, report['revision'])
        calls = len(self.calls)
        saved = json.loads(self.bridge._rpc_reviewRevalidate('main', old['id'], old['revision']))
        self.assertEqual('done', saved['status'])
        self.assertEqual(saved, json.loads(self.bridge._rpc_reviewRevalidate('main', old['id'], old['revision'])))
        self.assertEqual(calls, len(self.calls))
        self.assertEqual(output, Path(report['outputPath']).read_bytes())
        self.assertEqual(old['revision'], saved['previousValidation']['revision'])
        self.assertEqual('done', saved['progress']['phase'])
        self.assertGreater(saved['progress']['sequence'], old['progress']['sequence'])
        ref = json.loads(self.bridge._rpc_reviewReference('main', saved['id'], saved['revision']))
        self.assertEqual(1, len(ref['claims']))

    async def test_reparse_rejects_wrong_target_and_keeps_invalid_original(self):
        batch = self.submit(roles=self.roles[:1]); await self.wait()
        report = self.report(batch['reports'][0])
        raw = json.loads(report['raw']); raw['claims'][0]['sourceMessageId'] = 'different-answer'
        old = {**report, 'status': 'invalid', 'raw': json.dumps(raw)}
        old.pop('validationVersion', None)
        old = self.bridge._collaboration_store().write(self.scope, 'report', report['id'], old, report['revision'])
        with self.assertRaises(CollaborationError): self.bridge._rpc_reviewRevalidate('main', old['id'], old['revision'])
        self.assertEqual(old, self.report(report['id']))

    async def test_query_progress_and_previous_round_output_are_retained(self):
        calls = 0
        async def query(backend, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                packet = {'type': 'query', 'queries': [{'operation': 'read_text', 'arguments': {'path': 'proof.txt'}}]}
                kwargs['on_delta'](StreamDelta('child', 'report', 'text_delta', text=json.dumps(packet)))
            else:
                await self.answer(backend, **kwargs)
        with patch('src.backend.role_reviews.send_text_only', side_effect=query):
            batch = self.submit(roles=self.roles[:1]); await self.wait()
        report = self.report(batch['reports'][0])
        self.assertEqual(1, report['progress']['evidenceCount'])
        self.assertIn('read_text', report['progress']['roundOutputs'][0]['output'])
        self.assertTrue(any('proof.txt' in event['message'] for event in report['progress']['events']))
        events = [call.args[1] for call in self.bridge._emit_event.call_args_list if call.args[0] == 'reviewUpdated' and call.args[1].get('kind') == 'progress']
        self.assertTrue(any(event['progress'].get('roundOutputs') for event in events))

    async def test_native_partial_failure_preserves_visible_output_without_inventing_a_report(self):
        self.bridge._backend_configs[0].type = BackendType.CODEX_OFFICIAL
        async def failed(backend, **kwargs):
            kwargs['on_activity']('{"summary":"still working')
            raise RuntimeError('connection lost')
        with patch('src.backend.role_reviews.send_text_only', side_effect=failed):
            batch = self.submit(roles=self.roles[:1]); await self.wait()
        report = self.report(batch['reports'][0])
        self.assertEqual('error', report['status'])
        self.assertEqual('{"summary":"still working', report['progress']['output'])
        self.assertEqual({}, report['counts'])
        artifact = json.loads(Path(report['outputPath']).read_text(encoding='utf-8'))
        self.assertEqual(report['progress']['output'], artifact['progress']['output'])

    async def test_fast_output_is_coalesced_bounded_and_trailing_text_is_delivered(self):
        events = []
        output = ReviewOutput({'id': 'r', 'revision': 1, 'batchId': 'b', 'sourceSessionId': 's'}, events.append)
        try:
            output.change('waiting', 'submitted', round=1)
            for _ in range(300): output.text('x' * 100)
            self.assertEqual(1, len(events))
            await asyncio.sleep(.55)
            self.assertEqual(2, len(events))
            self.assertEqual(30000, events[-1]['progress']['outputCharacters'])
            self.assertEqual('x' * 24000, events[-1]['progress']['output'])
            output.change('waiting', 'next round', round=2, output='', outputCharacters=0)
            self.assertEqual('x' * 24000, events[-1]['progress']['roundOutputs'][0]['output'])
            output.text('last chunk'); output.close()
            count = len(events)
            await asyncio.sleep(.55)
            self.assertEqual(count, len(events))
        finally:
            output.close()

    async def test_explicit_summary_is_bounded_and_not_regenerated_on_replay(self):
        self.source.messages[-1].content = '长回答' * 50000
        with self.assertRaises(CollaborationError): self.bridge._rpc_reviewSnapshot('main')
        calls = []
        async def summarize(backend, **kwargs):
            calls.append(kwargs)
            self.assertLess(len(kwargs['content']), 121000)
            kwargs['on_delta'](StreamDelta('summary', 'summary', 'text_delta', text='[{"id":"answer","text":"待核验的完成主张"}]'))
        with patch('src.backend.role_reviews.send_text_only', side_effect=summarize):
            first = json.loads(await self.bridge._rpc_reviewSummarize('main', 'summary-request'))
            again = json.loads(await self.bridge._rpc_reviewSummarize('main', 'summary-request'))
        self.assertEqual(len(calls), 1)
        self.assertEqual(first, again)
        self.assertEqual(first['mode'], 'summary')
        self.assertGreater(first['omittedCharacters'], 0)
        self.assertTrue(first['limits'])

    async def test_changed_route_requires_explicit_context_and_keeps_old_history(self):
        first = self.submit(roles=self.roles[:1]); await self.wait()
        old_child = self.report(first['reports'][0])['sessionId']
        self.bridge._backend_configs[0].model = 'new-route'
        rejected = self.submit('different-route', self.roles[:1])
        self.assertEqual(rejected['status'], 'error')
        self.assertIn('另开', rejected['notice'])
        self.assertEqual(len(self.calls), 1)
        third = self.submit('new-context', self.roles[:1], newContext=True); await self.wait()
        self.assertNotEqual(self.report(third['reports'][0])['sessionId'], old_child)
        self.assertTrue(self.bridge._session_store.load(old_child).messages)
