import json
import unittest
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID
from src.types import normalize_session_view_mode
from tests.engine_workbench_fixtures import EngineFixture


class SessionWorkbenchModeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = EngineFixture().__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)
        self.store = self.fixture.session_store()
        self.session = self.fixture.session(session_type='loop')
        self.session.loop_control_mode = 'manual'
        self.session.auto_continue = False
        self.store.save(self.session, async_=False)
        self.bridge = BridgeWS.__new__(BridgeWS)
        self.bridge._session_store = self.store
        self.bridge._active_sessions = {self.session.id: self.session}
        self.bridge._emit_session_updated = Mock()
        owner = _REQUEST_OWNER_ID.set(self.session.owner_id)
        self.addCleanup(_REQUEST_OWNER_ID.reset, owner)

    def update(self, patch):
        return json.loads(self.bridge._rpc_updateSessionWorkbench(self.session.id, json.dumps(patch)))

    def test_legacy_data_and_unknown_values_default_to_chat(self):
        data = self.session.to_dict()
        data.pop('viewMode')
        self.store._session_path(self.session.id).write_text(json.dumps(data), encoding='utf-8')
        with self.store._lock:
            self.store._index[self.session.id].pop('viewMode')
        self.assertEqual(self.store.load(self.session.id).view_mode, 'chat')
        for value in (None, '', 'future', [], {}):
            self.assertEqual(normalize_session_view_mode(value), 'chat')
        self.assertEqual(normalize_session_view_mode('engine'), 'engine')

    def test_mode_durable_in_metadata_without_touching_transcript_or_execution(self):
        body = self.store._session_path(self.session.id).read_bytes()
        previous = self.session.to_dict()
        result = self.update({'viewMode': 'engine'})
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.store._session_path(self.session.id).read_bytes(), body)
        self.assertEqual(self.store.load(self.session.id).view_mode, 'engine')
        reopened = self.fixture.session_store()
        self.assertEqual(reopened.load(self.session.id).view_mode, 'engine')
        current = self.session.to_dict()
        self.assertEqual({k: v for k, v in previous.items() if k != 'viewMode'},
                         {k: v for k, v in current.items() if k != 'viewMode'})
        self.assertEqual(result['summary']['viewMode'], 'engine')
        self.bridge._emit_session_updated.assert_called_once()

    def test_omitted_field_and_legacy_rename_preserve_engine(self):
        self.update({'viewMode': 'engine'})
        with patch.object(self.store, 'save_meta', wraps=self.store.save_meta) as save:
            self.assertEqual(self.update({})['viewMode'], 'engine')
            save.assert_not_called()
        result = json.loads(self.bridge._rpc_renameSession(self.session.id, 'renamed'))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.store.load(self.session.id).view_mode, 'engine')

    def test_invalid_patch_rejected_without_changes(self):
        for patch_value in ([], {'viewMode': None}, {'viewMode': {}}, {'viewMode': 'future'}, {'sessionType': 'normal'}):
            with self.subTest(patch=patch_value):
                self.assertEqual(self.update(patch_value)['status'], 'error')
                self.assertEqual(self.session.view_mode, 'chat')
        self.assertEqual(json.loads(self.bridge._rpc_updateSessionWorkbench(self.session.id, '{'))['status'], 'error')
        self.bridge._emit_session_updated.assert_not_called()

    def test_other_user_cannot_read_or_change_mode(self):
        token = _REQUEST_OWNER_ID.set('another-user')
        try:
            with self.assertRaises(PermissionError):
                self.update({'viewMode': 'engine'})
        finally:
            _REQUEST_OWNER_ID.reset(token)
        self.assertEqual(self.session.view_mode, 'chat')

    def test_sessions_keep_independent_mode(self):
        other = self.fixture.session()
        self.store.save(other, async_=False)
        self.update({'viewMode': 'engine'})
        self.assertEqual(self.store.load(other.id).view_mode, 'chat')
        self.assertEqual(self.store.load(self.session.id).view_mode, 'engine')

    def test_failed_persistence_does_not_publish_success(self):
        with patch.object(self.store, '_save_index_sync', side_effect=OSError('injected')):
            self.assertEqual(self.update({'viewMode': 'engine'})['status'], 'error')
        self.assertEqual(self.session.view_mode, 'chat')
        self.assertEqual(self.store.get_meta(self.session.id)['viewMode'], 'chat')
        self.bridge._emit_session_updated.assert_not_called()


if __name__ == '__main__':
    unittest.main()
