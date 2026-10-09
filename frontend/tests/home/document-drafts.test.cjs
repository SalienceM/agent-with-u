const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentStore } = require('../../.home-test-dist/utils/documentStore.js');
const { DocumentDrafts, inspectStoredDraft } = require('../../.home-test-dist/utils/documentDrafts.js');
const { DocumentProtocolError } = require('../../.home-test-dist/utils/workspaceDocuments.js');
const identity = { ownerId: 'alice', executorInstance: 'test-executor', sessionId: 'test-session', workingDir: '/test', workspaceRevision: 'a'.repeat(64) };
const version = { exists: true, sha256: 'b'.repeat(64), byteLength: 3, fileId: 'f1', modifiedNs: '1', changedNs: '1' };
const client = (workspace = identity) => ({ identity: workspace, source: 'executor',
  read: async relativePath => ({ status: 'ok', document: { workspace, source: 'executor', relativePath },
    text: 'old', version, encoding: 'utf-8', bom: '', eol: 'none', complete: true,
    editable: true, canSave: true, reasonCode: '', writeReasonCode: '', byteLength: 3, readByteLength: 3, controlRevision: 0 }),
  save: async () => { throw new Error('draft recovery must not save'); } });
const fixture = () => {
  const records = new Map();
  const repository = {
    list: async (key, owner) => [...records.values()].filter(row => row.documentKey === key && row.ownerId === owner),
    listOwner: async owner => [...records.values()].filter(row => row.ownerId === owner),
    put: async record => { records.set(record.id, structuredClone(record)); },
    remove: async (id, owner) => { if (records.get(id)?.ownerId === owner) records.delete(id); },
    removeRecord: async record => {
      if (records.has(record.id) && JSON.stringify(records.get(record.id)) !== JSON.stringify(record)) throw new Error('draft_changed');
      records.delete(record.id);
    },
  };
  return { records, repository };
};

test('persisted draft restores matching identity without saving and keeps external disk for comparison', async () => {
  const f = fixture(), store = new DocumentStore(); const drafts = new DocumentDrafts(store, f.repository, 'window1', 0);
  const { document: a } = await drafts.open(client(), 'a.py'); store.edit(a.key, 'draft'); await drafts.flush(a.key);
  assert.equal(store.get(a.key).persistence, 'saved');
  const next = new DocumentStore(), recovery = new DocumentDrafts(next, f.repository, 'window1', 0);
  const api = client(); const read = api.read;
  api.read = async path => ({ ...await read(path), text: 'agent edit', version: { ...version, changedNs: '2' } });
  const restored = await recovery.open(api, 'a.py');
  assert.equal(restored.document.text, 'draft'); assert.equal(restored.document.baseText, 'old');
  assert.equal(restored.document.disk.text, 'agent edit'); assert.equal(restored.document.dirty, true);
});

test('quota/storage failure preserves memory and unknown saves cannot be discarded', async () => {
  const f = fixture(), store = new DocumentStore(); const drafts = new DocumentDrafts(store, f.repository, 'window1', 0);
  const { document: a } = await drafts.open(client(), 'a.py'); store.edit(a.key, 'draft');
  f.repository.put = async () => { throw new Error('quota'); };
  await drafts.flush(a.key);
  assert.equal(store.get(a.key).text, 'draft'); assert.equal(store.get(a.key).persistence, 'failed');
  await assert.rejects(store.save(client(), a.key));
  await assert.rejects(drafts.discard(a.key), /save_needs_reconciliation/);
});

