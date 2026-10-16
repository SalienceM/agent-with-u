const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LoopContractController, contractSnapshotStale } = require('../../.home-test-dist/utils/loopContractController.js');
const eligibility = { canRequest: true, causeRef: 'contract:one', causeRevision: 1, round: 1, seq: 1, controlRevision: 0 };
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const calls = [], updates = [];
  const transport = { request: async p => { calls.push(['write', p]); return { status: 'accepted', operation: { ...p, status: 'running' } }; },
    get: async id => { calls.push(['read', id]); return { status: 'ok', operation: { requestId: id, status: 'unknown' } }; },
    cancel: async id => { calls.push(['cancel', id]); return { status: 'accepted' }; }, ...overrides };
  const controller = new LoopContractController(transport, value => updates.push(value), () => 'same-request');
  controller.receive(eligibility);
  return { controller, calls, updates };
}
test('view is zero writes; double clicks and active receipt never submit twice', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  await Promise.all([f.controller.request(eligibility), f.controller.request(eligibility)]);
  await f.controller.request(eligibility);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].requestId, 'same-request');
});
test('unknown result gets one coalesced read, never replays a write or polls', async () => {
  let writes = 0, reads = 0;
  const gate = defer();
  const f = fixture({ request: async () => { writes++; throw Error('timeout'); },
    get: async id => { reads++; await gate.promise; return { status: 'ok', operation: { requestId: id, status: 'unknown' } }; } });
  const first = f.controller.request(eligibility);
  await new Promise(resolve => setImmediate(resolve));
  const query = f.controller.check();
  gate.resolve(); await Promise.all([first, query]);
  await f.controller.request(eligibility);
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(f.controller.feedback.receipt.status, 'unknown');
});
test('terminal push beats late query and old owner/session controller cannot update', async () => {
  const gate = defer();
  const f = fixture({ get: () => gate.promise });
  await f.controller.request(eligibility);
  const query = f.controller.check();
  f.controller.receive(eligibility, { requestId: 'same-request', status: 'succeeded' });
  gate.resolve({ status: 'ok', operation: { requestId: 'same-request', status: 'running' } });
  await query;
  assert.equal(f.controller.feedback.receipt.status, 'succeeded');
  const pending = defer();
  const old = fixture({ request: () => pending.promise });
  const request = old.controller.request(eligibility);
  old.controller.dispose(); const count = old.updates.length;
  pending.resolve({ status: 'accepted' }); await request;
  assert.equal(old.updates.length, count);
});
test('offline, unsupported and changed cause never fall back to running', async () => {
  const f = fixture();
  await f.controller.request(eligibility, false);
  await f.controller.request(undefined);
  assert.equal(f.calls.length, 0);
  const gate = defer();
  const stale = fixture({ request: () => gate.promise });
  const request = stale.controller.request(eligibility);
  stale.controller.receive({ ...eligibility, causeRevision: 2 });
  gate.resolve({ status: 'ok', operation: { requestId: 'same-request', status: 'succeeded' } });
  await request;
  assert.notEqual(stale.controller.feedback.receipt.status, 'succeeded');
});

test('old compact receipt cannot replace current operation or regress a committed result', async () => {
  const f = fixture();
  await f.controller.request(eligibility);
  f.controller.receive(eligibility, { requestId: 'previous-request', status: 'succeeded' });
  assert.equal(f.controller.feedback.receipt.requestId, 'same-request');
  f.controller.receive(eligibility, { requestId: 'same-request', status: 'succeeded' });
  f.controller.receive(eligibility, { requestId: 'same-request', status: 'running' });
  assert.equal(f.controller.feedback.receipt.status, 'succeeded');
  assert.equal(contractSnapshotStale({ causeRef: 'new', causeRevision: 3 }, { causeRef: 'old', causeRevision: 2 }), true);
});
