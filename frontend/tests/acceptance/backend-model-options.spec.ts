import { test, expect, type Page, type Locator } from '@playwright/test';

const options = (id: string) => [{ id: `${id}/future`, label: `模型 ${id}` }, { id: `${id}/old` }];
const primary = (node: string) => ({ id: 'qa-primary', type: 'codex-office', label: `Codex ${node}`,
  enabled: true, model: 'unlisted-default', skipPermissions: false, modelOptions: options(node) });
const target = (deviceId: string) => ({ mode: 'relay', url: 'ws://127.0.0.1:45421/model-options-qa',
  token: 'qa-fixture-not-a-credential', deviceId, deviceName: `工作站 ${deviceId}`,
  user: { userId: 'catalog-test', username: 'catalog-test', displayName: 'Catalog QA', managed: false } });

async function fixture(page: Page, remote = false) {
  const state = {
    nodes: Object.fromEntries(['local', 'A', 'B'].map(node => [node, [primary(node),
      { ...primary('review'), id: 'qa-reviewer', label: 'Codex Reviewer' },
      { ...primary('official'), id: 'official-codex', label: 'Codex 官方账户', pinned: true },
    ]])) as Record<string, any[]>,
    mode: 'ok', hold: '', delayed: [] as Array<() => void>,
    catalogMode: 'ok', catalogHold: false, catalogDelayed: [] as Array<() => void>,
    calls: [] as Array<{ node: string; method: string; params: any[] }>,
    errors: [] as string[],
  };
  page.on('pageerror', error => state.errors.push(error.message));
  if (remote) await page.addInitScript(value => {
    localStorage.setItem('awu.connectionTarget', JSON.stringify(value.home));
    localStorage.setItem('awu.execRoster', JSON.stringify([value.other]));
  }, { home: target('A'), other: target('B') });
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    let node = 'local';
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.t === 'hello') { node = frame.deviceId; socket.send(JSON.stringify({ t: 'ready' })); return; }
      state.calls.push({ node, ...frame });
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      const fail = () => socket.send(JSON.stringify({ id: frame.id, error: 'QA 节点不可达' }));
      if (/^(sendMessage|loopRunIteration|codexLocalThreads|openLoginTerminal)$/.test(frame.method)) throw new Error(`不得执行真实模型/认证：${frame.method}`);
      if (frame.method === 'getBackends') {
        if (state.mode === 'read-fail') return fail();
        const list = structuredClone(state.nodes[node]);
        if (state.hold === node) state.delayed.push(() => reply(list)); else reply(list);
        return;
      }
      if (frame.method === 'saveBackend') {
        if (state.mode === 'offline') return fail();
        const config = JSON.parse(frame.params[0]);
        if (state.mode === 'old') delete config.modelOptions;
        const index = state.nodes[node].findIndex(item => item.id === config.id);
        if (index < 0) state.nodes[node].push(config);
        else state.nodes[node][index] = { ...config, pinned: config.id === 'official-codex' };
        if (state.mode === 'save-then-read-fail') state.mode = 'read-fail';
        return reply(null);
      }
      if (frame.method === 'codexModelCatalog') {
        const mode = state.catalogMode;
        const result = { status: 'ok', source: 'codex-app-server', freshness: 'unknown',
          fetchedAt: '2026-10-06T00:00:00Z', modelOptions: options(`synced-${node}`) };
        const complete = () => {
          if (mode === 'transport') return fail();
          if (mode === 'empty-ok') return reply({ ...result, modelOptions: [] });
          if (mode !== 'ok') return reply({ status: 'error', code: mode, message: 'secret-not-for-ui' });
          reply(result);
        };
        if (state.catalogHold) state.catalogDelayed.push(complete); else complete();
        return;
      }
      if (frame.method === 'updateSessionRuntime') return reply({ status: 'ok', runtime: JSON.parse(frame.params[1]) });
      // 不让不同节点从真实 QA Session 索引互相覆盖路由；本测试只管理节点配置。
      if (remote && frame.method === 'listSessions') return reply([]);
      server.send(message);
    });
  });
  await page.goto('/');
  await expect(page.locator('.home-action-grid')).toBeVisible();
  return state;
}

