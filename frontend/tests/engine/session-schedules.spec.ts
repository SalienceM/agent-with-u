import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

async function mount(page: Page, width = 1200) {
  await page.setViewportSize({ width, height: 850 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { React, createRoot, SessionSchedules, api, getCurrentUserProfile } = await import('/tests/engine/session-schedules-harness.ts');
    const root = createRoot(document.getElementById('root')!);
    const callbacks = new Set<any>(), connections = new Set<any>(), interactions = new Set<any>(), permissions = new Set<any>(), queues = new Set<any>();
    const f = { calls: [] as any[], reads: 0, histories: 0, checks: 0, stops: 0, online: true, mode: '', session: 's', revision: 1,
      plans: [] as any[], receipts: {} as Record<string, any>, rows: [] as any[], resolve: null as any,
      render: () => {}, emit: (_row: any, _node = 'local') => {}, interaction: (_row: any, _node = 'local') => {}, permission: (_row: any) => {}, queue: (_auto: boolean, _node = 'local') => {}, connection: (_value: boolean) => {} };
    api.onUserInteraction = cb => { interactions.add(cb); return () => { interactions.delete(cb); }; };
    api.onPermissionRequest = cb => { permissions.add(cb); return () => { permissions.delete(cb); }; };
    api.onSeqtaskUpdated = cb => { queues.add(cb); return () => { queues.delete(cb); }; };
    f.queue = (seqAuto, node = 'local') => queues.forEach(cb => cb({ sessionId: 's', seqAuto, seqTasks: [] }, node));
    f.interaction = (row, node = 'local') => interactions.forEach(cb => cb({ id: 'question', sessionId: 's', messageId: 'schedule-assistant-occurrence', revision: 1, status: 'pending', ...row }, node));
    f.permission = row => permissions.forEach(cb => cb({ requestId: 'permission', sessionId: 's', executor: 'local', messageId: 'schedule-assistant-occurrence', ...row }));
    api.onSessionSchedule = cb => { callbacks.add(cb); return () => { callbacks.delete(cb); }; };
    api.onExecutorConnectionStatus = (_node, cb) => { connections.add(cb); cb(f.online); return () => { connections.delete(cb); }; };
    api.sessionScheduleList = async session => { f.reads++; return { version: 1, sessionId: session, executorId: 'executor', revision: f.revision, items: f.plans, nextOffset: null, ready: true, queuePaused: false, observedAt: Date.now() / 1000 }; };
    api.sessionScheduleGet = async (_session, _executor, id) => f.plans.find(row => row.id === id);
    api.sessionSchedulePreview = async (_session, _executor, config) => ({ nextDueAt: Date.now() / 1000 + 60, localTime: '2026-11-07T09:00:00+08:00', timezone: config.timezone, dstPolicy: '重复时间执行一次' });
    api.sessionScheduleSave = async (session, _executor, intent) => {
      f.calls.push({ session, intent });
      const row = { ...intent.config, id: intent.id, revision: (intent.expectedRevision || 0) + 1, sessionId: session, nextDueAt: Date.now() / 1000 + 60 };
      const receipt = { status: 'succeeded' as const, sessionId: session, requestId: intent.requestId, schedule: row };
      if (f.mode === 'reject') throw Object.assign(Error('计划已变化'), { serverRejected: true });
      f.plans = [...f.plans.filter(item => item.id !== row.id), row]; f.revision++;
      f.receipts[intent.requestId] = receipt;
      if (f.mode === 'lost') throw Error('WebSocket connection lost');
      if (f.mode === 'deferred') return await new Promise(resolve => { f.resolve = () => resolve(receipt); });
      return receipt;
    };
    api.sessionScheduleRequestStatus = async (_session, _executor, request) => { f.checks++; return f.receipts[request] || { status: 'not_found', requestId: request, sessionId: 's' }; };
    api.sessionScheduleOccurrences = async session => { f.histories++; return { version: 1, sessionId: session, executorId: 'executor', revision: f.revision, items: f.rows, nextOffset: null }; };
    api.sessionScheduleOutput = async () => ({ messageId: 'saved-message', text: '原始已保存的输出', nextOffset: null });
    f.emit = (row, node = 'local') => callbacks.forEach(cb => cb({ version: 1, sessionId: 's', executorId: 'executor', id: 'occurrence', revision: 3, state: 'running', updatedAt: Date.now() / 1000, ...row }, node));
    f.connection = value => { f.online = value; connections.forEach(cb => cb(value)); };
    f.render = () => root.render(React.createElement(SessionSchedules, { key: f.session, session: f.session, executor: 'local', owner: getCurrentUserProfile().userId, onStop: () => f.stops++ }));
    (window as any).scheduleFixture = f; f.render();
  });
  await page.getByRole('button', { name: 'Session 定时指令', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Session 定时指令' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存并启用', exact: true })).toBeEnabled();
}

