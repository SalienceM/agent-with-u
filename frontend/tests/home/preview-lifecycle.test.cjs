const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePreviewSource, samePreviewSource, PreviewLifecycle, PreviewRegistry, PREVIEW_REGISTRY_TTL, PREVIEW_REGISTRY_LIMIT } = require('../../.home-test-dist/utils/previewLifecycle');
const source = () => ({ version: 2, id: 'test', identity: { mode: 'local', realm: 'local', owner: 'local', epoch: 'first' }, executor: 'local', executorRealm: 'local', session: 'session', workingDir: '/fixture', workspace: { ownerId: 'local', executorInstance: 'node', sessionId: 'session', workingDir: '/fixture', workspaceRevision: 'a'.repeat(64) }, relative: 'a.txt', source: 'remote', readonly: false });
test('preview source fixes node, path, workspace and realm without credentials', () => {
  const value = validatePreviewSource(source());
  assert.ok(Object.isFrozen(value)); assert.ok(samePreviewSource(value, source()));
  for (const patch of [{ executor: 'other' }, { executorRealm: 'other' }, { relative: 'b.txt' }, { identity: { ...value.identity, realm: 'other' } }]) assert.equal(samePreviewSource(value, { ...value, ...patch }), false);
  for (const patch of [{ token: 'secret' }, { version: 3 }, { relative: '../secret' }, { relative: '/secret' }, { identity: { ...value.identity, token: 'secret' } }, { workspace: { ...value.workspace, ownerId: 'other' } }]) assert.throws(() => validatePreviewSource({ ...source(), ...patch }));
});
test('local source requires actual immutable binding', () => {
  const a = source(); a.source = 'local'; a.local = { kind: 'managed', id: 'managed:original', root: 'original' }; a.workspace.workingDir = a.local.id;
  assert.equal(validatePreviewSource(a).local.id, 'managed:original');
  assert.throws(() => validatePreviewSource({ ...a, local: { ...a.local, id: 'managed:replacement' } }));
});
test('lifecycle invalidates stale work but only real revocation hides content', () => {
  const life = new PreviewLifecycle(); life.set('ready'); const generation = life.generation;
  life.assert(generation); life.set('offline', 'offline'); assert.throws(() => life.assert(generation));
  life.set('ready'); life.assert(); life.set('revoked'); assert.throws(() => life.assert());
  life.set('ready'); assert.equal(life.phase, 'revoked'); life.set('closed'); assert.equal(life.phase, 'closed');
  const changed = new PreviewLifecycle(); changed.set('invalidated'); changed.set('offline', 'late timeout'); changed.set('ready');
  assert.equal(changed.phase, 'invalidated'); changed.set('revoked'); assert.equal(changed.phase, 'revoked');
});
test('registry is bounded, identity scoped, immutable and expires without document bytes', () => {
  let data = null, now = 1; const registry = new PreviewRegistry({ getItem: () => data, setItem: (_, v) => data = v }, () => now);
  const value = source(); registry.put({ source: value, dark: true });
  assert.equal(registry.get('unknown', value.identity), null);
  assert.throws(() => new PreviewRegistry({ getItem: () => null, setItem: () => { throw new Error('storage unavailable'); } }).put({ source: value, dark: true }), /storage unavailable/);
  assert.deepEqual(registry.get(value.id, value.identity).source, value);
  assert.throws(() => registry.get(value.id, { ...value.identity, epoch: 'new-login' }));
  assert.throws(() => registry.put({ source: { ...value, executor: 'other' }, dark: true }));
  for (let i = 1; i < PREVIEW_REGISTRY_LIMIT; i++) registry.put({ source: { ...value, id: `p${i}` }, dark: false });
  assert.throws(() => registry.put({ source: { ...value, id: 'overflow' }, dark: false }));
  assert.ok(!data.includes('token')); assert.ok(!data.includes('text')); now += PREVIEW_REGISTRY_TTL + 1;
  assert.equal(registry.get(value.id, value.identity), null); registry.put({ source: value, dark: true });
  registry.remove(value.id, value.identity); assert.equal(registry.get(value.id, value.identity), null);
});
