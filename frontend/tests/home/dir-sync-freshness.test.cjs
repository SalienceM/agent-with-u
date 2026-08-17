const test = require('node:test');
const assert = require('node:assert/strict');
const { describeSyncFreshness } = require('../../.home-test-dist/utils/dirSyncFreshness.js');

const file = (hash, mtime) => ({ hash, mtime });

test('hash equality is authoritative even when mtimes differ', () => {
  assert.equal(
    describeSyncFreshness(file('same', 1_000), file('same', 99_000)).kind,
    'same',
  );
});

test('three-way baseline identifies the side that changed', () => {
  const baseline = file('base', 1_000);
  assert.equal(
    describeSyncFreshness(file('local-new', 5_000), file('base', 1_000), baseline).kind,
    'local-updated',
  );
  assert.equal(
    describeSyncFreshness(file('base', 1_000), file('remote-new', 5_000), baseline).kind,
    'remote-updated',
  );
  assert.equal(
    describeSyncFreshness(file('local-new', 5_000), file('remote-new', 6_000), baseline).kind,
    'both-updated',
  );
});

test('without a baseline mtime is used only as a fallback', () => {
  const local = describeSyncFreshness(file('a', 20_000), file('b', 10_000));
  const remote = describeSyncFreshness(file('a', 10_000), file('b', 20_000));
  assert.deepEqual([local.kind, local.basis], ['local-updated', 'mtime']);
  assert.deepEqual([remote.kind, remote.basis], ['remote-updated', 'mtime']);
});

test('close or missing mtimes do not invent a newer side', () => {
  assert.equal(
    describeSyncFreshness(file('a', 10_000), file('b', 11_000)).kind,
    'different-unknown',
  );
  assert.equal(
    describeSyncFreshness(file('a', undefined), file('b', 20_000)).kind,
    'different-unknown',
  );
});

test('remote-only files carry their remote modification time', () => {
  const result = describeSyncFreshness(undefined, file('remote', 123_456));
  assert.equal(result.kind, 'remote-only');
  assert.equal(result.remoteMtime, 123_456);
});
