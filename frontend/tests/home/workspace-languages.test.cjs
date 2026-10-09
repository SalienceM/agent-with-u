const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceLanguages } = require('../../.home-test-dist/utils/workspaceLanguages.js');
const { applyLanguageTextEdits, languageOffset, languagePosition, languageRelative, prepareLanguageEdit, validateLanguageEdit } = require('../../.home-test-dist/utils/languageEdits.js');
const { DocumentStore } = require('../../.home-test-dist/utils/documentStore.js');
const { EditorState } = require('@codemirror/state');
const { history, undo } = require('@codemirror/commands');
const workspace = { ownerId: 'alice', executorInstance: 'executor', sessionId: 's', workingDir: '/qa', workspaceRevision: 'a'.repeat(64) };
const target = { user: 'alice', executor: 'node', session: 's', workingDir: '/qa' };
const service = { workspace, resourceId: 'resource', generation: 'generation', requestId: 'original', revision: 1, provider: 'python', status: 'ready',
  reasonCode: '', config: { provider: 'python' }, activityId: 'activity', planFingerprint: 'b'.repeat(64), exitConfirmed: false, capabilities: { rename: true }, documents: [] };
const version = { exists: true, sha256: 'a'.repeat(64), byteLength: 4, fileId: 'file', modifiedNs: '1', changedNs: '1' };
const edit = (start, end, newText) => ({ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText });

test('CRLF disk buffers map to CodeMirror coordinates without modifying original bytes', () => {
  const { languageEditorText } = require('../../.home-test-dist/utils/languageEdits.js');
  const disk = '😀\r\nname\r\nend';
  const editor = EditorState.create({ doc: disk }).doc.toString();
  assert.equal(languageEditorText(disk), editor);
  assert.deepEqual(languagePosition(editor, 5), { line: 1, character: 2 });
  assert.equal(languageOffset(disk, { line: 1, character: 2 }), 6);
  assert.throws(() => languageOffset(disk, { line: 0, character: 3 }), /越界/);
  assert.equal(applyLanguageTextEdits(disk, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: 'other' }]), '😀\r\nother\r\nend');
});

test('language lifecycle connects read-only, reconciles lost original start and rejects account changes', async () => {
  let current = true, started = false;
  const calls = [];
  const client = await WorkspaceLanguages.connect(target, async (node, method, params) => {
    assert.equal(node, 'node'); calls.push(method);
    if (method === 'sessionWorkbenchCapabilities') return { status: 'ok', protocolVersion: 1, identity: workspace,
      capabilities: { documents: 1, languageServices: 1, terminal: 1, viewMode: 1, windowHandoff: 1 } };
    assert.deepEqual(JSON.parse(params[1]), workspace);
    if (method === 'languageServiceList') return { status: 'ok', workspace, services: started ? [service] : [], controlRevision: 2 };
    if (method === 'languageServiceStart') { started = true; throw Error('lost'); }
    throw Error('unexpected');
  }, () => current);
  assert.deepEqual((await client.list()).services, []);
  assert.equal(calls.includes('languageServiceStart'), false);
  const result = await client.start({ workspace, planFingerprint: service.planFingerprint }, 2,
    { allowProjectCode: true, allowWorkspaceWrite: true, allowBuildImport: false }, 'original');
  assert.equal(result.resourceId, service.resourceId);
  assert.equal(calls.filter(v => v === 'languageServiceStart').length, 1);
  current = false; await assert.rejects(client.list(), /已变化/);
});

test('UTF-16 coordinates preserve astral symbols and reject split/overflow positions', () => {
  const text = 'a😀z\n名称';
  assert.equal(languageOffset(text, { line: 0, character: 3 }), 3);
  assert.deepEqual(languagePosition(text, 6), { line: 1, character: 1 });
  assert.throws(() => languageOffset(text, { line: 0, character: 2 }), /Unicode/);
  assert.throws(() => languageOffset(text, { line: 8, character: 0 }), /越界/);
  assert.equal(applyLanguageTextEdits(text, [edit(1, 3, '猫')]), 'a猫z\n名称');
  assert.throws(() => applyLanguageTextEdits(text, [edit(0, 3, ''), edit(1, 3, '')]), /重叠/);
});

test('semantic URIs stay in exact executor workspace and cannot open web, siblings or encoded traversal', () => {
  assert.equal(languageRelative(workspace, 'file:///qa/models.py'), 'models.py');
  for (const uri of ['https://host/qa/a', 'file://other/qa/a', 'file:///qax/a', 'file:///qa/%2e%2e/secret', 'file:///qa/a?x=1']) assert.throws(() => languageRelative(workspace, uri));
  assert.equal(languageRelative({ ...workspace, workingDir: 'C:\\QA' }, 'file:///C:/QA/App.tsx'), 'app.tsx');
});

