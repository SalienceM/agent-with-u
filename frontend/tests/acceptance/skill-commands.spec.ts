import { test, expect, type Page } from '@playwright/test';

const commands = [
  { name: '/skill openspec-apply-change', skillName: 'openspec-apply-change', digest: 'fixture-digest',
    description: '按变更任务实施', source: 'fixture/OpenSpec', kind: 'skill', requiresArguments: true },
  { name: '/opsx-apply', skillName: 'openspec-apply-change', digest: 'fixture-digest',
    description: 'OpenSpec 快捷入口', source: 'fixture/OpenSpec', kind: 'skill', requiresArguments: true },
];
async function openChat(page: Page, index = 0) {
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).nth(index).click();
  return page.locator('[data-session-tab-panel]:visible');
}

test('Skill commands load on demand, select without sending, and preserve arguments with a digest', async ({ page }, info) => {
  const sent: any[] = [];
  const reads: string[] = [];
  let finish: (() => void) | undefined;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (data: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(data) }));
      if (/^skillMarket|^skillRuntime|^activateSkill/.test(frame.method)) throw new Error('Unexpected install/market activity');
      if (frame.method === 'seqtaskGet') return reply({ status: 'ok', seqTasks: [], seqAuto: false });
      if (frame.method === 'listSessionSkillCommands') {
        reads.push(frame.params[0]);
        return reply({ status: 'ok', commands });
      }
      if (frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[0]);
        sent.push(payload);
        finish = () => {
          for (const type of ['error', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
            sessionId: payload.sessionId, messageId: payload.messageId, type,
            error: type === 'error' ? '[OPENSPEC_CLI_MISSING] 当前执行节点找不到 OpenSpec CLI；未自动安装。' : '',
          }) }));
        };
        return;
      }
      server.send(message);
    });
  });
  await page.goto('/');
  const pane = await openChat(page);
  const input = pane.locator('.chat-textarea');
  await expect(input).toBeVisible();
  expect(reads).toHaveLength(0);
  await input.fill('/opsx');
  const menu = pane.getByRole('listbox', { name: '聊天命令' });
  const option = menu.getByRole('option').filter({ hasText: '/opsx-apply' });
  await expect(option).toBeVisible();
  const count = reads.length;
  await input.fill('/opsx-');
  await page.waitForTimeout(1200);
  expect(reads).toHaveLength(count);
  await page.screenshot({ path: info.outputPath('skill-command-menu.png') });
  await option.click();
  await expect(input).toHaveValue('/opsx-apply ');
  expect(sent).toHaveLength(0);
  await input.fill('/opsx-apply market-cache "保留参数"; echo not-a-shell');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].skillInvocation).toEqual({ name: 'openspec-apply-change', digest: 'fixture-digest', arguments: 'market-cache "保留参数"; echo not-a-shell' });
  expect(sent[0].kitApprovalDelegation).toBe(false);
  expect(sent[0].sessionId).toBe(reads[0]);
  await input.fill('/opsx-apply another');
  await input.press('Enter');
  await expect(input).toHaveValue('/opsx-apply another');
  await expect(pane).toContainText('Skill 命令尚未发送');
  expect(sent).toHaveLength(1);
  finish!();
  await expect(pane).toContainText('OPENSPEC_CLI_MISSING');
  await page.screenshot({ path: info.outputPath('skill-command-error.png') });
});

test('no installed Skill still permits an explicit command with visible preflight error, app commands stay local', async ({ page }) => {
  const sent: any[] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (data: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(data) }));
      if (frame.method === 'seqtaskGet') return reply({ status: 'ok', seqTasks: [], seqAuto: false });
      if (frame.method === 'listSessionSkillCommands') return reply({ status: 'ok', commands: [] });
      if (frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[0]); sent.push(payload);
        for (const type of ['error', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
          sessionId: payload.sessionId, messageId: payload.messageId, type,
          error: type === 'error' ? '[SKILL_NOT_INSTALLED] 当前节点未安装 openspec-apply-change' : '',
        }) }));
        return;
      }
      server.send(message);
    });
  });
  await page.goto('/');
  const pane = await openChat(page);
  const input = pane.locator('.chat-textarea');
  await input.fill('/status');
  await input.press('Enter');
  await expect(pane).toContainText('会话状态');
  expect(sent).toHaveLength(0);
  await input.fill('/opsx-apply cache-change');
  await input.press('Enter');
  await expect(pane).toContainText('SKILL_NOT_INSTALLED');
  expect(sent).toHaveLength(1);
  expect(sent[0].content).toBe('/opsx-apply cache-change');
});

