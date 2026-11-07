import { test, expect, type BrowserContext, type Page } from '@playwright/test';

async function setup(context: BrowserContext) {
  await context.routeWebSocket(/.*/, s => s.close());
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname !== '/') return route.continue();
    return route.fulfill({ contentType: 'text/html', body: '<html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}</style><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;await import("/tests/engine/preview-lifecycle-harness.ts");</script></html>' });
  });
}
async function open(page: Page, context: BrowserContext, kind = 'excel', profile = false) {
  await setup(context); await page.goto(`/?fixture=${kind}${profile ? '&profile=1' : ''}`);
  if (kind === 'text') await expect(page.locator('.ftp-row').first()).toHaveAttribute('title', /两端均有/);
  await page.locator('.ftp-row').first().dblclick();
  const popup = context.waitForEvent('page'); await page.getByRole('button', { name: /独立窗口/ }).click();
  const child = await popup; await expect(child.locator('[data-preview-reading]')).toBeVisible(); return child;
}
test('actual opener unmount preserves detached source and reload', async ({ page, context }) => {
  const child = await open(page, context);
  await expect(child.locator('[data-excel-grid]')).toBeVisible();
  await page.evaluate(() => (window as any).lifecycleFixture.unmount());
  await expect(child.locator('[data-excel-grid]')).toBeVisible();
  await child.getByLabel('预览窗口操作', { exact: true }).click(); await child.getByText('↻ 重新加载', { exact: true }).click();
  await expect(child.locator('[data-excel-grid]')).toBeVisible();
  await expect(child.locator('[role=alert]')).toHaveCount(0);
});