async function documents() {
  const store = new DocumentStore(); let disk = { 'a.py': 'name', 'b.py': 'name' }, stamp = '1'; let reads = 0;
  const client = { identity: workspace, source: 'executor', read: async path => {
    reads++; return { status: 'ok', document: { workspace, relativePath: path, source: 'executor' }, text: disk[path],
      complete: true, editable: true, canSave: true, version: { ...version, fileId: path, modifiedNs: stamp }, controlRevision: 0 };
  } };
  await store.open(client, 'a.py'); await store.open(client, 'b.py');
  return { store, client, count: () => reads, external: () => { stamp = '2'; } };
}
const rename = { changes: { 'file:///qa/a.py': [edit(0, 4, 'renamed')], 'file:///qa/b.py': [edit(0, 4, 'renamed')] } };

test('rename validates all resource operations/paths before loading any additional files', async () => {
  const f = await documents(), count = f.count();
  await assert.rejects(prepareLanguageEdit(service, { documentChanges: [{ kind: 'rename', oldUri: 'file:///qa/a.py', newUri: 'file:///qa/new.py' }] }, f.client, f.store, f.store.all()), /不支持/);
  await assert.rejects(prepareLanguageEdit(service, { changes: { ...rename.changes, 'file:///secret.py': [] } }, f.client, f.store, f.store.all()), /工作区/);
  assert.equal(f.count(), count); assert.equal(f.store.all().some(d => d.dirty), false);
});

test('late buffer or disk changes invalidate entire rename before modifying any target', async () => {
  const f = await documents(); const plan = await prepareLanguageEdit(service, rename, f.client, f.store, f.store.all());
  const first = f.store.all()[0]; f.store.edit(first.key, 'mine');
  await assert.rejects(validateLanguageEdit(plan, f.client, f.store, () => true), /版本已变化/);
  assert.equal(f.store.all()[1].text, 'name');
  const second = await documents(); const diskPlan = await prepareLanguageEdit(service, rename, second.client, second.store, second.store.all());
  second.external(); await assert.rejects(validateLanguageEdit(diskPlan, second.client, second.store, () => true), /磁盘版本/);
  assert.equal(second.store.all().some(d => d.dirty), false);
});

test('batch edit is atomic to subscribers, undoable, and makes no disk write', async () => {
  const f = await documents(); const plan = await prepareLanguageEdit(service, rename, f.client, f.store, f.store.all());
  await validateLanguageEdit(plan, f.client, f.store, () => true);
  let notifications = 0; f.store.subscribe(() => { notifications++; assert.equal(f.store.all().filter(d => d.dirty).length, 2); });
  const changes = plan.files.map(file => {
    const original = EditorState.create({ doc: file.before, extensions: [history()] });
    return { ...file, text: file.after, editor: { state: original.update({ changes: { from: 0, to: original.doc.length, insert: file.after } }).state, scrollTop: 0, scrollLeft: 0 } };
  });
  f.store.applyBatch(changes); assert.equal(notifications, 1);
  let state = f.store.all()[0].editor.state;
  assert.equal(undo({ state, dispatch: tr => { state = tr.state; } }), true); assert.equal(state.doc.toString(), 'name');
  assert.equal((await f.client.read('a.py')).text, 'name');
});

test('stale final target prevents even first buffer from changing', async () => {
  const f = await documents(), [a, b] = f.store.all();
  assert.throws(() => f.store.applyBatch([{ key: a.key, lifecycleId: a.lifecycleId, revision: a.revision, text: 'new' },
    { key: b.key, lifecycleId: b.lifecycleId, revision: b.revision + 1, text: 'new' }]), /stale/);
  assert.equal(f.store.get(a.key).text, 'name');
});

test('partial rename saving reports every file and preserves unsaved failed targets', async () => {
  const f = await documents(); const [a, b] = f.store.all(); f.store.edit(a.key, 'new'); f.store.edit(b.key, 'new');
  const client = { ...f.client, save: async request => ({ status: request.relativePath === 'a.py' ? 'succeeded' : 'failed',
    requestId: request.requestId, workspace, relativePath: request.relativePath, bufferRevision: request.bufferRevision,
    version, reasonCode: request.relativePath === 'b.py' ? 'disk_conflict' : '' }) };
  const results = await f.store.saveAll(client, [a.key, b.key]);
  assert.deepEqual(results.map(row => row.receipt?.status), ['succeeded', 'failed']);
  assert.equal(f.store.get(a.key).dirty, false); assert.equal(f.store.get(b.key).dirty, true);
});
