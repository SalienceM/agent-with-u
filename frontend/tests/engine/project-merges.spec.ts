import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1200, dark = false, fixedTarget = false) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async ({ dark, fixedTarget }) => {
    const { React, createRoot, ProjectTasksPanel, ChatInput, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    document.documentElement.style.setProperty('--theme-bg-secondary', dark ? '#222' : '#fff');
    document.documentElement.style.setProperty('--theme-text', dark ? '#eee' : '#222');
    document.documentElement.style.setProperty('--theme-bg', dark ? '#191b20' : '#f4f6fa');
    document.documentElement.style.setProperty('--theme-text-muted', dark ? '#b6becb' : '#687487');
    document.documentElement.style.setProperty('--theme-border', dark ? '#424854' : '#dce1e8');
    document.documentElement.style.setProperty('--theme-panel-solid', dark ? '#191b20' : '#fff');
    const f = { actions: [] as string[], requests: [] as string[], previews: 0, opened: [] as string[], row: null as any, callbacks: new Set<any>(), fail: false, reads: 0,
      canVerify: false, conflict: true, diagnostics: [] as any[], tests: { state: 'unknown', items: [] }, extra: [] as any[], online: true, supported: true, connection: (_: boolean) => {}, receipt: 'succeeded' };
    const repo = { root: 'C:/test/main', commonDir: 'C:/test/main/.git', repositoryId: 'repo', head: 'a'.repeat(40), branch: 'main', fingerprint: 'repo', dirty: [] };
    api.collaborationList = async (_s, _e, kind) => ({ items: kind === 'merge' && f.row ? [f.row] : [], nextOffset: null });
    api.projectMergeDiscover = async () => ({ items: [{ id: 'one', title: '需求', workingDir: 'C:/test/one' }, { id: 'two', title: '需求', workingDir: 'C:/test/two' }], truncated: false });
    api.projectMergeCapabilities = async () => ({ mergeWorkflow: f.supported ? 1 : 0, branchSync: f.supported ? 1 : 0, branchGraph: 1 });
    api.onExecutorConnectionStatus = (_e, callback) => { f.connection = callback; callback(f.online); return () => {}; };
    api.collaborationRequestStatus = async () => ({ status: f.receipt });
    api.projectMergeOperations = async () => ({ items: [...(f.row ? [{ ...f.row, originSessionId: f.row.sourceSessionId, sourceSessionId: f.row.source.sessionId, targetSessionId: f.row.target.sessionId, sourceHead: f.row.source.head, targetHead: f.row.target.head }] : []), ...f.extra], nextOffset: null });
    api.projectMergeInspect = async () => { f.reads++; return { ...f.row, workflow: { version: 1, checkedAt: 1, sides: { integration: { head: f.row?.candidate || 'b'.repeat(40), state: 'known', activity: [], dirty: [] } }, diagnostics: f.diagnostics,
      gitVerified: f.row?.verification.status === 'git_verified', canAutoVerify: f.canVerify, tests: f.tests } } as any; };
    api.projectMergePreview = async (_s, _e, source, target, request) => { f.previews++; return f.row = { id: request, revision: 1, sourceSessionId: 'main', title: '需求 → 需求', status: 'preview', planFingerprint: 'frozen', files: ['same.txt'], blockers: [], direction: target === 'main' ? 'sync_main' : 'merge', fastForward: target === 'main',
      source: { ...repo, root: 'C:/test/one', sessionId: source, title: '需求' }, target: { ...repo, sessionId: target, title: '需求' },
      integrationConfig: { backendId: 'fake', skipPermissions: false }, policy: '独立整合空间，仅快进目标', verification: { status: 'not_run', notice: '项目测试尚未运行' } }; };
    api.projectMergeStatus = async () => { f.reads++; return f.row; };
    api.projectMergeAction = async (_s, _e, action, row, request) => {
      f.actions.push(action);
      f.requests.push(request);
      if (action === 'Prepare') f.row = { ...row, revision: 2, status: f.conflict ? 'conflict' : 'candidate', candidate: f.conflict ? '' : 'b'.repeat(40), integration: { sessionId: 'integration', root: 'C:/test/integration', conflicts: f.conflict ? ['same.txt'] : [] } };
      if (action === 'Verify') f.row = { ...row, revision: row.revision + 1, status: 'candidate', candidate: 'b'.repeat(40), integration: { ...row.integration, conflicts: [] }, verification: { status: 'git_verified', head: 'b'.repeat(40), notice: 'Git 已核对，项目测试另见整合会话。' } };
      if (action === 'Apply') { f.row = { ...row, revision: 4, status: 'succeeded', finalHead: 'b'.repeat(40) }; if (f.fail) throw Error('lost reply'); }
      if (action === 'Start') f.row = { ...row, startRequestId: 'started' };
      delete f.row.workflow;
      f.callbacks.forEach(cb => cb(f.row, 'local')); return f.row;
    };
    api.onProjectMergeUpdated = cb => { f.callbacks.add(cb); return () => { f.callbacks.delete(cb); }; };
    api.onTaskWorkspaceUpdated = () => () => {};
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.followupSuggestionSettings = async () => ({ version: 1, enabled: false });
    createRoot(document.getElementById('root')!).render(React.createElement(React.Fragment, null,
      React.createElement(ProjectTasksPanel, { session: 'main', executor: 'local', backendId: 'fake', backends: [], mergeTarget: fixedTarget ? 'two' : undefined, onOpenSession: (id: string) => f.opened.push(id) }),
      React.createElement(ChatInput, { sessionId: 'main', historyKey: 'main', isStreaming: false, activeBackendId: 'fake', backends: [], onSend: () => {}, onAbort: () => {} })));
    (window as any).mergeFixture = f;
  }, { dark, fixedTarget });
}

