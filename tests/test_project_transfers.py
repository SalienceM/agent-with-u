import asyncio
import base64
import hashlib
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch
import zipfile

from tests.test_task_workspaces import TaskWorkspaceTests
from tests.test_role_reviews import ReviewBridge, ReviewTests
from src.backend.project_transfer_snapshot import export_snapshot, import_snapshot, read_snapshot, validate_manifest
from src.backend.session_collaboration_store import CollaborationError
from src.backend.task_git import TaskGit
from src.backend.engine_workbench import WorkspaceIdentity


class ProjectTransferTests(unittest.IsolatedAsyncioTestCase):
    repository = TaskWorkspaceTests.repository
    role = ReviewTests.role
    answer = ReviewTests.answer

    def setUp(self):
        ReviewTests.setUp(self)
        self.bridge._loop_environment_executor = lambda: 'A'
        self.bridge._workbench_identity = lambda sid: WorkspaceIdentity('tester', 'A', sid, self.bridge._collaboration_session(sid).working_dir, 'revision')
        self.bridge._session_destroy_busy_reason = lambda sid: ''
        self.b = ReviewBridge()
        self.b._loop_environment_executor = lambda: 'B'
        for key in ('_session_store', '_session_collaboration_store', '_backend_configs', '_emit_event', '_emit_session_updated'):
            setattr(self.b, key, getattr(self.bridge, key))
        self.b._active_sessions = {}

    async def asyncTearDown(self):
        for bridge in (self.bridge, self.b):
            await asyncio.gather(*list(bridge._transfer_jobs().values()), *list(bridge._task_jobs().values()), return_exceptions=True)
        await ReviewTests.asyncTearDown(self)

    async def transfer(self, source=None, target=None, sid='main', prefix='send', mode='project'):
        source, target = source or self.bridge, target or self.b
        exported = json.loads(await source._rpc_projectTransferExport(sid, prefix + '-export', target._loop_environment_executor(), mode))
        self.assertEqual(exported['status'], 'exported', exported.get('notice'))
        plan = json.loads(await target._rpc_projectTransferPlan(prefix + '-plan', json.dumps(exported['descriptor']), 'Transferred project', 'api'))
        self.assertFalse(Path(plan['root']).exists())
        request = prefix + '-accept'
        target._rpc_projectTransferAccept(plan['id'], request, plan['planFingerprint'])
        offset = 0
        while offset < exported['descriptor']['size']:
            chunk = json.loads(source._rpc_projectTransferRead(exported['id'], offset))
            target._rpc_projectTransferChunk(plan['id'], request, offset, chunk['data'])
            offset = chunk['nextOffset']
        result = json.loads(await target._rpc_projectTransferFinish(plan['id'], request))
        self.assertEqual(result['status'], 'succeeded', result.get('notice'))
        self.assertEqual(result['receipt']['status'], 'succeeded')
        return exported, result

    async def test_offline_roundtrip_with_local_branches_binary_deletion_and_advanced_A(self):
        (self.project / 'delete.txt').write_text('delete later')
        (self.project / '.gitignore').write_text('cache/\n')
        git = self.repository()
        (self.project / 'proof.txt').write_text('saved current A')
        (self.project / 'new.bin').write_bytes(b'\0\xff\x01')
        cache = self.project / 'cache'; cache.mkdir(); (cache / 'ignored').write_text('cache')
        before = git.inspect(); index = (self.project / '.git/index').read_bytes()
        outbound, received = await self.transfer()
        self.assertEqual(git.inspect()['fingerprint'], before['fingerprint'])
        self.assertEqual((self.project / '.git/index').read_bytes(), index)
        b_session = self.b._session_store.load(received['sessionId'])
        b_root = Path(b_session.working_dir); b_git = TaskGit(str(b_root))
        self.assertFalse((b_root / 'cache').exists())
        self.assertEqual(b_git.run('remote'), b'')
        self.assertEqual((b_root / 'new.bin').read_bytes(), b'\0\xff\x01')
        self.assertEqual(b_session.messages, []); self.assertIsNone(b_session.agent_session_id)
        self.assertFalse(b_session.skip_permissions); self.assertFalse(b_session.parent_session_id)
        self.assertNotEqual(b_git.repository()['repositoryId'], git.repository()['repositoryId'])
        branch = json.loads(await self.b._rpc_taskWorkspacePlan(b_session.id, 'branch-plan', json.dumps({'title': 'B task', 'backendId': 'api'})))
        self.b._rpc_taskWorkspaceCreate(b_session.id, branch['id'], 'branch-create', branch['planFingerprint'])
        await asyncio.gather(*self.b._task_jobs().values())
        child = self.b._session_store.load(branch['sessionId']); work = Path(child.working_dir)
        (work / 'proof.txt').write_text('B branch result')
        (work / 'delete.txt').unlink()
        (work / 'new.bin').write_bytes(b'\0B\xff\xfe')
        self.assertTrue((b_root / 'delete.txt').exists())
        # A advances independently before return, including the original saved snapshot.
        git.run('add', '.'); git.run('commit', '-m', 'save A')
        (self.project / 'proof.txt').write_text('A conflicting result')
        git.run('add', '.'); git.run('commit', '-m', 'advance A')
        a_before = git.inspect(); a_index = (self.project / '.git/index').read_bytes()
        _, result = await self.transfer(self.b, self.bridge, child.id, 'return', 'return')
        candidate = self.bridge._session_store.load(result['sessionId']); candidate_git = TaskGit(candidate.working_dir)
        self.assertEqual(candidate.parent_session_id, 'main'); self.assertEqual(candidate.relation_kind, 'task')
        self.assertEqual(candidate_git.run('rev-parse', 'HEAD^').decode().strip(), outbound['baseline'])
        self.assertEqual((Path(candidate.working_dir) / 'new.bin').read_bytes(), b'\0B\xff\xfe')
        self.assertFalse((Path(candidate.working_dir) / 'delete.txt').exists())
        self.assertEqual(git.inspect()['fingerprint'], a_before['fingerprint'])
        self.assertEqual((self.project / '.git/index').read_bytes(), a_index)
        preview = json.loads(await self.bridge._rpc_projectMergePreview(candidate.id, candidate.id, 'main', 'returned-merge'))
        self.assertFalse(preview['blockers'], preview)
        candidate_git.merge(git.repository()['head'])
        self.assertIn(b'proof.txt', candidate_git.run('ls-files', '-u'))
        self.assertEqual(git.inspect()['fingerprint'], a_before['fingerprint'])
        self.assertEqual(self.calls, [])

    async def test_receipts_reject_replay_wrong_identity_and_keep_partial_unknown(self):
        self.repository()
        exported, result = await self.transfer()
        same = json.loads(await self.b._rpc_projectTransferFinish(result['id'], 'send-accept'))
        self.assertEqual(same['actual']['head'], result['actual']['head'])
        same = json.loads(self.b._rpc_projectTransferAccept(result['id'], 'send-accept', result['planFingerprint']))
        self.assertEqual(same['sessionId'], result['sessionId'])
        with self.assertRaises(ValueError):
            self.b._rpc_projectTransferAccept(result['id'], 'different-request', result['planFingerprint'])
        with self.assertRaises(ValueError): self.bridge._rpc_projectTransferStatus(result['id'])
        with patch.object(self.b, '_current_owner_id', return_value='intruder'):
            with self.assertRaises(ValueError): self.b._rpc_projectTransferStatus(result['id'])
        descriptor = {**exported['descriptor'], 'targetExecutor': 'C'}
        with self.assertRaisesRegex(ValueError, '节点不匹配'):
            await self.b._rpc_projectTransferPlan('wrong-node', json.dumps(descriptor), 'wrong', 'api')

    async def test_hash_corruption_never_publishes_session(self):
        self.repository()
        exported = json.loads(await self.bridge._rpc_projectTransferExport('main', 'export-corrupt', 'B'))
        plan = json.loads(await self.b._rpc_projectTransferPlan('plan-corrupt', json.dumps(exported['descriptor']), 'corrupt', 'api'))
        self.b._rpc_projectTransferAccept(plan['id'], 'accept-corrupt', plan['planFingerprint'])
        body = b'x' * exported['descriptor']['size']
        with self.assertRaises(ValueError):
            self.b._rpc_projectTransferChunk(plan['id'], 'accept-corrupt', 1, base64.b64encode(body).decode())
        self.b._rpc_projectTransferChunk(plan['id'], 'accept-corrupt', 0, base64.b64encode(body).decode())
        result = json.loads(await self.b._rpc_projectTransferFinish(plan['id'], 'accept-corrupt'))
        self.assertEqual(result['status'], 'unknown'); self.assertIn('哈希', result['notice'])
        self.assertIsNone(self.b._session_store.load(plan['sessionId']))
        self.assertFalse(Path(plan['root']).exists())

    async def test_frozen_backend_and_origin_are_rechecked(self):
        self.repository()
        _, received = await self.transfer()
        descriptor = json.loads(await self.b._rpc_projectTransferExport(received['sessionId'], 'return-check', 'A', 'return'))['descriptor']
        original = self.source.working_dir
        alternate = self.project.parent / 'replaced'; alternate.mkdir()
        self.source.working_dir = str(alternate)
        with self.assertRaises(ValueError):
            await self.bridge._rpc_projectTransferPlan('bad-return', json.dumps(descriptor), 'result', 'api')
        self.source.working_dir = original
        plan = json.loads(await self.bridge._rpc_projectTransferPlan('good-return', json.dumps(descriptor), 'result', 'api'))
        self.bridge._backend_configs[0].label = 'changed'
        with self.assertRaisesRegex(ValueError, 'Backend'):
            self.bridge._rpc_projectTransferAccept(plan['id'], 'bad-backend', plan['planFingerprint'])
        self.assertFalse(Path(plan['root']).exists())

    def test_snapshot_rejects_unsafe_paths_collisions_and_zip_payloads(self):
        row = {'path': 'ok', 'size': 0, 'sha256': hashlib.sha256(b'').hexdigest(), 'mode': '100644'}
        for name in ('../escape', '.git/config', '.env', 'id_rsa', 'folder\\file', 'file:stream', '/abs', 'CON', 'a./b'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_manifest([{**row, 'path': name}])
        for names in (('A', 'a'), ('a', 'a/b')):
            with self.assertRaises(ValueError): validate_manifest([{**row, 'path': name} for name in names])
        self.repository()
        archive = self.project.parent / 'bundle.zip'
        result = export_snapshot(TaskGit(str(self.project)), archive, 'refs/awu/transfers/codec')
        with zipfile.ZipFile(archive, 'a') as bundle: bundle.writestr('../escape', 'no')
        result.update(size=archive.stat().st_size, sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
        with self.assertRaisesRegex(ValueError, '非清单'): read_snapshot(archive, result)

    async def test_restart_marks_incomplete_import_unknown_without_replay(self):
        self.repository()
        _, result = await self.transfer()
        scope, row = self.b._transfer_row(result['id'])
        self.b._transfer_update(scope, row, status='importing')
        status = json.loads(self.b._rpc_projectTransferStatus(result['id']))
        self.assertEqual(status['status'], 'unknown')
        self.assertTrue(Path(status['root']).is_dir())

    async def test_partial_accept_failure_stays_unknown_and_recovery_is_read_only(self):
        self.repository()
        exported = json.loads(await self.bridge._rpc_projectTransferExport('main', 'stage-fail-export', 'B'))
        plan = json.loads(await self.b._rpc_projectTransferPlan('stage-fail-plan', json.dumps(exported['descriptor']), 'project', 'api'))
        scope, _ = self.b._transfer_row(plan['id'])
        archive = self.b._transfer_path(scope, plan['id']) / 'received.zip'
        archive.parent.mkdir(parents=True, exist_ok=True); archive.write_bytes(b'keep original')
        with self.assertRaises(FileExistsError):
            self.b._rpc_projectTransferAccept(plan['id'], 'stage-fail-accept', plan['planFingerprint'])
        result = json.loads(self.b._rpc_projectTransferFind(exported['id']))
        self.assertEqual(result['status'], 'unknown'); self.assertEqual(result['receipt']['status'], 'unknown')
        self.assertEqual(archive.read_bytes(), b'keep original')
        same = json.loads(self.b._rpc_projectTransferAccept(plan['id'], 'stage-fail-accept', plan['planFingerprint']))
        self.assertEqual(same['status'], 'unknown')
        with self.assertRaises(ValueError):
            self.b._rpc_projectTransferAccept(plan['id'], 'new-accept', plan['planFingerprint'])

    async def test_export_rejects_tracked_credentials_oversize_and_missing_git(self):
        (self.project / '.env').write_text('fixture-only')
        self.repository()
        exported = json.loads(await self.bridge._rpc_projectTransferExport('main', 'secret-export', 'B'))
        self.assertEqual(exported['status'], 'failed')
        (self.project / '.env').unlink()
        git = TaskGit(str(self.project)); git.run('add', '-u'); git.run('commit', '-m', 'remove credential fixture')
        with patch('src.backend.project_transfer_snapshot.MAX_TOTAL', 1):
            exported = json.loads(await self.bridge._rpc_projectTransferExport('main', 'oversize-export', 'B'))
            self.assertEqual(exported['status'], 'failed'); self.assertIn('预算', exported['notice'])
        with patch('src.backend.project_transfers.shutil.which', return_value=None):
            caps = json.loads(self.b._rpc_projectTransferCapabilities())
            self.assertFalse(caps['git'])

    async def test_clean_crlf_and_unicode_bytes_survive_without_filter_execution(self):
        (self.project / '.gitattributes').write_text('*.txt text\n*.bin -text\n')
        (self.project / 'proof.txt').write_bytes(b'first\r\nsecond\r\n')
        (self.project / '说明.bin').write_bytes(b'\xff\x00\x0d\x0a')
        git = self.repository()
        self.assertFalse(git.dirty())
        _, received = await self.transfer(prefix='crlf')
        root = Path(received['root'])
        self.assertEqual((root / 'proof.txt').read_bytes(), b'first\r\nsecond\r\n')
        self.assertEqual((root / '说明.bin').read_bytes(), b'\xff\x00\x0d\x0a')
        self.assertFalse(TaskGit(str(root)).dirty())