async function openManager(page: Page) {
  await page.locator('.home-action-grid button').nth(4).click();
  const manager = page.getByRole('dialog', { name: 'Backend 配置' });
  await expect(manager.getByRole('heading', { name: 'Backend Manager', exact: true })).toBeVisible();
  return manager;
}

async function edit(manager: Locator, label = 'Codex 官方账户') {
  await manager.locator('[data-backend-id]').filter({ hasText: label }).first().click();
  const editor = manager.getByRole('region', { name: '模型候选编辑' });
  await expect(editor).toBeVisible();
  return editor;
}

async function candidates(input: Locator): Promise<string[]> {
  return input.evaluate((element: HTMLInputElement) => [...(element.list?.options ?? [])].map(o => o.value));
}

async function publish(page: Page, execKey = 'local', backendId = 'qa-primary') {
  await page.evaluate(async ({ execKey, backendId }) => {
    const path = '/src/backendCatalog.ts';
    const { backendCatalog } = await import(path);
    backendCatalog.publish(execKey, backendId);
  }, { execKey, backendId });
}

test('explicit Codex sync fills only draft, preserves runtime and saves through existing consumers', async ({ page }, info) => {
  const data = await fixture(page);
  const manager = await openManager(page);
  let editor = await edit(manager);
  expect(data.calls.filter(c => c.method === 'codexModelCatalog')).toHaveLength(0);
  const button = manager.getByRole('button', { name: '从 Codex 同步', exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('synced-local/future');
  await expect(manager).toContainText('已填入草稿，保存后生效');
  await expect(manager).toContainText('上游来源与新鲜度未知');
  await expect(manager.getByLabel('Backend 默认模型')).toHaveValue('unlisted-default');
  expect(data.nodes.local[2].modelOptions).toEqual(options('official'));
  expect(data.calls.filter(c => c.method === 'saveBackend')).toHaveLength(0);
  await button.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('codex-catalog-sync.png') });
  await editor.getByLabel('模型 ID 1', { exact: true }).fill('manual-after-sync');
  await expect(manager).toContainText('同步后草稿已修改');
  await manager.getByRole('button', { name: 'Back', exact: true }).click();
  expect(data.nodes.local[2].modelOptions).toEqual(options('official'));
  editor = await edit(manager, 'Codex local');
  await button.click();
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('synced-local/future');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已保存到');
  expect(data.nodes.local[0].modelOptions).toEqual(options('synced-local'));
  expect(data.nodes.local[0].model).toBe('unlisted-default');
  expect(data.nodes.local[0].skipPermissions).toBe(false);
  await edit(manager, 'Codex local');
  await expect(manager).not.toContainText('读取时间：');
  await manager.getByRole('button', { name: '关闭 Backend 配置' }).click();
  await page.locator('.home-action-grid button').nth(0).click();
  const model = page.getByRole('combobox', { name: 'Codex 模型', exact: true }).last();
  await expect.poll(() => candidates(model)).toEqual(['synced-local/future', 'synced-local/old']);
  expect(data.calls.filter(c => /^(updateSessionRuntime|loopSetPolicy|sendMessage)$/.test(c.method))).toHaveLength(0);
  expect(data.errors).toEqual([]);
});

test('Codex sync errors and invalid success never discard manual drafts or leak raw errors', async ({ page }) => {
  const data = await fixture(page);
  const manager = await openManager(page);
  const editor = await edit(manager);
  await editor.getByLabel('模型 ID 1', { exact: true }).fill('keep-manual');
  for (const mode of ['unsupported', 'auth', 'empty', 'invalid', 'incomplete', 'timeout', 'limit', 'empty-ok', 'transport']) {
    data.catalogMode = mode;
    await manager.getByRole('button', { name: '从 Codex 同步', exact: true }).click();
    await expect(manager.getByRole('status')).toBeVisible();
    await expect(manager).not.toContainText('secret-not-for-ui');
    await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('keep-manual');
  }
  data.catalogMode = 'ok';
  await manager.getByRole('button', { name: '从 Codex 同步', exact: true }).click();
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('synced-local/future');
  data.mode = 'old';
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('模型候选未保存');
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('synced-local/future');
  expect(data.errors).toEqual([]);
});

