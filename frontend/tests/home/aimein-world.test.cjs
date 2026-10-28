const test = require('node:test');
const assert = require('node:assert/strict');
const { goalObservation, worldProjection, targetPosition } = require('../../.home-test-dist/utils/aimeinWorld.js');
const { flowProjection, flowTransitions, planWaitingMessage } = require('../../.home-test-dist/utils/aimeinWorld.js');

test('initial planning and delayed detail never fabricate targets, flow or coverage', () => {
  for (const plan of [undefined, {}, { targets: [] }, { sprint: {} }]) {
    const r = { seq: 1, completed: false, orchestration: [], aimeinRun: { plan }, aimeinSummary: { status: 'planning' } };
    assert.deepEqual(worldProjection(r).targets, []);
    assert.equal(goalObservation(r).known, false);
    const flow = flowProjection(r, true, true);
    assert.equal(flow.ready, false); assert.equal(flow.live, false);
    assert.deepEqual(flow.activity, []); assert.deepEqual(flow.saved, []);
    assert.equal(flow.verified, 0);
    assert.match(planWaitingMessage(r, true), /正在拆解目标/);
    assert.match(planWaitingMessage({ ...r, detailLoaded: false }, true), /正在读取/);
    assert.match(planWaitingMessage(r, false), /尚未生成/);
    assert.match(planWaitingMessage({ ...r, error: '规划失败' }, true), /尚未生成/);
    assert.match(planWaitingMessage({ ...r, aimeinSummary: { status: 'blocked' } }, true), /尚未生成/);
  }
  assert.equal(planWaitingMessage(undefined, false), '');
  assert.equal(planWaitingMessage(record(), false), '');
});

function record() {
  return { completed: true, aimeinRun: { plan: { targets: [{ id: 'a' }, { id: 'b' }] }, reviews: [0, 1, 2].map(() => ({ status: 'passed',
    targets: [{ id: 'a', status: 'verified', fingerprints: { file: 'hash' } }, { id: 'b', status: 'gap' }] })) } };
}
test('goal vessel uses unanimous whole-target evidence instead of maturity or attempts', () => {
  const value = record(); value.maturity = 100; value.attempt = 99;
  assert.equal(goalObservation(value).fraction, .5);
  value.aimeinRun.reviews[2].targets[0].status = 'gap';
  assert.equal(goalObservation(value).fraction, 0);
});

test('3D projection waits for actual targets and never infers sprint membership from counts', () => {
  assert.deepEqual(worldProjection({ seq: 1, completed: false, aimeinSummary: { targetCount: 12 } }).targets, []);
  const r = record(); r.seq = 1;
  r.aimeinRun.plan.targets[0].dependsOn = [];
  r.aimeinRun.plan.targets[1].dependsOn = ['a'];
  r.aimeinRun.plan.sprint = { criteria: [{ targetId: 'b' }] };
  const view = worldProjection(r);
  assert.deepEqual(view.targets.map(t => [t.id, t.inSprint, t.verified]), [['a', false, true], ['b', true, false]]);
  assert.deepEqual(targetPosition(0, view.targets, 'split'), targetPosition(0, view.targets, 'cluster'));
  assert.notDeepEqual(targetPosition(1, view.targets, 'split'), targetPosition(1, view.targets, 'cluster'));
});

