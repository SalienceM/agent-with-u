import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1200, sidebar = false, integration = false) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async ({ sidebar, integration }) => {
    const { React, createRoot, ProjectTasksPanel, Sidebar, ChatInput, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = { plans: [] as any[], created: [] as any[], started: [] as any[], opened: [] as string[], row: null as any, callbacks: new Set<any>(), fail: false, inspect: 0,
      nodes: [] as any[], merges: [] as any[], actions: [] as any[], mergeRow: null as any, activeSession: 'parent', render: () => {}, discarded: [] as any[], failDiscard: false, sessions: [] as any[], mergeCallbacks: new Set<any>() };
    const repo = { root: 'C:/fixture', commonDir: 'C:/fixture/.git', repositoryId: 'repo', head: 'a'.repeat(40), branch: 'main', fingerprint: 'source', dirty: [
      { path: 'same.txt', status: ' M', sha256: 'sha', bytes: 5, blocked: '' }, { path: '.env', status: '??', sha256: '', bytes: 5, blocked: '凭据路径' }] };
    api.taskWorkspaceInspect = async () => { f.inspect++; return { ...repo, status: 'ready', notice: '', defaults: {
      title: '主会话 · 副本', goal: '', backendId: 'fake', runtime: {}, constraints: '主会话约束', skills: ['local-skill'], skipPermissions: false,
      includePaths: [], snapshotMode: 'current', inheritSource: true } }; };
    api.collaborationList = async (_s, _e, kind) => ({ items: kind === 'merge' ? (f.mergeRow ? [f.mergeRow] : []) : (f.row && f.row.status !== 'discarded' ? [f.row] : []), nextOffset: null });
    api.taskWorkspacePlan = async (_s, _e, _request, config: any) => { f.plans.push(config); return f.row = { id: 'task', revision: 1, sessionId: 'child', sourceSessionId: 'parent', parentSessionId: 'parent', title: config.title,
      config, repository: repo, root: 'C:/managed/task', branch: 'awu/task/one', status: 'preview', planFingerprint: 'plan' }; };
    api.taskWorkspaceCreate = async (...args) => { f.created.push(args); f.row = { ...f.row, revision: 2, status: 'creating' }; if (f.fail) throw Error('lost'); return f.row; };
    api.taskWorkspaceStatus = async () => f.row;
    api.taskWorkspaceDiscardPreview = async (...args) => {
      f.discarded.push(args); f.row = { ...f.row, revision: 2, status: 'discarded' };
      if (f.failDiscard) throw Error('lost discard reply');
      f.callbacks.forEach(cb => cb(f.row, 'local')); return f.row;
    };
    api.taskWorkspaceStart = async (...args) => { f.started.push(args); return { status: 'succeeded', result: { notice: '启动已接收' } }; };
    api.onTaskWorkspaceUpdated = cb => { f.callbacks.add(cb); return () => { f.callbacks.delete(cb); }; };
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.followupSuggestionSettings = async () => ({ version: 1, enabled: false });
    const backends = [{ id: 'fake', type: 'openai-compatible', label: 'Fake' }];
    api.getBackends = async (node) => { f.nodes.push(node); return backends; };
    f.sessions = [{ id: 'parent', title: '主项目', workingDir: 'C:/fixture', backendId: 'fake', updatedAt: 1, execKey: 'relay:fixture', execLabel: '测试节点', pinned: true },
      { id: 'child', title: '功能副本', workingDir: 'C:/child', backendId: 'fake', updatedAt: 2, execKey: 'relay:fixture', execLabel: '测试节点', relationKind: 'task', parentSessionId: 'parent', workspaceId: 'workspace-child' },
      ...(integration ? [{ id: 'integration', title: '整合测试空间', workingDir: 'C:/integration', backendId: 'fake', updatedAt: 3, execKey: 'relay:fixture', relationKind: 'integration', parentSessionId: 'parent', workspaceId: 'integration',
        mergeLink: { operationId: 'op', originSessionId: 'child', sourceSessionId: 'child', targetSessionId: 'parent', status: 'conflict' } }] : [])];
    api.listSessions = async () => f.sessions;
    api.onProjectMergeUpdated = cb => { f.mergeCallbacks.add(cb); return () => { f.mergeCallbacks.delete(cb); }; };
    api.projectMergeStatus = async () => f.mergeRow;
    api.projectMergeCapabilities = async () => ({ mergeWorkflow: 0 });
    api.onExecutorConnectionStatus = (_e, callback) => { callback(true); return () => {}; };
    api.projectMergePreview = async (...args) => { f.merges.push(args); return f.mergeRow = { id: 'merge', revision: 1, sourceSessionId: 'child', title: '功能副本 → 主项目', status: 'preview', planFingerprint: 'fixed', files: ['same.txt'], blockers: [],
      source: { ...repo, sessionId: args[2], title: '功能副本' }, target: { ...repo, sessionId: args[3], title: '主项目' }, integrationConfig: { backendId: 'fake', skipPermissions: false }, verification: { status: 'not_run', notice: '未运行测试' }, policy: '独立准备后核对应用' }; };
    api.projectMergeAction = async (...args) => { f.actions.push(args); return args[3]; };
    const root = createRoot(document.getElementById('root')!);
    f.render = () => root.render(React.createElement(React.Fragment, null,
      sidebar ? React.createElement(Sidebar, { activeSessionId: f.activeSession, activeExecKey: 'relay:fixture', streamingSessions: new Set(), onSelectSession: (id: string) => { f.opened.push(id); f.activeSession = id; f.render(); }, onNewSession: () => {} }) :
        React.createElement(ProjectTasksPanel, { session: 'parent', executor: 'local', backendId: 'fake', backends, onOpenSession: (id: string) => f.opened.push(id) }),
      React.createElement(ChatInput, { sessionId: 'parent', historyKey: 'parent', activeBackendId: 'fake', backends, isStreaming: false, onSend: () => {}, onAbort: () => {} })));
    (window as any).taskFixture = f; f.render();
  }, { sidebar, integration });
}