test('pending Codex sync cannot overwrite edits, restore, save, cancel or reopened editor', async ({ page }) => {
  const data = await fixture(page);
  const manager = await openManager(page);
  let editor = await edit(manager);
  data.catalogHold = true;
  const begin = async () => {
    await manager.getByRole('button', { name: '从 Codex 同步', exact: true }).click();
    await expect.poll(() => data.catalogDelayed.length).toBe(1);
    await expect(manager.getByRole('button', { name: '正在读取 Codex 目录…' })).toBeDisabled();
  };
  const release = () => data.catalogDelayed.splice(0).forEach(fn => fn());
  await begin();
  await editor.getByLabel('模型 ID 1', { exact: true }).fill('new-edit');
  release();
  await expect(manager).toContainText('草稿已变化');
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('new-edit');
  await begin();
  await editor.getByRole('button', { name: '恢复内置候选' }).click();
  release();
  await expect(manager).toContainText('草稿已变化');
  await expect(editor).toContainText('模型候选 · 内置');
  await begin();
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已保存到');
  editor = await edit(manager);
  release();
  await expect(editor).toContainText('模型候选 · 内置');
  await begin();
  await manager.getByRole('button', { name: 'Back', exact: true }).click();
  editor = await edit(manager);
  release();
  await expect(editor).toContainText('模型候选 · 内置');
  await begin();
  await manager.getByRole('button', { name: '关闭 Backend 配置' }).click();
  await page.locator('.home-action-grid button').nth(4).click();
  // 重开可能保留原编辑页，但挂载实例必须已失效。
  release();
  await expect(editor).toContainText('模型候选 · 内置');
  expect(data.calls.filter(c => c.method === 'codexModelCatalog')).toHaveLength(5);
  expect(data.errors).toEqual([]);
});

test('sync uses exact remote executor and discards replies after switching nodes', async ({ page }) => {
  const data = await fixture(page, true);
  const manager = await openManager(page);
  await edit(manager, 'Codex A');
  data.catalogHold = true;
  await manager.getByRole('button', { name: '从 Codex 同步', exact: true }).click();
  await expect.poll(() => data.catalogDelayed.length).toBe(1);
  await manager.getByRole('button', { name: 'Back', exact: true }).click();
  await manager.getByRole('combobox', { name: '管理执行节点' }).selectOption('relay:catalog-test:B');
  const editor = await edit(manager, 'Codex B');
  data.catalogDelayed.splice(0).forEach(fn => fn());
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('B/future');
  data.catalogHold = false;
  await manager.getByRole('button', { name: '从 Codex 同步', exact: true }).click();
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('synced-B/future');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已保存到');
  expect(data.nodes.A[0].modelOptions).toEqual(options('A'));
  expect(data.nodes.B[0].modelOptions).toEqual(options('synced-B'));
  expect(data.calls.filter(c => c.method === 'codexModelCatalog').map(c => c.node)).toEqual(['A', 'B']);
  await edit(manager, 'Codex B');
  data.catalogMode = 'transport';
  await manager.getByRole('button', { name: '从 Codex 同步', exact: true }).click();
  await expect(manager).toContainText('无法读取目录');
  expect(data.calls.filter(c => c.method === 'codexModelCatalog').map(c => c.node)).toEqual(['A', 'B', 'B']);
  expect(data.errors).toEqual([]);
});

test('unsaved source configuration and new copied Backends require explicit save before sync', async ({ page }) => {
  const data = await fixture(page);
  const manager = await openManager(page);
  await edit(manager);
  await manager.getByPlaceholder('https://api.openai.com/v1', { exact: true }).fill('https://example.invalid/v1');
  await expect(manager.getByRole('button', { name: '从 Codex 同步', exact: true })).toBeDisabled();
  await expect(manager).toContainText('请先保存 Backend 及连接配置');
  await manager.getByRole('button', { name: 'Back', exact: true }).click();
  await manager.locator('[data-backend-id="official-codex"]').getByRole('button', { name: '⧉ 复制', exact: true }).click();
  await expect(manager.getByRole('button', { name: '从 Codex 同步', exact: true })).toBeDisabled();
  expect(data.calls.filter(c => c.method === 'codexModelCatalog')).toHaveLength(0);
  expect(data.calls.filter(c => c.method === 'saveBackend')).toHaveLength(0);
  expect(data.errors).toEqual([]);
});

