import json
import unittest
from types import SimpleNamespace

from src.backend.aside_runtime import runtime_evidence
from src.backend.loop_store import LoopRecord, LoopState, LoopStep


class RuntimeEvidenceTests(unittest.TestCase):
    def test_current_native_repair_and_previous_verify(self):
        prior = LoopRecord(seq=1, openspec_run={'phase': 'verify', 'verify': {
            'valid': True, 'remaining': 1, 'issues': [{'severity': 'critical', 'summary': 'fix', 'evidence': 'test'}],
            'raw': 'HIDDEN'}})
        current = LoopRecord(seq=2, sub_stage='execute', orchestration=[LoopStep(index=1, status='running')],
                             openspec_run={'phase': 'repair', 'progress': {'total': 10, 'checked': 6,
                                  'pendingIds': ['a', 'b'], 'manualIds': ['m', 'n']}},
                             stage_details={'thinking': 'HIDDEN'})
        state = LoopState(session_id='s', loops=[prior, current], unresolved_blockers={
            'items': [{'id': 'blocked', 'reasonCode': 'authorization', 'message': 'needs user permission'}]})
        result = runtime_evidence(state=state, running=True)
        self.assertEqual(result['openspec']['phase'], 'repair')
        self.assertEqual(result['openspec']['progress']['manual'], 2)
        self.assertEqual(result['latestVerify']['remaining'], 1)
        self.assertEqual(result['blockers'][0]['reasonCode'], 'authorization')
        self.assertEqual(result['recentIterations'][0]['steps'][0]['status'], 'running')
        self.assertNotIn('HIDDEN', json.dumps(result))
        current.orchestration[0].status = 'done'
        updated = runtime_evidence(state=state)
        self.assertGreaterEqual(updated['sampledAt'], result['sampledAt'])
        self.assertEqual(updated['recentIterations'][0]['steps'][0]['status'], 'done')

    def test_legacy_and_normal_are_unknown_not_completed(self):
        state = LoopState(session_id='s', loops=[LoopRecord(seq=n) for n in range(30)])
        result = runtime_evidence(state=state)
        self.assertIsNone(result['openspec'])
        self.assertIsNone(result['latestVerify'])
        self.assertEqual(len(result['recentIterations']), 8)
        session = SimpleNamespace(id='s', title='normal', working_dir='.', messages=[])
        result = runtime_evidence(session)
        self.assertEqual(result['kind'], 'normal')
        self.assertIsNone(result['running'])


if __name__ == '__main__':
    unittest.main()
