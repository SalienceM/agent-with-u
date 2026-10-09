import json
import asyncio
import threading
import os
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, AsyncMock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.chat_extras_store import ChatExtras, SeqTask
from src.backend.loop_control import ControlFacts, eligibility, normalize_operation, normalize_receipts
from src.backend.loop_store import LoopState, LoopRecord, LoopStore, AsideTurn
from src.types import ChatMessage
from src.backend.loop_control_persistence import OrderedLoopWrites
from src.backend.loop_control_snapshot import SnapshotResult, snapshot_handoff
from src.backend.session_store import SessionStore


class EligibilityTests(unittest.IsolatedAsyncioTestCase):
    def test_reason_table(self):
        base = ControlFacts()
        cases = [
            ('takeover', {}, 'ready'),
            ('takeover', {'available': False}, 'unavailable'),
            ('takeover', {'stage': 'loopidea'}, 'idea_unsealed'),
            ('takeover', {'stage': 'loopout'}, 'ready'),
            ('takeover', {'running': True}, 'loop_running'),
            ('takeover', {'resumable': True}, 'loop_resumable'),
            ('takeover', {'stage': 'loopout', 'resumable': True}, 'ready'),
            ('takeover', {'active_call': True}, 'active_call'),
            ('takeover', {'chat_running': True}, 'chat_running'),
            ('release', {'mode': 'manual', 'chat_running': True}, 'chat_running'),
            ('release', {'mode': 'manual', 'manual_has_messages': True, 'sequence_pending': True}, 'sequence_pending'),
            ('release', {'mode': 'manual', 'sequence_pending': True}, 'ready'),
            ('release', {'mode': 'manual', 'active_call': True}, 'active_call'),
            ('release', {'reserved': True}, 'handoff_busy'),
        ]
        for action, values, reason in cases:
            with self.subTest(action=action, values=values):
                result = eligibility(action, replace(base, **values))
                self.assertEqual(result['reasonCode'], reason)
                self.assertEqual(result['allowed'], reason == 'ready')
                self.assertTrue(result['message'])
                self.assertTrue(result['nextStep'])

    async def test_display_and_mutation_share_rejections(self):
        for action, reason in [('takeover', 'loop_resumable'), ('release', 'sequence_pending')]:
            with self.subTest(action=action):
                state = LoopState(session_id='s', stage='loopexecute',
                    control_mode='manual' if action == 'release' else 'loop',
                    loops=[LoopRecord(seq=1, kind='manual' if action == 'release' else 'agent')])
                session = SimpleNamespace(id='s', session_type='loop', messages=[object()])
                bridge = BridgeWS.__new__(BridgeWS)
                bridge._active_sessions = {'s': session}
                bridge._loop_states = {'s': state}
                bridge._session_store = SimpleNamespace(load=lambda _: session)
                bridge._chat_extras = {'s': ChatExtras(session_id='s',
                    seq_tasks=[SeqTask(id='queued')])}
                bridge._loop_save = Mock()
                bridge._require_session_access = Mock()
                shown = bridge._loop_control_eligibility(state)[action]
                handler = bridge._rpc_loopTakeover if action == 'takeover' else bridge._rpc_loopRelease
                actual = json.loads(await handler('s'))
                self.assertEqual(shown['reasonCode'], reason)
                self.assertEqual(actual['reasonCode'], shown['reasonCode'])
                self.assertEqual(actual['message'], shown['message'])
                bridge._loop_save.assert_not_called()


def receipt(index=1, **extra):
    return {'requestId': f'request-{index}', 'action': 'takeover', 'status': 'succeeded',
            'sourceMode': 'loop', 'targetMode': 'manual', 'phase': 'done', 'revision': 4,
            'sourceControlRevision': 0, 'controlRevision': 2, 'startedAt': 1, 'updatedAt': 2,
            'committed': True, 'checkpointAvailable': True, 'reasonCode': 'ready', **extra}