async function reloadFile(page: Page) {
  await page.getByLabel('预览窗口操作', { exact: true }).click(); await page.getByText('↻ 重新加载', { exact: true }).click();
}
async function edit(page: Page) {
  await page.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  const editor = page.locator('.cm-content'); await expect(editor).toBeVisible();
  await editor.fill('unsaved independent draft'); return editor;
}
for (const kind of ['excel', 'docx', 'pdf', 'text', 'markdown', 'html']) test(`independent ${kind} survives source close, reads and refreshes`, async ({ page, context }) => {
  const child = await open(page, context, kind);
  const loaded = async () => {
    if (kind === 'excel') await expect(child.locator('[data-excel-grid]')).toBeVisible();
    else if (kind === 'docx') await expect(child.locator('section.awu-docx').first()).toBeVisible();
    else if (kind === 'pdf') { await expect(child.getByText('第 1 / 2 页', { exact: true })).toBeVisible(); await expect(child.getByText('正在渲染第 1 页…')).toHaveCount(0); }
    else if (kind === 'html') await expect(child.frameLocator('iframe').getByText('Independent HTML')).toBeVisible();
    else await expect(child.locator('[data-preview-reading]')).toContainText(kind === 'markdown' ? 'Independent markdown' : 'Independent original text');
  };
  await loaded();
  if (kind === 'excel') await child.locator('[data-excel-grid] td').nth(2).click();
  if (kind === 'docx' || kind === 'pdf') {
    await child.getByLabel(kind === 'docx' ? 'Word 缩放' : 'PDF 缩放').selectOption('1.5');
    if (kind === 'pdf') { await child.getByLabel('下一页').click(); await expect(child.getByText('正在渲染第 2 页…')).toHaveCount(0); }
    await child.locator(kind === 'docx' ? '[data-docx-scroll]' : '[data-pdf-scroll]').evaluate(e => { e.scrollLeft = 90; e.scrollTop = 90; });
  }
  const selector = ({ excel: '[data-excel-grid]', docx: 'section.awu-docx', pdf: 'canvas', markdown: '.awu-md-document', html: 'iframe', text: '[data-preview-reading] pre' } as any)[kind];
  await child.evaluate(selector => { (window as any).stableViewer = document.querySelector(selector); }, selector);
  const gridSelection = kind === 'excel' ? await child.locator('[data-excel-grid]').innerHTML() : '';
  if (kind !== 'text') {
    await child.evaluate(() => { const f = (window as any).lifecycleFixture; f.offline = true; f.connection(false); });
    await expect(child.getByRole('alert')).toContainText('离线');
    await child.evaluate(() => { (window as any).lifecycleFixture.offline = false; });
    await child.getByText('重新连接 / 核对来源', { exact: true }).click();
    await expect(child.locator('[data-preview-connected]')).toHaveAttribute('data-preview-connected', 'true');
    expect(await child.evaluate(selector => (window as any).stableViewer === document.querySelector(selector), selector)).toBe(true);
    if (kind === 'excel') expect(await child.locator('[data-excel-grid]').innerHTML()).toBe(gridSelection);
    if (kind === 'docx' || kind === 'pdf') {
      await expect(child.getByLabel(kind === 'docx' ? 'Word 缩放' : 'PDF 缩放')).toHaveValue('1.5');
      expect(await child.locator(kind === 'docx' ? '[data-docx-scroll]' : '[data-pdf-scroll]').evaluate(e => e.scrollTop)).toBeGreaterThan(0);
      if (kind === 'pdf') await expect(child.getByText('第 2 / 2 页', { exact: true })).toBeVisible();
    }
  }
  await page.close(); await reloadFile(child); await loaded();
  if (kind === 'html') {
    await child.frameLocator('iframe').getByText('Next document').click();
    await expect(child.frameLocator('iframe').getByText('Second HTML')).toBeVisible();
  }
  await child.reload(); await loaded();
  const calls = await child.evaluate(() => (window as any).lifecycleFixture.calls);
  expect(calls.some((c: any) => /save|sendMessage|upload|register|reclaim/i.test(c.method))).toBe(false);
  expect(calls.filter((c: any) => ['parse', 'chunk'].includes(c.method)).every((c: any) => c.args.at(-1) === 'local')).toBe(true);
});
test('same identity profile update keeps selection and source registration', async ({ page, context }) => {
  const child = await open(page, context, 'excel', true);
  await child.locator('[data-excel-grid] td').nth(2).click();
  const before = await child.locator('[data-excel-grid]').innerHTML();
  await page.evaluate(async () => {
    const api = await import('/src/api.ts'); api.rememberRelayUserProfile({ ...api.getCurrentUserProfile(), displayName: 'New nickname', avatarColor: '#fff' });
  });
  await expect(child.locator('[data-preview-connected]')).toHaveAttribute('data-preview-connected', 'true');
  expect(await child.locator('[data-excel-grid]').innerHTML()).toBe(before);
  await reloadFile(child); await expect(child.locator('[data-excel-grid]')).toBeVisible();
});
test('node offline does not invalidate available local copy or its draft', async ({ page, context }) => {
  const child = await open(page, context, 'text'); const editor = await edit(child);
  const before = await child.evaluate(() => (window as any).lifecycleFixture.reads);
  await child.evaluate(() => { const f = (window as any).lifecycleFixture; f.offline = true; f.connection(false); });
  await expect(child.getByRole('alert')).toHaveCount(0); await expect(editor).toContainText('unsaved independent draft');
  await child.evaluate(() => { (window as any).lifecycleFixture.offline = false; });
  await expect(child.locator('[data-preview-connected]')).toHaveAttribute('data-preview-connected', 'true');
  await expect(editor).toContainText('unsaved independent draft');
  expect(await child.evaluate(() => (window as any).lifecycleFixture.reads)).toBe(before);
  expect(await child.evaluate(() => (window as any).lifecycleFixture.writes)).toBe(0);
});
test('workspace revision changes reject reloading and keep last known content', async ({ page, context }) => {
  const child = await open(page, context); await child.evaluate(() => { (window as any).lifecycleFixture.revision = 'b'.repeat(64); });
  await reloadFile(child); await expect(child.getByRole('alert')).toContainText('stale_workspace');
  await expect(child.locator('[data-excel-grid]')).toBeVisible();
});
test('unknown save only reconciles original request after source unmount', async ({ page, context }) => {
  const child = await open(page, context, 'text'); await edit(child);
  await child.evaluate(() => { (window as any).lifecycleFixture.unknownSave = true; });
  await child.getByRole('button', { name: '💾 保存', exact: true }).click();
  await expect(child.getByRole('button', { name: '核对保存', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).lifecycleFixture.unmount());
  await child.getByRole('button', { name: '核对保存', exact: true }).click();
  const calls = await child.evaluate(() => (window as any).lifecycleFixture.calls);
  const save = calls.filter((c: any) => c.method === 'save'); expect(save).toHaveLength(1);
  expect(calls.find((c: any) => c.method === 'saveGet').args[0]).toBe(save[0].args[0].requestId);
  await child.getByLabel('关闭预览', { exact: true }).click();
  await expect(child.locator('.cm-content')).toContainText('unsaved independent draft');
  expect(child.isClosed()).toBe(false);
});
test('cross window identity epoch change hides loaded content and late legacy hints cannot restore it', async ({ page, context }) => {
  const child = await open(page, context, 'text'); await edit(child);
  await page.evaluate(() => localStorage.setItem('awu.preview-identity-epoch-v1', 'revoked-fixture'));
  await expect(child.getByRole('alert')).toContainText('身份');
  await expect(child.locator('[data-preview-reading]')).toHaveCount(0);
  await expect(child.locator('.cm-content')).toHaveCount(0);
  expect(await child.title()).not.toContain('note.txt');
  await child.evaluate(() => { const id = new URL(location.href).searchParams.get('filePreview'); const c = new BroadcastChannel(`awu-file-preview-${id}`); c.postMessage({ kind: 'snapshot', snapshot: { preview: { text: 'LEAK' } } }); c.close(); });
  await expect(child.getByText('LEAK')).toHaveCount(0);
});
test('optional navigation missing source gives notice without clearing file', async ({ page, context }) => {
  const child = await open(page, context); await page.close();
  await child.getByRole('button', { name: '📂 定位', exact: true }).click();
  await expect(child.getByRole('alert')).toContainText('没有可用的原工作台');
  await expect(child.locator('[data-excel-grid]')).toBeVisible();
});
test('unknown new protocol ID never falls back to legacy or current Session', async ({ page, context }) => {
  await setup(context); await page.clock.install(); await page.goto('/?filePreview=unknown&previewVersion=2');
  await expect(page.getByText('正在核验并读取文件来源…')).toBeVisible(); await page.clock.fastForward(12500);
  await expect(page.getByRole('alert')).toContainText('没有可核验');
  expect(await page.evaluate(() => (window as any).lifecycleFixture.calls)).toEqual([]);
});
test('remote offline keeps loaded grid; explicit reconnect does not reparse', async ({ page, context }) => {
  const child = await open(page, context); const grid = child.locator('[data-excel-grid]');
  await child.evaluate(() => { const f = (window as any).lifecycleFixture; f.offline = true; f.connection(false); });
  await expect(child.getByRole('alert')).toContainText('离线'); await expect(grid).toBeVisible();
  const count = await child.evaluate(() => (window as any).lifecycleFixture.calls.filter((c: any) => c.method === 'parse').length);
  await child.evaluate(() => { (window as any).lifecycleFixture.offline = false; });
  await child.getByText('重新连接 / 核对来源', { exact: true }).click();
  await expect(child.locator('[data-preview-connected]')).toHaveAttribute('data-preview-connected', 'true');
  expect(await child.evaluate(() => (window as any).lifecycleFixture.calls.filter((c: any) => c.method === 'parse').length)).toBe(count);
});
test('source page closes but detached refresh uses independent source', async ({ page, context }) => {
  const child = await open(page, context); await page.close();
  await expect(child.locator('[data-excel-grid]')).toBeVisible();
  await child.reload(); await expect(child.locator('[data-excel-grid]')).toBeVisible();
  await expect(child.locator('[role=alert]')).toHaveCount(0);
});

test('local copy actual versioned save and dirty refresh recovery stay on original binding', async ({ page, context }) => {
  const child = await open(page, context, 'text'); await page.close(); const editor = await edit(child);
  await child.getByRole('button', { name: '💾 保存', exact: true }).click();
  await expect(child.getByText('已保存到原文件。', { exact: true })).toBeVisible();
  const disk = await child.evaluate(async () => {
    const { ManagedBrowserLocalFs } = await import('/src/utils/dirSync.ts'); return atob(await new ManagedBrowserLocalFs('preview-fixture').readFile('note.txt'));
  }); expect(disk).toBe('unsaved independent draft');
  await editor.fill('draft kept across reload');
  await expect(child.getByText(/草稿已存本设备/)).toBeVisible();
  child.once('dialog', dialog => dialog.accept()); await child.reload();
  await child.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  await expect(child.locator('.cm-content')).toContainText('draft kept across reload');
  expect(await child.evaluate(() => (window as any).lifecycleFixture.writes)).toBe(0);
});
test('binding recovery distinguishes managed and browser same-name directories with no fallback', async ({ page, context }) => {
  await setup(context); await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ManagedBrowserLocalFs, BrowserLocalFs } = await import('/src/utils/dirSync.ts');
    const { capturePreviewBinding, restorePreviewBinding } = await import('/src/utils/previewLocalBinding.ts');
    const first = new ManagedBrowserLocalFs('first'), second = new ManagedBrowserLocalFs('second');
    await first.writeFile('same.txt', btoa('original')); await second.writeFile('same.txt', btoa('replacement'));
    const binding = await capturePreviewBinding(first), restored = await restorePreviewBinding(binding);
    const managed = atob(await restored.readFile('same.txt'));
    let wrong = false; try { await restorePreviewBinding({ ...binding, root: 'second' }); } catch { wrong = true; }
    const root = await navigator.storage.getDirectory();
    const a = await (await root.getDirectoryHandle('a', { create: true })).getDirectoryHandle('same', { create: true });
    const b = await (await root.getDirectoryHandle('b', { create: true })).getDirectoryHandle('same', { create: true });
    const ba = await capturePreviewBinding(new BrowserLocalFs(a)), bb = await capturePreviewBinding(new BrowserLocalFs(b));
    const recovered = await restorePreviewBinding(ba);
    let missing = false; try { await restorePreviewBinding({ ...ba, id: 'browser:missing' }); } catch { missing = true; }
    const proto = Object.getPrototypeOf(a), inherited = proto.queryPermission;
    proto.queryPermission = async () => 'prompt'; let prompt = false;
    try { await restorePreviewBinding(ba); } catch (error) { prompt = String(error).includes('local_permission_required'); }
    finally { proto.queryPermission = inherited; }
    return { managed, wrong, distinct: ba.id !== bb.id, recovered: (await recovered.documentAdapter!()).bindingId === ba.id, missing, prompt };
  });
  expect(result).toEqual({ managed: 'original', wrong: true, distinct: true, recovered: true, missing: true, prompt: true });
});
test('Tauri binding adapter verifies exact native binding response (mock IPC only)', async ({ page, context }) => {
  await setup(context); await page.goto('/');
  const result = await page.evaluate(async () => {
    const { restorePreviewBinding } = await import('/src/utils/previewLocalBinding.ts');
    const calls: any[] = [];
    (window as any).__TAURI_INTERNALS__ = { invoke: async (method: string, args: any) => {
      calls.push({ method, args }); return { bindingId: args.dir === 'C:/original' ? 'tauri:original' : 'tauri:replacement', canonicalRoot: args.dir };
    } };
    const fs = await restorePreviewBinding({ kind: 'tauri', id: 'tauri:original', root: 'C:/original' });
    let mismatch = false; try { await restorePreviewBinding({ kind: 'tauri', id: 'tauri:original', root: 'C:/replacement' }); } catch { mismatch = true; }
    delete (window as any).__TAURI_INTERNALS__; return { root: fs.label(), mismatch, calls: calls.map(x => x.method) };
  });
  expect(result).toEqual({ root: 'C:/original', mismatch: true, calls: ['local_document_bind', 'local_document_bind'] });
});
test('late source read cannot cross workspace revision and missing node does not fallback', async ({ page, context }) => {
  const child = await open(page, context);
  const result = await child.evaluate(async () => {
    const { PreviewAccess } = await import('/src/utils/previewAccess.ts');
    const api = (window as any).lifecycleFixture.api;
    const source = JSON.parse(localStorage.getItem('awu.file-previews.v2')!)[0].source;
    const access = new PreviewAccess(source); await access.connect();
    const original = api.syncReadChunk; api.syncReadChunk = async (...args: any[]) => { const result = await original(...args); (window as any).lifecycleFixture.revision = 'c'.repeat(64); return result; };
    let late = false; try { await access.readFile('file.txt'); } catch { late = true; }
    const phase = access.life.phase; access.dispose(); api.syncReadChunk = original;
    const calls = (window as any).lifecycleFixture.calls.length;
    const missing = new PreviewAccess({ ...source, id: 'missing', executor: 'unknown-node' }); let failed = false;
    try { await missing.connect(); } catch { failed = true; } missing.dispose();
    return { late, phase, failed, extra: (window as any).lifecycleFixture.calls.length - calls };
  });
  expect(result).toEqual({ late: true, phase: 'invalidated', failed: true, extra: 0 });
});
test('same user in different Relay realm is revoked and prior draft repository is isolated', async ({ page, context }) => {
  const child = await open(page, context, 'text', true); await edit(child);
  await expect(child.getByText(/草稿已存本设备/)).toBeVisible();
  await page.evaluate(async () => {
    const a = await import('/src/api.ts'); const target = a.getConnectionTarget(); if (target.mode === 'relay') await a.setConnectionTarget({ ...target, url: 'ws://127.0.0.1:55191/different-realm' });
  });
  await expect(child.locator('[data-preview-reading]')).toHaveCount(0);
  const count = await child.evaluate(async () => {
    const { IndexedDraftRepository } = await import('/src/utils/documentDrafts.ts'); return (await new IndexedDraftRepository().listOwner('fixture-user')).length;
  }); expect(count).toBe(0);
});
test('closing independent window cleans registration without closing original panel', async ({ page, context }) => {
  await context.addInitScript(() => {
    const Channel = BroadcastChannel; (window as any).previewChannelCount = 0;
    window.BroadcastChannel = class extends Channel {
      private disposed = false;
      constructor(name: string) { super(name); if (name.startsWith('awu-file-preview-')) (window as any).previewChannelCount++; }
      close() { if (!this.disposed && this.name.startsWith('awu-file-preview-')) (window as any).previewChannelCount--; this.disposed = true; super.close(); }
    };
  });
  const child = await open(page, context); const id = new URL(child.url()).searchParams.get('filePreview');
  expect(await page.evaluate(() => (window as any).previewChannelCount)).toBe(1);
  const closed = child.waitForEvent('close'); await child.getByLabel('关闭预览', { exact: true }).click(); await closed;
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('awu.file-previews.v2') || '[]').some((x: any) => x.source.id === id), id)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).previewChannelCount)).toBe(0);
  await expect(page.locator('[data-excel-grid]')).toBeVisible();
});
test('source Session and Chat Engine navigation does not retarget detached reads', async ({ page, context }) => {
  const child = await open(page, context);
  await page.getByLabel('关闭预览', { exact: true }).click();
  await page.evaluate(() => (window as any).lifecycleFixture.switchView('another-session', '/another-root', true));
  await reloadFile(child); await expect(child.locator('[data-excel-grid]')).toBeVisible();
  const targets = await child.evaluate(() => (window as any).lifecycleFixture.calls.filter((c: any) => c.method === 'documents').map((c: any) => c.args));
  expect(targets.every((x: any[]) => x[0] === 'preview-fixture' && x[1] === 'local' && x[2] === '/fixture')).toBe(true);
});
test('created window with inaccessible source reports initialization failure and remains closable', async ({ page, context }) => {
  await setup(context); await page.goto('/?fixture=excel'); await page.locator('.ftp-row').first().dblclick();
  await page.evaluate(() => localStorage.setItem('fixture-fail-child', '1'));
  const popup = context.waitForEvent('page'); await page.getByRole('button', { name: /独立窗口/ }).click(); const child = await popup;
  await expect(child.getByRole('alert')).toContainText('offline');
  await expect(child.getByRole('alert')).toContainText('固定来源：local · /fixture/book.xlsx');
  await expect(child.locator('[data-preview-reading]')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('初始化失败');
  const closed = child.waitForEvent('close'); await child.getByLabel('关闭预览', { exact: true }).click(); await closed;
});
test('blocked popup does not register abandoned file source', async ({ page, context }) => {
  await setup(context); await page.goto('/?fixture=excel'); await page.locator('.ftp-row').first().dblclick();
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole('button', { name: /独立窗口/ }).click();
  await expect(page.getByRole('alert')).toContainText('阻止');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('awu.file-previews.v2') || '[]').length)).toBe(0);
  await expect(page.locator('[data-excel-grid]')).toBeVisible();
});
test('source exits during handoff reports bounded missing initialization without inventing content', async ({ page, context }) => {
  await setup(context); await page.goto('/?fixture=excel'); await page.locator('.ftp-row').first().dblclick();
  await page.evaluate(() => { (window as any).lifecycleFixture.api.workspaceDocuments = () => new Promise(() => {}); });
  const popup = context.waitForEvent('page'); await page.getByRole('button', { name: /独立窗口/ }).click(); const child = await popup;
  await expect(child.getByText('正在核验并读取文件来源…')).toBeVisible(); await page.close();
  await expect(child.getByRole('alert')).toContainText('没有可核验', { timeout: 16000 });
  await expect(child.locator('[data-preview-reading]')).toHaveCount(0);
  expect(await child.evaluate(() => (window as any).lifecycleFixture.calls)).toEqual([]);
});
test('offline refresh has no invented cached body and explicit retry loads original file', async ({ page, context }) => {
  const child = await open(page, context); await page.close();
  await child.evaluate(() => localStorage.setItem('fixture-fail-child', '1')); await child.reload();
  await expect(child.getByRole('alert')).toContainText('固定来源：local · /fixture/book.xlsx');
  await expect(child.locator('[data-preview-reading]')).toHaveCount(0);
  await child.evaluate(() => { (window as any).lifecycleFixture.offline = false; });
  await child.getByText('重新连接 / 核对来源', { exact: true }).click(); await expect(child.locator('[data-excel-grid]')).toBeVisible();
});
test('available original UI reveal uses only frozen executor and path', async ({ page, context }) => {
  const child = await open(page, context);
  await child.getByRole('button', { name: '📂 定位', exact: true }).click(); await expect(child.getByRole('status').filter({ hasText: '已在原文件窗口定位' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).lifecycleFixture.calls.filter((c: any) => c.method === 'reveal')))
    .toEqual([{ method: 'reveal', args: ['/fixture', 'book.xlsx', 'local'] }]);
});
test('unavailable managed reveal preserves draft and dirty reload remains guarded', async ({ page, context }) => {
  const child = await open(page, context, 'text');
  await child.getByRole('button', { name: '📂 定位', exact: true }).click(); await expect(child.getByRole('alert')).toContainText('浏览器管理');
  await edit(child); const reads = await child.evaluate(() => (window as any).lifecycleFixture.reads);
  await reloadFile(child); await expect(child.locator('.cm-content')).toContainText('unsaved independent draft');
  expect(await child.evaluate(() => (window as any).lifecycleFixture.reads)).toBe(reads);
  await child.getByLabel('关闭预览', { exact: true }).click(); expect(child.isClosed()).toBe(false);
  await child.getByLabel('文件与草稿操作', { exact: true }).click(); child.once('dialog', dialog => dialog.accept());
  await child.getByText('重新读取 / 放弃草稿', { exact: true }).click();
  await expect(child.locator('.cm-content')).toContainText('Independent original text');
  const closed = child.waitForEvent('close'); await child.getByLabel('关闭预览', { exact: true }).click(); await closed;
  expect(page.isClosed()).toBe(false);
});
test('actual API preview save path never registers or reclaims Session ownership', async ({ page, context }) => {
  const calls: any[] = [];
  const sockets: { close: () => void }[] = [];
  const workspace = { ownerId: 'local', executorInstance: 'fixture-native-api', sessionId: 'fixture-session', workingDir: '/fixture', workspaceRevision: 'd'.repeat(64) };
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><div id="root"></div></html>' });
    return route.continue();
  });
  await context.routeWebSocket(/.*/, ws => { sockets.push(ws); ws.onMessage(message => {
    const input = JSON.parse(String(message)); calls.push(input);
    let result: any = {};
    if (input.method === 'sessionWorkbenchCapabilities') result = { status: 'ok', protocolVersion: 1, identity: workspace,
      capabilities: { documents: 1, windowHandoff: 1, viewMode: 1, languageServices: 0, terminal: 0 } };
    if (input.method === 'workbenchWindow') result = { status: 'ok', workspace, windowId: 'original-workbench', frozen: false };
    if (input.method === 'workspaceDocumentSave') {
      const request = JSON.parse(input.params[2]); result = { status: 'failed', workspace, relativePath: request.relativePath,
        requestId: request.requestId, bufferRevision: request.bufferRevision, reasonCode: 'window_lease_required' };
    }
    ws.send(JSON.stringify({ id: input.id, result: JSON.stringify(result) }));
  }); });
  await page.goto('/?filePreview=api-test&previewVersion=2');
  const result = await page.evaluate(async () => {
    const { api, getPreviewIdentity } = await import('/src/api.ts');
    const { PreviewAccess } = await import('/src/utils/previewAccess.ts');
    const { loadWindowNavigation, windowTransport } = await import('/src/utils/workbenchWindows.ts');
    windowTransport.activate(loadWindowNavigation('local', localStorage, sessionStorage, 'preview-api-test'));
    const allowed = await api.previewDocumentWriteAllowed('fixture-session', 'local', '/fixture', () => true);
    const client = await api.workspaceDocuments('fixture-session', 'local', '/fixture');
    const access = new PreviewAccess({ version: 2, id: 'api-test', identity: getPreviewIdentity(), executor: 'local', executorRealm: 'local',
      session: 'fixture-session', workingDir: '/fixture', workspace: client.identity, relative: 'note.txt', source: 'remote', readonly: false });
    await access.connect(); (window as any).transportAccess = access;
    const receipt = await client.save({ requestId: 'save-fixture', relativePath: 'note.txt', baseVersion: { exists: false }, bufferRevision: 1, controlRevision: 0, text: 'draft' });
    return { allowed, status: receipt.status };
  });
  expect(result).toEqual({ allowed: false, status: 'failed' });
  expect(calls.filter(x => x.method === 'workbenchWindow').every(x => JSON.parse(x.params[2]).action === 'get')).toBe(true);
  expect(calls.some(x => x.method === 'sendMessage' || x.method === 'executeCommand')).toBe(false);
  expect(calls.find(x => x.method === 'workspaceDocumentSave').workbench.windowId).toBe('preview-api-test');
  expect(calls.find(x => x.method === 'workspaceDocumentSave').workbench.lease).toBeUndefined();
  sockets.forEach(socket => socket.close());
  await expect.poll(() => page.evaluate(() => (window as any).transportAccess.life.phase)).toBe('offline');
  await page.evaluate(() => (window as any).transportAccess.dispose());
});
test('narrow offline error leaves 44px close target reachable', async ({ page, context }, info) => {
  const child = await open(page, context); await child.setViewportSize({ width: 320, height: 360 });
  await child.evaluate(() => { const f = (window as any).lifecycleFixture; f.offline = true; f.connection(false); });
  await expect(child.getByRole('alert')).toContainText('离线');
  const button = child.getByLabel('关闭预览', { exact: true }), rect = (await button.boundingBox())!;
  expect(rect.width).toBeGreaterThanOrEqual(44); expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(rect.x + rect.width).toBeLessThanOrEqual(320); expect(rect.y + rect.height).toBeLessThanOrEqual(360);
  await child.screenshot({ path: info.outputPath('offline-close.png') });
  const closed = child.waitForEvent('close'); await button.click(); await closed;
});
test('unconfirmed read timeout retains concurrency reservation and late response cannot resume closed source', async ({ page, context }) => {
  const child = await open(page, context); await child.clock.install();
  await child.evaluate(async () => {
    const { PreviewAccess } = await import('/src/utils/previewAccess.ts');
    const source = JSON.parse(localStorage.getItem('awu.file-previews.v2')!)[0].source;
    const access = new PreviewAccess(source); await access.connect();
    const fixture = (window as any).lifecycleFixture;
    const original = fixture.api.workspaceDocuments; let count = 0;
    const waiters: (() => void)[] = [];
    fixture.api.workspaceDocuments = async (...args: any[]) => { count++; await new Promise<void>(resolve => waiters.push(resolve)); return original(...args); };
    const pending = Array.from({ length: 8 }, () => access.readFile('note.txt').then(() => 'unexpected', () => 'rejected'));
    (window as any).bounded = { access, pending, waiters, count: () => count, original };
  });
  await child.clock.fastForward(31000);
  const blocked = await child.evaluate(async () => {
    const b = (window as any).bounded;
    let denied = false; try { await b.access.connect(); } catch { denied = true; }
    const count = b.count(); b.access.dispose(); b.waiters.forEach((resolve: () => void) => resolve());
    (window as any).lifecycleFixture.api.workspaceDocuments = b.original;
    return { denied, count, results: await Promise.all(b.pending), phase: b.access.life.phase };
  });
  expect(blocked).toEqual({ denied: true, count: 8, results: Array(8).fill('rejected'), phase: 'closed' });
});
