import { test, expect, type Page } from '@playwright/test';

test.use({ hasTouch: true });

// 专用 Chromium 临时 profile + 合成执行端；本机仅写这个 profile 的 IndexedDB/OPFS。
async function mount(page: Page, width = 1366) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden;--theme-bg:#151922;--theme-bg-secondary:#202632;--theme-bg-tertiary:#303c50;--theme-text:#e1e6ef;--theme-text-secondary:#a5b0bf;--theme-border:#384252;color:#e1e6ef;background:#151922}button:focus-visible{outline:2px solid #75b6ff}button:disabled{opacity:.45}</style><div id="root" style="height:100vh;width:300px"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/tests/engine/react-harness.ts');
    const { FileTreePanel } = await import('/src/components/FileTreePanel.tsx');
    const { FileTransferCenter } = await import('/src/components/FileTransferCenter.tsx');
    const { api, getCurrentUserProfile } = await import('/src/api.ts');
    const { RemoteSyncReview } = await import('/src/utils/syncReviewProtocol.ts');
    const { byteHash } = await import('/src/utils/documentCodec.ts');
    const { useManagedLocalDir } = await import('/src/utils/dirSync.ts');
    const fs = await useManagedLocalDir('review-fixture');
    const long = Array.from({ length: 1100 }, (_, i) => `line ${i}`).join('\n');
    const files: Record<string, string> = { 'src/a.ts': long.replace('line 20\n', '<img src=x onerror=alert(1)>\n').replace('line 900\n', 'second hunk\n'), 'src/b.ts': 'remote b',
      'visual.txt': '\n' + 'y'.repeat(180) + '\n', 'budget.txt': Array.from({ length: 1500 }, (_, i) => 'remote-' + i).join('\n'),
      'remote-empty.txt': '', 'format.txt': 'same\n', 'binary.txt': '\0remote', 'large.txt': 'r'.repeat(2 * 1024 * 1024 + 1), 'src2/outside': 'outside' };
    for (const [path, text] of Object.entries({ 'src/a.ts': long, 'src/b.ts': 'local b', 'local-empty.txt': '', 'format.txt': '\uFEFFsame\r\n',
      'binary.txt': 'local', 'large.txt': 'local', 'visual.txt': '\n' + 'x'.repeat(220) + '\n',
      'budget.txt': Array.from({ length: 1500 }, (_, i) => 'local-' + i).join('\n') })) await fs.writeBlob!(path, new Blob([text]));
    const workspace = { ownerId: getCurrentUserProfile().userId, executorInstance: 'fixture-executor', sessionId: 'review-fixture', workingDir: '/fixture-only', workspaceRevision: 'a'.repeat(64) };
    const calls: { method: string; path?: string }[] = [], writes: string[] = [], receipts = new Map();
    const scan = fs.scan.bind(fs);
    fs.scan = async (...args) => { calls.push({ method: 'local-scan' }); return scan(...args); };
    const versions: Record<string, number> = {};
    const version = (path: string) => path in files ? { exists: true, sha256: byteHash(new TextEncoder().encode(files[path])),
      byteLength: new TextEncoder().encode(files[path]).length, fileId: path, modifiedNs: String(versions[path] || 1), changedNs: String(versions[path] || 1) } : { exists: false };
    const fixture = { fs, files, calls, writes, receipts, unknown: false, old: false, offline: false, delay: '', release: null as null | (() => void) };
    (window as any).reviewFixture = fixture;
    api.onSessionConnectionStatus = (_s: string, cb: (online: boolean) => void) => { cb(true); return () => {}; };
    api.gitDetect = async () => ({ isRepo: false });
    api.listDirectory = async (path: string) => {
      calls.push({ method: 'directory', path });
      const prefix = path ? path + '/' : '';
      const names = new Map();
      for (const name of Object.keys(files).filter(n => n.startsWith(prefix))) {
        const rest = name.slice(prefix.length), first = rest.split('/')[0];
        names.set(first, { name: first, path: prefix + first, isDir: rest.includes('/') });
      }
      return [...names.values()];
    };
    api.searchFiles = async (_dir: string, query: string) => {
      calls.push({ method: 'search', path: query });
      return { status: 'ok', matched: 2, results: Object.keys(files).filter(path => path.includes(query)).map(path => ({ path, name: path.split('/').pop(), size: files[path].length })) };
    };
    api.syncManifest = async () => { calls.push({ method: 'manifest' }); return { status: 'ok', files: Object.fromEntries(Object.keys(files).map(path => [path, { hash: version(path).sha256, size: version(path).byteLength }])) }; };
    api.syncReadFile = async (_dir: string, path: string) => { calls.push({ method: 'ordinary-preview', path }); return { status: 'ok', data: btoa(files[path] || '') }; };
    api.syncReview = async (session: string, executor: string, workingDir: string, current: () => boolean) => RemoteSyncReview.connect({ session, executor, workingDir, user: workspace.ownerId }, async (_e, method, params) => {
      const path = String(params[2] || ''); calls.push({ method, path });
      if (fixture.offline) throw new Error('offline');
      if (method === 'syncReviewCapabilities') return fixture.old ? null : { status: 'ok', protocolVersion: 1, workspace, read: true, apply: true, controlRevision: 0, maxBytes: 2 * 1024 * 1024 };
      if (method === 'syncReviewRead' || method === 'syncReviewCheck') {
        if (method === 'syncReviewRead' && fixture.delay === path) await new Promise<void>(resolve => { fixture.release = resolve; });
        if (!(path in files)) return { status: 'ok', workspace, relativePath: path, kind: 'missing', version: { exists: false } };
        const v = version(path), reasonCode = files[path].includes('\0') ? 'binary' : v.byteLength! > 2 * 1024 * 1024 ? 'too_large' : '';
        return { status: 'ok', workspace, relativePath: path, kind: reasonCode === 'too_large' ? 'unavailable' : 'file', version: v, reasonCode,
          ...(method === 'syncReviewRead' && !reasonCode ? { data: btoa(files[path]) } : {}) };
      }
      if (method === 'syncReviewApply') {
        const request = JSON.parse(path);
        const prior = receipts.get(request.requestId); if (prior) return prior;
        writes.push(request.relativePath);
        const result = { status: fixture.unknown ? 'unresolved' : JSON.stringify(version(request.relativePath)) === JSON.stringify(request.baseVersion) ? 'succeeded' : 'failed',
          requestId: request.requestId, workspace, relativePath: request.relativePath, scopeKey: request.scopeKey, direction: 'push', sourceHash: request.sourceHash };
        if (result.status === 'succeeded') { files[request.relativePath] = atob(request.data); versions[request.relativePath] = (versions[request.relativePath] || 1) + 1; }
        const receipt = { ...result, version: version(request.relativePath), reasonCode: result.status === 'failed' ? 'disk_conflict' : '' };
        receipts.set(request.requestId, receipt); return receipt;
      }
      if (method === 'syncReviewGet') return receipts.get(path) || { status: 'unknown', requestId: path };
      throw new Error('Unexpected protocol ' + method);
    }, current);
    const root = createRoot(document.getElementById('root')!);
    const render = (sessionId = 'review-fixture', workingDir = '/fixture-only', execKey = 'fixture-node') =>
      root.render(React.createElement(React.Fragment, {}, React.createElement(FileTreePanel, { sessionId, execKey,
        execMode: 'relay', workingDir, execLabel: '隔离测试执行端' }), React.createElement(FileTransferCenter)));
    Object.assign(fixture, { render }); render();
  });
  await expect(page.locator('.ftp-panel')).toBeVisible();
}
async function compare(page: Page) {
  await page.getByRole('button', { name: '更多文件工具', exact: true }).click();
  await page.getByRole('button', { name: '本机副本与同步', exact: true }).click();
  await page.getByRole('button', { name: '↔ 比对', exact: true }).click();
  await expect(page.getByRole('button', { name: /^审阅差异 \d+/ })).toBeEnabled();
  await expect(page.getByRole('dialog', { name: '目录同步审阅' })).toHaveCount(0);
}
async function open(page: Page) { await compare(page); await page.getByRole('button', { name: /^审阅差异 \d+/ }).click(); return page.getByRole('dialog', { name: '目录同步审阅' }); }

