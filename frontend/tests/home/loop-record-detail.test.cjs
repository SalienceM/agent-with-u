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

test('environment evidence revisions refresh selected detail; full bodies and identical pushes do not', () => {
  const current = { ...record, environmentChecks: [{ id: 'env', revision: 3, status: 'passed' }] };
  assert.notEqual(loopRecordRevision(current), loopRecordRevision({ ...current,
    environmentChecks: [{ id: 'env-new', revision: 4, status: 'blocked' }] }));
  assert.equal(loopRecordRevision(current), loopRecordRevision({ ...current,
    environmentChecks: [{ id: 'older', revision: 2, status: 'passed' }, { ...current.environmentChecks[0], entry: 'body' }] }));
});

test('stale cleanup evidence refreshes history without a current environment revision change', () => {
  const current = { ...record, environmentChecks: [{ id: 'late', revision: 1, status: 'stale', quiesced: false }] };
  const cleaned = { ...current, environmentChecks: [{ ...current.environmentChecks[0], revision: 2, quiesced: true }] };
  assert.notEqual(loopRecordRevision(current), loopRecordRevision(cleaned));
  assert.equal(loopRecordRevision(cleaned), loopRecordRevision(JSON.parse(JSON.stringify(cleaned))));
});

test('new decisions, source revisions and milestone summaries invalidate but bodies do not', () => {
  const current = { ...record, outcomeVersion: 1, terminalKind: 'paused', decision: { decisionId: 'a', revision: 1 },
    sourceSummary: { before: { scopeDigest: 'scope', stateDigest: 'state' } }, deliverySummary: { milestones: { credited: [] } } };
  assert.notEqual(loopRecordRevision(current), loopRecordRevision({ ...current, decision: { decisionId: 'b', revision: 2 } }));
  assert.notEqual(loopRecordRevision(current), loopRecordRevision({ ...current, deliverySummary: { milestones: { credited: ['shell'] } } }));
  assert.equal(loopRecordRevision(current), loopRecordRevision({ ...current, sourceSnapshots: { huge: 'body' }, milestonePlan: { raw: 'body' } }));
});
