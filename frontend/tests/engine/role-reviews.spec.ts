import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';

async function mount(page: Page, width = 1300) {
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
    const { React, createRoot, ChatInput, RoleReviewPanel, MessageBubble, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    document.body.style.cssText = 'margin:0;font:14px "Segoe UI","Microsoft YaHei",sans-serif;background:#0c1119;color:#e4eaf4';
    document.getElementById('root')!.className = 'app-root';
    const style = document.getElementById('root')!.style;
    for (const [key, value] of Object.entries({ '--theme-bg': '#0c1119', '--theme-bg-secondary': '#17202d', '--theme-bg-tertiary': '#202c3e', '--theme-panel-solid': '#111926', '--theme-input-bg': '#17202d', '--theme-message-bg': '#17202d', '--theme-text': '#e4eaf4', '--theme-text-muted': '#a0aec0', '--theme-border': '#304057', '--theme-accent': '#6c9bff' })) style.setProperty(key, value);
    Object.assign(document.getElementById('root')!.style, { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '90vh' });
    const root = createRoot(document.getElementById('root')!), input = React.createRef<any>();
    const roles = ['审查者', '怀疑者'].map((name, i) => ({ id: `role-${i}`, revision: 1, name, instructions: '检查证据', backendId: 'fake', runtime: {}, enabled: true, archived: false }));
    const f = { root, input, roles, session: 's', open: false, sent: [] as any[], reviewCalls: [] as any[], snapshotCalls: [] as any[], detailCalls: 0, stopCalls: [] as any[], openSessions: [] as string[], batches: [] as any[], reports: {} as Record<string, any>, callbacks: new Set<any>(), failSubmit: false, render: () => {} };
    api.onExecutorConnectionStatus = (_executor, cb) => { (f as any).connection = cb; cb(true); return () => {}; };
    api.followupSuggestionSettings = async () => ({ version: 1, enabled: false });
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.listDirectory = async () => [{ name: 'proof.txt', path: 'proof.txt', isDir: false } as any];
    api.listSessionRefs = async () => [{ id: 'other-session', title: '其他会话' }];
    api.collaborationList = async (_s, _e, kind) => ({ items: kind === 'role' ? roles : f.batches, nextOffset: null });
    api.collaborationGet = async (_s, _e, kind, id) => { f.detailCalls++; return kind === 'role' ? roles.find(row => row.id === id) : f.reports[id]; };
    api.roleProfileSave = async (_s, _e, _r, profile, revision) => { const role = { ...profile, id: profile.id || 'created', revision: revision + 1 }; const index = roles.findIndex(row => row.id === role.id); if (index >= 0) roles[index] = role; else roles.push(role); return { state: 'succeeded', role }; };
    api.reviewTargets = async () => [{ id: 'answer', text: '实现已完成', characters: 5 }];
    api.reviewSnapshot = async (_s, _e, ids) => { f.snapshotCalls.push(ids); return { id: 'snapshot', fingerprint: 'fingerprint', mode: 'visible', characters: 5, targetMessageIds: ['answer'], messages: [{ id: 'answer', role: 'assistant', text: '实现已完成' }] }; };
    api.reviewSubmit = async (_s, _e, request, intent: any) => {
      f.reviewCalls.push(intent);
      const reports = intent.roles.map((role: any, i: number) => ({ id: `${request}-report-${i}`, revision: 3, roleId: role.id, name: roles.find(r => r.id === role.id)!.name,
        roleName: roles.find(r => r.id === role.id)!.name, roleVersion: role.revision, sourceSessionId: 's', sessionId: `child-${i}`, status: 'done', mode: 'text-only-history',
        summary: i ? '仍缺少证据' : '基本同意', confidence: i ? null : .8, limits: ['没有执行测试'], counts: { total: 1, agree: i ? 0 : 1, disagree: i ? 1 : 0 }, raw: 'raw report',
        claims: [{ id: 'claim-1', sourceMessageId: 'answer', quote: '实现已完成', stance: i ? 'disagree' : 'agree', reason: i ? '需要验证关键分支' : '已给出理由', suggestion: '补充测试证据', evidenceRefs: [] }] }));
      reports.forEach((row: any) => { f.reports[row.id] = row; });
      const batch = { id: request, revision: 3, updatedAt: 100 + f.batches.length, sourceSessionId: 's', snapshotId: 'snapshot', question: intent.question, status: 'done',
        targets: [{ id: 'answer', text: '实现已完成' }], counts: { total: reports.length, done: reports.length, disagree: reports.length - 1 }, reports: reports.map((row: any) => row.id), reportSummaries: reports };
      f.batches.unshift(batch); f.callbacks.forEach(cb => cb(batch, 'local'));
      if (f.failSubmit) throw Error('lost reply'); return batch;
    };
    api.onReviewUpdated = cb => { f.callbacks.add(cb); return () => { f.callbacks.delete(cb); }; };
    api.reviewStatus = async (_s, _e, request) => f.batches.find(row => row.id === request);
    api.reviewStop = async (_s, _e, batch, report) => { f.stopCalls.push([batch, report]); return f.batches.find(row => row.id === batch); };
    api.reviewReference = async (_s, _e, id, _rev, claims = []) => { const report = f.reports[id]; return { reportId: id, reportRevision: report.revision, roleId: report.roleId, roleName: report.roleName, sourceSessionId: 's', snapshotId: 'snapshot', summary: report.summary, claims: claims.length ? report.claims.filter((item: any) => claims.includes(item.id)) : report.claims, fingerprint: id }; };
    api.collaborationOpenSession = async id => { f.openSessions.push(id); return { id }; };
    f.render = () => root.render(React.createElement(React.Fragment, null,
      React.createElement(MessageBubble, { message: { id: 'answer', role: 'assistant', content: '实现已完成', timestamp: 100 }, onReviewAnswer: (id: string) => input.current.startReview([id]) }),
      React.createElement(RoleReviewPanel, { session: f.session, executor: 'local', open: f.open, onOpen: () => { f.open = true; f.render(); }, onClose: () => { f.open = false; f.render(); }, onReference: (ref: any) => input.current.insertOpinion(ref), onOpenSession: (id: string) => f.openSessions.push(id), onStartReview: (targets?: string[]) => input.current.startReview(targets, true) }),
      React.createElement(ChatInput, { ref: input, sessionId: f.session, execKey: 'local', historyKey: f.session, workingDir: 'C:/fixture', isStreaming: false,
        activeBackendId: 'fake', backends: [{ id: 'fake', type: 'openai-compatible', label: 'Fake' }], onAbort: () => {}, onSend: (...args: any[]) => f.sent.push(args),
        onOpenOpinions: () => { f.open = true; f.render(); } })));
    (window as any).reviewFixture = f; f.render();
  });
  await expect(page.locator('.chat-textarea')).toBeVisible();
}
async function choose(page: Page, text: string, name: string) {
  await page.locator('.chat-textarea').fill(text);
  await page.getByRole('option', { name: '#' + name, exact: true }).click();
}

