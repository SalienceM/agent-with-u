const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalDocuments } = require('../../.home-test-dist/utils/localDocuments.js');
const { DocumentStore } = require('../../.home-test-dist/utils/documentStore.js');
const { byteHash, encodeDocumentText, decodeDocumentBytes, MAX_EDIT_BYTES } = require('../../.home-test-dist/utils/documentCodec.js');
const { DocumentProtocolError, sameDiskVersion } = require('../../.home-test-dist/utils/workspaceDocuments.js');
const { TauriDocumentAdapter } = require('../../.home-test-dist/utils/tauriLocalDocuments.js');

test('native path keys preserve Linux case distinctions but share Windows aliases', async () => {
  for (const caseSensitive of [true, false, undefined]) {
    const adapter = await TauriDocumentAdapter.connect('/fixture', async (method, params) => method === 'local_document_bind'
      ? { bindingId: 'tauri:fixture', canonicalRoot: '/fixture', caseSensitive }
      : { data: btoa('data'), size: 4, complete: true, readonly: false, canonicalPath: `/fixture/${params.rel}`, version: null });
    const upper = await adapter.resourceKey('File.py'), lower = await adapter.resourceKey('file.py');
    if (caseSensitive) assert.notEqual(upper, lower);
    else assert.equal(upper, lower);
  }
});

const utf8 = text => new TextEncoder().encode(text);
function fixture(initial = utf8('old')) {
  let bytes = initial, generation = 1, queue = Promise.resolve(), writes = 0, current = true;
  const jobs = new Map();
  const journal = {
    claim: async job => {
      if (jobs.has(job.key)) return structuredClone(jobs.get(job.key));
      await journal.put(job); return structuredClone(job);
    },
    get: async key => structuredClone(jobs.get(key)),
    put: async job => { jobs.set(job.key, structuredClone(job)); },
    pending: async key => [...jobs.values()].find(job => job.documentKey === key && ['accepted', 'unresolved'].includes(job.receipt.status)),
  };
  const read = async () => ({ bytes: bytes.slice(), complete: true, size: bytes.length,
    version: { exists: true, sha256: byteHash(bytes), byteLength: bytes.length, fileId: 'file1', modifiedNs: `${generation}`, changedNs: `${generation}` } });
  const adapter = { bindingId: 'root1', resourceKey: async () => 'physical-file1', read,
    lock: (_rel, task) => { const job = queue.then(task); queue = job.catch(() => {}); return job; },
    replace: async (_rel, baseline, value, check) => {
      check(); if (!sameDiskVersion((await read()).version, baseline)) throw new DocumentProtocolError('disk_conflict');
      writes++; bytes = value.slice(); generation++; return read();
    },
  };
  const client = new LocalDocuments('alice', 'session', 'executor', adapter, journal, () => current);
  const request = async (id = 'r1', text = 'draft') => ({ requestId: id, relativePath: 'a.py',
    baseVersion: (await read()).version, text, controlRevision: 0, bufferRevision: 1 });
  return { client, adapter, journal, request, jobs, read, writes: () => writes,
    external: text => { bytes = utf8(text); generation++; }, stale: () => { current = false; } };
}

test('local codec roundtrips UTF8/UTF16 BOM and CRLF/CR without replacing malformed Unicode', () => {
  for (const [encoding, bom] of [['utf-8', ''], ['utf-8', 'utf8'], ['utf-16-le', 'utf16le'], ['utf-16-be', 'utf16be']]) {
    for (const eol of ['lf', 'crlf', 'cr']) {
      const format = { encoding, bom, eol }, text = '你好😀\nsecond\n';
      const bytes = encodeDocumentText(text, format);
      assert.deepEqual(decodeDocumentBytes(bytes, true), { ...format, text, reasonCode: '' });
      assert.deepEqual(encodeDocumentText(decodeDocumentBytes(bytes, true).text, format), bytes);
      assert.throws(() => encodeDocumentText('\ud800', format), /invalid_encoding|replacement_character/);
    }
  }
  assert.equal(decodeDocumentBytes(utf8('a\r\nb\n'), true).reasonCode, '');
  assert.equal(decodeDocumentBytes(new Uint8Array([255]), true).reasonCode, 'invalid_encoding');
  assert.equal(decodeDocumentBytes(utf8('a\0b'), true).reasonCode, 'binary');
});