for (const width of [1366, 390]) test(`inherited scope, regex filtering and opaque review at ${width}px`, async ({ page }, info) => {
  await mount(page, width); await compare(page);
  await page.getByRole('button', { name: /^仅不同/ }).click();
  await page.evaluate(() => { document.body.style.setProperty('--theme-bg', 'rgba(21,25,34,.2)'); document.body.style.setProperty('--theme-panel-solid', '#151922'); });
  await page.getByRole('button', { name: /^审阅差异/ }).click();
  const panel = page.getByRole('dialog', { name: '目录同步审阅' });
  await expect(panel.getByText('仅不同：两端都存在且内容不同，不含仅本机／仅执行端文件')).toBeVisible();
  await expect(panel.getByRole('button', { name: /remote-empty|local-empty|src2/ })).toHaveCount(0);
  await panel.getByLabel('正则 .*', { exact: true }).check();
  await panel.getByRole('textbox', { name: '筛选差异文件' }).fill('^SRC/.*\\.ts$');
  await expect(panel.getByLabel('差异文件列表').getByRole('button', { name: /未处理/ })).toHaveCount(2);
  await panel.getByRole('textbox', { name: '筛选差异文件' }).fill('[');
  await expect(panel.getByRole('alert')).toContainText('正则表达式无效');
  await expect(panel.getByLabel('差异文件列表').getByRole('button', { name: /未处理/ })).toHaveCount(0);
  await panel.getByRole('textbox', { name: '筛选差异文件' }).fill('^src/a\\.ts$');
  await panel.getByRole('button', { name: 'src/a.ts 未处理', exact: true }).click();
  await expect(panel.getByLabel('本机差异正文')).toBeVisible();
  expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(21, 25, 34)');
  await page.screenshot({ path: info.outputPath(`opaque-regex-${width}.png`), fullPage: true });
  await page.evaluate(() => { document.body.style.setProperty('--theme-panel-solid', '#f6f8fa'); document.body.style.setProperty('--theme-text', '#24292f'); });
  expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(246, 248, 250)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('preview compare opens the exact file, restores focus and never scans or writes', async ({ page }) => {
  await mount(page);
  const file = page.locator('.ftp-row').filter({ has: page.getByText('format.txt', { exact: true }) });
  await file.click(); await expect(page.getByRole('button', { name: '对比', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await compare(page); await page.keyboard.press('Escape');
  await file.click(); const trigger = page.getByRole('button', { name: '对比', exact: true });
  const scans = await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => ['manifest','local-scan'].includes(c.method)).length);
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '目录同步审阅' });
  await expect(panel.getByRole('button', { name: 'format.txt 未处理', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(panel.getByText('编码、BOM 或换行格式不同（传输保留原字节）')).toBeVisible();
  await panel.getByRole('button', { name: '关闭审阅', exact: true }).click(); await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => ['manifest','local-scan'].includes(c.method)).length)).toBe(scans);
  expect(await page.evaluate(() => (window as any).reviewFixture.writes)).toEqual([]);
});

test('Session switching restores tree, search, compare and review preferences without replay', async ({ page }) => {
  await mount(page); await compare(page);
  await page.getByRole('button', { name: /^仅不同/ }).click();
  await page.getByRole('button', { name: /^审阅差异/ }).click();
  const panel = page.getByRole('dialog', { name: '目录同步审阅' });
  await panel.getByRole('button', { name: 'src/a.ts 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '跳过', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '跳过', exact: true }).click();
  await panel.getByLabel('正则 .*', { exact: true }).check();
  await panel.getByRole('textbox', { name: '筛选差异文件' }).fill('^src/');
  await panel.getByRole('button', { name: 'src/b.ts 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '推送到执行端 →', exact: true }).click();
  // 离开时不重放确认；重新打开只恢复筛选/选择/跳过状态。
  await page.evaluate(() => (window as any).reviewFixture.render('other-session'));
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '更多文件工具', exact: true }).click();
  await page.getByRole('button', { name: '本机副本与同步', exact: true }).click();
  await expect(page.getByRole('button', { name: /^审阅差异/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).reviewFixture.render());
  await expect(page.locator('.ftp-row').filter({ has: page.getByText('a.ts', { exact: true }) })).toBeVisible();
  await page.getByRole('button', { name: '更多文件工具', exact: true }).click();
  await page.getByRole('button', { name: '本机副本与同步', exact: true }).click();
  await expect(page.getByRole('button', { name: /^✓ 仅不同/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/上次比对：/)).toBeVisible();
  const scans = await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => ['manifest','local-scan','directory'].includes(c.method)).length);
  await page.getByRole('button', { name: /^审阅差异/ }).click();
  await expect(panel.getByRole('textbox', { name: '筛选差异文件' })).toHaveValue('^src/');
  await expect(panel.getByLabel('正则 .*', { exact: true })).toBeChecked();
  await expect(panel.getByRole('button', { name: 'src/a.ts 已跳过', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'src/b.ts 未处理', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(panel.getByRole('alertdialog')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '推送到执行端 →', exact: true }).click();
  await page.evaluate(() => { (window as any).reviewFixture.files['src/b.ts'] = 'changed-after-review'; });
  await panel.getByRole('button', { name: '确认推送', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'src/b.ts 需重新审阅', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '关闭审阅', exact: true }).click();
  const search = page.getByLabel('搜索工作区文件', { exact: true });
  await search.fill('src');
  await expect.poll(() => page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => c.method === 'search').length)).toBeGreaterThan(0);
  await expect(page.getByRole('listbox', { name: '文件搜索结果' }).getByRole('option').first()).toBeVisible();
  const searches = await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => c.method === 'search').length);
  await page.evaluate(() => (window as any).reviewFixture.render('other-session'));
  await expect(search).toHaveValue('');
  await page.evaluate(() => (window as any).reviewFixture.render());
  await expect(search).toHaveValue('src');
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => c.method === 'search').length)).toBe(searches);
  expect(await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => ['manifest','local-scan','directory'].includes(c.method)).length)).toBe(scans);
  expect(await page.evaluate(() => (window as any).reviewFixture.writes)).toEqual([]);
  await page.evaluate(() => (window as any).reviewFixture.render('review-fixture', '/another-root'));
  await expect(search).toHaveValue('');
});

