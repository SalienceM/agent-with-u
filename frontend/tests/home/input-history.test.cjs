const test = require('node:test');
const assert = require('node:assert/strict');
const { inputHistoryKey, normalizeInputHistory, createInputHistoryStore } = require('../../.home-test-dist/utils/inputHistory.js');
const identity = { mode: 'relay', userId: 'alice' };
const key = inputHistoryKey(identity, 'work', 'session');
const memory = () => {
  const data = new Map();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
};

test('recent inputs survive a new store instance and never contain authorization fields', () => {
  const storage = memory();
  const first = createInputHistoryStore(() => storage);
  first.append(key, '  第一条  ');
  first.append(key, '第二条\n多行需求');
  const restarted = createInputHistoryStore(() => storage);
  assert.deepEqual(restarted.read(key), ['第一条', '第二条\n多行需求']);
  assert.deepEqual(JSON.parse(storage.getItem(key)), { version: 1, entries: ['第一条', '第二条\n多行需求'] });
});

test('user, execution node and Session are independent; unknown routing never falls back', () => {
  const storage = memory();
  const store = createInputHistoryStore(() => storage);
  store.append(key, 'private');
  for (const scoped of [inputHistoryKey({ ...identity, userId: 'bob' }, 'work', 'session'),
    inputHistoryKey(identity, 'home', 'session'), inputHistoryKey(identity, 'work', 'other'),
    inputHistoryKey({ mode: 'local', userId: 'alice' }, 'work', 'session')]) {
    assert.deepEqual(store.read(scoped), []);
  }
  assert.equal(inputHistoryKey(identity, undefined, 'session'), null);
  assert.equal(inputHistoryKey({ ...identity, userId: 'legacy' }, 'work', 'session'), null);
  store.append(null, 'do not persist without a target');
  assert.equal(storage.data.size, 1);
  assert.notEqual(inputHistoryKey(identity, 'node:a', 'b'), inputHistoryKey(identity, 'node', 'a:b'));
});

test('only ten inputs, adjacent duplicates removed, multiline text preserved, oversized instructions not truncated', () => {
  assert.deepEqual(normalizeInputHistory(Array.from({ length: 15 }, (_, i) => `task-${i}`)),
    Array.from({ length: 10 }, (_, i) => `task-${i + 5}`));
  assert.deepEqual(normalizeInputHistory([' a ', 'a', 'b', 'a', '', { text: 'secret' }, null]), ['a', 'b', 'a']);
  assert.deepEqual(normalizeInputHistory(['small', 'x'.repeat(32_001), 'last']), ['small', 'last']);
  const large = normalizeInputHistory(['a'.repeat(30_000), 'b'.repeat(30_000), 'c'.repeat(30_000)]);
  assert.equal(large.length, 2);
  assert.equal(large[0].length, 30_000);
});

test('legacy transcript seeding cannot overwrite a newer slash command or queued input', () => {
  const store = createInputHistoryStore(() => memoryStorage);
  const memoryStorage = memory();
  assert.deepEqual(store.seed(key, ['原用户请求', '第二条']), ['原用户请求', '第二条']);
  store.append(key, '/cost');
  assert.deepEqual(store.seed(key, ['stale transcript']), ['原用户请求', '第二条', '/cost']);
});

test('separate windows append using the latest persisted history and deletion stays scoped', () => {
  const storage = memory();
  const a = createInputHistoryStore(() => storage), b = createInputHistoryStore(() => storage);
  a.append(key, 'first'); b.append(key, 'second'); a.append(key, 'third');
  assert.deepEqual(b.read(key), ['first', 'second', 'third']);
  const other = inputHistoryKey(identity, 'work', 'other');
  a.append(other, 'keep'); b.remove(key);
  assert.deepEqual(a.read(key), []);
  assert.deepEqual(a.read(other), ['keep']);
});

test('corrupt or unsupported storage is ignored; quota failures keep the latest in-window input', () => {
  const storage = memory();
  for (const raw of ['broken-json', '{"version":2,"entries":["wrong"]}', '{"version":1,"entries":{}}']) {
    storage.setItem(key, raw);
    assert.deepEqual(createInputHistoryStore(() => storage).read(key), []);
  }
  storage.setItem(key, JSON.stringify({ version: 1, entries: ['previous'] }));
  storage.setItem = () => { throw new Error('quota'); };
  const store = createInputHistoryStore(() => storage);
  assert.equal(store.append(key, 'latest').persisted, false);
  assert.deepEqual(store.read(key), ['previous', 'latest']);
  const blocked = createInputHistoryStore(() => { throw new Error('storage disabled'); });
  assert.equal(blocked.append(key, 'available this window').persisted, false);
  assert.deepEqual(blocked.read(key), ['available this window']);
});
