const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('../../.home-test-dist/utils/directorySyncReview.js');
const scope = { workspace: { ownerId: 'u', executorInstance: 'e', sessionId: 's', workingDir: '/w', workspaceRevision: 'v' }, execKey: 'node', bindingId: 'handle:1', includeGitMetadata: false };
const meta = c => ({ hash: c.repeat(64), size: 1 });
test('scope separates all identities, baseline never trusts legacy or restarted instance', () => {
  const storage = new Map(); const io = { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v) };
  storage.set('awu-dirsync-baseline:handle:1::/w', JSON.stringify({ a: meta('a') }));
  assert.deepEqual(r.loadReviewBaseline(scope, io), {});
  const version = { exists: true, sha256: 'a'.repeat(64), byteLength: 1 };
  assert.equal(r.saveReviewBaseline(scope, 'a', version, version, io), true);
  assert.equal(r.loadReviewBaseline(scope, io).a.hash, version.sha256);
  for (const key of Object.keys(scope.workspace)) {
    const other = { ...scope, workspace: { ...scope.workspace, [key]: 'other' } };
    assert.notEqual(r.reviewScopeKey(other), r.reviewScopeKey(scope));
    assert.deepEqual(r.loadReviewBaseline(other, io), {});
  }
  for (const other of [{ ...scope, execKey: 'other' }, { ...scope, bindingId: 'other' }, { ...scope, includeGitMetadata: true }]) {
    assert.deepEqual(r.loadReviewBaseline(other, io), {});
  }
  assert.equal(storage.has('awu-dirsync-baseline:handle:1::/w'), true);
});
test('immutable snapshot and late compare/read generation rejection', () => {
  const local = { a: meta('a') }; const snapshot = r.compareSnapshot(scope, 1, local, {});
  local.a.hash = 'b'; assert.equal(snapshot.local.a.hash, 'a'.repeat(64)); assert.ok(Object.isFrozen(snapshot.scope.workspace));
  const gate = new r.ReviewGeneration(); const old = gate.begin('a'), next = gate.begin('a');
  assert.equal(gate.accepts(old, 'a'), false); assert.equal(gate.accepts(next, 'b'), false);
  assert.equal(gate.accepts(next, 'a'), true); gate.invalidate(); assert.equal(gate.accepts(next, 'a'), false);
});
test('union, directory boundary, conflict priority and type conflict including blocked parent', () => {
  const queue = r.createReviewQueue(r.compareSnapshot(scope, 1,
    { 'src/a': meta('a'), 'src/d': meta('a'), 'src2/a': meta('a'), 'src/same': meta('a') },
    { 'src/a': meta('b'), 'src/d/b': meta('b'), 'src/remote': meta('b'), 'src/same': meta('a') }, { 'src/a': meta('c') }), 'src');
  assert.deepEqual(queue.entries.map(e => e.path), ['src/a', 'src/d', 'src/d/b', 'src/remote']);
  assert.equal(queue.entries[1].typeConflict, true); assert.equal(queue.entries[2].typeConflict, true);
});
test('paging never truncates, navigation does not skip; failed/late result never advances wrong item', () => {
  const local = Object.fromEntries(Array.from({ length: 251 }, (_, i) => [`f${String(i).padStart(3,'0')}`, meta('a')]));
  let q = r.createReviewQueue(r.compareSnapshot(scope, 1, local, {}));
  assert.equal(r.reviewPage(q, '', false, 2).entries.length, 51); assert.equal(r.reviewPage(q).pages, 3);
  q = r.reduceReviewQueue(q, { type: 'navigate', direction: 1 }); assert.equal(q.entries[0].status, 'pending');
  q = r.reduceReviewQueue(q, { type: 'result', path: 'f001', status: 'failed' }); assert.equal(q.selected, 'f001');
  q = r.reduceReviewQueue(q, { type: 'result', path: 'f001', status: 'skipped' }); assert.equal(q.selected, 'f002');
  q = r.reduceReviewQueue(q, { type: 'navigate', direction: -1 }); assert.equal(q.selected, 'f001'); assert.equal(q.entries[1].status, 'skipped');
  q = r.reduceReviewQueue(q, { type: 'result', path: 'f000', status: 'pushed' }); assert.equal(q.selected, 'f001');
  q = r.reduceReviewQueue(q, { type: 'result', path: 'f001', status: 'pulled' }); assert.equal(q.selected, 'f002');
  assert.equal(r.reviewPage(q, 'f25').count, 1);
});

test('only different scope excludes one-sided paths and navigation stays within scope', () => {
  const snapshot = r.compareSnapshot(scope, 1, { 'src/a.ts': meta('a'), 'src/b.ts': meta('a'), 'src/local': meta('a'), 'src/same': meta('a'), 'src2/a': meta('a') },
    { 'src/a.ts': meta('b'), 'src/b.ts': meta('b'), 'src/remote': meta('b'), 'src/same': meta('a'), 'src2/a': meta('b') });
  let q = r.createReviewQueue(snapshot, 'src', 'src/local', true);
  assert.deepEqual(q.entries.map(e => e.path), ['src/a.ts', 'src/b.ts']);
  q = r.reduceReviewQueue(q, { type: 'navigate', direction: 1 });
  q = r.reduceReviewQueue(q, { type: 'navigate', direction: 1 });
  assert.equal(q.selected, 'src/b.ts');
  const nextGate = new r.ReviewGeneration(), first = nextGate.begin('a');
  assert.ok(new r.ReviewGeneration().begin('a').generation > first.generation);
});

test('regex uses full relative paths, literal mode stays literal and invalid patterns fail closed', () => {
  const paths = ['src/a.ts', 'src/B.TSX', 'src/aXts', 'docs/a.ts'];
  assert.deepEqual(r.matchReviewPaths(paths, '^src/.*\\.(ts|tsx)$'), { status: 'ok', paths: paths.slice(0, 2) });
  assert.equal(r.matchReviewPaths(paths, '[').reason, 'invalid_regex');
  assert.equal(r.matchReviewPaths(paths, 'x'.repeat(513)).reason, 'pattern_too_long');
  const q = { entries: paths.map(path => ({ path, status: 'pending' })), selected: paths[0] };
  assert.equal(r.reviewPage(q, '.ts').count, 3);
  assert.equal(r.reviewPage(q, '', false, 0, new Set([paths[1]])).count, 1);
  assert.equal(r.reviewPage(q, '', false, 0, new Set()).count, 0);
});
