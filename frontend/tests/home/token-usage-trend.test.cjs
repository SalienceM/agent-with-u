const { test } = require('node:test');
const assert = require('node:assert/strict');
const { directionalTokens, tokenTrendStats } = require('../../.home-test-dist/utils/tokenUsageTrend.js');

test('input and output trends stay independent even when their sum is constant', () => {
  const events = [100, 100, 200, 200].map(inputTokens => ({ inputTokens, outputTokens: 300 - inputTokens }));
  assert.deepEqual(tokenTrendStats(events, 'input'), { latest: 200, average: 150, peak: 200, trend: '近期上升 100%' });
  assert.deepEqual(tokenTrendStats(events, 'output'), { latest: 100, average: 150, peak: 200, trend: '近期下降 50%' });
  assert.deepEqual(tokenTrendStats(events, 'total'), { latest: 300, average: 300, peak: 300, trend: '近期基本平稳' });
});

test('latest, six-call average and sixteen-call peak use their own bounded windows', () => {
  const events = Array.from({ length: 24 }, (_, i) => ({ inputTokens: i === 0 ? 90000 : i + 1, outputTokens: i + 101 }));
  assert.deepEqual(tokenTrendStats(events, 'input'), { latest: 24, average: 22, peak: 24, trend: '近期上升 15%' });
  assert.equal(tokenTrendStats(events, 'output').average, 122);
  assert.equal(tokenTrendStats(events, 'output').peak, 124);
});

test('empty, single-point and all-zero usage produce finite statistics', () => {
  assert.deepEqual(tokenTrendStats([], 'output'), { latest: 0, average: 0, peak: 0, trend: '数据积累中' });
  assert.equal(tokenTrendStats([{ outputTokens: 10 }], 'output').latest, 10);
  assert.equal(tokenTrendStats(Array(6).fill({ outputTokens: 0 }), 'output').trend, '近期基本平稳');
  assert.equal(tokenTrendStats([{}, {}, { outputTokens: 2 }, { outputTokens: 2 }], 'output').trend, '近期从零上升');
});

test('counts are normalized and cached/reasoning subcounts are not added a second time', () => {
  assert.equal(directionalTokens({ inputTokens: -1, outputTokens: Infinity }, 'total'), 0);
  assert.equal(directionalTokens({ inputTokens: 10.9, outputTokens: NaN }, 'input'), 10);
  const event = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, reasoningOutputTokens: 10, estimated: true };
  assert.equal(directionalTokens(event, 'total'), 120);
  assert.equal(tokenTrendStats([event], 'output').latest, 20);
});