test('regex backtracking is terminated off the UI thread and a changed expression recovers', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).reviewFixture.files['a'.repeat(64) + '!'] = 'path-only-fixture'; });
  const panel = await open(page);
  await panel.getByLabel('正则 .*', { exact: true }).check();
  await panel.getByRole('textbox', { name: '筛选差异文件' }).fill('(a+)+$');
  await expect(panel.getByText('正则匹配超时，请简化表达式')).toBeVisible();
  await panel.getByRole('textbox', { name: '筛选差异文件' }).fill('^src/');
  await expect(panel.getByLabel('差异文件列表').getByRole('button', { name: /未处理/ })).toHaveCount(2);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: '关闭审阅', exact: true }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.writes)).toEqual([]);
});

test('restoration never carries Git-metadata consent or a compare to another executor', async ({ page }) => {
  await mount(page); await compare(page);
  await page.getByText('高级同步 · Git 元数据默认排除', { exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel(/包含 \.git 仓库元数据/).check();
  await page.getByRole('button', { name: '↔ 比对', exact: true }).click();
  await expect(page.getByRole('button', { name: /^审阅差异/ })).toBeEnabled();
  await page.evaluate(() => (window as any).reviewFixture.render('other-session'));
  await expect(page.getByRole('button', { name: '更多文件工具', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).reviewFixture.render());
  await page.getByRole('button', { name: '更多文件工具', exact: true }).click();
  await page.getByRole('button', { name: '本机副本与同步', exact: true }).click();
  await expect(page.getByRole('button', { name: /^审阅差异/ })).toBeDisabled();
  await page.getByText('高级同步 · Git 元数据默认排除', { exact: true }).click();
  await expect(page.getByLabel(/包含 \.git 仓库元数据/)).not.toBeChecked();
  await page.getByRole('button', { name: '↔ 比对', exact: true }).click();
  await expect(page.getByRole('button', { name: /^审阅差异/ })).toBeEnabled();
  await page.evaluate(() => (window as any).reviewFixture.render('review-fixture', '/fixture-only', 'other-node'));
  await page.getByRole('button', { name: '更多文件工具', exact: true }).click();
  await page.getByRole('button', { name: '本机副本与同步', exact: true }).click();
  await expect(page.getByRole('button', { name: /^审阅差异/ })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).reviewFixture.writes)).toEqual([]);
});

for (const width of [1366, 390]) test(`whole-file review, skip, create/push/pull and focus at ${width}px`, async ({ page }, info) => {
  await mount(page, width); const panel = await open(page);
  await panel.getByRole('button', { name: 'src/a.ts 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => c.method === 'syncReviewRead').map((c: any) => c.path))).not.toContain('src/b.ts');
  if (width < 760) await panel.getByRole('button', { name: '执行端', exact: true }).tap();
  await expect(panel.getByLabel('执行端差异正文')).toContainText('<img src=x onerror=alert(1)>');
  await expect(panel.locator('img')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('button', { name: '推送到执行端 →', exact: true }).click();
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.writes.length)).toBe(0);
  await panel.getByRole('button', { name: '跳过', exact: true }).click();
  await panel.getByRole('button', { name: 'src/a.ts 已跳过', exact: true }).click();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '推送到执行端 →', exact: true }).click();
  await panel.getByRole('button', { name: '确认推送', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'src/a.ts 已推送', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'src/b.ts 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '← 拉取到本机', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '← 拉取到本机', exact: true }).click();
  await panel.getByRole('button', { name: '确认拉取', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'src/b.ts 已拉取', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'remote-empty.txt 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '← 拉取到本机', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '← 拉取到本机', exact: true }).click();
  await expect(panel.getByRole('alertdialog')).toContainText('创建缺失文件');
  await panel.getByRole('button', { name: '确认拉取', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'remote-empty.txt 已拉取', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => { const f = (window as any).reviewFixture; return { b: await (await f.fs.readBlob('src/b.ts')).text(), empty: await f.fs.fileSize('remote-empty.txt'), writes: f.writes,
    baselines: Object.keys(localStorage).filter(k => k.startsWith('awu-sync-review-v1:')).length }; })).toEqual({ b: 'remote b', empty: 0, writes: ['src/a.ts'], baselines: 1 });
  await panel.getByRole('button', { name: '关闭审阅', exact: true }).focus(); await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0); await expect(page.getByRole('button', { name: '更多文件工具', exact: true })).toBeFocused();
});

test('format/limits, stale decisions, unknown never resubmits and closed feedback remains', async ({ page }) => {
  await mount(page); const panel = await open(page);
  await panel.getByRole('button', { name: 'format.txt 未处理', exact: true }).click();
  await expect(panel.getByText('编码、BOM 或换行格式不同（传输保留原字节）')).toBeVisible();
  for (const [path, message] of [['binary.txt', '二进制内容'], ['large.txt', '文件超过 2 MiB']]) {
    await panel.getByRole('button', { name: `${path} 未处理`, exact: true }).click();
    await expect(panel.getByText(`无法完整审阅：${message}`)).toBeVisible();
    await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeDisabled();
  }
  await panel.getByRole('button', { name: 'src/b.ts 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '推送到执行端 →', exact: true }).click();
  await page.evaluate(() => { (window as any).reviewFixture.files['src/b.ts'] = 'external'; });
  await panel.getByRole('button', { name: '确认推送', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'src/b.ts 需重新审阅', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).reviewFixture.writes)).toEqual([]);
  await panel.getByRole('button', { name: '重新审阅', exact: true }).click();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'src/a.ts 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '推送到执行端 →', exact: true }).click();
  await panel.getByRole('button', { name: '确认推送', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'src/a.ts 已推送', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'src/b.ts 未处理', exact: true }).click();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).reviewFixture.unknown = true; });
  await panel.getByRole('button', { name: '推送到执行端 →', exact: true }).click();
  await panel.getByRole('button', { name: '确认推送', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'src/b.ts 结果未知', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '关闭审阅', exact: true }).click();
  await page.getByRole('button', { name: '核对结果', exact: true }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.writes)).toEqual(['src/a.ts', 'src/b.ts']);
});

