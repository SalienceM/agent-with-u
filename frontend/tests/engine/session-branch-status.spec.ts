import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1280, projects = 1) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async ({ projects }) => {
    const { React, createRoot, Sidebar, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const { uiDensityCss } = await import('/src/utils/uiDensity.ts');
    const style = document.createElement('style');
    style.textContent = `* { box-sizing: border-box; } ${uiDensityCss}`; document.head.appendChild(style);
    document.getElementById('root')!.className = 'app-root';
    const f = { sessions: [] as any[], tips: {} as Record<string, any[]>, reads: [] as any[], actions: [] as any[], selections: [] as string[], sessionEvents: new Set<any>(), mergeEvents: new Set<any>(),
      connections: new Set<any>(), online: true, supported: true, hidden: false, collapsed: false, hold: false, releases: [] as (() => void)[], active: 0, max: 0, changedPage: false, paging: false, render: () => {} };
    document.body.style.background = '#191b20'; document.body.style.margin = '0';
    Object.entries({ '--theme-bg': '#191b20', '--theme-bg-secondary': '#22252d', '--theme-bg-tertiary': '#292d38', '--theme-sidebar-bg': '#22252d', '--theme-sidebar-solid': '#22252d', '--theme-panel-solid': '#191b20', '--theme-text': '#e6ebf3', '--theme-text-muted': '#a8b2c4', '--theme-border': '#465063', '--theme-accent': '#88b3fc' }).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    Object.assign(document.getElementById('root')!.style, { height: '100vh', display: 'flex', fontFamily: 'system-ui, sans-serif' });
    for (let i = 0; i < projects; i++) {
      const root = `root${i}`, executor = 'relay:fixture';
      f.sessions.push(...[{ id: root, title: i ? `其他项目 ${i}` : '项目 A' }, { id: `b${i}`, title: i ? `其他副本 ${i}` : '功能 B', relationKind: 'task', parentSessionId: root }, { id: `c${i}`, title: i ? `次要副本 ${i}` : '功能 C', relationKind: 'task', parentSessionId: root }]
        .map(row => ({ ...row, workingDir: `C:/${row.id}`, execKey: executor, execLabel: '测试节点', backendId: 'fake', updatedAt: 1, messageCount: 0 })));
      f.tips[root] = [{ sessionId: root, title: i ? `其他项目 ${i}` : '项目 A', main: true, state: 'known', head: 'a', branch: 'main', ahead: 0, behind: 0, dirty: false },
        { sessionId: `b${i}`, title: '功能 B', main: false, state: 'known', head: 'b', branch: 'feature-b', ahead: 1, behind: 0, dirty: false },
        { sessionId: `c${i}`, title: '功能 C', main: false, state: 'known', head: 'c', branch: 'feature-c', ahead: 0, behind: 2, dirty: false }];
    }
    f.sessions.push({ id: 'integration', title: '旧整合空间', workingDir: 'C:/integration', execKey: 'relay:fixture', backendId: 'fake', updatedAt: 1, relationKind: 'integration', parentSessionId: 'root0',
      mergeLink: { operationId: 'old-success', originSessionId: 'b0', sourceSessionId: 'b0', targetSessionId: 'root0', status: 'succeeded' } });
    api.listSessions = async () => f.sessions;
    api.getBackends = async () => [{ id: 'fake', label: 'official-codex', type: 'openai-compatible' }];
    api.onSessionUpdated = cb => { f.sessionEvents.add(cb); return () => { f.sessionEvents.delete(cb); }; };
    api.onProjectMergeUpdated = cb => { f.mergeEvents.add(cb); return () => { f.mergeEvents.delete(cb); }; };
    api.onExecutorConnectionStatus = (_e, cb) => { f.connections.add(cb); cb(f.online); return () => { f.connections.delete(cb); }; };
    api.projectMergeCapabilities = async () => ({ branchStatus: f.supported ? 1 : 0, mergeWorkflow: 0 });
    api.projectBranchStatus = async (root, executor, offset = 0) => {
      f.reads.push([root, executor, offset]); f.active++; f.max = Math.max(f.max, f.active);
      const items = structuredClone(f.tips[root]);
      if (f.hold) await new Promise<void>(resolve => f.releases.push(resolve));
      f.active--;
      return { version: 1, parentSessionId: root, familyRevision: f.changedPage && offset ? 'changed' : 'family', checkedAt: Date.now() / 1000,
        items: f.paging ? [items[0], items[offset + 1]] : items, total: items.length - 1, nextOffset: f.paging && offset === 0 ? 1 : null };
    };
    api.collaborationList = async () => ({ items: [], nextOffset: null });
    api.projectMergePreview = async (...args) => { f.actions.push(args); throw Error('unexpected write'); };
    const root = createRoot(document.getElementById('root')!);
    f.render = () => root.render(React.createElement(Sidebar, { activeSessionId: 'b0', activeExecKey: 'relay:fixture', streamingSessions: new Set(), collapsed: f.collapsed,
      width: 320, view: f.hidden ? 'files' : 'sessions', onSelectSession: id => { f.selections.push(id); }, onNewSession: () => {} }));
    (window as any).branchFixture = f; f.render();
  }, { projects });
}

