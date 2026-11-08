import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

from tests.test_role_reviews import ReviewTests
from src.backend.task_git import TaskGit
from src.backend.engine_workbench import WorkspaceIdentity
from src.backend.session_collaboration_store import CollaborationError
from src.backend.session_collaboration_store import CollaborationScope
from src.backend.workspace_tools import ChatWorkspaceTools, validate_args
from src.backend.workbench_windows import WINDOW_REQUEST


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
        self.bridge._rpc_projectMergePrepare(plan['sourceSessionId'], plan['id'], plan['id'] + '-prepare', plan['planFingerprint'])
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        return json.loads(await self.bridge._rpc_projectMergeStatus(plan['sourceSessionId'], plan['id']))

    async def apply(self, row):
        self.bridge._rpc_projectMergeApply(row['sourceSessionId'], row['id'], 'apply-' + row['id'], row['candidate'], row['planFingerprint'])
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        return json.loads(await self.bridge._rpc_projectMergeStatus(row['sourceSessionId'], row['id']))

    async def test_merge_sync_back_and_continue_same_branch(self):
        child = await self.child()
        child_git = self.commit(child, 'b.txt', 'first round')
        child_head = child_git.inspect()['head']
        plan = json.loads(await self.bridge._rpc_projectMergePreview(child.id, child.id, 'main', 'round-one'))
        await self.prepare(plan)
        verified = json.loads(await self.bridge._rpc_projectMergeVerify(child.id, plan['id']))
        final = await self.apply(verified)
        self.assertEqual(final['status'], 'succeeded', final)
        self.assertEqual(child_git.inspect()['head'], child_head)
        sync = json.loads(await self.bridge._rpc_projectMergePreview(child.id, 'main', child.id, 'sync-one'))
        self.assertEqual(sync['direction'], 'sync_main')
        self.assertTrue(sync['fastForward'])
        candidate = await self.prepare(sync)
        self.assertEqual(candidate['candidate'], final['finalHead'])  # 不制造反向合并提交。
        self.assertEqual(child_git.inspect()['head'], child_head)
        verified = json.loads(await self.bridge._rpc_projectMergeVerify(child.id, sync['id']))
        synced = await self.apply(verified)
        self.assertEqual(synced['status'], 'succeeded', synced)
        self.assertEqual(child_git.inspect()['head'], final['finalHead'])
        self.assertEqual(child_git.inspect()['branch'], plan['source']['branch'])
        self.commit(child, 'b.txt', 'second round')
        second = await self.preview(child, 'round-two')
        self.assertEqual((await self.prepare(second))['status'], 'candidate')

    async def test_sync_divergence_conflicts_and_dirty_work_remain_in_branch(self):
        child = await self.child()
        self.commit(child, 'shared.txt', 'branch edit')
        self.commit(self.bridge._collaboration_session('main'), 'shared.txt', 'main edit')
        before = TaskGit(child.working_dir).inspect()
        sync = json.loads(await self.bridge._rpc_projectMergePreview(child.id, 'main', child.id, 'sync-conflict'))
        self.assertFalse(sync['fastForward'])
        prepared = await self.prepare(sync)
        self.assertEqual(prepared['status'], 'conflict', prepared)
        self.assertEqual(TaskGit(child.working_dir).inspect()['head'], before['head'])
        self.assertEqual((Path(child.working_dir) / 'shared.txt').read_text(), 'branch edit')
        (Path(child.working_dir) / 'draft.txt').write_text('unsaved work')
        dirty = json.loads(await self.bridge._rpc_projectMergePreview(child.id, 'main', child.id, 'sync-dirty'))
        self.assertEqual(dirty['status'], 'blocked')
        with self.assertRaises(CollaborationError): await self.prepare(dirty)
        self.assertEqual((Path(child.working_dir) / 'draft.txt').read_text(), 'unsaved work')

    async def test_branch_graph_reads_real_parents_and_counts_without_writes(self):
        child = await self.child()
        child_git = self.commit(child, 'b.txt', 'branch edit')
        self.commit(self.bridge._collaboration_session('main'), 'main.txt', 'main edit')
        before = (self.git.inspect()['fingerprint'], child_git.inspect()['fingerprint'])
        graph = json.loads(await self.bridge._rpc_projectBranchGraph(child.id))
        self.assertEqual(len(graph['branches']), 2)
        branch = next(row for row in graph['branches'] if row['sessionId'] == child.id)
        self.assertEqual((branch['ahead'], branch['behind']), (1, 1))
        commit = next(row for row in graph['commits'] if row['hash'] == branch['head'])
        self.assertEqual(commit['parents'], child_git.run('rev-parse', 'HEAD^').decode().split())
        self.assertEqual(before, (self.git.inspect()['fingerprint'], child_git.inspect()['fingerprint']))
        limited = json.loads(await self.bridge._rpc_projectBranchGraph(child.id, 1))
        self.assertEqual(len(limited['commits']), 1)
        self.assertTrue(limited['hasMore'])
        with self.assertRaises(CollaborationError): await self.bridge._rpc_projectBranchGraph(child.id, 201)

    async def test_sibling_merge_must_repreview_after_main_advances(self):
        first, second = await self.child('one'), await self.child('two')
        self.commit(first, 'one.txt', 'one'); self.commit(second, 'two.txt', 'two')
        plan_one, plan_two = await self.preview(first, 'one'), await self.preview(second, 'two')
        await self.prepare(plan_one); await self.prepare(plan_two)
        one = json.loads(await self.bridge._rpc_projectMergeVerify('main', 'one'))
        two = json.loads(await self.bridge._rpc_projectMergeVerify('main', 'two'))
        self.assertEqual((await self.apply(one))['status'], 'succeeded')
        self.assertNotEqual((await self.apply(two))['status'], 'succeeded')
        self.assertTrue((self.project / 'one.txt').exists())
        self.assertFalse((self.project / 'two.txt').exists())
        fresh = await self.preview(second, 'two-fresh')
        await self.prepare(fresh)
        verified = json.loads(await self.bridge._rpc_projectMergeVerify('main', fresh['id']))
        self.assertEqual((await self.apply(verified))['status'], 'succeeded')
        self.assertTrue((self.project / 'one.txt').exists())
        self.assertTrue((self.project / 'two.txt').exists())

    async def test_graph_unavailable_copy_stays_unknown_and_identity_cannot_change_mid_read(self):
        child = await self.child()
        original = self.bridge._task_git_authority
        def unavailable(sid):
            if sid == child.id: raise CollaborationError('副本登记不可用')
            return original(sid)
        with patch.object(self.bridge, '_task_git_authority', side_effect=unavailable):
            graph = json.loads(await self.bridge._rpc_projectBranchGraph('main'))
        unknown = next(row for row in graph['branches'] if row['sessionId'] == child.id)
        self.assertEqual(unknown['state'], 'unknown')
        self.assertNotIn('ahead', unknown)
        self.assertNotIn('head', unknown)
        saved_run = TaskGit.run
        def changed(git, *args, **kwargs):
            result = saved_run(git, *args, **kwargs)
            if args[0] == 'log':
                saved_run(git, 'checkout', '-b', 'moved-during-read')
            return result
        with patch.object(TaskGit, 'run', changed):
            with self.assertRaisesRegex(CollaborationError, '读取期间分支已推进'):
                await self.bridge._rpc_projectBranchGraph('main')

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

    async def test_related_discovery_is_bounded_scoped_and_read_only(self):
        child = await self.child()
        plan = json.loads(await self.bridge._rpc_projectMergePreview(child.id, child.id, 'main', 'from-child'))
        other = await self.preview(child, 'from-main')
        store = self.bridge._collaboration_store()
        for scope in (CollaborationScope('other', 'test-node'), CollaborationScope('tester', 'elsewhere')):
            store.write(scope, 'merge', 'hidden', plan, 0)
        first = json.loads(await self.bridge._rpc_projectMergeOperations('main', limit=1))
        second = json.loads(await self.bridge._rpc_projectMergeOperations('main', offset=first['nextOffset'], limit=1))
        self.assertEqual({item['id'] for item in first['items'] + second['items']}, {plan['id'], other['id']})
        self.assertIsNone(second['nextOffset'])
        self.assertEqual(first['items'][0]['sourceSessionId'], child.id)
        self.assertNotIn('source', first['items'][0])
        self.assertFalse(json.loads(await self.bridge._rpc_projectMergeOperations('main', source='main'))['items'])
        shown = json.loads(await self.bridge._rpc_projectMergeInspect('main', plan['id']))
        self.assertEqual(shown['sourceSessionId'], child.id)
        self.assertEqual(store.read(self.scope, 'merge', plan['id']), plan)
        with self.assertRaises(CollaborationError): self.bridge._rpc_projectMergePrepare('main', plan['id'], 'forged', plan['planFingerprint'])
        with self.assertRaises(CollaborationError): await self.bridge._rpc_projectMergeOperations('main', limit=101)
        self.assertEqual(json.loads(self.bridge._rpc_sessionCollaborationCapabilities('main'))['mergeWorkflow'], 1)
        broker = ChatWorkspaceTools(self.bridge)
        lease = {'session': 'main', 'active': True, 'client': self.peer}
        found = await broker._project_call(lease, validate_args({'action': 'merge_operations'}))
        self.assertEqual(len(found['items']), 2)
        inspected = await broker._project_call(lease, {'action': 'merge_inspect', 'operationId': plan['id']})
        self.assertEqual(inspected['id'], plan['id'])
        with self.assertRaises(CollaborationError): await broker._project_call(lease, {'action': 'merge_verify', 'operationId': plan['id']})
        with patch.object(self.bridge, '_require_session_access', side_effect=lambda sid: (_ for _ in ()).throw(PermissionError()) if sid == child.id else None):
            self.assertFalse(json.loads(await self.bridge._rpc_projectMergeOperations('main'))['items'])
            with self.assertRaises(PermissionError): await self.bridge._rpc_projectMergeInspect('main', plan['id'])

    async def test_diagnostics_distinguish_target_disk_buffer_activity_and_missing_details(self):
        child = await self.child()
        plan = await self.preview(child)
        (self.project / 'target-only.txt').write_text('dirty', encoding='utf-8')
        self.bridge._project_state()['buffers']['fixture'] = {'root': self.git.inspect()['root'], 'sessionId': 'main',
            'owner': 'tester', 'opened': True, 'dirty': True, 'client': self.peer, 'paths': ['draft.txt']}
        self.bridge._session_destroy_busy_reason = lambda sid: 'chat running' if sid == 'main' else ''
        view = json.loads(await self.bridge._rpc_projectMergeInspect(child.id, plan['id']))['workflow']
        self.assertFalse(view['sides']['source']['dirty'])
        diagnostics = view['diagnostics']
        self.assertTrue(all(item['side'] == 'target' for item in diagnostics))
        self.assertEqual({item['code'] for item in diagnostics}, {'git_dirty', 'changed', 'buffer_dirty', 'activity'})
        self.assertTrue(next(item for item in diagnostics if item['code'] == 'git_dirty')['paths'][0]['untracked'])
        self.assertEqual(next(item for item in diagnostics if item['code'] == 'buffer_dirty')['paths'][0]['path'], 'draft.txt')
        (self.project / 'target-only.txt').unlink()
        view = json.loads(await self.bridge._rpc_projectMergeInspect('main', plan['id']))['workflow']
        self.assertFalse(view['sides']['target']['dirty'])
        self.assertIn('buffer_dirty', [item['code'] for item in view['diagnostics']])
        self.bridge._clients.clear()
        view = json.loads(await self.bridge._rpc_projectMergeInspect('main', plan['id']))['workflow']
        self.assertIn('buffer_unknown', [item['code'] for item in view['diagnostics']])

    async def test_buffer_path_reporting_is_bounded_and_legacy_compatible(self):
        token = WINDOW_REQUEST.set({'clientId': 'fixture-client', 'windowId': 'fixture-window'})
        try:
            identity = json.dumps(self.identity('main').to_dict())
            self.bridge._rpc_projectBufferState('main', identity, True, True, ['draft.txt'])
            self.assertEqual(self.bridge._project_activity(str(self.project))[0]['paths'][0]['path'], 'draft.txt')
            self.bridge._rpc_projectBufferState('main', identity, True, True)
            self.assertEqual(self.bridge._project_activity(str(self.project))[0]['paths'], [])
            with self.assertRaises(ValueError): self.bridge._rpc_projectBufferState('main', identity, True, True, ['../outside'])
            with self.assertRaises(ValueError): self.bridge._rpc_projectBufferState('main', identity, True, True, ['a'] * 101)
        finally:
            WINDOW_REQUEST.reset(token)

    async def test_integration_activity_event_follows_turn_registry_release(self):
        from types import SimpleNamespace
        from src.backend.bridge_ws import BridgeWS
        gate = asyncio.Event()
        async def finish(payload):
            await gate.wait()
        events = []
        bridge = SimpleNamespace(_require_update_work_allowed=lambda: None, _check_chat_turn_allowed=lambda sid: None,
            _invalidate_followup=lambda sid: None, _handle_send_message=finish,
            _active_sessions={'integration': SimpleNamespace(relation_kind='integration')})
        bridge._emit_session_updated = lambda value: events.append((value, bool(bridge._chat_turn_tasks)))
        task = BridgeWS._start_chat_turn(bridge, json.dumps({'sessionId': 'integration'}))
        self.assertFalse(events); self.assertTrue(bridge._chat_turn_tasks)
        gate.set(); await task; await asyncio.sleep(0)
        self.assertEqual(events, [({'type': 'merge_activity', 'sessionId': 'integration'}, False)])

    async def test_projection_links_legacy_recovery_and_test_evidence_freshness(self):
        child = await self.child()
        self.commit(child, 'feature.txt', 'output')
        plan = await self.preview(child)
        row = await self.prepare(plan)
        view = json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))['workflow']
        self.assertTrue(view['canAutoVerify']); self.assertFalse(view['gitVerified'])
        self.assertEqual(view['tests']['state'], 'unknown')
        row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        store = self.bridge._collaboration_store()
        evidence = {'candidate': row['candidate'], 'name': 'fixture-test', 'exitCode': 1, 'source': 'executor', 'finishedAt': 1, 'logRef': 'integration/test.log'}
        row = store.write(self.scope, 'merge', row['id'], {**row, 'testEvidence': [evidence, {'source': 'model', 'name': 'all passed'}]}, row['revision'])
        view = json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))['workflow']
        self.assertTrue(view['gitVerified']); self.assertEqual(view['tests']['state'], 'failed')
        row = store.write(self.scope, 'merge', row['id'], {**row, 'testEvidence': [{**evidence, 'exitCode': 0}]}, row['revision'])
        self.assertEqual(json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))['workflow']['tests']['state'], 'passed')
        integration = self.bridge._session_store.load(row['integration']['sessionId'])
        git = TaskGit(integration.working_dir)
        original_branch = git.inspect()['branch']
        git.run('checkout', '-b', 'candidate-other-branch')
        view = json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))['workflow']
        self.assertFalse(view['gitVerified']); self.assertTrue(view['canAutoVerify'])
        git.run('checkout', original_branch)
        self.commit(integration, 'next.txt', 'new candidate')
        view = json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))['workflow']
        self.assertFalse(view['gitVerified']); self.assertEqual(view['tests']['state'], 'stale')
        self.bridge._session_destroy_busy_reason = lambda sid: 'native exit unknown' if sid == integration.id else ''
        view = json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))['workflow']
        self.assertFalse(view['canAutoVerify'])
        self.bridge._session_destroy_busy_reason = lambda sid: ''
        changed = {**evidence, 'candidate': '0' * 40}
        row = store.write(self.scope, 'merge', row['id'], {**row, 'testEvidence': [changed]}, row['revision'])
        self.assertEqual(json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))['workflow']['tests']['state'], 'stale')
        rows = self.bridge._merge_session_links(self.bridge._session_store.list())
        linked = next(item for item in rows if item['id'] == row['integration']['sessionId'])
        self.assertEqual(linked['mergeLink']['operationId'], row['id'])
        original = self.bridge._session_store.load(linked['id']).meta_dict()
        self.assertNotIn('mergeLink', original)
        orphan = self.bridge._merge_session_links([original])[0]
        self.assertNotIn('mergeLink', orphan)
        malformed = self.bridge._merge_session_links([{**original, 'workspaceId': 5}])[0]
        self.assertNotIn('mergeLink', malformed)
        integration_id = row['integration']['sessionId']
        original_access = self.bridge._require_session_access
        with patch.object(self.bridge, '_require_session_access', side_effect=lambda sid: (_ for _ in ()).throw(PermissionError('denied')) if sid == integration_id else original_access(sid)):
            denied = json.loads(await self.bridge._rpc_projectMergeInspect('main', row['id']))
            self.assertEqual(denied['integration']['root'], '')
            self.assertEqual(denied['workflow']['sides']['integration']['state'], 'unknown')
            self.assertFalse(denied['workflow']['gitVerified'])

    async def test_child_context_merge_integration_is_sibling_not_grandchild(self):
        child = await self.child()
        self.commit(child, 'feature.txt', 'output')
        plan = json.loads(await self.bridge._rpc_projectMergePreview(child.id, child.id, 'main', 'child-preview'))
        self.assertEqual(plan['integrationParentId'], 'main')
        self.bridge._rpc_projectMergePrepare(child.id, plan['id'], 'child-prepare', plan['planFingerprint'])
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        result = json.loads(await self.bridge._rpc_projectMergeStatus(child.id, plan['id']))
        self.assertEqual(result['status'], 'candidate', result)
        integration = self.bridge._session_store.load(result['integration']['sessionId'])
        self.assertEqual(integration.parent_session_id, 'main')
        self.assertEqual(integration.project_group_id, 'main')
        self.assertFalse((self.project / 'feature.txt').exists())
        with self.assertRaisesRegex(ValueError, '两层'):
            await self.bridge._rpc_taskWorkspacePlan(integration.id, 'no-grandchild', '{"title":"no"}')

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

    async def test_missing_buffer_reply_is_preflight_failure_and_original_candidate_can_be_rechecked(self):
        child = await self.child(); self.commit(child, 'feature.txt', 'output')
        row = await self.prepare(await self.preview(child))
        row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        class SilentPeer:
            async def send(self, raw): pass
        silent = SilentPeer(); self.bridge._clients.add(silent)
        wait_for = asyncio.wait_for
        async def short_probe(awaitable, timeout):
            return await wait_for(awaitable, .01 if timeout == 10 else timeout)
        with patch('src.backend.project_write_gate.asyncio.wait_for', side_effect=short_probe), patch.object(TaskGit, 'merge') as merge:
            failed = await self.apply(row)
            merge.assert_not_called()
        self.assertEqual(failed['status'], 'error', failed)
        self.assertIn('1 个窗口连接未回应', failed['notice'])
        self.assertIn('尚未开始 Git 合并', failed['notice'])
        self.assertNotIn('退出未知', failed['notice'])
        self.assertEqual(self.git.inspect()['head'], row['target']['head'])
        self.assertFalse(self.bridge._collaboration_store().project_gates('test-node'))
        self.assertFalse(self.bridge._project_state()['reservations'])
        self.assertFalse(self.bridge._project_state()['probes'])
        self.bridge._clients.remove(silent)
        recovered = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        self.assertEqual(recovered['status'], 'candidate')
        self.assertEqual(recovered['integration']['sessionId'], row['integration']['sessionId'])
        self.assertEqual(self.git.inspect()['head'], row['target']['head'])
        receipt = self.bridge._collaboration_store().request(self.scope, failed['applyRequestId'])
        self.assertEqual(receipt['status'], 'failed')
        # 原 requestId 重放只能返回原意图，不会因为已恢复就再合并。
        await self.apply(recovered)
        self.assertEqual(self.git.inspect()['head'], row['target']['head'])
        self.bridge._rpc_projectMergeApply('main', row['id'], 'apply-recovered', recovered['candidate'], recovered['planFingerprint'])
        await asyncio.gather(*list(self.bridge._merge_jobs().values()))
        final = json.loads(await self.bridge._rpc_projectMergeStatus('main', row['id']))
        self.assertEqual(final['status'], 'succeeded', final)
        self.assertEqual(self.git.inspect()['head'], recovered['candidate'])

    async def test_failed_apply_recheck_refuses_live_gate_unknown_and_changed_target(self):
        child = await self.child(); self.commit(child, 'feature.txt', 'output')
        row = await self.prepare(await self.preview(child))
        row = json.loads(await self.bridge._rpc_projectMergeVerify('main', row['id']))
        self.clean = False
        failed = await self.apply(row)
        self.assertEqual(failed['status'], 'error')
        store = self.bridge._collaboration_store()
        store.project_gate_save('test-node', {'root': row['target']['root'], 'owner': 'tester', 'operationId': row['id'], 'phase': 'applying', 'exitConfirmed': False})
        with self.assertRaisesRegex(CollaborationError, '尚未确认失败或退出'):
            await self.bridge._rpc_projectMergeVerify('main', row['id'])
        self.assertTrue(store.project_gates('test-node'))
        store.project_gate_remove('test-node', row['target']['root'], row['id'])
        unknown = self.bridge._merge_update(self.scope, failed, status='unknown')
        with self.assertRaises(CollaborationError): await self.bridge._rpc_projectMergeVerify('main', row['id'])
        self.bridge._merge_update(self.scope, unknown, status='error')
        self.commit(self.source, 'later.txt', 'keep newer target')
        with self.assertRaisesRegex(CollaborationError, '来源或目标已变化'):
            await self.bridge._rpc_projectMergeVerify('main', row['id'])
        self.assertFalse((self.project / 'feature.txt').exists())

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