test('quick navigation discards delayed content; subtree excludes adjacent directory', async ({ page }) => {
  await mount(page); await compare(page);
  await page.keyboard.press('Escape');
  await page.locator('.ftp-row').filter({ has: page.getByText('src', { exact: true }) }).click({ button: 'right' });
  await page.getByRole('button', { name: '审阅此目录差异', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '目录同步审阅' });
  await expect(panel.getByRole('button', { name: /src2/ })).toHaveCount(0);
  await page.evaluate(() => { (window as any).reviewFixture.delay = 'src/a.ts'; });
  await panel.getByRole('button', { name: '重新审阅', exact: true }).click();
  await page.waitForFunction(() => (window as any).reviewFixture.release);
  await panel.getByRole('button', { name: 'src/b.ts 未处理', exact: true }).click();
  await expect(panel.getByLabel('本机差异正文')).toContainText('local b');
  await page.evaluate(() => (window as any).reviewFixture.release());
  await expect(panel.getByLabel('本机差异正文')).toContainText('local b');
  await page.evaluate(() => { (window as any).reviewFixture.release = null; });
  await panel.getByRole('button', { name: 'src/a.ts 未处理', exact: true }).click();
  await page.waitForFunction(() => (window as any).reviewFixture.release);
  await panel.getByRole('button', { name: '关闭审阅', exact: true }).click();
  await page.evaluate(() => (window as any).reviewFixture.release());
  await expect(panel).toHaveCount(0);
});