for (const width of [1300, 390]) test(`two roles evaluate without main send; dissent appends to original draft (${width}px)`, async ({ page }) => {
  await mount(page, width);
  await choose(page, '#审', '审查者'); await choose(page, '#怀', '怀疑者');
  await page.locator('.chat-textarea').fill('这些答案可靠吗？');
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('');
  expect(await page.evaluate(() => (window as any).reviewFixture.sent)).toEqual([]);
  const submitted = await page.evaluate(() => (window as any).reviewFixture.reviewCalls[0]);
  expect(submitted.roles).toHaveLength(2); expect(submitted.kitApprovalDelegation).toBeUndefined();
  await expect(page.getByRole('button', { name: '查看角色评议' })).toContainText('有异议');
  expect(await page.evaluate(() => (window as any).reviewFixture.detailCalls)).toBe(0);
  await page.locator('.chat-textarea').fill('原草稿 保留');
  await page.locator('input[type=file]').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment kept') });
  await page.getByRole('button', { name: '查看角色评议' }).click();
  const panel = page.getByRole('dialog', { name: '角色评议详情' });
  await panel.getByRole('button', { name: '#怀疑者 · 已完成' }).click();
  await expect(panel).toContainText('角色自评置信：未知');
  await fs.mkdir(path.resolve('../.qa/role-review-repair'), { recursive: true });
  await panel.screenshot({ path: path.resolve(`../.qa/role-review-repair/opinions-${width}.png`) });
  await panel.getByLabel('不同意', { exact: true }).check();
  await panel.getByRole('button', { name: '引用所选要点' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.chat-textarea')).toHaveValue(/原草稿 保留.*角色意见：怀疑者.*需要验证关键分支/s);
  await page.getByRole('button', { name: '展开编辑消息和文本块' }).click();
  await expect(page.getByRole('dialog', { name: '展开编辑消息' })).toContainText('kept.txt');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Markdown is text; # and Slash menus work in expanded editor without sending', async ({ page }) => {
  await mount(page);
  for (const text of ['# heading', '```js\n#role', 'inline `#role', '    #role']) {
    await page.locator('.chat-textarea').fill(text);
    await expect(page.getByRole('listbox', { name: '选择评议角色' })).toHaveCount(0);
  }
  await page.locator('.chat-textarea').fill('');
  await page.getByRole('button', { name: '展开编辑消息和文本块' }).click();
  const editor = page.getByRole('textbox', { name: '编辑主消息' });
  await editor.fill('#审');
  await expect(page.getByRole('listbox', { name: '选择评议角色' })).toBeVisible();
  await expect(page.getByRole('option', { name: '#审查者', exact: true })).toBeVisible();
  await editor.press('Tab');
  await expect(editor).toHaveText('');
  await editor.fill('/hel'); await editor.press('Tab'); await expect(editor).toHaveText('/help ');
  expect(await page.evaluate(() => (window as any).reviewFixture.sent)).toEqual([]);
  await editor.fill('@proof'); await expect(page.getByRole('dialog', { name: '引用文件或目录' })).toBeVisible();
  await editor.press('Tab'); await expect(editor).toHaveText('@proof.txt ');
  await editor.fill('@SESSION:'); await page.getByText('其他会话', { exact: true }).click();
  await expect(editor).toHaveText('@SESSION:other-session ');
});

test('lost review reply cannot resubmit after Session switching; status does not write', async ({ page }) => {
  await mount(page); await page.evaluate(() => { (window as any).reviewFixture.failSubmit = true; });
  await choose(page, '#审', '审查者'); await page.locator('.chat-textarea').fill('check');
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对原评议' })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).reviewFixture; f.session = 'other'; f.render(); });
  await expect(page.locator('.chat-textarea')).toHaveValue('');
  await page.evaluate(() => { const f = (window as any).reviewFixture; f.session = 's'; f.render(); });
  await expect(page.locator('.chat-textarea')).toHaveValue('check');
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.reviewCalls)).toHaveLength(1);
  await page.getByRole('button', { name: '核对原评议' }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('');
});

test('role library edits and archives without model calls', async ({ page }) => {
  await mount(page); await page.getByRole('button', { name: '维护角色库' }).click();
  const library = page.getByRole('dialog', { name: '角色库' });
  await library.getByRole('button', { name: '审查者', exact: true }).click();
  await library.getByLabel('角色名称', { exact: true }).fill('证据审查');
  await library.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(library.getByRole('button', { name: '证据审查', exact: true })).toBeVisible();
  await library.getByLabel('归档（保留历史）', { exact: true }).check();
  await library.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(library).toContainText('证据审查 · 已归档');
  expect(await page.evaluate(() => (window as any).reviewFixture.reviewCalls)).toEqual([]);
});

test('cached history stays selected across new batches; @ opinion selector preserves cursor and does not submit', async ({ page }) => {
  await mount(page);
  await choose(page, '#审', '审查者'); await choose(page, '#怀', '怀疑者');
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  await page.getByRole('button', { name: '查看角色评议' }).click();
  const panel = page.getByRole('dialog', { name: '角色评议详情' });
  await panel.getByRole('button', { name: '#怀疑者 · 已完成' }).click();
  await expect(panel).toContainText('需要验证关键分支');
  await panel.getByRole('button', { name: '#审查者 · 已完成' }).click();
  await expect(panel).toContainText('基本同意');
  await panel.getByRole('button', { name: '#怀疑者 · 已完成' }).click();
  await expect(panel).toContainText('需要验证关键分支');
  const calls = await page.evaluate(() => (window as any).reviewFixture.detailCalls);
  await page.evaluate(() => { const f = (window as any).reviewFixture;
    const newer = { ...f.batches[0], id: 'newer', revision: 1 }; f.batches.unshift(newer); f.callbacks.forEach((cb: any) => cb(newer, 'local'));
  });
  await expect(panel).toContainText('需要验证关键分支');
  expect(await page.evaluate(() => (window as any).reviewFixture.detailCalls)).toBe(calls);
  await panel.getByRole('button', { name: '收起评议' }).click();
  await page.locator('.chat-textarea').fill('prefix @');
  await page.getByRole('button', { name: '@ 角色意见', exact: true }).click();
  await panel.getByRole('button', { name: '引用完整意见' }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue(/prefix .*角色意见：怀疑者/s);
  expect(await page.evaluate(() => (window as any).reviewFixture.sent)).toEqual([]);
  expect(await page.evaluate(() => (window as any).reviewFixture.stopCalls)).toEqual([]);
});

test('role selection clears Kit opt-in and explicit rejection preserves editable draft', async ({ page }) => {
  await mount(page);
  const opt = page.getByRole('switch', { name: '本次允许 Kit 代确认' });
  await opt.click(); await choose(page, '#审', '审查者');
  await expect(opt).toBeDisabled(); await expect(opt).not.toBeChecked();
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.reviewSubmit = async () => ({ status: 'error', notice: '角色已变化，请重新选择' } as any);
  });
  await page.locator('.chat-textarea').fill('question');
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('角色已变化');
  await expect(page.getByRole('button', { name: '核对原评议' })).toHaveCount(0);
  await expect(page.locator('.chat-textarea')).toHaveValue('question');
  await page.getByRole('button', { name: '#审查者 ×', exact: true }).click();
  await page.locator('.chat-textarea').press('Enter');
  expect(await page.evaluate(() => (window as any).reviewFixture.sent[0][3])).toBe(false);
});

