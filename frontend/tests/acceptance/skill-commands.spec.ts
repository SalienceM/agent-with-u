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
