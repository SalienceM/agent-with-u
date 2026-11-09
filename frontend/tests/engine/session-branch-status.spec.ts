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
    const f = { sessions: [] as any[], tips: {} as Record<string, any[]>, reads: [] as any[], actions: [] as any[], sessionEvents: new Set<any>(), mergeEvents: new Set<any>(),
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
    api.getBackends = async () => [{ id: 'fake', label: 'Fake', type: 'openai-compatible' }];
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
      width: 320, view: f.hidden ? 'files' : 'sessions', onSelectSession: () => {}, onNewSession: () => {} }));
    (window as any).branchFixture = f; f.render();
  }, { projects });
}

for (const width of [1280, 390]) test(`session badges reflect current siblings rather than merge history (${width})`, async ({ page }, testInfo) => {
  await mount(page, width);
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：1 个分支待合并', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：待合并', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '功能 C 的当前分支状态：待同步', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('session-branch-badges.png'), fullPage: true });
  await page.evaluate(() => {
    const f = (window as any).branchFixture;
    f.tips.root0[1].ahead = 0; f.tips.root0[1].behind = 0;
    f.tips.root0[2].ahead = 2;
    f.mergeEvents.forEach((cb: any) => cb({ sourceSessionId: 'b0', targetSessionId: 'root0' }, 'relay:fixture'));
  });
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：已同步', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '功能 C 的当前分支状态：待合并 · 待同步', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：1 个分支待合并', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).branchFixture; f.tips.root0[1].dirty = true;
    f.sessionEvents.forEach((cb: any) => cb({ type: 'branch_changed', sessionId: 'b0', execKey: 'relay:fixture' }));
  });
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：有未提交改动', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '功能 C 的当前分支状态：待合并 · 待同步', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as any).branchFixture.actions)).toEqual([]);
  expect(await page.evaluate(() => (window as any).branchFixture.reads.every((read: any[]) => read[1] === 'relay:fixture'))).toBe(true);
});

test('offline, unsupported and partial pages never retain a latest badge', async ({ page }) => {
  await mount(page);
  await expect(page.getByRole('button', { name: /项目 A 的当前分支状态：1 个分支待合并/ })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).branchFixture;
    f.tips.root0.forEach((tip: any) => { tip.ahead = 0; tip.behind = 0; });
    f.sessionEvents.forEach((cb: any) => cb({ type: 'branch_changed', sessionId: 'root0', execKey: 'relay:fixture' }));
  });
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：最新 · 分支均已合入', exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).branchFixture; f.online = false; f.connections.forEach((cb: any) => cb(false)); });
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：离线 · 待核对', exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).branchFixture; f.online = true; f.paging = true; f.changedPage = true; f.connections.forEach((cb: any) => cb(true)); });
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：状态待核对', exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).branchFixture; f.supported = false; window.dispatchEvent(new Event('focus')); });
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：状态不可用', exact: true })).toBeVisible();
});

test('events coalesce, hidden view stops reads and late results cannot restore stale labels', async ({ page }) => {
  await mount(page);
  await expect(page.getByRole('button', { name: /功能 B 的当前分支状态：待合并/ })).toBeVisible();
  const before = await page.evaluate(() => (window as any).branchFixture.reads.length);
  await page.evaluate(() => {
    const f = (window as any).branchFixture;
    for (let i = 0; i < 20; i++) f.sessionEvents.forEach((cb: any) => cb({ type: 'branch_changed', sessionId: 'b0', execKey: 'relay:fixture' }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).branchFixture.reads.length)).toBe(before + 1);
  await page.evaluate(() => {
    const f = (window as any).branchFixture; f.hold = true;
    f.sessionEvents.forEach((cb: any) => cb({ type: 'branch_changed', sessionId: 'b0', execKey: 'relay:fixture' }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).branchFixture.releases.length)).toBe(1);
  await page.evaluate(() => { const f = (window as any).branchFixture; f.collapsed = true; f.render(); });
  const hiddenReads = await page.evaluate(() => (window as any).branchFixture.reads.length);
  await page.evaluate(() => { const f = (window as any).branchFixture; f.releases.splice(0).forEach((resolve: any) => resolve()); window.dispatchEvent(new Event('focus')); });
  expect(await page.evaluate(() => (window as any).branchFixture.reads.length)).toBe(hiddenReads);
  await page.evaluate(() => { const f = (window as any).branchFixture; f.hold = false; f.tips.root0[1].ahead = 0; f.collapsed = false; f.render(); });
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：已同步', exact: true })).toBeVisible();
});

test('project reads are capped at two and unknown sibling prevents global latest', async ({ page }) => {
  await mount(page, 1280, 3);
  await expect(page.getByRole('button', { name: /其他项目 2 的当前分支状态：1 个分支待合并/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).branchFixture.max)).toBeLessThanOrEqual(2);
  await page.evaluate(() => {
    const f = (window as any).branchFixture;
    f.tips.root0[1].ahead = 0; f.tips.root0[2].state = 'unknown';
    f.sessionEvents.forEach((cb: any) => cb({ type: 'branch_changed', sessionId: 'root0', execKey: 'relay:fixture' }));
  });
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：部分分支待核对', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).branchFixture.actions)).toEqual([]);
});

test('external changes refresh at a low frequency only while visible', async ({ page }) => {
  await page.clock.install();
  await mount(page);
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：待合并', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).branchFixture.tips.root0[1].ahead = 0; });
  await page.clock.fastForward(60000); await page.clock.runFor(250);
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：已同步', exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const before = await page.evaluate(() => (window as any).branchFixture.reads.length);
  await page.clock.fastForward(120000); await page.clock.runFor(250);
  expect(await page.evaluate(() => (window as any).branchFixture.reads.length)).toBe(before);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(250);
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：已同步', exact: true })).toBeVisible();
});

test('late response from an earlier executor cannot overwrite the current project', async ({ page }) => {
  await mount(page);
  await expect(page.getByRole('button', { name: '功能 B 的当前分支状态：待合并', exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).branchFixture; f.hold = true; window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => page.evaluate(() => (window as any).branchFixture.releases.length)).toBe(1);
  await page.evaluate(() => {
    const f = (window as any).branchFixture; f.hold = false; f.sessions.forEach((s: any) => { s.execKey = 'relay:other'; }); f.tips.root0[1].ahead = 0;
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).branchFixture.reads.some((r: any[]) => r[1] === 'relay:other'))).toBe(true);
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：最新 · 分支均已合入', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).branchFixture.releases.splice(0).forEach((resolve: any) => resolve()); });
  await expect(page.getByRole('button', { name: '项目 A 的当前分支状态：最新 · 分支均已合入', exact: true })).toBeVisible();
});
