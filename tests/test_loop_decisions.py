import unittest

from src.backend.loop_decisions import DecisionFacts, decide_next, normalize_decision
from src.backend.loop_store import LoopRecord, LoopStep, LoopState


class DecisionsTest(unittest.TestCase):
    def test_table_and_priority(self):
        cases = [
            ({'user_stop': True, 'complete': True}, 'stop', 'user_stop'),
            ({'control_mode': 'manual'}, 'stop', 'user_stop'),
            ({'call_still_active': True, 'complete': True}, 'wait', 'call_active'),
            ({'hard_reason': 'safety', 'complete': True}, 'wait', 'safety'),
            ({'hard_reason': 'authorization'}, 'wait', 'authorization'),
            ({'source_status': 'conflict', 'complete': True}, 'wait', 'scope_conflict'),
            ({'source_status': 'blocked'}, 'wait', 'workflow_blocked'),
            ({'source_status': 'stale'}, 'wait', 'source_unavailable'),
            ({'complete': True, 'budget_exhausted': True}, 'complete', 'acceptance_passed'),
            ({'budget_exhausted': True}, 'stop', 'budget_exhausted'),
            ({'risk_limit': True}, 'stop', 'risk_limit'),
            ({'failure_limit': True}, 'stop', 'failure_limit'),
            ({}, 'wait', 'auto_off'),
            ({'auto': True, 'no_progress_pause': True}, 'wait', 'no_progress'),
            ({'auto': True, 'call_result': 'error', 'retry_allowed': True}, 'retry', 'bounded_retry'),
            ({'auto': True, 'ready_ids': ['1.1']}, 'continue', 'ready_work'),
            ({'auto': True, 'needs_replan': True, 'ready_ids': ['1.1']}, 'replan', 'ready_work'),
            ({'auto': True, 'needs_review': True}, 'replan', 'review_required'),
            ({'auto': True}, 'wait', 'human_input'),
        ]
        for kwargs, action, reason in cases:
            with self.subTest(kwargs=kwargs):
                result = decide_next(DecisionFacts(**kwargs), '1:1:analysis')
                self.assertEqual((result['action'], result['reasonCode']), (action, reason))
                self.assertEqual(result, decide_next(DecisionFacts(**kwargs), '1:1:analysis'))
        self.assertEqual(decide_next(DecisionFacts(complete=True, manual_remaining=True), 'end')['completionScope'], 'automatic')

    def test_legacy_unknown_and_round_trip(self):
        rec = LoopRecord.from_dict({'seq': 1, 'error': 'old pause wording'})
        self.assertEqual(rec.terminal_kind, '')
        self.assertEqual(rec.decision, {})
        self.assertEqual(rec.error, 'old pause wording')
        step = LoopStep.from_dict({'index': 0, 'status': 'done', 'callResult': 'future', 'taskResult': 'future'})
        self.assertEqual((step.call_result, step.task_result), ('unknown', 'unknown'))
        step.call_result, step.task_result = 'normal', 'partial'
        rec.orchestration = [step]
        rec.outcome_version, rec.terminal_kind = 1, 'paused'
        rec.decision = decide_next(DecisionFacts(hard_reason='unclassified_pause'), 'prepare')
        rec.progress_version = 2
        state = LoopState('test', loops=[rec], task_source={'version': 1, 'status': 'unavailable'})
        self.assertEqual(LoopState.from_dict(state.to_dict()).to_dict(), state.to_dict())
        self.assertEqual(normalize_decision({'action': 'new_action'})['action'], 'wait')
        self.assertEqual(LoopState.from_dict({'taskSource': ['bad']}).task_source['status'], 'invalid')


if __name__ == '__main__':
    unittest.main()
