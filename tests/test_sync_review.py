import asyncio
import base64
import codecs
import hashlib
import json
import os
import stat
import threading
import unittest
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.sync_review import MAX_BYTES, read_review, apply_review
from tests.engine_workbench_fixtures import EngineFixture


class ReviewFilesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {self.session.id: self.session}
        token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.addCleanup(_REQUEST_OWNER_ID.reset, token)
        self.identity = bridge._workbench_identity(self.session.id)
        self.path = self.fixture.write_project_file('test.txt', 'old\n')

    def read(self, path='test.txt'):
        return read_review(self.identity, path)

    def test_empty_missing_directory_large_binary_and_format(self):
        self.path.write_bytes(b'')
        empty = self.read()
        self.assertEqual(empty['kind'], 'file')
        self.assertEqual(empty['data'], '')
        self.assertEqual(self.read('missing.txt')['version'], {'exists': False})
        self.fixture.write_project_file('folder/child', '')
        self.assertEqual(self.read('folder')['kind'], 'directory')
        for data, reason in [(b'\0binary', 'binary'), (b'x' * (MAX_BYTES + 1), 'too_large'),
                             (b'\xff', 'invalid_encoding'), (b'x' * 65537, 'line_too_long'),
                             (b'\n' * 20000, 'too_many_lines')]:
            self.path.write_bytes(data)
            read = self.read()
            self.assertEqual(read['reasonCode'], reason)
            self.assertNotIn('data', read)
        self.path.write_bytes(b'a\r\nb\nc\r')
        self.assertEqual(self.read()['eol'], 'mixed')
        self.assertEqual(self.read()['reasonCode'], '')

    def test_same_size_edit_object_replacement_and_boundaries(self):
        before = self.read()['version']
        self.path.write_bytes(b'new\n')
        self.assertNotEqual(before, self.read()['version'])
        same = self.read()['version']
        replacement = self.fixture.write_project_file('replacement', 'new\n')
        os.replace(replacement, self.path)
        self.assertNotEqual(same['fileId'], self.read()['version']['fileId'])
        for path in ('../home/private', '/outside', 'C:/outside', 'test.txt:stream'):
            with self.assertRaises(WorkbenchError):
                self.read(path)
        with self.assertRaisesRegex(WorkbenchError, 'type_conflict'):
            self.read('test.txt/child')
        with patch('pathlib.Path.open', side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                self.read()

    def test_original_bytes_preserved_replace_create_and_attributes(self):
        for data in (b'', b'a\r\nb\nc\r', codecs.BOM_UTF8 + '中文\r\n'.encode(),
                     codecs.BOM_UTF16_BE + '中\n文'.encode('utf-16-be')):
            before = self.read()['version']
            mode = stat.S_IMODE(self.path.stat().st_mode)
            result = apply_review(self.identity, 'test.txt', before, data, lambda: None)
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(self.path.read_bytes(), data)
            self.assertEqual(mode, stat.S_IMODE(self.path.stat().st_mode))
            self.assertEqual(result['version'], self.read()['version'])
        apply_review(self.identity, 'new/child/empty', {'exists': False}, b'', lambda: None)
        self.assertEqual((self.fixture.workspace / 'new/child/empty').read_bytes(), b'')
        self.assertEqual(list(self.fixture.workspace.glob('.awu-review-*')), [])

    def test_changed_destination_and_creation_race_never_overwrite(self):
        before = self.read()['version']
        self.path.write_bytes(b'changed')
        with self.assertRaisesRegex(WorkbenchError, 'disk_conflict'):
            apply_review(self.identity, 'test.txt', before, b'reviewed', lambda: None)
        self.assertEqual(self.path.read_bytes(), b'changed')
        def gate():
            (self.fixture.workspace / 'new.txt').write_bytes(b'appeared')
        with self.assertRaisesRegex(WorkbenchError, 'disk_conflict'):
            apply_review(self.identity, 'new.txt', {'exists': False}, b'old', gate)
        self.assertEqual((self.fixture.workspace / 'new.txt').read_bytes(), b'appeared')
        original_link = os.link
        def race(source, target, **kwargs):
            (self.fixture.workspace / 'race.txt').write_bytes(b'won race')
            return original_link(source, target, **kwargs)
        with patch('src.backend.sync_review.os.link', side_effect=race):
            with self.assertRaises(FileExistsError):
                apply_review(self.identity, 'race.txt', {'exists': False}, b'reviewed', lambda: None)
        self.assertEqual((self.fixture.workspace / 'race.txt').read_bytes(), b'won race')

    def test_readonly_and_hardlink_refused_postpublish_failure_unknown(self):
        self.path.chmod(stat.S_IREAD)
        try:
            with self.assertRaisesRegex(WorkbenchError, 'document_readonly'):
                apply_review(self.identity, 'test.txt', self.read()['version'], b'x', lambda: None)
        finally:
            self.path.chmod(stat.S_IREAD | stat.S_IWRITE)
        link = self.fixture.workspace / 'hardlink'
        os.link(self.path, link)
        self.assertEqual(self.read()['reasonCode'], 'hardlinked_file')
        link.unlink()
        from src.backend.sync_review import _replace_existing
        def lost(*args):
            _replace_existing(*args)
            raise OSError('injected reply loss')
        with patch('src.backend.sync_review._replace_existing', side_effect=lost):
            with self.assertRaisesRegex(WorkbenchError, 'review_result_unverified'):
                apply_review(self.identity, 'test.txt', self.read()['version'], b'new', lambda: None)
        self.assertEqual(self.path.read_bytes(), b'new')


class ReviewBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}
        self.bridge._loop_control_jobs = {}
        token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.addAsyncCleanup(self.reset_owner, token)
        self.identity = self.bridge._workbench_identity(self.session.id)
        self.ident = json.dumps(self.identity.to_dict())
        self.path = self.fixture.write_project_file('test.txt', 'old\n')
        self.base = read_review(self.identity, 'test.txt')['version']
        self.addAsyncCleanup(self.shutdown)

    async def reset_owner(self, token):
        _REQUEST_OWNER_ID.reset(token)

    async def shutdown(self):
        for job in getattr(self.bridge, '_sync_review_jobs', {}).values():
            await asyncio.wait_for(asyncio.shield(job['completed']), 5)
        executor = getattr(self.bridge, '_sync_review_executor', None)
        if executor:
            executor.shutdown(wait=True)

    async def apply(self, data=b'new\n', rid='request1'):
        payload = dict(requestId=rid, relativePath='test.txt', baseVersion=self.base, data=base64.b64encode(data).decode(),
            sourceHash=hashlib.sha256(data).hexdigest(), scopeKey='isolated-fixture', controlRevision=0)
        return json.loads(await self.bridge._rpc_syncReviewApply(self.session.id, self.ident, json.dumps(payload)))

    async def get(self, wait=2):
        return json.loads(await self.bridge._rpc_syncReviewGet(self.session.id, self.ident, 'request1', wait))

    async def test_capability_read_check_identity_and_async_io(self):
        cap = json.loads(self.bridge._rpc_syncReviewCapabilities(self.session.id, self.session.working_dir))
        self.assertEqual(cap['workspace'], self.identity.to_dict())
        self.assertTrue(cap['apply'])
        entered, release = threading.Event(), threading.Event()
        def delayed(*args):
            entered.set()
            release.wait(2)
            return read_review(*args)
        with patch('src.backend.sync_review_bridge.read_review', side_effect=delayed):
            read = asyncio.create_task(self.bridge._rpc_syncReviewRead(self.session.id, self.ident, 'test.txt'))
            try:
                await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
                self.assertFalse(read.done())
            finally:
                release.set()
            result = json.loads(await read)
        self.assertEqual(result['version'], self.base)
        check = json.loads(await self.bridge._rpc_syncReviewCheck(self.session.id, self.ident, 'test.txt'))
        self.assertNotIn('data', check)
        self.assertEqual(check['version'], self.base)
        self.bridge._workbench_executor_instance = 'restarted'
        stale = json.loads(await self.bridge._rpc_syncReviewRead(self.session.id, self.ident, 'test.txt'))
        self.assertEqual(stale['reasonCode'], 'stale_workspace')

    async def test_idempotence_conflict_owner_unknown(self):
        self.assertEqual((await self.get())['status'], 'unknown')
        self.assertEqual((await self.apply())['status'], 'accepted')
        completed = await self.get()
        self.assertEqual(completed['status'], 'succeeded')
        self.assertEqual(await self.apply(), completed)
        self.assertEqual((await self.apply(b'other'))['reasonCode'], 'request_conflict')
        self.assertFalse(self.bridge._engineering_active(self.session.id))
        token = _REQUEST_OWNER_ID.set('foreign')
        try:
            with self.assertRaises(PermissionError):
                await self.get()
        finally:
            _REQUEST_OWNER_ID.reset(token)

    async def test_explicit_rejection_is_only_before_job_admission(self):
        with patch.object(self.bridge, '_engineering_admit', side_effect=WorkbenchError('control_changed')):
            rejected = await self.apply()
        self.assertEqual(rejected['status'], 'error')
        self.assertEqual(rejected['reasonCode'], 'control_changed')
        self.assertEqual((await self.get())['status'], 'unknown')
        self.assertEqual(self.path.read_text(), 'old\n')
        # 登记后哪怕整理回执失败，也返回真实活动回执，不变成“未提交”。
        with patch.object(self.bridge, '_review_trim', side_effect=ValueError('injected')):
            admitted = await self.apply()
        self.assertEqual(admitted['status'], 'accepted')
        self.assertEqual((await self.get())['status'], 'succeeded')

    async def test_wait_cancel_keeps_owned_job_and_unknown_never_replays(self):
        entered, release = threading.Event(), threading.Event()
        def delayed(*args):
            entered.set()
            release.wait(3)
            return apply_review(*args)
        with patch('src.backend.sync_review_bridge.apply_review', side_effect=delayed) as worker:
            await self.apply()
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            waiting = asyncio.create_task(self.get(10))
            await asyncio.sleep(0)
            waiting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting
            self.assertEqual((await self.get(0))['status'], 'accepted')
            self.assertTrue(self.bridge._engineering_active(self.session.id))
            self.assertEqual((await self.apply())['status'], 'accepted')
            release.set()
            self.assertEqual((await self.get())['status'], 'succeeded')
            self.assertEqual(worker.call_count, 1)
        self.base = read_review(self.identity, 'test.txt')['version']
        with patch('src.backend.sync_review_bridge.apply_review', side_effect=WorkbenchError('review_result_unverified')) as worker:
            await self.apply(rid='unknown')
            result = json.loads(await self.bridge._rpc_syncReviewGet(self.session.id, self.ident, 'unknown', 2))
            self.assertEqual(result['status'], 'unresolved')
            self.assertEqual((await self.apply(rid='unknown'))['status'], 'unresolved')
            self.assertEqual(worker.call_count, 1)
            self.assertTrue(self.bridge._engineering_active(self.session.id))


if __name__ == '__main__':
    unittest.main()
