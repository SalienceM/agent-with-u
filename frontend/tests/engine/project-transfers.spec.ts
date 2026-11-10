import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, width = 1280, mode: 'project' | 'return' = 'project') {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<button id="trigger">项目交接</button><div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async ({ mode, width }) => {
    const { React, createRoot } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const { ProjectTransferDialog } = await import('/src/components/ProjectTransferDialog.tsx');
    const { api } = await import('/src/api.ts');
    document.body.style.margin = '0'; document.body.style.fontFamily = 'system-ui, sans-serif';
    document.body.style.background = '#191b20';
    Object.entries({ '--theme-panel-solid': '#22252d', '--theme-bg': '#191b20', '--theme-bg-secondary': '#22252d', '--theme-text': '#e6ebf3', '--theme-text-muted': '#a8b2c4', '--theme-border': '#465063', '--theme-accent': '#5284dc' }).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    if (width === 390) Object.entries({ '--theme-panel-solid': '#fff', '--theme-bg': '#fff', '--theme-bg-secondary': '#f6f8fa', '--theme-text': '#1f2328', '--theme-text-muted': '#656d76', '--theme-border': '#d0d7de' }).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    const f = { writes: [] as any[], reads: [] as any[], opened: [] as any[], identity: 'user1', failChunk: false, loseFinish: false, noGit: false, hold: false, release: () => {}, row: null as any, render: () => {}, close: () => {} };
    api.projectTransferIdentity = () => f.identity;
    api.projectTransferExecutors = () => [{ key: 'local', label: '环境 A', connected: true, mode: 'local', isHome: true },
      { key: 'relay:B', label: '离线开发环境 B', connected: true, mode: 'relay', isHome: false }, { key: 'relay:C', label: '环境 C', connected: false, mode: 'relay', isHome: false }];
    api.projectTransferCapabilities = async (executor, session) => { f.reads.push(['caps', executor, session]); return { version: 1, executorId: executor === 'local' ? 'A' : 'B', git: !f.noGit, origin: mode === 'return' ? { executorId: 'B', sessionId: 'original', transferId: 'origin' } : null }; };
    api.getBackends = async () => [{ id: 'b-api', label: 'B Backend', enabled: true }];
    const descriptor = { version: 1, id: 'export-1', mode, sourceExecutor: 'A', sourceSessionId: 'main', sourceTitle: '项目 A', targetExecutor: 'B', origin: null, size: 6, bytes: 100, files: 2, sha256: 'a'.repeat(64) };
    api.projectTransferExport = async (...args) => { f.reads.push(['export', ...args]); return { id: 'export-1', direction: 'export', status: 'exported', descriptor } as any; };
    api.projectTransferPlan = async (...args) => { f.reads.push(['plan', ...args]); f.row = { id: 'node-1', direction: 'receive', status: 'preview', descriptor, title: args[3], backendId: args[4], planFingerprint: 'frozen', root: 'B:/auto/project', offset: 0, sessionId: 'node-1' }; return structuredClone(f.row); };
    api.projectTransferAccept = async (...args) => { f.writes.push(['accept', ...args]); f.row.status = 'receiving'; return structuredClone(f.row); };
    api.projectTransferRead = async (_executor, _id, offset) => {
      if (f.hold) await new Promise<void>(resolve => { f.release = resolve; });
      return { offset, nextOffset: offset + 3, data: btoa('abc') };
    };
    api.projectTransferChunk = async (...args) => { f.writes.push(['chunk', ...args]); if (f.failChunk) throw Error('connection lost'); f.row.offset = args[3] + 3; return { offset: f.row.offset }; };
    api.projectTransferFinish = async (...args) => { f.writes.push(['finish', ...args]); f.row.status = 'succeeded'; f.row.receipt = { status: 'succeeded' }; f.row.actual = { verifiedFiles: 2, verifiedBytes: 100, head: 'commit' }; if (f.loseFinish) throw Error('response lost'); return structuredClone(f.row); };
    api.projectTransferStatus = async (...args) => { f.reads.push(['status', ...args]); return structuredClone(f.row); };
    api.projectTransferList = async () => ({ items: [] });
    api.collaborationOpenSession = async (...args) => { f.opened.push(args); };
    const root = createRoot(document.getElementById('root')!);
    f.close = () => root.render(null);
    f.render = () => root.render(React.createElement(ProjectTransferDialog, { session: { id: 'main', title: '项目 A', execKey: 'local', backendId: 'a' }, mode, focusTarget: document.getElementById('trigger'), onClose: f.close, onOpenSession: id => f.opened.push(['select', id]) }));
    document.getElementById('trigger')!.onclick = f.render;
    (window as any).transferFixture = f; f.render();
  }, { mode, width });
}

