"""通过隔离 runner 核对 Session 当前分支关系，不运行模型。"""
import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from tests.test_project_merges import ProjectMergeTests
from src.backend.project_branch_graph import GraphGit
from src.backend.session_collaboration_store import CollaborationError
from src.backend.task_git import TaskGit


class SessionBranchStatusTests(unittest.IsolatedAsyncioTestCase):
    setUp = ProjectMergeTests.setUp
    asyncTearDown = ProjectMergeTests.asyncTearDown
    identity = ProjectMergeTests.identity
    send_frame = ProjectMergeTests.send_frame
    role = ProjectMergeTests.role
    answer = ProjectMergeTests.answer
    child = ProjectMergeTests.child
    commit = ProjectMergeTests.commit

    async def read(self, sid='main', offset=0, limit=24):
        return json.loads(await self.bridge._rpc_projectBranchStatus(sid, offset, limit))

    async def test_live_counts_after_merge_new_commit_main_advance_and_dirty(self):
        child = await self.child()
        git = self.commit(child, 'feature.txt', 'first')
        page = await self.read(child.id)
        tip = next(row for row in page['items'] if not row['main'])
        self.assertEqual((tip['ahead'], tip['behind'], tip['dirty']), (1, 0, False))
        self.git.run('merge', '--ff-only', git.inspect()['head'])
        page = await self.read()
        tip = next(row for row in page['items'] if not row['main'])
        self.assertEqual((tip['ahead'], tip['behind']), (0, 0))
        self.commit(child, 'feature.txt', 'second')
        self.commit(self.source, 'main.txt', 'main advance')
        (Path(child.working_dir) / 'draft.txt').write_text('uncommitted')
        page = await self.read()
        tip = next(row for row in page['items'] if not row['main'])
        self.assertEqual((tip['ahead'], tip['behind'], tip['dirty']), (1, 1, True))
        self.assertNotIn('commits', page)

    async def test_pages_cover_current_members_exclude_integration_and_never_read_log(self):
        one = await self.child('one'); two = await self.child('two')
        self.commit(two, 'two.txt', 'new')
        original = GraphGit.run
        calls = []
        def run(git, *args, **kwargs):
            calls.append(args[0])
            return original(git, *args, **kwargs)
        with patch.object(GraphGit, 'run', run):
            page1 = await self.read(limit=1)
            page2 = await self.read(offset=page1['nextOffset'], limit=1)
        self.assertEqual(page1['total'], 2)
        self.assertEqual(page1['familyRevision'], page2['familyRevision'])
        self.assertIsNone(page2['nextOffset'])
        self.assertEqual({row['sessionId'] for page in [page1, page2] for row in page['items'] if not row['main']}, {one.id, two.id})
        self.assertNotIn('log', calls)
        second = self.bridge._collaboration_session(two.id)
        second.relation_kind = 'integration'; self.bridge._session_store.save(second)
        page = await self.read()
        self.assertEqual(page['total'], 1)

    async def test_unknown_member_does_not_erase_other_branches_and_busy_is_reported(self):
        child = await self.child()
        with patch.object(self.bridge, '_task_git_authority', side_effect=lambda sid: (_ for _ in ()).throw(CollaborationError('unavailable')) if sid == child.id else None):
            page = await self.read()
        self.assertEqual(page['items'][0]['state'], 'known')
        self.assertEqual(page['items'][1]['state'], 'unknown')
        self.bridge._has_native_session_activity = lambda sid: sid == child.id
        self.assertTrue((await self.read())['items'][1]['busy'])
        with self.assertRaises(CollaborationError): await self.read(limit=25)
        with self.assertRaises(PermissionError): await self.read('not-owned')

    async def test_owned_write_notifies_only_after_exit_and_regular_turn_release_notifies(self):
        events = self.bridge._emit_session_updated
        release = asyncio.Event()
        async def write(): await release.wait()
        waiting = asyncio.create_task(self.bridge._project_guarded_call(str(self.project), write()))
        await asyncio.sleep(0)
        events.assert_not_called()
        release.set(); await waiting
        events.assert_called_with({'type': 'branch_changed', 'sessionId': 'main'})
        from types import SimpleNamespace
        from src.backend.bridge_ws import BridgeWS
        events = []
        async def finish(payload): return True
        bridge = SimpleNamespace(_require_update_work_allowed=lambda: None, _check_chat_turn_allowed=lambda sid: None,
            _invalidate_followup=lambda sid: None, _handle_send_message=finish,
            _active_sessions={'main': SimpleNamespace(relation_kind='', working_dir=str(self.project))})
        bridge._emit_session_updated = lambda value: events.append((value, bool(bridge._chat_turn_tasks)))
        await BridgeWS._start_chat_turn(bridge, json.dumps({'sessionId': 'main'}))
        await asyncio.sleep(0)
        self.assertEqual(events, [({'type': 'branch_changed', 'sessionId': 'main'}, False)])