test('late list replies cannot populate another Session, and failures expose retry', async ({ page }) => {
  let pending: (() => void) | undefined;
  let firstSession = '';
  let fail = true;
  let reads = 0;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (data: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(data) }));
      if (frame.method === 'seqtaskGet') return reply({ status: 'ok', seqTasks: [], seqAuto: false });
      if (frame.method === 'sendMessage') throw new Error('Selection must never run a model');
      if (frame.method === 'listSessionSkillCommands') {
        reads++;
        if (!firstSession) firstSession = frame.params[0];
        if (frame.params[0] === firstSession) { pending = () => reply({ status: 'ok', commands }); return; }
        return reply(fail ? { status: 'error', message: '模拟节点暂时不可用' } : { status: 'ok', commands: [] });
      }
      server.send(message);
    });
  });
  await page.goto('/');
  let pane = await openChat(page);
  await pane.locator('.chat-textarea').fill('/');
  await expect.poll(() => reads).toBeGreaterThan(0);
  pane = await openChat(page, 1);
  await pane.locator('.chat-textarea').fill('/opsx');
  await expect(pane).toContainText('模拟节点暂时不可用');
  pending!();
  await expect(pane.getByRole('option').filter({ hasText: '/opsx-apply' })).toHaveCount(0);
  fail = false;
  await pane.getByRole('button', { name: '刷新 Skill 命令' }).click();
  await expect(pane).toContainText('没有匹配命令');
});

test('installed OpenSpec project commands require a separate send and disappear after uninstall refresh', async ({ page }, info) => {
  const sent: any[] = [];
  const reads: string[] = [];
  let installed = true;
  const projectCommands = ['init', 'update', 'list', 'status', 'show', 'validate', 'help', 'version'].map(action => ({
    name: `/opsx-${action}`, skillName: `openspec:${action}`, digest: 'a'.repeat(64), kind: 'project',
    description: '已安装 OpenSpec 的项目入口', source: 'AgentWithU', requiresArguments: false,
  }));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (/^skillMarket|^skillRuntime|^activateSkill/.test(frame.method)) throw new Error('No installation or activation');
      if (frame.method === 'seqtaskGet') {
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false }) }));
        return;
      }
      if (frame.method === 'listSessionSkillCommands') {
        reads.push(frame.params[0]);
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', commands: installed ? projectCommands : [] }) }));
        return;
      }
      if (frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[0]);
        sent.push(payload);
        for (const type of ['error', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
          sessionId: payload.sessionId, messageId: payload.messageId, type,
          error: type === 'error' ? '[OPENSPEC_CLI_MISSING] 测试未安装 CLI；未执行初始化。' : '',
        }) }));
        return;
      }
      server.send(message);
    });
  });
  await page.goto('/');
  const pane = await openChat(page);
  const input = pane.locator('.chat-textarea');
  await input.fill('/opsx-');
  const menu = pane.getByRole('listbox', { name: '聊天命令' });
  for (const action of ['init', 'update', 'list', 'status', 'show', 'validate', 'help', 'version']) {
    await expect(menu.getByRole('option').filter({ hasText: `/opsx-${action}` })).toHaveCount(1);
  }
  await page.screenshot({ path: info.outputPath('openspec-project-commands.png') });
  await menu.getByRole('option').filter({ hasText: '/opsx-init' }).click();
  await expect(input).toHaveValue('/opsx-init');
  await expect(menu).toBeHidden();
  expect(sent).toHaveLength(0);
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].content).toBe('/opsx-init');
  expect(sent[0].skillInvocation).toMatchObject({ name: 'openspec:init', arguments: '' });
  expect(sent[0].skillInvocation.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(sent[0].sessionId).toBe(reads[0]);
  expect(sent[0].kitApprovalDelegation).toBe(false);
  await expect(pane).toContainText('OPENSPEC_CLI_MISSING');
  await input.fill('/opsx-version');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await input.press('Enter'); // keyboard selection also only fills the draft
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue('/opsx-version');
  expect(sent).toHaveLength(1);
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].skillInvocation).toMatchObject({ name: 'openspec:version', arguments: '' });
  installed = false;
  await input.fill('/opsx-');
  await expect(menu).toContainText('没有匹配命令');
  await expect(menu.getByRole('option')).toHaveCount(0);
  expect(sent).toHaveLength(2);
});

test('executor without OpenSpec Skill exposes no OpenSpec project menu or generic help entries', async ({ page }, info) => {
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (/^skillMarket|^skillRuntime|^activateSkill|^sendMessage$/.test(frame.method)) throw new Error('Read-only command discovery');
      if (frame.method === 'seqtaskGet') {
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false }) }));
        return;
      }
      server.send(message); // Use the real executor catalog, not a mocked empty result.
    });
  });
  await page.goto('/');
  const pane = await openChat(page);
  const input = pane.locator('.chat-textarea');
  await input.fill('/help');
  await input.press('Enter');
  await expect(pane).toContainText('可用命令');
  await expect(pane).not.toContainText('/opsx-');
  await input.fill('/opsx-');
  const menu = pane.getByRole('listbox', { name: '聊天命令' });
  await expect(menu).toContainText('没有匹配命令');
  await expect(menu.getByRole('option')).toHaveCount(0);
  await expect(menu).not.toContainText('/opsx-init');
  await page.screenshot({ path: info.outputPath('no-openspec-when-uninstalled.png') });
});
