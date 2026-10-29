const test = require('node:test');
const assert = require('node:assert/strict');
const { goalObservation, worldProjection, targetPosition, taskPage, targetRelations } = require('../../.home-test-dist/utils/aimeinWorld.js');
const { flowProjection, flowTransitions, planWaitingMessage } = require('../../.home-test-dist/utils/aimeinWorld.js');

test('initial planning and delayed detail never fabricate targets, flow or coverage', () => {
  for (const plan of [undefined, {}, { targets: [] }, { sprint: {} }]) {
    const r = { seq: 1, completed: false, orchestration: [], aimeinRun: { plan }, aimeinSummary: { status: 'planning' } };
    assert.deepEqual(worldProjection(r).targets, []);
    assert.equal(goalObservation(r).known, false);
    const flow = flowProjection(r, true, true);
    assert.equal(flow.ready, false); assert.equal(flow.live, true);
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

test('pre-plan traffic requires a real active call and stops on waits, errors and historical selection', () => {
  const r = { seq: 1, completed: false, orchestration: [], callDiagnostics: [{ stage: 'prepare', status: 'running', phase: 'tools' }] };
  assert.deepEqual(flowProjection(r, true, true).activity, ['prepare']);
  r.callDiagnostics[0].stage = 'aimein-plan';
  assert.deepEqual(flowProjection(r, true, true).activity, ['plan']);
  for (const phase of ['retry_wait', 'backend_dispatch', 'turn_accepted', 'environment_wait']) {
    r.callDiagnostics[0].phase = phase; assert.deepEqual(flowProjection(r, true, true).activity, []);
  }
  r.callDiagnostics[0].phase = 'thinking';
  assert.deepEqual(flowProjection(r, false, true).activity, []);
  assert.deepEqual(flowProjection(r, true, false).activity, []);
  r.error = 'failed'; assert.deepEqual(flowProjection(r, true, true).activity, []);
  assert.equal(flowProjection(r, true, true).verified, 0);
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
  assert.equal(targetPosition(0, view.targets, 'split')[1], targetPosition(0, view.targets, 'cluster')[1]);
  assert.notDeepEqual(targetPosition(1, view.targets, 'split'), targetPosition(1, view.targets, 'cluster'));
});

test('task plots stay single-layer, inside their district and separated for every reachable page', () => {
  for (const count of [0, 1, 8, 12, 20, 40]) {
    const targets = Array.from({ length: count }, (_, i) => ({ id: `T${i}`, title: `target ${i}`, dependsOn: i ? [`T${i - 1}`] : [], inSprint: i % 3 === 0, verified: false }));
    const before = JSON.stringify(targets);
    for (const layout of ['split', 'cluster']) {
      const reached = [];
      for (let p = 0; p < taskPage(targets).pages; p++) {
        const page = taskPage(targets, p);
        const positions = page.targets.map((t, i) => { reached.push(t.id); return targetPosition(page.start + i, targets, layout); });
        for (let i = 0; i < positions.length; i++) {
          const [x, y, z] = positions[i];
          assert.equal(y, .24);
          assert.ok(x >= -5.1 && x <= -.7 && z >= -2.1 && z <= 1.3);
          for (let j = 0; j < i; j++) assert.ok(Math.hypot(x - positions[j][0], z - positions[j][2]) >= 1.14);
        }
      }
      assert.deepEqual(reached, targets.map(t => t.id));
    }
    assert.equal(JSON.stringify(targets), before);
    assert.equal(taskPage(targets, -10).page, 0);
    assert.equal(taskPage(targets, 1000).page, taskPage(targets).pages - 1);
  }
});

test('focused dependencies keep direct cross-page and missing relationships without recursive clutter', () => {
  const targets = [{ id: 'a', dependsOn: ['missing', 'b'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }];
  assert.deepEqual(targetRelations(targets, ''), []);
  assert.deepEqual(targetRelations(targets, 'a'), [{ from: 'missing', to: 'a', missing: true }, { from: 'b', to: 'a', missing: false }, { from: 'a', to: 'b', missing: false }]);
  assert.ok(!targetRelations(targets, 'a').some(r => r.to === 'c'));
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

test('goal vessel uses frozen reviewer count, preserving three-report semantics of legacy records', () => {
  for (const count of [1, 2, 3]) {
    const r = record(); r.aimeinRun.reviewerCount = count; r.aimeinRun.reviews = r.aimeinRun.reviews.slice(0, count);
    assert.equal(goalObservation(r).fraction, .5);
    r.aimeinRun.reviews.pop(); assert.equal(goalObservation(r).known, false);
  }
  const r = record(); r.aimeinRun.reviews = r.aimeinRun.reviews.slice(0, 1);
  assert.equal(goalObservation(r).known, false);
  for (const count of [0, 4, '1', null]) { r.aimeinRun.reviewerCount = count; assert.equal(goalObservation(r).known, false); }
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
