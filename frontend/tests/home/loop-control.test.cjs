const assert = require('node:assert/strict');
const { test } = require('node:test');
const { LoopControlStore, controlBusy } = require('../../.home-test-dist/utils/loopControl.js');
const target = { user: 'local', executor: 'node-a', session: 's' };

test('late failed Get never downgrades committed view-loading or a newer hydration stage', async () => {
  for (const hydrated of [false, true]) {
    let reject;
    const { store, calls } = fixture({ get: () => { calls.get++; return new Promise((_, fail) => { reject = fail; }); } });
    store.receive(target, summary(1, op()));
    const read = store.check(target); await Promise.resolve();
    store.receive(target, summary(2, op('succeeded', 4)));
    if (hydrated) store.view(target, 2);
    reject(new Error('old offline')); await read;
    assert.equal(store.get(target).phase, hydrated ? 'succeeded' : 'view-loading');
    assert.equal(store.get(target).summary.controlRevision, 2);
    assert.equal(store.get(target).summary.eligibility.release.allowed, true);
    assert.equal(store.get(target).error, ''); assert.equal(store.get(target).checking, false);
    assert.equal(calls.request, 0);
  }
});

test('a new read failure during committed hydration retains ownership and hydration phase', async () => {
  const { store } = fixture({ get: async () => { throw Error('offline'); } });
  store.receive(target, summary(2, op('succeeded', 4))); await store.check(target);
  assert.equal(store.get(target).phase, 'view-loading');
  assert.equal(store.get(target).summary.operation.committed, true);
});
const summary = (rev = 0, operation) => ({ protocolVersion: 1, sessionId: 's', controlMode: rev >= 2 ? 'manual' : 'loop',
  controlRevision: rev, auto: false, stage: 'loopexecute', round: 1,
  eligibility: { takeover: { allowed: true }, release: { allowed: true } }, operation });
const op = (status = 'running', revision = 1) => ({ requestId: 'one', action: 'takeover', status,
  phase: 'snapshot', revision, startedAt: 1, updatedAt: 1, committed: status === 'succeeded' });
function fixture(overrides = {}) {
  const calls = { get: 0, request: 0, apply: 0 };
  const store = new LoopControlStore({
    requestId: () => 'one', apply: () => calls.apply++,
    get: async () => { calls.get++; return summary(); },
    request: async () => { calls.request++; return summary(1, op()); }, ...overrides,
  });
  return { store, calls };
}
test('immediate sending and double clicks yield a single request', async () => {
  let finish;
  const { store, calls } = fixture({ request: async () => { calls.request++; return new Promise(r => finish = r); } });
  store.receive(target, summary());
  const first = store.request(target, 'takeover');
  assert.equal(store.get(target).phase, 'sending');
  await store.request(target, 'release');
  assert.equal(calls.request, 1);
  finish(summary(1, op())); await first;
  assert.equal(store.get(target).phase, 'running');
});
test('push-before-response and old revisions never undo committed ownership or hydration', async () => {
  let finish;
  const { store } = fixture({ request: () => new Promise(r => finish = r) });
  store.receive(target, summary());
  const request = store.request(target, 'takeover');
  store.receive(target, summary(2, op('succeeded', 5)));
  store.view(target, 2);
  finish(summary(1, op())); await request;
  assert.equal(store.get(target).phase, 'succeeded');
  store.receive(target, summary(2, op('succeeded', 5)));
  assert.equal(store.get(target).phase, 'succeeded');
  store.view(target, 1, 'stale failure');
  assert.equal(store.get(target).phase, 'succeeded');
});
test('lost request and failed query stop loading, coalesce reads and never retry writes', async () => {
  let reads = 0, writes = 0;
  const { store } = fixture({ request: async () => { writes++; throw new Error('timeout'); },
    get: async () => { reads++; throw new Error('offline'); } });
  store.receive(target, summary());
  await store.request(target, 'takeover');
  assert.equal(store.get(target).phase, 'reconciling');
  assert.equal(store.get(target).checking, false);
  assert.equal(controlBusy(store.get(target)), true);
  await Promise.all([store.check(target), store.check(target), store.check(target)]);
  assert.equal(reads, 2); assert.equal(writes, 1);
});
test('user executor and session isolation survives late completion', () => {
  const { store } = fixture();
  const others = [{ ...target, user: 'b' }, { ...target, executor: 'node-b' }, { ...target, session: 'b' }];
  store.receive(target, summary(2, op('succeeded', 4)));
  for (const other of others) assert.equal(store.get(other).phase, 'idle');
});
test('view failure retries only view state, not handoff', () => {
  const { store, calls } = fixture();
  store.receive(target, summary(2, op('succeeded', 4)));
  store.view(target, 2, 'chat unavailable');
  assert.equal(store.get(target).phase, 'view-error');
  store.view(target, 2);
  assert.equal(store.get(target).phase, 'succeeded');
  assert.equal(calls.request, 0);
});
test('historical requested receipt cannot replace a newer current operation', () => {
  const { store } = fixture();
  const current = { ...op(), requestId: 'new', controlRevision: 3 };
  store.receive(target, summary(3, current));
  store.receive(target, { ...summary(3, { ...op('succeeded'), controlRevision: 2 }), currentOperation: current });
  assert.equal(store.get(target).requestId, 'new');
  assert.equal(store.get(target).phase, 'running');
  store.receive(target, summary(3, { ...op('succeeded'), controlRevision: 2 }));
  assert.equal(store.get(target).requestId, 'new');
});
test('old read cannot release locally sending state or start a second mutation', async () => {
  let complete;
  const { store, calls } = fixture({ request: async () => { calls.request++; return new Promise(r => complete = r); } });
  store.receive(target, summary(2, { ...op('succeeded'), requestId: 'old', controlRevision: 2 }));
  store.view(target, 2);
  const sending = store.request(target, 'release');
  store.receive(target, summary(2, { ...op('succeeded'), requestId: 'old', controlRevision: 2 }));
  assert.equal(store.get(target).phase, 'sending');
  await store.request(target, 'release');
  assert.equal(calls.request, 1);
  complete(summary(3, { ...op(), controlRevision: 3 })); await sending;
});
test('definite failure retries explicitly with goal retained only in memory', async () => {
  const inputs = [];
  let id = 0;
  const { store } = fixture({ requestId: () => `r${++id}`, request: async (_target, input) => {
    inputs.push(input);
    return summary(id, { ...op('failed'), requestId: input.requestId, controlRevision: id, message: 'disk failed' });
  } });
  store.receive(target, summary());
  await store.request(target, 'takeover', 'new round goal');
  assert.equal(store.get(target).phase, 'failed');
  assert.equal(inputs.length, 1);
  await store.retry(target);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].goal, 'new round goal');
  assert.notEqual(inputs[1].requestId, inputs[0].requestId);
});
test('unreachable executor never leaves a previously allowed button enabled', async () => {
  const { store } = fixture({ get: async () => { throw new Error('offline'); } });
  store.receive(target, summary());
  await store.check(target);
  assert.equal(store.get(target).summary.eligibility.takeover.allowed, false);
  assert.equal(store.get(target).summary.eligibility.release.allowed, false);
  store.receive(target, summary());
  assert.equal(store.get(target).summary.eligibility.takeover.allowed, true);
});

