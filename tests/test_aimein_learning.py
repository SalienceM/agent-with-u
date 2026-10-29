"""No production sessions or models: reviewer memory and feedback contracts."""
import copy
import json
import unittest

from src.backend.aimein import AimeinError
from src.backend.aimein_learning import (memory, update_memory, recommendations, profile_snapshot,
                                         feedback_plan, apply_feedback, feedback_anchor, addon_in_scope, backend_revision)
from src.backend.aimein_bridge import scope_revision
from src.backend.loop_store import LoopState, LoopRecord, Addon
from tests import test_aimein as base
from tests.test_aimein import configs, plan


def doc(index=0):
    return dict(name=f'体验评委 {index}', backendId='b', model=f'model-{index}', reasoningEffort='',
                domain='产品 体验', flavor='首次使用清晰优先', focus='反馈 恢复 保存')


def save(state, action='save', **kwargs):
    state.aimein_memory = update_memory(state, dict(action=action,
        expectedRevision=state.aimein_memory.get('revision', 0), **kwargs), configs())
    return state.aimein_memory


class LearningContracts(unittest.TestCase):
    def test_versioned_documents_roundtrip_compact_and_import_no_credit(self):
        state = LoopState('s')
        save(state, document=doc())
        ident = state.aimein_memory['profiles'][0]['id']
        save(state, document={**doc(), 'focus': '离线恢复'}, profileId=ident)
        self.assertEqual(len(state.aimein_memory['profiles'][0]['history']), 1)
        save(state, 'import', document={**doc(), 'calibrations': [{'kind': 'confirmed'}]})
        self.assertFalse(state.aimein_memory['calibrations'])
        self.assertNotEqual(state.aimein_memory['profiles'][1]['id'], ident)
        self.assertEqual(LoopState.from_dict(state.to_dict()).aimein_memory, state.aimein_memory)
        self.assertEqual(state.to_dict(compact=True)['aimeinMemory']['profiles'], 2)
        with self.assertRaises(AimeinError): update_memory(state, dict(action='save', expectedRevision=0, document=doc()), configs())
        with self.assertRaises(AimeinError): memory({'valid': False, 'status': 'invalid'})
        with self.assertRaises(AimeinError): memory({'profiles': [{'document': {'focus': '中' * 310000}}]})

    def test_recommendations_explain_unknown_and_do_not_treat_preferences_as_ability(self):
        state = LoopState('s')
        for i in range(3): save(state, document=doc(i))
        first = state.aimein_memory['profiles'][0]
        state.aimein_memory['calibrations'] = [dict(profileId=first['id'], revision=first['document']['revision'], kind='preference', backendRevision=backend_revision(doc(), configs()))]
        ranked = recommendations(state.aimein_memory, '产品保存和恢复体验', configs())
        self.assertTrue(all(r['samples'] == 0 for r in ranked))
        self.assertEqual(sum(r['recommended'] for r in ranked), 3)
        self.assertTrue(all('样本不足' in r['reasons'][-1] for r in ranked))
        state.aimein_memory['calibrations'][0]['kind'] = 'unsuitable'
        ranked = recommendations(state.aimein_memory, '产品保存', configs())
        self.assertFalse(next(r for r in ranked if r['profileId'] == first['id'])['recommended'])
        self.assertTrue(all(not r['available'] for r in recommendations(state.aimein_memory, '', [])))

    def test_model_diversity_snapshot_and_stale_model_configuration(self):
        state = LoopState('s')
        for i in range(3): save(state, document=doc(i))
        ids = [p['id'] for p in state.aimein_memory['profiles']]
        with self.assertRaises(AimeinError): save(state, 'select', profileIds=[ids[0]] * 3)
        for count in (1, 2):
            save(state, 'select', profileIds=ids[:count])
            self.assertEqual(len(state.policy.aimein_reviewers), count)
        save(state, 'select', profileIds=ids)
        frozen = profile_snapshot(state.policy.aimein_reviewers[0], state.aimein_memory)
        save(state, document={**doc(), 'model': 'another-model'}, profileId=ids[0])
        self.assertEqual(frozen['model'], 'model-0')
        with self.assertRaises(AimeinError): profile_snapshot(state.policy.aimein_reviewers[0], state.aimein_memory)

    def test_feedback_mapping_cannot_omit_invent_or_pretend_applied_is_verified(self):
        state = LoopState('s', goal='G')
        addon = Addon('a', '可恢复保存', feedback=feedback_anchor(state, {'kind': 'goal', 'seq': 0}))
        state.addons.append(addon)
        mapping = [dict(addonId='a', disposition='planned', reason='加入恢复条件', criteriaIds=['C1'])]
        record = LoopRecord(1, aimein_run={'feedbackPlan': feedback_plan(mapping, [{'id': 'a'}], plan())})
        for bad in ([], mapping * 2, [{**mapping[0], 'criteriaIds': ['missing']}], [{**mapping[0], 'disposition': 'deferred'}]):
            with self.assertRaises(AimeinError): feedback_plan(bad, [{'id': 'a'}], plan())
        apply_feedback(state, record)
        self.assertEqual(addon.feedback['status'], 'planned')
        apply_feedback(state, record, set())
        self.assertEqual(addon.feedback['status'], 'needs_work')
        apply_feedback(state, record, {'C1'})
        self.assertEqual(addon.feedback['status'], 'verified')
        self.assertEqual(len(addon.feedback['history']), 3)
        self.assertEqual(Addon.from_dict(addon.to_dict()).feedback, addon.feedback)
        record.aimein_run['feedbackPlan'][0].update(reason='中' * 1600, criteriaIds=['中' * 80] * 24)
        for seq in range(2, 10):
            record.seq = seq
            apply_feedback(state, record, set())
        self.assertEqual(Addon.from_dict(addon.to_dict()).feedback, addon.feedback)
        self.assertLess(len(addon.feedback['history']), 6)

    def test_late_feedback_is_for_next_boundary(self):
        state = LoopState('s', goal='G')
        scope = scope_revision(state)
        addon = Addon('late', 'later', feedback={'kind': 'flow', 'status': 'pending'})
        state.addons.append(addon)
        record = LoopRecord(1, aimein_run={'scopeAddonIds': []})
        self.assertFalse(addon_in_scope(addon, record))
        self.assertEqual(scope, scope_revision(state, []))
        self.assertNotEqual(scope, scope_revision(state))
        record.aimein_run = {'scopeAddonIds': ['late'], 'feedbackPlan': [{'addonId': 'late', 'disposition': 'deferred'}]}
        self.assertFalse(addon_in_scope(addon, record))

    def test_calibration_must_bind_actual_profile_and_does_not_accumulate_duplicates(self):
        state = LoopState('s')
        save(state, document=doc())
        profile = state.aimein_memory['profiles'][0]
        state.loops = [LoopRecord(1, completed=True, aimein_run={'reviews': [dict(id='review1', model='model-0', status='passed', profile={'id': profile['id'], **profile['document'], 'backendRevision': backend_revision(doc(), configs())})]})]
        for _ in range(3): save(state, 'calibrate', seq=1, reviewId='review1', kind='confirmed', note='实际使用验证了这个判断')
        self.assertEqual(len(state.aimein_memory['calibrations']), 1)
        self.assertEqual(recommendations(state.aimein_memory, '产品', configs())[0]['samples'], 1)
        changed = configs(); changed[0].base_url = 'http://different-provider.invalid'
        self.assertEqual(recommendations(state.aimein_memory, '产品', changed)[0]['samples'], 0)
        with self.assertRaises(AimeinError): save(state, 'calibrate', seq=999, reviewId='review1', kind='confirmed', note='不存在的评审')
        save(state, profileId=profile['id'], document={**doc(), 'focus': '新聚焦'})
        self.assertEqual(recommendations(state.aimein_memory, '产品', configs())[0]['samples'], 0)


