import asyncio
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.chat_extras_store import ChatExtras, ChatExtrasStore, SeqTask
from src.backend.sequence_scheduler import SequenceScheduler
from src.types import Session


class SequenceSchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = patch.dict('os.environ', {'AGENT_WITH_U_DATA_ROOT': self.temp.name})
        self.root.start()
        self.bridge = b = BridgeWS.__new__(BridgeWS)
        b._chat_extras = {}
        b._chat_extras_store = ChatExtrasStore()
        b._chat_turn_tasks = {}
        b._seq_dispatch_reservations = {}
        self.session = Session(id='s', title='test', created_at=1, updated_at=1,
                               messages=[], working_dir='.', backend_id='test',
                               owner_id='owner-a', skip_permissions=False)
        b._active_sessions = {'s': self.session}
        b._session_store = SimpleNamespace(load=lambda sid: b._active_sessions.get(sid),
                                          save=lambda *a, **kw: None, get_meta=lambda sid: None)
        self.events = []
        b._emit_seqtask_updated = lambda ex: self.events.append(ex.to_dict())
        b._emit_session_updated = lambda data: None
        b._sequence_scheduler = SequenceScheduler(b)
        await b._sequence_scheduler.start()
        self.calls = []
        self.releases = []
        self.outcomes = []

        async def send(raw):
            payload = json.loads(raw)
            payload['ownerObserved'] = _REQUEST_OWNER_ID.get()
            self.calls.append(payload)
            event = asyncio.Event()
            self.releases.append(event)
            await event.wait()
            return self.outcomes.pop(0) if self.outcomes else True
        b._handle_send_message = send

    async def asyncTearDown(self):
        await self.bridge._sequence_scheduler.stop()
        for tasks in list(self.bridge._chat_turn_tasks.values()):
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        self.root.stop()
        self.temp.cleanup()

    async def until(self, condition):
        for _ in range(100):
            if condition():
                return
            await asyncio.sleep(0)
        self.fail('condition not reached')

    def add(self, text='first'):
        return json.loads(self.bridge._rpc_seqtaskAdd('s', text))

    def extras(self):
        return self.bridge._chat_extras_get('s')

    async def test_drains_without_any_client_one_at_a_time(self):
        self.add('one')
        self.add('two')
        await self.until(lambda: len(self.calls) == 1)
        self.assertEqual([t.status for t in self.extras().seq_tasks], ['running', 'pending'])
        self.assertEqual(self.bridge._chat_extras_store.load('s').seq_tasks[0].status, 'running')
        for _ in range(10):
            self.bridge._sequence_scheduler.kick('s')
            self.bridge._rpc_seqtaskTakeNext('s')
        self.assertEqual(len(self.calls), 1)
        self.releases[0].set()
        await self.until(lambda: len(self.calls) == 2)
        self.releases[1].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual([t.status for t in self.extras().seq_tasks], ['done', 'done'])

    async def test_pausing_does_not_cancel_current_and_survives_new_input(self):
        self.add('one')
        await self.until(lambda: len(self.calls) == 1)
        self.bridge._rpc_seqtaskSetAuto('s', False)
        self.add('two')
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.bridge._chat_extras_store.load('s').seq_auto)
        self.bridge._rpc_seqtaskSetAuto('s', True)
        await self.until(lambda: len(self.calls) == 2)

    async def test_waits_for_real_manual_turn_exit_not_done_event(self):
        self.bridge._rpc_sendMessage(json.dumps({'sessionId': 's', 'content': 'manual'}))
        await self.until(lambda: len(self.calls) == 1)
        self.add('queued')
        await asyncio.sleep(0)
        self.assertEqual(len(self.calls), 1)
        self.releases[0].set()
        await self.until(lambda: len(self.calls) == 2)
        self.assertEqual(self.calls[1]['content'], 'queued')

    async def test_failed_task_pauses_and_explicit_retry_uses_edited_content(self):
        self.outcomes = [False]
        self.add('one')
        self.add('two')
        await self.until(lambda: len(self.calls) == 1)
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual([t.status for t in self.extras().seq_tasks], ['error', 'pending'])
        self.assertFalse(self.extras().seq_auto)
        self.bridge._rpc_seqtaskEdit('s', self.extras().seq_tasks[0].id, 'fixed')
        self.bridge._rpc_seqtaskSetAuto('s', True)
        await self.until(lambda: len(self.calls) == 2)
        self.assertEqual(self.calls[1]['content'], 'fixed')

    async def test_failure_of_manual_turn_pauses_queued_work(self):
        self.outcomes = [False]
        self.bridge._rpc_sendMessage(json.dumps({'sessionId': 's', 'content': 'manual'}))
        await self.until(lambda: len(self.calls) == 1)
        self.add()
        self.releases[0].set()
        await self.until(lambda: not self.bridge._active_chat_turn_tasks('s'))
        await asyncio.sleep(0)
        self.assertFalse(self.extras().seq_auto)
        self.assertEqual(len(self.calls), 1)

    async def test_double_resume_and_old_take_next_never_double_dispatch(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        self.add()
        for _ in range(5):
            self.bridge._rpc_seqtaskSetAuto('s', True)
            self.assertIsNone(json.loads(self.bridge._rpc_seqtaskTakeNext('s'))['task'])
        await self.until(lambda: len(self.calls) == 1)
        with self.assertRaises(ValueError):
            self.bridge._start_chat_turn(json.dumps({'sessionId': 's', 'content': 'racing'}))

    async def test_stale_client_send_is_visibly_rejected_without_interrupting(self):
        events = []
        self.bridge._emit_session_updated = events.append
        self.add()
        await self.until(lambda: len(self.calls) == 1)
        self.bridge._rpc_sendMessage(json.dumps({'sessionId': 's', 'messageId': 'stale', 'content': 'racing'}))
        self.assertEqual(events[-1]['type'], 'chat_send_rejected')
        self.assertEqual(events[-1]['messageId'], 'stale')
        self.assertEqual(len(self.calls), 1)

    async def test_manual_abort_pauses_even_if_backend_returns_success(self):
        self.bridge._backends = {}
        self.bridge._abort_loop_backend_calls = lambda sid: None
        self.add('one')
        self.add('two')
        await self.until(lambda: len(self.calls) == 1)
        self.bridge._rpc_abortMessage('s')
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertFalse(self.extras().seq_auto)
        self.assertEqual(self.extras().seq_tasks[0].status, 'error')
        self.assertEqual(len(self.calls), 1)

    async def test_redirect_continues_after_interrupting_queued_turn(self):
        backend = SimpleNamespace(follow_up_capabilities=lambda: {'interruptResume': True},
                                  abort=lambda sid: self.releases[0].set())
        self.bridge._get_backend = lambda backend_id: backend
        self.add('one')
        self.add('two')
        await self.until(lambda: len(self.calls) == 1)
        self.bridge._rpc_redirectMessage('s', 'new direction')
        await self.until(lambda: len(self.calls) == 2)
        self.assertEqual(self.calls[1]['content'], 'new direction')
        self.assertEqual(self.extras().seq_tasks[1].status, 'interrupted')

    async def test_restart_resumes_pending_but_never_replays_uncertain_running(self):
        ex = ChatExtras(session_id='s', seq_tasks=[SeqTask(id='one', text='pending')])
        self.bridge._chat_extras_store.save(ex)
        await self.bridge._sequence_scheduler.start()
        await self.until(lambda: len(self.calls) == 1)
        await self.bridge._sequence_scheduler.stop()
        self.bridge._chat_extras.clear()
        self.bridge._sequence_scheduler = SequenceScheduler(self.bridge)
        await self.bridge._sequence_scheduler.start()
        self.assertFalse(self.extras().seq_auto)
        self.assertEqual(self.extras().seq_tasks[0].status, 'error')
        self.assertEqual(len(self.calls), 1)

    async def test_restart_preserves_explicit_pause(self):
        self.bridge._chat_extras_store.save(ChatExtras(
            session_id='s', seq_auto=False, seq_tasks=[SeqTask(id='one', text='pending')]))
        await self.bridge._sequence_scheduler.start()
        await asyncio.sleep(0)
        self.assertEqual(self.calls, [])

    async def test_permissions_owner_attachments_and_no_kit_delegation(self):
        images = [{'id': 'im', 'base64': 'YQ==', 'mime_type': 'image/png', 'size': 1}]
        self.bridge._rpc_seqtaskAdd('s', 'hello', json.dumps(images))
        await self.until(lambda: len(self.calls) == 1)
        self.assertEqual(self.calls[0]['images'][0]['base64'], images[0]['base64'])
        self.assertEqual(self.calls[0]['images'][0]['mime_type'], images[0]['mime_type'])
        self.assertEqual(self.calls[0]['ownerObserved'], 'owner-a')
        self.assertFalse(self.calls[0]['skipPermissions'])
        self.assertNotIn('kitApprovalDelegation', self.calls[0])

    async def test_clear_during_running_retains_current_and_removes_pending(self):
        self.add('one')
        self.add('two')
        await self.until(lambda: len(self.calls) == 1)
        self.bridge._rpc_seqtaskClear('s')
        self.assertEqual(len(self.extras().seq_tasks), 1)
        result = json.loads(self.bridge._rpc_seqtaskRemove('s', self.extras().seq_tasks[0].id))
        self.assertEqual(result['status'], 'busy')
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual(len(self.calls), 1)

    async def test_reorder_changes_only_unsent_tasks(self):
        self.add('one')
        self.add('two')
        self.add('three')
        await self.until(lambda: len(self.calls) == 1)
        tasks = self.extras().seq_tasks
        self.bridge._rpc_seqtaskReorder('s', json.dumps([tasks[2].id, tasks[1].id]))
        self.releases[0].set()
        await self.until(lambda: len(self.calls) == 2)
        self.assertEqual(self.calls[1]['content'], 'three')

    async def test_commands_do_not_leak_to_model_and_error_is_visible(self):
        self.add('/compact')
        self.add('after compact')
        await self.until(lambda: len(self.calls) == 1)
        self.assertEqual(self.calls[0]['content'], 'after compact')
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.add('/not-a-command')
        await self.until(lambda: not self.extras().seq_auto)
        self.assertIn('未调用模型', self.extras().seq_error)
        self.assertEqual(len(self.calls), 1)

    async def test_removal_stops_future_dispatch(self):
        self.add('one')
        self.add('two')
        await self.until(lambda: len(self.calls) == 1)
        self.bridge._sequence_scheduler.remove('s')
        await asyncio.sleep(0)
        self.bridge._sequence_scheduler.kick('s')
        await asyncio.sleep(0)
        self.assertEqual(len(self.calls), 1)

    def test_legacy_unused_toggle_migrates_to_auto_new_pause_survives(self):
        self.assertTrue(ChatExtras.from_dict({'sessionId': 's', 'seqAuto': False}).seq_auto)
        self.assertFalse(ChatExtras.from_dict(ChatExtras(session_id='s', seq_auto=False).to_dict()).seq_auto)


if __name__ == '__main__':
    unittest.main()