test('edit pinned and copied catalogs, keyboard reorder, validation, cancel and all three modes', async ({ page }, info) => {
  const data = await fixture(page);
  const manager = await openManager(page);
  let editor = await edit(manager);
  const defaultModel = manager.getByLabel('Backend 默认模型');
  await editor.getByRole('button', { name: '清空候选', exact: true }).click();
  await editor.getByRole('button', { name: '添加候选', exact: true }).click();
  await editor.getByLabel('模型 ID 1', { exact: true }).fill('future/next');
  await editor.getByLabel('显示名称 1', { exact: true }).fill('我的新版');
  await editor.getByRole('button', { name: '添加候选', exact: true }).click();
  await editor.getByLabel('模型 ID 2', { exact: true }).fill('future/next');
  await expect(editor.getByRole('alert')).toContainText('第 2 项 ID 重复');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  expect(data.calls.filter(c => c.method === 'saveBackend')).toHaveLength(0);
  await editor.getByLabel('模型 ID 2', { exact: true }).fill('vendor/fast');
  await editor.getByRole('button', { name: '上移候选 2', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue('vendor/fast');
  await expect(defaultModel).toHaveValue('unlisted-default');
  await expect.poll(() => candidates(defaultModel)).toEqual(['vendor/fast', 'future/next']);
  await editor.scrollIntoViewIfNeeded();
  expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('model-candidate-editor.png') });
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已保存到');
  const official = () => data.nodes.local.find(item => item.id === 'official-codex');
  expect(official().modelOptions).toEqual([{ id: 'vendor/fast' }, { id: 'future/next', label: '我的新版' }]);
  editor = await edit(manager);
  await editor.getByLabel('模型 ID 1', { exact: true }).fill('cancelled-change');
  await manager.getByRole('button', { name: 'Back', exact: true }).click();
  expect(official().modelOptions[0].id).toBe('vendor/fast');
  await manager.locator('[data-backend-id="official-codex"]').getByRole('button', { name: '⧉ 复制', exact: true }).click();
  await manager.getByLabel('模型 ID 1', { exact: true }).fill('copy-only');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已基于');
  expect(official().modelOptions[0].id).toBe('vendor/fast');
  expect(data.nodes.local.find(item => item.id === 'official-codex-copy').modelOptions[0].id).toBe('copy-only');
  editor = await edit(manager);
  await editor.getByRole('button', { name: '清空候选', exact: true }).click();
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已保存到');
  expect(official().modelOptions).toEqual([]);
  editor = await edit(manager);
  await expect.poll(() => candidates(defaultModel)).toEqual([]);
  await editor.getByRole('button', { name: '恢复内置候选', exact: true }).click();
  await expect(editor).toContainText('模型候选 · 内置');
  await expect(defaultModel).toHaveValue('unlisted-default');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已保存到');
  expect(official().modelOptions).toBeNull();
  expect(official().skipPermissions).toBe(false);
  expect(data.errors).toEqual([]);
});

test('old executor, offline save and failed readback keep candidate drafts without false success', async ({ page }) => {
  const data = await fixture(page);
  const manager = await openManager(page);
  const editor = await edit(manager);
  for (const mode of ['old', 'offline', 'save-then-read-fail']) {
    data.mode = mode;
    await editor.getByLabel('模型 ID 1', { exact: true }).fill(`draft-${mode}`);
    await manager.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(manager).toContainText(mode === 'old' ? '执行端已升级' : mode === 'offline' ? '节点不可达' : '回读失败');
    await expect(editor.getByLabel('模型 ID 1', { exact: true })).toHaveValue(`draft-${mode}`);
    await expect(manager.getByRole('heading', { name: 'Edit Backend' })).toBeVisible();
  }
  data.mode = 'old';
  await editor.getByRole('button', { name: '清空候选', exact: true }).click();
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('模型候选未保存');
  await expect(editor).toContainText('无候选');
  expect(data.errors).toEqual([]);
});