for (const [width, dark] of [[1280, false], [390, true]] as const) test(`merge conflict and lost receipt retain draft (${width}, dark=${dark})`, async ({ page }, testInfo) => {
  await mount(page, width, dark); await page.locator('.chat-textarea').fill('汇合后的下一步草稿');
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '合并记录', exact: true }).click();
  await page.getByRole('button', { name: '发现项目会话' }).click();
  await page.getByLabel('来源会话', { exact: true }).selectOption('one');
  await page.getByLabel('目标会话', { exact: true }).selectOption('two');
  await page.getByRole('button', { name: '预览汇合计划' }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual([]);
  await page.getByRole('button', { name: '确认准备独立整合空间' }).click();
  await expect(page.getByRole('dialog')).toContainText('冲突：same.txt');
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toHaveCount(0);
  await page.getByRole('button', { name: '核对实际 Git 候选' }).click();
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('merge-candidate.png'), fullPage: true });
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

test('failed apply offers recheck of the same candidate without recreating or applying it', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '合并记录', exact: true }).click();
  await page.getByRole('button', { name: '发现项目会话' }).click();
  await page.getByLabel('来源会话', { exact: true }).selectOption('one');
  await page.getByLabel('目标会话', { exact: true }).selectOption('two');
  await page.getByRole('button', { name: '预览汇合计划' }).click();
  await page.getByRole('button', { name: '确认准备独立整合空间' }).click();
  await page.getByRole('button', { name: '核对实际 Git 候选' }).click();
  await page.evaluate(() => {
    const f = (window as any).mergeFixture;
    f.row = { ...f.row, status: 'error', applyRequestId: 'failed-apply', revision: 4, notice: '目标编辑缓冲核对超时，尚未开始 Git 合并' };
    f.callbacks.forEach((cb: any) => cb(f.row, 'local'));
  });
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toHaveCount(0);
  await page.getByRole('button', { name: '重新核对原候选' }).click();
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare', 'Verify', 'Verify']);
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

async function openPrepared(page: Page) {
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '合并记录', exact: true }).click();
  await page.getByRole('button', { name: '发现项目会话' }).click();
  await page.getByLabel('来源会话', { exact: true }).selectOption('one');
  await page.getByLabel('目标会话', { exact: true }).selectOption('two');
  await page.getByRole('button', { name: '预览汇合计划' }).click();
  await page.getByRole('button', { name: '确认准备独立整合空间' }).click();
  await expect(page.getByRole('button', { name: '明确启动冲突修复与验证' })).toBeEnabled();
}

