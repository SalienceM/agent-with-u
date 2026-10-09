const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionViewKey, localSessionView, rememberLocalSessionView } = require('../../.home-test-dist/utils/sessionViewPreference.js');
const memory = () => ({ text: null, getItem() { return this.text; }, setItem(_key, value) { this.text = value; } });

test('old-node view preferences isolate user, executor and session; removal restores authority', () => {
  const storage = memory(), key = sessionViewKey('alice', 'remote', 'a');
  assert.equal(rememberLocalSessionView(storage, key, 'engine'), true);
  assert.equal(localSessionView(storage, key), 'engine');
  for (const identity of [['bob', 'remote', 'a'], ['alice', 'home', 'a'], ['alice', 'remote', 'b']]) {
    assert.equal(localSessionView(storage, sessionViewKey(...identity)), undefined);
  }
  rememberLocalSessionView(storage, key, null);
  assert.equal(localSessionView(storage, key), undefined);
});

test('corrupt/unavailable preference storage is bounded and does not become a document store', () => {
  const storage = memory(), key = sessionViewKey('alice', 'remote', 'a');
  for (const text of ['{', '[]', 'null', 'x'.repeat(65537), JSON.stringify({ [key]: 'loop' })]) {
    storage.text = text; assert.equal(localSessionView(storage, key), undefined);
  }
  const disabled = { getItem() { throw Error('disabled'); }, setItem() { throw Error('quota'); } };
  assert.equal(localSessionView(disabled, key), undefined);
  assert.equal(rememberLocalSessionView(disabled, key, 'engine'), false);
  for (let i = 0; i < 250; i++) rememberLocalSessionView(storage, sessionViewKey('alice', 'remote', String(i)), 'engine');
  assert.equal(Object.keys(JSON.parse(storage.text)).length, 200);
});
