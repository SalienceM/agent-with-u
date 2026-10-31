const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectAimeinRecord, readCollection, aimeinDataMessages } = require('../../.home-test-dist/utils/aimeinRecordData.js');
const { aimeinRuntime, aimeinStageLabel, aimeinObservation } = require('../../.home-test-dist/utils/aimeinRuntime.js');
const { reviewOverview } = require('../../.home-test-dist/utils/aimeinReviewSummary.js');
const { goalObservation, worldProjection, flowProjection } = require('../../.home-test-dist/utils/aimeinWorld.js');
const { loopRecordRevision } = require('../../.home-test-dist/utils/loopRecordDetail.js');
const record = () => ({ seq: 1, round: 1, completed: true, error: '', subStage: 'done', orchestration: [], aimeinSummary: {}, aimeinRun: {} });
const state = r => ({ loops: [r], running: false, round: 1, goal: '合成目标', resumable: false });

test('backend no-attempt empty summary is absent in view without mutating raw data', () => {
  const raw = record(), before = JSON.stringify(raw);
  const view = projectAimeinRecord(raw);
  assert.equal(view.aimeinSummary, undefined);
  assert.equal(view.aimeinData.collections.orchestration, 'empty');
  assert.deepEqual(aimeinDataMessages(view.aimeinData), []);
  assert.equal(JSON.stringify(raw), before);
});

test('missing, explicit empty, wrong type and wrong member remain distinct', () => {
  for (const [value, expected] of [[undefined, 'missing'], [[], 'empty'], [null, 'invalid'], [{}, 'invalid'], ['bad', 'invalid'], [[null], 'invalid']]) {
    const r = projectAimeinRecord({ ...record(), orchestration: value });
    assert.equal(readCollection(value).state, expected);
    assert.equal(r.aimeinData.collections.orchestration, expected);
    assert.doesNotThrow(() => aimeinRuntime(state(r), r, {}));
    assert.equal(aimeinStageLabel('step1', { orchestration: value }), '执行步骤 1');
    assert.equal(aimeinObservation(state(r), r).stepState, expected);
    assert.equal(aimeinObservation(state(r), r).savedKnown, expected === 'empty');
  }
});

test('missing/invalid summary collections cannot earn acceptance or erase their diagnostic', () => {
  for (const value of [undefined, null, {}, 'bad', [null], []]) {
    const r = projectAimeinRecord({ ...record(), aimeinSummary: { status: 'accepted', accepted: true, complete: true, reviews: value, criteria: value, issues: value } });
    assert.equal(r.aimeinSummary.accepted, false);
    assert.equal(r.aimeinSummary.complete, false);
    assert.equal(reviewOverview(r.aimeinSummary, r.aimeinRun).accepted, false);
    assert.doesNotThrow(() => worldProjection(r));
    assert.doesNotThrow(() => flowProjection(r, false, true));
    if (!Array.isArray(value) || value.length) assert.ok(aimeinDataMessages(r.aimeinData).length);
  }
});

test('null/invalid detail collections preserve unknown coverage across scene and review views', () => {
  for (const value of [null, {}, 'bad', [null]]) {
    const raw = { ...record(), aimeinRun: { reviews: value, plan: { targets: value, sprint: { criteria: value, deferred: value } } } };
    const r = projectAimeinRecord(raw);
    assert.equal(goalObservation(r).known, false);
    assert.doesNotThrow(() => worldProjection(r));
    assert.doesNotThrow(() => flowProjection(r, false, true));
    assert.ok(aimeinDataMessages(r.aimeinData).every(text => text.includes('格式异常')));
  }
});

test('valid reports retain full acceptance and malformed report members cannot become complete', () => {
  const review = { id: 'r1', model: 'model', status: 'passed',
    criteria: [{ id: 'C1', status: 'verified', reason: '合成证据', evidence: ['a'] }],
    targets: [{ id: 'T1', status: 'verified', reason: '合成证据', evidence: ['a'], fingerprints: { a: 'hash' } }] };
  const raw = { ...record(), orchestration: [{ index: 1, status: 'done', desc: '已保存步骤', output: '正文' }],
    aimeinSummary: { reviewerCount: 1, status: 'accepted', accepted: true, complete: true, reviews: [review], criteria: [{ id: 'C1', lane: 'flow', acceptance: '验收' }], issues: [] },
    aimeinRun: { reviewerCount: 1, reviews: [review], plan: { targets: [{ id: 'T1', title: '目标', acceptance: '标准', dependsOn: [] }], sprint: { criteria: [{ id: 'C1', targetId: 'T1', lane: 'flow' }] } } } };
  const r = projectAimeinRecord(raw);
  assert.equal(reviewOverview(r.aimeinSummary, r.aimeinRun).accepted, true);
  assert.equal(goalObservation(r).known, true);
  assert.equal(aimeinRuntime(state(r), r, {}).channel.text, '正文');
  assert.equal(aimeinObservation(state(r), r).saved, 1);
  for (const value of [undefined, null, {}, [null], [{ id: 'C1', status: 'verified', reason: '', evidence: null }]]) {
    const malformed = projectAimeinRecord({ ...raw, aimeinRun: { ...raw.aimeinRun, reviews: [{ ...review, criteria: value }] } });
    assert.equal(reviewOverview(malformed.aimeinSummary, malformed.aimeinRun).accepted, false);
    assert.equal(goalObservation(malformed).known, false);
  }
});

test('revision key distinguishes absent, invalid and empty orchestration before detail load', () => {
  const keys = [undefined, [], null, {}, 'bad', [null]].map(value => loopRecordRevision({ ...record(), orchestration: value }));
  assert.equal(new Set(keys).size, keys.length);
});

test('compact output does not claim zero saved steps before details are read', () => {
  const r = projectAimeinRecord({ ...record(), detailLoaded: false, orchestration: [{ index: 1, status: 'done', desc: '保存', output: '' }] });
  assert.equal(aimeinObservation(state(r), r).savedKnown, false);
});
