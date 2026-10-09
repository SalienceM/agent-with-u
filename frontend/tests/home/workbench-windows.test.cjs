const test = require('node:test');
const assert = require('node:assert/strict');
const { WindowTransport, WindowOwnershipClient, loadWindowNavigation } = require('../../.home-test-dist/utils/workbenchWindows.js');
const workspace = { ownerId: 'alice', executorInstance: 'process', sessionId: 's', workingDir: '/qa', workspaceRevision: 'a'.repeat(64) };
const target = { user: 'alice', executor: 'e', session: 's', workingDir: '/qa' };
const state = () => ({ status: 'ok', workspace, clientId: 'client', windowId: 'source', generation: 1, revision: 1, frozen: false, pending: null });
const storage = () => { const map = new Map(); return { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v), map }; };

test('window navigation contains only IDs, isolates accounts and accepts explicit child-window routing', () => {
  const local = storage(), session = storage(), a = loadWindowNavigation('alice', local, session);
  assert.deepEqual(loadWindowNavigation('alice', local, session), a);
  const b = loadWindowNavigation('bob', local, session);
  assert.notEqual(a.clientId, b.clientId); assert.notEqual(a.windowId, b.windowId);
  const child = loadWindowNavigation('alice', local, storage(), 'child');
  assert.equal(child.clientId, a.clientId); assert.equal(child.windowId, 'child');
  assert.deepEqual(Object.keys(child).sort(), ['clientId', 'windowId']);
});

test('transport fences source immediately and never lowers newer ownership with late snapshots', () => {
  const t = new WindowTransport(); t.activate({ clientId: 'client', windowId: 'source' }); t.observe('e', state());
  assert.equal(t.metadata('e', 'sendMessage', ['{"sessionId":"s"}']).lease.generation, 1);
  t.markUnknown('e', 's');
  assert.throws(() => t.metadata('e', 'workspaceDocumentSave', ['s']), /归属/);
  const metadata = t.metadata('e', 'workspaceDocumentRead', ['s']);
  assert.equal(metadata.clientId, 'client'); assert.equal(metadata.windowId, 'source'); assert.equal(typeof metadata.documentId, 'string');
  t.observe('e', { ...state(), revision: 4, generation: 2, windowId: 'target' });
  t.observe('e', state());
  assert.throws(() => t.metadata('e', 'terminalInput', ['s']), /归属/);
  assert.throws(() => t.activate({ clientId: 'client', windowId: 'other' }), /替换/);
  t.clear(); assert.equal(t.identity, null); assert.equal(t.get('e', 's'), undefined);
});

test('read-only ownership refresh does not remove a local checkpoint recovery hold', () => {
  const t = new WindowTransport(); t.activate({ clientId: 'client', windowId: 'source' }); t.observe('e', state());
  t.hold('e', 's', true); t.observe('e', { ...state(), revision: 2 });
  assert.throws(() => t.metadata('e', 'workspaceDocumentSave', ['s']), /归属/);
  t.hold('e', 's', false); assert.equal(t.metadata('e', 'workspaceDocumentSave', ['s']).lease.generation, 1);
});

function fixture() {
  const transport = new WindowTransport(), calls = [];
  let current = true, snapshot = state(), receipt, holdPrepare, dropCommit = false, unavailable = false;
  const call = async (executor, method, params) => {
    assert.equal(executor, 'e'); calls.push(method === 'workbenchWindow' ? JSON.parse(params[2]).action : method);
    if (method === 'sessionWorkbenchCapabilities') return { status: 'ok', protocolVersion: 1, identity: workspace,
      capabilities: { viewMode: 1, documents: 1, windowHandoff: 1, terminal: 0, languageServices: 0 } };
    const p = JSON.parse(params[2]);
    if (unavailable) throw Error('offline');
    if (p.action === 'prepare') {
      receipt = { status: 'prepared', requestId: p.requestId, sourceWindow: 'source', targetWindow: p.targetWindow,
        generation: 1, stateVersion: p.stateVersion, stateDigest: p.stateDigest, fingerprint: 'f'.repeat(64) };
      snapshot = { ...snapshot, frozen: true, revision: 2, pending: receipt };
      if (holdPrepare) await holdPrepare;
      return structuredClone(receipt);
    }
    if (p.action === 'commit') {
      snapshot = { ...snapshot, windowId: 'target', generation: 2, revision: 4, frozen: false, pending: null };
      receipt = { ...receipt, status: 'committed', ownerWindow: 'target', committedGeneration: 2, revision: 4 };
      if (dropCommit) throw Error('response lost');
      return receipt;
    }
    return { ...snapshot, ...(p.requestId ? { receipt: receipt || { status: 'unknown', requestId: p.requestId } } : {}) };
  };
  return { transport, calls, connect: () => WindowOwnershipClient.connect(target, call, () => current, transport,
    () => ({ clientId: 'client', windowId: 'source' })),
    hold: value => { holdPrepare = value; }, drop: () => { dropCommit = true; }, offline: () => { unavailable = true; },
    switchUser: () => { current = false; } };
}

test('pending prepare deduplicates clicks; lost commit is reconciled by exactly one read, no write replay', async () => {
  const f = fixture(), client = await f.connect(); await client.register();
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = client.prepare('target', 'b'.repeat(64), 2, 'operation');
  await assert.rejects(client.prepare('target', 'b'.repeat(64), 2, 'duplicate'), /归属/);
  release(); const plan = await pending;
  f.drop(); const result = await client.finish(plan, true);
  assert.equal(result.status, 'committed');
  assert.equal(f.calls.filter(c => c === 'prepare').length, 1);
  assert.equal(f.calls.filter(c => c === 'commit').length, 1);
  assert.deepEqual(f.calls.slice(-2), ['commit', 'get']);
  assert.throws(() => f.transport.metadata('e', 'sendMessage', ['{"sessionId":"s"}']), /归属/);
});

test('offline reconciliation preserves unknown protection; changed identity sends no old-owner request', async () => {
  const f = fixture(), client = await f.connect(); await client.register();
  const plan = await client.prepare('target', 'b'.repeat(64), 2, 'operation');
  f.offline(); await assert.rejects(client.finish(plan, true), /offline/);
  assert.equal(f.transport.get('e', 's').unknown, true);
  assert.throws(() => f.transport.metadata('e', 'terminalInput', ['s']), /归属/);
  const count = f.calls.length; f.switchUser();
  await assert.rejects(client.get('operation'), /身份/); assert.equal(f.calls.length, count);
});