test('copy source and actual binding isolate owner/session/executor and same-name roots', () => {
  const f = fixture();
  for (const args of [['bob', 'session', 'executor', f.adapter], ['alice', 'other', 'executor', f.adapter],
    ['alice', 'session', 'other', f.adapter], ['alice', 'session', 'executor', { ...f.adapter, bindingId: 'root2' }]]) {
    const client = new LocalDocuments(...args, f.journal, () => true);
    assert.notDeepEqual(client.identity, f.client.identity);
  }
  assert.equal(f.client.source, 'local-copy');
});

test('lossless local save is idempotent and rejects request reuse with different input', async () => {
  const f = fixture(encodeDocumentText('old\n', { encoding: 'utf-16-be', bom: 'utf16be', eol: 'crlf' }));
  const request = await f.request('r1', '新😀\n');
  const receipt = await f.client.save(request);
  assert.equal(receipt.status, 'succeeded');
  assert.equal((await f.client.read('a.py')).text, request.text);
  assert.equal((await f.client.read('a.py')).bom, 'utf16be');
  assert.deepEqual(await f.client.save(request), receipt);
  assert.equal(f.writes(), 1);
  await assert.rejects(f.client.save({ ...request, text: 'other' }), /request_conflict/);
});

test('external change and same-origin competitor leave draft dirty with a definite conflict', async () => {
  const f = fixture(); let id = 0; const store = new DocumentStore(() => `s${++id}`);
  const doc = await store.open(f.client, 'a.py'); store.edit(doc.key, 'mine');
  f.external('external');
  const receipt = await store.save(f.client, doc.key);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'disk_conflict');
  assert.equal(store.get(doc.key).dirty, true); assert.equal(store.get(doc.key).save.unknown, false);
  assert.equal(f.writes(), 0);
  const a = await f.request('a'), b = await f.request('b', 'competitor');
  const results = await Promise.all([f.client.save(a), f.client.save(b)]);
  assert.deepEqual(results.map(row => row.status), ['succeeded', 'failed']);
  assert.equal(f.writes(), 1);
});

test('lost commit response is reconciled read-only; mismatch remains blocked across clients', async () => {
  const f = fixture(); const replace = f.adapter.replace;
  f.adapter.replace = async (...args) => { await replace(...args); throw new Error('lost response'); };
  const request = await f.request();
  assert.equal((await f.client.save(request)).status, 'unresolved');
  const recovered = new LocalDocuments('alice', 'session', 'executor', f.adapter, f.journal, () => true);
  assert.equal((await recovered.saveGet('r1')).status, 'succeeded'); assert.equal(f.writes(), 1);
  f.adapter.replace = async () => { throw new Error('unknown'); };
  assert.equal((await recovered.save(await f.request('r2', 'second'))).status, 'unresolved');
  assert.equal((await recovered.saveGet('r2')).status, 'unresolved');
  assert.equal((await recovered.save(await f.request('r3', 'third'))).reasonCode, 'save_needs_reconciliation');
  assert.equal(f.writes(), 1);
});

test('journal failure and identity switch before replacement perform no write', async () => {
  const f = fixture(); f.journal.put = async () => { throw new Error('quota'); };
  assert.equal((await f.client.save(await f.request())).reasonCode, 'journal_unavailable');
  assert.equal(f.writes(), 0);
  const g = fixture(); const put = g.journal.put;
  g.journal.put = async value => { await put(value); g.stale(); };
  await assert.rejects(g.client.save(await g.request()), /stale_workspace/);
  assert.equal(g.writes(), 0);
  assert.equal([...g.jobs.values()][0].receipt.status, 'failed');
});

test('an unchanged target matching the desired text is not proof of an unknown commit', async () => {
  const f = fixture(utf8('same text'));
  f.adapter.replace = async () => { throw new Error('lost before native entry'); };
  assert.equal((await f.client.save(await f.request('same', 'same text'))).status, 'unresolved');
  assert.equal((await f.client.saveGet('same')).status, 'unresolved');
  assert.equal(f.writes(), 0);
});

test('binary, malformed encoding, specialized documents and truncated data cannot be saved', async () => {
  for (const initial of [utf8('a\0b'), new Uint8Array([255])]) {
    const f = fixture(initial); assert.equal((await f.client.read('a.py')).editable, false);
    assert.equal((await f.client.save(await f.request())).status, 'failed'); assert.equal(f.writes(), 0);
  }
  const f = fixture(); assert.equal((await f.client.read('a.pdf')).editable, false);
  f.adapter.read = async () => ({ bytes: utf8('preview'), version: null, complete: false, size: MAX_EDIT_BYTES + 1 });
  assert.equal((await f.client.read('a.py')).editable, false);
  await assert.rejects(f.client.read('../escape.py'), /invalid_path/);
});

