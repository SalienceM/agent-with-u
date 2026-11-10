import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 780 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><head><meta charset="utf-8"></head><body><button id="trigger">传输</button><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const { DirectoryTransferDialog } = await import('/src/components/DirectoryTransferDialog.tsx');
    const { api, getCurrentUserProfile } = await import('/src/api.ts');
    const { byteHash } = await import('/src/utils/documentCodec.ts');
    const { fileTransfers } = await import('/src/utils/fileTransfers.ts');
    const { scanTransferSource } = await import('/src/utils/directoryTransferSource.ts');
    Object.entries({ '--theme-panel-solid': '#fff', '--theme-text': '#273244', '--theme-text-muted': '#627085', '--theme-border': '#d5dce5', '--theme-accent': '#527bcf' }).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
    document.body.style.fontFamily = 'system-ui, sans-serif'; document.body.style.margin = '0';
    const f = { calls: [] as any[], source: { same: 'same', changed: 'new', empty: '' } as Record<string, string>,
      target: { same: 'same', changed: 'old', extra: 'delete me' }, mirror: false, identity: 'initial',
      lost: false, unknown: false, corrupt: false, closed: 0, changed: 0, render: () => {}, rows: new Map(), scans: 0,
      manager: fileTransfers, scanTransferSource };
    const meta = (data: string) => ({ hash: byteHash(new TextEncoder().encode(data)), size: data.length });
    const sourceManifest = () => Object.fromEntries(Object.entries(f.source).map(([p, s]) => [p, meta(s)]));
    api.projectTransferIdentity = () => f.identity;
    const workspace = { ownerId: getCurrentUserProfile().userId, sessionId: 's', workingDir: 'C:/remote', executorInstance: 'node', workspaceRevision: 'a'.repeat(64) };
    api.directoryTransferCall = async (_executor, method, args) => {
      f.calls.push([method, ...args]);
      if (method === 'Config') return { version: 1, workspace, ignore: ['node_modules'] };
      if (method === 'Plan') {
        const request = JSON.parse(args[2] as string);
        const entries = Object.entries(request.source).map(([path, value]: any) => ({ path, ...value, action: !(path in f.target) ? 'add' : meta(f.target[path as keyof typeof f.target]).hash === value.hash ? 'skip' : 'update' }));
        if (request.mirror) entries.push({ path: 'extra', action: 'delete', ...meta(f.target.extra) });
        const row = { version: 1, id: String(f.rows.size + 1), state: 'preview', workspace, scope: '', mirror: request.mirror, entries, uploaded: [], deleted: [], message: '' };
        f.rows.set(row.id, row); return structuredClone(row);
      }
      const id = args[method === 'Commit' ? 3 : 2] as string, row = f.rows.get(id);
      if (method === 'Cancel') { row.state = 'cancelled'; return structuredClone(row); }
      if (method === 'Chunk') { if (f.corrupt) throw Error('network failure'); return { written: atob(args[5] as string).length }; }
      if (method === 'Commit') {
        row.state = f.unknown ? 'committing' : 'succeeded';
        row.uploaded = row.entries.filter((e: any) => e.action === 'add' || e.action === 'update').map((e: any) => e.path);
        row.deleted = row.entries.filter((e: any) => e.action === 'delete').map((e: any) => e.path);
        if (f.lost || f.unknown) throw Error('reply lost');
        return structuredClone(row);
      }
      if (method === 'Status') return structuredClone(row);
      throw Error(method);
    };
    const fs = { kind: 'browser', id: () => 'local-copy', label: () => 'D:/source', transferScan: async () => { f.scans++; return sourceManifest(); },
      readChunk: async (rel: string, offset: number, size: number) => btoa(f.source[rel].slice(offset, offset + size)) };
    const root = createRoot(document.getElementById('root')!);
    f.render = () => root.render(React.createElement(DirectoryTransferDialog, { input: { executor: 'remote', session: 's', workingDir: 'C:/remote', fs, scope: '', directory: true, mirror: f.mirror,
      includeGit: false, transferKey: 'remote:/work', label: '执行节点 B', current: () => true },
      onClose: () => { f.closed++; root.render(null); }, onChanged: () => { f.changed++; } }));
    document.getElementById('trigger')!.onclick = f.render;
    (window as any).fixture = f; document.getElementById('trigger')!.focus(); f.render();
  });
  await expect(page.getByRole('dialog')).toContainText('跳过 1');
}