for (const width of [1280, 390]) test(`non Git project shows a normal prerequisite and rechecks without creating (${width})`, async ({ page }, testInfo) => {
  await mount(page, width);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).taskFixture;
    f.restoreInspect = api.taskWorkspaceInspect;
    api.taskWorkspaceInspect = async () => {
      f.inspect++;
      return { status: 'unavailable', reason: 'not_git', notice: '当前项目尚未启用 Git',
        preparation: '分支副本需要 Git。启用 Git 并完成首次提交后，即可创建。' } as any;
    };
  });
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分支副本', exact: true });
  await expect(dialog).toContainText('当前项目尚未启用 Git');
  await expect(dialog).not.toContainText('独立分支，并行开发');
  await expect(dialog).not.toContainText('fatal:');
  await expect(dialog).not.toContainText('目录和分支自动分配');
  await expect(dialog.getByRole('button', { name: '创建副本', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '知道了', exact: true })).toBeVisible();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath(`non-git-${width}.png`), fullPage: true });
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.taskWorkspaceInspect = (window as any).taskFixture.restoreInspect;
  });
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(page.getByLabel('副本名称', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => {
    const f = (window as any).taskFixture;
    return { reads: f.inspect, plans: f.plans.length, creates: f.created.length, starts: f.started.length };
  })).toEqual({ reads: 2, plans: 0, creates: 0, starts: 0 });
});

for (const width of [1280, 390]) for (const kind of ['init', 'initial_commit'])
test(`uninitialized project creates in one explicit action (${kind}, ${width})`, async ({ page }) => {
  await mount(page, width);
  await page.evaluate(async kind => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const inspect = api.taskWorkspaceInspect, plan = api.taskWorkspacePlan;
    api.taskWorkspaceInspect = async (...args) => {
      const repo = await inspect(...args);
      return { ...repo, head: '', dirty: [], initialization: { kind, branch: 'main' },
        defaults: { ...repo.defaults!, initializeRepository: true } } as any;
    };
    api.taskWorkspacePlan = async (...args) => {
      const row = await plan(...args);
      row.repository = { ...row.repository, head: '', dirty: [], initialization: { kind, branch: 'main' } } as any;
      return row;
    };
  }, kind);
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  await expect(page.getByLabel('副本名称', { exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: '分支副本', exact: true });
  await expect(dialog).toContainText('用所选文件建立首次提交');
  expect(await page.evaluate(() => {
    const f = (window as any).taskFixture;
    return [f.plans.length, f.created.length, f.started.length];
  })).toEqual([0, 0, 0]);
  const action = dialog.getByRole('button', { name: kind === 'init' ? '启用 Git 并创建副本' : '建立首次提交并创建副本', exact: true });
  await expect(action).toBeEnabled();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  await action.click();
  await expect.poll(() => page.evaluate(() => (window as any).taskFixture.created.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).taskFixture.plans[0].initializeRepository)).toBe(true);
  expect(await page.evaluate(() => (window as any).taskFixture.started.length)).toBe(0);
});