class ReceiptTests(unittest.TestCase):
    def test_revision_advances_only_on_acceptance_and_commit(self):
        state = LoopState(session_id='s')
        state.accept_control_operation(receipt(status='accepted', committed=False))
        self.assertEqual(state.control_revision, 1)
        with self.assertRaises(ValueError):
            state.accept_control_operation(receipt(status='accepted', committed=False))
        state.finish_control_operation(receipt())
        self.assertEqual(state.control_revision, 2)
        with self.assertRaises(ValueError):
            state.finish_control_operation(receipt())
        with self.assertRaises(ValueError):
            state.accept_control_operation(receipt(2, status='accepted', committed=False))
        self.assertEqual(state.control_revision, 2)

    def test_legacy_is_unknown(self):
        state = LoopState.from_dict({'sessionId': 'old'})
        self.assertEqual(state.control_revision, 0)
        self.assertEqual(state.control_operation, {})
        self.assertEqual(state.control_receipts, [])

    def test_bounded_receipts_and_sensitive_fields(self):
        op = receipt(message='secret', goal='secret', token='secret', exception='secret',
                     inputDigest='a' * 64, identityDigest='b' * 64)
        state = LoopState(session_id='s', control_revision=12, control_operation=op,
                          control_receipts=[receipt(i) for i in range(20)])
        restored = LoopState.from_dict(state.to_dict())
        self.assertEqual(restored.control_revision, 12)
        self.assertEqual(len(restored.control_receipts), 8)
        self.assertEqual(restored.control_receipts[0]['requestId'], 'request-12')
        self.assertNotIn('secret', json.dumps(restored.to_dict()))
        with tempfile.TemporaryDirectory() as temp:
            with patch('src.backend.loop_store.paths.sub', return_value=Path(temp)):
                store = LoopStore()
                store.save(restored)
                loaded = store.load('s')
                self.assertEqual(loaded.control_operation, restored.control_operation)
                meta = store.load_meta('s')
                self.assertEqual(meta['controlRevision'], 12)
                self.assertNotIn('inputDigest', meta['controlOperation'])
                self.assertNotIn('controlReceipts', meta)
                self.assertLess(len(json.dumps(meta)), 1500)
                store._meta_path('s').unlink()
                rebuilt = store.load_meta('s')
                self.assertEqual(rebuilt['controlRevision'], 12)
                self.assertEqual(rebuilt['controlOperation'], meta['controlOperation'])
                stale = {**meta, 'controlMode': 'loop', '_stateMtimeNs': 0}
                store._meta_path('s').write_text(json.dumps(stale), encoding='utf-8')
                self.assertEqual(store.load_meta('s')['controlRevision'], 12)

    def test_invalid_receipts_are_unknown_and_duplicates_are_bounded(self):
        self.assertEqual(normalize_operation({'requestId': 'bad\n'}), {})
        self.assertEqual(normalize_receipts([receipt()] * 30), [normalize_operation(receipt())])
        self.assertEqual(normalize_receipts([receipt(status='running')]), [])


class OrderedWriteTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_commit_keeps_loop_responsive_and_merges_queued_appends(self):
        entered, finish = threading.Event(), threading.Event()
        writes = []

        def write(data):
            if data.get('controlMode') == 'manual' and not writes:
                entered.set()
                finish.wait(2)
            writes.append(data)

        queue = OrderedLoopWrites(write)
        source = {'sessionId': 's', 'controlMode': 'loop', 'addons': [], 'asides': []}
        commit = queue.enqueue(source, commit_patch={'controlMode': 'manual', 'controlRevision': 2})
        await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
        source['addons'].append({'text': 'concurrent addon'})
        queue.enqueue(source)
        source['asides'].append({'answer': 'concurrent aside'})
        queue.enqueue(source)
        self.assertFalse(commit.done())
        self.assertEqual(writes, [])
        finish.set()
        await queue.flush()
        self.assertEqual(len(writes), 3)
        self.assertTrue(all(row['controlMode'] == 'manual' for row in writes))
        self.assertEqual(len(writes[-1]['addons']), 1)
        self.assertEqual(len(writes[-1]['asides']), 1)
        self.assertEqual(writes[0]['addons'], [])

    async def test_failed_commit_does_not_apply_target_to_subsequent_save(self):
        writes = []

        def write(data):
            if data['controlMode'] == 'manual':
                raise OSError('injected disk failure')
            writes.append(data)

        queue = OrderedLoopWrites(write)
        source = {'controlMode': 'loop', 'addons': []}
        failed = queue.enqueue(source, commit_patch={'controlMode': 'manual'})
        queue.enqueue({**source, 'addons': [1]})
        with self.assertRaises(OSError):
            await failed
        await queue.flush()
        self.assertEqual(writes[-1], {'controlMode': 'loop', 'addons': [1]})
        self.assertEqual(queue.committed_patch, {})


class HandoffIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        with patch('src.backend.loop_store.paths.sub', return_value=Path(self.temp.name)):
            store = LoopStore()
        self.state = LoopState(session_id='s', stage='loopexecute')
        self.session = SimpleNamespace(id='s', owner_id='local', session_type='loop',
            messages=[], working_dir=self.temp.name, backend_id='fake', agent_session_id='',
            loop_control_mode='loop')
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {'s': self.session}
        self.bridge._session_store = SimpleNamespace(load=lambda _: self.session,
            get_meta=lambda _: None, save=Mock())
        self.bridge._loop_states = {'s': self.state}
        self.bridge._loop_store = store
        self.bridge._emit_loop_updated = Mock()
        self.bridge._mirror_loop_control_mode = Mock()
        self.bridge._loop_context_digest = Mock(return_value='bounded context')
        self.bridge._session_runtime = Mock(return_value={})
        self.bridge._resolved_runtime = Mock(return_value={})
        self.extras = ChatExtras(session_id='s')
        self.bridge._chat_extras = {'s': self.extras}
        self.bridge._ensure_kit_scheduler = Mock()
        self.bridge._loop_run_agent = Mock(side_effect=AssertionError('no model calls allowed'))
        self.git = patch('src.backend.loop_control_bridge.snapshot_handoff',
                         new_callable=AsyncMock, return_value=SnapshotResult(git='checkpoint')).start()
        self.addCleanup(patch.stopall)

    async def request(self, rid='one', action='takeover', expected=None, **extra):
        return json.loads(await self.bridge._rpc_loopControlRequest('s', json.dumps({
            'requestId': rid, 'action': action, 'expectedControlRevision':
                self.state.control_revision if expected is None else expected, **extra})))

    async def finish(self):
        task = self.bridge._loop_control_jobs.get('s', {}).get('task')
        if task:
            await asyncio.wait_for(asyncio.shield(task), 3)

    async def test_authorization_inputs_and_read_only(self):
        self.assertEqual(json.loads(await self.bridge._rpc_loopControlGet('s'))['protocolVersion'], 1)
        self.assertFalse(self.state.control_operation)
        self.git.assert_not_called()
        for sid in ('missing', 'other'):
            with self.assertRaises(PermissionError):
                await self.bridge._rpc_loopControlGet(sid)
        self.session.owner_id = 'someone-else'
        with self.assertRaises(PermissionError):
            await self.request()
        self.session.owner_id = 'local'
        for value in ('null', '[]', '{}', '{', '{"requestId": "bad\\n"}'):
            result = json.loads(await self.bridge._rpc_loopControlRequest('s', value))
            self.assertEqual(result['reasonCode'], 'invalid_request')
        self.assertEqual((await self.request(expected=True))['reasonCode'], 'invalid_request')
        self.assertEqual((await self.request(goal='not loopout'))['reasonCode'], 'invalid_request')
        self.git.assert_not_called()

    async def test_slow_snapshot_deduplicates_and_timeout_retains_lock(self):
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        async def slow(_cwd, _action, _budget):
            entered.set()
            await asyncio.to_thread(finish.wait, 2)
            return SnapshotResult(git='checkpoint')
        self.git.side_effect = slow
        self.bridge._loop_control_snapshot_budget = .01
        accepted = await self.request()
        self.assertEqual(accepted['status'], 'accepted')
        self.assertEqual(accepted['controlMode'], 'loop')
        await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
        await asyncio.sleep(.04)
        self.assertTrue(self.bridge._loop_control_reserved('s'))
        self.assertFalse(self.bridge._loop_control_reserved('other'))
        self.assertEqual(self.state.control_operation['status'], 'unresolved')
        result = json.loads(await asyncio.wait_for(self.bridge._dispatch('loopControlGet', ['s']), .5))
        self.assertFalse(result['operation']['committed'])
        self.assertEqual((await self.request(expected=0))['operation']['requestId'], 'one')
        self.assertEqual((await self.request(expected=0, goal='different'))['reasonCode'], 'request_conflict')
        self.assertEqual((await self.request('opposite', 'release'))['reasonCode'], 'handoff_busy')
        for method, params in [('loopSetGoal', ['s', 'forbidden']), ('loopSetAuto', ['s', True]),
                               ('loopAdvanceToOut', ['s']), ('loopExecutionEnvironmentCheck', ['s', 0]),
                               ('seqtaskTakeNext', ['s'])]:
            with self.subTest(method=method):
                denied = json.loads(await self.bridge._dispatch(method, params))
                self.assertEqual(denied['reasonCode'], 'handoff_busy')
        self.assertFalse(self.bridge._schedule_loop_iteration('s'))
        with self.assertRaises(ValueError):
            self.bridge._start_chat_turn(json.dumps({'sessionId': 's'}))
        finish.set()
        await self.finish()
        self.assertEqual(self.state.control_mode, 'manual')
        self.assertEqual(self.state.control_revision, 2)
        self.assertEqual(len(self.state.loops), 1)
        self.assertEqual((await self.request(expected=0))['operation']['status'], 'succeeded')
        self.git.assert_called_once()
        self.bridge._loop_run_agent.assert_not_called()

    async def test_commit_failure_does_not_open_round(self):
        self.state.stage = 'loopout'
        self.state.round = 3
        original = self.bridge._loop_store.save_frozen
        def fail_commit(data):
            if data['controlMode'] == 'manual':
                raise OSError('injected fsync failure')
            original(data)
        self.bridge._loop_store.save_frozen = fail_commit
        await self.request(goal='new goal')
        await self.finish()
        self.assertEqual(self.state.control_mode, 'loop')
        self.assertEqual(self.state.round, 3)
        self.assertEqual(self.state.loops, [])
        self.assertEqual(self.state.control_operation['status'], 'failed')
        self.assertFalse(self.bridge._loop_control_reserved('s'))

    async def _cancel_during_persistence(self, final_commit: bool) -> None:
        entered, proceed = threading.Event(), threading.Event()
        original = self.bridge._loop_store.save_frozen
        def slow(data):
            operation = data.get('controlOperation', {})
            if (operation.get('committed') if final_commit else operation.get('phase') == 'committing'):
                entered.set()
                if not proceed.wait(3):
                    raise TimeoutError('isolated test write timed out')
            original(data)
        self.bridge._loop_store.save_frozen = slow
        try:
            await self.request()
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            job = self.bridge._loop_control_jobs['s']['task']
            job.cancel()
            await job
            pending = json.loads(await asyncio.wait_for(self.bridge._rpc_loopControlGet('s'), .5))
            self.assertEqual(pending['controlMode'], 'loop')
            self.assertEqual(pending['operation']['status'], 'unresolved')
            self.assertTrue(self.bridge._loop_control_reserved('s'))
            self.assertEqual((await self.request('another'))['reasonCode'], 'handoff_busy')
            proceed.set()
            await self.bridge._loop_control_writes['s'].flush()
            response = json.loads(await self.bridge._rpc_loopControlGet('s'))
            saved = self.bridge._loop_store.load('s')
            expected_mode = 'manual' if final_commit else 'loop'
            self.assertEqual(response['controlMode'], expected_mode)
            self.assertEqual(response['controlMode'], saved.control_mode)
            self.assertEqual(response['controlRevision'], saved.control_revision)
            self.assertEqual(response['operation']['status'], 'succeeded' if final_commit else 'interrupted')
            self.assertEqual(response['operation']['committed'], final_commit)
            self.assertEqual(saved.control_operation['committed'], final_commit)
            self.assertEqual(len(saved.loops), 1 if final_commit else 0)
            self.assertFalse(self.bridge._loop_control_reserved('s'))
            self.git.assert_called_once()
            self.bridge._loop_run_agent.assert_not_called()
        finally:
            proceed.set()
            writer = getattr(self.bridge, '_loop_control_writes', {}).get('s')
            if writer:
                await writer.flush()

    async def test_cancel_before_final_commit_retains_lock_until_phase_write_finishes(self):
        await self._cancel_during_persistence(final_commit=False)

    async def test_cancel_during_final_commit_reconciles_disk_memory_and_receipt(self):
        await self._cancel_during_persistence(final_commit=True)

    async def test_cancel_after_commit_repairs_mirror_and_releases_reservation(self):
        self.bridge._mirror_loop_control_mode.side_effect = asyncio.CancelledError()
        await self.request()
        await self.finish()
        self.assertEqual(self.state.control_mode, 'manual')
        self.assertTrue(self.bridge._loop_control_reserved('s'))
        self.bridge._mirror_loop_control_mode.side_effect = None
        response = json.loads(await self.bridge._rpc_loopControlGet('s'))
        self.assertEqual(response['operation']['status'], 'succeeded')
        self.assertTrue(response['operation']['committed'])
        self.assertFalse(self.bridge._loop_control_reserved('s'))
        self.bridge._mirror_loop_control_mode.assert_called_with(self.session, 'manual')
        self.git.assert_called_once()

    async def test_cancel_acceptance_wait_keeps_owned_write_and_recovers_without_worker(self):
        entered, proceed = threading.Event(), threading.Event()
        original = self.bridge._loop_store.save_frozen
        def slow(data):
            if data.get('controlOperation', {}).get('status') == 'accepted':
                entered.set()
                proceed.wait(3)
            original(data)
        self.bridge._loop_store.save_frozen = slow
        caller = asyncio.create_task(self.request())
        try:
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            self.bridge._loop_control_jobs['s']['acceptTask'].cancel()
            with self.assertRaises(asyncio.CancelledError):
                await caller
            self.assertTrue(self.bridge._loop_control_reserved('s'))
            proceed.set()
            await self.bridge._loop_control_writes['s'].flush()
            result = json.loads(await self.bridge._rpc_loopControlGet('s'))
            self.assertEqual(result['operation']['status'], 'interrupted')
            self.assertEqual(result['controlMode'], 'loop')
            self.assertFalse(self.bridge._loop_control_reserved('s'))
            self.git.assert_not_called()
        finally:
            proceed.set()
            writer = getattr(self.bridge, '_loop_control_writes', {}).get('s')
            if writer:
                await writer.flush()

    async def test_real_session_index_slow_disk_keeps_mirror_and_queries_responsive(self):
        with patch('src.backend.session_store.paths.sub', return_value=Path(self.temp.name) / 'sessions'):
            store = SessionStore()
        entered, proceed = threading.Event(), threading.Event()
        original = store._atomic_write_text
        saved_payloads = []
        def slow(path, payload):
            saved_payloads.append(json.loads(payload))
            if len(saved_payloads) == 1:
                entered.set()
                if not proceed.wait(3):
                    raise TimeoutError('isolated index write timed out')
            original(path, payload)
        store._atomic_write_text = slow
        self.session.meta_dict = lambda: {'id': 's', 'loopControlMode': self.session.loop_control_mode,
                                         'updatedAt': 1, 'ownerId': 'local'}
        store.update_meta(self.session)
        self.bridge._session_store = store
        self.bridge._mirror_loop_control_mode = BridgeWS._mirror_loop_control_mode.__get__(self.bridge)
        write = asyncio.create_task(asyncio.to_thread(store._save_index_sync))
        next_write = None
        try:
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            started = asyncio.get_running_loop().time()
            await self.request()
            await self.finish()
            result = json.loads(await self.bridge._rpc_loopControlGet('s'))
            self.assertLess(asyncio.get_running_loop().time() - started, 1)
            self.assertEqual(result['controlMode'], 'manual')
            self.assertEqual(store.get_meta('s')['loopControlMode'], 'manual')
            self.assertFalse(write.done())
            # 第二个写者只能在首个落盘后取最新索引；顺序等待不能卡住事件循环。
            next_write = asyncio.create_task(asyncio.to_thread(store._save_index_sync))
            await asyncio.sleep(.02)
            self.assertFalse(next_write.done())
            self.assertEqual(len(saved_payloads), 1)
            proceed.set()
            await asyncio.gather(write, next_write)
            saved = json.loads(store._index_path.read_text(encoding='utf-8'))
            self.assertEqual(saved[0]['loopControlMode'], 'manual')
            self.assertFalse(store._index_dirty)
            self.git.assert_called_once()
            self.bridge._loop_run_agent.assert_not_called()
        finally:
            proceed.set()
            await write
            if next_write is not None:
                await next_write
            if store._index_save_timer:
                store._index_save_timer.cancel()
                await asyncio.to_thread(store._index_save_timer.join, 3)
            store._io_running = False
            await asyncio.to_thread(store._io_thread.join, 3)

    async def test_session_index_preserves_dirty_new_values_and_failed_writes(self):
        with patch('src.backend.session_store.paths.sub', return_value=Path(self.temp.name) / 'sessions'):
            store = SessionStore()
        entered, proceed = threading.Event(), threading.Event()
        original = store._atomic_write_text
        def slow(path, payload):
            entered.set()
            proceed.wait(3)
            original(path, payload)
        store._atomic_write_text = slow
        session = SimpleNamespace(id='s', meta_dict=lambda: {'id': 's', 'nested': {'value': 1}})
        store.update_meta(session)
        write = asyncio.create_task(asyncio.to_thread(store._save_index_sync))
        try:
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            with store._lock:
                store._index['s']['nested']['value'] = 2
            proceed.set()
            await write
            self.assertTrue(store._index_dirty)
            self.assertEqual(json.loads(store._index_path.read_text(encoding='utf-8'))[0]['nested']['value'], 1)
            store._atomic_write_text = Mock(side_effect=OSError('disk full'))
            with self.assertRaises(OSError):
                await asyncio.to_thread(store._save_index_sync)
            self.assertTrue(store._index_dirty)
            store._atomic_write_text = original
            await asyncio.to_thread(store._save_index_sync)
            self.assertFalse(store._index_dirty)
            self.assertEqual(json.loads(store._index_path.read_text(encoding='utf-8'))[0]['nested']['value'], 2)
        finally:
            proceed.set()
            await write
            store._io_running = False
            await asyncio.to_thread(store._io_thread.join, 3)

    async def test_commit_merges_concurrent_addon_and_mirror_failure_is_not_retry(self):
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        original = self.bridge._loop_store.save_frozen
        def slow_commit(data):
            if data['controlMode'] == 'manual':
                entered.set()
                finish.wait(2)
            original(data)
        self.bridge._loop_store.save_frozen = slow_commit
        self.bridge._mirror_loop_control_mode.side_effect = OSError('injected mirror failure')
        await self.request()
        await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
        self.assertEqual(self.state.control_mode, 'loop')
        addon = asyncio.create_task(self.bridge._dispatch('loopAddAddon', ['s', 'keep this']))
        await asyncio.sleep(.01)
        self.state.asides.append(AsideTurn(id='aside', question='keep aside', answer='answer', status='done'))
        self.bridge._loop_save(self.state)
        self.assertFalse(addon.done())
        finish.set()
        await self.finish()
        self.assertEqual(json.loads(await addon)['status'], 'ok')
        self.assertEqual(self.state.addons[0].text, 'keep this')
        saved = self.bridge._loop_store.load('s')
        self.assertEqual(saved.control_mode, 'manual')
        self.assertEqual(saved.addons[0].text, 'keep this')
        self.assertEqual(saved.asides[0].answer, 'answer')
        self.bridge._mirror_loop_control_mode.side_effect = None
        result = json.loads(await self.bridge._rpc_loopControlGet('s', 'one'))
        self.assertTrue(result['operation']['committed'])
        self.bridge._mirror_loop_control_mode.assert_called_with(self.session, 'manual')
        self.git.assert_called_once()

    async def test_restart_unknown_work_never_replays_or_unlocks(self):
        self.state.control_operation = receipt(status='running', committed=False, phase='snapshot')
        response = json.loads(await self.bridge._rpc_loopControlGet('s'))
        self.assertEqual(response['operation']['status'], 'unresolved')
        self.assertEqual(response['currentOperation']['status'], 'unresolved')
        self.assertTrue(self.bridge._loop_control_reserved('s'))
        self.git.assert_not_called()
        self.assertEqual((await self.request('new'))['reasonCode'], 'handoff_busy')

    async def test_cold_restart_protects_direct_chat_and_legacy_queue_before_get(self):
        self.state.control_operation = receipt(status='running', committed=False, phase='snapshot')
        self.bridge._loop_store.save(self.state)
        self.bridge._loop_states.clear()
        self.assertTrue(self.bridge._loop_control_reserved('s'))
        with self.assertRaises(ValueError):
            self.bridge._start_chat_turn(json.dumps({'sessionId': 's'}))
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskTakeNext('s'))['reasonCode'], 'handoff_busy')
        self.assertFalse(self.bridge._loop_states)  # 轻量保护不为此加载全部历史。
        self.git.assert_not_called()

    async def test_restart_before_worker_is_interrupted_without_replay(self):
        self.state.control_operation = receipt(status='accepted', committed=False, phase='validating')
        response = json.loads(await self.bridge._rpc_loopControlGet('s'))
        self.assertEqual(response['operation']['status'], 'interrupted')
        self.assertFalse(self.bridge._loop_control_reserved('s'))
        self.git.assert_not_called()

    async def test_evicted_receipt_and_changed_executor_cannot_reexecute(self):
        for index in range(10):
            await self.request(str(index), 'takeover' if index % 2 == 0 else 'release')
            await self.finish()
        self.assertEqual(len(self.state.control_receipts), 8)
        self.assertEqual((await self.request('0', expected=0))['reasonCode'], 'stale_revision')
        with patch.object(self.bridge, '_loop_environment_executor', return_value='other-node'):
            self.assertEqual((await self.request('9', 'release', expected=18))['reasonCode'], 'request_conflict')
        self.assertEqual(self.git.call_count, 10)

    async def test_missing_checkpoint_warns_but_unconfirmed_exit_never_commits(self):
        self.git.return_value = SnapshotResult()
        await self.request()
        await self.finish()
        self.assertFalse(self.state.control_operation['checkpointAvailable'])
        self.assertEqual(self.state.control_operation['reasonCode'], 'snapshot_unavailable')
        self.git.return_value = SnapshotResult(exit_confirmed=False, owner=object())
        await self.request('release', 'release')
        await self.finish()
        self.assertEqual(self.state.control_mode, 'manual')
        self.assertTrue(self.bridge._loop_control_reserved('s'))
        self.assertEqual(self.state.control_operation['status'], 'unresolved')

    async def test_legacy_returns_terminal_and_empty_release_ignores_old_queue(self):
        self.state.stage = 'loopout'
        result = json.loads(await self.bridge._rpc_loopTakeover('s', 'new round'))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.state.round, 2)
        self.assertEqual(self.state.control_operation['status'], 'succeeded')
        self.extras.seq_tasks.append(SeqTask(id='queued'))
        result = json.loads(await self.bridge._rpc_loopRelease('s'))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.state.control_mode, 'loop')
        self.assertFalse(self.state.auto)
        self.assertEqual(self.state.loops, [])
        self.assertEqual(self.state.control_revision, 4)

    async def test_parallel_acceptance_and_legacy_wait_share_one_worker(self):
        entered, proceed = threading.Event(), threading.Event()
        self.addCleanup(proceed.set)
        original = self.bridge._loop_store.save_frozen
        def slow(data):
            if data.get('controlOperation', {}).get('status') == 'accepted':
                entered.set()
                proceed.wait(2)
            original(data)
        self.bridge._loop_store.save_frozen = slow
        self.state.stage = 'loopout'
        first = asyncio.create_task(self.request(goal='goal'))
        await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
        duplicate = asyncio.create_task(self.request(expected=0, goal='goal'))
        legacy = asyncio.create_task(self.bridge._rpc_loopTakeover('s', 'goal'))
        await asyncio.sleep(.01)
        self.assertFalse(legacy.done())
        self.assertEqual(json.loads(await self.bridge._rpc_loopTakeover('s', 'other'))['reasonCode'], 'request_conflict')
        with patch.object(self.bridge, '_loop_environment_executor', return_value='other'):
            self.assertEqual((await self.request(expected=0, goal='goal'))['reasonCode'], 'request_conflict')
        proceed.set()
        self.assertEqual((await first)['status'], 'accepted')
        self.assertEqual((await duplicate)['status'], 'accepted')
        self.assertEqual(json.loads(await legacy)['status'], 'ok')
        self.assertEqual(self.state.round, 2)
        self.assertEqual(len(self.state.loops), 1)
        self.git.assert_called_once()

    async def test_acceptance_failure_keeps_original_mode_and_no_worker(self):
        self.bridge._loop_store.save_frozen = Mock(side_effect=OSError('disk full'))
        self.assertEqual((await self.request())['reasonCode'], 'persistence_failed')
        self.assertEqual(self.state.control_revision, 0)
        self.assertEqual(self.state.control_mode, 'loop')
        self.assertFalse(self.bridge._loop_control_reserved('s'))
        self.git.assert_not_called()

    async def test_pending_legacy_dispatch_blocks_before_chat_task_exists(self):
        self.bridge._has_seq_dispatch_reservation = Mock(return_value=True)
        self.assertEqual((await self.request())['reasonCode'], 'chat_running')
        self.git.assert_not_called()

    async def test_mirror_failure_restores_in_memory_mode_then_get_repairs(self):
        self.bridge._mirror_loop_control_mode = BridgeWS._mirror_loop_control_mode.__get__(self.bridge)
        save = Mock(side_effect=OSError('metadata disk failure'))
        self.bridge._session_store.save_meta = save
        await self.request()
        await self.finish()
        self.assertEqual(self.session.loop_control_mode, 'loop')
        self.assertEqual(self.state.control_mode, 'manual')
        save.side_effect = None
        result = json.loads(await self.bridge._rpc_loopControlGet('s', 'one'))
        self.assertTrue(result['operation']['committed'])
        self.assertEqual(self.session.loop_control_mode, 'manual')
        self.git.assert_called_once()

    async def test_real_slow_fsync_does_not_block_other_session_meta(self):
        entered, proceed = threading.Event(), threading.Event()
        self.addCleanup(proceed.set)
        other = LoopState(session_id='other', stage='loopexecute')
        self.bridge._loop_store.save(other)
        real_fsync = os.fsync
        def slow(fd):
            entered.set()
            proceed.wait(2)
            real_fsync(fd)
        with patch('src.backend.loop_store.os.fsync', side_effect=slow):
            request = asyncio.create_task(self.request())
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            async def light():
                return self.bridge._loop_store.load_meta('other')
            self.assertEqual((await asyncio.wait_for(light(), .5))['controlMode'], 'loop')
            self.assertFalse(request.done())
            proceed.set()
            await request
            await self.finish()

    async def test_source_and_activity_are_revalidated_after_snapshot(self):
        async def changed_source(*_args):
            self.session.working_dir = self.temp.name + '/different'
            return SnapshotResult(git='checkpoint')
        self.git.side_effect = changed_source
        await self.request()
        await self.finish()
        self.assertEqual(self.state.control_operation['reasonCode'], 'stale_revision')
        self.assertEqual(self.state.control_mode, 'loop')
        self.assertEqual(self.state.loops, [])
        async def changed_activity(*_args):
            self.bridge._loop_has_active_call = Mock(return_value=True)
            return SnapshotResult(git='checkpoint')
        self.git.side_effect = changed_activity
        await self.request('second')
        await self.finish()
        self.assertEqual(self.state.control_operation['reasonCode'], 'active_call')
        self.assertEqual(self.state.control_mode, 'loop')

    async def test_control_get_with_manual_messages_uses_real_queue(self) -> None:
        await self.request()
        await self.finish()
        self.session.messages = [ChatMessage(id='u', role='user', content='manual work')]
        cases = [
            ([], 'ready'),
            (['done', 'error', 'interrupted', 'sent'], 'ready'),
            (['pending'], 'sequence_pending'),
            (['done', 'pending'], 'sequence_pending'),
        ]
        for statuses, reason in cases:
            with self.subTest(statuses=statuses):
                self.extras.seq_tasks = [SeqTask(id=str(i), status=status)
                                         for i, status in enumerate(statuses)]
                state_before = self.state.to_dict()
                extras_before = self.extras.to_dict()
                result = json.loads(await self.bridge._rpc_loopControlGet('s', 'one'))
                self.assertEqual(result['status'], 'ok')
                self.assertEqual(result['controlMode'], 'manual')
                self.assertTrue(result['operation']['committed'])
                self.assertEqual(result['eligibility']['release']['reasonCode'], reason)
                self.assertEqual(result['eligibility']['release']['allowed'], reason == 'ready')
                self.assertEqual(self.state.to_dict(), state_before)
                self.assertEqual(self.extras.to_dict(), extras_before)
        self.git.assert_called_once()
        self.bridge._loop_run_agent.assert_not_called()

    async def test_pending_queue_blocks_release_until_task_is_done(self) -> None:
        await self.request()
        await self.finish()
        self.session.messages = [ChatMessage(id='u', role='user', content='manual work')]
        queued = SeqTask(id='queued', text='next task')
        self.extras.seq_tasks.append(queued)
        state_before = self.state.to_dict()
        extras_before = self.extras.to_dict()
        result = await self.request('release', 'release')
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['reasonCode'], 'sequence_pending')
        self.assertEqual(self.state.to_dict(), state_before)
        self.assertEqual(self.extras.to_dict(), extras_before)
        self.assertFalse(self.bridge._loop_control_reserved('s'))
        self.git.assert_called_once()

        queued.status = 'done'
        result = await self.request('release-after-queue', 'release')
        self.assertEqual(result['status'], 'accepted')
        await self.finish()
        self.assertEqual(self.state.control_operation['status'], 'succeeded')
        self.assertEqual(self.state.control_mode, 'loop')
        self.assertFalse(self.state.auto)
        self.assertEqual(self.extras.seq_tasks, [queued])
        self.assertEqual(queued.status, 'done')
        self.bridge._loop_run_agent.assert_not_called()

    async def test_takeover_receipt_after_manual_message_uses_real_queue(self) -> None:
        await self.request()
        await self.finish()
        self.session.messages = [ChatMessage(id='u', role='user', content='manual work')]
        state_before = self.state.to_dict()
        result = await self.request(expected=0)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['controlMode'], 'manual')
        self.assertTrue(result['operation']['committed'])
        self.assertEqual(result['operation']['status'], 'succeeded')
        self.assertEqual(self.state.to_dict(), state_before)
        self.assertEqual(len(self.state.loops), 1)
        self.git.assert_called_once()

    async def test_release_commits_replayable_manual_steps_only_after_disk_success(self):
        await self.request()
        await self.finish()
        self.session.messages = [ChatMessage(id='u', role='user', content='implement fixture'),
                                 ChatMessage(id='a', role='assistant', content='verified fixture', streaming=True)]
        await self.request('release', 'release')
        await self.finish()
        record = self.bridge._loop_store.load('s').loops[-1]
        self.assertTrue(record.completed)
        self.assertEqual(record.orchestration[0].status, 'done')
        self.assertEqual(record.orchestration[0].output, 'verified fixture')
        self.assertEqual(record.manual_messages[0]['content'], 'implement fixture')
        self.assertEqual(record.artifact_checkpoint, 'checkpoint')
        self.assertEqual(self.state.control_mode, 'loop')
        self.bridge._loop_run_agent.assert_not_called()

    async def test_late_owned_exit_can_resolve_without_replaying_snapshot(self):
        owner = SimpleNamespace(exit_confirmed=Mock(return_value=False), release=Mock())
        self.git.return_value = SnapshotResult(exit_confirmed=False, owner=owner)
        await self.request()
        await self.finish()
        self.assertTrue(self.bridge._loop_control_reserved('s'))
        owner.exit_confirmed.return_value = True
        result = json.loads(await self.bridge._rpc_loopControlGet('s'))
        self.assertEqual(result['operation']['status'], 'interrupted')
        self.assertFalse(self.bridge._loop_control_reserved('s'))
        self.assertEqual(self.state.control_mode, 'loop')
        owner.release.assert_called_once()
        self.git.assert_called_once()

    async def test_missing_owner_reference_is_not_proof_of_worker_exit(self):
        self.git.return_value = SnapshotResult(exit_confirmed=False, owner=None)
        await self.request()
        await self.finish()
        for _ in range(2):
            result = json.loads(await self.bridge._rpc_loopControlGet('s'))
            self.assertEqual(result['operation']['status'], 'unresolved')
            self.assertTrue(self.bridge._loop_control_reserved('s'))
        self.assertEqual(self.state.control_mode, 'loop')


class OwnedSnapshotTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(shutil.which('git'), 'isolated Git fixture requires git')
    async def test_real_owned_helper_uses_temporary_index_and_exits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.assertFalse(root.is_symlink())
            repo = root / 'repo'
            repo.mkdir()
            env = {**os.environ, 'HOME': str(root), 'USERPROFILE': str(root),
                   'APPDATA': str(root / 'appdata'), 'LOCALAPPDATA': str(root / 'local'),
                   'AGENT_WITH_U_DATA_ROOT': str(root / 'data'), 'GIT_CONFIG_NOSYSTEM': '1'}
            for args in [('init',), ('config', 'user.email', 'fixture@example.invalid'),
                         ('config', 'user.name', 'Handoff Fixture')]:
                subprocess.run(['git', *args], cwd=repo, env=env, check=True, capture_output=True)
            (repo / 'proof.txt').write_text('fixture only', encoding='utf-8')
            # 临时仓库没有 HEAD/真实 index；快照不应创建它们。
            with patch.dict(os.environ, env):
                result = await snapshot_handoff(str(repo), 'takeover', 15)
            self.assertTrue(result.exit_confirmed)
            self.assertTrue(result.git)
            self.assertIsNone(result.directory)
            self.assertFalse((repo / '.git' / 'index').exists())
            self.assertEqual(list((repo / '.git').glob('awu_loop_idx_*')), [])


if __name__ == '__main__':
    unittest.main()
