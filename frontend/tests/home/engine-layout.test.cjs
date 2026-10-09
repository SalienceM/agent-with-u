const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultEngineLayout: defaults, normalizeEngineLayout, readEngineLayout, writeEngineLayout, fittedEngineWidths } = require('../../.home-test-dist/utils/engineLayout.js');
const storage = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v), data }; };
test('layout clamps dimensions and serializes only navigation, never document bodies', () => {
  const s = storage();
  writeEngineLayout(s, 'u/node/session', { ...defaults, filesWidth: Infinity, conversationWidth: 2000, terminalHeight: -2, text: 'SECRET', token: 'SECRET' });
  const layout = readEngineLayout(s, 'u/node/session');
  assert.equal(layout.filesWidth, 240); assert.equal(layout.conversationWidth, 720); assert.equal(layout.terminalHeight, 100);
  assert.ok(![...s.data.values()].join('').includes('SECRET'));
  assert.deepEqual(normalizeEngineLayout({ version: 0, filesWidth: 400 }), defaults);
});
test('layout storage isolates accounts, nodes, sessions and windows; unavailable storage is explicit', () => {
  const a = storage(), b = storage();
  for (const key of ['u1/n1/s1', 'u2/n1/s1', 'u1/n2/s1', 'u1/n1/s2']) assert.deepEqual(readEngineLayout(a, key), defaults);
  writeEngineLayout(a, 'u1/n1/s1', { ...defaults, filesWidth: 400, region: 'terminal', filesCollapsed: true });
  assert.equal(readEngineLayout(a, 'u1/n1/s1').filesWidth, 400);
  for (const key of ['u2/n1/s1', 'u1/n2/s1', 'u1/n1/s2']) assert.deepEqual(readEngineLayout(a, key), defaults);
  assert.deepEqual(readEngineLayout(b, 'u1/n1/s1'), defaults);
  const denied = { getItem() { throw Error(); }, setItem() { throw Error(); } };
  assert.deepEqual(readEngineLayout(denied, 'x'), defaults); assert.equal(writeEngineLayout(denied, 'x', defaults), false);
});
test('fitting leaves a usable document region without mutating preferred dimensions', () => {
  const preferred = { ...defaults, filesWidth: 480, conversationWidth: 720 };
  const small = fittedEngineWidths(preferred, 900);
  assert.ok(small.files + small.conversation <= 568);
  assert.deepEqual(fittedEngineWidths(preferred, 1700), { files: 480, conversation: 720 });
  assert.deepEqual(fittedEngineWidths({ ...preferred, filesCollapsed: true }, 1200), { files: 0, conversation: 720 });
});