test('return restores operation, bounded automatic verification ignores duplicate events and never applies', async ({ page }) => {
  await mount(page); await openPrepared(page);
  await page.locator('button').filter({ hasText: '返回对话' }).click();
  await page.evaluate(() => {
    const f = (window as any).mergeFixture;
    f.canVerify = true; f.row.status = 'candidate'; f.row.candidate = 'b'.repeat(40); f.row.revision++;
  });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeEnabled();
  await page.evaluate(() => { const f = (window as any).mergeFixture; for (let i = 0; i < 20; i++) f.callbacks.forEach((cb: any) => cb(f.row, 'local')); });
  await page.getByRole('button', { name: '核对原操作', exact: true }).click();
  expect(await page.evaluate(() => ({ actions: (window as any).mergeFixture.actions, previews: (window as any).mergeFixture.previews })))
    .toEqual({ actions: ['Prepare', 'Verify'], previews: 1 });
  await expect(page.getByRole('dialog')).toContainText('项目测试：未验证');
  await page.getByRole('button', { name: '返回对话' }).click();
  await expect(page.getByRole('button', { name: '分支副本与合并' })).toBeFocused();
});

test('repair starts only explicitly and returns to the same operation', async ({ page }) => {
  await mount(page); await openPrepared(page);
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare']);
  await page.getByRole('button', { name: '明确启动冲突修复与验证' }).click();
  await expect(page.getByRole('button', { name: '明确启动冲突修复与验证' })).toHaveCount(0);
  await page.getByRole('button', { name: '打开处理空间', exact: true }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.opened)).toEqual(['integration']);
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.canVerify = true; f.row.revision++; });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeEnabled();
  expect(await page.evaluate(() => ({ actions: (window as any).mergeFixture.actions, previews: (window as any).mergeFixture.previews }))).toEqual({ actions: ['Prepare', 'Start', 'Verify'], previews: 1 });
});

test('hidden and offline boundaries only verify after a fresh visible read', async ({ page }) => {
  await mount(page); await openPrepared(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const f = (window as any).mergeFixture; f.canVerify = true; f.row.revision++;
    f.callbacks.forEach((cb: any) => cb(f.row, 'local')); f.connection(false);
  });
  await expect(page.getByRole('dialog')).toContainText('执行节点离线');
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare']);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare']);
  await page.evaluate(() => (window as any).mergeFixture.connection(true));
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare', 'Verify']);
});

test('target buffer diagnostics navigate exact file and retain failed test evidence', async ({ page }) => {
  await mount(page); await openPrepared(page);
  await page.getByRole('button', { name: '核对实际 Git 候选' }).click();
  await page.evaluate(() => {
    const f = (window as any).mergeFixture;
    f.diagnostics = [{ side: 'target', code: 'buffer_dirty', sessionId: 'two', root: 'C:/test/main', notice: '未保存编辑缓冲', paths: [{ path: 'target.txt', status: 'buffer' }] }];
    f.tests = { state: 'failed', items: [{ name: 'unit', candidate: 'b'.repeat(40), state: 'failed', exitCode: 1, finishedAt: 1, source: 'executor', logRef: 'logs/unit.log' }] };
    window.addEventListener('awu:merge-file-focus', (event: any) => { f.file = event.detail; });
    f.row.revision++; f.callbacks.forEach((cb: any) => cb(f.row, 'local'));
  });
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('存在失败');
  await page.getByText('查看目标 Session 的文件（1）', { exact: true }).click();
  await page.getByRole('button', { name: 'target.txt', exact: true }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.file)).toEqual({ executor: 'local', sessionId: 'two', workingDir: 'C:/test/main', relativePath: 'target.txt' });
  expect(await page.evaluate(() => (window as any).mergeFixture.opened)).toEqual(['two']);
});

