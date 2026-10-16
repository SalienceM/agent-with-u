const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodexReasoningCatalog: parse, normalizeReasoningEffort: normalize, readCodexReasoning: read } =
  require('../../.home-test-dist/utils/codexReasoning.js');
const result = { status: 'ok', source: 'codex-app-server', freshness: 'unknown', fetchedAt: '2026-10-13T00:00:00Z',
  modelOptions: [{ id: 'a' }, { id: 'b' }], reasoningCapabilities: [
    { model: 'a', defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [
      { reasoningEffort: 'high', description: 'Native high' }, { reasoningEffort: 'ultra', description: 'Native new effort' }] },
    { model: 'b', defaultReasoningEffort: 'none', supportedReasoningEfforts: [] }] };

test('native per-model order, defaults, descriptions, new effort and empty capabilities survive', () => {
  assert.deepEqual(parse(result), result.reasoningCapabilities);
  assert.notEqual(parse(result)[0], result.reasoningCapabilities[0]);
  assert.deepEqual(parse({ ...result, reasoningCapabilities: undefined }), []);
  assert.equal(normalize(' Ultra '), 'ultra');
  for (const input of [null, {}, 'a'.repeat(65), 'high;cmd', 'high"', 'high\ncmd']) assert.equal(normalize(input), '');
});

test('malformed and duplicate native capabilities never produce a fixed fallback', () => {
  const row = result.reasoningCapabilities[0];
  for (const value of [null, {}, [row, row], [{ ...row, model: 'missing' }],
    [{ ...row, defaultReasoningEffort: 'low' }], [{ ...row, supportedReasoningEfforts: [null] }],
    [{ ...row, supportedReasoningEfforts: Array(33).fill(row.supportedReasoningEfforts[0]) }],
    [{ ...row, supportedReasoningEfforts: [{ reasoningEffort: 'secret;cmd', description: '' }] }]]) {
    assert.throws(() => parse({ ...result, reasoningCapabilities: value }), e => !e.message.includes('secret'));
  }
});

test('in-flight reads coalesce by identity only; completed reads and failures are not cached', async () => {
  let complete, count = 0;
  const loader = () => { count++; return new Promise(resolve => { complete = resolve; }); };
  const a = read('node-A/session/backend', loader);
  assert.equal(read('node-A/session/backend', loader), a);
  await Promise.resolve();
  const b = read('node-B/session/backend', async () => result);
  assert.notEqual(a, b);
  complete(result);
  await Promise.all([a, b]);
  assert.equal(count, 1);
  await read('node-A/session/backend', async () => { count++; return result; });
  assert.equal(count, 2);
  await assert.rejects(read('error', async () => { throw new Error('offline'); }));
  assert.deepEqual(await read('error', async () => result), result.reasoningCapabilities);
});
