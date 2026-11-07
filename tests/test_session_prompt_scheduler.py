import asyncio
import json
from pathlib import Path
import sqlite3
import threading
import unittest
from types import SimpleNamespace

from src.backend.session_prompt_scheduler import ScheduleIO, ScheduleLease, SessionPromptScheduler
from src.backend.session_schedule_rules import ScheduleError
from src.backend.sequence_scheduler import SequenceScheduler
import tests.test_sequence_scheduler as sequence_fixture
from tests.test_session_schedule_rules import config, instant


class PromptSchedulerTests(sequence_fixture.SequenceSchedulerTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.now = instant('2026-01-01')
        b = self.bridge
        b._loop_environment_executor = lambda: 'executor'
        from src.types import BackendType
        b._backend_configs = [SimpleNamespace(id='test', enabled=True, type=BackendType.OPENAI_COMPATIBLE)]
        b._emit_event = lambda *args: self.events.append(args)
        self.service = b._session_prompt_scheduler = SessionPromptScheduler(b, Path(self.temp.name) / 'schedule.sqlite', clock=lambda: self.now)
        await self.service.start(background=False)
        self.assertTrue(self.service.ready, self.service.error)

    async def asyncTearDown(self):
        await self.bridge._sequence_scheduler.stop()
        await self.service.stop()
        await super().asyncTearDown()

    async def until(self, condition):
        for _ in range(1000):
            if condition():
                return
            await asyncio.sleep(.001)
        self.fail('condition not reached')

    async def schedule(self, **kwargs):
        return await self.service.mutate(('owner-a', 'executor'), 's', {
            'action': 'save', 'id': 'plan', 'requestId': 'create', 'expectedRevision': 0,
            'config': config({'kind': 'interval', 'anchor': self.now + 60, 'seconds': 60}), **kwargs})

    async def test_scheduled_turn_current_runtime_and_stable_ids(self):
        await self.schedule()
        self.assertEqual(self.calls, [])
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)
        payload = self.calls[0]
        self.assertTrue(payload['messageId'].startswith('schedule-assistant-'))
        self.assertEqual(payload['ownerObserved'], 'owner-a')
        self.assertNotIn('kitApprovalDelegation', payload)
        self.assertNotIn('workspaceToolsVersion', payload)
        await self.service.tick()
        self.assertEqual(len(self.calls), 1)
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        history = await self.service.io.run(self.service.store.listing, ('owner-a', 'executor'), 's', history=True)
        self.assertEqual(history['items'][0]['state'], 'completed')

    async def test_pause_coalesce_and_explicit_stop(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        await self.schedule()
        self.now += 3600
        await self.service.tick()
        self.assertEqual(len(self.extras().pending_tasks()), 1)
        self.assertEqual(self.calls, [])
        self.bridge._rpc_seqtaskSetAuto('s', True)
        await self.until(lambda: len(self.calls) == 1)
        self.bridge._backends = {}
        self.bridge._abort_loop_backend_calls = lambda _: None
        self.bridge._rpc_abortMessage('s')
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.now += 600
        await self.service.tick()
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.extras().seq_auto)

    async def test_restart_unknown_without_queue_never_replays(self):
        await self.schedule()
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)
        await self.bridge._sequence_scheduler.stop()
        await self.service.stop()
        self.extras().seq_tasks.clear()
        self.bridge._chat_extras_save(self.extras())
        self.service = self.bridge._session_prompt_scheduler = SessionPromptScheduler(self.bridge, Path(self.temp.name) / 'schedule.sqlite', clock=lambda: self.now)
        self.bridge._sequence_scheduler = SequenceScheduler(self.bridge)
        await self.service.start(background=False)
        await self.bridge._sequence_scheduler.start()
        self.assertIn('s', self.service.unknown)
        self.assertFalse(self.extras().seq_auto)
        self.now += 120
        await self.service.tick()
        self.assertEqual(len(self.calls), 1)

    async def test_mutation_receipt_lost_owned_write_finishes(self):
        started, release = threading.Event(), threading.Event()
        original = self.service.store.mutate
        def delayed(*args):
            started.set()
            release.wait(2)
            return original(*args)
        self.service.store.mutate = delayed
        task = asyncio.create_task(self.schedule())
        await self.until(started.is_set)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        release.set()
        receipt = await self.service.io.run(self.service.store.request, ('owner-a', 'executor'), 's', 'create')
        self.assertEqual(receipt['status'], 'succeeded')
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)

    async def test_legacy_queue_edit_and_retry_cannot_replay_scheduled(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        await self.schedule()
        self.now += 60
        await self.service.tick()
        task = self.extras().seq_tasks[0]
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskEdit('s', task.id, 'changed'))['status'], 'error')
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskRemove('s', task.id))['status'], 'error')
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskClear('s'))['status'], 'error')
        task.status = 'error'
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskSetAuto('s', True))['status'], 'error')
        self.assertEqual(self.calls, [])

    async def test_background_database_lock_does_not_block_event_loop(self):
        with sqlite3.connect(self.service.store.path, isolation_level=None) as db:
            db.execute('BEGIN IMMEDIATE')
            task = asyncio.create_task(self.schedule())
            await asyncio.sleep(.03)
            self.assertFalse(task.done())
            # 主事件循环仍能执行读取/暂停等轻量动作。
            self.bridge._rpc_seqtaskSetAuto('s', False)
            self.assertFalse(self.extras().seq_auto)
            db.execute('ROLLBACK')
            await task

    async def test_non_normal_session_rejected(self):
        self.bridge._require_session_access = lambda _: 's'
        self.bridge._current_owner_id = lambda: 'owner-a'
        self.session.session_type = 'loop'
        with self.assertRaises(ScheduleError):
            await self.bridge._rpc_sessionScheduleList('s')

    async def test_prepared_queue_and_receipt_crash_windows(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        await self.schedule()
        self.now += 60
        await self.service.io.run(self.service.store.consume, self.now)
        original = (await self.service.io.run(self.service.store.work))[0]
        self.assertEqual(original['state'], 'prepared')
        save = self.bridge._chat_extras_save
        def fail_after_save(ex):
            save(ex)
            raise OSError('fixture crash after queue publication')
        self.bridge._chat_extras_save = fail_after_save
        with self.assertRaises(OSError):
            await self.service.reconcile()
        self.bridge._chat_extras_save = save
        await self.service.io.run(self.service.store.recover)
        await self.service.reconcile()
        self.assertEqual(len(self.extras().seq_tasks), 1)
        self.assertEqual(self.extras().seq_tasks[0].id, original['taskId'])
        self.bridge._rpc_seqtaskSetAuto('s', True)
        await self.until(lambda: len(self.calls) == 1)
        self.assertEqual(self.calls[0]['messageId'], original['assistantMessageId'])
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        await self.service.io.run(self.service.store.recover)
        await self.service.reconcile()
        self.assertEqual(len(self.calls), 1)

    async def test_disable_before_claim_and_type_change(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        await self.schedule()
        self.now += 60
        await self.service.tick()
        await self.service.mutate(('owner-a', 'executor'), 's', {'action': 'enable', 'id': 'plan',
            'requestId': 'disable', 'expectedRevision': 1, 'enabled': False})
        self.assertEqual(self.extras().seq_tasks, [])
        self.assertEqual(self.calls, [])
        await self.service.mutate(('owner-a', 'executor'), 's', {'action': 'enable', 'id': 'plan',
            'requestId': 'enable', 'expectedRevision': 2, 'enabled': True})
        self.session.session_type = 'loop'
        self.now += 60
        await self.service.tick()
        self.assertEqual(self.calls, [])

    async def test_actual_runtime_failure_and_explicit_retry(self):
        await self.schedule()
        self.session.model_override = 'small-model'
        self.session.reasoning_effort = 'low'
        self.outcomes = [False]
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        await self.service.reconcile()
        original = (await self.service.io.run(self.service.store.listing, ('owner-a', 'executor'), 's', history=True))['items'][0]
        self.assertEqual(original['runtime']['model'], 'small-model')
        self.assertEqual(original['state'], 'failed')
        await self.service.mutate(('owner-a', 'executor'), 's', {'action': 'retry', 'id': original['id'], 'requestId': 'retry-one'})
        await self.until(lambda: len(self.calls) == 2)
        self.assertNotEqual(self.calls[0]['messageId'], self.calls[1]['messageId'])

    async def test_update_block_and_busy_manual_turn_keep_pending(self):
        self.add('manual')
        await self.until(lambda: len(self.calls) == 1)
        await self.schedule()
        self.now += 3600
        await self.service.tick()
        self.assertEqual(len(self.extras().pending_tasks()), 1)
        self.bridge._update_work_blocked = lambda: True
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        await self.service.tick()
        self.assertEqual(len(self.calls), 1)
        self.bridge._update_work_blocked = lambda: False
        self.bridge._sequence_scheduler.kick('s')
        await self.until(lambda: len(self.calls) == 2)

    async def test_definite_commit_returns_receipt_when_queue_reconcile_fails(self):
        reconcile = self.service.reconcile
        async def fail():
            raise OSError('fixture failed presentation')
        self.service.reconcile = fail
        receipt = await self.schedule()
        self.assertEqual(receipt['status'], 'succeeded')
        self.assertEqual((await self.service.io.run(self.service.store.request, ('owner-a', 'executor'), 's', 'create'))['status'], 'succeeded')
        self.service.reconcile = reconcile

    async def test_final_chat_save_failure_remains_unknown(self):
        async def failed_save(_session):
            raise OSError('fixture failed disk')
        self.bridge._session_store.save_confirmed = failed_save
        await self.schedule()
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertIn('s', self.service.unknown)
        self.now += 600
        await self.service.tick()
        self.assertEqual(len(self.calls), 1)

    async def test_output_is_bounded_visible_text_only(self):
        from src.types import ChatMessage, ThinkingBlock
        await self.schedule()
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)
        row = self.service.running['s']
        self.session.messages.append(ChatMessage(id=row['assistantMessageId'], role='assistant', content='x' * 16001,
                                                 thinking_blocks=[ThinkingBlock(content='private')]))
        self.bridge._require_session_access = lambda _: 's'
        self.bridge._current_owner_id = lambda: 'owner-a'
        result = json.loads(await self.bridge._rpc_sessionScheduleOutput('s', row['id']))
        self.assertEqual(len(result['text']), 8000)
        self.assertEqual(result['nextOffset'], 8000)
        self.assertNotIn('private', json.dumps(result))

    async def test_stop_during_claim_does_not_call_model(self):
        await self.schedule()
        entered, release = threading.Event(), threading.Event()
        transition = self.service.store.transition
        def delayed(scope, key, state, **kwargs):
            if state == 'claimed':
                entered.set()
                release.wait(3)
            return transition(scope, key, state, **kwargs)
        self.service.store.transition = delayed
        self.now += 60
        await self.service.tick()
        await self.until(entered.is_set)
        self.bridge._rpc_seqtaskSetAuto('s', False)
        release.set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual(self.calls, [])
        rows = await self.service.io.run(self.service.store.listing, ('owner-a', 'executor'), 's', history=True)
        self.assertEqual(rows['items'][0]['state'], 'interrupted')

    async def test_queue_mismatch_is_unknown_not_retryable(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        await self.schedule()
        self.now += 60
        await self.service.tick()
        task = self.extras().seq_tasks[0]
        task.status = 'done'
        await self.service.io.run(self.service.store.recover)
        await self.service.reconcile()
        self.assertIn('s', self.service.unknown)
        with self.assertRaises(ScheduleError):
            await self.service.mutate(('owner-a', 'executor'), 's', {'action': 'retry', 'id': task.schedule_ref['occurrenceId'], 'requestId': 'no-retry'})
        self.assertEqual(self.calls, [])

    async def test_missing_ledger_and_corrupt_source_fail_closed(self):
        from src.backend.chat_extras_store import SeqTask
        corrupt = SeqTask.from_dict({'id': 'schedule-broken', 'scheduleRef': {'invalid': True}, 'text': 'never replay'})
        self.assertEqual(corrupt.status, 'error')
        self.extras().seq_tasks.append(corrupt)
        self.bridge._chat_extras_save(self.extras())
        await self.service.audit_queue()
        self.assertIn('s', self.service.unknown)
        self.assertFalse(self.extras().seq_auto)
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskClear('s'))['status'], 'error')
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskRemove('s', corrupt.id))['status'], 'error')
        self.assertEqual(json.loads(self.bridge._rpc_seqtaskSetAuto('s', True))['status'], 'error')
        with self.assertRaises(ValueError):
            self.bridge._check_chat_turn_allowed('s')
        self.assertEqual(self.calls, [])

    async def test_waiting_projection_uses_exact_scheduled_message(self):
        await self.schedule()
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)
        row = self.service.running['s']
        self.bridge._require_session_access = lambda _: 's'
        self.bridge._current_owner_id = lambda: 'owner-a'
        gate = asyncio.get_running_loop().create_future()
        self.bridge._permission_gates = {'s': gate}
        self.bridge._permission_payloads = {'s': {'messageId': 'different-manual-message'}}
        history = json.loads(await self.bridge._rpc_sessionScheduleOccurrences('s'))
        self.assertFalse(history['items'][0]['waitingForInput'])
        self.bridge._permission_payloads['s']['messageId'] = row['assistantMessageId']
        listing = json.loads(await self.bridge._rpc_sessionScheduleList('s'))
        self.assertTrue(listing['activity']['waitingForInput'])
        gate.set_result(False)
        history = json.loads(await self.bridge._rpc_sessionScheduleOccurrences('s'))
        self.assertFalse(history['items'][0]['waitingForInput'])

    async def test_retry_receipt_survives_queue_resume_save_failure(self):
        await self.schedule()
        self.outcomes = [False]
        self.now += 60
        await self.service.tick()
        await self.until(lambda: len(self.calls) == 1)
        self.releases[0].set()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        await self.service.reconcile()
        row = (await self.service.io.run(self.service.store.listing, ('owner-a', 'executor'), 's', history=True))['items'][0]
        save = self.bridge._chat_extras_save
        def fail_resume(ex):
            if ex.seq_auto:
                raise OSError('fixture resume save failed')
            save(ex)
        self.bridge._chat_extras_save = fail_resume
        result = await self.service.mutate(('owner-a', 'executor'), 's', {'action': 'retry', 'id': row['id'], 'requestId': 'retry-failed-save'})
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(len(self.calls), 1)
        self.bridge._chat_extras_save = save

    async def test_once_waits_for_guard_then_starts_without_new_due_time(self):
        await self.schedule(config=config({'kind': 'once', 'at': self.now + 60}))
        self.bridge._loop_control_reserved = lambda _: True
        self.now += 60
        await self.service.tick()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual(self.calls, [])
        self.bridge._loop_control_reserved = lambda _: False
        await self.service.tick()
        await self.service.tick()  # bounded target cursor wraps independently of due consumption
        await self.until(lambda: len(self.calls) == 1)
        self.assertEqual(len(self.extras().seq_tasks), 1)

    async def test_multiple_plans_follow_manual_queue_and_coalesce(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        self.add('manual-first')
        for key in ['b', 'a']:
            await self.schedule(id=key, requestId=key)
        self.now += 60 * 10000
        await self.service.tick()
        tasks = self.extras().seq_tasks
        self.assertEqual(len(tasks), 3)
        self.assertEqual(tasks[0].text, 'manual-first')
        self.assertEqual([task.schedule_ref['scheduleId'] for task in tasks[1:]], ['a', 'b'])
        self.now += 60 * 10000
        await self.service.tick()
        self.assertEqual(len(tasks), 3)
        self.assertEqual(self.calls, [])

    async def test_disabled_backend_and_unsupported_command_do_not_fallback(self):
        self.bridge._backend_configs[0].enabled = False
        await self.schedule()
        self.now += 60
        await self.service.tick()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual(self.calls, [])
        self.assertIn('Backend', self.extras().seq_error)
        self.bridge._backend_configs[0].enabled = True
        await self.service.mutate(('owner-a', 'executor'), 's', {'action': 'save', 'id': 'plan', 'requestId': 'command', 'expectedRevision': 1,
            'config': config({'kind': 'once', 'at': self.now + 60}, prompt='/model unsupported')})
        old = self.extras().seq_tasks[0]
        await self.service.mutate(('owner-a', 'executor'), 's', {'action': 'cancel', 'id': old.schedule_ref['occurrenceId'], 'requestId': 'cancel-old'})
        self.bridge._rpc_seqtaskSetAuto('s', True)
        self.now += 60
        await self.service.tick()
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        self.assertEqual(self.calls, [])
        self.assertIn('不支持', self.extras().seq_error)

    async def test_recovery_barrier_does_not_mutate_queued_work(self):
        self.bridge._rpc_seqtaskSetAuto('s', False)
        await self.schedule()
        self.now += 60
        await self.service.tick()
        self.service.ready = False
        self.bridge._rpc_seqtaskSetAuto('s', True)
        await self.until(lambda: not self.bridge._sequence_scheduler.workers)
        row = (await self.service.io.run(self.service.store.listing, ('owner-a', 'executor'), 's', history=True))['items'][0]
        self.assertEqual(row['state'], 'queued')
        self.assertEqual(self.calls, [])
        self.service.ready = True


class ScheduleIOTests(unittest.IsolatedAsyncioTestCase):
    async def test_lease_cannot_be_owned_twice(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'lease'
            first = ScheduleLease(path)
            try:
                with self.assertRaises(ScheduleError):
                    ScheduleLease(path)
                import subprocess, sys
                script = "from pathlib import Path; from src.backend.session_prompt_scheduler import ScheduleLease; import sys; ScheduleLease(Path(sys.argv[1]))"
                result = await asyncio.to_thread(subprocess.run, [sys.executable, '-c', script, str(path)], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
            finally:
                first.close()
            second = ScheduleLease(path)
            second.close()

    async def test_bounded_queue_and_cancelled_waiter(self):
        io = ScheduleIO()
        release = threading.Event()
        tasks = [asyncio.create_task(io.run(release.wait, 2)) for _ in range(64)]
        await asyncio.sleep(.01)
        with self.assertRaises(ScheduleError):
            await io.run(lambda: None)
        tasks[0].cancel()
        self.assertEqual(len(io.pending), 64)
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await io.close()


if __name__ == '__main__':
    unittest.main()
