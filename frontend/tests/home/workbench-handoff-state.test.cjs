const test = require('node:test');
const assert = require('node:assert/strict');
const { handoffEnvelope, readHandoffEnvelope, HandoffParticipants } = require('../../.home-test-dist/utils/workbenchHandoffState.js');
const workspace = { ownerId: 'alice', executorInstance: 'instance', sessionId: 's', workingDir: '/qa', workspaceRevision: 'a'.repeat(64) };
const make = () => ({ format: 1, workspace, clientId: 'client', sourceWindow: 'source', targetWindow: 'target', requestId: 'op', version: 1,
  parts: { input: { text: 'unsent' }, layout: { version: 1 } } });
test('handoff payload is bounded and exact, with no incidental fields or permissions', () => {
  const envelope = handoffEnvelope(make());
  assert.deepEqual(readHandoffEnvelope(envelope.payload, workspace, 'client', 'target', envelope.digest).state, make());
  for (const mutation of [p => { p.token = 'secret'; }, p => { p.parts.kitApprovalDelegation = true; },
    p => { p.parts.input.text = 'x'.repeat(17 * 1024 * 1024); }, p => { p.workspace.credential = 'secret'; }]) {
    const value = make(); mutation(value); assert.throws(() => handoffEnvelope(value));
  }
  assert.throws(() => readHandoffEnvelope(envelope.payload, { ...workspace, ownerId: 'bob' }, 'client', 'target', envelope.digest));
  assert.throws(() => readHandoffEnvelope(envelope.payload, workspace, 'client', 'wrong-window', envelope.digest));
  assert.throws(() => readHandoffEnvelope(envelope.payload.replace('unsent', 'tampered'), workspace, 'client', 'target', envelope.digest));
});
test('participants export only registered state and layout can mount later participants before ACK', async () => {
  const registry = new HandoffParticipants(), received = [];
  registry.register('scope', 'layout', { export: () => ({ mode: 'engine' }), import: () => {
    registry.register('scope', 'input', { export: () => ({ text: 'draft' }), import: value => received.push(value) });
  } });
  await registry.restore('scope', { layout: {}, input: { text: 'transferred' } }, () => true);
  assert.deepEqual(received, [{ text: 'transferred' }]);
  assert.deepEqual(await registry.capture('scope'), { layout: { mode: 'engine' }, input: { text: 'draft' } });
  assert.deepEqual(await registry.capture('other-user'), {});
  assert.throws(() => registry.register('scope', 'input', { export() {}, import() {} }), /重复/);
  await assert.rejects(registry.restore('scope', { input: {} }, () => false), /身份/);
});
