const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewOverview } = require('../../.home-test-dist/utils/aimeinReviewSummary.js');
const reports = () => [1, 2, 3].map(i => ({ id: `review${i}`, model: `model${i}`, status: 'passed', criteria: [{ id: 'C1', status: 'verified', reason: 'saved evidence', evidence: ['test'] }] }));
const summary = reviews => ({ accepted: true, complete: false, reviews, criteria: [{ id: 'C1', acceptance: '保存重开一致' }], issues: [] });
test('overall opinion requires all three full reports, preserves unknown and never majority-votes', () => {
  const reviews = reports();
  assert.equal(reviewOverview(summary(reviews), { reviews }).accepted, true);
  assert.equal(reviewOverview(summary(reviews), { reviews }).common.length, 1);
  assert.equal(reviewOverview(summary(reviews)).accepted, false);
  assert.equal(reviewOverview(summary(reviews)).common.length, 0);
  reviews[2].status = 'running';
  assert.equal(reviewOverview(summary(reviews), { reviews }).accepted, false);
  assert.equal(reviewOverview(summary(reviews), { reviews }).returned, 2);
  reviews[2].status = 'error';
  assert.equal(reviewOverview(summary(reviews), { reviews }).common.length, 0);
});
test('conflicting observations retain all reasons and explicit next focus without erasing a minority', () => {
  const reviews = reports(); reviews[2].status = 'changes_requested'; reviews[2].criteria[0] = { id: 'C1', status: 'gap', reason: '离线恢复丢失', evidence: ['offline-test'] };
  const result = reviewOverview({ ...summary(reviews), accepted: false, nextFocus: '补齐离线恢复' }, { reviews });
  assert.equal(result.accepted, false); assert.equal(result.common.length, 0);
  assert.equal(result.problems[0].disagreement, true);
  assert.equal(result.problems[0].opinions[2].item.reason, '离线恢复丢失');
  assert.equal(result.next, '补齐离线恢复');
});

test('one or two frozen reviewers require the exact roster and never reinterpret legacy missing reports', () => {
  for (const count of [1, 2]) {
    const reviews = reports().slice(0, count);
    const s = { ...summary(reviews), reviewerCount: count }, d = { reviews, reviewerCount: count };
    assert.equal(reviewOverview(s, d).accepted, true);
    assert.equal(reviewOverview(s, d).expected, count);
    assert.equal(reviewOverview(summary(reviews), { reviews }).accepted, false);
    assert.equal(reviewOverview(s, { reviews }).accepted, false);
    assert.equal(reviewOverview(s, { ...d, reviews: reviews.slice(1) }).accepted, false);
    const incomplete = structuredClone(d); incomplete.reviews[0].criteria = [];
    assert.equal(reviewOverview(s, incomplete).accepted, false);
    reviews[0].status = 'error'; assert.equal(reviewOverview(s, d).accepted, false);
  }
});
