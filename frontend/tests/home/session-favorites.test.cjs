const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionFavorites, IndexedFavoriteRepository, favoriteKey, favoriteIdentityTarget, mergeFavoriteRemote, validateFavoriteRow } = require('../../.home-test-dist/utils/sessionFavorites.js');
const { deleteSessionOnTarget } = require('../../.home-test-dist/utils/sessionDeletion.js');

const target = { scope: '["https://qa","alice"]', node: 'node-a', session: 'session-a' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
test('scope strips credentials, separates servers/modes/owners/nodes, and aliases only verified local', () => {
  const input = { mode: 'relay', origin: 'http://qa', relayUrl: 'wss://name:secret@qa/relay?token=private#private', userId: 'alice', deviceId: 'node' };
  const base = favoriteIdentityTarget(input, 'same');
  assert.equal(base.scope, '["relay","wss://qa/relay","alice"]');
  for (const patch of [{ relayUrl: 'wss://else/relay' }, { userId: 'bob' }, { deviceId: 'other' }, { mode: 'local' }])
    assert.notEqual(favoriteKey(base), favoriteKey(favoriteIdentityTarget({ ...input, ...patch }, 'same')));
  assert.deepEqual(favoriteIdentityTarget({ ...input, verifiedLocalAlias: true }, 'same'), favoriteIdentityTarget({ ...input, mode: 'local' }, 'same'));
  assert.ok(favoriteIdentityTarget({ ...input, userId: undefined }, 'same').scope.includes('legacy'));
});
class MemoryRepository {
  rows = new Map(); fail = false;
  async all() { return [...this.rows.values()]; }
  async edit(key, change) {
    if (this.fail) throw new Error('quota');
    const next = change(this.rows.get(key) || null);
    if (next) { validateFavoriteRow(next); this.rows.set(key, next); } else this.rows.delete(key);
    return next;
  }
  async clear(scopes) { for (const [key, row] of this.rows) if (!scopes || scopes.includes(row.scope)) this.rows.delete(key); }
}
function fixture(repo = new MemoryRepository()) {
  const state = { online: 'offline', remote: { protocolVersion: 1, status: 'ok', pinned: false, favoriteRevision: 0 }, calls: [], observed: [], reads: 0 };
  const controller = new SessionFavorites(repo, {
    available: () => state.online,
    async call(t, method, params) {
      state.calls.push({ t, method, params });
      if (state.handler) return state.handler(t, method, params);
      if (method === 'sessionFavoriteGet') return { ...state.remote };
      const input = JSON.parse(params[1]);
      if (input.expectedRevision !== state.remote.favoriteRevision) return { ...state.remote, status: 'conflict' };
      state.remote = { ...state.remote, pinned: input.pinned, favoriteRevision: state.remote.favoriteRevision + 1, lastRequestId: input.requestId };
      return { ...state.remote };
    },
    remote: (t, value) => state.observed.push({ t, value }), changed() {},
  });
  return { controller, repo, state };
}

test('offline latest choice persists, projects all stale sources, and isolates full identity', async () => {
  const { controller: c, repo, state } = fixture();
  await c.choose(target, true, 0); await c.choose(target, false, 0); await c.choose(target, true, 0); await tick();
  assert.equal(repo.rows.size, 1); assert.equal(c.get(target).generation, 3); assert.equal(state.calls.length, 0);
  const other = fixture(repo).controller; await other.reload();
  for (const remote of [{ pinned: false }, { pinned: false, favoriteRevision: 0 }]) assert.equal(other.project(target, remote).pinned, true);
  for (const identity of [{ scope: '["https://other","alice"]' }, { scope: '["https://qa","bob"]' }, { node: 'node-b' }])
    assert.equal(other.project({ ...target, ...identity }, { pinned: false }).pinned, false);
  assert.equal(JSON.stringify([...repo.rows.values()]).includes('token'), false);
  assert.equal(mergeFavoriteRemote({ pinned: false, favoriteRevision: 3 }, { pinned: true, favoriteRevision: 1 }).pinned, false);
});

test('persistence failure neither changes durable choice nor calls server; validation bounds', async () => {
  const { controller: c, repo, state } = fixture();
  await c.choose(target, true, 0); await tick(); repo.fail = true;
  await assert.rejects(c.choose(target, false, 0), /quota/);
  assert.equal(c.get(target).pinned, true); assert.equal(state.calls.length, 0);
  assert.throws(() => validateFavoriteRow({ ...c.get(target), message: '长'.repeat(800) }), /2 KiB/);
  await assert.rejects(new IndexedFavoriteRepository().all(), /不可用/);
});

test('reconnect only coordinates latest and stops; no polling or legacy writes', async () => {
  const { controller: c, state } = fixture();
  await c.choose(target, false, 0); await c.choose(target, true, 0); await tick();
  state.online = 'online'; c.reconnect(); await tick(); await tick();
  assert.deepEqual(state.calls.map(v => v.method), ['sessionFavoriteGet', 'sessionFavoriteSet']);
  assert.equal(c.get(target), undefined); c.reconnect(); await tick(); assert.equal(state.calls.length, 2);
});

test('in-flight acknowledged write advances successor only; no external conflict', async () => {
  const { controller: c, state } = fixture(); const saved = deferred();
  state.online = 'online'; state.handler = async (_t, method, params) => {
    if (method === 'sessionFavoriteGet') return { ...state.remote };
    const input = JSON.parse(params[1]);
    state.remote = { ...state.remote, pinned: input.pinned, favoriteRevision: state.remote.favoriteRevision + 1 };
    if (input.pinned) await saved.promise;
    return { ...state.remote };
  };
  await c.choose(target, true, 0); await tick();
  await c.choose(target, false, 0); saved.resolve(); await tick(); await tick();
  assert.equal(state.remote.pinned, false); assert.equal(state.remote.favoriteRevision, 2); assert.equal(c.get(target), undefined);
});

test('unknown write is read first on reconnect, and does not replay committed write', async () => {
  const { controller: c, state } = fixture(); state.online = 'online';
  state.handler = async (_t, method, params) => {
    if (method === 'sessionFavoriteGet') return { ...state.remote };
    state.remote = { ...state.remote, pinned: JSON.parse(params[1]).pinned, favoriteRevision: 1 };
    throw new Error('connection lost');
  };
  await c.choose(target, true, 0); await tick(); assert.equal(c.get(target).phase, 'unknown');
  c.reconnect(); await tick(); assert.equal(c.get(target), undefined);
  assert.deepEqual(state.calls.map(v => v.method), ['sessionFavoriteGet', 'sessionFavoriteSet', 'sessionFavoriteGet']);
});

test('ABA revision conflict preserves local choice; explicit local and remote resolutions', async () => {
  for (const choice of ['remote', 'local']) {
    const { controller: c, state } = fixture(); await c.choose(target, true, 0); await tick();
    state.remote.favoriteRevision = 2; state.online = 'online'; await c.sync(target);
    assert.equal(c.get(target).phase, 'conflict'); assert.equal(state.calls.length, 1);
    await c.resolve(target, choice); assert.equal(c.get(target), undefined);
    assert.equal(state.remote.pinned, choice === 'local');
  }
});

test('not found clears only matching target; denied, removed and unsupported do not loop', async () => {
  for (const response of [null, { status: 'not_found' }, { status: 'error', message: 'denied' }]) {
    const { controller: c, state } = fixture(); await c.choose(target, true, 0); await tick();
    state.online = 'online'; state.handler = async () => response; await c.sync(target);
    assert.equal(c.get(target)?.phase, response === null ? 'unsupported' : response.status === 'error' ? 'blocked' : undefined);
    c.reconnect(); await tick(); assert.equal(state.calls.length, 1);
  }
  for (const online of ['removed', 'unsupported']) {
    const { controller: c, state } = fixture(); state.online = online;
    await c.choose(target, true, 0); await tick(); assert.equal(state.calls.length, 0);
    assert.equal(c.get(target).phase, online === 'removed' ? 'blocked' : 'unsupported');
  }
});

test('clear invalidates late replies and deletes durable old identity', async () => {
  const { controller: c, state, repo } = fixture(), read = deferred(); state.online = 'online'; state.handler = () => read.promise;
  await c.choose(target, true, 0); await tick(); await c.clear(); read.resolve(state.remote); await tick();
  assert.equal(repo.rows.size, 0); assert.equal(state.observed.length, 0); assert.equal(state.calls.length, 1);
});

test('identity cleanup only removes the old scope and leaves another window identity intact', async () => {
  const { controller: c, state, repo } = fixture();
  const other = { ...target, scope: '["https://qa","bob"]' };
  await c.choose(target, true, 0); await c.choose(other, false, 0); await tick();
  await c.clear([target.scope]);
  assert.equal(c.get(target), undefined); assert.equal(c.get(other).pinned, false);
  assert.equal(repo.rows.size, 1);
  state.online = 'inactive'; c.reconnect(); await tick(); assert.equal(state.calls.length, 0);
});

test('per-node concurrency is two and same-target notifications coalesce', async () => {
  const { controller: c, state } = fixture(); const pending = []; let active = 0, peak = 0;
  state.online = 'online'; state.handler = async () => { active++; peak = Math.max(peak, active); const wait = deferred(); pending.push(wait); await wait.promise; active--; return { ...state.remote, pinned: true }; };
  for (let i = 0; i < 5; i++) await c.choose({ ...target, session: `s${i}` }, true, 0);
  await tick(); assert.equal(peak, 2);
  for (let i = 0; i < 6; i++) { for (const wait of pending) wait.resolve(); await tick(); }
  assert.equal(state.calls.length, 5); assert.equal(peak, 2);
});

test('another window newer choice prevents stale in-flight read from writing', async () => {
  const a = fixture(), b = fixture(a.repo), read = deferred();
  a.state.online = 'online'; a.state.handler = () => read.promise;
  await a.controller.choose(target, true, 0); await tick();
  await b.controller.choose(target, false, 0); await tick();
  read.resolve(a.state.remote); await tick();
  assert.equal(a.state.calls.length, 1); assert.equal(a.controller.get(target).pinned, false);
  assert.equal(a.repo.rows.get(favoriteKey(target)).generation, 2);
});

test('strict deletion classifies boolean, malformed, denial, preflight and unknown without retry', async () => {
  for (const [raw, status] of [[true, 'succeeded'], [false, 'failed'], [null, 'unknown'], ['garbled', 'unknown'], ['true', 'succeeded']]) {
    let count = 0;
    const result = await deleteSessionOnTarget({ online: () => true, current: () => true, request: async (_m, _p, timeout) => { count++; assert.equal(timeout, 10000); return raw; } }, 's');
    assert.equal(result.status, status); assert.equal(count, 1);
  }
  for (const [error, status] of [[{ serverRejected: true }, 'failed'], [{ notSubmitted: true }, 'not_submitted'], [new Error('timeout'), 'unknown']]) {
    assert.equal((await deleteSessionOnTarget({ online: () => true, current: () => true, request: async () => { throw error; } }, 's')).status, status);
  }
  let writes = 0;
  assert.equal((await deleteSessionOnTarget({ online: () => false, current: () => true, request: async () => { writes++; } }, 's')).status, 'not_submitted');
  assert.equal(writes, 0);
  let current = true;
  assert.equal((await deleteSessionOnTarget({ online: () => true, current: () => current, request: async () => { current = false; return true; } }, 's')).status, 'unknown');
});
