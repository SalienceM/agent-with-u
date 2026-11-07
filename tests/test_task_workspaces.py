import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from tests.test_role_reviews import ReviewTests
from src.backend.task_git import TaskGit


class TaskWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    setUp = ReviewTests.setUp
    role = ReviewTests.role
    answer = ReviewTests.answer

    async def asyncTearDown(self):
        await asyncio.gather(*list(self.bridge._task_jobs().values()), return_exceptions=True)
        await ReviewTests.asyncTearDown(self)

    def repository(self):
        git = TaskGit(str(self.project)); git.run('init'); git.run('add', '.'); git.run('commit', '-m', 'baseline')
        return git

    async def plan(self, request='plan'):
        return json.loads(await self.bridge._rpc_taskWorkspacePlan('main', request, json.dumps({'title': '独立任务', 'goal': '实现功能', 'backendId': 'api'})))

    async def test_inspect_and_preview_do_not_create_or_run_then_publish_verified_session(self):
        git = self.repository()
        view = json.loads(await self.bridge._rpc_taskWorkspaceInspect('main')); self.assertEqual(view['status'], 'ready')
        plan = await self.plan()
        self.assertFalse(Path(plan['root']).exists()); self.assertEqual(self.calls, [])
        self.assertEqual(await self.plan(), plan)
        initial = json.loads(self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'create', plan['planFingerprint']))
        self.assertEqual(initial['status'], 'creating')
        await asyncio.gather(*list(self.bridge._task_jobs().values()))
        final = json.loads(self.bridge._rpc_taskWorkspaceStatus('main', plan['id']))
        self.assertEqual(final['status'], 'ready'); self.assertEqual(final['receipt']['status'], 'succeeded')
        child = self.bridge._session_store.load(final['sessionId'])
        self.assertEqual(child.parent_session_id, 'main'); self.assertEqual(child.workspace_id, plan['id'])
        self.assertEqual(child.relation_kind, 'task'); self.assertIsNone(child.agent_session_id)
        self.assertFalse(child.skip_permissions); self.assertFalse(child.followup_suggestions_enabled)
        self.assertNotEqual(child.working_dir, self.source.working_dir)
        self.assertEqual(TaskGit(child.working_dir).repository()['commonDir'], git.repository()['commonDir'])
        self.assertEqual(json.loads(self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'create', plan['planFingerprint']))['status'], 'ready')
        self.bridge._check_chat_turn_allowed = Mock(); self.bridge._start_chat_turn = Mock()
        first = json.loads(self.bridge._rpc_taskWorkspaceStart('main', plan['id'], 'start'))
        self.assertEqual(first['status'], 'succeeded')
        self.bridge._rpc_taskWorkspaceStart('main', plan['id'], 'start')
        self.bridge._start_chat_turn.assert_called_once()
        payload = json.loads(self.bridge._start_chat_turn.call_args.args[0]); self.assertEqual(payload['sessionId'], child.id)
        self.assertNotIn('kitApprovalDelegation', payload)

    async def test_failed_publication_keeps_directory_and_restart_does_not_replay(self):
        self.repository(); plan = await self.plan()
        save = self.bridge._session_store.save
        def fail(session, **kwargs):
            if session.relation_kind == 'task': raise OSError('disk full')
            return save(session, **kwargs)
        with patch.object(self.bridge._session_store, 'save', side_effect=fail):
            self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'create', plan['planFingerprint'])
            await asyncio.gather(*list(self.bridge._task_jobs().values()))
        result = json.loads(self.bridge._rpc_taskWorkspaceStatus('main', plan['id']))
        self.assertNotEqual(result['status'], 'ready'); self.assertTrue(Path(plan['root']).exists())
        self.assertIsNone(self.bridge._session_store.load(plan['sessionId']))
        self.bridge._task_workspace_jobs = {}
        self.assertEqual(json.loads(self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'create', plan['planFingerprint']))['status'], result['status'])

    async def test_no_repository_and_authority_fields_fail_without_initializing(self):
        view = json.loads(await self.bridge._rpc_taskWorkspaceInspect('main'))
        self.assertEqual(view['status'], 'unavailable'); self.assertFalse((self.project / '.git').exists())
        for extra in [{'node': 'other'}, {'agentSessionId': 'main-native'}, {'kitApprovalDelegation': True}]:
            with self.assertRaises(ValueError):
                await self.bridge._rpc_taskWorkspacePlan('main', 'invalid', json.dumps({'title': 'task', **extra}))
