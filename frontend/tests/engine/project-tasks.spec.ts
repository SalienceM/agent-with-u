import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1200, sidebar = false) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async ({ sidebar }) => {
    const { React, createRoot, ProjectTasksPanel, Sidebar, ChatInput, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = { plans: [] as any[], created: [] as any[], started: [] as any[], opened: [] as string[], row: null as any, callbacks: new Set<any>(), fail: false, inspect: 0,
      nodes: [] as any[], merges: [] as any[], actions: [] as any[], mergeRow: null as any, activeSession: 'parent', render: () => {} };
    const repo = { root: 'C:/fixture', commonDir: 'C:/fixture/.git', repositoryId: 'repo', head: 'a'.repeat(40), branch: 'main', fingerprint: 'source', dirty: [
      { path: 'same.txt', status: ' M', sha256: 'sha', bytes: 5, blocked: '' }, { path: '.env', status: '??', sha256: '', bytes: 5, blocked: '凭据路径' }] };
    api.taskWorkspaceInspect = async () => { f.inspect++; return { ...repo, status: 'ready', notice: '', defaults: {
      title: '主会话 · 副本', goal: '', backendId: 'fake', runtime: {}, constraints: '主会话约束', skills: ['local-skill'], skipPermissions: false,
      includePaths: [], snapshotMode: 'current', inheritSource: true } }; };
    api.collaborationList = async (_s, _e, kind) => ({ items: kind === 'merge' ? (f.mergeRow ? [f.mergeRow] : []) : (f.row ? [f.row] : []), nextOffset: null });
    api.taskWorkspacePlan = async (_s, _e, _request, config: any) => { f.plans.push(config); return f.row = { id: 'task', revision: 1, sessionId: 'child', sourceSessionId: 'parent', parentSessionId: 'parent', title: config.title,
      config, repository: repo, root: 'C:/managed/task', branch: 'awu/task/one', status: 'preview', planFingerprint: 'plan' }; };
    api.taskWorkspaceCreate = async (...args) => { f.created.push(args); f.row = { ...f.row, revision: 2, status: 'creating' }; if (f.fail) throw Error('lost'); return f.row; };
    api.taskWorkspaceStatus = async () => f.row;
    api.taskWorkspaceStart = async (...args) => { f.started.push(args); return { status: 'succeeded', result: { notice: '启动已接收' } }; };
    api.onTaskWorkspaceUpdated = cb => { f.callbacks.add(cb); return () => { f.callbacks.delete(cb); }; };
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.followupSuggestionSettings = async () => ({ version: 1, enabled: false });
    const backends = [{ id: 'fake', type: 'openai-compatible', label: 'Fake' }];
    api.getBackends = async (node) => { f.nodes.push(node); return backends; };
    api.listSessions = async () => [{ id: 'parent', title: '主项目', workingDir: 'C:/fixture', backendId: 'fake', updatedAt: 1, execKey: 'relay:fixture', execLabel: '测试节点', pinned: true },
      { id: 'child', title: '功能副本', workingDir: 'C:/child', backendId: 'fake', updatedAt: 2, execKey: 'relay:fixture', execLabel: '测试节点', relationKind: 'task', parentSessionId: 'parent', workspaceId: 'workspace-child' }];
    api.projectMergeStatus = async () => f.mergeRow;
    api.projectMergePreview = async (...args) => { f.merges.push(args); return f.mergeRow = { id: 'merge', revision: 1, sourceSessionId: 'child', title: '功能副本 → 主项目', status: 'preview', planFingerprint: 'fixed', files: ['same.txt'], blockers: [],
      source: { ...repo, sessionId: args[2], title: '功能副本' }, target: { ...repo, sessionId: args[3], title: '主项目' }, integrationConfig: { backendId: 'fake', skipPermissions: false }, verification: { status: 'not_run', notice: '未运行测试' }, policy: '独立准备后核对应用' }; };
    api.projectMergeAction = async (...args) => { f.actions.push(args); return args[3]; };
    const root = createRoot(document.getElementById('root')!);
    f.render = () => root.render(React.createElement(React.Fragment, null,
      sidebar ? React.createElement(Sidebar, { activeSessionId: f.activeSession, activeExecKey: 'relay:fixture', streamingSessions: new Set(), onSelectSession: (id: string) => { f.opened.push(id); f.activeSession = id; f.render(); }, onNewSession: () => {} }) :
        React.createElement(ProjectTasksPanel, { session: 'parent', executor: 'local', backendId: 'fake', backends, onOpenSession: (id: string) => f.opened.push(id) }),
      React.createElement(ChatInput, { sessionId: 'parent', historyKey: 'parent', activeBackendId: 'fake', backends, isStreaming: false, onSend: () => {}, onAbort: () => {} })));
    (window as any).taskFixture = f; f.render();
  }, { sidebar });
}

for (const width of [1280, 390]) test(`sidebar branch copies keep family together and merge to parent (${width})`, async ({ page }) => {
  await mount(page, width, true);
  const parent = page.locator('[aria-haspopup="menu"]').filter({ hasText: '主项目' });
  const child = page.locator('[aria-haspopup="menu"]').filter({ hasText: '功能副本' });
  await expect(parent).toHaveCount(1); await expect(child).toHaveCount(0);
  await page.getByRole('button', { name: '展开 主项目 的子 Session' }).click();
  await expect(parent.locator('..')).toContainText('功能副本');
  await child.click();
  expect(await page.evaluate(() => (window as any).taskFixture.opened)).toEqual(['child']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '收起 主项目 的子 Session' }).click();
  await expect(child).toHaveCount(0);
  await page.evaluate(() => (window as any).taskFixture.render());
  await expect(child).toHaveCount(0);
  await parent.click();
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
  await page.getByRole('button', { name: '预览副本创建计划' }).click();
  await page.getByRole('button', { name: '确认创建副本（不运行模型）' }).click();
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
  await expect(page.getByRole('button', { name: '预览副本创建计划' })).toBeDisabled();
  await page.getByLabel('项目文件范围', { exact: true }).selectOption('selected');
  await page.getByRole('button', { name: '预览副本创建计划' }).click();
  expect(await page.evaluate(() => (window as any).taskFixture.created)).toEqual([]);
  const plan = await page.evaluate(() => (window as any).taskFixture.plans[0]);
  expect(plan.includePaths).toEqual(['same.txt']); expect(plan.skipPermissions).toBe(false); expect(plan.kitApprovalDelegation).toBeUndefined();
  await page.getByRole('button', { name: '确认创建副本（不运行模型）' }).click();
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
  await page.getByRole('button', { name: '预览副本创建计划' }).click();
  await page.evaluate(() => { (window as any).taskFixture.fail = true; });
  await page.getByRole('button', { name: '确认创建副本（不运行模型）' }).click();
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
