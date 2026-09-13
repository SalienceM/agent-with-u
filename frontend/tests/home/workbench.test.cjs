const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workbenchReducer, initialWorkbench, selectSessionPane, sessionWorkbenchTab, workbenchSessionId, isConversationTab } = require('../../.home-test-dist/utils/workbench.js');
const { filterMarketItems, marketVersion } = require('../../.home-test-dist/utils/skillMarketView.js');
const { normalizeWorkbenchSnapshot, workbenchStorageKey, loadWorkbenchSnapshot, saveWorkbenchSnapshot } = require('../../.home-test-dist/utils/workbench.js');
test('workbench opens unique tabs and restores previous neighbor on close', () => {
  let state = workbenchReducer(initialWorkbench, { type: 'open', tab: 'library' });
  state = workbenchReducer(state, { type: 'open', tab: 'market' });
  state = workbenchReducer(state, { type: 'open', tab: 'library' });
  assert.deepEqual(state.tabs, ['chat', 'library', 'market']);
  state = workbenchReducer(state, { type: 'close', tab: 'market' });
  assert.equal(state.active, 'library');
  state = workbenchReducer(state, { type: 'close', tab: 'library' });
  assert.deepEqual(state, initialWorkbench);
  assert.deepEqual(workbenchReducer(state, { type: 'close', tab: 'chat' }), state);
  assert.deepEqual(workbenchReducer({ tabs: ['chat', 'market'], active: 'market' }, { type: 'reset' }), initialWorkbench);
});

