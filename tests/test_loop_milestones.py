import copy
import hashlib
import tempfile
import unittest
from pathlib import Path

from src.backend.loop_milestones import register_plan, review_milestones, milestone_progress, validate_plan, inherit_plan
from src.backend.loop_delivery import assess_progress, completion_ready
from src.backend.loop_store import LoopRecord
from tests.test_loop_delivery import report


class MilestoneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'shell.py').write_text('shell complete', encoding='utf-8')
        self.parents = [{'id': '1.1', 'description': 'Build login shell and verify behavior'}]
        self.raw = {'milestones': [{'id': 'shell', 'parentId': '1.1', 'originRef': '1.1', 'acceptance': 'login shell',
                                    'status': 'pending', 'deliverable': 'operable shell'}]}

    def planned(self, seq=1):
        return register_plan(self.raw, self.parents, 'scope', seq, str(self.root))

    def reviewed(self, plan, status='implemented', key='shell'):
        refs = [{'path': 'shell.py', 'fingerprint': hashlib.sha256((self.root / 'shell.py').read_bytes()).hexdigest(),
                 'environment': 'env', 'result': 'isolated test passed', 'command': 'test shell'}]
        return review_milestones([{'id': key, 'status': status, 'mappingConfirmed': True, 'evidenceRefs': refs}], plan, str(self.root), 'env')

    def record(self, seq, status='implemented'):
        plan = self.planned(seq)
        rec = LoopRecord(seq, completed=True, progress_version=2, milestone_plan=plan, delivery=report(verification={}))
        rec.delivery['milestoneReview'] = self.reviewed(plan, status)
        return rec

    def test_partial_advance_resets_stagnation_without_parent_completion(self):
        records = [self.record(1, 'pending'), self.record(2, 'pending'), self.record(3)]
        guard = assess_progress(records)
        self.assertEqual(guard['noProgressCount'], 0)
        self.assertEqual(guard['milestones']['credited'], ['shell'])
        self.assertEqual(records[-1].delivery['items'][0]['status'], 'pending')
        self.assertFalse(completion_ready(records[-1].delivery))
        self.assertEqual(milestone_progress([self.record(1)])['credited'], ['shell'])

    def test_repetition_alias_regression_and_restoration_no_new_credit(self):
        records = [self.record(1), self.record(2), self.record(3, 'pending'), self.record(4)]
        self.assertEqual(assess_progress(records)['noProgressCount'], 3)
        self.assertEqual(milestone_progress(records)['credited'], [])
        self.raw['milestones'][0]['id'] = 'renamed'
        plan = self.planned(5)
        rec = self.record(5)
        rec.milestone_plan = plan
        rec.delivery['milestoneReview'] = self.reviewed(plan, key='renamed')
        self.assertEqual(milestone_progress(records + [rec])['credited'], [])

    def test_invalid_report_neither_credits_nor_consumes_milestone_high_water(self):
        first, invalid, valid = self.record(1, 'pending'), self.record(2), self.record(3)
        invalid.delivery.update(valid=False, scopeComplete=False)
        self.assertEqual(milestone_progress([first, invalid])['credited'], [])
        self.assertEqual(assess_progress([first, invalid])['noProgressCount'], 1)
        self.assertEqual(milestone_progress([first, invalid, valid])['credited'], ['shell'])

    def test_registered_scope_survives_missing_or_invalid_review(self):
        for delivery in ({}, {'valid': False}, {'valid': True, 'milestoneReview': {'valid': False}}):
            with self.subTest(delivery=delivery):
                old = LoopRecord(1, progress_version=2, progress_scope='scope',
                                 milestone_plan=self.planned(), delivery=delivery)
                before = copy.deepcopy(old.milestone_plan)
                inherited = inherit_plan({}, [old], 'scope', 2, str(self.root), 'env')
                self.assertTrue(inherited.get('valid'))
                self.assertEqual([m['id'] for m in inherited['milestones']], ['shell'])
                self.assertEqual(inherited['milestones'][0]['status'], 'pending')
                self.assertEqual(old.milestone_plan, before)
                self.assertEqual(inherit_plan({}, [old], 'other-scope', 2, str(self.root), 'env'), {})

    def test_invalid_review_cannot_poison_inherited_baseline_or_consume_credit(self):
        invalid = self.record(1, 'verified')
        invalid.progress_scope = 'scope'
        invalid.delivery['valid'] = False
        for new_plan in ({}, self.planned(2)):
            with self.subTest(new_plan=bool(new_plan)):
                plan = inherit_plan(new_plan, [invalid], 'scope', 2, str(self.root), 'env')
                self.assertEqual(plan['milestones'][0]['status'], 'pending')
                self.assertEqual(plan['milestones'][0]['evidenceRefs'], [])
                valid = self.record(2, 'verified')
                valid.progress_scope = 'scope'
                valid.milestone_plan = plan
                valid.delivery['milestoneReview'] = self.reviewed(plan, 'verified')
                self.assertEqual(milestone_progress([invalid, valid])['credited'], ['shell'])

    def test_unreviewed_inventory_remains_baseline_not_new_implementation(self):
        self.raw['milestones'][0]['status'] = 'implemented'
        old = LoopRecord(1, progress_version=2, progress_scope='scope', milestone_plan=self.planned())
        plan = inherit_plan({}, [old], 'scope', 2, str(self.root), 'env')
        current = self.record(2)
        current.milestone_plan = plan
        current.delivery['milestoneReview'] = self.reviewed(plan)
        self.assertEqual(milestone_progress([old, current])['credited'], [])
        candidate = report('verified')
        candidate['milestoneReview'] = review_milestones([], plan, str(self.root), 'env')
        self.assertFalse(completion_ready(candidate))

    def test_invalid_review_preserves_prior_valid_baseline_without_recredit(self):
        first = self.record(1, 'implemented')
        invalid = self.record(2, 'verified')
        first.progress_scope = invalid.progress_scope = 'scope'
        invalid.delivery['valid'] = False
        plan = inherit_plan({}, [first, invalid], 'scope', 3, str(self.root), 'env')
        self.assertEqual(plan['milestones'][0]['status'], 'implemented')
        current = self.record(3)
        current.milestone_plan = plan
        current.delivery['milestoneReview'] = self.reviewed(plan)
        self.assertEqual(milestone_progress([first, invalid, current])['credited'], [])
        current.delivery['milestoneReview'] = self.reviewed(plan, 'verified')
        self.assertEqual(milestone_progress([first, invalid, current])['credited'], ['shell'])

    def test_inherited_review_keeps_identity_and_rechecks_current_evidence(self):
        prior = self.record(1, 'verified')
        prior.progress_scope = 'scope'
        self.raw['milestones'][0]['id'] = 'renamed-shell'
        plan = inherit_plan(self.planned(2), [prior], 'scope', 2, str(self.root), 'env')
        self.assertEqual(plan['milestones'][0]['id'], 'shell')
        self.assertEqual(plan['milestones'][0]['status'], 'verified')
        current = LoopRecord(2, milestone_plan=plan, delivery=report('verified'))
        current.delivery['milestoneReview'] = review_milestones([], plan, str(self.root), 'env')
        self.assertTrue(completion_ready(current.delivery))
        self.assertEqual(milestone_progress([prior, current])['credited'], [])
        for changed_environment in (True, False):
            if not changed_environment:
                (self.root / 'shell.py').write_text('regression', encoding='utf-8')
            invalid = inherit_plan({}, [prior], 'scope', 3, str(self.root),
                                   'changed-env' if changed_environment else 'env')
            self.assertEqual(invalid['milestones'][0]['status'], 'invalid')
            candidate = report('verified')
            candidate['milestoneReview'] = review_milestones([], invalid, str(self.root), 'env')
            self.assertFalse(completion_ready(candidate))

    def test_orphan_duplicate_capacity_and_action_only(self):
        for modify in [lambda r: r['milestones'][0].update(parentId='missing'),
                       lambda r: r['milestones'][0].update(acceptance='run git status'),
                       lambda r: r['milestones'].append(copy.deepcopy(r['milestones'][0])),
                       lambda r: r.update(milestones=r['milestones'] * 201)]:
            raw = copy.deepcopy(self.raw)
            modify(raw)
            self.assertFalse(register_plan(raw, self.parents, 'scope', 1, str(self.root))['valid'])
        self.assertFalse(review_milestones([{'id': 'late'}], {}, str(self.root), 'env')['valid'])
        broken = self.planned()
        broken['milestones'][0]['registeredSeq'] = None
        self.assertFalse(validate_plan(broken)['valid'])

    def test_late_discovery_baseline_and_targeted_evidence_invalidation(self):
        self.raw['milestones'][0]['status'] = 'implemented'
        first = self.record(1)
        self.assertEqual(milestone_progress([first])['credited'], [])
        evidence = first.delivery['milestoneReview']['milestones'][0]['evidenceRefs']
        (self.root / 'unrelated.txt').write_text('unrelated change', encoding='utf-8')
        raw = [{'id': 'shell', 'status': 'verified', 'mappingConfirmed': True, 'evidenceRefs': evidence}]
        self.assertEqual(review_milestones(raw, first.milestone_plan, str(self.root), 'env')['milestones'][0]['validity'], 'current')
        (self.root / 'shell.py').write_text('changed', encoding='utf-8')
        updated = review_milestones(raw, first.milestone_plan, str(self.root), 'env')
        self.assertEqual(updated['milestones'][0]['status'], 'invalid')
        self.assertEqual(updated['milestones'][0]['validity'], 'changed')
        self.assertEqual(review_milestones(raw, first.milestone_plan, str(self.root), 'other')['milestones'][0]['validity'], 'environment')


if __name__ == '__main__':
    unittest.main()
