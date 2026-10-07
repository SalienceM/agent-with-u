const assert = require('node:assert/strict');
const { test } = require('node:test');
const { LoopControlTransport, requestWithReadiness } = require('../../.home-test-dist/utils/loopControlTransport.js');
const target = { user: 'local', executor: 'node-a', session: 's' };
const input = { requestId: 'one', action: 'takeover', expectedControlRevision: 0 };
function fixture(call) {
  return new LoopControlTransport({ target: () => target, call, current: () => ({ phase: 'idle', since: 0 }) });
}
test('strict identity and executor never fall back to another node or a mock', async () => {
  const calls = [];
  const transport = fixture(async (...args) => { calls.push(args); throw new Error('offline'); });
  for (const changed of [{ ...target, executor: '' }, { ...target, executor: 'node-b' }, { ...target, user: 'other' }]) {
    await assert.rejects(transport.read(changed, ''), /身份或执行节点/);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(transport.read(target, ''), /offline/);
  assert.equal(calls[0][0], 'node-a');
  assert.ok(calls[0][3] > 11000 && calls[0][3] <= 12000);
});
test('unknown modern writes never call legacy mutation, even for null or malformed receipts', async () => {
  for (const reply of [null, undefined, 'broken-json', {}, { status: 'accepted' }]) {
    const calls = [];
    const transport = fixture(async (_node, method) => { calls.push(method); return reply; });
    await assert.rejects(transport.request(target, input, false));
    assert.deepEqual(calls, ['loopControlRequest']);
  }
});
test('legacy discovery requires matching successful old metadata and is read-only', async () => {
  const calls = [];
  const transport = fixture(async (_node, method) => {
    calls.push(method);
    return method === 'loopControlGet' ? null : method === 'loadSessionMeta'
      ? { id: 's', sessionType: 'loop' }
      : { sessionId: 's', controlMode: 'loop', canTakeover: true, running: false };
  });
  const summary = await transport.read(target, '');
  assert.equal(summary.protocolVersion, 0);
  assert.match(summary.eligibility.takeover.message, /阶段详情不可用/);
  assert.deepEqual(calls, ['loopControlGet', 'loadSessionMeta', 'loopGetState']);
  for (const meta of [null, { id: 'wrong', sessionType: 'loop' }, { id: 's', sessionType: 'loop', loopControlProtocolVersion: 1 }]) {
    const newer = fixture(async (_node, method) => method === 'loopControlGet' ? null : meta);
    await assert.rejects(newer.read(target, ''), /协议/);
  }
});
test('readiness consumes the same deadline and offline/readiness failure never sends RPC', async () => {
  let writes = 0;
  const connection = { ready: Promise.resolve(), isOpen: false, request: async () => { writes++; } };
  await assert.rejects(requestWithReadiness(connection, 'write', [], 15), /离线/);
  connection.isOpen = true;
  connection.ready = new Promise(() => {});
  await assert.rejects(requestWithReadiness(connection, 'write', [], 15), /超时/);
  assert.equal(writes, 0);
  connection.ready = new Promise(r => setTimeout(r, 20));
  connection.request = async (_method, _params, budget) => { writes++; return budget; };
  const remaining = await requestWithReadiness(connection, 'write', [], 200);
  assert.ok(remaining > 0 && remaining < 200);
  assert.equal(writes, 1);
});
