const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LoopActionController } = require('../../.home-test-dist/utils/loopActionController.js');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('action feedback is immediate, double click deduped, acceptance not completion', async () => {
  const updates = [], gate = defer(); let calls = 0;
  const c = new LoopActionController(v => updates.push(v));
  const run = c.run('执行', () => { calls++; return gate.promise; }, true);
  assert.equal(c.feedback.phase, 'sending');
  await c.run('执行', async () => { calls++; return { status: 'ok' }; }, true);
  gate.resolve({ status: 'ok' }); await run;
  assert.equal(calls, 1); assert.equal(c.feedback.phase, 'accepted');
});
test('failure is visible even when backend omits message; successful setting is done', async () => {
  const c = new LoopActionController(() => {});
  await c.run('Auto', async () => ({ status: 'error' }));
  assert.equal(c.feedback.phase, 'error'); assert.match(c.feedback.message, /失败/);
  await c.run('Auto', async () => ({ status: 'ok' }));
  assert.equal(c.feedback.phase, 'done');
});
test('timeout gets one read, never writes again or accepts late result', async () => {
  const gate = defer(); let writes = 0, reads = 0;
  const c = new LoopActionController(() => {}, 5);
  await c.run('执行', () => { writes++; return gate.promise; }, true, async () => { reads++; return false; });
  assert.equal(c.feedback.phase, 'unknown');
  await c.run('执行', async () => { writes++; return { status: 'ok' }; });
  gate.resolve({ status: 'ok' }); await new Promise(r => setImmediate(r));
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(c.feedback.phase, 'unknown');
});
test('different Session is responsive and disposed response cannot publish', async () => {
  const gate = defer(), updates = [];
  const a = new LoopActionController(v => updates.push(v)), b = new LoopActionController(() => {});
  const run = a.run('执行', () => gate.promise);
  a.dispose(); await b.run('Auto', async () => ({ status: 'ok' }));
  gate.resolve({ status: 'ok' }); await run;
  assert.equal(updates.length, 1); assert.equal(b.feedback.phase, 'done');
});
test('manual read can confirm pending action; unrelated success does not permit write replay', async () => {
  let checked = false, writes = 0;
  const c = new LoopActionController(() => {}, 5);
  await c.run('执行', async () => { writes++; throw new Error('offline'); }, true, async () => checked);
  await c.run('设置', async () => ({ status: 'ok' }));
  await c.run('执行', async () => { writes++; return { status: 'ok' }; });
  assert.equal(writes, 1); assert.equal(c.feedback.phase, 'unknown');
  checked = true; await c.check();
  assert.equal(c.feedback.phase, 'accepted');
});
