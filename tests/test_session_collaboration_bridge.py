import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from src.backend.session_collaboration_bridge import SessionCollaborationBridge
from src.backend.session_collaboration_store import CollaborationScope, CollaborationStore, CollaborationError


class FakeBridge(SessionCollaborationBridge):
    owner = 'alice'
    executor = 'node-a'
    sessions = {'s': 'alice', 'other': 'bob'}
    def _current_owner_id(self): return self.owner
    def _loop_environment_executor(self): return self.executor
    def _current_request_client(self): return 'current'
    def _owner_id_for_client(self, client): return 'bob' if client == 'other' else self.owner
    def _require_session_access(self, session_id):
        if self.sessions.get(session_id) != self.owner: raise PermissionError('不可用')


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_online_same_owner_declared_clients_can_render_questions(self):
        from src.backend.user_interactions import UserInteractionRequest
        b = FakeBridge()
        b._clients = {'current', 'other'}
        b._client_meta = {'current': {}, 'other': {'userInteractionsVersion': 1}}
        b._collaboration_session = lambda sid: SimpleNamespace(id=sid, skip_permissions=False)
        self.assertFalse(b._has_interaction_client())
        with self.assertRaisesRegex(CollaborationError, '普通下一轮'):
            await b._await_user_interaction(UserInteractionRequest('s', 'm', 'r'))
        b._declare_interaction_client(True)
        self.assertFalse(b._has_interaction_client())
        b._declare_interaction_client(1)
        self.assertTrue(b._has_interaction_client())
        b._clients.remove('current')
        self.assertFalse(b._has_interaction_client())

    async def test_old_client_approval_uses_existing_gate(self):
        from unittest.mock import AsyncMock
        from src.backend.base import PermissionRequest
        b = FakeBridge()
        b._collaboration_session = lambda sid: SimpleNamespace(id=sid, skip_permissions=False)
        b._check_skip_permission = lambda sid: False
        b._await_permission_grant = AsyncMock(return_value=False)
        self.assertFalse(await b._await_bool_interaction(PermissionRequest('s', 'm', 't', 'tool', '{}'), lambda: False))
        b._await_permission_grant.assert_awaited_once()

    async def test_reconnect_projects_interrupted_and_unknown_without_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            b = FakeBridge()
            b._session_collaboration_store = CollaborationStore(Path(directory) / 's.db')
            b._backend_configs = []
            b._collaboration_session = lambda sid: SimpleNamespace(backend_id='absent')
            b._emit_event = lambda *args: None
            b._window_guard = lambda sid: None
            scope = CollaborationScope('alice', 'node-a')
            for key, status in [('p', 'pending'), ('r', 'responding')]:
                b._collaboration_store().write(scope, 'interaction', key, {'sessionId': 's', 'status': status}, 0)
            rows = json.loads(await b._rpc_userInteractionList('s'))['items']
            self.assertEqual({row['id']: row['status'] for row in rows}, {'p': 'interrupted', 'r': 'unknown'})
            reply = json.loads(await b._rpc_userInteractionRespond('s', 'r', '{"kind":"cancelled"}'))
            self.assertEqual(reply['status'], 'unknown')
            self.assertFalse(b._user_interactions().pending)

    async def test_owner_session_revision_and_executor_are_all_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            b = FakeBridge()
            b._session_collaboration_store = CollaborationStore(Path(directory) / 's.db')
            scope = CollaborationScope('alice', 'node-a')
            b._collaboration_store().write(scope, 'report', 'r', {'sourceSessionId': 's', 'content': 'body'}, 0)
            self.assertEqual(json.loads(await b._rpc_sessionCollaborationGet('s', 'report', 'r', 1))['content'], 'body')
            self.assertNotIn('content', json.loads(await b._rpc_sessionCollaborationList('s', 'report'))['items'][0])
            with self.assertRaises(PermissionError):
                await b._rpc_sessionCollaborationGet('other', 'report', 'r')
            with self.assertRaises(CollaborationError):
                await b._rpc_sessionCollaborationGet('s', 'report', 'r', 2)
            b.executor = 'offline-other'
            with self.assertRaises(CollaborationError):
                await b._rpc_sessionCollaborationGet('s', 'report', 'r')
            self.assertEqual(json.loads(await b._rpc_sessionCollaborationList('s', 'report'))['items'], [])
