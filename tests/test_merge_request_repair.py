"""仅 fake Backend + 隔离真实 Git；不启动生产模型。"""
import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import Mock

from tests.test_project_merges import ProjectMergeTests
from src.backend.session_collaboration_store import CollaborationError
from src.backend.task_git import TaskGit
from src.types import ChatMessage


class MergeRequestRepairTests(unittest.IsolatedAsyncioTestCase):
    setUp = ProjectMergeTests.setUp
    identity = ProjectMergeTests.identity
    send_frame = ProjectMergeTests.send_frame
    role = ProjectMergeTests.role
    answer = ProjectMergeTests.answer
    child = ProjectMergeTests.child
    commit = ProjectMergeTests.commit
    preview = ProjectMergeTests.preview
    prepare = ProjectMergeTests.prepare

    async def asyncTearDown(self):
        await self.settle()
        await ProjectMergeTests.asyncTearDown(self)

    async def candidate(self, conflict=False):
        child = await self.child()
        self.commit(child, 'shared.txt' if conflict else 'feature.txt', 'branch')
        if conflict:
            self.commit(self.bridge._collaboration_session('main'), 'shared.txt', 'main')
        row = await self.prepare(await self.preview(child))
        self.bridge._check_chat_turn_allowed = Mock()
        self.bridge._permission_gates = {}
        self.bridge._permission_payloads = {}
        from src.backend.bridge_ws import BridgeWS
        self.bridge._rpc_workbenchPermissionGet = BridgeWS._rpc_workbenchPermissionGet.__get__(self.bridge)
        self.bridge._rpc_grantPermission = BridgeWS._rpc_grantPermission.__get__(self.bridge)
        return row

    async def settle(self):
        for _ in range(5):
            await asyncio.sleep(0)
            jobs = list(self.bridge._merge_repair_jobs().values())
            if jobs:
                await asyncio.gather(*jobs, return_exceptions=True)

    def read(self, row):
        return json.loads(self.bridge._rpc_projectMergeRepairRead('main', row['id']))

    async def test_conflict_repair_commits_and_verifies_without_frontend(self):
        row = await self.candidate(True)
        source_before = TaskGit(row['source']['root']).inspect()['head']
        target_before = self.git.inspect()['head']
        async def model():
            def resolve():
                git = TaskGit(row['integration']['root'])
                (Path(git.root) / 'shared.txt').write_text('main + branch')
                git.run('add', '--', 'shared.txt'); git.run('commit', '-m', 'resolve conflict')
            await asyncio.to_thread(resolve)
            return True
        self.bridge._start_chat_turn = Mock(side_effect=lambda _: asyncio.create_task(model()))
        accepted = json.loads(self.bridge._rpc_projectMergeStart('main', row['id'], 'repair'))
        self.assertEqual(accepted['status'], 'succeeded')
        self.assertEqual(self.read(row)['repair']['status'], 'running')
        again = json.loads(self.bridge._rpc_projectMergeStart('main', row['id'], 'repair'))
        self.assertEqual(again, accepted)
        with self.assertRaises(CollaborationError):
            self.bridge._rpc_projectMergeStart('main', row['id'], 'duplicate')
        await self.settle()
        current = json.loads(await self.bridge._rpc_projectMergeStatus('main', row['id']))
        self.assertEqual(current['repair']['status'], 'ready', current)
        self.assertEqual(current['status'], 'candidate')
        self.assertEqual(current['verification']['head'], current['candidate'])
        self.assertEqual(self.git.inspect()['head'], target_before)
        self.assertEqual(TaskGit(row['source']['root']).inspect()['head'], source_before)
        self.bridge._start_chat_turn.assert_called_once()

    async def test_failed_start_can_explicitly_retry_same_operation(self):
        row = await self.candidate()
        self.bridge._start_chat_turn = Mock(side_effect=ValueError('runtime unavailable'))
        result = json.loads(self.bridge._rpc_projectMergeStart('main', row['id'], 'first'))
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(self.read(row)['repair']['status'], 'failed')
        self.bridge._rpc_projectMergeStart('main', row['id'], 'first')
        self.bridge._start_chat_turn.assert_called_once()
        async def fails(): return False
        self.bridge._start_chat_turn = Mock(side_effect=lambda _: asyncio.create_task(fails()))
        self.bridge._rpc_projectMergeStart('main', row['id'], 'second')
        await self.settle()
        self.assertEqual(self.read(row)['repair']['status'], 'failed')
        self.assertTrue(self.read(row)['repair']['canStart'])

    async def test_incomplete_repair_and_native_unknown_do_not_claim_success(self):
        row = await self.candidate(True)
        async def incomplete(): return True
        self.bridge._start_chat_turn = Mock(side_effect=lambda _: asyncio.create_task(incomplete()))
        self.bridge._rpc_projectMergeStart('main', row['id'], 'incomplete')
        await self.settle()
        self.assertEqual(self.read(row)['repair']['status'], 'needs_attention')
        self.bridge._has_native_session_activity = lambda sid: sid == row['integration']['sessionId']
        self.assertEqual(self.read(row)['repair']['status'], 'unknown')
        self.assertFalse(self.read(row)['repair']['canStart'])
        with self.assertRaises(CollaborationError):
            self.bridge._rpc_projectMergeStart('main', row['id'], 'unsafe-retry')

    async def test_scoped_bounded_read_and_permission_never_skip(self):
        row = await self.candidate()
        child = self.bridge._merge_repair_child(row)
        child.messages = [ChatMessage(id=str(i), role='assistant', content='x' * 25000) for i in range(24)]
        gate = asyncio.get_running_loop().create_future()
        self.bridge._permission_gates[child.id] = gate
        self.bridge._permission_payloads[child.id] = {'sessionId': child.id, 'requestId': 'permit', 'messageId': 'm', 'tools': []}
        self.bridge._permission_gate_ids = {child.id: 'permit'}
        self.bridge._skip_rest_sessions = set()
        snapshot = self.read(row)
        self.assertLessEqual(sum(len(m['content']) for m in snapshot['messages']), 48000)
        self.assertTrue(snapshot['truncated'])
        self.assertEqual(snapshot['permission']['requestId'], 'permit')
        with self.assertRaises(ValueError):
            self.bridge._rpc_projectMergeRepairPermission('main', row['id'], 'old-id', True)
        with self.assertRaises(CollaborationError):
            self.bridge._rpc_projectMergeRepairPermission(child.id, row['id'], 'permit', True)
        related = json.loads(self.bridge._rpc_projectMergeRepairRead(child.id, row['id']))
        self.assertIsNone(related['permission'])
        self.bridge._rpc_projectMergeRepairPermission('main', row['id'], 'permit', True)
        self.assertTrue(gate.result())
        self.assertEqual(self.bridge._skip_rest_sessions, set())
        child.working_dir = str(self.project)
        with self.assertRaises(CollaborationError): self.read(row)

    async def test_restart_read_never_replays_and_legacy_can_resume(self):
        row = await self.candidate(True)
        self.bridge._merge_update(self.scope, row, startRequestId='old', repair={'requestId': 'old', 'status': 'running'})
        self.bridge._start_chat_turn = Mock()
        self.assertEqual(self.read(row)['repair']['status'], 'needs_attention')
        self.assertTrue(self.read(row)['repair']['canStart'])
        self.bridge._start_chat_turn.assert_not_called()
