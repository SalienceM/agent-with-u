import { test, expect, type Page } from '@playwright/test';

async function sidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

test('parent command configuration edits, rejects stale save, imports and exports without execution', async ({ page }, info) => {
  const parent = { id: 'repo.123456789abcdef0', name: 'Review Suite', repository: 'example/review', revision: 'parent1' };
  const owners = ['reviewer', 'tester'];
  let content = JSON.stringify({ schemaVersion: 1, id: 'review-suite', skillIds: owners, commands: [] }, null, 2);
  let revision = 'r1';
  let failSave = true;
  const saves: any[][] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (data: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(data) }));
      if (['sendMessage', 'activateSkill', 'skillRuntimePrepare', 'skillMarketInstall'].includes(frame.method)) throw new Error('Unexpected execution');
      if (frame.method === 'listSkills') return reply(owners.map(name => ({ name, description: 'Review projects', content: '# Fixture', parent })));
      if (frame.method === 'listPrompts') return reply([]);
      if (frame.method === 'getSkillCommandConfig') {
        expect(frame.params).toEqual([parent.id]);
        return reply({ status: 'ok', name: parent.id, owners, content, revision, origin: 'new', warnings: [] });
      }
      if (frame.method === 'saveSkillCommandConfig') {
        saves.push(frame.params);
        if (failSave) return reply({ status: 'error', message: '命令配置已变化，请刷新后重新确认' });
        expect(frame.params[0]).toBe(parent.id); expect(frame.params[2]).toBe(revision);
        content = frame.params[1]; revision = 'r2';
        return reply({ status: 'ok', name: parent.id, owners, content, revision, origin: 'package', warnings: [] });
      }
      server.send(message);
    });
  });
  await page.goto('/'); await sidebar(page);
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /Skills 与 Prompts/ }).click();
  const group = page.getByRole('region', { name: 'Skill 仓库 Review Suite', exact: true });
  await group.getByRole('button', { name: '管理 Review Suite', exact: true }).click();
  await group.getByRole('button', { name: '/ 命令配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Skill 命令配置', exact: true });
  await expect(dialog).toContainText('reviewer、tester');
  const input = dialog.getByRole('textbox', { name: '命令配置 JSON' });
  await expect(input).toHaveValue(content);
  const declaration = { schemaVersion: 1, id: 'review-suite', skillIds: owners,
    commands: [{ name: '/review-plan', description: 'Review project', kind: 'skill', skillId: 'reviewer' }] };
  await dialog.locator('input[type=file]').setInputFiles({ name: 'awu.commands.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(declaration, null, 2)) });
  expect(JSON.parse(await input.inputValue())).toEqual(declaration);
  await dialog.getByRole('button', { name: '校验并保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('配置已变化');
  expect(JSON.parse(await input.inputValue())).toEqual(declaration);
  failSave = false;
  await dialog.getByRole('button', { name: '校验并保存', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存到 Skill 包内');
  expect(saves).toHaveLength(2);
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('awu.commands.json');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(declaration);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: info.outputPath('command-config.png') });
  await dialog.getByText('最小声明示例与分享说明', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: '校验并保存', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('generic aliases share the menu/send route and registry issues are visible', async ({ page }, info) => {
  const sent: any[] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (data: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(data) }));
      if (frame.method === 'seqtaskGet') return reply({ status: 'ok', seqTasks: [], seqAuto: false });
      if (frame.method === 'listSessionSkillCommands') return reply({ status: 'ok', commands: [
        { name: '/review-plan', description: 'Review project', kind: 'skill', family: 'review-suite', skillName: 'command:review-suite:review-plan', digest: 'definition1', source: 'Skill 配置', requiresArguments: true }
      ], issues: [{ source: '/conflict', message: '多个配置声明同名命令，入口已停用' }] });
      if (frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[0]); sent.push(payload);
        for (const type of ['error', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({ sessionId: payload.sessionId, messageId: payload.messageId, type, error: '[SKILL_CHANGED] 配置已更新' }) }));
        return;
      }
      server.send(message);
    });
  });
  await page.goto('/'); await sidebar(page);
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  const input = pane.locator('.chat-textarea');
  await input.fill('/review');
  const menu = pane.getByRole('listbox', { name: '聊天命令' });
  await expect(menu).toContainText('同名命令');
  await menu.getByRole('option').filter({ hasText: '/review-plan' }).click();
  await expect(input).toHaveValue('/review-plan ');
  expect(sent).toHaveLength(0);
  await input.fill('/review-plan inspect current project'); await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].skillInvocation).toEqual({ name: 'command:review-suite:review-plan', arguments: 'inspect current project', digest: 'definition1' });
  await expect(pane).toContainText('SKILL_CHANGED');
  await page.screenshot({ path: info.outputPath('generic-command.png') });
});