test('chat, new Session and LOOP role consumers refresh suggestions without resetting runtime drafts', async ({ page }) => {
  const data = await fixture(page);
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText('客户工作会话 5', { exact: true }).click();
  const pane = page.locator('[data-session-tab-panel="qa-chat-004"]');
  const toggle = pane.getByRole('button', { name: /切换本 Session 模型/ });
  await toggle.click();
  const input = pane.getByRole('combobox', { name: 'Codex 模型', exact: true });
  await expect.poll(() => candidates(input)).toEqual(['local/future', 'local/old']);
  await input.fill('unlisted/runtime-draft');
  data.nodes.local[0].modelOptions = options('updated');
  await publish(page);
  await expect.poll(() => candidates(input)).toEqual(['updated/future', 'updated/old']);
  await expect(input).toHaveValue('unlisted/runtime-draft');
  await pane.getByRole('button', { name: '应用到后续 turn' }).click();
  expect(data.calls.findLast(c => c.method === 'updateSessionRuntime')?.params[1]).toContain('unlisted/runtime-draft');
  // 模拟另一窗口更新：重新打开时读权威列表，而不是依赖本窗口通知。
  data.nodes.local[0].modelOptions = [];
  await toggle.click();
  await expect.poll(() => candidates(input)).toEqual([]);
  await pane.getByRole('button', { name: '关闭模型设置' }).click();
  await page.getByRole('tab', { name: '工作总览', exact: true }).click();
  await page.locator('.home-action-grid button').nth(0).click();
  const sessionInput = page.getByRole('combobox', { name: 'Codex 模型', exact: true }).last();
  await sessionInput.fill('session-draft');
  data.nodes.local[0].modelOptions = options('reopened');
  await publish(page);
  await expect.poll(() => candidates(sessionInput)).toEqual(['reopened/future', 'reopened/old']);
  await expect(sessionInput).toHaveValue('session-draft');
  await page.getByRole('button', { name: /Loop 会话/ }).click();
  await page.getByRole('button', { name: /Loop 策略与心智/ }).click();
  await page.getByRole('combobox', { name: '规划与分步 Backend', exact: true }).selectOption('qa-reviewer');
  const planning = page.getByRole('combobox', { name: '规划与分步 Backend', exact: true }).locator('..').getByRole('combobox', { name: 'Codex 模型', exact: true });
  const execute = page.getByRole('combobox', { name: '逐步执行 Backend', exact: true }).locator('..').getByRole('combobox', { name: 'Codex 模型', exact: true });
  await expect.poll(() => candidates(planning)).toEqual(['review/future', 'review/old']);
  await expect.poll(() => candidates(execute)).toEqual(['reopened/future', 'reopened/old']);
  await planning.fill('planning-draft');
  data.nodes.local[1].modelOptions = options('review-new');
  await publish(page, 'local', 'qa-reviewer');
  await expect.poll(() => candidates(planning)).toEqual(['review-new/future', 'review-new/old']);
  await expect(planning).toHaveValue('planning-draft');
  await expect.poll(() => candidates(execute)).toEqual(['reopened/future', 'reopened/old']);
  expect(data.errors).toEqual([]);
});

