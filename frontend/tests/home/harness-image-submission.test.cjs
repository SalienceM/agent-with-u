const test = require('node:test');
const assert = require('node:assert/strict');
const { HarnessImageSubmissions, imageSnapshot, imageQuickCheck, imageReceiptLabel } = require('../../.home-test-dist/utils/harnessImageSubmission.js');
const scope = { key: '["owner",1,"node","s"]', owner: 'owner', executor: 'node', session: 's' };
const input = { content: '原稿', images: [{ id: 'img', base64: 'AAAA', mime_type: 'image/png', size: 3 }],
  textAttachments: [{ id: 'text', name: '原文', content: '全文', size: 2 }] };
const draft = { scopeKey: scope.key, draftRevision: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}, maxScopes) {
  let seq = 0, calls = { capabilities: 0, write: [], read: [] };
  const receipt = (payload, state = 'platform_accepted', revision = 1) => ({ version: 1, ownerId: 'owner', sessionId: 's',
    requestId: payload.requestId, state, revision, nativeReceived: ['native_received', 'succeeded', 'failed'].includes(state), reason: '' });
  const io = { current: () => true, id: () => `id-${++seq}`, capabilities: async () => {
    calls.capabilities++; return { version: 1, submit: true, queue: true, status: true };
  }, write: async (_s, queue, payload) => { calls.write.push({ queue, payload }); return receipt(payload, queue ? 'queued' : 'platform_accepted'); },
    read: async (_s, requestId) => { calls.read.push(requestId); return { version: 1, requestId, sessionId: 's', state: 'unknown' }; }, ...overrides };
  return { c: new HarnessImageSubmissions(io, maxScopes), calls, io, receipt };
}
test('completion copy is compact while actionable unknown and rejection states remain explicit', () => {
  const f = fixture(), receipt = f.receipt({ requestId: 'copy' }, 'succeeded');
  assert.equal(imageReceiptLabel(receipt), '本轮已完成');
  assert.match(imageReceiptLabel({ ...receipt, state: 'unknown' }), /结果未知.*勿重复发送/);
  assert.match(imageReceiptLabel({ ...receipt, state: 'not_submitted', reason: 'image_bytes' }), /未提交.*4 MiB/);
  assert.match(imageReceiptLabel({ ...receipt, state: 'failed' }), /接收后执行失败/);
});

