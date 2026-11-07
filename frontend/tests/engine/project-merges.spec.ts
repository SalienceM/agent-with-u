import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1200, dark = false) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async ({ dark }) => {
    const { React, createRoot, ProjectTasksPanel, ChatInput, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    document.documentElement.style.setProperty('--theme-bg-secondary', dark ? '#222' : '#fff');
    document.documentElement.style.setProperty('--theme-text', dark ? '#eee' : '#222');
    const f = { actions: [] as string[], opened: [] as string[], row: null as any, callbacks: new Set<any>(), fail: false, reads: 0 };
    const repo = { root: 'C:/test/main', commonDir: 'C:/test/main/.git', repositoryId: 'repo', head: 'a'.repeat(40), branch: 'main', fingerprint: 'repo', dirty: [] };
    api.collaborationList = async (_s, _e, kind) => ({ items: kind === 'merge' && f.row ? [f.row] : [], nextOffset: null });
    api.projectMergeDiscover = async () => ({ items: [{ id: 'one', title: '需求', workingDir: 'C:/test/one' }, { id: 'two', title: '需求', workingDir: 'C:/test/two' }], truncated: false });
    api.projectMergePreview = async (_s, _e, source, target) => f.row = { id: 'op', revision: 1, sourceSessionId: 'main', title: '需求 → 需求', status: 'preview', planFingerprint: 'frozen', files: ['same.txt'], blockers: [],
      source: { ...repo, root: 'C:/test/one', sessionId: source, title: '需求' }, target: { ...repo, sessionId: target, title: '需求' },
      integrationConfig: { backendId: 'fake', skipPermissions: false }, policy: '独立整合空间，仅快进目标', verification: { status: 'not_run', notice: '项目测试尚未运行' } };
    api.projectMergeStatus = async () => { f.reads++; return f.row; };
    api.projectMergeAction = async (_s, _e, action, row) => {
      f.actions.push(action);
      if (action === 'Prepare') f.row = { ...row, revision: 2, status: 'conflict', integration: { sessionId: 'integration', root: 'C:/test/integration', conflicts: ['same.txt'] } };
      if (action === 'Verify') f.row = { ...row, revision: 3, status: 'candidate', candidate: 'b'.repeat(40), integration: { ...row.integration, conflicts: [] }, verification: { status: 'git_verified', head: 'b'.repeat(40), notice: 'Git 已核对，项目测试另见整合会话。' } };
      if (action === 'Apply') { f.row = { ...row, revision: 4, status: 'succeeded', finalHead: 'b'.repeat(40) }; if (f.fail) throw Error('lost reply'); }
      if (action === 'Start') f.row = { ...row, startRequestId: 'started' };
      f.callbacks.forEach(cb => cb(f.row, 'local')); return f.row;
    };
    api.onProjectMergeUpdated = cb => { f.callbacks.add(cb); return () => { f.callbacks.delete(cb); }; };
    api.onTaskWorkspaceUpdated = () => () => {};
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.followupSuggestionSettings = async () => ({ version: 1, enabled: false });
    createRoot(document.getElementById('root')!).render(React.createElement(React.Fragment, null,
      React.createElement(ProjectTasksPanel, { session: 'main', executor: 'local', backendId: 'fake', backends: [], onOpenSession: (id: string) => f.opened.push(id) }),
      React.createElement(ChatInput, { sessionId: 'main', historyKey: 'main', isStreaming: false, activeBackendId: 'fake', backends: [], onSend: () => {}, onAbort: () => {} })));
    (window as any).mergeFixture = f;
  }, { dark });
}

for (const [width, dark] of [[1280, false], [390, true]] as const) test(`merge conflict and lost receipt retain draft (${width}, dark=${dark})`, async ({ page }) => {
  await mount(page, width, dark); await page.locator('.chat-textarea').fill('汇合后的下一步草稿');
  await page.getByRole('button', { name: '项目任务与汇合' }).click();
  await page.getByRole('button', { name: '成果汇合', exact: true }).click();
  await page.getByRole('button', { name: '发现项目会话' }).click();
  await page.getByLabel('来源会话', { exact: true }).selectOption('one');
  await page.getByLabel('目标会话', { exact: true }).selectOption('two');
  await page.getByRole('button', { name: '预览汇合计划' }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual([]);
  await page.getByRole('button', { name: '确认准备独立整合空间' }).click();
  await expect(page.getByRole('dialog')).toContainText('冲突：same.txt');
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toHaveCount(0);
  await page.getByRole('button', { name: '核对实际 Git 候选' }).click();
  await page.evaluate(() => { (window as any).mergeFixture.fail = true; });
  await page.getByRole('button', { name: '确认快进应用到目标' }).click();
  await page.getByRole('button', { name: '核对原操作', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('最终提交：' + 'b'.repeat(40));
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare', 'Verify', 'Apply']);
  await page.getByRole('button', { name: '返回对话' }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('汇合后的下一步草稿');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('fixed opinion source is lazy and missing source does not replace the excerpt', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { React, createRoot, OpinionReferencePreview, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = { calls: [] as any[], content: '【角色意见：同名角色｜报告 old-report v3｜来源 gone-session】\n原始异议' };
    api.reviewReferenceLookup = async (...args) => { f.calls.push(args); return { status: 'unavailable', notice: '源已不可访问；已发送摘录保持原样。' }; };
    const host = document.createElement('div'); document.body.append(host);
    createRoot(host).render(React.createElement(OpinionReferencePreview, { session: 'main', content: f.content }));
    (window as any).referenceFixture = f;
  });
  expect(await page.evaluate(() => (window as any).referenceFixture.calls)).toEqual([]);
  await page.getByRole('button', { name: /查看固定意见来源/ }).click();
  await expect(page.getByRole('status')).toContainText('源已不可访问');
  expect(await page.evaluate(() => (window as any).referenceFixture.calls)).toEqual([['main', 'gone-session', 'old-report', 3]]);
});

test('project buffer freeze covers nested sessions, rejects dirty text and requires reload after merge', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { DocumentStore } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const store = new DocumentStore();
    const identity = { ownerId: 'owner', executorInstance: 'node', sessionId: 'child', workingDir: 'C:/project/sub', workspaceRevision: 'r' };
    const target = { ...identity, sessionId: 'parent', workingDir: 'c:/PROJECT' };
    const client = { identity, read: async () => ({ document: { workspace: identity, relativePath: 'a.txt', source: 'executor' }, text: 'original', editable: true, canSave: true }), save: async () => ({}), saveGet: async () => ({}) } as any;
    const doc = await store.open(client, 'a.txt'); store.edit(doc.key, 'unsaved');
    const rejectsDirty = !store.freezeProject('one', target);
    store.edit(doc.key, 'original'); const frozen = store.freezeProject('two', target, 'operation');
    let rejected = false; try { store.edit(doc.key, 'must not edit'); } catch { rejected = true; }
    store.releaseProject('two', true);
    const requiresReload = store.get(doc.key)?.read?.editable === false;
    await store.open(client, 'a.txt', true); store.edit(doc.key, 'after reload');
    return { rejectsDirty, frozen, rejected, requiresReload, final: store.get(doc.key)?.text };
  });
  expect(result).toEqual({ rejectsDirty: true, frozen: true, rejected: true, requiresReload: true, final: 'after reload' });
});
