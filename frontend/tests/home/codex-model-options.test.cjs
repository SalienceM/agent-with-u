const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CODEX_MODELS, normalizeCodexModelOptions: normalize, cloneCodexModelOptions: clone,
  resolveCodexModelOptions: resolve, assertCodexModelOptionsSaved: verify, saveAndVerifyBackend,
} = require('../../.home-test-dist/utils/codexModelOptions.js');
const { createBackendCatalog } = require('../../.home-test-dist/utils/backendCatalog.js');

test('builtins, replacement and empty mode; independent drafts, non-Codex unaffected', () => {
  assert.deepEqual(resolve({ type: 'codex-office' }), CODEX_MODELS);
  assert.deepEqual(resolve({ type: 'codex-office', modelOptions: null }), CODEX_MODELS);
  assert.deepEqual(resolve({ type: 'codex-office', modelOptions: [] }), []);
  const custom = [{ id: 'future/b', label: '同名' }, { id: 'A', label: '同名' }];
  assert.deepEqual(resolve({ type: 'codex-office', modelOptions: custom }), custom);
  assert.deepEqual(resolve({ type: 'qwen-code-cli', modelOptions: custom }), []);
  const copied = clone(custom);
  copied[0].id = 'changed'; copied.reverse();
  assert.equal(custom[0].id, 'future/b');
  const builtinDraft = resolve({ type: 'codex-office' });
  builtinDraft[0].id = 'changed';
  assert.notEqual(CODEX_MODELS[0].id, 'changed');
});

test('same Python boundaries; future IDs, case and unicode codepoint lengths', () => {
  assert.equal(normalize(null), null);
  assert.deepEqual(normalize([]), []);
  assert.deepEqual(normalize([{ id: ' \u0085vendor/future:fast\u3000', label: ' 常用 ' }, { id: 'A', label: ' ' }]),
    [{ id: 'vendor/future:fast', label: '常用' }, { id: 'A' }]);
  assert.equal(normalize([{ id: 'x'.repeat(200), label: '😀'.repeat(120) }]).length, 1);
  assert.equal(normalize([{ id: 'a', label: 'same' }, { id: 'A', label: 'same' }]).length, 2);
  assert.equal(normalize(Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))).length, 100);
  for (const invalid of [false, {}, 'x', [null], ['x'], [{}], [{ id: 3 }], [{ id: ' ' }],
    [{ id: 'a b' }], [{ id: 'a\u0085b' }], [{ id: 'a\x00b' }], [{ id: 'a', label: null }],
    [{ id: 'a', label: 'a\x7fb' }], [{ id: 'x'.repeat(201) }], [{ id: 'a', label: '😀'.repeat(121) }],
    [{ id: 'a' }, { id: ' a ' }], Array.from({ length: 101 }, (_, i) => ({ id: String(i) })), [{ id: 'a', extra: true }]]) {
    assert.throws(() => normalize(invalid));
  }
  assert.throws(() => normalize([{ id: 'valid' }, { id: '' }]), /第 2 项/);
});

test('readback checks all modes; missing old server field cannot report custom or empty saved', async () => {
  for (const options of [null, [], [{ id: 'a' }]]) {
    const draft = { id: 'shared', type: 'codex-office', modelOptions: options };
    const calls = [];
    const output = await saveAndVerifyBackend(draft, 'remote', async (config, node) => calls.push(['save', node, config]),
      async (node, disabled) => { calls.push(['read', node, disabled]); return [structuredClone(draft)]; });
    assert.deepEqual(output, [draft]);
    assert.equal(calls[0][1], 'remote');
    assert.deepEqual(calls[1], ['read', 'remote', true]);
    if (options !== null) assert.throws(() => verify(draft, { type: 'codex-office' }), /其他字段可能已保存/);
    assert.throws(() => verify(draft, undefined), /未保存/);
  }
  const draft = { id: 'shared', type: 'codex-office', modelOptions: [] };
  let reads = 0;
  await assert.rejects(saveAndVerifyBackend(draft, 'remote', async () => { throw new Error('offline'); }, async () => { reads++; return []; }), /offline/);
  assert.equal(reads, 0);
  await assert.rejects(saveAndVerifyBackend(draft, 'remote', async () => {}, async () => { throw new Error('offline'); }), /回读失败/);
  await assert.rejects(saveAndVerifyBackend(draft, 'remote', async () => {}, async () => [{ id: 'shared', type: 'codex-office' }]), /执行端已升级/);
  assert.deepEqual(draft.modelOptions, []);
});

test('node scoped revision, coalescing, late read isolation and reopen; no polling or fallback', async () => {
  const requests = [];
  const catalog = createBackendCatalog(node => new Promise((resolve, reject) => requests.push({ node, resolve, reject })));
  const eventsA = [], eventsB = [];
  const stopA = catalog.subscribe('A', e => eventsA.push(e));
  const stopB = catalog.subscribe('B', e => eventsB.push(e));
  const old = catalog.read('B');
  assert.equal(catalog.read('B'), old);
  const a = catalog.read('A');
  await Promise.resolve();
  assert.deepEqual(requests.map(r => r.node), ['B', 'A']);
  catalog.publish('B', 'shared');
  assert.equal(eventsA.length, 0);
  assert.deepEqual(eventsB, [{ execKey: 'B', backendId: 'shared' }]);
  const fresh = catalog.read('B');
  assert.notEqual(fresh, old);
  await Promise.resolve();
  requests[0].resolve([{ id: 'shared', modelOptions: [{ id: 'stale' }] }]);
  await old;
  assert.equal(catalog.read('B'), fresh, 'old completion must not evict fresh in-flight read');
  requests[1].resolve([{ id: 'shared', modelOptions: [{ id: 'node-a' }] }]);
  requests[2].resolve([{ id: 'shared', modelOptions: [{ id: 'node-b' }] }]);
  assert.equal((await a)[0].modelOptions[0].id, 'node-a');
  assert.equal((await fresh)[0].modelOptions[0].id, 'node-b');
  const reopen = catalog.read('B');
  await Promise.resolve();
  requests[3].reject(new Error('B offline'));
  await assert.rejects(reopen, /B offline/);
  assert.equal(requests.length, 4);
  stopA(); stopB(); catalog.publish('B', 'shared');
  assert.equal(eventsB.length, 1);
});
