const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activeLoopSeq, mergeCallDiagnostics } = require('../../.home-test-dist/utils/loopDiagnostics.js');
const { loopRecordRevision } = require('../../.home-test-dist/utils/loopRecordDetail.js');

test('old interrupted rounds never capture the live lane', () => {
  const loops = [{ seq: 1, round: 1, completed: false, error: '' }, { seq: 2, round: 2, completed: false, error: '' }];
  assert.equal(activeLoopSeq({ running: true, round: 2, loops }), 2);
  assert.equal(activeLoopSeq({ running: false, round: 2, loops }), null);
  assert.equal(activeLoopSeq({ running: true, round: 3, loops }), null);
});

test('diagnostic activity never refetches full stage text; only call boundaries do', () => {
  const call = { id: 'a', stage: 'prepare', startedAt: 1, observedAt: 2, status: 'running', phase: 'thinking' };
  const record = { seq: 1, subStage: 'prepare', error: '', completed: false, orchestration: [], callDiagnostics: [call] };
  assert.equal(loopRecordRevision(record), loopRecordRevision({ ...record, callDiagnostics: [{ ...call, observedAt: 3, textChars: 100 }] }));
  assert.notEqual(loopRecordRevision(record), loopRecordRevision({ ...record, callDiagnostics: [{ ...call, status: 'done', endedAt: 4 }] }));
  assert.deepEqual(mergeCallDiagnostics([call], [{ ...call, observedAt: 1 }]), [call]);
  assert.equal(mergeCallDiagnostics([call], [{ ...call, endedAt: 4, status: 'done' }])[0].status, 'done');
});
