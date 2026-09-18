import { test, expect, type Page } from '@playwright/test';

const session = { id: 'skill-binding-qa', title: '能力绑定回归会话', messageCount: 0, updatedAt: 1,
  workingDir: 'C:/isolated-session', backendId: 'qa-backend', sessionType: 'normal', abilities: { skills: [], prompts: [], constraints: '已有约束' } };
const skill = { id: 'library-demo', name: 'library-demo', content: '# Library demo', description: 'Fixture skill' };

async function sidebar(page: Page) {
  await expect(page.getByRole('button', { name: '返回工作总览', exact: true })).toBeVisible();
  if (await page.locator('.awu-sidebar').isVisible()) return;
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
}

async function openBinding(page: Page) {
  await sidebar(page);
  await page.locator('.awu-sidebar').getByText(session.title, { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /绑定能力/ }).click();
  return page.getByRole('dialog', { name: '绑定能力', exact: true });
}

async function openRepo(page: Page) {
  await sidebar(page);
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /Skills 与 Prompts/ }).click();
  return page.locator('#workbench-panel-library');
}

test('built-in Kit prompt defaults to auto, persists per session, and failed mode saves never look applied', async ({ page }, testInfo) => {
  const current = structuredClone(session) as typeof session & { abilities: { kitToolsMode?: string } };
  let fail = true;
  let saves = 0;
  let kitReads = 0;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listSessions') return reply([current]);
      if (frame.method === 'getBackends') return reply([]);
      if (frame.method === 'loadSessionMeta') return reply(current);
      if (frame.method === 'listSkills') return reply([skill]);
      if (frame.method === 'listPrompts') return reply([]);
      if (frame.method === 'kitGetState' && frame.params[0] === session.id) kitReads++;
      if (frame.method === 'updateSessionAbilities') {
        saves++;
        if (fail) return reply({ status: 'error', message: '模拟模式保存失败' });
        current.abilities = JSON.parse(frame.params[1]);
        return reply({ status: 'ok' });
      }
      server.send(message);
    });
  });
  await page.goto('/');
  let dialog = await openBinding(page);
  let mode = dialog.getByRole('combobox', { name: 'Kit 调用 Prompt 激活模式' });
  await expect(mode).toBeEnabled();
  await expect(mode).toHaveValue('auto');
  await expect(dialog).toContainText('新会话没有 Kit 时不附加');
  await mode.selectOption('off');
  await expect(dialog.getByRole('alert')).toContainText('模拟模式保存失败');
  await expect(mode).toHaveValue('auto');
  fail = false;
  await dialog.getByRole('textbox').fill('保留未保存的约束草稿');
  await mode.selectOption('off');
  await expect(mode).toHaveValue('off');
  await expect(dialog).toContainText('仍可从 Kit 面板操作');
  expect(current.abilities.constraints).toBe('保留未保存的约束草稿');
  await dialog.getByText(skill.name, { exact: true }).click();
  await expect.poll(() => current.abilities.skills).toEqual([skill.name]);
  expect(current.abilities.kitToolsMode).toBe('off');
  await expect(mode).toBeEnabled();
  const promptCard = dialog.getByRole('region', { name: '内置 Kit 调用 Prompt' });
  await promptCard.scrollIntoViewIfNeeded();
  const cardBounds = await promptCard.boundingBox();
  const constraintBounds = await dialog.getByText(/^临时约束\/rule/).boundingBox();
  expect(cardBounds).not.toBeNull();
  expect(constraintBounds).not.toBeNull();
  expect(cardBounds!.y + cardBounds!.height).toBeLessThanOrEqual(constraintBounds!.y);
  await page.screenshot({ path: testInfo.outputPath('kit-prompt-activation.png'), fullPage: false });
  await dialog.getByRole('button', { name: '关闭绑定能力' }).click();
  dialog = await openBinding(page);
  mode = dialog.getByRole('combobox', { name: 'Kit 调用 Prompt 激活模式' });
  await expect(mode).toHaveValue('off');
  await mode.selectOption('on');
  await expect(mode).toHaveValue('on');
  await expect(dialog).toContainText('不会自动创建或执行 Kit');
  await mode.selectOption('auto');
  await expect(mode).toHaveValue('auto');
  expect(saves).toBe(5);
  expect(kitReads).toBe(0); // Binding never loads full Kit definitions/logs or starts polling.
});