test('same Backend ID across nodes, late replies, non-home save and unavailable node never fall back', async ({ page }) => {
  const data = await fixture(page, true);
  const manager = await openManager(page);
  const picker = manager.getByRole('combobox', { name: '管理执行节点' });
  await expect(manager.locator('[data-backend-id="qa-primary"]')).toContainText('Codex A');
  data.hold = 'B';
  await picker.selectOption('relay:catalog-test:B');
  await expect.poll(() => data.delayed.length).toBeGreaterThan(0);
  await picker.selectOption('relay:catalog-test:A');
  data.hold = '';
  data.delayed.splice(0).forEach(release => release());
  await expect(manager.locator('[data-backend-id="qa-primary"]')).toContainText('Codex A');
  await expect(manager.locator('[data-backend-id="qa-primary"]')).not.toContainText('Codex B');
  await picker.selectOption('relay:catalog-test:B');
  const editor = await edit(manager, 'Codex B');
  await editor.getByLabel('模型 ID 1', { exact: true }).fill('B/saved');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager).toContainText('已保存到「工作站 B」');
  expect(data.nodes.B[0].modelOptions[0].id).toBe('B/saved');
  expect(data.nodes.A[0].modelOptions[0].id).toBe('A/future');
  expect(data.calls.filter(c => c.method === 'saveBackend').map(c => c.node)).toEqual(['B']);
  await manager.getByRole('button', { name: '关闭 Backend 配置' }).click();
  await page.locator('.home-action-grid button').nth(0).click();
  const model = page.getByRole('combobox', { name: 'Codex 模型', exact: true }).last();
  await expect.poll(() => candidates(model)).toEqual(['A/future', 'A/old']);
  data.hold = 'B';
  await page.getByRole('button', { name: /工作站 B/ }).click();
  await expect.poll(() => data.delayed.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: /工作站 A/ }).click();
  data.hold = '';
  data.delayed.splice(0).forEach(release => release());
  await expect.poll(() => candidates(model)).toEqual(['A/future', 'A/old']);
  await page.getByRole('button', { name: /工作站 B/ }).click();
  await expect.poll(() => candidates(model)).toEqual(['B/saved', 'B/old']);
  await model.fill('remote-draft');
  data.nodes.B[0].modelOptions = options('B-new');
  const readsA = data.calls.filter(c => c.node === 'A' && c.method === 'getBackends').length;
  await publish(page, 'relay:catalog-test:B');
  await expect.poll(() => candidates(model)).toEqual(['B-new/future', 'B-new/old']);
  await expect(model).toHaveValue('remote-draft');
  expect(data.calls.filter(c => c.node === 'A' && c.method === 'getBackends')).toHaveLength(readsA);
  data.mode = 'read-fail';
  await publish(page, 'relay:catalog-test:B');
  await expect(page.getByText(/节点不可达；当前显示的是最近缓存/)).toBeVisible();
  await expect.poll(() => candidates(model)).toEqual(['B-new/future', 'B-new/old']);
  expect(data.calls.filter(c => c.node === 'A' && c.method === 'getBackends')).toHaveLength(readsA);
  expect(data.errors).toEqual([]);
});

test('an open LOOP policy keeps role drafts while candidate lists refresh and reopen', async ({ page }) => {
  const data = await fixture(page);
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText('首页交付 Loop 1', { exact: true }).click();
  const pane = page.locator('[data-session-tab-panel="qa-loop-000"]');
  const toggle = pane.getByRole('button', { name: /策略与心智/ });
  await toggle.click();
  const role = (name: string) => pane.getByRole('combobox', { name: `${name} Backend`, exact: true })
    .locator('..').getByRole('combobox', { name: 'Codex 模型', exact: true });
  await expect.poll(() => candidates(role('逐步执行'))).toEqual(['local/future', 'local/old']);
  await expect.poll(() => candidates(role('评分 / 评审'))).toEqual(['review/future', 'review/old']);
  await role('逐步执行').fill('unlisted/loop-draft');
  data.nodes.local[0].modelOptions = [];
  await publish(page);
  for (const name of ['规划与分步', '逐步执行', '想法展开', '目标汇总 / 微调', '旁路问答']) {
    await expect.poll(() => candidates(role(name))).toEqual([]);
  }
  await expect(role('逐步执行')).toHaveValue('unlisted/loop-draft');
  await expect.poll(() => candidates(role('评分 / 评审'))).toEqual(['review/future', 'review/old']);
  await toggle.click();
  data.nodes.local[0].modelOptions = options('other-window');
  await toggle.click();
  await expect.poll(() => candidates(role('逐步执行'))).toEqual(['other-window/future', 'other-window/old']);
  await expect(role('逐步执行')).toHaveValue('unlisted/loop-draft');
  expect(data.calls.filter(c => c.method === 'loopSetPolicy')).toHaveLength(0);
  expect(data.errors).toEqual([]);
});
