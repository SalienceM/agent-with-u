const { test } = require('node:test');
const assert = require('node:assert/strict');
const { blockerLabel, mergeBlockerDetails } = require('../../.home-test-dist/utils/loopTaskBlockers.js');
const { loopRecordRevision } = require('../../.home-test-dist/utils/loopRecordDetail.js');

test('blocker labels do not equate readonly review with permission or acceptance', () => {
  assert.equal(blockerLabel(), '');
  assert.match(blockerLabel({ status: 'running' }), /正在只读复核/);
  assert.match(blockerLabel({ status: 'done', valid: true, readyIds: ['U'] }), /有独立就绪/);
  assert.match(blockerLabel({ status: 'done', valid: true, readyIds: ['T'], affectedIds: [] }), /阻塞已解除.*验收仍待核实/);
  for (const status of ['failed', 'stale', 'unknown', 'unsupported'])
    assert.match(blockerLabel({ status }), /未放行/);
});

test('compact updates preserve lazy evidence without reverting summary status', () => {
  const detail = { blockerSummary: { status: 'running' }, blockerReview: { evidenceRefs: ['original'] },
    taskBlockers: { items: [{ id: 'baseline', resolution: 'readable baseline' }] }, taskPlan: { valid: true } };
  const result = mergeBlockerDetails({ blockerSummary: { status: 'done', readyIds: ['U'] },
    blockerReview: {}, taskBlockers: {}, taskPlan: {} }, detail);
  assert.equal(result.blockerSummary.status, 'done');
  assert.equal(result.taskBlockers.items[0].resolution, 'readable baseline');
  assert.deepEqual(result.blockerReview.evidenceRefs, ['original']);
});

test('blocker summary changes refresh selected detail but evidence bodies do not', () => {
  const record = { seq: 1, subStage: 'analysis', completed: false, error: '', orchestration: [], blockerSummary: { status: 'running' } };
  assert.notEqual(loopRecordRevision(record), loopRecordRevision({ ...record, blockerSummary: { status: 'done', readyIds: ['U'] } }));
  assert.equal(loopRecordRevision(record), loopRecordRevision({ ...record, taskBlockers: { items: ['large body'] } }));
});