class LearningLifecycle(unittest.IsolatedAsyncioTestCase):
    setUp = base.AimeinLifecycle.setUp
    run_attempt = base.AimeinLifecycle.run_attempt
    async def test_frozen_profile_input_and_calibration_between_attempts(self):
        for i in range(3): save(self.state, document=doc(i))
        ids = [p['id'] for p in self.state.aimein_memory['profiles']]
        save(self.state, 'select', profileIds=ids)
        first = await self.run_attempt()
        review0 = first.aimein_run['reviews'][0]
        self.assertEqual(review0['profile']['focus'], doc()['focus'])
        calls = [c for c in self.calls if c[0].startswith('aimein-review')]
        for i, call in enumerate(calls):
            self.assertIn(f'体验评委 {i}', call[1])
            self.assertNotIn(f'体验评委 {(i + 1) % 3}', call[1])
        save(self.state, 'calibrate', seq=first.seq, reviewId='review1', kind='missed', note='漏掉首次使用的失败提示')
        self.calls.clear()
        await self.run_attempt()
        calls = [c for c in self.calls if c[0].startswith('aimein-review')]
        self.assertIn('漏掉首次使用', calls[0][1])
        self.assertNotIn('漏掉首次使用', calls[1][1])
        self.assertFalse(review0['profile']['calibrations'])

    async def test_feedback_enters_plan_and_only_shared_verification_closes(self):
        addon = Addon('opinion', '保存失败需要提示', feedback=feedback_anchor(self.state, {'kind': 'flow', 'seq': 0}))
        self.state.addons.append(addon)
        original = self.bridge._loop_run_agent
        async def agent(session, prompt, stage, seq, **kwargs):
            raw, result = await original(session, prompt, stage, seq, **kwargs)
            if stage == 'aimein-plan':
                self.assertIn('opinion', prompt)
                parsed = json.loads(raw)
                parsed['aimeinFeedback'] = [dict(addonId='opinion', disposition='planned', reason='验收保存反馈', criteriaIds=['C1'])]
                raw = json.dumps(parsed)
            return raw, result
        self.bridge._loop_run_agent = agent
        self.passed = False
        await self.run_attempt()
        self.assertEqual(addon.feedback['status'], 'needs_work')
        self.passed = True
        await self.run_attempt()
        self.assertEqual(addon.feedback['status'], 'verified')
        self.assertTrue(all('保存失败需要提示' in c[1] for c in self.calls if c[0].startswith('aimein-review')))

    async def test_resume_preserves_old_profile_after_document_edit(self):
        for i in range(3): save(self.state, document=doc(i))
        ids = [p['id'] for p in self.state.aimein_memory['profiles']]
        save(self.state, 'select', profileIds=ids)
        record = await self.run_attempt()
        record.completed = False; record.terminal_kind = ''; record.sub_stage = 'analysis'
        record.aimein_run['reviews'][2]['status'] = 'pending'
        save(self.state, document={**doc(2), 'focus': '新版本专属关注点'}, profileId=ids[2])
        self.calls.clear()
        await self.run_attempt()
        prompt = next(c[1] for c in self.calls if c[0] == 'aimein-review3')
        self.assertNotIn('新版本专属关注点', prompt)
        self.assertIn(doc(2)['focus'], prompt)

    async def test_late_feedback_does_not_invalidate_current_review_or_complete_goal(self):
        self.complete = True
        original = self.bridge._loop_run_agent
        async def agent(*args, **kwargs):
            result = await original(*args, **kwargs)
            if args[2] == 'aimein-review1':
                self.state.addons.append(Addon('late', '补充意见', feedback={'kind': 'goal', 'status': 'pending'}))
            return result
        self.bridge._loop_run_agent = agent
        record = await self.run_attempt()
        self.assertTrue(record.completed)
        self.assertFalse(record.aimein_run['complete'])
        self.assertNotEqual(self.state.stage, 'loopout')

    async def test_rpc_active_and_stale_guards(self):
        self.bridge._loop_is_running = lambda _: True
        result = json.loads(self.bridge._rpc_loopAimeinUpdate(self.session.id, json.dumps(dict(action='save', expectedRevision=0, document=doc()))))
        self.assertEqual(result['status'], 'error')
        self.assertFalse(self.state.aimein_memory)
        self.bridge._loop_is_running = lambda _: False
        self.bridge._loop_has_active_call = lambda _: False
        result = json.loads(self.bridge._rpc_loopAimeinUpdate(self.session.id, json.dumps(dict(action='save', expectedRevision=0, document=doc()))))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(json.loads(self.bridge._rpc_loopAimeinGet(self.session.id))['memory']['revision'], 1)