async function openCheck(page: Page, title = '项目 A') {
  await page.getByText(title, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '检查分支状态', exact: true }).click();
  return page.getByRole('dialog', { name: '分支状态', exact: true });
}

for (const width of [1280, 390]) test(`list stays quiet until a main Session check (${width})`, async ({ page }, testInfo) => {
  await page.clock.install();
  await mount(page, width);
  await expect(page.getByText('功能 B', { exact: true })).toBeVisible();
  await page.getByText('功能 B', { exact: true }).click();
  expect(await page.evaluate(() => (window as any).branchFixture.selections)).toEqual(['b0']);
  await page.clock.fastForward(180000);
  await page.evaluate(() => {
    const f = (window as any).branchFixture; window.dispatchEvent(new Event('focus'));
    f.sessionEvents.forEach((cb: any) => cb({ type: 'branch_changed', sessionId: 'b0', execKey: 'relay:fixture' }));
    f.mergeEvents.forEach((cb: any) => cb({ sourceSessionId: 'b0', targetSessionId: 'root0' }, 'relay:fixture'));
    f.connections.forEach((cb: any) => { cb(false); cb(true); });
  });
  await page.clock.runFor(300);
  expect(await page.evaluate(() => (window as any).branchFixture.reads)).toEqual([]);
  await expect(page.getByRole('button', { name: /当前分支状态/ })).toHaveCount(0);
  await expect(page.getByText(/核对中|已同步|待合并|待同步/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('session-list-on-demand.png'), fullPage: true });
  await page.getByText('功能 B', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '检查分支状态', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByText('项目 A', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '检查分支状态', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).branchFixture.reads)).toEqual([]);
});

