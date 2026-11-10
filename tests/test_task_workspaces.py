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

    async def test_branch_copy_inherits_settings_and_current_files_with_independent_skills(self):
        from src.types import BackendType
        self.bridge._backend_configs[0].type = BackendType.CODEX_OFFICIAL
        self.source.model_override = 'test-model'; self.source.reasoning_effort = 'high'
        self.source.codex_connection_mode = 'node'; self.source.codex_thread_attached = True
        (self.project / '.gitignore').write_text('.agents/\nnode_modules/\n', encoding='utf-8')
        (self.project / 'removed.txt').write_text('remove in working copy')
        git = self.repository()
        (self.project / 'proof.txt').write_text('staged'); git.run('add', 'proof.txt')
        (self.project / 'proof.txt').write_text('current working copy')
        (self.project / 'new.txt').write_text('new file')
        (self.project / 'removed.txt').unlink()
        skill = self.project / '.agents/skills/local/SKILL.md'; skill.parent.mkdir(parents=True); skill.write_text('local skill')
        cache = self.project / 'node_modules/cache.js'; cache.parent.mkdir(); cache.write_text('cache')
        self.source.abilities = {'skills': ['local'], 'prompts': ['prompt-1'], 'constraints': 'ability rule',
            'kitToolsMode': 'off', 'workspaceToolsMode': 'off', 'unknownGrant': 'must not inherit'}
        self.source.constraints = 'source rules'; self.source.auto_continue = False
        self.source.max_continuations = 3; self.source.followup_suggestions_enabled = True
        self.source.followup_suggestions_config = {'backendId': 'api', 'timeoutSeconds': 30}
        defaults = json.loads(await self.bridge._rpc_taskWorkspaceInspect('main'))['defaults']
        self.assertTrue(defaults['inheritSource']); self.assertEqual(defaults['snapshotMode'], 'current')
        self.assertEqual(defaults['skills'], ['local']); self.assertTrue(defaults['skipPermissions'])
        before = git.inspect(); index = (self.project / '.git/index').read_bytes()
        plan = json.loads(await self.bridge._rpc_taskWorkspacePlan('main', 'copy-plan', json.dumps(defaults)))
        again = json.loads(await self.bridge._rpc_taskWorkspacePlan('main', 'copy-plan', json.dumps(defaults)))
        self.assertEqual(plan['id'], again['id'])
        self.assertEqual(set(plan['config']['includePaths']), {'proof.txt', 'new.txt', 'removed.txt'})
        self.assertEqual(len(plan['skillFiles']), 1)
        self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'copy-create', plan['planFingerprint'])
        await asyncio.gather(*list(self.bridge._task_jobs().values()))
        result = json.loads(self.bridge._rpc_taskWorkspaceStatus('main', plan['id']))
        self.assertEqual(result['status'], 'ready', result.get('notice'))
        child = self.bridge._session_store.load(result['sessionId']); root = Path(child.working_dir)
        self.assertEqual((root / 'proof.txt').read_text(), 'current working copy')
        self.assertEqual((root / 'new.txt').read_text(), 'new file'); self.assertFalse((root / 'removed.txt').exists())
        self.assertEqual((root / '.agents/skills/local/SKILL.md').read_text(), 'local skill')
        (root / '.agents/skills/local/SKILL.md').write_text('child edits')
        self.assertEqual(skill.read_text(), 'local skill'); self.assertFalse((root / 'node_modules').exists())
        self.assertEqual(git.inspect()['fingerprint'], before['fingerprint'])
        self.assertEqual((self.project / '.git/index').read_bytes(), index)
        self.assertEqual(child.abilities['prompts'], ['prompt-1']); self.assertNotIn('unknownGrant', child.abilities)
        self.assertEqual(child.constraints, 'source rules'); self.assertFalse(child.auto_continue)
        self.assertEqual(child.max_continuations, 3); self.assertTrue(child.followup_suggestions_enabled)
        self.assertEqual(child.followup_suggestions_config, self.source.followup_suggestions_config)
        self.assertEqual(child.messages, []); self.assertIsNone(child.agent_session_id)
        self.assertEqual(child.model_override, 'test-model'); self.assertEqual(child.reasoning_effort, 'high')
        self.assertEqual(child.codex_connection_mode, 'node'); self.assertFalse(child.codex_thread_attached)
        self.assertEqual(self.source.agent_session_id, 'main-native'); self.assertEqual(self.calls, [])
        with self.assertRaisesRegex(ValueError, '两层'):
            await self.bridge._rpc_taskWorkspacePlan(child.id, 'grandchild', json.dumps(defaults))
        with self.assertRaisesRegex(ValueError, '两层'):
            await self.bridge._rpc_taskWorkspaceInspect(child.id)

    async def test_inherited_configuration_and_skills_are_frozen_until_creation(self):
        (self.project / '.gitignore').write_text('.agents/\n'); self.repository()
        skill = self.project / '.agents/skills/local/SKILL.md'; skill.parent.mkdir(parents=True); skill.write_text('v1')
        raw = {'title': 'copy', 'inheritSource': True}
        plan = json.loads(await self.bridge._rpc_taskWorkspacePlan('main', 'copy-plan', json.dumps(raw)))
        self.source.constraints = 'changed after preview'
        with self.assertRaisesRegex(ValueError, '配置已变化'):
            self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'stale', plan['planFingerprint'])
        self.assertFalse(Path(plan['root']).exists())
        plan = json.loads(await self.bridge._rpc_taskWorkspacePlan('main', 'new-plan', json.dumps(raw)))
        skill.write_text('v2')
        self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'stale-skill', plan['planFingerprint'])
        await asyncio.gather(*list(self.bridge._task_jobs().values()))
        result = json.loads(self.bridge._rpc_taskWorkspaceStatus('main', plan['id']))
        self.assertEqual(result['status'], 'error'); self.assertIn('Skills 已变化', result['notice'])
        self.assertFalse(Path(plan['root']).exists())

    async def test_current_snapshot_cannot_silently_skip_blocked_files(self):
        self.repository(); (self.project / '.env').write_text('do not copy')
        with self.assertRaisesRegex(ValueError, '不可复制'):
            await self.bridge._rpc_taskWorkspacePlan('main', 'current', json.dumps({'title': 'copy', 'inheritSource': True}))
        plan = await self.plan('legacy-selected')
        self.assertFalse(plan['config']['inheritSource']); self.assertEqual(plan['config']['includePaths'], [])
        self.assertFalse(Path(plan['root']).exists())

    async def test_creation_rejects_source_that_became_a_child_after_preview(self):
        self.repository(); plan = await self.plan()
        self.source.parent_session_id = 'other'
        with self.assertRaisesRegex(ValueError, '两层'):
            self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'create', plan['planFingerprint'])
        self.assertFalse(Path(plan['root']).exists())

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
        self.assertEqual(view['reason'], 'not_git')
        self.assertEqual(view['notice'], '当前项目尚未启用 Git')
        self.assertNotIn('fatal:', json.dumps(view))
        git = TaskGit(str(self.project)); git.run('init')
        unborn = json.loads(await self.bridge._rpc_taskWorkspaceInspect('main'))
        self.assertEqual(unborn['reason'], 'no_commits')
        self.assertNotIn('fatal:', json.dumps(unborn))
        self.assertEqual(git.run('rev-parse', '--verify', '--quiet', 'HEAD', allowed=(0, 1)), b'')
        for extra in [{'node': 'other'}, {'agentSessionId': 'main-native'}, {'kitApprovalDelegation': True}]:
            with self.assertRaises(ValueError):
                await self.bridge._rpc_taskWorkspacePlan('main', 'invalid', json.dumps({'title': 'task', **extra}))

    async def test_inspection_error_does_not_instruct_git_initialization(self):
        with patch.object(TaskGit, 'inspect', side_effect=OSError('fixture permission denied')):
            view = json.loads(await self.bridge._rpc_taskWorkspaceInspect('main'))
        self.assertEqual(view['reason'], 'inspection_failed')
        self.assertEqual(view['notice'], '暂时无法检查项目')
        self.assertEqual(view['detail'], 'fixture permission denied')
        self.assertNotIn('初始化', view['preparation'])
        self.assertFalse((self.project / '.git').exists())

    async def test_discard_preview_is_durable_idempotent_and_never_touches_git(self):
        git = self.repository(); plan = await self.plan()
        before = git.inspect()
        result = json.loads(self.bridge._rpc_taskWorkspaceDiscardPreview('main', plan['id'], 'discard', plan['planFingerprint']))
        self.assertEqual(result['status'], 'discarded')
        self.assertEqual(result['discardReceipt']['status'], 'succeeded')
        self.assertFalse(Path(plan['root']).exists())
        self.assertIsNone(self.bridge._session_store.load(plan['sessionId']))
        self.assertEqual(git.inspect()['fingerprint'], before['fingerprint'])
        self.assertEqual(self.calls, [])
        self.assertEqual(json.loads(self.bridge._rpc_taskWorkspaceDiscardPreview('main', plan['id'], 'discard', plan['planFingerprint'])), result)
        self.assertEqual((await self.plan())['status'], 'discarded')
        self.assertEqual(json.loads(await self.bridge._rpc_sessionCollaborationList('main', 'workspace'))['items'], [])
        with self.assertRaises(ValueError):
            self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], 'late-create', plan['planFingerprint'])
        with self.assertRaises(ValueError):
            self.bridge._rpc_taskWorkspaceDiscardPreview('main', plan['id'], 'discard', 'different-intent')

    async def test_discard_rejects_wrong_identity_fingerprint_and_started_work(self):
        self.repository(); plan = await self.plan()
        discard = self.bridge._rpc_taskWorkspaceDiscardPreview
        with self.assertRaises(PermissionError):
            discard('missing-session', plan['id'], 'wrong-owner', plan['planFingerprint'])
        with self.assertRaises(ValueError):
            discard('main', plan['id'], 'wrong-plan', 'wrong-fingerprint')
        for status in ('creating', 'ready', 'unknown', 'error', 'archived', 'cleaning', 'cleaned'):
            plan = self.bridge._task_update(self.scope, plan, status=status)
            with self.subTest(status=status), self.assertRaises(ValueError):
                discard('main', plan['id'], 'discard-' + status, plan['planFingerprint'])
        plan = self.bridge._task_update(self.scope, plan, status='preview', requestId='creation-already-accepted')
        with self.assertRaises(ValueError):
            discard('main', plan['id'], 'discard-stale-preview', plan['planFingerprint'])
        self.assertEqual(self.bridge._collaboration_store().read(self.scope, 'workspace', plan['id']), plan)
        self.assertFalse(Path(plan['root']).exists())
