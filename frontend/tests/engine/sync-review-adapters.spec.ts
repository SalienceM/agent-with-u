import { test, expect, type Page } from '@playwright/test';
async function empty(page: Page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated review adapters</title>' });
    return route.continue();
  });
  await page.goto('/');
}
test('real IndexedDB CAS, empty create, idempotence, changed destination and commit-id reconciliation', async ({ page }) => {
  await empty(page);
  const result = await page.evaluate(async () => {
    const { ManagedBrowserLocalFs } = await import('/src/utils/dirSync.ts');
    const { DocumentProtocolError } = await import('/src/utils/workspaceDocuments.ts');
    const fs = new ManagedBrowserLocalFs('review-only-' + crypto.randomUUID());
    await fs.writeBlob('a.txt', new Blob(['old']));
    const adapter = await fs.reviewAdapter('scope');
    const req = { requestId: 'first', relativePath: 'a.txt', baseVersion: (await adapter.read('a.txt')).version!, bytes: new TextEncoder().encode('\uFEFFnew\r\nmixed\n'), scopeKey: 'scope' };
    const saved = await adapter.apply(req, () => {}), repeat = await adapter.apply(req, () => {});
    const contents = [...new Uint8Array(await (await fs.readBlob('a.txt')).arrayBuffer())];
    const stale = await adapter.apply({ ...req, requestId: 'stale' }, () => {});
    const created = await adapter.apply({ ...req, requestId: 'empty', relativePath: 'new/empty.txt', baseVersion: { exists: false }, bytes: new Uint8Array() }, () => {});
    const base = (await adapter.read('a.txt')).version!;
    const journal = (adapter as any).journal, put = journal.put.bind(journal);
    journal.put = async () => { throw new Error('lost journal response'); };
    let lost = false;
    try { await adapter.apply({ ...req, requestId: 'unknown', baseVersion: base }, () => {}); } catch { lost = true; }
    journal.put = put;
    const reconciled = await adapter.get('unknown');
    let aborted = '';
    try { await adapter.apply({ ...req, requestId: 'abort' }, () => { throw new DocumentProtocolError('stale_workspace'); }); } catch (e) { aborted = (e as Error).message; }
    const scan = await fs.scan([]);
    await fs.writeBlob('a.txt', new Blob(['after scan']));
    return { saved: saved.status, repeat: repeat.status, stale: stale.reasonCode, created: created.status,
      size: await fs.fileSize('new/empty.txt'), lost, reconciled: reconciled.status, aborted,
      contents, expected: [...req.bytes], final: await (await fs.readBlob('a.txt')).text(), scanSize: scan['a.txt'].size };
  });
  expect(result.saved).toBe('succeeded'); expect(result.repeat).toBe('succeeded'); expect(result.stale).toBe('disk_conflict');
  expect(result.created).toBe('succeeded'); expect(result.size).toBe(0); expect(result.lost).toBe(true); expect(result.reconciled).toBe('succeeded');
  expect(result.contents).toEqual(result.expected); expect(result.aborted).toBe('stale_workspace'); expect(result.final).toBe('after scan');
});
test('real browser handle raw replacement; no weak create; revoked permission and unknown close', async ({ page }) => {
  await empty(page);
  const result = await page.evaluate(async () => {
    const { BrowserLocalFs } = await import('/src/utils/dirSync.ts');
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle('review-' + crypto.randomUUID(), { create: true });
    const handle = await directory.getFileHandle('a.txt', { create: true });
    let writer = await handle.createWritable(); await writer.write('old'); await writer.close();
    const fs = new BrowserLocalFs(directory), adapter = await fs.reviewAdapter('browser-scope');
    let req = { requestId: 'first', relativePath: 'a.txt', baseVersion: (await adapter.read('a.txt')).version!, bytes: new TextEncoder().encode('\uFEFFnew\r\nmixed\n'), scopeKey: 'browser-scope' };
    const saved = await adapter.apply(req, () => {});
    const bytes = [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
    let create = '';
    try { await adapter.apply({ ...req, requestId: 'create', relativePath: 'missing.txt', baseVersion: { exists: false } }, () => {}); }
    catch (e) { create = (e as Error).message; }
    req = { ...req, baseVersion: (await adapter.read('a.txt')).version! };
    const originalQuery = FileSystemFileHandle.prototype.queryPermission;
    FileSystemFileHandle.prototype.queryPermission = async () => 'denied';
    const denied = await adapter.apply({ ...req, requestId: 'denied' }, () => {});
    FileSystemFileHandle.prototype.queryPermission = originalQuery;
    const close = FileSystemWritableFileStream.prototype.close;
    let closes = 0;
    FileSystemWritableFileStream.prototype.close = async function () { closes++; await close.call(this); throw new Error('lost reply'); };
    const unknown = await adapter.apply({ ...req, requestId: 'unknown', bytes: new TextEncoder().encode('after') }, () => {});
    FileSystemWritableFileStream.prototype.close = close;
    const queried = await adapter.get('unknown');
    const repeated = await adapter.apply({ ...req, requestId: 'unknown', bytes: new TextEncoder().encode('after') }, () => {});
    return { saved: saved.status, bytes, expected: [...req.bytes], create, denied: denied.status, unknown: unknown.status,
      queried: queried.status, repeated: repeated.status, closes, final: await (await handle.getFile()).text() };
  });
  expect(result.saved).toBe('succeeded'); expect(result.bytes).toEqual(result.expected); expect(result.create).toBe('safe_create_unsupported');
  expect(result.denied).toBe('failed'); expect(result.unknown).toBe('unresolved'); expect(result.queried).toBe('unresolved');
  expect(result.repeated).toBe('unresolved'); expect(result.closes).toBe(1); expect(result.final).toBe('after');
});

test('browser same-name replacement is not overwritten even with identical bytes', async ({ page }) => {
  await empty(page);
  const result = await page.evaluate(async () => {
    const { BrowserLocalFs } = await import('/src/utils/dirSync.ts');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('replacement-' + crypto.randomUUID(), { create: true });
    const initial = await dir.getFileHandle('a.txt', { create: true });
    const writer = await initial.createWritable(); await writer.write('old'); await writer.close();
    const fs = new BrowserLocalFs(dir), adapter = await fs.reviewAdapter('replacement-scope');
    const baseVersion = (await adapter.read('a.txt')).version!;
    const raw = (adapter as any).adapter, replace = raw.replace.bind(raw);
    raw.replace = async (...args: any[]) => {
      await dir.removeEntry('a.txt');
      const replacement = await dir.getFileHandle('a.txt', { create: true });
      const w = await replacement.createWritable(); await w.write('old'); await w.close();
      return replace(...args);
    };
    const receipt = await adapter.apply({ requestId: 'replacement', relativePath: 'a.txt', baseVersion,
      bytes: new TextEncoder().encode('new'), scopeKey: 'replacement-scope' }, () => {});
    return { status: receipt.status, reason: receipt.reasonCode, text: await (await (await dir.getFileHandle('a.txt')).getFile()).text() };
  });
  expect(result).toEqual({ status: 'failed', reason: 'disk_conflict', text: 'old' });
});
