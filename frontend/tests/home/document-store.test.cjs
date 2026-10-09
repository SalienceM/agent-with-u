const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentStore, documentKey } = require('../../.home-test-dist/utils/documentStore.js');
const { loadDocumentPreview, defaultDocumentView } = require('../../.home-test-dist/utils/documentPreview.js');

const workspace = { ownerId: 'alice', executorInstance: 'boot-a', sessionId: 'session-a', workingDir: '/project', workspaceRevision: 'a'.repeat(64) };
const diskVersion = (text = 'old') => ({ exists: true, sha256: 'b'.repeat(64), byteLength: text.length,
  fileId: '1:2', modifiedNs: '3', changedNs: '4' });
const read = (relativePath, text = 'old', space = workspace) => ({ status: 'ok',
  document: { workspace: space, source: 'executor', relativePath, canonicalPath: `/project/${relativePath}` }, text,
  encoding: 'utf-8', bom: '', eol: 'lf', complete: true, editable: true, canSave: true,
  reasonCode: '', writeReasonCode: '', byteLength: text.length, readByteLength: text.length,
  version: diskVersion(text), controlRevision: 0 });
const client = (space = workspace) => ({ identity: space,
  read: async path => read(path, 'old', space),
  save: async request => ({ status: 'succeeded', workspace: space, requestId: request.requestId,
    relativePath: request.relativePath, bufferRevision: request.bufferRevision,
    version: diskVersion(request.text), document: read(request.relativePath, request.text, space).document }) });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const store = () => { let id = 0; return new DocumentStore(() => `request-${++id}`); };

test('each file has independent buffer/dirty/editor state and reopening does not reload', async () => {
  const state = store(), api = client();
  const a = await state.open(api, 'a.py');
  state.edit(a.key, 'draft', { selection: 3, history: 'a' });
  const b = await state.open(api, 'b.py');
  state.edit(b.key, 'b draft');
  const reopened = await state.open(api, 'a.py');
  assert.equal(reopened.text, 'draft');
  assert.equal(reopened.dirty, true);
  assert.deepEqual(reopened.editor, { selection: 3, history: 'a' });
  assert.equal(state.get(b.key).text, 'b draft');
});

test('same path on another user/node/workspace/source never shares the write target', async () => {
  const state = store();
  const a = await state.open(client(), 'a.py');
  state.edit(a.key, 'draft');
  for (const space of [{ ...workspace, ownerId: 'bob' }, { ...workspace, executorInstance: 'boot-b' },
    { ...workspace, workspaceRevision: 'c'.repeat(64) }]) {
    const b = await state.open(client(space), 'a.py');
    assert.notEqual(b.key, a.key);
    assert.equal(b.text, 'old');
    await assert.rejects(state.save(client(space), a.key), /stale_workspace/);
  }
  assert.notEqual(documentKey({ ...a.identity, source: 'local-copy' }), a.key);
});

test('late earlier read cannot replace a newer load or resurrect a closed document', async () => {
  const state = store(), api = client();
  const first = deferred(), second = deferred();
  let calls = 0;
  api.read = () => ++calls === 1 ? first.promise : second.promise;
  const one = state.open(api, 'a.py');
  const two = state.open(api, 'a.py', true);
  second.resolve(read('a.py', 'new'));
  const doc = await two;
  first.resolve(read('a.py', 'old'));
  await one;
  assert.equal(state.get(doc.key).text, 'new');
  const third = deferred(); api.read = () => third.promise;
  const pending = state.open(api, 'a.py', true);
  state.close(doc.key);
  third.resolve(read('a.py'));
  await assert.rejects(pending, /read_cancelled/);
  assert.equal(state.get(doc.key), undefined);
});

test('refresh retains dirty draft, base and independent current disk version', async () => {
  const state = store(), api = client();
  const doc = await state.open(api, 'a.py');
  state.edit(doc.key, 'draft');
  api.read = async path => ({ ...read(path, 'agent edit'), version: { ...diskVersion(), sha256: 'c'.repeat(64) } });
  await state.open(api, 'a.py', true);
  assert.equal(state.get(doc.key).text, 'draft');
  assert.equal(state.get(doc.key).baseText, 'old');
  assert.equal(state.get(doc.key).disk.text, 'agent edit');
  await assert.rejects(state.save(api, doc.key), /disk_conflict/);
});

test('saving an old buffer revision leaves edits made during save dirty', async () => {
  const state = store(), api = client();
  const doc = await state.open(api, 'a.py');
  state.edit(doc.key, 'saved snapshot');
  const response = deferred(); let request;
  api.save = input => { request = input; return response.promise; };
  const save = state.save(api, doc.key);
  state.edit(doc.key, 'new input');
  response.resolve(await client().save(request));
  await save;
  assert.equal(state.get(doc.key).text, 'new input');
  assert.equal(state.get(doc.key).baseText, 'saved snapshot');
  assert.equal(state.get(doc.key).dirty, true);
  state.edit(doc.key, 'saved snapshot');
  assert.equal(state.get(doc.key).dirty, false);
});