for (const width of [1280, 390]) test(`manual check shows current project and supports keyboard close (${width})`, async ({ page }, testInfo) => {
  await mount(page, width, 2);
  if (width === 390) await page.evaluate(() => {
    Object.entries({ '--theme-panel-solid': '#fff', '--theme-bg': '#fff', '--theme-bg-secondary': '#f6f8fa', '--theme-text': '#1f2328', '--theme-text-muted': '#656d76', '--theme-border': '#d0d7de' })
      .forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
  });
  const dialog = await openCheck(page);
  await expect(dialog.getByText('1 个分支待合并', { exact: true })).toBeVisible();
  await expect(dialog.getByText('待合并', { exact: true })).toBeVisible();
  await expect(dialog.getByText('待同步', { exact: true })).toBeVisible();
  await expect(dialog.getByText('feature-b', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('旧整合空间');
  expect(await page.evaluate(() => (window as any).branchFixture.reads)).toEqual([['root0', 'relay:fixture', 0]]);
  await page.screenshot({ path: testInfo.outputPath('manual-branch-check.png'), fullPage: true });
  await page.evaluate(() => {
    const f = (window as any).branchFixture;
    f.tips.root0[1].ahead = 0; f.tips.root0[2].ahead = 2;
  });
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(dialog.getByText('已同步', { exact: true })).toBeVisible();
  await expect(dialog.getByText('待合并 · 待同步', { exact: true })).toBeVisible();
  await expect(dialog.getByText('1 个分支待合并', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).branchFixture.tips.root0[1].dirty = true; });
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(dialog.getByText('有未提交改动', { exact: true })).toBeVisible();
  const close = dialog.getByRole('button', { name: '关闭分支状态' });
  await close.focus(); await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '重新检查', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(close).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(page.locator('[aria-haspopup="menu"]').filter({ hasText: '项目 A' })).toBeFocused();
  expect(await page.evaluate(() => (window as any).branchFixture.actions)).toEqual([]);
  expect(await page.evaluate(() => (window as any).branchFixture.selections)).toEqual([]);
});

test('events, elapsed time and reconnect never schedule another read', async ({ page }) => {
  await page.clock.install(); await mount(page);
  const dialog = await openCheck(page);
  await expect(dialog.getByText('1 个分支待合并', { exact: true })).toBeVisible();
  await page.clock.fastForward(180000); await page.clock.runFor(100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await page.evaluate(() => (window as any).branchFixture.reads.length)).toBe(1);
  await page.evaluate(() => {
    const f = (window as any).branchFixture;
    f.sessionEvents.forEach((cb: any) => cb({ type: 'branch_changed', sessionId: 'b0', execKey: 'relay:fixture' }));
  });
  await expect(dialog).toContainText('项目已变化');
  await expect(dialog.getByText('1 个分支待合并', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).branchFixture.reads.length)).toBe(1);
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(dialog.getByText('待合并', { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).branchFixture; f.online = false; f.connections.forEach((cb: any) => cb(false)); });
  await expect(dialog).toContainText('原节点离线');
  await page.evaluate(() => { const f = (window as any).branchFixture; f.online = true; f.connections.forEach((cb: any) => cb(true)); });
  await page.clock.runFor(300);
  expect(await page.evaluate(() => (window as any).branchFixture.reads.length)).toBe(2);
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(dialog.getByText('待同步', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭分支状态' }).click();
  await page.clock.fastForward(180000); await page.clock.runFor(300);
  expect(await page.evaluate(() => (window as any).branchFixture.reads.length)).toBe(3);
});

test('unsupported, changed pages and unknown or busy members cannot claim latest', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).branchFixture.supported = false; });
  const dialog = await openCheck(page);
  await expect(dialog).toContainText('原节点尚不支持');
  expect(await page.evaluate(() => (window as any).branchFixture.reads)).toEqual([]);
  await page.evaluate(() => { const f = (window as any).branchFixture; f.supported = true; f.paging = true; f.changedPage = true; });
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(dialog).toContainText('分页期间主干或成员已变化');
  await expect(dialog.getByText('最新 · 分支均已合入', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const f = (window as any).branchFixture; f.changedPage = false;
    f.tips.root0[1].ahead = 0; f.tips.root0[2].state = 'unknown';
  });
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(dialog.getByText('部分分支待核对', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await page.evaluate(() => {
    const f = (window as any).branchFixture; f.tips.root0[2].state = 'known'; f.tips.root0[2].busy = true;
  });
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(dialog.getByText('运行/编辑中 · 待核对', { exact: true })).toBeVisible();
  await expect(dialog.getByText('最新 · 分支均已合入', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).branchFixture.actions)).toEqual([]);
});

test('late results after closing cannot replace a check for another executor', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).branchFixture.hold = true; });
  const dialog = await openCheck(page);
  await expect.poll(() => page.evaluate(() => (window as any).branchFixture.releases.length)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    const f = (window as any).branchFixture; f.hold = false;
    f.sessions = f.sessions.map((s: any) => ({ ...s, execKey: 'relay:other', ...(s.id === 'root0' ? { title: '其他节点项目' } : {}) }));
    f.tips.root0.forEach((tip: any) => { tip.ahead = 0; tip.behind = 0; });
    f.tips.root0[0].title = '其他节点项目';
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByText('其他节点项目', { exact: true })).toBeVisible();
  await openCheck(page, '其他节点项目');
  await expect(dialog.getByText('最新 · 分支均已合入', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).branchFixture.releases.splice(0).forEach((resolve: any) => resolve()));
  await expect(dialog.getByText('最新 · 分支均已合入', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).branchFixture.reads.at(-1)[1])).toBe('relay:other');
  expect(await page.evaluate(() => (window as any).branchFixture.max)).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