test('opening a role navigates to its independent session and closing does not stop other reports', async ({ page }) => {
  await mount(page); await choose(page, '#审', '审查者');
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  await page.locator('.chat-textarea').fill('主对话保留');
  await page.getByRole('button', { name: '查看角色评议' }).click();
  await page.getByText('查看原文、证据与角色历史', { exact: true }).click();
  await page.getByRole('button', { name: '查看角色历史会话', exact: true }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.openSessions)).toEqual(['child-0', 'child-0']);
  expect(await page.evaluate(() => (window as any).reviewFixture.stopCalls)).toEqual([]);
  await expect(page.getByRole('dialog', { name: '角色评议详情' })).toHaveCount(0);
  await expect(page.locator('.chat-textarea')).toHaveValue('主对话保留');
});

for (const width of [1300, 390]) test(`answer action shows target and chosen roles without touching draft (${width}px)`, async ({ page }) => {
  await mount(page, width);
  await page.locator('.chat-textarea').fill('请重点看证据是否充分');
  await page.getByRole('button', { name: '请角色评议', exact: true }).click();
  await page.getByRole('option', { name: '#审查者', exact: true }).click();
  const selection = page.getByRole('region', { name: '评议选择' });
  await expect(selection).toContainText('评议对象 · 1 条回答');
  await expect(selection).toContainText('实现已完成');
  await expect(page.locator('.chat-textarea')).toHaveValue('请重点看证据是否充分');
  await selection.getByRole('button', { name: '添加角色' }).click();
  await page.getByRole('option', { name: '#怀疑者', exact: true }).click();
  await expect(selection).toContainText('#怀疑者');
  expect(await page.evaluate(() => (window as any).reviewFixture.reviewCalls.length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await fs.mkdir(path.resolve('../.qa/role-review-repair'), { recursive: true });
  await page.screenshot({ path: path.resolve(`../.qa/role-review-repair/compose-${width}.png`) });
  await page.locator('.awu-composer').screenshot({ path: path.resolve(`../.qa/role-review-repair/composer-${width}.png`) });
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('');
  expect(await page.evaluate(() => (window as any).reviewFixture.snapshotCalls)).toEqual([['answer']]);
  expect(await page.evaluate(() => (window as any).reviewFixture.sent)).toEqual([]);
});

test('failed preparation shows cause and recovery, no dead stop or empty history destination', async ({ page }) => {
  await mount(page);
  await choose(page, '#审', '审查者');
  await page.locator('.chat-textarea').fill('保留我的评议问题');
  await page.evaluate(() => {
    const f = (window as any).reviewFixture;
    const report = { id: 'failed-report', revision: 2, roleId: 'role-0', roleName: '审查者', name: '审查者', roleVersion: 1,
      sessionId: 'empty-child', sourceSessionId: 's', status: 'error', mode: 'text-only-history', notice: '批次准备未完成，未调用模型；已有空间保留' };
    f.reports[report.id] = report;
    const batch = { id: 'failed-batch', revision: 3, updatedAt: 100, sourceSessionId: 's', snapshotId: 'snapshot', status: 'error',
      notice: "'method' object is not subscriptable", counts: { total: 1, done: 0, failed: 1 }, reports: [report.id], reportSummaries: [report] };
    f.batches.push(batch); f.callbacks.forEach((cb: any) => cb(batch, 'local'));
  });
  await expect(page.getByRole('button', { name: '查看角色评议' })).toContainText('未能开始');
  await page.getByRole('button', { name: '查看角色评议' }).click();
  const panel = page.getByRole('dialog', { name: '角色评议详情' });
  await expect(panel).toContainText('评议未能开始');
  await expect(panel).toContainText("'method' object is not subscriptable");
  await expect(panel.getByRole('button', { name: /停止/ })).toHaveCount(0);
  await panel.getByText('查看原文、证据与角色历史', { exact: true }).click();
  await page.evaluate(() => document.getElementById('root')!.style.setProperty('--theme-bg-secondary', 'rgba(17,25,38,.1)'));
  expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(17, 25, 38)');
  await expect(panel.getByRole('button', { name: '查看角色历史会话' })).toHaveCount(0);
  await panel.getByText('查看原文、证据与角色历史', { exact: true }).click();
  await fs.mkdir(path.resolve('../.qa/role-review-repair'), { recursive: true });
  await page.screenshot({ path: path.resolve('../.qa/role-review-repair/failed-review.png') });
  await panel.getByRole('button', { name: '重新选择角色' }).click();
  await expect(page.getByRole('listbox', { name: '选择评议角色' })).toBeVisible();
  await expect(page.getByRole('option', { name: '#审查者', exact: true })).toBeVisible();
  await expect(page.locator('.chat-textarea')).toHaveValue('保留我的评议问题');
  expect(await page.evaluate(() => (window as any).reviewFixture.reviewCalls)).toEqual([]);
});

test('empty review history explains where to act, including transparent background themes', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { React, RoleSessionNotice } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).reviewFixture;
    document.getElementById('root')!.style.setProperty('--theme-bg-secondary', 'rgba(17,25,38,.1)');
    f.root.render(React.createElement(RoleSessionNotice, { empty: true, onReturn: () => f.openSessions.push('source') }));
  });
  await expect(page.getByRole('region', { name: '角色评议记录' })).toContainText('这里还没有评议内容');
  await expect(page.getByText('输入消息开始', { exact: false })).toHaveCount(0);
  expect(await page.getByRole('region', { name: '角色评议记录' }).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(17, 25, 38)');
  await page.getByRole('region', { name: '角色评议记录' }).screenshot({ path: path.resolve('../.qa/role-review-repair/empty-history.png') });
  await page.getByRole('button', { name: '返回来源对话' }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.openSessions)).toEqual(['source']);
});