test('binding opens before metadata, never loads chat history, and failed saves remain visible', async ({ page }, testInfo) => {
  const pending: Array<() => void> = [];
  let loads = 0;
  let failSave = true;
  const mutations: unknown[][] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listSessions') return reply([session]);
      if (frame.method === 'getBackends') return reply([]);
      if (frame.method === 'loadSessionMeta') { pending.push(() => reply(session)); return; }
      if (frame.method === 'loadSession') { loads++; return reply({ ...session, messages: [] }); }
      if (frame.method === 'listSkills') return reply([skill]);
      if (frame.method === 'listPrompts') return reply([]);
      if (frame.method === 'updateSessionAbilities') {
        mutations.push(frame.params);
        return reply(failSave ? { status: 'error', message: '模拟保存失败' } : { status: 'ok' });
      }
      server.send(message);
    });
  });
  await page.goto('/');
  await sidebar(page);
  await expect(page.locator('.awu-sidebar').getByText(session.title, { exact: true })).toBeAttached();
  const before = loads;
  const dialog = await openBinding(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('正在加载能力库');
  await expect(dialog).not.toContainText('暂无 Skills');
  await expect(dialog.getByRole('button', { name: '保存并关闭' })).toBeDisabled();
  expect(loads).toBe(before);
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  pending.splice(0).forEach(release => release());
  await expect(dialog.getByText(skill.name, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue('已有约束');
  await dialog.getByText(skill.name, { exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('模拟保存失败');
  expect(mutations).toHaveLength(1);
  failSave = false;
  await dialog.getByText(skill.name, { exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(JSON.parse(String(mutations[1][1])).skills).toEqual([skill.name]);
  await page.screenshot({ path: testInfo.outputPath('skill-binding.png'), fullPage: true });
  await dialog.getByRole('button', { name: '保存并关闭' }).click();
  await expect(dialog).toHaveCount(0);
  expect(loads).toBe(before);
  expect(errors).toEqual([]);
});

test('closing a loading binding dialog cannot be undone by a late reply', async ({ page }) => {
  const pending: Array<() => void> = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listSessions') return reply([session]);
      if (frame.method === 'getBackends') return reply([]);
      if (frame.method === 'loadSessionMeta') { pending.push(() => reply(session)); return; }
      if (frame.method === 'listSkills' || frame.method === 'listPrompts') return reply([]);
      server.send(message);
    });
  });
  await page.goto('/');
  const dialog = await openBinding(page);
  await expect(dialog).toBeVisible();
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: '关闭绑定能力' }).click();
  pending.forEach(release => release());
  await expect(dialog).toHaveCount(0);
  // Reopen consumes a fresh lightweight read, never a cached modal state.
  const reopened = await openBinding(page);
  await expect(reopened).toBeVisible();
});

test('repo displays loading and retry instead of an empty library', async ({ page }, testInfo) => {
  let hold = true;
  let fail = false;
  let reads = 0;
  const pending: Array<() => void> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listSkills') {
        reads++;
        expect(frame.params[0]).toBe(''); // Node library, not a foreign Session workspace.
        const send = () => fail ? socket.send(JSON.stringify({ id: frame.id, error: '模拟库读取失败' })) : reply([skill]);
        if (hold) pending.push(send); else send();
        return;
      }
      if (frame.method === 'listPrompts') return reply([]);
      server.send(message);
    });
  });
  await page.goto('/');
  const repo = await openRepo(page);
  await expect(repo).toContainText('正在加载能力库');
  await expect(repo).not.toContainText('暂无 Skill');
  await expect(repo.getByRole('combobox', { name: '能力库所在节点' })).toHaveValue('local');
  hold = false;
  pending.splice(0).forEach(release => release());
  await expect(repo.getByText(skill.name, { exact: true })).toBeVisible();
  fail = true;
  await repo.getByRole('button', { name: '刷新能力库' }).click();
  await expect(repo.getByRole('alert')).toContainText('模拟库读取失败');
  await expect(repo).not.toContainText('暂无 Skill');
  fail = false;
  await repo.getByRole('button', { name: '重试加载' }).click();
  await expect(repo.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('skill-repo.png'), fullPage: true });
  expect(reads).toBe(3);
  expect(errors).toEqual([]);
});

