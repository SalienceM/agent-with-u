const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogConnectionSaved, parseCodexCatalogResult } = require('../../.home-test-dist/utils/codexCatalogSync.js');

const draft = { id: 'codex', type: 'codex-office', apiKey: 'secret', env: { CODEX_HOME: 'test', empty: '' } };
const result = { status: 'ok', modelOptions: [{ id: 'future/z', label: '新版' }, { id: 'future/a' }],
  source: 'codex-app-server', freshness: 'unknown', fetchedAt: '2026-10-06T00:00:00Z' };

test('connection comparison ignores candidates but covers all source fields', () => {
  assert.equal(catalogConnectionSaved(draft, null), false);
  assert.equal(catalogConnectionSaved({ ...draft, modelOptions: [], model: 'changed' }, draft), true);
  assert.equal(catalogConnectionSaved({ ...draft, env: { CODEX_HOME: ' test ' } }, draft), true);
  for (const key of ['id', 'type', 'apiKey', 'baseUrl', 'cliPath', 'workingDir']) {
    assert.equal(catalogConnectionSaved({ ...draft, [key]: 'different' }, draft), false, key);
  }
  assert.equal(catalogConnectionSaved({ ...draft, env: { CODEX_HOME: 'other' } }, draft), false);
});

test('complete catalog preserves order with independent rows', () => {
  const parsed = parseCodexCatalogResult(result);
  assert.deepEqual(parsed.modelOptions, result.modelOptions);
  assert.notEqual(parsed.modelOptions[0], result.modelOptions[0]);
  assert.equal(parsed.fetchedAt, '2026-10-06T00:00:00.000Z');
});

test('malformed, empty, invalid and partial responses never become successful catalogs', () => {
  for (const value of [null, {}, { ...result, modelOptions: null }, { ...result, modelOptions: [] },
    { ...result, modelOptions: [{ id: 'secret bad' }] }, { ...result, modelOptions: [{ id: 'a' }, { id: 'a' }] },
    { ...result, modelOptions: Array.from({ length: 101 }, (_, i) => ({ id: String(i) })) },
    { ...result, source: 'official-latest' }, { ...result, freshness: 'latest' }, { ...result, fetchedAt: 'bad' }]) {
    assert.throws(() => parseCodexCatalogResult(value), error => !error.message.includes('secret'));
  }
});

test('server errors mapped safely, without raw error text', () => {
  for (const code of ['backend', 'unsupported', 'auth', 'empty', 'invalid', 'incomplete', 'timeout', 'limit', 'unknown']) {
    assert.throws(() => parseCodexCatalogResult({ status: 'error', code, message: 'secret' }),
      error => !error.message.includes('secret'));
  }
});