test('multiple unfinished records require selection; related parent is read only until original entry is opened', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).mergeFixture;
    await api.projectMergePreview('main', 'local', 'one', 'two', 'seed'); f.row.sourceSessionId = 'one';
    f.extra = [{ ...f.row, id: 'second', title: '另一个未完成记录', originSessionId: 'one' }];
  });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '合并记录', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('请选择要继续的合并');
  await page.getByRole('button', { name: /需求 → 需求 · 待确认准备/ }).click();
  await expect(page.getByRole('button', { name: '确认准备独立整合空间' })).toBeDisabled();
  await page.getByRole('button', { name: '返回原合并入口' }).click();
  await expect(page.getByRole('button', { name: '确认准备独立整合空间' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual([]);
});

test('unknown Apply keeps its intent through reopen and reconnect without resubmission', async ({ page }) => {
  await mount(page); await openPrepared(page);
  await page.getByRole('button', { name: '核对实际 Git 候选' }).click();
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).mergeFixture; const action = api.projectMergeAction;
    f.receipt = 'unknown';
    api.projectMergeAction = async (...args) => {
      if (args[2] !== 'Apply') return action(...args);
      f.actions.push('Apply'); f.requests.push(args[4]); throw Error('lost before acknowledgement');
    };
  });
  await page.getByRole('button', { name: '确认快进应用到目标' }).dblclick();
  await expect(page.getByRole('dialog')).toContainText('保留原 requestId');
  await page.getByRole('button', { name: '返回对话' }).click();
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeDisabled();
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.connection(false); });
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.connection(true); });
  await page.getByRole('button', { name: '核对原操作', exact: true }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions.filter((action: string) => action === 'Apply').length)).toBe(1);
});

test('legacy node keeps its original history and never auto verifies', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).mergeFixture.supported = false; });
  await openPrepared(page);
  await page.getByRole('button', { name: '返回对话' }).click();
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await expect(page.getByRole('dialog')).toContainText('只支持原发起 Session 历史');
  await expect(page.getByRole('dialog')).toContainText('冲突：same.txt');
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare']);
});

test('late inspection cannot replace a newer verified candidate', async ({ page }) => {
  await mount(page); await openPrepared(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).mergeFixture, inspect = api.projectMergeInspect;
    api.projectMergeInspect = async (...args) => {
      const snapshot = structuredClone(await inspect(...args));
      await new Promise<void>(resolve => { f.finishRead = resolve; });
      return snapshot;
    };
  });
  await page.getByRole('button', { name: '核对原操作', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).mergeFixture.finishRead)).toBe('function');
  await page.getByRole('button', { name: '核对实际 Git 候选' }).click();
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeVisible();
  await page.evaluate(() => (window as any).mergeFixture.finishRead());
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare', 'Verify']);
});

for (const [width, dark] of [[1280, true], [390, false]] as const) test(`clean merge needs two confirmations in one panel (${width}, dark=${dark})`, async ({ page }, testInfo) => {
  await mount(page, width, dark);
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.conflict = false; f.canVerify = true; });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '合并记录', exact: true }).click();
  await page.getByRole('button', { name: '发现项目会话' }).click();
  await page.getByLabel('来源会话', { exact: true }).selectOption('one');
  await page.getByLabel('目标会话', { exact: true }).selectOption('two');
  await page.getByRole('button', { name: '预览汇合计划' }).click();
  await expect(page.getByRole('dialog')).toContainText('第一次确认');
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual([]);
  await page.getByRole('button', { name: '确认准备独立整合空间' }).click();
  await expect(page.getByRole('button', { name: '确认快进应用到目标' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare', 'Verify']);
  await page.screenshot({ path: testInfo.outputPath('clean-merge.png'), fullPage: true });
  await page.getByRole('button', { name: '确认快进应用到目标' }).click();
  await expect(page.getByRole('dialog')).toContainText('已更新原目标 需求 的 main 分支');
  expect(await page.evaluate(() => (window as any).mergeFixture.actions)).toEqual(['Prepare', 'Verify', 'Apply']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

async function seedBlocked(page: Page) {
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).mergeFixture;
    await api.projectMergePreview('main', 'local', 'main', 'two', 'blocked-original');
    f.row.status = 'blocked'; f.row.files = []; f.row.blockers = ['目标有未提交文件'];
    f.row.source.title = 'AgentWithU-维护 · 副本'; f.row.target.title = 'AgentWithU-维护';
    f.diagnostics = [{ side: 'target', code: 'git_dirty', sessionId: 'two', root: 'C:/test/main', notice: '有 Git 未提交文件',
      paths: Array.from({ length: 48 }, (_, i) => ({ path: `frontend/src/components/changed-${i}.tsx`, status: ' M', worktree: true })) }];
    document.documentElement.style.setProperty('--theme-bg-secondary', 'rgba(20, 24, 28, 0.2)');
    document.body.style.background = 'repeating-linear-gradient(45deg, #183955 0 30px, #a58464 30px 60px)';
  });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '合并到主 Session', exact: true }).click();
}

