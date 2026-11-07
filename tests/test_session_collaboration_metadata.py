"""Session 组织元数据迁移只使用临时数据根。"""
import json
import tempfile
import unittest
from unittest.mock import patch

from src.backend.session_store import SessionStore
from src.types import Session


class SessionCollaborationMetadataTests(unittest.TestCase):
    def test_legacy_and_unknown_roundtrip(self):
        with tempfile.TemporaryDirectory() as root, patch.dict('os.environ', {'AGENT_WITH_U_DATA_ROOT': root}):
            store = SessionStore()
            try:
                original = Session('s', '同名', 1, 1, [], root, 'backend', owner_id='alice')
                data = original.to_dict()
                for key in original.collaboration_meta():
                    data.pop(key)
                data['futureField'] = {'preserve': [1, 2]}
                store._session_path('s').write_text(json.dumps(data), encoding='utf-8')
                loaded = store.load('s')
                self.assertFalse(loaded.followup_suggestions_enabled)
                self.assertIsNone(loaded.parent_session_id)
                self.assertNotIn('futureField', loaded.to_dict())
                loaded.parent_session_id = 'parent'
                loaded.relation_kind = 'task'
                loaded.project_group_id = 'group'
                loaded.workspace_id = 'workspace'
                loaded.followup_suggestions_enabled = True
                loaded.followup_suggestions_config = {'backendId': 'light', 'model': 'small', 'timeoutSeconds': 60}
                store.save(loaded, async_=False)
                persisted = json.loads(store._session_path('s').read_text(encoding='utf-8'))
                self.assertEqual(persisted['futureField'], data['futureField'])
                self.assertEqual(store.load('s').collaboration_meta(), loaded.collaboration_meta())
                self.assertEqual(store.get_meta('s')['workspaceId'], 'workspace')
            finally:
                store._io_running = False
                if store._index_save_timer:
                    store._index_save_timer.cancel()
                store._io_thread.join(timeout=2)

    def test_same_title_does_not_define_identity(self):
        a = Session('one', '同名', 1, 1, [], '/node-a/project', 'a', owner_id='alice', workspace_id='wa')
        b = Session('two', '同名', 1, 1, [], '/node-b/project', 'b', owner_id='bob', workspace_id='wb')
        self.assertNotEqual(a.meta_dict()['id'], b.meta_dict()['id'])
        self.assertNotEqual(a.meta_dict()['ownerId'], b.meta_dict()['ownerId'])
        self.assertNotEqual(a.meta_dict()['workspaceId'], b.meta_dict()['workspaceId'])


if __name__ == '__main__':
    unittest.main()
