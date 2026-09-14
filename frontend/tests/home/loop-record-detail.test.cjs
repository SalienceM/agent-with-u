const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loopRecordRevision } = require('../../.home-test-dist/utils/loopRecordDetail.js');
const record = { seq: 1, subStage: 'execute', completed: false, error: '', updatedAt: 10,
  orchestration: [{ index: 1, desc: 'run', status: 'running', endedAt: 0 }],
  stageDetails: { prepare: { status: 'done', attemptCount: 1 } } };

test('a completed step invalidates loaded details even if parent timestamp did not change', () => {
  assert.notEqual(loopRecordRevision(record), loopRecordRevision({ ...record,
    orchestration: [{ ...record.orchestration[0], status: 'done', endedAt: 11 }] }));
});
test('full and compact records share a revision; streamed text alone never triggers a detail read', () => {
  assert.equal(loopRecordRevision(record), loopRecordRevision({ ...record, progress: 'text',
    stageDetails: { prepare: { ...record.stageDetails.prepare, attempts: [{ rawOutput: 'long text' }] } } }));
});
test('plan retry and degradation invalidate the audit detail cache', () => {
  assert.notEqual(loopRecordRevision(record), loopRecordRevision({ ...record,
    stageDetails: { prepare: { status: 'retrying', attemptCount: 2 } } }));
});
