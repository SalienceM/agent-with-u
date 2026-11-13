const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupCollapsed, saveGroupCollapsed, navigationScope } = require('../../.home-test-dist/utils/clientNavigation');
const { loadWorkbenchSnapshot, saveWorkbenchSnapshot, normalizeWorkbenchSnapshot } = require('../../.home-test-dist/utils/workbench');
const storage = () => { const rows = new Map(); return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) }; };
function fixture(run) {
  const old = global.window;
  global.window = { localStorage: storage(), sessionStorage: storage(), location: { origin: 'https://client', search: '' }, dispatchEvent() {} };
  try { run(window); } finally { global.window = old; }
}
const identity = { mode: 'relay', userId: 'alice', realm: 'https://relay-one/' };
test('node preferences survive new windows and isolate clients, users and realms', () => fixture(w => {
  saveGroupCollapsed(identity, 'node-a', true); saveGroupCollapsed(identity, 'node-b', false);
  w.sessionStorage = storage();
  assert.equal(groupCollapsed(identity, 'node-a'), true);
  assert.equal(groupCollapsed(identity, 'node-b'), false);
  assert.equal(groupCollapsed({ ...identity, userId: 'bob' }, 'node-a'), false);
  assert.equal(groupCollapsed({ ...identity, realm: 'https://other' }, 'node-a'), false);
  w.localStorage = storage(); w.localStorage.setItem('awu-window-client-v1:alice', 'client-other');
  assert.equal(groupCollapsed(identity, 'node-a'), false);
}));
test('cold start restores exact open tabs; detached and passive saves cannot replace main', () => fixture(w => {
  const a = normalizeWorkbenchSnapshot({ version: 1, workbench: { tabs: ['chat', 'session:a', 'session:c'], active: 'session:c' }, panes: ['c', 'a'], layout: '1x2' });
  saveWorkbenchSnapshot(identity, a);
  const mainWindow = w.sessionStorage;
  w.sessionStorage = storage();
  assert.deepEqual(loadWorkbenchSnapshot(identity), a);
  saveWorkbenchSnapshot(identity, normalizeWorkbenchSnapshot(null), false);
  w.sessionStorage = storage();
  assert.deepEqual(loadWorkbenchSnapshot(identity), a);
  w.location.search = '?sessionWindow=1&workbenchWindow=detached';
  saveWorkbenchSnapshot(identity, normalizeWorkbenchSnapshot({ version: 1, workbench: { tabs: ['session:d'], active: 'session:d' } }));
  w.location.search = ''; w.sessionStorage = mainWindow;
  assert.deepEqual(loadWorkbenchSnapshot(identity), a);
  w.sessionStorage = storage();
  assert.deepEqual(loadWorkbenchSnapshot(identity), a);
}));
test('malformed preferences do not crash; storage failure retains in-window choice', () => fixture(w => {
  w.localStorage.setItem(`${navigationScope(identity)}:group:bad`, '{');
  assert.equal(groupCollapsed(identity, 'bad'), false);
  w.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(saveGroupCollapsed(identity, 'offline', true), false);
  assert.equal(groupCollapsed(identity, 'offline'), true);
}));
test('existing v1 main snapshot migrates only into matching identity', () => fixture(w => {
  const old = normalizeWorkbenchSnapshot({ version: 1, workbench: { tabs: ['session:legacy'], active: 'session:legacy' } });
  w.localStorage.setItem('agent-with-u:workbench:v1:relay:alice', JSON.stringify(old));
  assert.equal(loadWorkbenchSnapshot(identity).workbench.active, 'chat');
  w.localStorage.setItem('awu.connectionTarget', JSON.stringify({ mode: 'relay', url: identity.realm, user: { userId: 'alice' } }));
  assert.deepEqual(loadWorkbenchSnapshot(identity), old);
  assert.equal(loadWorkbenchSnapshot({ ...identity, userId: 'bob' }).workbench.active, 'chat');
  w.localStorage.setItem('awu.connectionTarget', JSON.stringify({ mode: 'relay', url: 'https://other', user: { userId: 'alice' } }));
  assert.equal(loadWorkbenchSnapshot({ ...identity, realm: 'https://other' }).workbench.active, 'chat');
}));

test('first use with denied storage keeps a stable temporary client and group choice', () => fixture(w => {
  w.localStorage.setItem = () => { throw Error('quota'); };
  const key = navigationScope(identity);
  saveGroupCollapsed(identity, 'node-a', true);
  assert.equal(navigationScope(identity), key);
  assert.equal(groupCollapsed(identity, 'node-a'), true);
}));