test('3D layout basis changes with stage or history, not scores or repeated pushes', () => {
  const r = record(); r.seq = 2; r.aimeinRun.plan.sprint = { criteria: [{ targetId: 'a' }] };
  r.aimeinSummary = { status: 'preparing', maturityTarget: 20 };
  const before = worldProjection(r);
  r.aimeinSummary.maturityTarget = 90;
  assert.equal(worldProjection(r).basis, before.basis);
  r.aimeinSummary.status = 'executing';
  assert.equal(worldProjection(r).layout, 'cluster');
  assert.notEqual(worldProjection(r).basis, before.basis);
  const current = worldProjection(r).basis; r.seq = 1;
  assert.notEqual(worldProjection(r).basis, current);
});
test('goal vessel remains unknown for missing, partial or legacy unversioned evidence', () => {
  assert.equal(goalObservation().known, false);
  const value = record(); value.completed = false;
  assert.equal(goalObservation(value).known, false);
  value.completed = true; value.aimeinRun.reviews[0].status = 'error';
  assert.equal(goalObservation(value).known, false);
  value.aimeinRun.reviews[0].status = 'passed'; delete value.aimeinRun.reviews[0].targets[0].fingerprints;
  assert.equal(goalObservation(value).known, false);
});

function flowRecord(status = 'preparing') {
  const r = record(); r.seq = 1; r.completed = false;
  r.aimeinRun.plan.sprint = { criteria: [{ targetId: 'a', lane: 'flow' }, { targetId: 'b', lane: 'infra' }] };
  r.aimeinSummary = { sprintId: '1:1', attempt: 1, status, reviews: [0, 1, 2].map(i => ({ id: `r${i}`, status: 'running' })) };
  r.orchestration = [{ index: 1, status: 'running', output: '' }, { index: 2, status: 'pending', output: '' }];
  return r;
}
test('flow events ignore hydration, repeated messages, history and a different attempt', () => {
  const r = flowRecord(); const before = flowProjection(r, true, true);
  r.aimeinSummary.status = 'executing'; const next = flowProjection(r, true, true);
  assert.deepEqual(flowTransitions(before, next), ['build', 'infra']);
  assert.deepEqual(flowTransitions(undefined, next), []);
  assert.deepEqual(flowTransitions({ ...before, ready: false }, next), []);
  assert.deepEqual(flowTransitions(next, flowProjection(r, true, true)), []);
  assert.deepEqual(flowTransitions(before, flowProjection(r, true, false)), []);
  r.seq++; assert.deepEqual(flowTransitions(before, flowProjection(r, true, true)), []);
});
test('ant traffic needs actual running and saved piles need nonempty completed output', () => {
  const r = flowRecord('executing'); const before = flowProjection(r, true, true);
  assert.deepEqual(before.activity, ['build', 'infra', 'store']); assert.deepEqual(before.saved, []);
  assert.deepEqual(flowProjection(r, false, true).activity, []);
  assert.deepEqual(flowProjection(r, true, false).activity, []);
  r.orchestration[0].status = 'done'; assert.deepEqual(flowProjection(r, true, true).saved, []);
  r.orchestration[0].output = '已保存实现结果';
  const next = flowProjection(r, true, true); assert.deepEqual(next.saved, [1]);
  assert.deepEqual(flowTransitions(before, next), ['store']);
  assert.equal(next.verified, 0);
  r.completed = true; assert.deepEqual(flowProjection(r, true, true).activity, []);
});
test('review branches remain independent, repair preserves outputs, only unanimous evidence injects vessel', () => {
  const r = flowRecord('executing'); r.orchestration[0] = { index: 1, status: 'done', output: 'result' };
  const before = flowProjection(r, true, true); r.aimeinSummary.status = 'reviewing';
  const reviewing = flowProjection(r, true, true);
  assert.deepEqual(flowTransitions(before, reviewing), ['review0', 'review1', 'review2']);
  r.aimeinSummary.reviews[1].status = 'passed';
  assert.deepEqual(flowProjection(r, true, true).activity, ['review0', 'review2']);
  r.aimeinSummary.status = 'repair'; r.completed = true;
  const repair = flowProjection(r, false, true);
  assert.deepEqual(flowTransitions(reviewing, repair), ['repair', 'verify0', 'verify1', 'verify2']);
  assert.deepEqual(repair.saved, [1]);
  r.aimeinRun.reviews[2].status = 'error';
  assert.deepEqual(flowTransitions(reviewing, flowProjection(r, false, true)), ['repair']);
});
