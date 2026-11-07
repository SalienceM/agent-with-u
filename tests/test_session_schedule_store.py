import tempfile
import unittest
from pathlib import Path

from src.backend.session_schedule_rules import ScheduleError
from src.backend.session_schedule_store import SessionScheduleStore
from tests.test_session_schedule_rules import config, instant


class ScheduleStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = SessionScheduleStore(Path(self.temp.name) / 's.sqlite')
        self.store.initialize()
        self.scope = ('owner', 'executor')
        self.now = instant('2026-01-01')

    def save(self, **kwargs):
        value = {'action': 'save', 'id': 'plan', 'requestId': 'request', 'expectedRevision': 0,
                 'config': config({'kind': 'interval', 'anchor': self.now + 60, 'seconds': 60}), **kwargs}
        return self.store.mutate(self.scope, 's', value, self.now)

    def test_receipt_cas_owner_and_reopen(self):
        first = self.save()
        self.assertEqual(first, self.save())
        with self.assertRaises(ScheduleError):
            self.save(config=config(prompt='changed'))
        with self.assertRaises(ScheduleError):
            self.save(requestId='other')
        other = SessionScheduleStore(self.store.path)
        other.initialize()
        self.assertEqual(other.request(self.scope, 's', 'request'), first)
        self.assertEqual(other.listing(('other', 'executor'), 's')['items'], [])
        with self.assertRaises(ScheduleError):
            other.get(self.scope, 'other-session', 'plan')

    def test_coalesce_no_clock_backwards_replay(self):
        self.save()
        self.store.consume(self.now + 60)
        self.store.consume(self.now + 3600)
        work = self.store.work()
        self.assertEqual(len(work), 1)
        self.assertEqual(work[0]['coalescedCount'], 60)
        self.store.consume(self.now + 20)
        self.assertEqual(self.store.work()[0]['coalescedCount'], 60)

    def test_skip_grace_and_once_exhaustion(self):
        self.save(config=config({'kind': 'once', 'at': self.now + 60}, misfirePolicy='skip'))
        self.store.consume(self.now + 65)
        occ = self.store.work()[0]
        self.assertTrue(self.store.get(self.scope, 's', 'plan')['enabled'])
        self.assertIsNone(self.store.get(self.scope, 's', 'plan')['nextDueAt'])
        self.store.transition(self.scope, occ['id'], 'queued')
        self.store.transition(self.scope, occ['id'], 'claimed')
        self.store.transition(self.scope, occ['id'], 'running')
        self.store.recover()
        self.assertEqual(self.store.get(self.scope, 's', occ['id'], occurrence=True)['state'], 'unknown')
        with self.assertRaises(ScheduleError):
            self.store.transition(self.scope, occ['id'], 'queued')

    def test_skip_all_and_disabled_period(self):
        self.save(config=config({'kind': 'once', 'at': self.now + 60}, misfirePolicy='skip'))
        self.store.consume(self.now + 200)
        self.assertEqual(self.store.work(), [])
        self.assertEqual(self.store.listing(self.scope, 's', history=True)['items'][0]['state'], 'skipped')
        self.store.archive(self.now + 1000)
        self.store.consume(self.now + 300)
        self.assertEqual(len(self.store.listing(self.scope, 's', history=True)['items']), 1)

    def test_cancel_before_claim_and_claim_before_disable(self):
        self.save()
        self.store.consume(self.now + 60)
        occ = self.store.work()[0]
        self.store.transition(self.scope, occ['id'], 'queued')
        self.store.mutate(self.scope, 's', {'action': 'enable', 'id': 'plan', 'expectedRevision': 1,
                                          'requestId': 'off', 'enabled': False}, self.now + 65)
        with self.assertRaises(ScheduleError):
            self.store.transition(self.scope, occ['id'], 'claimed')
        self.store.mutate(self.scope, 's', {'action': 'enable', 'id': 'plan', 'expectedRevision': 2,
                                          'requestId': 'on', 'enabled': True}, self.now + 1000)
        self.store.consume(self.now + 1020)
        new = next(row for row in self.store.work() if row['state'] == 'prepared')
        self.store.transition(self.scope, new['id'], 'queued')
        self.store.transition(self.scope, new['id'], 'claimed')
        result = self.store.mutate(self.scope, 's', {'action': 'delete', 'id': 'plan', 'expectedRevision': 3,
                                                   'requestId': 'delete'}, self.now + 1021)
        self.assertEqual(result['active'][0]['state'], 'claimed')

    def test_retry_new_identity_and_unknown_never_retried(self):
        self.save()
        self.store.consume(self.now + 60)
        occ = self.store.work()[0]
        self.store.transition(self.scope, occ['id'], 'failed', error='test')
        value = {'action': 'retry', 'id': occ['id'], 'requestId': 'retry'}
        retry = self.store.mutate(self.scope, 's', value, self.now + 65)
        self.assertNotEqual(retry['occurrence']['id'], occ['id'])
        self.assertEqual(retry, self.store.mutate(self.scope, 's', value, self.now + 70))

    def test_large_history_paging_and_archival_keep_deduplication(self):
        self.save(config=config({'kind': 'interval', 'anchor': self.now + 60, 'seconds': 60}, misfirePolicy='skip'))
        for index in range(150):
            self.store.consume(self.now + 180 * (index + 1))
            for row in self.store.work():
                self.store.transition(self.scope, row['id'], 'failed', error='fixture')
                row = self.store.get(self.scope, 's', row['id'], occurrence=True)
                self.store.acknowledge(self.scope, row['id'], row['revision'])
        first = self.store.listing(self.scope, 's', history=True)
        self.assertEqual(len(first['items']), 30)
        self.assertEqual(first['nextOffset'], 30)
        second = self.store.listing(self.scope, 's', history=True, offset=30)
        self.assertFalse({row['id'] for row in first['items']} & {row['id'] for row in second['items']})
        self.assertNotIn('promptSnapshot', str(first))
        while self.store.archive(self.now + 999999):
            pass
        self.store.consume(self.now + 10)
        self.assertEqual(first['items'][0]['id'], self.store.listing(self.scope, 's', history=True)['items'][0]['id'])
        self.assertEqual(self.store.work(), [])


if __name__ == '__main__':
    unittest.main()
