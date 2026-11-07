import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

from tests.test_role_reviews import ReviewTests
from src.backend.task_git import TaskGit
from src.backend.engine_workbench import WorkspaceIdentity
from src.backend.session_collaboration_store import CollaborationError


class ProjectMergeTests(unittest.IsolatedAsyncioTestCase):
    role = ReviewTests.role
    answer = ReviewTests.answer

    def setUp(self):
        ReviewTests.setUp(self)
        self.bridge._workbench_identity = self.identity
        fixture = self
        class Peer:
            async def send(self, raw): await fixture.send_frame(raw)
        self.peer = Peer()
        self.bridge._clients = {self.peer}
        self.bridge._owner_id_for_client = lambda client: 'tester'
        self.bridge._current_request_client = lambda: self.peer
        self.bridge._session_destroy_busy_reason = lambda sid: ''
        self.clean = True
        self.events = []
        self.git = TaskGit(str(self.project))
        self.git.run('init'); self.git.run('add', '.'); self.git.run('commit', '-m', 'base')

    def identity(self, sid, expected=None):
        source = self.bridge._collaboration_session(sid)
        identity = WorkspaceIdentity('tester', 'test-node', sid, source.working_dir, 'revision')
        if expected is not None: identity.require_match(expected)
        return identity

    async def send_frame(self, raw):
        event = json.loads(raw); self.events.append(event)
        if event['event'] == 'projectBufferFreeze':
            self.bridge._rpc_projectBufferReply(event['data']['probeId'], self.clean)

    async def asyncTearDown(self):
        await asyncio.gather(*list(self.bridge._merge_jobs().values()), *list(self.bridge._task_jobs().values()), return_exceptions=True)
        await ReviewTests.asyncTearDown(self)

    async def child(self, name='child'):
        plan = json.loads(await self.bridge._rpc_taskWorkspacePlan('main', name + '-plan', json.dumps({'title': name})))
        self.bridge._rpc_taskWorkspaceCreate('main', plan['id'], name + '-create', plan['planFingerprint'])
        await asyncio.gather(*list(self.bridge._task_jobs().values()))
        return self.bridge._session_store.load(plan['sessionId'])

    def commit(self, session, name, text):
        (Path(session.working_dir) / name).write_text(text, encoding='utf-8')
        git = TaskGit(session.working_dir); git.run('add', '--', name); git.run('commit', '-m', 'change')
        return git

    async def preview(self, child, request='preview'):
        return json.loads(await self.bridge._rpc_projectMergePreview('main', child.id, 'main', request))

    async def prepare(self, plan):
        self.bridge._rpc_projectMergePrepare('main', plan['id'], plan['id'] + '-prepare', plan['planFingerprint'])
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        return json.loads(await self.bridge._rpc_projectMergeStatus('main', plan['id']))

    async def apply(self, row):
        self.bridge._rpc_projectMergeApply('main', row['id'], 'apply-' + row['id'], row['candidate'], row['planFingerprint'])
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        return json.loads(await self.bridge._rpc_projectMergeStatus('main', row['id']))

    async def test_merge_prepares_separate_candidate_then_ff_once_and_cleanup_only_owned(self):
        child = await self.child()
        self.commit(child, 'feature.txt', 'independent output')
        original = self.git.inspect()['head']
        plan = await self.preview(child)
        self.assertEqual(plan['status'], 'preview')
        candidate = await self.prepare(plan)
        self.assertEqual(candidate['status'], 'candidate')
        self.assertEqual(self.git.inspect()['head'], original)
        self.assertFalse((self.project / 'feature.txt').exists())
        with self.assertRaises(CollaborationError): await self.apply(candidate)
        candidate = json.loads(await self.bridge._rpc_projectMergeVerify('main', plan['id']))
        final = await self.apply(candidate)
        self.assertEqual(final['status'], 'succeeded', final)
        self.assertEqual(final['finalHead'], self.git.inspect()['head'])
        self.assertEqual((self.project / 'feature.txt').read_text(), 'independent output')
        again = await self.apply(candidate)
        self.assertEqual(again['finalHead'], final['finalHead'])
        self.assertEqual(len([e for e in self.events if e['event'] == 'projectBufferFreeze']), 1)
        self.bridge._rpc_taskWorkspaceArchive('main', child.workspace_id, 'archive')
        cleanup = json.loads(await self.bridge._rpc_taskWorkspaceCleanupPlan('main', child.workspace_id))
        self.bridge._rpc_taskWorkspaceCleanup('main', child.workspace_id, 'cleanup', cleanup['cleanupPlan']['fingerprint'])
        await asyncio.gather(*list(self.bridge._task_jobs().values()))
        self.assertEqual(json.loads(self.bridge._rpc_taskWorkspaceStatus('main', child.workspace_id))['status'], 'cleaned')
        self.assertFalse(Path(child.working_dir).exists())
        self.assertTrue(self.bridge._session_store.load(child.id))
        self.assertEqual((self.project / 'feature.txt').read_text(), 'independent output')
        self.assertFalse(self.bridge._collaboration_store().project_gates('test-node'))

    async def test_conflict_keeps_target_and_requires_actual_resolved_commit(self):
        child = await self.child()
        self.commit(child, 'proof.txt', 'source answer')
        self.commit(self.source, 'proof.txt', 'target answer')
        original = self.git.inspect()['head']
        row = await self.prepare(await self.preview(child))
        self.assertEqual(row['status'], 'conflict', row)
        self.assertEqual(row['integration']['conflicts'], ['proof.txt'])
        self.assertEqual(self.git.inspect()['head'], original)
        with self.assertRaises(CollaborationError): await self.bridge._rpc_projectMergeVerify('main', row['id'])
        integration = self.bridge._session_store.load(row['integration']['sessionId'])
        self.commit(integration, 'proof.txt', 'resolved both answers')
        row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        final = await self.apply(row)
        self.assertEqual(final['status'], 'succeeded', final)
        self.assertEqual((self.project / 'proof.txt').read_text(), 'resolved both answers')

    async def test_dirty_busy_unsaved_unknown_and_external_stale_states_refuse(self):
        child = await self.child()
        self.commit(child, 'feature.txt', 'source')
        (Path(child.working_dir) / 'dirty.txt').write_text('keep')
        blocked = await self.preview(child, 'dirty')
        self.assertEqual(blocked['status'], 'blocked')
        (Path(child.working_dir) / 'dirty.txt').unlink()
        self.bridge._session_destroy_busy_reason = lambda sid: 'terminal active' if sid == 'main' else ''
        self.assertIn('terminal active', (await self.preview(child, 'busy'))['blockers'])
        self.bridge._session_destroy_busy_reason = lambda sid: ''
        row = await self.prepare(await self.preview(child))
        row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        self.clean = False
        final = await self.apply(row)
        self.assertEqual(final['status'], 'error'); self.assertFalse((self.project / 'feature.txt').exists())
        self.assertFalse(self.bridge._collaboration_store().project_gates('test-node'))
        self.clean = True
        row = await self.prepare(await self.preview(child, 'stale'))
        row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        self.commit(self.source, 'external.txt', 'preserve external commit')
        final = await self.apply(row)
        self.assertEqual(final['status'], 'error', final)
        self.assertFalse((self.project / 'feature.txt').exists())
        self.assertFalse(self.bridge._collaboration_store().project_gates('test-node'))

    async def test_lost_final_receipt_reconciles_oid_without_reapplying(self):
        child = await self.child(); self.commit(child, 'feature.txt', 'output')
        row = await self.prepare(await self.preview(child))
        row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        update = self.bridge._merge_update
        def lost(scope, row, **changes):
            if changes.get('status') == 'succeeded': raise OSError('lost persistence')
            return update(scope, row, **changes)
        with patch.object(self.bridge, '_merge_update', side_effect=lost):
            self.bridge._rpc_projectMergeApply('main', row['id'], 'apply-preview', row['candidate'], row['planFingerprint'])
            await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        self.assertTrue(self.bridge._collaboration_store().project_gates('test-node'))
        with self.assertRaises(CollaborationError): self.bridge._project_check_write(session_id='main')
        # 模拟进程内登记丢失，只按持久回执和磁盘核对。
        self.bridge._project_writes['reservations'] = {}
        final = json.loads(await self.bridge._rpc_projectMergeStatus('main', row['id']))
        self.assertEqual(final['status'], 'succeeded', final)
        self.assertEqual(self.git.inspect()['head'], row['candidate'])
        self.assertFalse(self.bridge._collaboration_store().project_gates('test-node'))

    async def test_archive_keeps_unmerged_dirty_and_cancel_never_deletes(self):
        child = await self.child(); self.commit(child, 'feature.txt', 'unmerged')
        self.bridge._rpc_taskWorkspaceArchive('main', child.workspace_id, 'archive')
        with self.assertRaises(CollaborationError): await self.bridge._rpc_taskWorkspaceCleanupPlan('main', child.workspace_id)
        self.assertTrue(Path(child.working_dir).exists())
        row = await self.prepare(await self.preview(child))
        cancelled = json.loads(self.bridge._rpc_projectMergeCancel('main', row['id'], 'cancel'))
        self.assertEqual(cancelled['status'], 'cancelled')
        self.assertTrue(Path(row['integration']['root']).exists())

    async def test_gate_rejects_new_writers_and_retains_unknown_buffer(self):
        from src.backend.workbench_windows import WINDOW_REQUEST
        token = WINDOW_REQUEST.set({'clientId': 'client', 'windowId': 'window'})
        try:
            self.bridge._rpc_projectBufferState('main', json.dumps(self.identity('main').to_dict()), True, True)
            with self.assertRaises(CollaborationError): await self.bridge._project_reserve('main', 'op')
            self.bridge._rpc_projectBufferState('main', json.dumps(self.identity('main').to_dict()), True, False)
            self.bridge._clients = set()
            self.assertTrue(self.bridge._project_activity(str(self.project)))
            self.bridge._clients = {self.peer}
            lease = await self.bridge._project_reserve('main', 'op')
            with self.assertRaises(CollaborationError): self.bridge._project_check_write(session_id='main')
            await self.bridge._project_release(lease)
            self.bridge._project_check_write(session_id='main')
        finally: WINDOW_REQUEST.reset(token)

    async def test_chat_uses_discovered_ids_and_independent_frozen_approval(self):
        from src.backend.workspace_tools import ChatWorkspaceTools
        child = await self.child('same'); other = await self.child('other')
        other.title = child.title; self.bridge._session_store.save(other, async_=False)
        self.commit(child, 'feature.txt', 'output')
        tool = ChatWorkspaceTools(self.bridge)
        token = tool.issue('main', 'answer', self.peer, skip_permissions=True)
        ambiguous = await tool.call(token, {'action': 'merge_preview', 'sourceSession': 'same', 'targetSession': 'main', 'requestId': 'ambiguous'})
        self.assertEqual(ambiguous['status'], 'ambiguous')
        plan = await tool.call(token, {'action': 'merge_preview', 'sourceSession': child.id, 'targetSession': 'main', 'requestId': 'from-chat'})
        self.bridge._await_permission_grant = AsyncMock(return_value=True)
        prepared = await tool.call(token, {'action': 'merge_prepare', 'operationId': plan['id'], 'requestId': 'chat-prepare'})
        self.assertEqual(prepared['status'], 'preparing', prepared)
        self.assertFalse(self.bridge._await_permission_grant.call_args.kwargs['allow_skip'])
        self.assertTrue(self.bridge._await_permission_grant.call_args.kwargs['require_request_id'])
        self.assertIn(plan['planFingerprint'], self.bridge._await_permission_grant.call_args.args[2][0].input)
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        await tool.call(token, {'action': 'merge_prepare', 'operationId': plan['id'], 'requestId': 'chat-prepare'})
        self.bridge._await_permission_grant.assert_awaited_once()
        await tool.call(token, {'action': 'merge_verify', 'operationId': plan['id']})
        self.bridge._await_permission_grant.reset_mock()
        await tool.call(token, {'action': 'merge_apply', 'operationId': plan['id'], 'requestId': 'chat-apply'})
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        final = await tool.call(token, {'action': 'merge_status', 'operationId': plan['id']})
        self.assertEqual(final['status'], 'succeeded', final)
        self.bridge._await_permission_grant.assert_awaited_once()

    async def test_two_tasks_questions_reviews_fixed_dissent_and_final_merge(self):
        from src.backend.user_interactions import UserInteractionRequest
        from src.types import ChatMessage
        children = [await self.child('task-a'), await self.child('task-b')]
        registry = self.bridge._user_interactions()
        requests = [UserInteractionRequest(child.id, 'answer', 'native-' + child.id,
            questions=[{'id': 'choice', 'question': '确认输出要求', 'options': [{'label': '保留双方成果'}]}]) for child in children]
        pending = [asyncio.create_task(registry.ask(self.scope, request, skip=True)) for request in requests]
        for _ in range(200):
            if len(registry.pending) == 2: break
            await asyncio.sleep(.01)
        self.assertEqual(len(registry.pending), 2)
        for key, entry in list(registry.pending.items()):
            await registry.respond(self.scope, entry['row']['sessionId'], key, {'kind': 'answers', 'answers': {'choice': ['保留双方成果']}})
        self.assertEqual(len(await asyncio.gather(*pending)), 2)
        for request in requests: await request.delivered(True)
        await asyncio.gather(*(asyncio.to_thread(self.commit, child, f'feature-{i}.txt', f'output {i}') for i, child in enumerate(children)))
        batch = ReviewTests.submit(self)
        await ReviewTests.wait(self)
        report = self.bridge._collaboration_store().read(self.scope, 'report', batch['reports'][1])
        reference = json.loads(self.bridge._rpc_reviewReference('main', report['id'], report['revision']))
        self.assertEqual(reference['claims'][0]['stance'], 'disagree')
        self.source.messages.append(ChatMessage('revision-request', 'user', '根据固定异议修订：' + json.dumps(reference, ensure_ascii=False)))
        self.commit(children[0], 'feature-0.txt', 'revised after dissent')
        for index, child in enumerate(children):
            row = await self.prepare(await self.preview(child, 'merge-' + str(index)))
            row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
            self.assertEqual((await self.apply(row))['status'], 'succeeded')
        self.assertEqual((self.project / 'feature-0.txt').read_text(), 'revised after dissent')
        self.assertEqual((self.project / 'feature-1.txt').read_text(), 'output 1')
        self.assertNotEqual(children[0].working_dir, children[1].working_dir)
        self.assertIsNone(children[0].agent_session_id)
        self.assertEqual(self.source.agent_session_id, 'main-native')

    async def test_explicit_integration_start_does_not_inherit_delegation_and_failed_start_preserves(self):
        child = await self.child(); self.commit(child, 'feature.txt', 'output')
        row = await self.prepare(await self.preview(child))
        self.bridge._check_chat_turn_allowed = Mock(); self.bridge._start_chat_turn = Mock(side_effect=ValueError('runtime unavailable'))
        result = json.loads(self.bridge._rpc_projectMergeStart('main', row['id'], 'start-repair'))
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(Path(row['integration']['root']).exists())
        self.assertFalse((self.project / 'feature.txt').exists())
        self.bridge._rpc_projectMergeStart('main', row['id'], 'start-repair')
        self.bridge._start_chat_turn.assert_called_once()
        payload = json.loads(self.bridge._start_chat_turn.call_args.args[0])
        self.assertEqual(payload['sessionId'], row['integration']['sessionId'])
        self.assertNotIn('kitApprovalDelegation', payload)


if __name__ == '__main__': unittest.main()