test('old/offline capabilities fail closed; ordinary preview and idle tree stay independent', async ({ page }) => {
  await mount(page);
  const panel = page.locator('.ftp-panel');
  const offset = await panel.evaluate(el => el.querySelector('.ftp-tree-scroll')!.getBoundingClientRect().top - el.getBoundingClientRect().top);
  expect(offset).toBeLessThanOrEqual(80);
  await page.evaluate(() => { (window as any).reviewFixture.old = true; });
  await page.getByRole('button', { name: '更多文件工具', exact: true }).click();
  await page.getByRole('button', { name: '本机副本与同步', exact: true }).click();
  await page.getByRole('button', { name: '↔ 比对', exact: true }).click();
  await expect(page.getByRole('button', { name: /^审阅差异/ })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => c.method === 'syncReviewRead').length)).toBe(0);
  await page.keyboard.press('Escape');
  await page.locator('.ftp-row').filter({ has: page.getByText('format.txt', { exact: true }) }).click();
  await expect(page.getByRole('button', { name: '关闭预览', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '目录同步审阅' })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).reviewFixture; f.old = false; });
  const review = await open(page);
  await page.evaluate(() => { (window as any).reviewFixture.offline = true; });
  await review.getByRole('button', { name: 'src/b.ts 未处理', exact: true }).click();
  await expect(review.getByText('无法完整审阅：offline')).toBeVisible();
  await expect(review.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeDisabled();
  await review.getByRole('button', { name: '关闭审阅', exact: true }).click();
  const calls = await page.evaluate(() => (window as any).reviewFixture.calls.length);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).reviewFixture.calls.length)).toBe(calls);
});

