import asyncio
import json
import threading
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_startup_bridge import LoopStartupBridge
from src.backend.loop_control_snapshot import SnapshotResult, snapshot_handoff
from src.backend.loop_store import LoopState, LoopRecord, STAGE_EXECUTE
from tests import test_loop_lifecycle as lifecycle


class StartupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state = LoopState('s', stage=STAGE_EXECUTE)
        self.bridge, self.session = lifecycle.LoopLifecycleTests._bridge(self.state)
        self.session.working_dir = 'isolated-fixture'
        self.record = LoopRecord(1)
        self.state.loops = [self.record]

    async def startup(self):
        return await LoopStartupBridge._loop_startup_snapshot(self.bridge, self.session, self.state, self.record)

    async def test_slow_snapshot_leaves_other_session_heartbeat_responsive_and_dedupes(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(*args):
            started.set()
            await release.wait()
            return SnapshotResult(git='isolated-checkpoint')
        with patch('src.backend.loop_startup_bridge.snapshot_handoff', side_effect=slow) as worker:
            task = asyncio.create_task(self.startup())
            await started.wait()
            self.assertEqual(self.state.startup['status'], 'running')
            before = time.monotonic()
            await asyncio.sleep(.01)
            self.assertLess(time.monotonic() - before, .2)
            other = LoopState('other', stage=STAGE_EXECUTE)
            self.bridge._loop_states['other'] = other
            self.assertTrue(self.bridge._loop_iteration_request(other)['canRequest'])
            self.assertEqual(json.loads(self.bridge._rpc_loopRunIteration('s'))['status'], 'error')
            self.assertEqual(worker.call_count, 1)
            release.set()
            self.assertTrue(await task)
        self.assertFalse(self.bridge._loop_has_active_call('s'))
        self.assertEqual(self.record.git_checkpoint, 'isolated-checkpoint')

    async def test_cancel_retains_ownership_until_cleanup_confirmed(self):
        started, cleaning, exited = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def slow(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await exited.wait()
                return SnapshotResult()
        with patch('src.backend.loop_startup_bridge.snapshot_handoff', side_effect=slow):
            task = asyncio.create_task(self.startup())
            await started.wait()
            task.cancel()
            await cleaning.wait()
            self.assertTrue(self.bridge._loop_has_active_call('s'))
            self.assertFalse(task.done())
            exited.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse(self.bridge._loop_has_active_call('s'))

    async def test_unknown_exit_persists_guard_without_model_or_retry(self):
        with patch('src.backend.loop_startup_bridge.snapshot_handoff', new=AsyncMock(return_value=SnapshotResult(exit_confirmed=False))):
            self.assertFalse(await self.startup())
        self.assertEqual(self.state.startup['status'], 'unknown')
        self.assertTrue(self.bridge._loop_has_active_call('s'))
        reloaded = LoopState.from_dict(self.state.to_dict())
        cold, _ = lifecycle.LoopLifecycleTests._bridge(reloaded)
        self.assertFalse(cold._loop_iteration_request(reloaded)['canRequest'])

    async def test_presnapshot_write_failure_never_spawns(self):
        self.bridge._loop_flush = AsyncMock(side_effect=OSError('fake disk full'))
        with patch('src.backend.loop_startup_bridge.snapshot_handoff', new_callable=AsyncMock) as worker:
            with self.assertRaises(OSError):
                await self.startup()
            worker.assert_not_called()
        self.assertFalse(self.bridge._loop_has_active_call('s'))

    async def test_normal_persistence_is_ordered_and_does_not_block_event_loop(self):
        started, release = threading.Event(), threading.Event()
        saved = []
        def write(payload):
            started.set()
            release.wait(2)
            saved.append(payload['goal'])
        self.bridge._loop_store.save_frozen = write
        self.bridge._loop_save = BridgeWS._loop_save.__get__(self.bridge)
        self.state.goal = 'first'
        self.bridge._loop_save(self.state)
        self.state.goal = 'second'
        self.bridge._loop_save(self.state)
        try:
            await asyncio.wait_for(asyncio.to_thread(started.wait, 1), 1.5)
            before = time.monotonic()
            await asyncio.sleep(.01)
            self.assertLess(time.monotonic() - before, .2)
        finally:
            release.set()
            await self.bridge._loop_flush('s')
        self.assertEqual(saved, ['first', 'second'])

    async def test_confirmed_prespawn_os_failure_has_no_orphan_lock(self):
        with patch('src.backend.loop_control_snapshot.asyncio.create_subprocess_exec', new=AsyncMock(side_effect=OSError('fake spawn refused'))):
            result = await snapshot_handoff('isolated-fixture', 'takeover')
        self.assertTrue(result.exit_confirmed)
        self.assertIsNone(result.owner)
        self.assertIsNone(result.git)

    async def test_artifact_snapshot_does_not_replace_start_checkpoint(self):
        self.record.git_checkpoint = 'original-checkpoint'
        with patch('src.backend.loop_startup_bridge.snapshot_handoff', new=AsyncMock(return_value=SnapshotResult(git='artifact'))) as worker:
            self.assertTrue(await LoopStartupBridge._loop_startup_snapshot(self.bridge, self.session, self.state, self.record, artifact=True))
            worker.assert_awaited_once_with('isolated-fixture', 'release')
        self.assertEqual(self.record.git_checkpoint, 'original-checkpoint')
        self.assertEqual(self.record.artifact_checkpoint, 'artifact')


if __name__ == '__main__':
    unittest.main()