test('repo ignores old-node replies and binding stays on the Session node after default changes', async ({ page }) => {
  const profile = { userId: 'library-qa', username: 'library-qa', displayName: 'Library QA', managed: false };
  const target = (deviceId: string) => ({ mode: 'relay', url: 'ws://127.0.0.1:45421/library-routing-qa',
    token: 'qa-fixture-not-a-credential', deviceId, deviceName: `库节点 ${deviceId}`, user: profile });
  await page.addInitScript(value => localStorage.setItem('awu.connectionTarget', JSON.stringify(value)), target('A'));
  let holdA = true;
  const pending: Array<() => void> = [];
  const saves: string[] = [];
  const inspections: string[] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    let node = 'local';
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.t === 'hello') { node = frame.deviceId; socket.send(JSON.stringify({ t: 'ready' })); return; }
      if (frame.method === 'listSessions') return reply(node === 'A' ? [session] : []);
      if (frame.method === 'loadSessionMeta') return reply(session);
      if (frame.method === 'getBackends' || frame.method === 'listPrompts') return reply([]);
      if (frame.method === 'listSkills') {
        const send = () => reply([{ ...skill, id: `skill-${node}`, name: `skill-${node}` }]);
        if (node === 'A' && holdA) pending.push(send); else send();
        return;
      }
      if (frame.method === 'updateSessionAbilities') { saves.push(node); return reply({ status: 'ok' }); }
      if (frame.method === 'skillRuntimeInspect') {
        inspections.push(node);
        return reply({ status: 'ok', plan: { status: 'ready', node: { host: `${node}-host`, os: 'Linux' },
          fileCount: 1, environment: `/isolated/${node}/skill-runtime`, steps: [] } });
      }
      server.send(message);
    });
  });
  await page.goto('/');
  const repo = await openRepo(page);
  await expect(repo).toContainText('正在加载能力库');
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  await page.evaluate(async value => {
    const modulePath = '/src/api.ts';
    const { setConnectionTarget } = await import(modulePath);
    await setConnectionTarget(value);
  }, target('B'));
  await expect(repo.getByRole('combobox', { name: '能力库所在节点' }).locator('option[value="relay:library-qa:B"]')).toBeAttached();
  await repo.getByRole('combobox', { name: '能力库所在节点' }).selectOption('relay:library-qa:B');
  await expect(repo.getByText('skill-B', { exact: true })).toBeVisible();
  holdA = false;
  pending.splice(0).forEach(release => release());
  await expect(repo.getByText('skill-A', { exact: true })).toHaveCount(0);
  await repo.getByRole('button', { name: '运行准备 / 状态', exact: true }).click();
  const runtime = page.getByRole('dialog', { name: 'Skill 运行准备' });
  await expect(runtime).toContainText('B-host');
  expect(inspections).toEqual(['B']);
  await runtime.getByRole('button', { name: '关闭运行准备' }).click();
  await sidebar(page);
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: 'Session 会话', exact: true }).click();
  const binding = await openBinding(page);
  await expect(binding).toContainText('库节点 A');
  await expect(binding.getByText('skill-A', { exact: true })).toBeVisible();
  await binding.getByText('skill-A', { exact: true }).click();
  await expect.poll(() => saves).toEqual(['A']);
  await expect(binding.getByText('skill-B', { exact: true })).toHaveCount(0);
});