for (const [width, height, dark] of [[1314, 738, true], [390, 844, false]] as const) test(`blocked merge exposes recovery above long file list (${width}, dark=${dark})`, async ({ page }, testInfo) => {
  await mount(page, width, dark, true); await page.setViewportSize({ width, height });
  await seedBlocked(page);
  const panel = page.getByRole('region', { name: '连续合并流程' });
  await expect(panel.getByLabel('下一步')).toContainText('主 Session 有未提交文件');
  await expect(panel).toContainText('未提交改动尚未计入');
  await expect(panel).not.toContainText('查看变化 → 确认准备');
  await expect(page.getByRole('button', { name: '打开主 Session 处理' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '重新预览合并', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '核对原操作', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'frontend/src/components/changed-0.tsx', exact: true })).not.toBeVisible();
  expect(await page.getByRole('dialog').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(dark ? 'rgb(25, 27, 32)' : 'rgb(255, 255, 255)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('blocked-next-action.png'), fullPage: true });
  await page.getByRole('button', { name: '打开主 Session 处理' }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.opened)).toEqual(['two']);
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.diagnostics = []; f.row.revision++; });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '重新预览合并', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认准备独立整合空间' })).toBeEnabled();
  expect(await page.evaluate(() => {
    const f = (window as any).mergeFixture;
    return { actions: f.actions, previews: f.previews, newPlan: f.row.id !== 'blocked-original', source: f.row.source.sessionId, target: f.row.target.sessionId };
  })).toEqual({ actions: [], previews: 2, newPlan: true, source: 'main', target: 'two' });
});

test('blocked recovery cannot repreview a related or unknown operation', async ({ page }) => {
  await mount(page, 1200, false, true); await seedBlocked(page);
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.row.sourceSessionId = 'one'; f.row.revision++; f.callbacks.forEach((cb: any) => cb(f.row, 'local')); });
  await expect(page.getByRole('button', { name: '返回原合并入口' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新预览合并', exact: true })).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.row.sourceSessionId = 'main'; f.row.status = 'unknown'; f.row.revision++; f.callbacks.forEach((cb: any) => cb(f.row, 'local')); });
  await expect(page.getByLabel('下一步')).toContainText('提交结果待核对');
  await expect(page.getByRole('button', { name: '重新预览合并', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({ actions: (window as any).mergeFixture.actions, previews: (window as any).mergeFixture.previews }))).toEqual({ actions: [], previews: 1 });
});

test('merge success offers sync back at the top and preserves both confirmations', async ({ page }) => {
  await mount(page, 1200, false, true);
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '合并到主 Session', exact: true }).click();
  await page.getByRole('button', { name: '预览合并到主 Session' }).click();
  await page.evaluate(() => { const f = (window as any).mergeFixture; f.row.status = 'succeeded'; f.row.finalHead = 'b'.repeat(40); f.row.revision++; f.callbacks.forEach((cb: any) => cb(f.row, 'local')); });
  const sync = page.getByLabel('下一步').getByRole('button', { name: '同步主干到此分支' });
  await expect(sync).toBeInViewport(); await sync.click();
  expect(await page.evaluate(() => { const f = (window as any).mergeFixture; return [f.row.source.sessionId, f.row.target.sessionId, f.actions, f.previews]; })).toEqual(['two', 'main', [], 2]);
  await expect(page.getByRole('dialog')).toContainText('可直接快进');
  await expect(page.getByRole('button', { name: '确认准备独立整合空间' })).toBeVisible();
  await page.evaluate(() => { (window as any).mergeFixture.conflict = false; });
  await page.getByRole('button', { name: '确认准备独立整合空间' }).click();
  await page.getByRole('button', { name: '核对实际 Git 候选', exact: true }).click();
  await page.getByRole('button', { name: '确认快进应用到目标' }).click();
  await expect(page.getByRole('button', { name: '返回此分支继续开发' })).toBeInViewport();
  await page.getByRole('button', { name: '返回此分支继续开发' }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.opened)).toEqual(['main']);
});

