const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectionLabel, sourceStatus, mergeAsideTurns, matchesThoughtsScope } = require('../../.home-test-dist/utils/thoughtsInspection.js');

test('aside terminal and newer revisions survive late phases, clear remains explicit', () => {
  const done = { id: 'a', status: 'done', inspection: { phase: 'done', sequence: 4 } };
  assert.equal(mergeAsideTurns([done], [{ id: 'a', status: 'answering', inspection: { sequence: 9 } }])[0], done);
  assert.equal(mergeAsideTurns([done], [{ id: 'a', status: 'error', inspection: { sequence: 3 } }])[0], done);
  assert.deepEqual(mergeAsideTurns([done], []), []);
  assert.equal(mergeAsideTurns([{ id: 'old-server', status: 'answering', inspection: { sequence: 0 } }],
    [{ id: 'old-server', status: 'done' }])[0].status, 'done');
  const unknown = { id: 'a', status: 'answering', inspection: { phase: 'unknown', sequence: 5 } };
  assert.equal(mergeAsideTurns([unknown], [{ ...done, inspection: { sequence: 6 } }])[0].status, 'done');
});
test('session and exact executor must both match; unknown does not become local', () => {
  assert.equal(matchesThoughtsScope('s', 'local', { sessionId: 's' }, 'remote'), false);
  assert.equal(matchesThoughtsScope('s', 'local', { sessionId: 's' }), false);
  assert.equal(matchesThoughtsScope('s', '', { sessionId: 's' }, ''), false);
  assert.equal(matchesThoughtsScope('s', 'remote', { sessionId: 't' }, 'remote'), false);
  assert.equal(matchesThoughtsScope('s', 'remote', { sessionId: 's' }, 'remote'), true);
});
test('actual query phases and failure types are distinct without fabricating old evidence', () => {
  for (const phase of ['preparing', 'reading', 'answering', 'done', 'error', 'cancelled', 'unknown']) {
    assert.notEqual(inspectionLabel('answering', { phase }), '状态未记录');
  }
  for (const code of ['missing', 'denied', 'limit', 'identity_changed', 'model_error']) {
    assert.notEqual(inspectionLabel('error', { errorCode: code }), '查询失败');
  }
  assert.equal(sourceStatus({ status: 'ok', complete: false }), '部分覆盖');
  assert.equal(sourceStatus({ status: 'denied' }), '访问被拒绝');
  assert.equal(sourceStatus({}), '状态未记录');
});
