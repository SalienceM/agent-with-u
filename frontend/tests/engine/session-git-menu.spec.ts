import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1200) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { React, createRoot, Sidebar, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const { uiDensityCss } = await import('/src/utils/uiDensity.ts');
    const style = document.createElement('style'); style.textContent = `* { box-sizing: border-box; } ${uiDensityCss}`; document.head.appendChild(style);
    document.getElementById('root')!.className = 'app-root';
    Object.assign(document.getElementById('root')!.style, { height: '100vh', display: 'flex', fontFamily: 'system-ui' });
    Object.entries({ '--theme-panel-solid': '#161b22', '--theme-bg-secondary': '#20252d', '--theme-sidebar-solid': '#20252d', '--theme-text': '#e6edf3', '--theme-text-muted': '#a8b2c4', '--theme-border': '#465063', '--theme-accent': '#88b3fc' })
      .forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    const f: any = { sessions: [], events: new Set(), reads: [], transferReads: [], writes: [], forbidden: [], selections: [], repo: true, fail: false, hold: false, release: () => {}, metaExecutor: 'relay:fixture' };
    f.sessions = [
      { id: 'solo', title: '独立会话' }, { id: 'parent', title: '有副本的主会话' },
      { id: 'child', title: '分支副本', relationKind: 'task', parentSessionId: 'parent' },
      { id: 'old', title: '只有整合记录' }, { id: 'integration', title: '整合空间', relationKind: 'integration', parentSessionId: 'old' },
      { id: 'foreign-child', title: '另一节点副本', relationKind: 'task', parentSessionId: 'solo', execKey: 'relay:other' },
      { id: 'ssh', title: 'SSH 会话', codexConnectionMode: 'ssh' },
    ].map(row => ({ execKey: 'relay:fixture', execLabel: '测试节点', workingDir: `C:/${row.id}`, backendId: 'fake', updatedAt: 1, messageCount: 0, ...row }));
    (window as any).gitMenuFixture = f;
    api.listSessions = async () => f.sessions;
    api.getBackends = async () => [{ id: 'fake', label: 'test', type: 'openai-compatible' }];
    api.onSessionUpdated = cb => { f.events.add(cb); return () => { f.events.delete(cb); }; };
    api.onProjectMergeUpdated = () => () => {};
    api.onSessionConnectionStatus = (_session, cb) => { cb(true); return () => {}; };
    api.loadSessionMeta = async id => {
      if (f.hold) await new Promise<void>(resolve => { f.release = resolve; });
      return { ...f.sessions.find((row: any) => row.id === id), execKey: f.metaExecutor, workingDir: `C:/latest/${id}` };
    };
    api.gitDetect = async (...args) => { f.reads.push(['detect', ...args]); if (f.fail) throw Error('offline'); return { isRepo: f.repo }; };
    api.gitStatus = async (...args) => { f.reads.push(['status', ...args]); return { branch: 'feature-test', ahead: 1, behind: 1, files: [{ path: 'demo.txt', status: 'modified', staged: false }] }; };
    api.gitStashList = async (...args) => { f.reads.push(['stash', ...args]); return { stashes: [] }; };
    api.gitLog = async (...args) => { f.reads.push(['log', ...args]); return { commits: [], hasMore: false }; };
    api.gitStage = async (...args) => { f.writes.push(['stage', ...args]); return { status: 'ok' }; };
    api.projectTransferExecutors = () => [];
    api.projectTransferCapabilities = async (...args) => {
      f.transferReads.push(args);
      return { version: 1, executorId: 'fixture', git: true, origin: { executorId: 'origin', sessionId: 'original', transferId: 'transfer' } };
    };
    for (const name of ['listDirectory', 'syncManifest', 'searchFiles', 'syncReadFile', 'projectBranchStatus', 'projectMergePreview',
      'projectTransferExport', 'projectTransferPlan', 'projectTransferAccept', 'projectTransferChunk', 'projectTransferFinish']) {
      (api as any)[name] = async (...args: any[]) => { f.forbidden.push([name, ...args]); throw Error('Unexpected scan or write'); };
    }
    const root = createRoot(document.getElementById('root')!);
    root.render(React.createElement(Sidebar, { activeSessionId: 'parent', activeExecKey: 'relay:fixture', activeEngineMode: true,
      streamingSessions: new Set(), width: 320, onSelectSession: id => f.selections.push(id), onNewSession: () => {} }));
  });
  await expect(page.getByText('独立会话', { exact: true })).toBeVisible();
}

