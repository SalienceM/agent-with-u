const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tokenContext } = require('../../.home-test-dist/utils/tokenUsageContext.js');

test('Harness last input is usable without a known context window', () => {
  const value = tokenContext({ contextTokens: 171859 });
  assert.equal(value.tokens, 171859);
  assert.equal(value.percent, null);
  assert.equal(value.window, null);
});

test('reported zero differs from missing and never falls back to lifetime totals', () => {
  assert.equal(tokenContext({ contextTokens: 0, contextWindow: 100000 }).percent, 0);
  assert.equal(tokenContext({ inputTokens: 6000000 }).tokens, null);
  assert.equal(tokenContext({ contextTokens: 90000, contextWindow: 100000, contextApprox: true }).tokens, null);
  assert.equal(tokenContext(null).tokens, null);
  assert.equal(tokenContext({ contextTokens: NaN, contextWindow: Infinity }).percent, null);
});

test('configured limits and LOOP scope stay explicit; percentages are not concealed at 100', () => {
  const value = tokenContext({ contextTokens: 120, contextWindow: 100, contextWindowSource: 'configured', source: 'loop' });
  assert.equal(value.percent, 120);
  assert.equal(value.windowSource, 'Backend 配置上限');
  assert.equal(value.label, '最近 LOOP 请求上下文');
});
