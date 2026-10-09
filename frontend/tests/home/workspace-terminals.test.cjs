const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceTerminals, TerminalOutputFilter } = require('../../.home-test-dist/utils/workspaceTerminals.js');
const workspace = { ownerId: 'alice', executorInstance: 'executor', sessionId: 's', workingDir: '/qa', workspaceRevision: 'a'.repeat(64) };
const target = { user: 'alice', executor: 'node', session: 's', workingDir: '/qa' };
const record = { workspace, resourceId: 'resource', generation: 'generation', requestId: 'create', shell: { id: 'sh', executable: '/bin/sh', args: [] },
  cols: 80, rows: 24, status: 'running', reasonCode: '', revision: 1, lastSequence: 0, inputSequence: 0, activityId: 'activity', exitConfirmed: false };
function fixture() {
  let current = true, resource = null, lose = false;
  const calls = [];
  const call = async (node, method, params) => {
    assert.equal(node, 'node'); calls.push(method);
    if (method === 'sessionWorkbenchCapabilities') return { status: 'ok', protocolVersion: 1, identity: workspace,
      capabilities: { viewMode: 1, documents: 1, windowHandoff: 1, terminal: 1, languageServices: 0 } };
    assert.deepEqual(JSON.parse(params[1]), workspace);
    if (method === 'terminalCreate') { resource = { ...record, requestId: JSON.parse(params[2]).requestId }; if (lose) throw Error('lost'); return resource; }
    if (method === 'terminalList') return { status: 'ok', workspace, terminals: resource ? [resource] : [], shells: [record.shell], controlRevision: 0 };
    if (method === 'terminalInput') { if (lose) throw Error('lost'); return { status: 'accepted', sequence: 1, terminal: { ...resource, inputSequence: 1 } }; }
    throw Error('unsupported test RPC');
  };
  return { calls, connect: () => WorkspaceTerminals.connect(target, call, () => current), lose: () => { lose = true; }, change: () => { current = false; } };
}
test('opening terminal client lists only; lost create reconciles original request without a second shell', async () => {
  const f = fixture(), client = await f.connect(); await client.list();
  assert.deepEqual(f.calls, ['sessionWorkbenchCapabilities', 'terminalList']);
  f.lose(); const row = await client.create('sh', 0, 'original'); assert.equal(row.requestId, 'original');
  assert.deepEqual(f.calls.slice(-2), ['terminalCreate', 'terminalList']);
});
test('input loss is never retried and identity changes issue no resource RPC', async () => {
  const f = fixture(), client = await f.connect(), row = await client.create('sh', 0);
  f.lose(); await assert.rejects(client.input(row, 'echo user\n', 1), /lost/);
  assert.equal(f.calls.filter(c => c === 'terminalInput').length, 1);
  const count = f.calls.length; f.change(); await assert.rejects(client.list(), /已变化/); assert.equal(f.calls.length, count);
});
test('terminal output strips split OSC clipboard/hyperlink and DCS actions, retaining ordinary text and color', () => {
  const filter = new TerminalOutputFilter();
  assert.equal(filter.feed('hello\x1b]52;c;c2Vj'), 'hello');
  assert.equal(filter.feed('cmV0\x07world\x1b[31m red\x1b[0m'), 'world\x1b[31m red\x1b[0m');
  assert.equal(filter.feed('\x1b]8;;https://bad\x1b'), '');
  assert.equal(filter.feed('\\link\x1b]8;;\x07\x1bPfile;payload\x1b\\safe'), 'linksafe');
  assert.equal(filter.feed('\x9d52;data\x9cend'), 'end');
  filter.feed('\x1b]unfinished'); filter.reset(); assert.equal(filter.feed('after gap'), 'after gap');
});
