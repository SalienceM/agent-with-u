import concurrent.futures
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from src.backend.session_collaboration_store import CollaborationStore, CollaborationScope, CollaborationError


class CollaborationStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state.sqlite3'
        self.store = CollaborationStore(self.path)
        self.scope = CollaborationScope('alice', 'node-a')

    def test_discarded_previews_do_not_consume_list_pages_but_remain_readable(self):
        for name, status in [('ready', 'ready'), ('preview', 'preview'), ('removed-1', 'discarded'), ('removed-2', 'discarded')]:
            self.store.write(self.scope, 'workspace', name, {'sourceSessionId': 's', 'status': status}, 0)
        page = self.store.list(self.scope, 'workspace', session_id='s', limit=1)
        self.assertEqual([row['id'] for row in page['items']], ['preview'])
        self.assertEqual(page['nextOffset'], 1)
        last = self.store.list(self.scope, 'workspace', session_id='s', offset=page['nextOffset'], limit=1)
        self.assertEqual([row['id'] for row in last['items']], ['ready'])
        self.assertIsNone(last['nextOffset'])
        self.assertEqual(self.store.read(self.scope, 'workspace', 'removed-1')['status'], 'discarded')

    def test_concurrent_retry_is_claimed_once_and_survives_restart(self):
        def begin(_):
            return CollaborationStore(self.path).begin_request(self.scope, 'req', 'create', {'source': 's'})
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            outcomes = list(pool.map(begin, range(12)))
        self.assertEqual(sum(fresh for _, fresh in outcomes), 1)
        receipt, fresh = begin(None)
        self.assertFalse(fresh)
        self.assertEqual(receipt['status'], 'accepted')
        with self.assertRaises(CollaborationError):
            self.store.begin_request(self.scope, 'req', 'create', {'source': 'another'})
        self.assertIsNone(self.store.request(CollaborationScope('alice', 'node-b'), 'req'))

    def test_revision_race_and_compact_list(self):
        self.store.write(self.scope, 'report', 'r', {'sessionId': 's', 'title': '同名', 'content': '秘密正文'}, 0)
        def write(i):
            try:
                self.store.write(self.scope, 'report', 'r', {'sessionId': 's', 'title': str(i)}, 1)
                return True
            except CollaborationError:
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(write, range(4))), 1)
        summary = self.store.list(self.scope, 'report', session_id='s')
        self.assertEqual(len(summary['items']), 1)
        self.assertNotIn('content', summary['items'][0])
        self.assertEqual(self.store.list(CollaborationScope('bob', 'node-a'), 'report')['items'], [])
        self.assertEqual(self.store.list(self.scope, 'report', session_id='other')['items'], [])

    def test_interrupted_transaction_does_not_publish(self):
        with self.assertRaises(RuntimeError):
            with self.store._connection() as db:
                db.execute('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)',
                           ('alice', 'node-a', 'report', 'r', 1, 0, '{}', '{}'))
                raise RuntimeError('模拟进程提交前中断')
        self.assertIsNone(CollaborationStore(self.path).read(self.scope, 'report', 'r'))
        receipt, _ = self.store.begin_request(self.scope, 'req', 'create', {})
        done = self.store.finish_request(self.scope, 'req', receipt['revision'], 'unknown')
        self.assertEqual(CollaborationStore(self.path).request(self.scope, 'req'), done)

    def test_future_schema_refuses_write(self):
        db = sqlite3.connect(self.path)
        db.execute('PRAGMA user_version=2')
        db.close()
        with self.assertRaises(CollaborationError):
            CollaborationStore(self.path)
