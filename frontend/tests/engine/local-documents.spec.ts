import { test, expect, type Page } from '@playwright/test';

async function empty(page: Page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated document tests</title>' });
    return route.continue();
  });
  await page.goto('/');
}

test('real IndexedDB copy uses transactional versions and preserves explicit transfer operations', async ({ page }) => {
  await empty(page);
  const result = await page.evaluate(async () => {
    const { ManagedBrowserLocalFs } = await import('/src/utils/dirSync.ts');
    const { LocalDocuments } = await import('/src/utils/localDocuments.ts');
    const { IndexedLocalJournal } = await import('/src/utils/localDocumentStorage.ts');
    const fs = new ManagedBrowserLocalFs('test-only-' + crypto.randomUUID());
    await fs.writeBlob('a.py', new Blob(['old\r\n']));
    const adapter = await fs.documentAdapter();
    const client = new LocalDocuments('test-user', 'session', 'fake-executor', adapter, new IndexedLocalJournal(), () => true);
    const base = await client.read('a.py');
    const req = { requestId: 'r1', relativePath: 'a.py', baseVersion: base.version, controlRevision: 0, bufferRevision: 1, text: 'edited\n' };
    const save = await client.save(req);
    const saved = await (await fs.readBlob('a.py')).text();
    const repeat = await client.save(req);
    await fs.writeStart('a.py', 'explicit-transfer');
    await fs.writeChunk('a.py', 'explicit-transfer', 0, btoa('transfer'));
    await fs.writeFinish('a.py', 'explicit-transfer', 8);
    const stale = await client.save({ ...req, requestId: 'r2', baseVersion: save.version });
    // 在平台 CAS 最后一刻模拟另一个传输提交，必须拒绝覆盖。
    const current = await client.read('a.py');
    let rejected = '';
    await fs.writeBlob('a.py', new Blob(['outside']));
    try { await adapter.replace('a.py', current.version, new TextEncoder().encode('mine'), () => {}); }
    catch (error) { rejected = error.reasonCode; }
    return { source: base.document.source, saved, save: save.status, repeat: repeat.status,
      stale: stale.reasonCode, rejected, final: await (await fs.readBlob('a.py')).text() };
  });
  expect(result).toEqual({ source: 'local-copy', saved: 'edited\r\n', save: 'succeeded', repeat: 'succeeded',
    stale: 'disk_conflict', rejected: 'disk_conflict', final: 'outside' });
});

test('real browser handles distinguish same-name roots and serialize two windows', async ({ page, context }) => {
  await empty(page);
  const other = await context.newPage(); await empty(other);
  const setup = async (p: Page) => p.evaluate(async () => {
    const { BrowserDocumentAdapter } = await import('/src/utils/browserLocalDocuments.ts');
    const { LocalDocuments } = await import('/src/utils/localDocuments.ts');
    const { IndexedLocalJournal } = await import('/src/utils/localDocumentStorage.ts');
    const root = await navigator.storage.getDirectory();
    const one = await (await root.getDirectoryHandle('one', { create: true })).getDirectoryHandle('same', { create: true });
    const two = await (await root.getDirectoryHandle('two', { create: true })).getDirectoryHandle('same', { create: true });
    const handle = await one.getFileHandle('a.py', { create: true });
    const existing = await handle.getFile();
    if (!existing.size) { const writer = await handle.createWritable(); await writer.write('old'); await writer.close(); }
    const adapter = await BrowserDocumentAdapter.connect(one);
    const second = await BrowserDocumentAdapter.connect(two);
    const client = new LocalDocuments('test-user', 'session', 'fake-executor', adapter, new IndexedLocalJournal(), () => true);
    (window as any).testClient = client;
    (window as any).baseline = (await client.read('a.py')).version;
    return { first: adapter.bindingId, second: second.bindingId };
  });
  const a = await setup(page), b = await setup(other);
  expect(a.first).toBe(b.first); expect(a.first).not.toBe(a.second);
  const save = (p: Page, requestId: string) => p.evaluate(async requestId => {
    return (await (window as any).testClient.save({ requestId, relativePath: 'a.py',
      baseVersion: (window as any).baseline, controlRevision: 0, bufferRevision: 1, text: requestId })).status;
  }, requestId);
  expect((await Promise.all([save(page, 'window-a'), save(other, 'window-b')])).sort()).toEqual(['failed', 'succeeded']);
});

