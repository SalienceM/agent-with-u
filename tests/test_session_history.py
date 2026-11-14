import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from src.backend.session_history import renewal_id
from src.backend.session_store import SessionStore
from src.types import BackendType
from tests.test_session_appearance import _fixture, _stop_store


class SessionHistoryTests(unittest.IsolatedAsyncioTestCase):
    def prepare(self, bridge, source):
        bridge._require_agent_execution_enabled = Mock()
        bridge._window_guard = Mock()
        bridge._session_destroy_busy_reason = Mock(return_value='')
        bridge._has_native_session_activity = Mock(return_value=False)
        bridge._backend_configs = [SimpleNamespace(id=source.backend_id, type=BackendType.DEEPSEEK_HARNESS)]

    async def test_renew_retains_original_bytes_and_native_binding_inherits_only_settings(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            source.agent_session_id = 'awu-' + 'a' * 32
            source.model_override = 'model-choice'
            source.reasoning_effort = 'high'
            source.abilities = {'skills': ['keep'], 'prompts': ['constraint']}
            source.constraints = 'session rules'
            source.codex_thread_attached = True
            source.token_usage = {'tokens': 789}
            store.save(source, async_=False)
            store.commit_appearance(source.id, {'isPrivate': True}, expected_revision=0, request_id='private')
            before = store._session_path(source.id).read_bytes()
            result = json.loads(await bridge._rpc_sessionRenew(source.id, 'one'))
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(before, store._session_path(source.id).read_bytes())
            new = store.load(result['session']['id'])
            self.assertEqual(new.title, source.title)
            self.assertEqual(new.working_dir, source.working_dir)
            self.assertEqual(new.model_override, 'model-choice')
            self.assertEqual(new.abilities, source.abilities)
            self.assertIsNot(new.abilities, source.abilities)
            self.assertTrue(new.is_private)
            self.assertEqual(new.messages, [])
            self.assertIsNone(new.agent_session_id)
            self.assertFalse(new.codex_thread_attached)
            self.assertFalse(new.token_usage)
            self.assertEqual(new.history_root_id, source.id)
            self.assertEqual(new.history_source_id, source.id)
            self.assertEqual([event['type'] for event in events], ['session_archived', 'session_created'])
            self.assertTrue(store.load(source.id).is_archived)
            self.assertFalse(new.is_archived)
            self.assertTrue(new.history_archive_completed)
            reopened = SessionStore()
            try:
                self.assertEqual(reopened.load(new.id).history_source_id, source.id)
                self.assertEqual(len(reopened.load(source.id).messages), 1)
                self.assertTrue(reopened.load(source.id).is_archived)
                self.assertEqual(len(reopened.list()), 2)
            finally:
                _stop_store(reopened)

    async def test_duplicate_and_lost_reply_create_once_status_does_not_write(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            replies = await asyncio.gather(*(bridge._rpc_sessionRenew(source.id, 'same') for _ in range(3)))
            self.assertEqual(len({json.loads(r)['session']['id'] for r in replies}), 1)
            self.assertEqual(len(store.list()), 2)
            self.assertEqual(len(events), 2)
            with patch.object(store, 'save_confirmed', side_effect=AssertionError('status wrote')):
                status = json.loads(bridge._rpc_sessionRenewStatus(source.id, 'same'))
                self.assertEqual(status['status'], 'succeeded')
                self.assertEqual(json.loads(bridge._rpc_sessionRenewStatus(source.id, 'other'))['status'], 'not_found')

    async def test_busy_foreign_special_and_disk_failure_leave_old_history_intact(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            before = store._session_path(source.id).read_bytes()
            bridge._has_native_session_activity.return_value = True
            self.assertEqual(json.loads(await bridge._rpc_sessionRenew(source.id, 'busy'))['status'], 'error')
            bridge._has_native_session_activity.return_value = False
            source.relation_kind = 'task'
            self.assertEqual(json.loads(await bridge._rpc_sessionRenew(source.id, 'task'))['status'], 'error')
            source.relation_kind = None
            with patch.object(store, '_atomic_write_text', side_effect=OSError('disk full')):
                with self.assertRaises(OSError): await bridge._rpc_sessionRenew(source.id, 'fail')
            self.assertEqual(before, store._session_path(source.id).read_bytes())
            self.assertEqual(events, [])
            self.assertEqual(len(store.list()), 1)
            bridge._current_owner_id = lambda: 'foreign'
            for read in [lambda: bridge._rpc_sessionHistory(source.id), lambda: bridge._rpc_sessionNativeLogLocation(source.id),
                         lambda: bridge._rpc_sessionRenewStatus(source.id, 'x')]:
                with self.assertRaises(PermissionError): read()
            with self.assertRaises(PermissionError): await bridge._rpc_sessionRenew(source.id, 'foreign')

    async def test_history_uses_renewal_time_retains_offline_and_filters_owner(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            one = json.loads(await bridge._rpc_sessionRenew(source.id, 'one'))['session']['id']
            two = json.loads(await bridge._rpc_sessionRenew(one, 'two'))['session']['id']
            source.title = 'renamed old'
            store.save(source, async_=False)
            other = copy.deepcopy(source)
            other.id = 'foreign'; other.owner_id = 'another'; other.history_root_id = source.id
            store.save(other, async_=False)
            first = json.loads(bridge._rpc_sessionHistory(source.id, 0, 2))
            self.assertEqual([r['id'] for r in first['items']], [two, one])
            last = json.loads(bridge._rpc_sessionHistory(two, first['nextOffset'], 2))
            self.assertEqual([r['id'] for r in last['items']], [source.id])
            self.assertIsNone(last['nextOffset'])
            store.delete(source.id)
            self.assertEqual(len(json.loads(bridge._rpc_sessionHistory(two))['items']), 2)

    async def test_partial_index_write_is_read_only_unknown_then_same_request_repairs(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            store._save_index_sync()
            before = store._session_path(source.id).read_bytes()
            with patch.object(store, 'commit_archive', side_effect=OSError('index unavailable')):
                with self.assertRaises(OSError): await bridge._rpc_sessionRenew(source.id, 'partial')
                self.assertEqual(json.loads(bridge._rpc_sessionRenewStatus(source.id, 'partial'))['status'], 'incomplete')
            self.assertEqual(events, [])
            result = json.loads(await bridge._rpc_sessionRenew(source.id, 'partial'))
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(len(store.list()), 2)
            self.assertEqual(len(events), 2)
            self.assertEqual(store._session_path(source.id).read_bytes(), before)

    async def test_archive_restore_cas_stale_saves_and_old_renewal_receipt(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            stale = copy.deepcopy(source)
            result = json.loads(await bridge._rpc_sessionRenew(source.id, 'archive'))
            with self.assertRaisesRegex(ValueError, '已归档'):
                bridge._check_chat_turn_allowed(source.id)
            store.save(stale, async_=False)
            self.assertTrue(store.load(source.id).is_archived)
            with patch.object(store, 'commit_archive', side_effect=AssertionError('read wrote')):
                self.assertTrue(json.loads(bridge._rpc_sessionArchiveStatus(source.id))['session']['isArchived'])
            conflict = json.loads(await bridge._rpc_sessionArchiveRestore(source.id, 0, 'wrong-version'))
            self.assertEqual(conflict['status'], 'conflict')
            revision = store.get_meta(source.id)['archiveRevision']
            restored = json.loads(await bridge._rpc_sessionArchiveRestore(source.id, revision, 'restore'))
            self.assertFalse(restored['session']['isArchived'])
            self.assertEqual(json.loads(await bridge._rpc_sessionArchiveRestore(source.id, revision, 'restore')), restored)
            store.save(stale, async_=False)
            self.assertFalse(store.load(source.id).is_archived)
            again = json.loads(await bridge._rpc_sessionRenew(source.id, 'archive'))
            self.assertEqual(again['session']['id'], result['session']['id'])
            self.assertFalse(store.load(source.id).is_archived, 'old receipt cannot re-archive a restored session')
            bridge._current_owner_id = lambda: 'foreign'
            with self.assertRaises(PermissionError): await bridge._rpc_sessionArchiveRestore(source.id, revision, 'foreign')
            with self.assertRaises(PermissionError): bridge._rpc_sessionArchiveStatus(source.id)

    async def test_pending_renewal_blocks_new_turns_and_failed_archive_does_not_claim_success(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            entered, release = asyncio.Event(), asyncio.Event()
            save = store.save_confirmed
            async def slow_save(candidate):
                entered.set()
                await release.wait()
                await save(candidate)
            with patch.object(store, 'save_confirmed', side_effect=slow_save):
                task = asyncio.create_task(bridge._rpc_sessionRenew(source.id, 'pending'))
                await entered.wait()
                with self.assertRaisesRegex(ValueError, '正在核对'):
                    bridge._check_chat_turn_allowed(source.id)
                release.set()
                await task
            self.assertTrue(store.get_meta(source.id)['isArchived'])

    async def test_archived_queue_is_not_claimed_or_discarded(self):
        from src.backend.sequence_scheduler import SequenceScheduler
        from src.backend.chat_extras_store import ChatExtras, SeqTask
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            await bridge._rpc_sessionRenew(source.id, 'queued')
            extras = ChatExtras(session_id=source.id, seq_auto=True, seq_tasks=[SeqTask(id='queued', text='keep')])
            bridge._chat_extras_get = lambda _sid: extras
            bridge._start_chat_turn = Mock(side_effect=AssertionError('archived session started'))
            await SequenceScheduler(bridge)._drain(source.id)
            self.assertEqual(extras.seq_tasks[0].status, 'pending')
            bridge._start_chat_turn.assert_not_called()

    async def test_cancelling_during_archive_write_keeps_turn_guard_until_disk_settles(self):
        import threading
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            entered, release = asyncio.Event(), threading.Event()
            loop = asyncio.get_running_loop()
            commit = store.commit_archive
            def slow_commit(*args, **kwargs):
                loop.call_soon_threadsafe(entered.set)
                if not release.wait(5):
                    raise RuntimeError('fixture timeout')
                return commit(*args, **kwargs)
            with patch.object(store, 'commit_archive', side_effect=slow_commit):
                task = asyncio.create_task(bridge._rpc_sessionRenew(source.id, 'cancel'))
                await entered.wait()
                task.cancel()
                await asyncio.sleep(0)
                try:
                    with self.assertRaisesRegex(ValueError, '正在核对'):
                        bridge._require_session_conversation(source.id)
                finally:
                    release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertTrue(store.get_meta(source.id)['isArchived'])
            self.assertEqual(json.loads(bridge._rpc_sessionRenewStatus(source.id, 'cancel'))['status'], 'succeeded')

    async def test_dsh_location_is_read_only_and_does_not_load_transcript(self):
        with _fixture() as (store, source, bridge, events):
            self.prepare(bridge, source)
            with patch.object(store, 'load', side_effect=AssertionError('read body')):
                response = json.loads(bridge._rpc_sessionNativeLogLocation(source.id))
            self.assertEqual(response['status'], 'ok')
            self.assertFalse(response['exists'])
            self.assertFalse(Path(response['bindingPath']).exists())
            self.assertTrue(response['sessionsPath'].endswith(str(Path('home') / 'sessions')))
            self.assertEqual(events, [])
            bridge._backend_configs[0].type = BackendType.CODEX_OFFICIAL
            self.assertEqual(json.loads(bridge._rpc_sessionNativeLogLocation(source.id))['status'], 'unsupported')

    def test_request_ids_are_scoped_and_validated(self):
        self.assertNotEqual(renewal_id('a', 's', 'r'), renewal_id('b', 's', 'r'))
        with self.assertRaises(ValueError): renewal_id('a', 's', '../bad')