test('inspection failures keep technical output in optional details', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.taskWorkspaceInspect = async () => ({ status: 'unavailable', reason: 'inspection_failed',
      notice: '暂时无法检查项目', preparation: '请查看详情，处理后重新检查。', detail: 'fatal: fixture permission denied' } as any);
  });
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  await expect(page.getByText('暂时无法检查项目', { exact: true })).toBeVisible();
  const details = page.getByRole('dialog').locator('details');
  await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open');
  await expect(details).toContainText('fixture permission denied');
});

for (const width of [1280, 390]) test(`compact copy form creates in one click with automatic directory (${width})`, async ({ page }, testInfo) => {
  await mount(page, width);
  await page.evaluate(async dark => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const inspect = api.taskWorkspaceInspect;
    api.taskWorkspaceInspect = async (...args) => {
      const repo = await inspect(...args);
      return { ...repo, dirty: [], defaults: { ...repo.defaults!, skills: Array.from({ length: 30 }, (_, i) => `skill-${i}`), constraints: '长约束'.repeat(200) } };
    };
    const theme = { '--theme-bg-secondary': dark ? '#151b25' : '#fff', '--theme-text': dark ? '#e6edf3' : '#222', '--theme-bg': dark ? '#0d1117' : '#f4f6fa', '--theme-text-muted': dark ? '#9ba8bb' : '#687487', '--theme-border': dark ? '#303b4c' : '#dce1e8', '--theme-panel-solid': dark ? '#151b25' : '#fff' };
    Object.entries(theme).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
  }, width === 1280);
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分支副本', exact: true });
  await expect(page.getByLabel('副本名称', { exact: true })).toBeFocused();
  await expect(page.getByLabel('任务约束', { exact: true })).toBeHidden();
  await expect(page.getByLabel('项目文件范围', { exact: true })).toBeHidden();
  await expect(dialog.getByRole('button', { name: '合并', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '分支图', exact: true })).toHaveCount(0);
  await expect(dialog).toContainText('目录和分支自动分配');
  const create = dialog.getByRole('button', { name: '创建副本', exact: true });
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(562);
  expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(42);
  await page.getByLabel('副本名称', { exact: true }).fill('新功能对话');
  await page.getByLabel('初始需求', { exact: true }).fill('创建后由我开始');
  await page.screenshot({ path: testInfo.outputPath('copy-form.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width, height: 560 });
  const actionBounds = (await create.boundingBox())!;
  expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(560);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('copy-form-short.png'), fullPage: true, animations: 'disabled' });
  await create.click();
  await expect(dialog).toContainText('正在创建');
  expect(await page.evaluate(() => {
    const f = (window as any).taskFixture;
    return { plans: f.plans.length, name: f.plans[0].title, skills: f.plans[0].skills.length, source: f.plans[0].inheritSource,
      snapshot: f.plans[0].snapshotMode, created: f.created.length, fingerprint: f.created[0][4], opened: f.opened, started: f.started };
  })).toEqual({ plans: 1, name: '新功能对话', skills: 30, source: true, snapshot: 'current', created: 1, fingerprint: 'plan', opened: [], started: [] });
  await page.evaluate(() => {
    const f = (window as any).taskFixture; f.row = { ...f.row, status: 'ready', revision: 3 };
    f.callbacks.forEach((cb: any) => cb(f.row, 'local'));
  });
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).taskFixture.opened)).toEqual(['child']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('failed copy planning preserves the form and never submits creation', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.taskWorkspacePlan = async () => { throw Error('项目内容已变化，请重新检查'); };
  });
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  await page.getByLabel('副本名称', { exact: true }).fill('保留我的配置');
  await page.getByLabel('项目文件范围', { exact: true }).selectOption('selected');
  await page.getByRole('button', { name: '创建副本', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('项目内容已变化');
  await expect(page.getByLabel('副本名称', { exact: true })).toHaveValue('保留我的配置');
  expect(await page.evaluate(() => {
    const f = (window as any).taskFixture;
    return { created: f.created, started: f.started, opened: f.opened };
  })).toEqual({ created: [], started: [], opened: [] });
});