async function fill(page: Page) {
  await page.getByLabel('定时名称', { exact: true }).fill('每日检查');
  await page.getByLabel('预设指令', { exact: true }).fill('检查测试结果并报告变化');
  await page.getByLabel('运行规则', { exact: true }).selectOption('daily');
  await page.getByLabel('定时时区', { exact: true }).fill('Asia/Shanghai');
}

for (const width of [1200, 390]) test(`save and view a schedule without a model call (${width}px)`, async ({ page }) => {
  await mount(page, width); await fill(page);
  await page.getByRole('button', { name: '预览下一次时间', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('2026-11-07T09:00:00+08:00');
  expect(await page.evaluate(() => (window as any).scheduleFixture.calls.length)).toBe(0);
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('已保存到执行节点');
  const calls = await page.evaluate(() => (window as any).scheduleFixture.calls);
  expect(calls).toHaveLength(1); expect(calls[0].intent.config).toMatchObject({ enabled: true, timezone: 'Asia/Shanghai', misfirePolicy: 'catch_up_once', rule: { kind: 'daily', time: '09:00' } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await fs.mkdir(path.resolve('../.qa/session-schedules'), { recursive: true });
  await page.getByRole('dialog').screenshot({ path: path.resolve(`../.qa/session-schedules/settings-${width}.png`) });
});

test('lost save receipt is reconciled without a second write and preserves new edits', async ({ page }) => {
  await mount(page); await fill(page);
  await page.evaluate(() => { (window as any).scheduleFixture.mode = 'lost'; });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('结果未知');
  await page.getByLabel('预设指令', { exact: true }).fill('保留更新的草稿');
  await page.evaluate(() => { (window as any).scheduleFixture.connection(false); });
  await page.evaluate(() => { (window as any).scheduleFixture.connection(true); });
  await expect(page.getByRole('dialog')).toContainText('已保存到执行节点');
  await expect(page.getByLabel('预设指令', { exact: true })).toHaveValue('保留更新的草稿');
  expect(await page.evaluate(() => (window as any).scheduleFixture.calls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).scheduleFixture.checks)).toBe(1);
});

test('server conflict and offline save retain the draft', async ({ page }) => {
  await mount(page); await fill(page);
  await page.evaluate(() => { (window as any).scheduleFixture.mode = 'reject'; });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('计划已变化');
  await expect(page.getByLabel('预设指令', { exact: true })).toHaveValue('检查测试结果并报告变化');
  await page.evaluate(() => { (window as any).scheduleFixture.connection(false); });
  await expect(page.getByRole('button', { name: '保存并启用', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).scheduleFixture.calls.length)).toBe(1);
});

test('LAN HTTP without randomUUID can save and restored pending request is checked once', async ({ page }) => {
  await mount(page); await fill(page);
  await page.evaluate(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); (window as any).scheduleFixture.mode = 'lost'; });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('结果未知');
  await page.evaluate(() => { const f = (window as any).scheduleFixture; f.session = 'temporary-other'; f.render(); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).scheduleFixture; f.session = 's'; f.render(); });
  await expect.poll(() => page.evaluate(() => (window as any).scheduleFixture.checks)).toBe(1);
  expect(await page.evaluate(() => (window as any).scheduleFixture.calls.length)).toBe(1);
});

test('late receipt cannot populate another Session', async ({ page }) => {
  await mount(page); await fill(page);
  await page.evaluate(() => { (window as any).scheduleFixture.mode = 'deferred'; });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).scheduleFixture; f.session = 'other'; f.plans = []; f.render(); });
  await page.evaluate(() => { (window as any).scheduleFixture.resolve(); });
  await page.getByRole('button', { name: 'Session 定时指令', exact: true }).click();
  await expect(page.getByLabel('预设指令', { exact: true })).toHaveValue('');
  await expect(page.getByRole('dialog')).not.toContainText('已保存到执行节点');
});

test('older executor never falls back to a legacy queue write', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/session-schedules-harness.ts');
    const f = (window as any).scheduleFixture;
    api.sessionScheduleList = async () => { throw Error('Unknown method: sessionScheduleList'); };
    api.seqtaskAdd = async () => { f.calls.push({ forbiddenLegacyWrite: true }); throw Error('legacy fallback forbidden'); };
    f.session = 'older-executor-session'; f.render();
  });
  await page.getByRole('button', { name: 'Session 定时指令', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Unknown method');
  await expect(page.getByRole('button', { name: '保存并启用', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).scheduleFixture.calls.length)).toBe(0);
});

