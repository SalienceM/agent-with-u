const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionWindowHandoff } = require('../../.home-test-dist/utils/sessionWindowHandoff.js');
const workspace = { ownerId: 'alice', executorInstance: 'process', sessionId: 's', workingDir: '/qa', workspaceRevision: 'a'.repeat(64) };
function fixture() {
  let plan, captured = { input: { text: 'draft', images: [] } }, persisted, released = 0, failOffer = false;
  const calls = [], progress = [];
  const client = { workspace, transport: { identity: { clientId: 'client', windowId: 'source' } },
    prepare: async (targetWindow, stateDigest, stateVersion, requestId) => {
      calls.push('prepare'); assert.ok(persisted);
      return plan = { requestId, sourceWindow: 'source', targetWindow, stateDigest, stateVersion, generation: 1, fingerprint: 'f'.repeat(64), status: 'prepared' };
    }, get: async () => { calls.push('get'); return { state: { frozen: !['committed', 'cancelled'].includes(plan?.status), windowId: plan?.status === 'committed' ? 'target' : 'source', pending: plan }, receipt: plan }; },
    finish: async (_p, commit) => { calls.push(commit ? 'commit' : 'cancel'); if (plan.status !== 'committed') plan = { ...plan, status: commit ? 'committed' : 'cancelled' }; return plan; },
  };
  const io = { capture: async () => captured, restore: async () => {}, read: async () => persisted,
    persist: async envelope => { calls.push('persist'); persisted = envelope; }, release: () => { released++; },
    offer: async () => { calls.push('offer'); if (failOffer) throw Error('target lost'); plan = { ...plan, status: 'acknowledged' }; },
  };
  const controller = new SessionWindowHandoff(client, io, p => progress.push(p), () => true);
  return { controller, client, io, calls, progress, released: () => released, fail: () => { failOffer = true; }, recover: () => { failOffer = false; }, change: () => { captured = { input: { text: 'changed', images: [] } }; } };
}
test('window creation is not success; source released only after durable state and ACK/commit', async () => {
  const f = fixture(); let ready;
  const pending = f.controller.move('target', new Promise(r => { ready = r; }));
  assert.equal(f.released(), 0); assert.deepEqual(f.calls, []);
  await assert.rejects(f.controller.move('target', Promise.resolve()), /已有/);
  ready(); await pending;
  assert.deepEqual(f.calls, ['persist', 'prepare', 'offer', 'get', 'commit', 'persist']); assert.equal(f.released(), 1);
  assert.equal(f.progress.at(-1).phase, 'moved');
});
test('blocked popup leaves source; missing target ACK preserves journal and explicit cancel only', async () => {
  const blocked = fixture(); await assert.rejects(blocked.controller.move('target', Promise.reject(Error('popup'))), /popup/);
  assert.deepEqual(blocked.calls, []); assert.equal(blocked.progress.at(-1).phase, 'idle');
  assert.equal(blocked.progress.at(-1).settled, false, 'idle popup errors must stay visible');
  const f = fixture(); f.fail(); await assert.rejects(f.controller.move('target', Promise.resolve()), /target lost/);
  assert.equal(f.released(), 0); assert.equal(f.progress.at(-1).phase, 'unknown');
  assert.equal(f.progress.at(-1).settled, false, 'unknown handoffs must not become quiet success');
  await f.controller.reconcile(); assert.equal(f.calls.filter(c => c === 'prepare').length, 1);
  await f.controller.cancel(); assert.equal(f.calls.at(-2), 'cancel'); assert.equal(f.progress.at(-1).phase, 'idle');
  assert.equal(f.progress.at(-1).settled, true, 'confirmed cancellation may move to the window menu');
});
test('mutable draft change during frozen transfer prevents commit instead of losing edits', async () => {
  const f = fixture(), offer = f.io.offer;
  f.io.offer = async p => { await offer(p); f.change(); };
  await assert.rejects(f.controller.move('target', Promise.resolve()), /草稿发生变化/);
  assert.equal(f.calls.includes('commit'), false); assert.equal(f.released(), 0);
});

test('resume wakes the original target after lost ACK without a new prepare or new draft', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(f.controller.move('target', Promise.resolve()), /target lost/);
  f.recover(); await f.controller.resume();
  assert.equal(f.calls.filter(c => c === 'prepare').length, 1);
  assert.equal(f.calls.filter(c => c === 'commit').length, 1);
  assert.equal(f.released(), 1);
});

test('resume rejects changed drafts before asking the original target to restore', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(f.controller.move('target', Promise.resolve()), /target lost/);
  f.change(); f.recover();
  await assert.rejects(f.controller.resume(), /草稿与原交接不同/);
  assert.equal(f.calls.filter(c => c === 'offer').length, 1); assert.equal(f.released(), 0);
});
