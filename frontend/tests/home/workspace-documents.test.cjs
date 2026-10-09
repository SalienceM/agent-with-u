const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceDocuments } = require('../../.home-test-dist/utils/workspaceDocuments.js');

const target = { user: 'alice', executor: 'remote-exact', session: 'session-a', workingDir: '/project' };
const identity = { ownerId: 'alice', executorInstance: 'boot-a', sessionId: 'session-a',
  workingDir: '/project', workspaceRevision: 'a'.repeat(64) };
const version = { exists: true, sha256: 'b'.repeat(64), byteLength: 3, fileId: '1:2', modifiedNs: '3', changedNs: '4' };
const doc = { workspace: identity, relativePath: 'a.py', canonicalPath: '/project/a.py', source: 'executor' };
const capabilities = () => ({ status: 'ok', protocolVersion: 1, identity: { ...identity },
  capabilities: { viewMode: 1, documents: 1, windowHandoff: 0, languageServices: 0, terminal: 0 } });
const read = () => ({ status: 'ok', document: doc, text: 'old', encoding: 'utf-8', bom: '', eol: 'none',
  complete: true, editable: true, canSave: true, reasonCode: '', writeReasonCode: '',
  byteLength: 3, readByteLength: 3, version, controlRevision: 0 });
const save = () => ({ requestId: 'save-1', relativePath: 'a.py', baseVersion: version,
  bufferRevision: 7, controlRevision: 0, text: 'new' });
const receipt = (status = 'succeeded') => ({ status, requestId: 'save-1', workspace: identity,
  relativePath: 'a.py', bufferRevision: 7, document: doc, version });

test('unsupported/old and future document protocols stay read-only with zero write calls', async () => {
  for (const capability of [null, { ...capabilities(), capabilities: { ...capabilities().capabilities, documents: 0 } },
    { ...capabilities(), capabilities: { ...capabilities().capabilities, documents: 2 } }]) {
    const calls = [];
    const client = await WorkspaceDocuments.connect(target, async (...args) => { calls.push(args); return capability; }, () => true);
    assert.equal(client.supported, false);
    await assert.rejects(client.save(save()), /safe_documents_unsupported/);
    await assert.rejects(client.read('a.py', 'read-1'), /safe_documents_unsupported/);
    assert.deepEqual(calls.map(args => args[1]), ['sessionWorkbenchCapabilities']);
  }
});

test('document calls remain on the exact executor with frozen identity', async () => {
  const calls = [];
  const mutable = { ...target };
  const client = await WorkspaceDocuments.connect(mutable, async (...args) => {
    calls.push(args); return args[1] === 'sessionWorkbenchCapabilities' ? capabilities() : read();
  }, () => true);
  mutable.executor = 'home';
  assert.equal((await client.read('a.py', 'read-1')).text, 'old');
  assert.equal(calls[1][0], 'remote-exact');
  assert.deepEqual(JSON.parse(calls[1][2][1]), identity);
  assert.equal(Object.isFrozen(client.identity), true);
});

test('offline or unsupported save is not retried or downgraded to syncWriteFile', async () => {
  for (const failure of ['offline', null]) {
    const calls = [];
    const client = await WorkspaceDocuments.connect(target, async (...args) => {
      calls.push(args);
      if (args[1] === 'sessionWorkbenchCapabilities') return capabilities();
      if (failure) throw Error(failure);
      return null;
    }, () => true);
    await assert.rejects(client.save(save()), /offline|unsupported/);
    assert.deepEqual(calls.map(args => args[1]), ['sessionWorkbenchCapabilities', 'workspaceDocumentSave']);
  }
});

test('truncated/binary/invalid writable read responses cannot become editor baselines', async () => {
  for (const patch of [{ complete: false }, { version: null }, { readByteLength: 1 },
    { reasonCode: 'binary' }, { encoding: 'unknown' }, { eol: 'mixed' }]) {
    const client = await WorkspaceDocuments.connect(target, async (_, method) =>
      method === 'sessionWorkbenchCapabilities' ? capabilities() : { ...read(), ...patch }, () => true);
    await assert.rejects(client.read('a.py', 'read-1'), /unsafe_document_response/);
  }
  const client = await WorkspaceDocuments.connect(target, async (_, method) =>
    method === 'sessionWorkbenchCapabilities' ? capabilities() : { ...read(), text: '', editable: false,
      canSave: false, complete: false, version: null, reasonCode: 'too_large' }, () => true);
  assert.equal((await client.read('a.py', 'read-1')).editable, false);
});

test('foreign workspace, wrong path and late identity change are rejected', async () => {
  for (const document of [{ ...doc, relativePath: 'b.py' }, { ...doc, source: 'local-copy' },
    { ...doc, workspace: { ...identity, executorInstance: 'boot-b' } }]) {
    const client = await WorkspaceDocuments.connect(target, async (_, method) =>
      method === 'sessionWorkbenchCapabilities' ? capabilities() : { ...read(), document }, () => true);
    await assert.rejects(client.read('a.py', 'read-1'), /invalid_document_response/);
  }
  let current = true;
  const client = await WorkspaceDocuments.connect(target, async (_, method) => {
    if (method === 'sessionWorkbenchCapabilities') return capabilities();
    current = false; return read();
  }, () => current);
  await assert.rejects(client.read('a.py', 'read-1'), /stale_workspace/);
});

test('save receipt must confirm exact request, path and buffer revision', async () => {
  for (const patch of [{ requestId: 'other' }, { relativePath: 'b.py' }, { bufferRevision: 8 },
    { version: null }, { workspace: { ...identity, ownerId: 'bob' } }]) {
    const client = await WorkspaceDocuments.connect(target, async (_, method) =>
      method === 'sessionWorkbenchCapabilities' ? capabilities() : { ...receipt(), ...patch }, () => true);
    await assert.rejects(client.save(save()), /receipt|stale_workspace/);
  }
});

test('accepted/unresolved stays nonterminal; lost receipt gets read-only lookup once', async () => {
  const methods = [];
  const client = await WorkspaceDocuments.connect(target, async (_, method) => {
    methods.push(method);
    if (method === 'sessionWorkbenchCapabilities') return capabilities();
    if (method === 'workspaceDocumentSave') return receipt('accepted');
    return receipt('unresolved');
  }, () => true);
  assert.equal((await client.save(save())).status, 'accepted');
  assert.equal((await client.saveGet('save-1')).status, 'unresolved');
  assert.deepEqual(methods, ['sessionWorkbenchCapabilities', 'workspaceDocumentSave', 'workspaceDocumentSaveGet']);
});

test('path traversal is rejected before network dispatch and refresh lists stay bounded', async () => {
  let calls = 0;
  const client = await WorkspaceDocuments.connect(target, async () => { calls++; return capabilities(); }, () => true);
  for (const path of ['../private', 'C:/private', '/private', 'a.py:stream']) {
    await assert.rejects(client.read(path, 'read-1'), /invalid_path/);
  }
  await assert.rejects(client.refresh(Array(17).fill({ relativePath: 'a.py', version })), /refresh_limit/);
  assert.equal(calls, 1);
});
