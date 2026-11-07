"""隔离磁盘/假发布阻塞下的响应性；不运行真实发布或访问用户会话。"""
import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.release_center import ReleaseCenterManager
from src.backend.workspace_kit_store import WorkspaceKitStore
from src.types import Session


class SessionViewReadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {}
        self.session = Session(id='session', title='fixture', created_at=0, updated_at=0,
                               messages=[], owner_id='alice', working_dir='', backend_id='fixture')
        self.store = self.bridge._session_store = Mock()
        self.store.get_meta.return_value = self.session.meta_dict()
        self.started, self.release = threading.Event(), threading.Event()
        def read(sid):
            self.started.set()
            self.release.wait(3)
            return self.session
        self.store.load.side_effect = read
        self.owner = _REQUEST_OWNER_ID.set('alice')

    async def asyncTearDown(self):
        self.release.set()
        jobs = list(getattr(self.bridge, '_session_view_loads', {}).values())
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
        _REQUEST_OWNER_ID.reset(self.owner)

    async def test_cold_reads_coalesce_and_do_not_replace_newer_active_session(self):
        one = asyncio.create_task(self.bridge._load_session_for_view('session'))
        two = asyncio.create_task(self.bridge._load_session_for_view('session'))
        self.assertTrue(await asyncio.to_thread(self.started.wait, .5))
        newer = Session(id='session', title='new', created_at=0, updated_at=1,
                        messages=[], owner_id='alice', working_dir='', backend_id='fixture')
        self.bridge._active_sessions['session'] = newer
        self.release.set()
        await asyncio.gather(one, two)
        self.assertIs(self.bridge._active_sessions['session'], newer)
        self.store.load.assert_called_once()

    async def test_deleted_session_is_not_resurrected_by_late_disk_read(self):
        read = asyncio.create_task(self.bridge._load_session_for_view('session'))
        self.assertTrue(await asyncio.to_thread(self.started.wait, .5))
        self.store.get_meta.return_value = None
        self.release.set()
        with self.assertRaises(PermissionError):
            await read
        self.assertFalse(self.bridge._active_sessions)

    async def test_cancelled_waiter_does_not_install_late_session_or_leak_job(self):
        read = asyncio.create_task(self.bridge._load_session_for_view('session'))
        self.assertTrue(await asyncio.to_thread(self.started.wait, .5))
        job = self.bridge._session_view_loads['session']
        read.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await read
        self.release.set()
        await job
        await asyncio.sleep(0)
        self.assertFalse(self.bridge._active_sessions)
        self.assertFalse(self.bridge._session_view_loads)


class ReleaseIoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = ReleaseCenterManager(Path(self.temp.name))
        self.manager._save_state({'jobs': [{'id': 'job', 'status': 'running'}]})
        self.started, self.release = threading.Event(), threading.Event()

    async def asyncTearDown(self):
        self.release.set()
        self.temp.cleanup()

    async def test_slow_publish_progress_disk_write_does_not_block_event_loop(self):
        original = self.manager._save_state
        main_thread = threading.get_ident()
        writers = []
        def slow(state):
            writers.append(threading.get_ident())
            self.started.set()
            self.release.wait(3)
            original(state)
        with patch.object(self.manager, '_save_state', side_effect=slow):
            task = asyncio.create_task(self.manager._report_upload_progress('job', 20, 100, 0, 100))
            try:
                self.assertTrue(await asyncio.to_thread(self.started.wait, .5))
                self.assertFalse(task.done())
                self.assertNotIn(main_thread, writers)
                await asyncio.wait_for(asyncio.sleep(0), .2)
            finally:
                self.release.set()
                await task
        self.assertEqual(self.manager.job_status('job')['uploadedBytes'], 20)

    async def test_cancelled_io_finishes_commit_before_later_write_and_callback(self):
        events = []
        def write():
            self.started.set()
            self.release.wait(3)
            events.append('disk')
            return 'receipt'
        task = asyncio.create_task(self.manager._io(write, committed=lambda value: events.append(value)))
        self.assertTrue(await asyncio.to_thread(self.started.wait, .5))
        task.cancel()
        later = asyncio.create_task(self.manager._io(lambda: events.append('later')))
        await asyncio.sleep(.02)
        self.assertFalse(task.done())
        self.assertFalse(later.done())
        self.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await later
        self.assertEqual(events, ['disk', 'receipt', 'later'])

    async def test_job_read_does_not_probe_account_and_terminal_is_stable(self):
        with patch.object(self.manager, 'public_config', side_effect=AssertionError('account probe')):
            self.assertEqual((await self.manager._io(self.manager.job_status, 'job'))['id'], 'job')
        self.manager._update_job('job', {'status': 'succeeded'})
        self.manager._update_job('job', {'status': 'cancelled'})
        self.assertEqual(self.manager.job_status('job')['status'], 'succeeded')


class KitInventoryTests(unittest.TestCase):
    def test_unchanged_logs_not_reread_and_changed_or_deleted_inventory_invalidates(self):
        with tempfile.TemporaryDirectory() as root, patch('src.backend.workspace_kit_store.paths.sub', return_value=Path(root)):
            store = WorkspaceKitStore()
            path = Path(root) / 'fixture.json'
            path.write_text(json.dumps({'sessionId': 'first', 'logs': 'x' * 10000}), encoding='utf-8')
            self.assertEqual(store.list_session_ids(), ['first'])
            with patch.object(Path, 'read_text', side_effect=AssertionError('unchanged log reread')):
                self.assertEqual(store.list_session_ids(), ['first'])
            path.write_text(json.dumps({'sessionId': 'second'}), encoding='utf-8')
            self.assertEqual(store.list_session_ids(), ['second'])
            path.unlink()
            self.assertEqual(store.list_session_ids(), [])


if __name__ == '__main__':
    unittest.main()
