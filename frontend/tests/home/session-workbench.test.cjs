const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSessionViewMode } = require('../../.home-test-dist/utils/sessionWorkbench.js');
const { SessionRoutingCache, mergeSessionRouting } = require('../../.home-test-dist/utils/sessionRouting.js');
const { readWorkbenchCapabilities } = require('../../.home-test-dist/utils/sessionWorkbench.js');

const target = { user: 'alice', executor: 'remote-exact', session: 'a', workingDir: '/project' };
const response = () => ({ status: 'ok', protocolVersion: 1,
  identity: { ownerId: 'alice', executorInstance: 'boot-1', sessionId: 'a', workingDir: '/project', workspaceRevision: 'a'.repeat(64) },
  capabilities: { viewMode: 1, windowHandoff: 0, documents: 0, languageServices: 0, terminal: 0 } });

test('legacy view mode defaults to Chat, independently of execution type', () => {
  for (const value of [undefined, null, '', 'loop', {}, []]) assert.equal(normalizeSessionViewMode(value), 'chat');
  assert.equal(normalizeSessionViewMode('engine'), 'engine');
  const merged = mergeSessionRouting(null, { sessionType: 'loop', loopControlMode: 'manual' });
  assert.equal(merged.viewMode, 'chat');
  assert.equal(merged.loopControlMode, 'manual');
});

test('old partial metadata preserves Engine and does not change control state', () => {
  const merged = mergeSessionRouting({ viewMode: 'engine', sessionType: 'loop', loopControlMode: 'manual', controlRevision: 3 }, { title: 'new' });
  assert.equal(merged.viewMode, 'engine');
  assert.equal(merged.sessionType, 'loop');
  assert.equal(merged.loopControlMode, 'manual');
  assert.equal(mergeSessionRouting(merged, { viewMode: null }).viewMode, 'engine');
});

test('late metadata load does not undo a newer mode and sessions stay separate', () => {
  const cache = new SessionRoutingCache();
  cache.update('a', { viewMode: 'chat' });
  const revision = cache.revision('a');
  cache.update('a', { viewMode: 'engine' });
  cache.loaded('a', { viewMode: 'chat' }, revision);
  cache.update('b', { sessionType: 'normal' });
  assert.equal(cache.get('a').viewMode, 'engine');
  assert.equal(cache.get('b').viewMode, 'chat');
});

test('capability discovery routes once to the explicit node, old nodes fail closed', async () => {
  const calls = [];
  const value = await readWorkbenchCapabilities(target, async (...args) => { calls.push(args); return null; }, () => true);
  assert.equal(value.status, 'unsupported');
  assert.deepEqual(Object.values(value.capabilities), [0, 0, 0, 0, 0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'remote-exact');
  assert.deepEqual(calls[0][2], ['a', '/project']);
});

test('offline errors do not fall back to home and empty routes are rejected', async () => {
  let calls = 0;
  const offline = async () => { calls++; throw new Error('offline'); };
  await assert.rejects(readWorkbenchCapabilities(target, offline, () => true), /offline/);
  await assert.rejects(readWorkbenchCapabilities({ ...target, executor: '' }, offline, () => true), /身份不完整/);
  assert.equal(calls, 1);
});

test('foreign, stale, malformed and future capabilities never become usable', async () => {
  for (const bad of [false, {}, { ...response(), status: 'error', reasonCode: 'stale_workspace' },
      { ...response(), identity: { ...response().identity, ownerId: 'bob' } }]) {
    await assert.rejects(readWorkbenchCapabilities(target, async () => bad, () => true));
  }
  let current = true;
  await assert.rejects(readWorkbenchCapabilities(target, async () => { current = false; return response(); }, () => current), /身份已变化/);
  const future = response(); future.capabilities.terminal = 2;
  assert.equal((await readWorkbenchCapabilities(target, async () => future, () => true)).capabilities.terminal, 0);
});
