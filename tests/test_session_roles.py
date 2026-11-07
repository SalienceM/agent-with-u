import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from src.backend.session_roles import SessionRoles, role_profile
from src.backend.session_collaboration_store import CollaborationScope, CollaborationStore, CollaborationError
from src.types import ModelBackendConfig, BackendType


class RoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.bridge = SessionRoles()
        self.store = CollaborationStore(Path(self.temp.name) / 'c.db')
        self.scope = CollaborationScope('alice', 'node')
        self.source = SimpleNamespace(backend_id='codex')
        self.bridge._collaboration_store = lambda: self.store
        self.bridge._collaboration_scope = lambda sid: self.scope
        self.bridge._collaboration_session = lambda sid: self.source
        self.bridge._window_guard = Mock()
        self.bridge._emit_event = Mock()
        self.bridge._session_runtime = lambda session: {'model': 'source-model'}
        self.bridge._backend_configs = [ModelBackendConfig('codex', BackendType.CODEX_OFFICIAL, 'Codex'),
            ModelBackendConfig('api', BackendType.OPENAI_COMPATIBLE, 'API')]
        self.profile = {'name': '审查者', 'instructions': '检查证据与未覆盖范围', 'backendId': '', 'runtime': {}, 'enabled': True, 'archived': False}

    def save(self, request, profile=None, revision=0):
        return json.loads(self.bridge._rpc_roleProfileSave('source', request, json.dumps(profile or self.profile), revision))

    def test_create_edit_archive_is_idempotent_and_preserves_frozen_version(self):
        first = self.save('new')['role']
        self.assertEqual(self.save('new')['role'], first)
        frozen = dict(first)
        changed = {**self.profile, 'id': first['id'], 'name': '新名字', 'archived': True}
        second = self.save('edit', changed, 1)['role']
        self.assertFalse(second['enabled'])
        self.assertEqual(second['revision'], 2)
        self.assertEqual(frozen['name'], '审查者')
        self.assertEqual(self.save('new')['role']['revision'], 1)
        self.assertEqual(len(self.store.list(self.scope, 'role')['items']), 1)
        self.assertEqual(self.save('stale', changed, 1)['state'], 'rejected')

    def test_roles_are_scoped_to_owner_executor_and_names_are_not_ids(self):
        first = self.save('first')['role']
        second = self.save('second')['role']
        self.assertNotEqual(first['id'], second['id'])
        self.assertIsNone(self.store.read(CollaborationScope('bob', 'node'), 'role', first['id']))
        self.assertIsNone(self.store.read(CollaborationScope('alice', 'elsewhere'), 'role', first['id']))

    def test_invalid_route_runtime_and_permission_fields_rejected(self):
        for extra in [{'node': 'other'}, {'workingDir': 'C:\\'}, {'skipPermissions': True}, {'kitApprovalDelegation': True}]:
            with self.assertRaises(CollaborationError): role_profile({**self.profile, **extra})
        for change in [{'backendId': 'missing'}, {'backendId': 'api', 'runtime': {'model': 'other'}}, {'runtime': {'reasoningEffort': 'bad space'}}]:
            with self.assertRaises(CollaborationError): self.save('bad', {**self.profile, **change})
        config, runtime = self.bridge._role_route(self.source, self.profile)
        self.assertEqual((config.id, runtime['model']), ('codex', 'source-model'))
        config, runtime = self.bridge._role_route(self.source, {**self.profile, 'backendId': 'api'})
        self.assertEqual(runtime, {})