test('default preview remains the selected answer when the main conversation advances', async ({ page }) => {
  await mount(page);
  await choose(page, '#审', '审查者');
  await expect(page.getByRole('region', { name: '评议选择' })).toContainText('实现已完成');
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.reviewTargets = async () => [{ id: 'new-answer', text: '这是刚完成的新回答', characters: 9 }];
  });
  await page.getByRole('button', { name: '发起评议', exact: true }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('');
  expect(await page.evaluate(() => (window as any).reviewFixture.snapshotCalls)).toEqual([['answer']]);
  expect(await page.evaluate(() => (window as any).reviewFixture.sent)).toEqual([]);
});

for (const width of [1300, 390]) test(`live review output streams before completion, without report reloads (${width}px)`, async ({ page }) => {
  await mount(page, width);
  await page.evaluate(() => {
    const f = (window as any).reviewFixture;
    const report = { id: 'live-report', revision: 1, name: '审查者', roleName: '审查者', sourceSessionId: 's', batchId: 'live-batch', status: 'running', roleVersion: 1, mode: 'text-only-history' };
    f.reports[report.id] = report;
    f.batches.push({ id: 'live-batch', revision: 1, updatedAt: Date.now() / 1000, sourceSessionId: 's', status: 'running', counts: { total: 1, done: 0 }, reports: [report.id], reportSummaries: [report] });
    f.callbacks.forEach((cb: any) => cb(f.batches[0], 'local'));
  });
  await page.getByRole('button', { name: '查看角色评议' }).click();
  const panel = page.getByRole('dialog', { name: '角色评议详情' });
  await expect(panel.getByRole('button', { name: '停止此角色', exact: true })).toBeVisible();
  await panel.getByText('实时输出 · 第 1 轮 · 已接收 0 字', { exact: true }).click();
  await page.evaluate(() => {
    const f = (window as any).reviewFixture;
    const progress = { sequence: 4, phase: 'responding', message: '正在接收角色输出', round: 2, startedAt: Date.now() / 1000 - 5, updatedAt: Date.now() / 1000,
      lastOutputAt: Date.now() / 1000, evidenceCount: 2, outputCharacters: 32, output: '{"summary":"材料支持主要判断，但还需要验证关联关系',
      events: [{ at: Date.now() / 1000 - 1, message: '读取文件：proof.txt · 完成' }] };
    f.reports['live-report'].progress = progress;
    const event = { kind: 'progress', id: 'live-report', batchId: 'live-batch', sourceSessionId: 's', revision: 1, progress };
    f.callbacks.forEach((cb: any) => cb(event, 'local'));
    f.callbacks.forEach((cb: any) => cb({ ...event, progress: { ...progress, sequence: 3, output: 'OLD OUTPUT' } }, 'local'));
    f.callbacks.forEach((cb: any) => cb({ ...event, progress: { ...progress, sequence: 10, output: 'OTHER NODE' } }, 'another-node'));
    f.callbacks.forEach((cb: any) => cb({ ...event, sourceSessionId: 'other-session', progress: { ...progress, sequence: 10, output: 'OTHER SESSION' } }, 'local'));
    f.callbacks.forEach((cb: any) => cb({ ...event, id: 'other-report', progress: { ...progress, sequence: 10, output: 'OTHER ROLE' } }, 'local'));
  });
  await expect(panel.getByLabel('角色实时正文')).toContainText('还需要验证关联关系');
  await expect(panel.getByLabel('角色实时正文')).not.toContainText('OLD OUTPUT');
  await expect(panel.getByLabel('角色实时正文')).not.toContainText('OTHER NODE');
  await expect(panel.getByLabel('角色实时正文')).not.toContainText('OTHER SESSION');
  await expect(panel.getByLabel('角色实时正文')).not.toContainText('OTHER ROLE');
  await expect(panel).toContainText('已获取 2 条证据');
  expect(await page.evaluate(() => (window as any).reviewFixture.detailCalls)).toBe(0);
  await page.evaluate(() => (window as any).reviewFixture.connection(false));
  await expect(panel).toContainText('连接中断 · 保留最后输出');
  await expect(panel.getByLabel('角色实时正文')).toContainText('还需要验证关联关系');
  await page.evaluate(() => (window as any).reviewFixture.connection(true));
  await expect(panel).toContainText('正在接收角色输出');
  expect(await page.evaluate(() => (window as any).reviewFixture.reviewCalls)).toEqual([]);
  await fs.mkdir(path.resolve('../.qa/role-review-live'), { recursive: true });
  await panel.screenshot({ path: path.resolve(`../.qa/role-review-live/live-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await panel.getByRole('button', { name: '收起评议' }).click();
  expect(await page.evaluate(() => (window as any).reviewFixture.stopCalls)).toEqual([]);
});

test('old invalid output can be revalidated and cited without rerunning the reviewer', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const f = (window as any).reviewFixture;
    const report = { id: 'invalid-report', revision: 1, name: '审查者', roleName: '审查者', sourceSessionId: 's', batchId: 'invalid-batch', status: 'invalid',
      roleVersion: 1, mode: 'text-only-history', notice: '第 3 条意见引文与目标回答不符', raw: '{"summary":"有价值的意见"}', counts: {} };
    f.reports[report.id] = report;
    const batch = { id: 'invalid-batch', revision: 1, updatedAt: Date.now() / 1000, sourceSessionId: 's', status: 'completed_with_issues', counts: { total: 1, done: 0, failed: 1 }, reports: [report.id], reportSummaries: [report] };
    f.batches.push(batch); f.callbacks.forEach((cb: any) => cb(batch, 'local'));
    api.reviewRevalidate = async () => {
      const saved = { ...report, revision: 2, status: 'done', summary: '有价值的意见', notice: '已重新核对，没有调用模型', counts: { total: 1, partial: 1 }, claims: [{ id: 'claim-1', sourceMessageId: 'answer', quote: '实现已完成', stance: 'partial', reason: '需要运行证据', evidenceRefs: [] }] };
      f.reports[report.id] = saved; batch.reportSummaries = [saved]; batch.counts = { total: 1, done: 1, failed: 0 }; batch.status = 'done'; batch.revision++;
      f.callbacks.forEach((cb: any) => cb(batch, 'local')); return saved as any;
    };
  });
  await page.getByRole('button', { name: '查看角色评议' }).click();
  const panel = page.getByRole('dialog', { name: '角色评议详情' });
  await panel.getByRole('button', { name: '重新解析已有意见' }).click();
  await expect(panel).toContainText('有价值的意见');
  await expect(panel.getByRole('button', { name: '引用完整意见' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).reviewFixture.reviewCalls)).toEqual([]);
});