test('keyboard hunk navigation, folding, real blank/long lines and budget failure', async ({ page }) => {
  await mount(page); const panel = await open(page);
  await panel.getByRole('button', { name: 'src/a.ts 未处理', exact: true }).click();
  const next = panel.getByRole('button', { name: '下一差异块', exact: true });
  await expect(next).toBeEnabled(); await next.focus(); await page.keyboard.press('Enter');
  await expect(panel.getByLabel('执行端差异正文')).toContainText('second hunk');
  const before = await panel.getByLabel('本机差异正文').evaluate(el => el.scrollHeight);
  await panel.getByRole('button', { name: /^展开/ }).first().click();
  expect(await panel.getByLabel('本机差异正文').evaluate(el => el.scrollHeight)).toBeGreaterThan(before);
  await panel.getByRole('button', { name: 'visual.txt 未处理', exact: true }).click();
  const left = panel.getByLabel('本机差异正文'), right = panel.getByLabel('执行端差异正文');
  await expect(left).toContainText('x'.repeat(220));
  await expect(left.locator('[data-diff-kind]').first()).toHaveText('1');
  await left.evaluate(el => { el.scrollLeft = 150; el.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => right.evaluate(el => el.scrollLeft)).toBe(150);
  const farRight = await left.evaluate(el => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event('scroll')); return el.scrollWidth - el.clientWidth; });
  await expect.poll(() => left.evaluate(el => el.scrollLeft)).toBe(farRight);
  expect(await right.evaluate(el => el.scrollLeft)).toBeLessThan(farRight);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('button', { name: 'budget.txt 未处理', exact: true }).click();
  await expect(panel.getByText('无法完整审阅：差异计算超出预算')).toBeVisible();
  await expect(panel.getByRole('button', { name: '推送到执行端 →', exact: true })).toBeDisabled();
});