test('lost result keeps request identity and cannot be overwritten or closed until reconciled', async () => {
  const state = store(), api = client();
  const doc = await state.open(api, 'a.py'); state.edit(doc.key, 'draft');
  let original, writes = 0;
  api.save = async request => { original = request; writes++; throw Error('timeout'); };
  await assert.rejects(state.save(api, doc.key));
  await assert.rejects(state.save(api, doc.key), /save_needs_reconciliation/);
  assert.throws(() => state.close(doc.key, true), /save_needs_reconciliation/);
  api.saveGet = async id => { assert.equal(id, original.requestId); return client().save(original); };
  await state.reconcile(api, doc.key);
  assert.equal(writes, 1);
  assert.equal(state.get(doc.key).dirty, false);
});

test('save all reports each result and preserves failed/read-only drafts', async () => {
  const state = store(), api = client();
  const a = await state.open(api, 'a.py'), b = await state.open(api, 'b.py');
  state.edit(a.key, 'a'); state.edit(b.key, 'b');
  api.save = request => request.relativePath === 'a.py' ? client().save(request) : Promise.resolve({
    status: 'failed', requestId: request.requestId, relativePath: request.relativePath,
    workspace, bufferRevision: request.bufferRevision, reasonCode: 'disk_conflict' });
  const results = await state.saveAll(api, [a.key, b.key]);
  assert.deepEqual(results.map(row => row.receipt.status), ['succeeded', 'failed']);
  assert.equal(state.get(a.key).dirty, false);
  assert.equal(state.get(b.key).dirty, true);
  assert.throws(() => state.close(b.key), /unsaved_document/);
  api.read = async path => ({ ...read(path), editable: false, canSave: false, complete: false, version: null });
  const c = await state.open(api, 'c.py');
  assert.throws(() => state.edit(c.key, 'bad'), /document_readonly/);
  await assert.rejects(state.save(api, c.key), /document_readonly/);
});

test('code defaults to source, document/media uses explicit preview adapters', async () => {
  for (const name of ['A.java', 'main.py', 'App.vue', 'App.tsx']) assert.equal(defaultDocumentView(name), 'source');
  for (const name of ['README.md', 'page.html', 'report.pdf', 'slides.pptx']) assert.equal(defaultDocumentView(name), 'preview');
  const base = name => ({ name, rel: name, source: 'remote', loading: true });
  const io = { bytes: async max => { assert.ok(max <= 64 * 1024 * 1024); return new Uint8Array([65]); },
    structured: async () => ({ status: 'ok', kind: 'excel' }), base64: async () => btoa('text') };
  assert.equal((await loadDocumentPreview(base('report.pdf'), io)).renderer, 'pdf');
  assert.equal((await loadDocumentPreview(base('report.docx'), io)).renderer, 'docx');
  assert.equal((await loadDocumentPreview(base('sheet.xlsx'), io)).structured.kind, 'excel');
  assert.equal((await loadDocumentPreview(base('a.py'), io)).text, 'text');
  assert.equal((await loadDocumentPreview(base('a.md'), io)).isMarkdown, true);
  assert.equal((await loadDocumentPreview(base('page.html'), io)).isHtml, true);
});

test('legacy preview adapter marks truncation but never provides a writable disk baseline', async () => {
  const result = await loadDocumentPreview({ name: 'large.txt', rel: 'large.txt', source: 'local', loading: true },
    { base64: async () => btoa('a'.repeat(200001)) });
  assert.equal(result.truncated, true);
  assert.equal(result.version, undefined);
  assert.equal(result.editable, undefined);
});

test('explicit merge adopts only the observed disk version without saving or discarding either input', async () => {
  const state = store(), api = client();
  const doc = await state.open(api, 'a.py'); state.edit(doc.key, 'my draft');
  const external = { ...read('a.py', 'agent edit'), version: { ...diskVersion(), changedNs: 'new' } };
  api.read = async () => external;
  const compared = await state.open(api, 'a.py', true);
  assert.equal(compared.text, 'my draft'); assert.equal(compared.baseText, 'old');
  assert.equal(compared.disk.text, 'agent edit');
  let writes = 0; api.save = async req => { writes++; return client().save(req); };
  state.merge(doc.key, external.version, compared.revision, 'combined');
  assert.equal(state.get(doc.key).baseText, 'agent edit'); assert.equal(state.get(doc.key).text, 'combined');
  assert.equal(state.get(doc.key).dirty, true); assert.equal(writes, 0);
  await state.save(api, doc.key); assert.equal(writes, 1);
});

test('deleted/recreated files and stale merge plans do not lose drafts or silently recreate files', async () => {
  const state = store(), api = client(); const doc = await state.open(api, 'a.py'); state.edit(doc.key, 'mine');
  api.read = async () => { throw new Error('deleted'); };
  await assert.rejects(state.open(api, 'a.py', true));
  assert.equal(state.get(doc.key).text, 'mine'); assert.equal(state.get(doc.key).baseText, 'old');
  const recreated = { ...read('a.py', 'recreated'), version: { ...diskVersion(), fileId: 'new-file' } };
  api.read = async () => recreated;
  const compared = await state.open(api, 'a.py', true);
  state.edit(doc.key, 'mine newer');
  assert.throws(() => state.merge(doc.key, recreated.version, compared.revision, 'stale plan'), /merge_stale/);
  assert.equal(state.get(doc.key).text, 'mine newer');
  assert.equal(state.get(doc.key).disk.text, 'recreated');
});