test('snapshot allowlist excludes grants and tokens, immutable and quick limits are advisory', () => {
  const snap = imageSnapshot({ ...input, kitApprovalDelegation: true, token: 'secret', skipPermissions: true,
    images: [{ ...input.images[0], token: 'secret' }] }, 1);
  assert.equal(JSON.stringify(snap).includes('secret'), false);
  assert.equal(snap.kitApprovalDelegation, undefined);
  assert(Object.isFrozen(snap.images[0]));
  assert.equal(imageQuickCheck(snap), '');
  assert.equal(imageQuickCheck({ ...input, images: Array(5).fill(input.images[0]) }), 'image_count');
  assert.equal(imageQuickCheck({ ...input, images: [{ ...input.images[0], mime_type: 'image/gif' }] }), 'image_format');
});
test('explicit submit only; duplicate gestures coalesce and IDs remain stable', async () => {
  const f = fixture();
  assert.equal(f.c.get(scope), undefined); assert.equal(f.calls.capabilities, 0);
  const a = f.c.submit(scope, input, false, draft), b = f.c.submit(scope, input, false, draft);
  assert.equal(a, b); await a;
  await f.c.submit(scope, { ...input, content: 'later' }, true, draft);
  assert.equal(f.calls.write.length, 1);
  assert.equal(f.c.get(scope).current.receipt.state, 'platform_accepted');
  assert.equal(f.c.shouldClear(f.c.get(scope).current, 1), false);
});
test('old or offline node retains immutable snapshot and never falls back to a write', async () => {
  for (const capabilities of [async () => null, async () => ({ version: 0 }), async () => { throw new Error('offline secret'); }]) {
    const f = fixture({ capabilities });
    const result = await f.c.submit(scope, input, false, draft);
    assert.equal(result.receipt.state, 'not_submitted'); assert.equal(f.calls.write.length, 0);
    assert.deepEqual(f.c.get(scope).current.snapshot.images, input.images);
    assert.equal(imageReceiptLabel(result.receipt).includes('secret'), false);
  }
});
test('queued receipt clears only matching revision and cannot replay same draft after RPC resolves', async () => {
  const f = fixture(); await f.c.submit(scope, input, true, draft);
  const a = f.c.get(scope).current;
  assert.equal(f.c.shouldClear(a, 2), false); assert.equal(f.c.shouldClear(a, 1), true);
  f.c.didClear(a); assert.equal(f.c.shouldClear(a, 1), false);
  await f.c.submit(scope, input, true, draft); assert.equal(f.calls.write.length, 1);
});
test('slow native receipt never clears an edited draft; failed-after-receipt needs explicit restore', async () => {
  const f = fixture(); await f.c.submit(scope, input, false, draft);
  const a = f.c.get(scope).current;
  f.c.observe(scope, f.receipt(a, 'native_received', 3));
  assert.equal(f.c.shouldClear(a, 2), false);
  f.c.observe(scope, f.receipt(a, 'failed', 4));
  assert.equal(f.c.restore(a, false, false, false), undefined);
  assert.equal(f.c.restore(a, true, false, true), undefined);
  assert.deepEqual(f.c.restore(a, true, true, true).images, input.images);
  f.c.observe(scope, f.receipt(a, 'platform_accepted', 2)); assert.equal(a.receipt.state, 'failed');
});
test('RPC timeout does one coalesced read; remount and duplicate send never replay', async () => {
  const f = fixture({ write: async () => { throw new Error('lost response'); } });
  await f.c.submit(scope, input, false, draft); await tick();
  assert.equal(f.calls.read.length, 1); assert.equal(f.c.get(scope).current.receipt.state, 'unknown');
  const unsubscribe = f.c.subscribe(() => {}); unsubscribe(); f.c.subscribe(() => {});
  await f.c.submit(scope, input, true, draft); await tick(); assert.equal(f.calls.read.length, 1);
  await Promise.all([f.c.refresh(scope, f.c.get(scope).current.requestId), f.c.refresh(scope, f.c.get(scope).current.requestId)]);
  assert.equal(f.calls.read.length, 2);
});
test('early native receipt cannot be downgraded by delayed platform reply or missing status', async () => {
  let done; const f = fixture({ write: async () => new Promise(resolve => { done = resolve; }) });
  const job = f.c.submit(scope, input, false, draft); await tick(); const a = f.c.get(scope).current;
  f.c.observe(scope, f.receipt(a, 'native_received', 3)); done(f.receipt(a)); await job;
  await f.c.refresh(scope, a.requestId); assert.equal(a.receipt.state, 'native_received');
});
test('identity clear releases memory and late capability cannot send or repopulate old scope', async () => {
  let done; const f = fixture({ capabilities: () => new Promise(resolve => { done = resolve; }) });
  const job = f.c.submit(scope, input, false, draft); await tick(); f.c.clear();
  done({ version: 1, submit: true, status: true }); await job;
  assert.equal(f.c.get(scope), undefined); assert.equal(f.calls.write.length, 0);
});
test('scope and owner guard ignore late receipts from another executor/account', async () => {
  const f = fixture(); await f.c.submit(scope, input, false, draft); const a = f.c.get(scope).current;
  f.c.observe({ ...scope, key: 'other-executor' }, f.receipt(a, 'succeeded', 7));
  f.c.observe(scope, { ...f.receipt(a, 'succeeded', 7), ownerId: 'another-user' });
  assert.equal(a.receipt.state, 'platform_accepted');
});
test('one recovery slot per scope, maximum scope cap never evicts unknown protection', async () => {
  const f = fixture({}, 1); await f.c.submit(scope, input, false, draft);
  const second = await f.c.submit({ ...scope, key: 'second' }, input, true);
  assert.equal(second.receipt.reason, 'memory_limit'); assert.equal(f.calls.write.length, 1);
  f.c.observe(scope, f.receipt(f.c.get(scope).current, 'succeeded', 4));
  await f.c.submit(scope, { ...input, content: 'next' }, true, { ...draft, draftRevision: 2 });
  await f.c.submit(scope, { ...input, content: 'third' }, true, { ...draft, draftRevision: 3 });
  assert.equal(f.c.get(scope).current.snapshot.content, 'third'); assert.equal(f.c.get(scope).recovery.snapshot.content, 'next');
});