test('closing during plan preparation cannot reopen a completed copy on a later visit', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const plan = api.taskWorkspacePlan;
    api.taskWorkspacePlan = (...args) => new Promise(resolve => { (window as any).finishPlan = async () => resolve(await plan(...args)); });
  });
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  await page.getByLabel('项目文件范围', { exact: true }).selectOption('selected');
  await page.getByRole('button', { name: '创建副本', exact: true }).click();
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.evaluate(async () => { await (window as any).finishPlan(); });
  await expect.poll(() => page.evaluate(() => (window as any).taskFixture.created.length)).toBe(1);
  await page.evaluate(() => {
    const f = (window as any).taskFixture; f.row = { ...f.row, status: 'ready', revision: 3 };
    f.callbacks.forEach((cb: any) => cb(f.row, 'local'));
  });
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开副本 Session' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).taskFixture.opened)).toEqual([]);
});

for (const width of [1280, 390]) test(`sidebar branch copies keep family together and merge to parent (${width})`, async ({ page }) => {
  await mount(page, width, true);
  const parent = page.locator('[aria-haspopup="menu"]').filter({ hasText: '主项目' });
  const child = page.locator('[aria-haspopup="menu"]').filter({ hasText: '功能副本' });
  await expect(parent).toHaveCount(1); await expect(child).toHaveCount(0);
  await page.getByRole('button', { name: '展开 主项目 的子 Session' }).click();
  await expect(parent.locator('..')).toContainText('功能副本');
  await child.getByText('功能副本', { exact: true }).click();
  expect(await page.evaluate(() => (window as any).taskFixture.opened)).toEqual(['child']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '收起 主项目 的子 Session' }).click();
  await expect(child).toHaveCount(0);
  await page.evaluate(() => (window as any).taskFixture.render());
  await expect(child).toHaveCount(0);
  await parent.getByText('主项目', { exact: true }).click();
  await page.evaluate(() => { const f = (window as any).taskFixture; f.activeSession = 'child'; f.render(); });
  await expect(child).toBeVisible();
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新建分支副本' }).click();
  await expect(page.getByLabel('副本名称', { exact: true })).toHaveValue('主会话 · 副本');
  expect(await page.evaluate(() => (window as any).taskFixture.nodes)).toContain('relay:fixture');
  expect(await page.evaluate(() => (window as any).taskFixture.created)).toEqual([]);
  await page.getByRole('button', { name: '返回对话' }).click();
  await child.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /重命名/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /绑定能力/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '新建分支副本' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '合并到主 Session', exact: true }).click();
  await expect(page.getByRole('button', { name: '发现项目会话' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建分支副本' })).toHaveCount(0);
  await page.getByRole('button', { name: '预览合并到主 Session' }).click();
  const calls = await page.evaluate(() => (window as any).taskFixture.merges);
  expect(calls).toHaveLength(1); expect(calls[0].slice(0, 4)).toEqual(['child', 'relay:fixture', 'child', 'parent']);
  expect(await page.evaluate(() => (window as any).taskFixture.actions)).toEqual([]);
  await expect(page.getByRole('button', { name: '确认准备独立整合空间' })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText('Error:');
  await page.screenshot({ path: `../.qa/session-branches/merge-${width}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

for (const closeEarly of [false, true]) test(`new child opens as a Session only after ready; closed dialog stays closed (${closeEarly})`, async ({ page }) => {
  await mount(page, 1200, true);
  await page.locator('[aria-haspopup="menu"]').filter({ hasText: '主项目' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新建分支副本' }).click();
  await page.getByLabel('项目文件范围', { exact: true }).selectOption('selected');
  await page.getByText('更多设置', { exact: true }).click();
  await page.getByRole('button', { name: '预览副本创建计划' }).click();
  await page.getByRole('button', { name: '创建副本' }).click();
  await expect(page.getByRole('dialog', { name: '分支副本', exact: true })).toContainText('正在创建');
  expect(await page.evaluate(() => (window as any).taskFixture.opened)).toEqual([]);
  if (closeEarly) await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.evaluate(() => {
    const f = (window as any).taskFixture; f.row = { ...f.row, status: 'ready', revision: 3 };
    f.callbacks.forEach((cb: any) => cb(f.row, 'relay:fixture'));
  });
  await expect(page.getByRole('dialog', { name: '分支副本', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).taskFixture.opened)).toEqual(closeEarly ? [] : ['child']);
  expect(await page.evaluate(() => (window as any).taskFixture.started)).toEqual([]);
  if (!closeEarly) await expect(page.locator('[aria-haspopup="menu"]').filter({ hasText: '功能副本' })).toBeVisible();
});

for (const [width, lost] of [[1280, false], [390, true]] as const) test(`discard an uncreated preview preserves ready Sessions and draft (${width}, lost=${lost})`, async ({ page }) => {
  await mount(page, width);
  await page.locator('.chat-textarea').fill('保留主会话草稿');
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  await page.getByLabel('项目文件范围', { exact: true }).selectOption('selected');
  await page.getByText('更多设置', { exact: true }).click();
  await page.getByRole('button', { name: '预览副本创建计划' }).click();
  await page.evaluate(async lost => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).taskFixture; f.failDiscard = lost;
    f.stale = { ...f.row }; f.kept = { ...f.row, id: 'kept', sessionId: 'kept-session', title: '已创建的副本', status: 'ready' };
    api.collaborationList = async () => ({ items: [f.row, f.kept].filter(row => row.status !== 'discarded'), nextOffset: null });
    api.taskWorkspaceStatus = async (_s, _e, id) => id === 'kept' ? f.kept : f.row;
  }, lost);
  await page.getByRole('button', { name: '移除预览', exact: true }).click();
  if (lost) {
    await expect(page.getByRole('status')).toContainText('移除结果未知');
    await expect(page.getByRole('button', { name: '移除预览', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '创建副本' })).toBeDisabled();
    await page.getByRole('button', { name: '核对副本状态' }).click();
  }
  const current = page.getByRole('region', { name: '当前分支副本' });
  await expect(page.getByRole('navigation', { name: '分支副本记录' })).toHaveCount(0);
  await expect(current).not.toContainText('待确认创建');
  await expect(current).toContainText('已创建的副本');
  // 旧在途列表即使晚到，也不能让已移除的预览重新出现。
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts'); const f = (window as any).taskFixture;
    api.collaborationList = async () => ({ items: [f.stale, f.kept], nextOffset: null });
  });
  await page.getByRole('button', { name: '核对副本状态' }).click();
  await expect(current).not.toContainText('待确认创建');
  await expect(page.getByRole('button', { name: '打开副本 Session' })).toBeVisible();
  await expect(page.getByRole('button', { name: '移除预览', exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).taskFixture.discarded);
  expect(calls).toHaveLength(1); expect(calls[0].slice(0, 3)).toEqual(['parent', 'local', 'task']); expect(calls[0][4]).toBe('plan');
  expect(await page.evaluate(() => (window as any).taskFixture.created)).toEqual([]);
  expect(await page.evaluate(() => (window as any).taskFixture.started)).toEqual([]);
  await page.getByRole('button', { name: '返回对话' }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('保留主会话草稿');
});

for (const width of [1280, 390]) test(`copy page shows only the latest record without a history column (${width})`, async ({ page }, testInfo) => {
  await mount(page, width);
  await page.evaluate(async dark => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).taskFixture;
    const base = await api.taskWorkspacePlan('parent', 'local', 'fixture', { title: '最新副本', goal: '', backendId: 'fake', runtime: {}, constraints: '', skills: [], skipPermissions: false, includePaths: [] });
    f.plans = []; f.statusReads = []; f.listReads = [];
    f.records = [{ ...base, id: 'latest', status: 'ready', updatedAt: 3 }, { ...base, id: 'old-preview', title: '旧创建预览', updatedAt: 2 }, { ...base, id: 'old-copy', title: '旧副本', status: 'ready', updatedAt: 1 }];
    api.collaborationList = async (_s, _e, _kind, offset) => { f.listReads.push(offset || 0); return { items: f.records, nextOffset: 50 }; };
    api.taskWorkspaceStatus = async (_s, _e, id) => { f.statusReads.push(id); return f.records.find((row: any) => row.id === id); };
    const theme = { '--theme-bg-secondary': dark ? '#222' : '#fff', '--theme-text': dark ? '#eee' : '#222', '--theme-bg': dark ? '#191b20' : '#f4f6fa', '--theme-text-muted': dark ? '#b6becb' : '#687487', '--theme-border': dark ? '#424854' : '#dce1e8', '--theme-panel-solid': dark ? '#191b20' : '#fff' };
    Object.entries(theme).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
  }, width === 1280);
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  const current = page.getByRole('region', { name: '当前分支副本' });
  await expect(current.getByRole('heading', { name: '最新副本 · 工作区就绪' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '分支副本记录' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更多任务' })).toHaveCount(0);
  await expect(current).not.toContainText('旧创建预览');
  await expect(current).not.toContainText('旧副本');
  expect(await page.evaluate(() => (window as any).taskFixture.statusReads)).toEqual(['latest']);
  const panelBounds = await page.getByRole('dialog', { name: '分支副本', exact: true }).boundingBox();
  const detailBounds = await current.boundingBox();
  expect(detailBounds!.width).toBeGreaterThan(panelBounds!.width - 5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('latest-copy.png'), fullPage: true, animations: 'disabled' });
  // 事件更新最新记录，但结果未知时继续核对原记录，不被另一条记录挤走。
  await page.evaluate(() => {
    const f = (window as any).taskFixture;
    f.records.unshift({ ...f.records[0], id: 'newer', title: '新到副本', status: 'unknown', updatedAt: 4 });
    f.callbacks.forEach((cb: any) => cb(f.records[0], 'local'));
  });
  await expect(current.getByRole('heading', { name: '新到副本 · 结果未知' })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).taskFixture;
    f.records.unshift({ ...f.records[0], id: 'newest', title: '下一条副本', status: 'ready', updatedAt: 5 });
    f.callbacks.forEach((cb: any) => cb(f.records[0], 'local'));
  });
  await page.getByRole('button', { name: '核对副本状态' }).click();
  await expect(current.getByRole('heading', { name: '新到副本 · 结果未知' })).toBeVisible();
  await expect(current).not.toContainText('下一条副本');
  await page.evaluate(() => {
    const f = (window as any).taskFixture, row = f.records.find((r: any) => r.id === 'newer');
    row.status = 'ready'; row.revision++;
    f.callbacks.forEach((cb: any) => cb(row, 'local'));
  });
  await expect(current.getByRole('heading', { name: '下一条副本 · 工作区就绪' })).toBeVisible();
  expect(await page.evaluate(() => { const f = (window as any).taskFixture; return { pages: f.listReads.every((offset: number) => offset === 0), records: f.records.length, created: f.created, started: f.started, discarded: f.discarded }; })).toEqual({ pages: true, records: 5, created: [], started: [], discarded: [] });
});

test('legacy nested sessions flatten without leaking collapsed descendants or cross-node parents', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { taskSessionTree } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const rows = [{ id: 'root' }, { id: 'child', parentSessionId: 'root', relationKind: 'task' },
      { id: 'grandchild', parentSessionId: 'child', relationKind: 'integration' },
      { id: 'remote', parentSessionId: 'root', relationKind: 'task', execKey: 'other' }];
    return { full: taskSessionTree(rows, new Set(), false).map(row => [row.item.id, row.depth]),
      collapsed: taskSessionTree(rows, new Set(['local:root']), false).map(row => row.item.id) };
  });
  expect(result.full).toEqual([['root', 0], ['child', 1], ['grandchild', 1], ['remote', 0]]);
  expect(result.collapsed).toEqual(['root', 'remote']);
});

test('associated integration projection keeps copy counts, search, favorites and orphan recovery', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { taskSessionTree, projectTaskSessions } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const link = { operationId: 'op', originSessionId: 'child', sourceSessionId: 'child', targetSessionId: 'root', status: 'succeeded' };
    const rows = [{ id: 'root' }, { id: 'child', parentSessionId: 'root', relationKind: 'task' },
      { id: 'integration', parentSessionId: 'root', relationKind: 'integration', mergeLink: link },
      { id: 'legacy', parentSessionId: 'root', relationKind: 'integration' },
      { id: 'pinned', pinned: true, parentSessionId: 'root', relationKind: 'integration', mergeLink: link },
      { id: 'orphan', parentSessionId: 'gone', relationKind: 'integration', mergeLink: { ...link, targetSessionId: 'gone' } }];
    const normal = projectTaskSessions(rows);
    const tree = taskSessionTree(normal, new Set(), false);
    return { normal: normal.map(row => row.id), search: projectTaskSessions(rows, true).map(row => row.id),
      active: projectTaskSessions(rows, false, 'local:integration').map(row => row.id),
      copyCount: tree.find(row => row.item.id === 'root')!.children.map(row => row.id),
      unchanged: rows[2].parentSessionId };
  });
  expect(result.normal).toEqual(['root', 'child', 'legacy', 'pinned', 'orphan']);
  expect(result.search).toContain('integration'); expect(result.active).toContain('integration');
  expect(result.copyCount).toEqual(['child', 'legacy']); expect(result.unchanged).toBe('root');
});

test('integration notice opens read-only history without starting a model', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { React, createRoot, MergeSessionNotice, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).taskFixture;
    const host = document.createElement('div'); document.body.append(host);
    createRoot(host).render(React.createElement(MergeSessionNotice, { session: { id: 'integration', title: '处理空间', backendId: 'fake', relationKind: 'integration' }, onOpenSession: (id: string) => f.opened.push(id) }));
    api.collaborationList = async () => ({ items: [], nextOffset: null });
  });
  await page.getByRole('button', { name: '返回合并记录' }).click();
  await expect(page.getByRole('dialog')).toContainText('只支持原发起 Session 历史');
  expect(await page.evaluate(() => ({ actions: (window as any).taskFixture.actions, started: (window as any).taskFixture.started }))).toEqual({ actions: [], started: [] });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '返回合并记录' })).toBeFocused();
});

test('sidebar shows merge handling indicator while integration stays searchable and out of copy count', async ({ page }) => {
  await mount(page, 390, true, true);
  await expect(page.getByRole('button', { name: '主项目 的合并记录' })).toContainText('待解冲突');
  const toggle = page.getByRole('button', { name: '展开 主项目 的子 Session' });
  await expect(toggle).toHaveAttribute('title', /1 个子 Session/);
  await toggle.click();
  await expect(page.locator('[aria-haspopup="menu"]').filter({ hasText: '整合测试空间' })).toHaveCount(0);
  await page.getByPlaceholder('搜索会话').fill('整合测试');
  await expect(page.locator('[aria-haspopup="menu"]').filter({ hasText: '整合测试空间' })).toBeVisible();
  await page.getByPlaceholder('搜索会话').fill('');
  await page.evaluate(() => { const f = (window as any).taskFixture; f.activeSession = 'integration'; f.render(); });
  await expect(page.locator('[aria-haspopup="menu"]').filter({ hasText: '整合测试空间' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).taskFixture.started)).toEqual([]);
});

test('sidebar uses a single branch entry and opens the exact actionable record', async ({ page }, testInfo) => {
  await mount(page, 1200, true, true);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).taskFixture;
    await api.projectMergePreview('child', 'relay:fixture', 'child', 'parent', 'fixture');
    f.mergeRow.id = 'op'; f.mergeRow.status = 'conflict'; f.merges = []; f.reads = [];
    api.projectMergeCapabilities = async () => ({ mergeWorkflow: 1 });
    api.projectMergeOperations = async () => ({ items: [{ ...f.mergeRow, originSessionId: 'child' }], nextOffset: null });
    api.projectMergeInspect = async (...args) => { f.reads.push(args); return f.mergeRow; };
  });
  await page.getByRole('button', { name: '主项目 的合并记录' }).click();
  await expect(page.getByRole('button', { name: /^进入.+合并$/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).taskFixture.reads[0])).toEqual(['parent', 'relay:fixture', 'op']);
  await page.getByRole('button', { name: '返回对话' }).click();
  await page.evaluate(() => {
    const f = (window as any).taskFixture;
    f.sessions.find((s: any) => s.id === 'integration').mergeLink.status = 'succeeded';
    f.mergeCallbacks.forEach((cb: any) => cb({ id: 'op', revision: 2 }, 'relay:fixture'));
  });
  await expect(page.getByRole('button', { name: '主项目 的合并记录' })).toHaveCount(0);
  await page.locator('[aria-haspopup="menu"]').filter({ hasText: '主项目' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '分支与合并', exact: true })).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: '分支副本与合并记录', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '查看合并记录', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('single-branch-menu.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => ({ merges: (window as any).taskFixture.merges, actions: (window as any).taskFixture.actions }))).toEqual({ merges: [], actions: [] });
});

test('historic failures do not stay pending; running and unknown records remain visible', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { mergeAttention } = await import('/src/utils/mergeAttention.ts');
    const row = (id: string, status: string, createdAt: number, reverse = false) => ({ id, execKey: 'node', mergeLink: {
      operationId: id, originSessionId: 'child', sourceSessionId: reverse ? 'main' : 'child',
      targetSessionId: reverse ? 'child' : 'main', status, createdAt } });
    const done = row('new', 'succeeded', 2, true);
    const select = (rows: any[], stream = new Set<string>()) => mergeAttention(rows, 'main', 'node', stream)?.link.operationId || '';
    return {
      oldConflict: select([row('old', 'conflict', 1), done]), error: select([row('old', 'error', 1)]),
      unknown: select([row('old', 'unknown', 1), done]), running: select([row('old', 'applying', 1), done]),
      stream: select([row('old', 'candidate', 1), done], new Set(['old'])),
      foreign: select([{ ...row('foreign', 'unknown', 1), execKey: 'other' }, done]),
      differentPair: select([row('old', 'conflict', 1), { ...done, mergeLink: { ...done.mergeLink, targetSessionId: 'another-child' } }]),
      legacy: select([row('legacy', 'conflict', 0), done]),
    };
  });
  expect(result).toEqual({ oldConflict: '', error: '', unknown: 'old', running: 'old', stream: 'old', foreign: '', differentPair: 'old', legacy: 'legacy' });
});

for (const width of [1300, 390]) test(`task preview freezes selection; explicit create then separate start (${width}px)`, async ({ page }) => {
  await mount(page, width); await page.locator('.chat-textarea').fill('原会话草稿');
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  expect(await page.evaluate(() => (window as any).taskFixture.inspect)).toBe(0);
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  await expect(page.getByLabel('任务约束', { exact: true })).toHaveValue('主会话约束');
  await expect(page.getByLabel('Skills（每行一个已安装 ID）', { exact: true })).toHaveValue('local-skill');
  await page.getByLabel('副本名称', { exact: true }).fill('并行需求');
  await page.getByLabel('初始需求', { exact: true }).fill('修复功能');
  await expect(page.getByLabel('.env · 凭据路径', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('same.txt', { exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '创建副本', exact: true })).toBeDisabled();
  await page.getByLabel('项目文件范围', { exact: true }).selectOption('selected');
  await page.getByText('更多设置', { exact: true }).click();
  await page.getByRole('button', { name: '预览副本创建计划' }).click();
  expect(await page.evaluate(() => (window as any).taskFixture.created)).toEqual([]);
  const plan = await page.evaluate(() => (window as any).taskFixture.plans[0]);
  expect(plan.includePaths).toEqual(['same.txt']); expect(plan.skipPermissions).toBe(false); expect(plan.kitApprovalDelegation).toBeUndefined();
  await page.getByRole('button', { name: '创建副本' }).click();
  await expect(page.getByRole('dialog', { name: '分支副本', exact: true })).toContainText('正在创建');
  expect(await page.evaluate(() => (window as any).taskFixture.started)).toEqual([]);
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('原会话草稿');
  await page.evaluate(() => { const f = (window as any).taskFixture; f.row = { ...f.row, status: 'ready', revision: 3 }; f.callbacks.forEach((cb: any) => cb(f.row, 'local')); });
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '启动初始需求', exact: true }).click();
  expect(await page.evaluate(() => (window as any).taskFixture.started)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).taskFixture.opened)).toEqual(['child']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('lost create receipt is checked without duplicate creation; hierarchy keeps orphan and pinned children reachable', async ({ page }) => {
  await mount(page, 1200);
  await page.getByRole('button', { name: '分支副本与合并', exact: true }).click();
  await page.getByRole('button', { name: '新建分支副本', exact: true }).click();
  await page.getByLabel('副本名称', { exact: true }).fill('任务');
  await page.getByLabel('项目文件范围', { exact: true }).selectOption('selected');
  await page.getByText('更多设置', { exact: true }).click();
  await page.getByRole('button', { name: '预览副本创建计划' }).click();
  await page.evaluate(() => { (window as any).taskFixture.fail = true; });
  await page.getByRole('button', { name: '创建副本' }).click();
  await expect(page.getByRole('status')).toContainText('结果未知');
  await page.getByRole('button', { name: '核对副本状态' }).click();
  await expect(page.getByRole('dialog', { name: '分支副本', exact: true })).toContainText('正在创建');
  expect(await page.evaluate(() => (window as any).taskFixture.created)).toHaveLength(1);
  const tree = await page.evaluate(async () => {
    const { taskSessionTree } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const rows = [{ id: 'child', relationKind: 'task', parentSessionId: 'parent' }, { id: 'parent' }, { id: 'orphan', relationKind: 'task', parentSessionId: 'gone', pinned: true }];
    return { expanded: taskSessionTree(rows, new Set(), false).map(row => [row.item.id, row.depth]),
      collapsed: taskSessionTree(rows, new Set(['local:parent']), false).map(row => row.item.id),
      searched: taskSessionTree(rows, new Set(['local:parent']), true).map(row => row.item.id) };
  });
  expect(tree.expanded).toEqual([['parent', 0], ['child', 1], ['orphan', 0]]);
  expect(tree.collapsed).toEqual(['parent', 'orphan']); expect(tree.searched).toEqual(['parent', 'child', 'orphan']);
});