test('mixed EOL local text roundtrips losslessly and preserves unchanged lines on edit, insertion and deletion', async () => {
  for (const [encoding, bom] of [['utf-8', ''], ['utf-8', 'utf8'], ['utf-16-le', 'utf16le'], ['utf-16-be', 'utf16be']]) {
    const format = { encoding, bom, eol: 'mixed', text: 'a\nb\nc\nd', lineEndings: ['\r\n', '\n', '\r'] };
    const bytes = encodeDocumentText(format.text, format);
    const decoded = decodeDocumentBytes(bytes, true);
    assert.equal(decoded.reasonCode, '');
    assert.deepEqual(encodeDocumentText(decoded.text, decoded), bytes);
    const f = fixture(bytes);
    const read = await f.client.read('a.py'); assert.equal(read.editable, true);
    assert.equal((await f.client.save(await f.request('edit', 'A\nb\nc\nd'))).status, 'succeeded');
    assert.deepEqual(decodeDocumentBytes((await f.read()).bytes, true).lineEndings, ['\r\n', '\n', '\r']);
    assert.equal((await f.client.save(await f.request('insert', 'A\ninsert\nb\nc\nd'))).status, 'succeeded');
    assert.deepEqual(decodeDocumentBytes((await f.read()).bytes, true).lineEndings, ['\r\n', '\r\n', '\n', '\r']);
    assert.equal((await f.client.save(await f.request('delete', 'A\ninsert\nc\nd'))).status, 'succeeded');
    assert.deepEqual(decodeDocumentBytes((await f.read()).bytes, true).lineEndings, ['\r\n', '\r\n', '\r']);
    assert.equal((await f.client.read('a.py')).bom, bom);
  }
});

test('mixed EOL draft restores after reload, rejects disk conflicts and keeps original bytes', async () => {
  const f = fixture(utf8('one\r\ntwo\nthree'));
  let id = 0; const store = new DocumentStore(() => `mixed${++id}`);
  const doc = await store.open(f.client, 'a.py');
  store.restore(doc.key, { format: 1, identity: doc.identity, text: 'ONE\ntwo\nthree', baseText: doc.text,
    revision: 2, baseVersion: doc.read.version, encoding: doc.read.encoding, bom: doc.read.bom, eol: 'mixed' });
  assert.equal(store.get(doc.key).dirty, true);
  assert.equal((await store.save(f.client, doc.key)).status, 'succeeded');
  assert.equal(new TextDecoder().decode((await f.read()).bytes), 'ONE\r\ntwo\nthree');
  store.edit(doc.key, 'another'); f.external('external\r\nchange\n');
  assert.equal((await store.save(f.client, doc.key)).reasonCode, 'disk_conflict');
  assert.equal(store.get(doc.key).dirty, true);
  assert.equal(new TextDecoder().decode((await f.read()).bytes), 'external\r\nchange\n');
});

test('remote readonly adapter disables cached edits, ordinary save and batch save without invoking writer', async () => {
  const { readonlyDocumentClient } = require('../../.home-test-dist/utils/documentStore.js');
  const f = fixture(); const client = { ...f.client, identity: f.client.identity, source: 'executor', read: p => f.client.read(p),
    save: p => f.client.save(p), saveGet: p => f.client.saveGet(p) };
  // 此测试只核对策略；实际来源身份在浏览器端到端验证。
  const readonly = readonlyDocumentClient(client);
  assert.equal((await readonly.read('a.py')).editable, false);
  await assert.rejects(readonly.save(await f.request()), /remote_readonly/);
  const store = new DocumentStore(); const doc = await store.open(f.client, 'a.py'); store.edit(doc.key, 'legacy draft');
  f.external('external update'); await store.open(f.client, 'a.py', true);
  const conflict = store.get(doc.key);
  assert.equal(conflict.disk.editable, true);
  await store.open(readonlyDocumentClient(f.client), 'a.py');
  assert.equal(store.get(doc.key).text, 'legacy draft');
  assert.throws(() => store.edit(doc.key, 'blocked'), /document_readonly/);
  assert.throws(() => store.merge(doc.key, conflict.disk.version, conflict.revision, 'blocked merge'), /document_readonly/);
  assert.throws(() => store.applyBatch([{ key: doc.key, lifecycleId: doc.lifecycleId, revision: conflict.revision, text: 'blocked batch' }]), /edit_plan_stale/);
  await assert.rejects(store.save(readonlyDocumentClient(f.client), doc.key), /remote_readonly/);
  assert.equal((await store.saveAll(readonlyDocumentClient(f.client), [doc.key]))[0].error, 'remote_readonly');
  assert.equal(f.writes(), 0);
});
