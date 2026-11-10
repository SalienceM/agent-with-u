from __future__ import annotations

import base64
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.backend.directory_transfer import DirectoryTransfers, scan


def meta(data: bytes) -> dict:
    return {'hash': hashlib.sha256(data).hexdigest(), 'size': len(data)}


class DirectoryTransferTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.manager = DirectoryTransfers()
        self.identity = {'workingDir': str(self.root), 'ownerId': 'test', 'sessionId': 's', 'executorInstance': 'node'}

    def tearDown(self) -> None:
        for row in self.manager.rows.values():
            self.manager._clean(row)
        self.temp.cleanup()

    def write(self, rel: str, data: bytes) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def plan(self, source: dict[str, bytes], mirror: bool = False, scope: str = '') -> dict:
        return self.manager.plan(self.identity, {'source': {p: meta(d) for p, d in source.items()}, 'scope': scope,
            'directory': True, 'mirror': mirror, 'includeGit': False, 'ignore': ['node_modules']}, ['node_modules'])

    def upload(self, plan: dict, source: dict[str, bytes]) -> None:
        for entry in plan['entries']:
            if entry['action'] in ('add', 'update'):
                self.manager.chunk(self.identity, plan['id'], entry['path'], 0, base64.b64encode(source[entry['path']]).decode())

    def commit(self, plan: dict) -> dict:
        return self.manager.commit(self.identity, plan['id'], lambda: None)

    def test_skip_identical_and_copy_changed_same_size_with_empty_file(self) -> None:
        self.write('same', b'yes'); self.write('changed', b'old'); self.write('extra', b'keep')
        stamp = (self.root / 'same').stat().st_mtime_ns
        source = {'same': b'yes', 'changed': b'new', 'empty': b''}
        plan = self.plan(source)
        self.assertEqual({e['path']: e['action'] for e in plan['entries']}, {'changed': 'update', 'empty': 'add', 'same': 'skip'})
        self.upload(plan, source)
        result = self.commit(plan)
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(result['uploaded'], ['changed', 'empty'])
        self.assertEqual((self.root / 'same').stat().st_mtime_ns, stamp)
        self.assertTrue((self.root / 'extra').exists())
        self.assertEqual(self.commit(plan), result)

    def test_mirror_deletes_only_selected_scope_and_preserves_git_ignored(self) -> None:
        for rel in ['part/old', 'part/.git/config', 'part/node_modules/lib', 'partial/old']:
            self.write(rel, b'keep')
        plan = self.plan({}, True, 'part')
        self.assertEqual([e['path'] for e in plan['entries']], ['part/old'])
        self.assertEqual(self.commit(plan)['state'], 'succeeded')
        self.assertFalse((self.root / 'part/old').exists())
        for rel in ['part/.git/config', 'part/node_modules/lib', 'partial/old']:
            self.assertTrue((self.root / rel).exists())

    def test_stale_target_fails_before_writes_and_deletion(self) -> None:
        self.write('old', b'old')
        plan = self.plan({'new': b'new'}, True)
        self.upload(plan, {'new': b'new'})
        self.write('late', b'late')
        self.assertEqual(self.commit(plan)['state'], 'failed')
        self.assertFalse((self.root / 'new').exists())
        self.assertTrue((self.root / 'old').exists())

    def test_corrupt_or_missing_body_does_not_delete(self) -> None:
        self.write('old', b'old')
        plan = self.plan({'new': b'new'}, True)
        self.upload(plan, {'new': b'bad'})
        self.assertEqual(self.commit(plan)['state'], 'failed')
        self.assertTrue((self.root / 'old').exists())
        self.assertFalse((self.root / 'new').exists())

    def test_failure_after_first_write_reports_partial_and_keeps_delete(self) -> None:
        self.write('old', b'old')
        source = {'a': b'one', 'b': b'two'}
        plan = self.plan(source, True); self.upload(plan, source)
        import os
        replace = os.replace
        def fail_second(src: Path, dst: Path) -> None:
            if dst.name == 'b': raise OSError('disk failure')
            replace(src, dst)
        with patch('src.backend.directory_transfer.os.replace', side_effect=fail_second):
            result = self.commit(plan)
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(result['uploaded'], ['a'])
        self.assertEqual(result['deleted'], [])
        self.assertTrue((self.root / 'old').exists())

    def test_cancel_and_scope_identity(self) -> None:
        plan = self.plan({'a': b'a'})
        with self.assertRaises(ValueError): self.manager.get({**self.identity, 'ownerId': 'other'}, plan['id'])
        self.manager.cancel(self.identity, plan['id'])
        self.assertEqual(self.commit(plan)['state'], 'cancelled')
        self.assertFalse((self.root / 'a').exists())

    def test_path_type_case_and_git_protections(self) -> None:
        (self.root / 'dir').mkdir()
        for rel in ['../bad', '/bad', 'C:/bad', '.git/config', 'dir']:
            with self.assertRaises((ValueError, OSError)): self.plan({rel: b'x'}, True)
        with self.assertRaises(ValueError): self.plan({'Foo': b'a', 'foo': b'b'})

    def test_read_failure_and_same_mtime_do_not_reuse_old_hash(self) -> None:
        self.write('file', b'old')
        old = scan(self.root, '', True, [], False)
        import os
        stamp = (self.root / 'file').stat()
        self.write('file', b'new')
        os.utime(self.root / 'file', ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertNotEqual(scan(self.root, '', True, [], False), old)
        with patch('src.backend.directory_transfer.os.scandir', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError): self.plan({}, True)

    def test_links_rejected_without_following(self) -> None:
        self.write('original', b'safe')
        try: (self.root / 'link').symlink_to(self.root / 'original')
        except OSError: self.skipTest('OS does not allow symlink creation')
        with self.assertRaises(ValueError): self.plan({}, True)


class DirectoryTransferBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        import json
        from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
        from tests.engine_workbench_fixtures import EngineFixture
        from unittest.mock import Mock
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.session = self.fixture.session()
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._active_sessions = {self.session.id: self.session}
        self.bridge._loop_environment_executor = lambda: 'transfer-fixture'
        self.bridge._loop_control_jobs = {}
        self.bridge._app_config_store = Mock()
        self.bridge._app_config_store.get.return_value = ['node_modules']
        self.bridge._project_activity = lambda _: []
        self.bridge._project_branch_changed = lambda _: None
        token = _REQUEST_OWNER_ID.set(self.session.owner_id)
        async def reset() -> None:
            _REQUEST_OWNER_ID.reset(token)
        self.addAsyncCleanup(reset)
        self.identity = self.bridge._workbench_identity(self.session.id).to_dict()
        self.ident = json.dumps(self.identity)

    async def prepare(self) -> dict:
        import json
        self.fixture.write_project_file('extra', 'delete')
        raw = await self.bridge._rpc_syncTransferPlan(self.session.id, self.ident, json.dumps({
            'source': {'new': meta(b'new')}, 'scope': '', 'directory': True, 'mirror': True,
            'includeGit': False, 'ignore': ['node_modules']}))
        row = json.loads(raw)
        self.assertEqual(row['status'], 'ok', row)
        await self.bridge._rpc_syncTransferChunk(self.session.id, self.ident, row['id'], 'new', 0, base64.b64encode(b'new').decode())
        return row

    async def test_commit_uses_real_engineering_gate_and_receipt(self) -> None:
        import json
        row = await self.prepare()
        result = json.loads(await self.bridge._rpc_syncTransferCommit(self.session.id, self.ident, self.session.working_dir, row['id']))
        self.assertEqual(result.get('state'), 'succeeded', result)
        status = json.loads(self.bridge._rpc_syncTransferStatus(self.session.id, self.ident, row['id']))
        self.assertEqual(status, result)
        self.assertEqual(self.bridge._engineering_active(self.session.id), ())
        self.assertFalse((self.fixture.workspace / 'extra').exists())
        self.assertEqual((self.fixture.workspace / 'new').read_bytes(), b'new')

    async def test_active_project_refuses_and_identity_cannot_change(self) -> None:
        import json
        row = await self.prepare()
        self.bridge._project_activity = lambda _: [{'reason': 'running'}]
        result = json.loads(await self.bridge._rpc_syncTransferCommit(self.session.id, self.ident, self.session.working_dir, row['id']))
        self.assertEqual(result['status'], 'error')
        self.assertTrue((self.fixture.workspace / 'extra').exists())
        invalid = json.dumps({**self.identity, 'executorInstance': 'other'})
        result = json.loads(self.bridge._rpc_syncTransferStatus(self.session.id, invalid, row['id']))
        self.assertEqual(result['status'], 'error')
        await self.bridge._rpc_syncTransferCancel(self.session.id, self.ident, row['id'])

    async def test_cancelled_waiter_retains_owned_commit_and_lease(self) -> None:
        import asyncio
        import json
        import threading
        row = await self.prepare()
        entered, release = threading.Event(), threading.Event()
        manager = self.bridge._directory_transfers()
        commit = manager.commit
        def delayed(*args):
            entered.set(); release.wait(3)
            return commit(*args)
        with patch.object(manager, 'commit', side_effect=delayed):
            waiter = asyncio.create_task(self.bridge._rpc_syncTransferCommit(self.session.id, self.ident, self.session.working_dir, row['id']))
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 2)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError): await waiter
            self.assertTrue(self.bridge._engineering_active(self.session.id))
            release.set()
            await asyncio.wait_for(asyncio.gather(*self.bridge._directory_transfer_tasks), 2)
        result = json.loads(self.bridge._rpc_syncTransferStatus(self.session.id, self.ident, row['id']))
        self.assertEqual(result['state'], 'succeeded')
        self.assertFalse(self.bridge._engineering_active(self.session.id))

    async def test_late_write_gate_rejection_releases_unstarted_lease(self) -> None:
        import json
        row = await self.prepare()
        async def reject(_root, operation):
            operation.close()
            raise ValueError('frozen')
        self.bridge._project_guarded_call = reject
        result = json.loads(await self.bridge._rpc_syncTransferCommit(self.session.id, self.ident, self.session.working_dir, row['id']))
        self.assertEqual(result['status'], 'error')
        self.assertFalse(self.bridge._engineering_active(self.session.id))
        self.assertTrue((self.fixture.workspace / 'extra').exists())
        await self.bridge._rpc_syncTransferCancel(self.session.id, self.ident, row['id'])