for (const width of [1280, 390]) test(`mirror preview explicit deletion and keyboard ${width}`, async ({ page }, info) => {
  await mount(page, width);
  await page.getByLabel('传输模式', { exact: true }).selectOption('mirror');
  await expect(page.getByLabel('待删除文件')).toContainText('extra');
  await expect(page.getByRole('dialog')).toContainText('实际传输：3 B');
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((a: any[]) => ['Chunk', 'Commit'].includes(a[0])))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('mirror-preview.png'), fullPage: true });
  await page.getByRole('button', { name: '确认同步并删除' }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '关闭传输预览' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#trigger')).toBeFocused();
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((a: any[]) => a[0] === 'Commit'))).toEqual([]);
});

test('identical files send no body and ordinary upload does not delete', async ({ page }) => {
  await mount(page); await page.getByRole('button', { name: '确认传输', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0]?.status)).toBe('done');
  const rows = await page.evaluate(() => (window as any).fixture.calls);
  expect(rows.filter((a: any[]) => a[0] === 'Chunk').map((a: any[]) => a[4])).toEqual(['changed', 'empty']);
  expect(rows.filter((a: any[]) => a[0] === 'Commit')).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0].message)).toContain('删除 0');
});

test('mirror writes only after explicit confirmation', async ({ page }) => {
  await mount(page); await page.getByLabel('传输模式', { exact: true }).selectOption('mirror');
  await page.getByRole('button', { name: '确认同步并删除' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0]?.status)).toBe('done');
  expect(await page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0].message)).toContain('删除 1');
});

test('source changes refuse the frozen plan', async ({ page }) => {
  await mount(page); await page.evaluate(() => { (window as any).fixture.source.newFile = 'new'; });
  await page.getByRole('button', { name: '确认传输', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0]?.status)).toBe('error');
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((a: any[]) => ['Chunk', 'Commit'].includes(a[0])))).toEqual([]);
});

test('lost receipt checks original without replay and unresolved remains reserved', async ({ page }) => {
  await mount(page); await page.evaluate(() => { (window as any).fixture.unknown = true; });
  await page.getByRole('button', { name: '确认传输', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0]?.status)).toBe('unresolved');
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((a: any[]) => a[0] === 'Status'))).toHaveLength(1);
  await page.evaluate(async () => {
    const f = (window as any).fixture; f.rows.get('1').state = 'succeeded'; await f.manager.getSnapshot()[0].reconcile();
  });
  expect(await page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0].status)).toBe('done');
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((a: any[]) => a[0] === 'Commit'))).toHaveLength(1);
});

test('body failure never commits mirror deletion', async ({ page }) => {
  await mount(page); await page.getByLabel('传输模式', { exact: true }).selectOption('mirror');
  await expect(page.getByLabel('待删除文件')).toBeVisible();
  await page.evaluate(() => { (window as any).fixture.corrupt = true; });
  await page.getByRole('button', { name: '确认同步并删除' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.manager.getSnapshot()[0]?.status)).toBe('error');
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((a: any[]) => a[0] === 'Commit'))).toEqual([]);
});

test('actual source scan never trusts cached metadata or swallowed directory errors', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { scanTransferSource } = (window as any).fixture;
    let body = 'old'; let missing = false;
    const fs = { kind: 'browser', listDir: async () => { if (missing) throw Error('unreadable'); return [{ name: 'a', isDir: false }]; },
      fileSize: async () => 3, readChunk: async () => btoa(body) };
    const first = await scanTransferSource(fs, '', true, [], false); body = 'new';
    const second = await scanTransferSource(fs, '', true, [], false); missing = true;
    let error = ''; try { await scanTransferSource(fs, '', true, [], false); } catch (e: any) { error = e.message; }
    return { different: first.a.hash !== second.a.hash, error };
  });
  expect(result).toEqual({ different: true, error: 'unreadable' });
});

test('identity changes invalidate confirmation without any upload', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).fixture.identity = 'changed-user'; });
  await page.getByRole('button', { name: '确认传输', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('用户、节点或副本已变化');
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((a: any[]) => ['Chunk', 'Commit'].includes(a[0])))).toEqual([]);
});

test('old native source cannot fall back to a lossy ordinary scan', async ({ page }) => {
  await mount(page);
  const message = await page.evaluate(async () => {
    const f = (window as any).fixture;
    try { await f.scanTransferSource({ kind: 'tauri', scan: () => { throw Error('unsafe fallback'); } }, '', true, [], false); }
    catch (error: any) { return error.message; }
  });
  expect(message).toContain('请更新桌面端');
});
