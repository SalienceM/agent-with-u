const test = require('node:test');
const assert = require('node:assert/strict');
const { readSessionWindowRoute, sessionWindowUrl } = require('../../.home-test-dist/utils/sessionWindowRoute.js');
const { beginSessionDrag, readSessionDrag, consumeSessionDrag } = require('../../.home-test-dist/utils/sessionWindowDrag.js');
const { windowTransport } = require('../../.home-test-dist/utils/workbenchWindows.js');
test('independent window URL carries only bounded routing identifiers', () => {
  const route = { session: 's', executor: 'relay:device', windowId: 'child', homeWindow: 'main' };
  const url = sessionWindowUrl('/app', route);
  assert.deepEqual(readSessionWindowRoute(url.slice(url.indexOf('?'))), route);
  assert.equal(new URLSearchParams(url.split('?')[1]).size, 5);
  assert.equal(readSessionWindowRoute('?sessionWindow=1&windowSession=../../secret'), null);
  assert.throws(() => sessionWindowUrl('/app', { ...route, windowId: 'bad id' }));
});
test('desktop drag wakeup requires a matching live source gesture, never arbitrary IDs', () => {
  const t = windowTransport; t.clear(); t.activate({ clientId: 'client', windowId: 'source' });
  t.observe('e', { status: 'ok', workspace: { sessionId: 's' }, clientId: 'client', windowId: 'source', generation: 1, revision: 1, frozen: false, pending: null });
  const gesture = beginSessionDrag('s', 'e'); assert.ok(gesture);
  assert.deepEqual(readSessionDrag(JSON.stringify(gesture)), gesture);
  assert.equal(readSessionDrag(JSON.stringify({ ...gesture, token: 'secret' })), null);
  assert.equal(consumeSessionDrag('other', gesture.nonce), false);
  assert.equal(consumeSessionDrag('s', 'forged'), false);
  assert.equal(consumeSessionDrag('s', gesture.nonce), true); assert.equal(consumeSessionDrag('s', gesture.nonce), false);
  t.hold('e', 's', true); assert.equal(beginSessionDrag('s', 'e'), null); t.clear();
});