for (const [width, dark] of [[1280, false], [390, true]] as const) test(`branch graph connects real parents and commit details (${width})`, async ({ page }, testInfo) => {
  await mount(page, width, dark, true);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).mergeFixture; f.graphReads = 0; f.details = [];
    const sha = (s: string) => s.repeat(40);
    api.projectBranchGraph = async (session, executor) => {
      f.graphReads++; f.graphScope = [session, executor];
      return { version: 1, snapshot: 'one', checkedAt: 1000, root: 'C:/test/main', repositoryId: 'repo', limit: 80, hasMore: false, omittedBranches: 0,
        branches: [{ sessionId: 'two', title: '主项目', main: true, state: 'known', head: sha('d'), branch: 'main', ahead: 0, behind: 0 },
          { sessionId: 'main', title: '支付功能 B', main: false, state: 'known', head: sha('b'), branch: 'feature/payment', ahead: 0, behind: 2 }],
        commits: [['d', ['c', 'b'], '合并支付功能'], ['b', ['a'], '新增支付流程'], ['c', ['a'], '主干修复登录'], ['a', [], '项目基线']].map(([h, parents, message]) => ({ hash: sha(h as string), parents: (parents as string[]).map(sha), author: 'Developer', date: '2026-11-08T12:00:00+08:00', message: message as string })) };
    };
    api.gitShow = async (...args) => { f.details.push(args); return { message: '新增支付流程', stat: '', files: [{ path: 'payment.ts', status: 'added', added: 1, deleted: 0 }] }; };
    api.gitCommitFileDiff = async () => ({ diff: 'diff --git a/payment.ts b/payment.ts\n--- a/payment.ts\n+++ b/payment.ts\n@@ -0,0 +1 @@\n+export const pay = true;\n', binary: false });
  });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  expect(await page.evaluate(() => (window as any).mergeFixture.graphReads)).toBe(0);
  await page.getByRole('button', { name: '分支图', exact: true }).click();
  await expect(page.getByLabel('分支状态')).toContainText('领先 0 · 落后 2');
  await expect(page.locator('path[data-edge]')).toHaveCount(4);
  const merged = 'd'.repeat(40), side = 'b'.repeat(40);
  await expect(page.locator(`path[data-edge="${side}:${merged}"]`)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '刷新分支图' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '提交 aaaaaaaa 项目基线', exact: true })).toBeInViewport();
  expect(await page.getByRole('table', { name: '提交记录' }).evaluate(el => getComputedStyle(el).color)).toBe(dark ? 'rgb(238, 238, 238)' : 'rgb(34, 34, 34)');
  await page.screenshot({ path: testInfo.outputPath('branch-overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'bbbbbbbb', exact: true }).click();
  await expect(page.locator(`[data-node="${side}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'payment.ts · +1 −0' }).click();
  await expect(page.getByLabel('提交详情')).toContainText('export const pay = true;');
  expect(await page.evaluate(() => (window as any).mergeFixture.details)).toEqual([['C:/test/main', side, 'local']]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await page.evaluate(() => { const f = (window as any).mergeFixture; return [f.graphReads, f.actions, f.previews]; })).toEqual([1, [], 0]);
  await page.screenshot({ path: testInfo.outputPath('branch-graph.png'), fullPage: true });
  await page.getByRole('button', { name: '合并与同步', exact: true }).click();
  await expect(page.getByRole('button', { name: '同步主干到此分支', exact: true })).toBeVisible();
  expect(await page.evaluate(() => { const f = (window as any).mergeFixture; return [f.actions, f.previews, f.graphScope]; })).toEqual([[], 0, ['main', 'local']]);
});

test('branch graph reports unsupported and read failures without a fallback node', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.projectMergeCapabilities = async () => ({ mergeWorkflow: 1 });
    api.projectBranchGraph = async () => { throw Error('offline graph'); };
  });
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await page.getByRole('button', { name: '分支图', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('此节点尚不支持分支图');
  await page.evaluate(async () => { const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts'); api.projectMergeCapabilities = async () => ({ branchGraph: 1 }); });
  await page.getByRole('button', { name: '刷新分支图' }).click();
  await expect(page.getByRole('alert')).toContainText('offline graph');
  await expect(page.getByRole('table', { name: '提交记录' })).toHaveCount(0);
});
