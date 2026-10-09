const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthoritativeReadGate } = require('../../.home-test-dist/utils/authoritativeReadGate.js');
test('late authority reads cannot revive resolved plans or replace newer reads; accounts and nodes stay isolated', () => {
  const gate = new AuthoritativeReadGate(), old = gate.begin('alice/node1/session');
  gate.begin('alice/node2/session'); assert.equal(gate.current('alice/node1/session', old), true);
  const pushed = gate.begin('alice/node1/session');
  assert.equal(gate.current('alice/node1/session', old), false);
  assert.equal(gate.current('alice/node1/session', pushed), true);
  gate.clear(); assert.equal(gate.current('alice/node1/session', pushed), false);
  gate.begin('alice/node1/session'); assert.equal(gate.current('alice/node1/session', old), false);
});
