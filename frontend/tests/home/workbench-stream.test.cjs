const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkbenchStreamGate } = require('../../.home-test-dist/utils/workbenchStream.js');
const delta = (n, extra = {}) => ({ sessionId: 's', streamEpoch: 'epoch', streamSequence: n, type: 'text_delta', text: `${n}`, ...extra });
const snapshot = { position: { epoch: 'epoch', sequence: 2, complete: true }, state: '12' };
test('same Session IDs on different executors/accounts keep distinct accumulators across replay', async () => {
  const { ScopedStreamStates } = require('../../.home-test-dist/utils/scopedStreamStates.js');
  const states = new ScopedStreamStates(); let user = 'alice', selected = 'node-a';
  states.configure((session, executor) => JSON.stringify([user, executor || selected, session]));
  const gate = new WorkbenchStreamGate((event, key) => {
    const executor = JSON.parse(key)[1]; states.set(event.sessionId, (states.get(event.sessionId, executor) || '') + event.text, executor);
  });
  gate.push(JSON.stringify(['alice', 'node-a', 's']), delta(1, { text: 'A' }));
  gate.push(JSON.stringify(['alice', 'node-b', 's']), delta(1, { text: 'B' }));
  assert.equal(states.get('s'), 'A'); selected = 'node-b'; assert.equal(states.get('s'), 'B');
  await gate.restore(JSON.stringify(['alice', 'node-a', 's']), 's', { position: { epoch: 'epoch', sequence: 1, complete: true }, state: 'A' },
    async () => ({ status: 'ok', sessionId: 's', streamEpoch: 'epoch', lastSequence: 2, gap: false, events: [delta(2, { text: '2' })] }),
    value => states.set('s', value, 'node-a'), () => true);
  assert.equal(states.get('s', 'node-a'), 'A2'); assert.equal(states.get('s', 'node-b'), 'B');
  user = 'bob'; assert.equal(states.get('s', 'node-a'), undefined);
});
test('stream cursor deduplicates live/replay and refuses incomplete source snapshot', () => {
  const seen = [], gate = new WorkbenchStreamGate(d => seen.push(d.text));
  gate.push('s', delta(1)); gate.push('s', delta(2)); gate.push('s', delta(1));
  assert.deepEqual(seen, ['1', '2']); assert.equal(gate.capture('s', '12').position.sequence, 2);
  gate.push('s', delta(4)); assert.throws(() => gate.capture('s', '124'), /缺口/);
  gate.push('s', delta(5, { streamMessageStart: true })); assert.equal(gate.capture('s', '5').position.complete, true);
  gate.push('other', delta(9)); assert.throws(() => gate.capture('other', '9'), /缺口/);
});
test('snapshot + journal + concurrent live events merge once in sequence without model calls', async () => {
  let visible = 'partial', resolve;
  const gate = new WorkbenchStreamGate(d => { visible += d.text; });
  const wait = gate.restore('s', 's', snapshot, () => new Promise(r => { resolve = r; }), state => { visible = state; }, () => true);
  gate.push('s', delta(3)); gate.push('s', delta(4));
  resolve({ status: 'ok', sessionId: 's', streamEpoch: 'epoch', lastSequence: 3, events: [delta(3)], gap: false });
  await wait; assert.equal(visible, '1234'); gate.push('s', delta(4)); gate.push('s', delta(5)); assert.equal(visible, '12345');
});
test('gap, epoch reset, oversized buffering and stale identity never install/ACK snapshot', async () => {
  for (const fault of ['gap', 'epoch', 'overflow', 'identity', 'missing']) {
    let installed = false, current = true, resolve, seen = 0;
    const gate = new WorkbenchStreamGate(() => seen++);
    const wait = gate.restore('s', 's', snapshot, () => new Promise(r => { resolve = r; }), () => { installed = true; }, () => current);
    if (fault === 'overflow') gate.push('s', delta(3, { text: 'x'.repeat(4 * 1024 * 1024) }));
    if (fault === 'identity') { gate.push('s', delta(3)); current = false; gate.clear(); }
    resolve({ status: 'ok', sessionId: 's', streamEpoch: fault === 'epoch' ? 'new' : 'epoch', gap: fault === 'gap',
      lastSequence: fault === 'missing' ? 4 : 3, events: [delta(3)] });
    await assert.rejects(wait); assert.equal(installed, false);
    if (fault === 'identity') assert.equal(seen, 0);
  }
});
test('empty idle history works but unsupported unsequenced stream is never complete', async () => {
  const gate = new WorkbenchStreamGate(() => {}); let installed = false;
  await gate.restore('s', 's', { position: { epoch: '', sequence: 0, complete: true }, state: '' },
    async () => ({ status: 'unavailable' }), () => { installed = true; }, () => true);
  assert.equal(installed, true); gate.push('s', { sessionId: 's', type: 'text_delta', text: 'old' });
  assert.throws(() => gate.capture('s', 'old'), /缺口/);
});