async function preview(page: Page) {
  await page.getByLabel('目标节点', { exact: true }).selectOption('relay:B');
  await expect(page.getByLabel('Backend', { exact: true })).toHaveValue('b-api');
  await page.getByRole('button', { name: '预览交接', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认传输并创建' })).toBeVisible();
}

for (const width of [1280, 390]) test(`frozen transfer confirmation and compact keyboard UI ${width}`, async ({ page }, info) => {
  await mount(page, width); await preview(page);
  expect(await page.evaluate(() => (window as any).transferFixture.writes)).toEqual([]);
  await expect(page.getByRole('dialog')).toContainText('离线开发环境 B');
  await expect(page.getByRole('dialog')).toContainText('2 个文件');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('transfer-confirmation.png'), fullPage: true });
  await page.getByRole('button', { name: '确认传输并创建' }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '关闭发送项目到节点' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#trigger')).toBeFocused(); await page.locator('#trigger').click();
  await page.getByRole('button', { name: '确认传输并创建' }).click();
  await expect(page.getByRole('button', { name: '打开目标项目' })).toBeVisible();
  await page.getByRole('button', { name: '打开目标项目' }).click();
  expect(await page.evaluate(() => (window as any).transferFixture.opened)).toEqual([['node-1', 'relay:B'], ['select', 'node-1']]);
  expect(await page.evaluate(() => (window as any).transferFixture.writes.map((row: any[]) => row[0]))).toEqual(['accept', 'chunk', 'chunk', 'finish']);
});

test('lost finish reply uses original receipt without repeating writes', async ({ page }) => {
  await mount(page); await preview(page);
  await page.evaluate(() => { (window as any).transferFixture.loseFinish = true; });
  await page.getByRole('button', { name: '确认传输并创建' }).click();
  await expect(page.getByRole('button', { name: '打开目标项目' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).transferFixture.writes.map((row: any[]) => row[0]))).toEqual(['accept', 'chunk', 'chunk', 'finish']);
  expect(await page.evaluate(() => (window as any).transferFixture.reads.filter((row: any[]) => row[0] === 'status').length)).toBe(1);
});

test('interrupted chunks remain unknown across close and only recheck', async ({ page }) => {
  await mount(page); await preview(page);
  await page.evaluate(() => { (window as any).transferFixture.failChunk = true; });
  await page.getByRole('button', { name: '确认传输并创建' }).click();
  await expect(page.getByRole('button', { name: '核对原请求' })).toBeVisible();
  await page.keyboard.press('Escape'); await page.locator('#trigger').click();
  await page.getByRole('button', { name: '核对原请求' }).click();
  await expect(page.getByRole('button', { name: '确认传输并创建' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).transferFixture.writes.map((row: any[]) => row[0]))).toEqual(['accept', 'chunk']);
});

test('close does not cancel accepted transfer; identity changes stop later writes', async ({ page }) => {
  await mount(page); await preview(page);
  await page.evaluate(() => { (window as any).transferFixture.hold = true; });
  await page.getByRole('button', { name: '确认传输并创建' }).click();
  await expect(page.getByRole('progressbar')).toBeVisible(); await page.keyboard.press('Escape');
  await page.evaluate(() => { const f = (window as any).transferFixture; f.identity = 'user2'; f.release(); });
  await expect.poll(() => page.evaluate(() => (window as any).transferFixture.writes.length)).toBe(1);
  await page.locator('#trigger').click();
  await expect(page.getByRole('button', { name: '预览交接' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).transferFixture.reads.filter((row: any[]) => row[0] === 'status').length)).toBe(0);
});

test('return action names review branch and Git prerequisite blocks preview', async ({ page }) => {
  await mount(page, 390, 'return'); await preview(page);
  await expect(page.getByRole('dialog')).toContainText('合并需另行确认');
  await page.getByRole('button', { name: '确认传输并创建' }).click();
  await expect(page.getByRole('button', { name: '打开待合并分支' })).toBeVisible();
  await page.getByRole('button', { name: '新的交接' }).click();
  await page.evaluate(() => { (window as any).transferFixture.noGit = true; });
  await page.getByLabel('目标节点', { exact: true }).selectOption('');
  await page.getByLabel('目标节点', { exact: true }).selectOption('relay:B');
  await expect(page.getByRole('alert')).toContainText('未安装本地 Git');
  await expect(page.getByRole('button', { name: '预览交接' })).toBeDisabled();
});

test('explicit recovery finds the persisted receiver without creating again', async ({ page }) => {
  await mount(page); await preview(page);
  await page.getByRole('button', { name: '确认传输并创建' }).click();
  await expect(page.getByRole('button', { name: '打开目标项目' })).toBeVisible();
  await page.getByRole('button', { name: '新的交接' }).click();
  await page.evaluate(async () => {
    const { api } = await import('/src/api.ts'); const f = (window as any).transferFixture;
    api.projectTransferList = async () => ({ items: [{ id: 'export-1', status: 'exported' }] });
    api.projectTransferStatus = async () => ({ id: 'export-1', direction: 'export', descriptor: f.row.descriptor }) as any;
    api.projectTransferFind = async () => structuredClone(f.row);
  });
  await page.getByRole('button', { name: '核对最近交接' }).click();
  await expect(page.getByRole('button', { name: '打开目标项目' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).transferFixture.writes.length)).toBe(4);
});

test('repeated explicit receipt checks share one in-flight read', async ({ page }) => {
  await mount(page); await preview(page);
  await page.evaluate(() => { (window as any).transferFixture.failChunk = true; });
  await page.getByRole('button', { name: '确认传输并创建' }).click();
  await expect(page.getByRole('button', { name: '核对原请求' })).toBeVisible();
  await page.evaluate(async () => {
    const { api } = await import('/src/api.ts');
    const f = (window as any).transferFixture; f.checks = 0;
    api.projectTransferStatus = async () => { f.checks++; await new Promise<void>(resolve => { f.release = resolve; }); return structuredClone(f.row); };
  });
  await page.getByRole('button', { name: '核对原请求' }).click();
  await page.getByRole('button', { name: '核对原请求' }).click();
  expect(await page.evaluate(() => (window as any).transferFixture.checks)).toBe(1);
  await page.evaluate(() => { (window as any).transferFixture.release(); });
  expect(await page.evaluate(() => (window as any).transferFixture.writes.length)).toBe(2);
});