test('navigation snapshot retains all tabs, active tab and unique split focus', () => {
  const snapshot = { version: 1,
    workbench: { tabs: ['chat', 'session:a', 'market', 'session:b', 'session:c'], active: 'session:b' },
    panes: ['a', 'b', null, null], focused: 1, layout: '1x2' };
  assert.deepEqual(normalizeWorkbenchSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  assert.equal(normalizeWorkbenchSnapshot({ ...snapshot, workbench: { ...snapshot.workbench, active: 'market' } }).workbench.active, 'market');
  const malformed = normalizeWorkbenchSnapshot({ version: 1, workbench: { tabs: ['chat', 'session:a', 'session:a', 'bogus', 'session:'], active: 'session:a' }, panes: ['a', 'a'], focused: 99, layout: '1x2' });
  assert.deepEqual(malformed.workbench.tabs, ['chat', 'session:a']);
  assert.deepEqual(malformed.panes, ['a', null, null, null]);
  assert.equal(malformed.focused, 0);
  assert.deepEqual(normalizeWorkbenchSnapshot({ version: 99 }), normalizeWorkbenchSnapshot(null));
  assert.notEqual(workbenchStorageKey({ mode: 'local', userId: 'local' }), workbenchStorageKey({ mode: 'relay', userId: 'local' }));
  assert.notEqual(workbenchStorageKey({ mode: 'relay', userId: 'a' }), workbenchStorageKey({ mode: 'relay', userId: 'b' }));
});

test('window snapshots isolate users, prefer this window and store navigation only', () => {
  const makeStorage = () => {
    const data = new Map();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  };
  const oldWindow = global.window;
  global.window = { sessionStorage: makeStorage(), localStorage: makeStorage() };
  try {
    const a = { mode: 'relay', userId: 'a' }, b = { mode: 'relay', userId: 'b' };
    const snapshot = normalizeWorkbenchSnapshot({ version: 1, workbench: { tabs: ['chat', 'session:s'], active: 'session:s' } });
    saveWorkbenchSnapshot(a, { ...snapshot, token: 'do-not-store', kitApprovalDelegation: true });
    assert.deepEqual(loadWorkbenchSnapshot(a), snapshot);
    assert.deepEqual(loadWorkbenchSnapshot(b), normalizeWorkbenchSnapshot(null));
    const raw = window.localStorage.getItem(workbenchStorageKey(a));
    assert.equal(raw.includes('do-not-store'), false);
    assert.equal(raw.includes('kitApprovalDelegation'), false);
    window.localStorage.setItem(workbenchStorageKey(a), JSON.stringify(normalizeWorkbenchSnapshot(null)));
    assert.deepEqual(loadWorkbenchSnapshot(a), snapshot);
    window.sessionStorage = makeStorage();
    assert.deepEqual(loadWorkbenchSnapshot(a), normalizeWorkbenchSnapshot(null));
  } finally { global.window = oldWindow; }
});
test('market sorts metadata without converting missing numbers into ratings', () => {
  const base = { name: 'a', description: '', sourceName: '', repository: '', path: '', official: false, updateAvailable: false };
  const items = [
    { ...base, id: '1', sourceId: 's1' },
    { ...base, name: 'b', id: '2', sourceId: 's2', repositoryInfo: { stars: 0, pushedAt: '2026-09-01' } },
    { ...base, name: 'c', id: '3', sourceId: 's2', repositoryInfo: { stars: 20, pushedAt: '2025-01-01' } },
  ];
  assert.deepEqual(filterMarketItems(items, '', '', 'stars').map(x => x.id), ['3', '2', '1']);
  assert.deepEqual(filterMarketItems(items, '', '', 'recent').map(x => x.id), ['2', '3', '1']);
  assert.deepEqual(filterMarketItems(items, 'b', 's2', 'name').map(x => x.id), ['2']);
  assert.deepEqual(filterMarketItems(items, 'b', 's1', 'name'), []);
  assert.deepEqual(items.map(x => x.id), ['1', '2', '3']);
  assert.match(marketVersion({ digest: 'abcd123456789012' }), /未声明版本 · abcd12345678/);
  assert.equal(marketVersion({ digest: 'abc', version: '2.1' }), '声明版本 2.1');
});

test('Session tabs reuse ids, keep opening order and close only the selected view', () => {
  let state = initialWorkbench;
  for (const id of ['a', 'b', 'a']) state = workbenchReducer(state, { type: 'open', tab: sessionWorkbenchTab(id) });
  assert.deepEqual(state.tabs, ['chat', 'session:a', 'session:b']);
  assert.equal(state.active, 'session:a');
  assert.equal(workbenchSessionId(state.active), 'a');
  assert.equal(isConversationTab(state.active), true);
  assert.equal(isConversationTab('market'), false);
  state = workbenchReducer(state, { type: 'close', tab: 'session:b' });
  assert.equal(state.active, 'session:a');
  assert.equal(workbenchReducer(state, { type: 'close', tab: 'session:a' }).active, 'chat');
  assert.deepEqual(workbenchReducer(state, { type: 'reset' }), initialWorkbench);
});

test('split focus restores Session tabs without stealing extension focus; migration preserves tabs', () => {
  let state = workbenchReducer(initialWorkbench, { type: 'syncSessions', sessionIds: ['a', 'b', null, null], focusedSessionId: 'b' });
  assert.deepEqual(state, { tabs: ['chat', 'session:a', 'session:b'], active: 'session:b' });
  state = workbenchReducer(state, { type: 'open', tab: 'market' });
  state = workbenchReducer(state, { type: 'syncSessions', sessionIds: ['a', 'b', 'c', null], focusedSessionId: 'c' });
  assert.equal(state.active, 'market');
  assert.deepEqual(state.tabs, ['chat', 'session:a', 'session:b', 'market', 'session:c']);
  state = workbenchReducer(state, { type: 'migrateSessions', ids: { a: 'd', b: 'd' } });
  assert.deepEqual(state.tabs, ['chat', 'session:d', 'market', 'session:c']);
});

test('selecting an already visible Session focuses its pane instead of rendering twice', () => {
  const panes = ['a', 'b', null, null];
  assert.deepEqual(selectSessionPane(panes, 'a', 1, 2), { panes, focused: 0 });
  assert.deepEqual(selectSessionPane(panes, 'c', 1, 2), { panes: ['a', 'c', null, null], focused: 1 });
  assert.deepEqual(selectSessionPane(panes, 'b', 0, 1), { panes: ['b', null, null, null], focused: 0 });
  assert.deepEqual(selectSessionPane(panes, null, 1, 2), { panes: ['a', null, null, null], focused: 1 });
});