test('duplicate events coalesce reads and hidden history stays unloaded', async ({ page }) => {
  await mount(page);
  const before = await page.evaluate(() => (window as any).scheduleFixture.reads);
  await page.evaluate(() => { const f = (window as any).scheduleFixture; for (let n = 0; n < 50; n++) f.emit({}); });
  await expect(page.getByText('运行中', { exact: true })).toBeVisible();
  await page.waitForTimeout(450);
  expect(await page.evaluate(() => (window as any).scheduleFixture.reads)).toBeLessThanOrEqual(before + 1);
  expect(await page.evaluate(() => (window as any).scheduleFixture.histories)).toBe(0);
  await page.getByRole('button', { name: '收起Session 定时指令' }).click();
  const closed = await page.evaluate(() => (window as any).scheduleFixture.reads);
  await page.evaluate(() => { const f = (window as any).scheduleFixture; f.emit({ revision: 4, state: 'completed' }); f.emit({ revision: 2, state: 'running' }); f.emit({ revision: 5, state: 'failed' }, 'other-node'); });
  await page.waitForTimeout(450);
  await expect(page.getByText('本轮已结束', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).scheduleFixture.reads)).toBe(closed);
});

test('history separates unknown, waiting input and original saved output', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { const f = (window as any).scheduleFixture; const base = { sessionId: 's', title: '检查', scheduledAt: 1793967000, createdAt: 1793967000, coalescedCount: 1, error: '', assistantMessageId: 'answer', userMessageId: 'user' };
    f.rows = [{ ...base, id: 'unknown', state: 'unknown', error: '未自动重试' }, { ...base, id: 'waiting', state: 'running', waitingForInput: true }]; });
  await page.getByRole('button', { name: '运行历史', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('结果未知');
  await expect(page.getByRole('dialog')).toContainText('等待用户输入');
  await page.getByRole('button', { name: '查看原输出', exact: true }).first().click();
  await expect(page.getByLabel('定时原输出')).toContainText('原始已保存的输出');
  await page.getByRole('button', { name: '停止当前轮', exact: true }).click();
  expect(await page.evaluate(() => (window as any).scheduleFixture.stops)).toBe(1);
  expect(await page.evaluate(() => (window as any).scheduleFixture.calls.length)).toBe(0);
});

test('live input follows exact Session and executor without history polling', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '收起Session 定时指令' }).click();
  await page.evaluate(() => { const f = (window as any).scheduleFixture; f.emit({}); f.interaction({ messageId: 'manual-answer' }); f.interaction({}, 'wrong-node'); });
  await expect(page.getByText('运行中', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).scheduleFixture.interaction({ id: 'scheduled-question' }));
  await expect(page.getByText('等待用户输入', { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).scheduleFixture; f.emit({ id: 'next-occurrence', revision: 1, state: 'queued' }); f.interaction({ id: 'scheduled-question', revision: 2, status: 'answered' }); f.interaction({ id: 'scheduled-question', revision: 1 }); });
  await expect(page.getByText('运行中', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).scheduleFixture.permission({}));
  await expect(page.getByText('等待用户输入', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).scheduleFixture.permission({ resolved: true }));
  await expect(page.getByText('运行中', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).scheduleFixture.queue(false));
  await expect(page.getByText('运行中 · 后续队列暂停', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).scheduleFixture.queue(true, 'wrong-node'));
  await expect(page.getByText('运行中 · 后续队列暂停', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).scheduleFixture.emit({ revision: 4, state: 'interrupted' }));
  await expect(page.getByText('队列暂停', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).scheduleFixture.histories)).toBe(0);
  expect(await page.evaluate(() => (window as any).scheduleFixture.calls.length)).toBe(0);
});

test('new event during a delayed status read triggers one follow-up read', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { api } = await import('/tests/engine/session-schedules-harness.ts');
    const f = (window as any).scheduleFixture, original = api.sessionScheduleList;
    let first = true;
    api.sessionScheduleList = async (...args) => {
      const value = await original(...args);
      if (first) { first = false; await new Promise<void>(resolve => { f.releaseRead = resolve; }); }
      return value;
    };
    f.emit({ revision: 10 });
  });
  await expect.poll(() => page.evaluate(() => !!(window as any).scheduleFixture.releaseRead)).toBeTruthy();
  const before = await page.evaluate(() => (window as any).scheduleFixture.reads);
  await page.evaluate(() => (window as any).scheduleFixture.emit({ revision: 11, state: 'completed' }));
  await page.waitForTimeout(350);
  await page.evaluate(() => (window as any).scheduleFixture.releaseRead());
  await expect.poll(() => page.evaluate(() => (window as any).scheduleFixture.reads)).toBe(before + 1);
  await expect(page.getByText('本轮已结束', { exact: true })).toBeVisible();
});
