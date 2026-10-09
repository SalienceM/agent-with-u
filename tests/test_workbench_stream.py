import unittest
from src.backend.workbench_stream import WorkbenchStreamJournal
from src.backend.engine_workbench import WorkbenchError


class StreamWindowTests(unittest.TestCase):
    def test_exact_replay_position_and_new_instance_are_not_ambiguous(self):
        journal = WorkbenchStreamJournal()
        a = journal.append('alice', 's', {'type': 'text_delta', 'text': 'a'})
        b = journal.append('alice', 's', {'type': 'text_delta', 'text': 'b'})
        self.assertEqual(b['streamSequence'], 2)
        self.assertEqual(journal.read('alice', 's', a['streamEpoch'], 1)['events'], [b])
        self.assertEqual(journal.read('alice', 's', a['streamEpoch'], 2)['events'], [])
        self.assertTrue(journal.read('alice', 's', 'old-process', 1)['gap'])
        self.assertEqual(journal.read('bob', 's', '', 0)['status'], 'unavailable')
        self.assertEqual(WorkbenchStreamJournal().read('alice', 's', a['streamEpoch'], 2)['status'], 'unavailable')

    def test_high_output_and_oversized_frame_remain_bounded_with_explicit_gap(self):
        journal = WorkbenchStreamJournal(per_session=512, total=1024, max_sessions=4, max_events=2)
        for index in range(100):
            event = journal.append('alice', 's', {'text': str(index) * 30})
        window = journal.windows[('alice', 's')]
        self.assertLessEqual(window.size, 512); self.assertLessEqual(len(window.events), 2)
        self.assertTrue(journal.read('alice', 's', event['streamEpoch'], 0)['gap'])
        large = journal.append('alice', 's', {'text': 'x' * 5000})
        self.assertEqual(large['text'], 'x' * 5000)
        self.assertTrue(journal.read('alice', 's', large['streamEpoch'], 100)['gap'])
        for index in range(10):
            journal.append('alice', str(index), {'text': 'x' * 300})
        self.assertLessEqual(sum(w.size for w in journal.windows.values()), 1024)
        self.assertLessEqual(len(journal.windows), 4)
        self.assertEqual(journal.read('alice', 's', large['streamEpoch'], 101)['status'], 'unavailable')

    def test_malformed_or_future_positions_never_return_successful_recovery(self):
        journal = WorkbenchStreamJournal(); event = journal.append('alice', 's', {'text': 'hello'})
        for value in [-1, True, 2**53, 1.5]:
            with self.assertRaises(WorkbenchError):
                journal.read('alice', 's', '', value)
        self.assertTrue(journal.read('alice', 's', event['streamEpoch'], 100)['gap'])