test('permission revoked before commit aborts temp writer; close response loss is read-only reconciled', async ({ page }) => {
  await empty(page);
  const result = await page.evaluate(async () => {
    const { BrowserDocumentAdapter } = await import('/src/utils/browserLocalDocuments.ts');
    const { LocalDocuments } = await import('/src/utils/localDocuments.ts');
    const { IndexedLocalJournal } = await import('/src/utils/localDocumentStorage.ts');
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('a.py', { create: true });
    const writer = await handle.createWritable(); await writer.write('old'); await writer.close();
    const adapter = await BrowserDocumentAdapter.connect(root);
    const client = new LocalDocuments('test-user', 's', 'e', adapter, new IndexedLocalJournal(), () => true);
    const base = await client.read('a.py');
    const request = { requestId: 'r1', relativePath: 'a.py', baseVersion: base.version, text: 'new', controlRevision: 0, bufferRevision: 1 };
    let permissionChecks = 0;
    const originalQuery = FileSystemFileHandle.prototype.queryPermission;
    FileSystemFileHandle.prototype.queryPermission = async function (...args) {
      return ++permissionChecks > 4 ? 'denied' : originalQuery.apply(this, args);
    };
    const denied = await client.save(request);
    FileSystemFileHandle.prototype.queryPermission = originalQuery;
    const afterDenied = await (await handle.getFile()).text();
    const close = FileSystemWritableFileStream.prototype.close;
    FileSystemWritableFileStream.prototype.close = async function () { await close.call(this); throw new Error('lost close reply'); };
    const unknown = await client.save({ ...request, requestId: 'r2' });
    FileSystemWritableFileStream.prototype.close = close;
    const reconciled = await client.saveGet('r2');
    return { denied: denied.status, reason: denied.reasonCode, afterDenied, unknown: unknown.status,
      reconciled: reconciled.status, final: await (await handle.getFile()).text() };
  });
  expect(result).toEqual({ denied: 'failed', reason: 'document_readonly', afterDenied: 'old',
    unknown: 'unresolved', reconciled: 'succeeded', final: 'new' });
});

test('managed copies retain safe editing without Web Locks/randomUUID and claim requests across windows', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { value: undefined });
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
  });
  await empty(page); const other = await context.newPage(); await empty(other);
  async function setup(target: Page, create: boolean) {
    await target.evaluate(async create => {
      const { ManagedBrowserLocalFs } = await import('/src/utils/dirSync.ts');
      const { LocalDocuments } = await import('/src/utils/localDocuments.ts');
      const { IndexedLocalJournal } = await import('/src/utils/localDocumentStorage.ts');
      const fs = new ManagedBrowserLocalFs('isolated-no-locks');
      if (create) await fs.writeBlob('a.py', new Blob(['same text']));
      const adapter = await fs.documentAdapter();
      const client = new LocalDocuments('test-user', 'session', 'fake-executor', adapter, new IndexedLocalJournal(), () => true);
      const request = { requestId: 'same-request', relativePath: 'a.py', baseVersion: (await client.read('a.py')).version,
        bufferRevision: 1, controlRevision: 0, text: 'same text' };
      (window as any).client = client; (window as any).request = request;
      if (create) {
        const replace = adapter.storage.replace;
        adapter.storage.replace = async (...args) => {
          await new Promise(resolve => { (window as any).commit = resolve; });
          return replace(...args);
        };
        (window as any).saving = client.save(request);
      }
    }, create);
  }
  await setup(page, true); await page.waitForFunction(() => (window as any).commit);
  await setup(other, false);
  expect(await other.evaluate(async () => (await (window as any).client.save((window as any).request)).status)).toBe('accepted');
  // 文本恰好相同不能证明本请求已经提交，必须核对 IDB 内原子存储的提交 ID。
  expect(await other.evaluate(async () => (await (window as any).client.saveGet('same-request')).status)).toBe('unresolved');
  expect(await other.evaluate(async () => (await (window as any).client.save({ ...(window as any).request,
    requestId: 'competitor', text: 'competing' })).reasonCode)).toBe('save_needs_reconciliation');
  expect(await page.evaluate(async () => { (window as any).commit(); return (await (window as any).saving).status; })).toBe('succeeded');
  expect(await other.evaluate(async () => (await (window as any).client.saveGet('same-request')).status)).toBe('succeeded');
});
