import copy
import json
import unittest
from unittest.mock import patch

from tests.test_session_appearance import _fixture, _stop_store
from src.backend.session_store import SessionStore


class SessionPrivacyTests(unittest.TestCase):
    def test_durable_marker_does_not_touch_favorites_body_or_time(self) -> None:
        with _fixture() as (store, session, bridge, events):
            old = copy.deepcopy(session)
            before = store._session_path(session.id).read_bytes()
            payload = json.dumps({'isPrivate': True, 'expectedRevision': 0, 'requestId': 'private-1'})
            result = json.loads(bridge._rpc_sessionPrivacySet(session.id, payload))
            self.assertEqual('ok', result['status'])
            self.assertEqual(1, result['privacyRevision'])
            self.assertEqual(before, store._session_path(session.id).read_bytes())
            self.assertFalse(session.pinned)
            self.assertEqual(old.updated_at, session.updated_at)
            store.commit_appearance(session.id, {'pinned': True, 'sidebarColor': 'ocean'})
            store.save(old, async_=False)
            self.assertTrue(store.load(session.id).is_private)
            self.assertTrue(store.load(session.id).pinned)
            reopened = SessionStore()
            try:
                self.assertTrue(reopened.load(session.id).is_private)
                self.assertEqual('private-1', reopened.privacy_state(session.id)['lastRequestId'])
                self.assertNotIn('_privacyReceipt', reopened.list()[0])
            finally:
                _stop_store(reopened)
            self.assertTrue(events[-1]['summary']['isPrivate'])

    def test_cas_receipts_and_field_independence(self) -> None:
        with _fixture() as (store, session, bridge, _):
            def submit(value: bool, revision: int, request: str) -> dict:
                return json.loads(bridge._rpc_sessionPrivacySet(session.id, json.dumps({
                    'isPrivate': value, 'expectedRevision': revision, 'requestId': request})))
            self.assertEqual('ok', submit(True, 0, 'one')['status'])
            self.assertEqual(1, submit(True, 0, 'one')['privacyRevision'])
            self.assertEqual('error', submit(False, 0, 'one')['status'])
            self.assertEqual('conflict', submit(False, 0, 'two')['status'])
            store.commit_appearance(session.id, {'pinned': True})
            self.assertEqual('ok', submit(False, 1, 'three')['status'])
            self.assertTrue(store.load(session.id).pinned)
            self.assertEqual(1, store.load(session.id).favorite_revision)
            self.assertFalse(store.load(session.id).is_private)

    def test_failed_disk_write_and_invalid_payload_never_publish(self) -> None:
        with _fixture() as (store, session, bridge, events):
            self.assertFalse(store.load(session.id).is_private)
            with patch.object(store, '_atomic_write_text', side_effect=OSError('fixture disk failure')):
                result = json.loads(bridge._rpc_sessionPrivacySet(session.id, json.dumps({
                    'isPrivate': True, 'expectedRevision': 0, 'requestId': 'one'})))
            self.assertEqual('error', result['status'])
            self.assertFalse(store.privacy_state(session.id)['isPrivate'])
            self.assertEqual([], events)
            for value in ['true', 1, None]:
                result = json.loads(bridge._rpc_sessionPrivacySet(session.id, json.dumps({
                    'isPrivate': value, 'expectedRevision': 0, 'requestId': 'invalid'})))
                self.assertEqual('error', result['status'])
            self.assertEqual('not_found', json.loads(bridge._rpc_sessionPrivacyGet('missing'))['status'])
