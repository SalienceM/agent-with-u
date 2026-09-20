const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkspaceNode, executeWorkspaceRequest, workspaceSessionLink, parseWorkspaceSessionLink } = require('../../.home-test-dist/utils/workspaceTools.js');

const nodes = [
  { id: 'work-id', name: 'work_1', connected: true, isCurrent: true },
  { id: 'home-id', name: 'home', connected: false, isDefault: true },
];
const request = (phase, args) => ({ id: 'request', sessionId: 'source', phase, arguments: args });
const makeDriver = (result = { status: 'ok' }) => {
  const calls = [];
  return { calls, assertCurrent() {}, async nodes() { return nodes; },
    async request(...args) { calls.push(args); return JSON.stringify(result); } };
};

test('name resolution uses exact IDs/names, never guesses duplicate nodes or default', () => {
  assert.equal(resolveWorkspaceNode(nodes).node.id, 'work-id');
  assert.equal(resolveWorkspaceNode(nodes, 'home').node.id, 'home-id');
  assert.equal(resolveWorkspaceNode(nodes, 'work').node.id, 'work-id');
  assert.equal(resolveWorkspaceNode(nodes, 'absent').status, 'not_found');
  assert.equal(resolveWorkspaceNode([...nodes, { ...nodes[1], id: 'home-copy' }], 'home').status, 'ambiguous');
});

test('nodes and ambiguous targets never dispatch mutations or load file contents', async () => {
  const driver = makeDriver();
  assert.equal((await executeWorkspaceRequest(request('query', { action: 'nodes' }), driver)).nodes.length, 2);
  assert.equal((await executeWorkspaceRequest(request('prepare', { action: 'create_session', node: 'missing' }), driver)).status, 'not_found');
  assert.equal(driver.calls.length, 0);
});

test('current session defaults are explicit and templates on other nodes do not inherit them', async () => {
  const driver = makeDriver();
  await executeWorkspaceRequest(request('query', { action: 'files' }), driver);
  assert.equal(JSON.parse(driver.calls[0][2][0]).session, 'source');
  await executeWorkspaceRequest(request('query', { action: 'files', node: 'home' }), driver);
  assert.equal(JSON.parse(driver.calls[1][2][0]).session, undefined);
});

test('prepare and commit route the exact target with the frozen fingerprint', async () => {
  const driver = makeDriver({ status: 'prepared' });
  await executeWorkspaceRequest(request('prepare', { action: 'create_session', node: 'home', requestId: 'split' }), driver);
  assert.equal(driver.calls[0][0], 'home-id');
  assert.equal(driver.calls[0][1], 'workspacePrepare');
  assert.equal(JSON.parse(driver.calls[0][2][1]).node, 'home-id');
  await executeWorkspaceRequest(request('commit', { node: 'home-id', requestId: 'split', fingerprint: 'frozen' }), driver);
  assert.deepEqual(driver.calls[1], ['home-id', 'workspaceCommit', ['session:source', 'split', 'frozen']]);
});

test('scope metadata comes from the actual controller route, not target data or the default node', async () => {
  const driver = makeDriver({ status: 'prepared', node: { id: 'forged', isCurrent: true } });
  const args = { action: 'write_files', requestId: 'write', files: [{ path: 'a.md', text: 'a' }] };
  const local = await executeWorkspaceRequest(request('prepare', args), driver);
  assert.equal(local.node.id, 'work-id');
  assert.equal(local.node.isCurrent, true);
  assert.equal(JSON.parse(driver.calls[0][2][1]).session, 'source');
  const remote = await executeWorkspaceRequest(request('prepare', { ...args, node: 'home' }), driver);
  assert.equal(remote.node.id, 'home-id');
  assert.notEqual(remote.node.isCurrent, true);
  assert.equal(JSON.parse(driver.calls[1][2][1]).session, undefined);
  await executeWorkspaceRequest(request('prepare', { ...args, session: 'other' }), driver);
  assert.equal(JSON.parse(driver.calls[2][2][1]).session, 'other');
});

test('no arbitrary RPC passthrough, read-phase writes, silent offline success or unsupported node success', async () => {
  const driver = makeDriver();
  await assert.rejects(executeWorkspaceRequest(request('query', { action: 'create_session' }), driver));
  await assert.rejects(executeWorkspaceRequest(request('prepare', { action: 'run_shell_command' }), driver));
  await assert.rejects(executeWorkspaceRequest(request('commit', { requestId: 'split' }), driver));
  const offline = makeDriver(); offline.request = async () => { throw new Error('offline'); };
  await assert.rejects(executeWorkspaceRequest(request('query', { action: 'sessions', node: 'home' }), offline), /offline/);
  await assert.rejects(executeWorkspaceRequest(request('query', { action: 'sessions' }), makeDriver(null)), /协议/);
});

test('identity changes invalidate an in-flight reply', async () => {
  const driver = makeDriver(); let changed = false;
  driver.request = async () => { changed = true; return { status: 'ok' }; };
  driver.assertCurrent = () => { if (changed) throw new Error('identity changed'); };
  await assert.rejects(executeWorkspaceRequest(request('query', { action: 'sessions' }), driver), /identity changed/);
});

test('success receipts link to the exact node/session, not a command or automatic send', async () => {
  const driver = makeDriver({ status: 'succeeded', receipt: { session: { id: 'new-session' } } });
  const result = await executeWorkspaceRequest(request('query', { action: 'status', node: 'home', requestId: 'split' }), driver);
  assert.equal(result.sessionLink, workspaceSessionLink('home-id', 'new-session'));
  assert.deepEqual(parseWorkspaceSessionLink(result.sessionLink), { node: 'home-id', session: 'new-session' });
  assert.equal(parseWorkspaceSessionLink('https://example.com/#awu-session=x&node=y'), null);
  assert.equal(parseWorkspaceSessionLink('#awu-session=x'), null);
});
