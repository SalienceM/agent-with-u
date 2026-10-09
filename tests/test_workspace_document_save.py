import asyncio
import codecs
from concurrent.futures import ThreadPoolExecutor
import errno
import json
import os
import stat
import sys
import threading
import unittest
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.backend.engine_workbench import WorkbenchError
from src.backend.workspace_documents import atomic_save_document, read_document, guarded_parent
from tests.engine_workbench_fixtures import EngineFixture
from src.backend.loop_store import LoopState, LoopStore


class DocumentAtomicSaveTests(unittest.TestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._active_sessions = {self.session.id: self.session}
        token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.addCleanup(_REQUEST_OWNER_ID.reset, token)
        self.identity = bridge._workbench_identity(self.session.id)
        self.path = self.fixture.write_project_file('code.txt', 'original\n')
        self.original = self.path.read_bytes()
        self.baseline = read_document(self.identity, 'code.txt')['version']
        self.gate = Mock()

    def save(self, text='new\n', baseline=None, relative='code.txt'):
        return atomic_save_document(self.identity, relative, self.baseline if baseline is None else baseline, text, self.gate)

    def assert_no_temporary(self):
        self.assertEqual(list(self.path.parent.glob('.awu-save-*.tmp')), [])

    @unittest.skipUnless(os.name == 'nt', 'Windows sharing semantics')
    def test_parent_handle_actually_prevents_directory_rename(self):
        root = self.fixture.workspace.resolve()
        moved = root.with_name(root.name + '-rename-probe')
        self.assertEqual(moved.parent, root.parent)
        self.assertFalse(moved.exists())
        renamed = False
        with guarded_parent(root, self.path):
            try:
                root.rename(moved)
                renamed = True
            except OSError:
                pass
            finally:
                if renamed:
                    moved.rename(root)
        self.assertFalse(renamed, 'attribute-only handles do not pin Windows directories')

    def test_preserves_encoding_eol_and_returns_exact_committed_version(self):
        for marker, codec in ((codecs.BOM_UTF8, 'utf-8'), (codecs.BOM_UTF16_LE, 'utf-16-le')):
            self.path.write_bytes(marker + 'old\r\n'.encode(codec))
            before = self.path.stat()
            baseline = read_document(self.identity, 'code.txt')['version']
            saved = self.save('新🙂\n', baseline)
            self.assertEqual(saved['status'], 'succeeded')
            self.assertEqual(self.path.read_bytes(), marker + '新🙂\r\n'.encode(codec))
            self.assertEqual(saved['version'], read_document(self.identity, 'code.txt')['version'])
            self.assertEqual(stat.S_IMODE(before.st_mode), stat.S_IMODE(self.path.stat().st_mode))
        self.gate.assert_called()
        self.assert_no_temporary()

    def test_external_edit_delete_and_recreation_conflict(self):
        for action in ('edit', 'delete', 'recreate'):
            self.path.write_bytes(self.original)
            baseline = read_document(self.identity, 'code.txt')['version']
            if action == 'edit':
                self.path.write_bytes(b'external')
            else:
                self.path.unlink()
                if action == 'recreate':
                    self.path.write_bytes(self.original)
            with self.assertRaisesRegex(WorkbenchError, 'disk_conflict'):
                self.save(baseline=baseline)
            self.assertEqual(self.path.exists(), action != 'delete')
        self.assert_no_temporary()

    def test_final_disk_and_control_checks_protect_original(self):
        self.gate.side_effect = WorkbenchError('stale_control_revision')
        with self.assertRaisesRegex(WorkbenchError, 'stale_control_revision'):
            self.save()
        self.assertEqual(self.path.read_bytes(), self.original)
        self.gate.side_effect = lambda: self.path.write_bytes(b'changed near commit')
        with self.assertRaisesRegex(WorkbenchError, 'disk_conflict'):
            self.save()
        self.assertEqual(self.path.read_bytes(), b'changed near commit')
        self.assert_no_temporary()

    def test_disk_full_and_replace_failure_do_not_truncate_original(self):
        for method in ('os.fsync', 'src.backend.workspace_documents._replace_existing'):
            with patch(method, side_effect=OSError(errno.ENOSPC, 'fixture disk full')):
                with self.assertRaises(OSError):
                    self.save()
            self.assertEqual(self.path.read_bytes(), self.original)
            self.assert_no_temporary()

    def test_exclusive_temporary_collision_never_deletes_unowned_file(self):
        occupied = self.path.parent / '.awu-save-collision.tmp'
        occupied.write_bytes(b'not owned by this save')
        with patch('src.backend.workspace_documents.uuid.uuid4', return_value=Mock(hex='collision')):
            with self.assertRaises(FileExistsError):
                self.save()
        self.assertEqual(occupied.read_bytes(), b'not owned by this save')
        self.assertEqual(self.path.read_bytes(), self.original)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux inode generation')
    def test_unverifiable_generation_is_preview_only_and_never_commits_new_file(self):
        with patch('fcntl.ioctl', side_effect=OSError(errno.EOPNOTSUPP, 'unsupported fixture fs')):
            document = read_document(self.identity, 'code.txt')
            self.assertFalse(document['editable'])
            self.assertIsNone(document['version'])
            self.assertEqual(document['reasonCode'], 'file_identity_unverifiable')
            with self.assertRaisesRegex(WorkbenchError, 'file_identity_unverifiable'):
                self.save('new', {'exists': False}, 'new.txt')
        self.assertFalse((self.path.parent / 'new.txt').exists())
        self.assert_no_temporary()

    @unittest.skipUnless(sys.platform == 'linux', 'Linux file attributes')
    def test_linux_replace_preserves_owner_mode_and_extended_attributes(self):
        os.setxattr(self.path, 'user.awu-fixture', b'preserve me')
        if os.geteuid() == 0:
            os.chown(self.path, 65534, 65534)  # 仅独占临时夹具，不修改用户/系统文件。
        self.path.chmod(0o2640)
        before = self.path.stat()
        baseline = read_document(self.identity, 'code.txt')['version']
        self.save(baseline=baseline)
        after = self.path.stat()
        self.assertEqual((before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)),
                         (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)))
        self.assertEqual(os.getxattr(self.path, 'user.awu-fixture'), b'preserve me')

    def test_concurrent_alias_saves_share_lock_only_one_baseline_wins(self):
        def save(relative):
            try:
                return self.save(relative=relative)['status']
            except WorkbenchError as error:
                return error.reason
        aliases = ['code.txt', './code.txt', 'CODE.TXT' if os.name == 'nt' else '././code.txt']
        with ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(save, aliases))
        self.assertEqual(results.count('succeeded'), 1)
        self.assertEqual(results.count('disk_conflict'), 2)
        self.assert_no_temporary()

    def test_hardlinks_and_unsupported_content_do_not_write(self):
        os.link(self.path, self.fixture.workspace / 'alias.txt')
        baseline = read_document(self.identity, 'code.txt')['version']
        with self.assertRaisesRegex(WorkbenchError, 'document_readonly'):
            self.save(baseline=baseline)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assert_no_temporary()

    def test_new_file_does_not_replace_racing_creator(self):
        relative = 'new.txt'
        path = self.fixture.workspace / relative
        saved = self.save('created', {'exists': False}, relative)
        self.assertEqual(saved['version'], read_document(self.identity, relative)['version'])
        self.assertTrue(read_document(self.identity, relative)['editable'])
        path.unlink()
        self.gate.side_effect = lambda: path.write_bytes(b'external new file')
        with self.assertRaisesRegex(WorkbenchError, 'disk_conflict'):
            self.save('my new file', {'exists': False}, relative)
        self.assertEqual(path.read_bytes(), b'external new file')
        self.assert_no_temporary()

    def test_readonly_attributes_not_bypassed(self):
        self.path.chmod(0o400)
        try:
            baseline = read_document(self.identity, 'code.txt')['version']
            with self.assertRaises(OSError):
                self.save(baseline=baseline)
            self.assertEqual(self.path.read_bytes(), self.original)
            self.assert_no_temporary()
        finally:
            self.path.chmod(0o600)

    def test_linked_parent_cannot_escape_workspace(self):
        link = self.fixture.workspace / 'linked'
        os.symlink(self.fixture.home, link, target_is_directory=True)
        with self.assertRaisesRegex(WorkbenchError, 'linked_path'):
            self.save('bad', {'exists': False}, 'linked/new.txt')
        self.assertFalse((self.fixture.home / 'new.txt').exists())
        link.unlink()

    @unittest.skipUnless(os.name == 'nt', 'Windows file attributes')
    def test_windows_replace_preserves_creation_time_dacl_and_existing_streams(self):
        import ctypes
        from ctypes import wintypes
        security = ctypes.WinDLL('advapi32', use_last_error=True).GetFileSecurityW
        security.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p,
                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        def dacl():
            buffer = ctypes.create_string_buffer(16384)
            needed = wintypes.DWORD()
            if not security(str(self.path), 4, buffer, len(buffer), ctypes.byref(needed)):
                raise ctypes.WinError(ctypes.get_last_error())
            return buffer.raw[:needed.value]
        from pathlib import Path
        stream = Path(str(self.path) + ':fixture')
        stream.write_bytes(b'preserved metadata')
        before, creation = dacl(), self.path.stat().st_ctime_ns
        self.baseline = read_document(self.identity, 'code.txt')['version']
        self.save()
        self.assertEqual(dacl(), before)
        self.assertEqual(self.path.stat().st_ctime_ns, creation)
        self.assertEqual(stream.read_bytes(), b'preserved metadata')


class DocumentSaveProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session(session_type='loop')
        self.sid = self.session.id
        self.state = LoopState(session_id=self.sid, stage='loopexecute', control_mode='manual')
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.sid: self.session}
        self.bridge._loop_states = {self.sid: self.state}
        self.bridge._loop_store = LoopStore()
        self.bridge._loop_environment_executor = Mock(return_value='fixture-executor')
        self.path = self.fixture.write_project_file('code.txt', 'before\n')
        self.path.write_bytes(b'before\n')

    async def asyncSetUp(self):
        self.token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.identity = self.bridge._workbench_identity(self.sid)
        self.payload = {'requestId': 'save-1', 'relativePath': 'code.txt', 'text': 'after\n',
                        'baseVersion': read_document(self.identity, 'code.txt')['version'],
                        'bufferRevision': 7, 'controlRevision': 0}

    async def asyncTearDown(self):
        for job in getattr(self.bridge, '_document_save_jobs', {}).values():
            await asyncio.wait_for(asyncio.shield(job['completed']), 5)
        executor = getattr(self.bridge, '_document_save_executor', None)
        if executor:
            executor.shutdown(wait=True)
        _REQUEST_OWNER_ID.reset(self.token)

    async def save(self, **changes):
        return json.loads(await self.bridge._rpc_workspaceDocumentSave(self.sid,
            json.dumps(self.identity.to_dict()), json.dumps({**self.payload, **changes})))

    async def receipt(self, wait=2):
        return json.loads(await self.bridge._rpc_workspaceDocumentSaveGet(self.sid,
            json.dumps(self.identity.to_dict()), 'save-1', wait))

    async def test_duplicates_and_lost_receipt_do_not_write_twice(self):
        from src.backend.workspace_documents import _replace_existing
        with patch('src.backend.workspace_documents._replace_existing', wraps=_replace_existing) as replace:
            first = await self.save()
            self.assertEqual(first['status'], 'accepted')
            self.assertEqual((await self.save(text='different'))['reasonCode'], 'request_conflict')
            saved = await self.receipt()
            self.assertEqual(saved['status'], 'succeeded')
            self.assertEqual(saved['bufferRevision'], 7)
            self.assertEqual(await self.save(), saved)
            self.assertEqual(await self.receipt(), saved)
            self.assertEqual(replace.call_count, 1)
        self.assertEqual(self.bridge._engineering_active(self.sid), ())

    async def test_cancel_wait_and_timeout_keep_owned_activity_until_worker_finishes(self):
        entered, finish = threading.Event(), threading.Event()
        def delayed(*args):
            entered.set()
            if not finish.wait(4):
                raise RuntimeError('fixture timeout')
            return atomic_save_document(*args)
        with patch('src.backend.workspace_document_bridge.atomic_save_document', side_effect=delayed):
            await self.save()
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            waiter = asyncio.create_task(self.receipt(10))
            await asyncio.sleep(0)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertEqual((await self.receipt(1))['status'], 'accepted')
            self.assertEqual(len(self.bridge._engineering_active(self.sid)), 1)
            blocked = json.loads(await self.bridge._rpc_loopControlRequest(self.sid,
                json.dumps({'requestId': 'release', 'action': 'release', 'expectedControlRevision': 0})))
            self.assertEqual(blocked['reasonCode'], 'engineering_activity')
            finish.set()
            self.assertEqual((await self.receipt())['status'], 'succeeded')
        self.assertEqual(self.bridge._engineering_active(self.sid), ())

    async def test_final_control_check_rejects_changed_authority(self):
        entered, finish = threading.Event(), threading.Event()
        def delayed(*args):
            entered.set()
            finish.wait(3)
            return atomic_save_document(*args)
        with patch('src.backend.workspace_document_bridge.atomic_save_document', side_effect=delayed):
            await self.save()
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            self.state.control_revision += 1
            finish.set()
            result = await self.receipt()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reasonCode'], 'stale_control_revision')
        self.assertEqual(self.path.read_bytes(), b'before\n')
        self.assertFalse(self.bridge._engineering_active(self.sid))

    async def test_handoff_and_auto_mode_reject_before_submission(self):
        self.bridge._loop_control_jobs = {self.sid: {'requestId': 'in-flight'}}
        self.assertEqual((await self.save())['reasonCode'], 'handoff_busy')
        self.bridge._loop_control_jobs.clear()
        self.state.control_mode = 'loop'
        self.assertEqual((await self.save())['reasonCode'], 'manual_control_required')
        self.assertEqual(self.path.read_bytes(), b'before\n')
        self.assertFalse(self.bridge._engineering_active(self.sid))

    async def test_result_uncertainty_is_reconciled_readonly(self):
        from src.backend.workspace_documents import _replace_existing
        def reply_lost(*args):
            _replace_existing(*args)
            raise OSError('injected outcome loss')
        with patch('src.backend.workspace_documents._replace_existing', side_effect=reply_lost) as replace:
            await self.save()
            job = next(iter(self.bridge._document_save_jobs.values()))
            await asyncio.shield(job['completed'])
            self.assertEqual(job['receipt']['status'], 'unresolved')
            self.assertTrue(self.bridge._engineering_active(self.sid))
            result = await self.receipt()
            self.assertEqual(result['status'], 'succeeded')
            self.assertTrue(result['reconciled'])
            self.assertEqual(replace.call_count, 1)
        self.assertFalse(self.bridge._engineering_active(self.sid))

    async def test_get_and_write_reject_foreign_identity_unknown_receipt_never_replays(self):
        self.assertEqual((await self.receipt())['status'], 'unknown')
        token = _REQUEST_OWNER_ID.set('another-user')
        try:
            with self.assertRaises(PermissionError):
                await self.save()
            with self.assertRaises(PermissionError):
                await self.receipt()
        finally:
            _REQUEST_OWNER_ID.reset(token)
        self.session.working_dir = str(self.fixture.home)
        self.assertEqual((await self.save())['reasonCode'], 'stale_workspace')
        self.assertEqual((await self.receipt())['reasonCode'], 'stale_workspace')
        self.assertEqual(self.path.read_bytes(), b'before\n')

    async def test_failure_does_not_release_a_different_activity(self):
        terminal = self.bridge._engineering_admit(self.sid, self.identity.to_dict(), 0, 'terminal')
        self.path.write_bytes(b'other writer')
        await self.save()
        self.assertEqual((await self.receipt())['reasonCode'], 'disk_conflict')
        self.assertEqual(self.bridge._engineering_active(self.sid), (terminal,))
        self.bridge._engineering_confirm_finished(terminal)