async function openGit(page: Page, title = '独立会话') {
  await page.getByText(title, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Git 工作区', exact: true }).click();
  return page.getByRole('dialog', { name: '会话 Git 工作区', exact: true });
}

test('branch entries require ordinary children on the same node and do not scan on menu open', async ({ page }) => {
  await mount(page);
  for (const title of ['独立会话', '只有整合记录']) {
    await page.getByText(title, { exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /新建分支副本/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '检查分支状态', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '分支与合并', exact: true })).toHaveCount(0);
    for (const name of ['Git 工作区', '发送项目到节点', '回传项目成果']) {
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
    }
    await page.keyboard.press('Escape');
  }
  await page.getByText('有副本的主会话', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '检查分支状态', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '分支与合并', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByText('SSH 会话', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Git 工作区', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '发送项目到节点', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '回传项目成果', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.forbidden)).toEqual([]);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.reads)).toEqual([]);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.transferReads)).toEqual([]);
});

for (const width of [1200, 360]) test(`project transfer and Git entries coexist on the clicked session (${width}px)`, async ({ page }) => {
  await mount(page, width);
  for (const [name, suffix] of [['发送项目到节点', '节点副本'], ['回传项目成果', '成果']]) {
    await page.getByText('独立会话', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name, exact: true });
    await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue(`独立会话 · ${suffix}`);
    await expect(dialog.getByRole('button', { name: '预览交接', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[aria-haspopup="menu"]').filter({ hasText: '独立会话' })).toBeFocused();
  }
  expect(await page.evaluate(() => (window as any).gitMenuFixture.transferReads)).toEqual([
    ['relay:fixture', 'solo'], ['relay:fixture', 'solo'],
  ]);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.reads)).toEqual([]);
  const git = await openGit(page);
  await expect(git).toContainText('C:/latest/solo');
  await expect(git).toContainText('feature-test');
  expect(await page.evaluate(() => (window as any).gitMenuFixture.forbidden)).toEqual([]);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.writes)).toEqual([]);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.selections)).toEqual([]);
});

for (const width of [1200, 360]) test(`Git context entry opens clicked session directly with lazy tools (${width}px)`, async ({ page }, testInfo) => {
  await mount(page, width);
  const dialog = await openGit(page);
  await expect(dialog).toContainText('feature-test');
  await expect(dialog).toContainText('C:/latest/solo');
  await expect(page.locator('.ftp-tree-scroll')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.reads)).toEqual([
    ['detect', 'C:/latest/solo', 'relay:fixture', true], ['status', 'C:/latest/solo', 'relay:fixture', false],
  ]);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.selections)).toEqual([]);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('session-git.png') });
  await dialog.getByRole('button', { name: '查看 Stash (0)', exact: true }).click();
  await expect(dialog).toContainText('没有 Stash');
  await dialog.getByTitle('提交变更', { exact: true }).click();
  await expect(page.getByText('1 个文件变更', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '✕', exact: true }).click();
  await dialog.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.getByText('Git 日志', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '✕', exact: true }).click();
  await dialog.getByTitle('暂存所有变更', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).gitMenuFixture.writes.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.writes[0])).toEqual(['stage', 'C:/latest/solo', ['.'], 'relay:fixture']);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.forbidden)).toEqual([]);
  await dialog.getByRole('button', { name: '关闭 Git 工作区', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[aria-haspopup="menu"]').filter({ hasText: '独立会话' })).toBeFocused();
});

test('non-repository, failed detection and changed executor never expose writable Git actions', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).gitMenuFixture.repo = false; });
  let dialog = await openGit(page);
  await expect(dialog).toContainText('此目录未启用 Git');
  await expect(dialog.getByTitle('提交变更', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).gitMenuFixture.fail = true; });
  dialog = await openGit(page);
  await expect(dialog).toContainText('Git 状态同步失败');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const f = (window as any).gitMenuFixture; f.reads = []; f.metaExecutor = 'relay:changed'; });
  dialog = await openGit(page);
  await expect(dialog).toContainText('会话或执行节点已变化');
  expect(await page.evaluate(() => (window as any).gitMenuFixture.reads)).toEqual([]);
});

test('late metadata after closing cannot open Git or read a directory', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).gitMenuFixture.hold = true; });
  const dialog = await openGit(page);
  await expect(dialog).toContainText('正在读取会话工作区');
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).gitMenuFixture.release());
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.reads)).toEqual([]);
  expect(await page.evaluate(() => (window as any).gitMenuFixture.forbidden)).toEqual([]);
});