test('successive handoffs ignore the previous view while sending and retain the new identity', async () => {
  let settle, id = 0;
  const remembered = [];
  const { store, calls } = fixture({ requestId: () => `next-${++id}`,
    remember: (_target, value) => remembered.push(value),
    request: () => { calls.request++; return new Promise(resolve => { settle = resolve; }); } });
  store.receive(target, summary(2, { ...op('succeeded'), requestId: 'old', controlRevision: 2 }));
  store.view(target, 2);
  for (const [action, revision] of [['release', 2], ['takeover', 4]]) {
    const request = store.request(target, action);
    const requestId = store.get(target).requestId;
    store.view(target, revision);
    store.view(target, revision, 'late old view failure');
    assert.equal(store.get(target).phase, 'sending');
    assert.equal(controlBusy(store.get(target)), true);
    assert.equal(remembered.at(-1).requestId, requestId);
    await store.request(target, action);
    assert.equal(calls.request, id);
    const result = summary(revision + 2, { ...op('succeeded', 5), action, requestId, controlRevision: revision + 2 });
    result.controlMode = action === 'takeover' ? 'manual' : 'loop';
    settle(result); await request;
    assert.equal(store.get(target).phase, 'view-loading');
    store.view(target, revision); // 旧界面即使迟到也不能完成新界面的加载。
    assert.equal(store.get(target).phase, 'view-loading');
    store.view(target, revision + 2);
    assert.equal(store.get(target).phase, 'succeeded');
  }
});

test('new request timeout after previous success reconciles exactly once without another write', async () => {
  let reject, reads = 0, writes = 0;
  const old = summary(2, { ...op('succeeded'), requestId: 'old', controlRevision: 2 });
  const { store } = fixture({ requestId: () => 'new-release',
    request: () => { writes++; return new Promise((_resolve, fail) => { reject = fail; }); },
    get: async () => { reads++; return old; } });
  store.receive(target, old); store.view(target, 2);
  const request = store.request(target, 'release');
  reject(new Error('timeout')); await request;
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(store.get(target).phase, 'reconciling');
  assert.equal(store.get(target).requestId, 'new-release');
  assert.equal(store.get(target).checking, false);
  store.view(target, 2);
  assert.equal(controlBusy(store.get(target)), true);
});

test('matching committed push still wins over a late timeout of the same request', async () => {
  let reject;
  const { store, calls } = fixture({ request: () => new Promise((_resolve, fail) => { reject = fail; }) });
  store.receive(target, summary());
  const request = store.request(target, 'takeover');
  store.receive(target, summary(2, op('succeeded', 5)));
  store.view(target, 2);
  reject(new Error('late timeout')); await request;
  assert.equal(store.get(target).phase, 'succeeded');
  assert.equal(calls.get, 0);
});
