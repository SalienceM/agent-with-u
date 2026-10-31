const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FilePanelViewCache, filePanelViewKey, loadFileTreeExpansion, saveFileTreeExpansion } = require('../../.home-test-dist/utils/filePanelViewState.js');

test('file view memory separates owner/executor/session/root/mode/surface and evicts by LRU/weight', () => {
  const args = ['user', 'node', 'session', '/project', 'relay', false];
  const key = filePanelViewKey(...args);
  for (let i = 0; i < args.length; i++) {
    const other = [...args]; other[i] = i === 5 ? true : 'other';
    assert.notEqual(filePanelViewKey(...other), key);
  }
  const cache = new FilePanelViewCache(2, 5);
  cache.set('a', { expanded: true }, 2); cache.set('b', {}, 2);
  assert.equal(cache.get('a').expanded, true);
  cache.set('c', {}, 2); assert.equal(cache.get('b'), undefined);
  cache.set('large', {}, 6); assert.equal(cache.get('large'), undefined);
  cache.set('d', {}, 4); assert.equal(cache.get('a'), undefined); assert.equal(cache.get('c'), undefined);
  cache.clear(); assert.equal(cache.get('d'), undefined);
});

function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('directory expansion survives reload with closed ancestors and stays scoped to the exact view', () => {
  const saved = storage();
  const args = ['user', 'node', 'session', '/project', 'relay', false];
  const key = filePanelViewKey(...args);
  assert.equal(saveFileTreeExpansion(key, { src: false, 'src/deep': true, docs: true }, saved), true);
  assert.deepEqual(loadFileTreeExpansion(key, saved), { 'src/deep': true, docs: true });
  for (let i = 0; i < args.length; i++) {
    const other = [...args]; other[i] = i === 5 ? true : 'other';
    assert.deepEqual(loadFileTreeExpansion(filePanelViewKey(...other), saved), {});
  }
  assert.equal(saveFileTreeExpansion(key, {}, saved), true);
  assert.deepEqual(loadFileTreeExpansion(key, saved), {});
});

test('directory expansion validates storage and only persists bounded path preferences', () => {
  const saved = storage();
  assert.equal(saveFileTreeExpansion('a', { src: true, '/abs': true, '../escape': true,
    'a/../escape': true, 'C:/root': true, 'a\\b': true, wrong: 'true', secret: 'file body' }, saved), true);
  assert.deepEqual(loadFileTreeExpansion('a', saved), { src: true });
  assert.equal([...saved.values.values()][0].includes('file body'), false);
  for (let i = 0; i < 40; i++) saveFileTreeExpansion(`view-${i}`, { src: true }, saved);
  assert.deepEqual(loadFileTreeExpansion('view-0', saved), {});
  assert.deepEqual(loadFileTreeExpansion('view-39', saved), { src: true });
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`dir-${i}`, true]));
  saveFileTreeExpansion('many', many, saved);
  assert.equal(Object.keys(loadFileTreeExpansion('many', saved)).length, 512);
  const key = [...saved.values.keys()][0];
  for (const invalid of ['broken', 'null', '{"version":2,"entries":{}}', '{"version":1,"entries":[]}']) {
    saved.values.set(key, invalid);
    assert.deepEqual(loadFileTreeExpansion('a', saved), {});
  }
  assert.equal(saveFileTreeExpansion('a', { src: true }, saved), true);
  assert.deepEqual(loadFileTreeExpansion('a', saved), { src: true });
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(loadFileTreeExpansion('a', denied), {});
  assert.equal(saveFileTreeExpansion('a', { src: true }, denied), false);
});
