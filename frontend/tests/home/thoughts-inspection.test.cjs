const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectionLabel, sourceStatus, sourceRange, mergeAsideTurns, matchesThoughtsScope } = require('../../.home-test-dist/utils/thoughtsInspection.js');

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

test('ranges distinguish directory pages, search coverage and actual text offsets', () => {
  assert.equal(sourceRange({ operation: 'list_directory', offset: 0 }), '目录分页（偏移 0）');
  assert.equal(sourceRange({ operation: 'list_directory', offset: 200, entryCount: 12, nextOffset: 400 }),
    '目录项：本页 12 项（偏移 200）；下一页偏移 400');
  assert.equal(sourceRange({ operation: 'search_text', visited: 14, matchCount: 2 }), '搜索覆盖：检查 14 个文件目标，命中 2 处');
  assert.equal(sourceRange({ operation: 'read_text', offset: 0, end: 100, complete: false }), '字符范围：0–100（非全文）');
  for (const source of [{ operation: 'read_text', offset: 0 }, { offset: 0, end: 50 },
    { operation: 'read_text', offset: NaN, end: Infinity }, { operation: 'read_text', offset: 100, end: 0 }]) {
    assert.equal(sourceRange(source), '');
  }
});

test('limit reasons are explicit and legacy sources remain unknown', () => {
  for (const limitReason of ['file_bytes', 'total_bytes', 'search_bytes', 'context_chars', 'operations', 'rounds', 'answer_reserve']) {
    assert.match(sourceStatus({ status: 'limit', limitReason }), /^读取受限 · /);
  }
  assert.match(sourceStatus({ status: 'ok', complete: false, limitReason: 'search_bytes' }), /^部分覆盖 · 搜索读取额度/);
  assert.equal(sourceStatus({ status: 'limit' }), '达到查询上限');
  assert.equal(sourceStatus({ status: 'limit', limitReason: 'unknown' }), '达到查询上限');
  assert.equal(sourceStatus({ status: 'limit', limitReason: 'constructor' }), '达到查询上限');
});
