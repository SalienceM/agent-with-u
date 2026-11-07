const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeNodeUpdate, UpdateResultUnknown } = require('../../.home-test-dist/utils/nodeUpdateObservation.js');

function options(read, extra = {}) {
  return { read, requestId: 'request', kind: 'stage', receive() {}, waiting() {}, sleep: async () => {}, ...extra };
}

test('temporary status losses keep tracking the same stage', async () => {
  let reads = 0;
  const statuses = [];
  const result = await observeNodeUpdate(options(async () => {
    if (++reads <= 2) throw Error('offline');
    return { stageRequestId: 'request', phase: reads === 3 ? 'downloading' : 'staged' };
  }, { receive: value => statuses.push(value) }));
  assert.equal(result.phase, 'staged');
  assert.deepEqual(statuses.map(s => s.phase), ['downloading', 'staged']);
});

test('persistent connection failure is bounded and stays unknown', async () => {
  let reads = 0;
  await assert.rejects(observeNodeUpdate(options(async () => { reads++; throw Error('offline'); })), UpdateResultUnknown);
  assert.equal(reads, 6);
});

test('another request cannot be mistaken for our staged download', async () => {
  let reads = 0;
  await assert.rejects(observeNodeUpdate(options(async () => {
    reads++;
    return { stageRequestId: 'different', phase: 'staged' };
  })), UpdateResultUnknown);
  assert.equal(reads, 6);
});

test('lost apply reply is reconciled by exact apply identity', async () => {
  let reads = 0;
  const result = await observeNodeUpdate(options(async () => {
    reads++;
    return reads === 1 ? { phase: 'staged' } : { phase: 'installing', applyRequestId: 'request' };
  }, { kind: 'apply' }));
  assert.equal(result.phase, 'installing');
  assert.equal(reads, 2);
});

test('closed panel stops observation without inventing task cancellation', async () => {
  await assert.rejects(observeNodeUpdate(options(async () => assert.fail('must not read'), { active: () => false })), UpdateResultUnknown);
});