test('same-path foreign accounts and branches never overwrite or silently merge another draft', async () => {
  const f = fixture();
  for (const [branch, text] of [['window1', 'one'], ['window2', 'two']]) {
    const store = new DocumentStore();
    const doc = await store.open(client(), 'a.py');
    const drafts = new DocumentDrafts(store, f.repository, branch, 0);
    store.edit(doc.key, text); await drafts.flush(doc.key);
  }
  assert.equal(f.records.size, 2);
  const store = new DocumentStore(), drafts = new DocumentDrafts(store, f.repository, 'window3', 0);
  const offered = await drafts.open(client(), 'a.py');
  assert.equal(offered.document.text, 'old'); assert.equal(offered.choices.length, 2);
  const other = await drafts.open(client({ ...identity, ownerId: 'bob' }), 'a.py');
  assert.equal(other.document.text, 'old'); assert.equal(other.choices.length, 0);
  await assert.rejects(drafts.restore(other.document.key, offered.choices[0]), /invalid_draft/);
});

test('invalid persisted draft is retained until explicit discard instead of silently deleting it', async () => {
  const f = fixture(), store = new DocumentStore();
  const doc = await store.open(client(), 'a.py');
  f.records.set('corrupt', { id: 'corrupt', documentKey: doc.key, ownerId: 'alice', branch: 'window1', payload: '{broken' });
  const next = new DocumentStore(), drafts = new DocumentDrafts(next, f.repository, 'window1', 0);
  const result = await drafts.open(client(), 'a.py');
  assert.equal(result.document.persistence, 'failed'); assert.equal(result.choices.length, 1);
  await assert.rejects(drafts.flush(doc.key), /draft_invalid/);
  assert.equal(f.records.size, 1);
  await drafts.removeStored(result.choices[0], 'alice', () => true);
  assert.equal(f.records.size, 0);
});

test('offline recovery is read-only and exact-owner; record cleanup refuses changed or pending saves', async () => {
  const f = fixture(), store = new DocumentStore(), drafts = new DocumentDrafts(store, f.repository, 'window1', 0);
  const { document } = await drafts.open(client(), 'a.py'); store.edit(document.key, 'offline draft'); await drafts.flush(document.key);
  const [record] = await drafts.listOwner('alice');
  assert.equal(inspectStoredDraft(record, 'alice').text, 'offline draft');
  assert.throws(() => inspectStoredDraft(record, 'bob'), /invalid_draft/);
  assert.deepEqual(await drafts.listOwner('bob'), []);
  await assert.rejects(drafts.removeStored(record, 'alice', () => true), /draft_open_in_editor/);
  const recovery = new DocumentDrafts(new DocumentStore(), f.repository, 'other', 0);
  await assert.rejects(recovery.removeStored(record, 'alice', () => false), /stale_workspace/);
  f.records.set(record.id, { ...record, updatedAt: record.updatedAt + 1 });
  await assert.rejects(recovery.removeStored(record, 'alice', () => true), /draft_changed/);
  const pending = { ...record, payload: JSON.stringify({ ...JSON.parse(record.payload), pendingSave: { requestId: 'test' } }) };
  await assert.rejects(recovery.removeStored(pending, 'alice', () => true), /save_needs_reconciliation/);
});

test('coalesces document recovery and never applies a stale identity restore', async () => {
  const f = fixture(), store = new DocumentStore(), drafts = new DocumentDrafts(store, f.repository, 'window1', 0);
  let release; const gate = new Promise(resolve => { release = resolve; }); let reads = 0;
  const api = client(), read = api.read; api.read = async path => { reads++; await gate; return read(path); };
  const first = drafts.open(api, 'a.py'), second = drafts.open(api, 'a.py');
  release(); const [a, b] = await Promise.all([first, second]); assert.equal(reads, 1); assert.equal(a.document.key, b.document.key);
  store.edit(a.document.key, 'draft'); await drafts.flush(a.document.key);
  const [record] = await drafts.listOwner('alice');
  store.close(a.document.key, true); await store.open(client(), 'a.py');
  await assert.rejects(drafts.restore(a.document.key, record, () => false), /draft_changed/);
  assert.equal(store.get(a.document.key).text, 'old');
  store.editorState(a.document.key, { stale: true }, a.document.lifecycleId);
  assert.equal(store.get(a.document.key).editor, undefined);
});
