import { test, expect, type Page } from '@playwright/test';

const command = '/opsx-apply persist-login-debug-preference';
const customCommand = '/team-review "当前项目 <验收>"';
const examples = [
  { id: 'suggestion', role: 'assistant', timestamp: 1, content: `准备好后，可以继续执行：\n\n\`${command}\`\n\n这一步会按照变更任务实施。` },
  { id: 'fenced', role: 'assistant', timestamp: 2, content: `也可以使用仓库配置的命令：\n\n\`\`\`text\n${customCommand}\n\`\`\`` },
];

async function fixtures(page: Page, messages: any[] = examples) {
  const requests: string[] = [];
  const sent: any[] = [];
  let emit = (_payload: any, _type: string, _text = '') => {};
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    const loads = new Set<string>();
    emit = (payload, type, text = '') => socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
      sessionId: payload.sessionId, messageId: payload.messageId, type,
      ...(type === 'error' ? { error: text } : { text }),
    }) }));
    server.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (loads.delete(frame.id)) {
        const session = JSON.parse(frame.result);
        frame.result = JSON.stringify({ ...session, messages, messageCount: messages.length });
      }
      socket.send(JSON.stringify(frame));
    });
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      requests.push(frame.method);
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (/^skillMarket|^skillRuntime|^activateSkill|^seqtask(Add|Edit|SetAuto)$/.test(frame.method)) {
        throw new Error(`Draft insertion must not execute or queue: ${frame.method}`);
      }
      if (frame.method === 'seqtaskGet') return reply({ status: 'ok', seqTasks: [], seqAuto: false });
      if (frame.method === 'listSessionSkillCommands') return reply({ status: 'ok', commands: [{
        name: '/opsx-apply', skillName: 'openspec-apply-change', digest: 'fixture-digest',
        kind: 'skill', description: '按变更任务实施', requiresArguments: true,
      }] });
      if (frame.method === 'sendMessage') { sent.push(JSON.parse(frame.params[0])); return; }
      if (frame.method === 'loadSession') loads.add(frame.id);
      server.send(raw);
    });
  });
  await page.goto('/');
  return { requests, sent, emit: (payload: any, type: string, text = '') => emit(payload, type, text) };
}

async function openChat(page: Page, index = 0) {
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).nth(index).click();
  return page.locator('[data-session-tab-panel]:visible');
}

test('inline and fenced suggestions fill and focus without sending; keyboard activation stays draft-only', async ({ page }, info) => {
  const { requests, sent } = await fixtures(page);
  const pane = await openChat(page);
  const input = pane.locator('.chat-textarea');
  const inline = pane.getByRole('button', { name: `填入输入框：${command}`, exact: true });
  const fenced = pane.getByRole('button', { name: `填入输入框：${customCommand}`, exact: true });
  await expect(inline).toBeVisible();
  await expect(fenced).toBeVisible();
  await expect(pane.locator('.command-draft-btn')).toHaveCount(2);
  await inline.click();
  await expect(input).toHaveValue(command);
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([command.length, command.length]);
  await expect(pane.getByRole('status').filter({ hasText: '已填入输入框，未发送' })).toBeVisible();
  // Repeated click must not append/duplicate or require a confirmation.
  page.on('dialog', () => { throw new Error('Unchanged draft needs no confirmation'); });
  await inline.click();
  await input.fill('');
  await fenced.focus();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(customCommand);
  await expect(input).toBeFocused();
  await input.fill('');
  await inline.focus();
  await page.keyboard.press('Space');
  await expect(input).toHaveValue(command);
  expect(sent).toHaveLength(0);
  expect(requests.filter(method => method === 'listSessionSkillCommands')).toHaveLength(0);
  // The copyable code itself remains unchanged; the new action sits outside it.
  await expect(pane.locator('pre.md-pre > code')).not.toContainText('填入输入框');
  await expect(pane.locator('pre.md-pre .code-copy-btn')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('command-draft.png') });
});

test('existing drafts require confirmation, attachments survive, and Session tabs stay isolated', async ({ page }) => {
  const { sent } = await fixtures(page);
  const paneA = await openChat(page);
  const idA = await paneA.getAttribute('data-session-tab-panel');
  const inputA = paneA.locator('.chat-textarea');
  await inputA.fill('保留我原来的问题');
  await paneA.locator('input[type=file]').setInputFiles([
    { name: 'requirements.txt', mimeType: 'text/plain', buffer: Buffer.from('不得丢失附件') },
    { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS7kAAAAASUVORK5CYII=', 'base64') },
  ]);
  await expect(paneA.getByText('requirements.txt', { exact: true })).toBeVisible();
  await expect(paneA.getByRole('img', { name: 'Pasted', exact: true })).toBeVisible();
  const fill = paneA.getByRole('button', { name: `填入输入框：${command}`, exact: true });
  page.once('dialog', dialog => dialog.dismiss());
  await fill.click();
  await expect(inputA).toHaveValue('保留我原来的问题');
  page.once('dialog', dialog => dialog.accept());
  await fill.click();
  await expect(inputA).toHaveValue(command);
  await expect(paneA.getByText('requirements.txt', { exact: true })).toBeVisible();
  await expect(paneA.getByRole('img', { name: 'Pasted', exact: true })).toBeVisible();
  await expect(paneA.getByRole('status').filter({ hasText: '现有附件已保留' })).toBeVisible();
  const paneB = await openChat(page, 1);
  const idB = await paneB.getAttribute('data-session-tab-panel');
  expect(idB).not.toBe(idA);
  await paneB.getByRole('button', { name: `填入输入框：${customCommand}`, exact: true }).click();
  await expect(paneB.locator('.chat-textarea')).toHaveValue(customCommand);
  await expect(page.locator(`[data-session-tab-panel="${idA}"] .chat-textarea`)).toHaveValue(command);
  await openChat(page, 0);
  await expect(page.locator(`[data-session-tab-panel="${idB}"] .chat-textarea`)).toHaveValue(customCommand);
  await expect(page.locator(`[data-session-tab-panel="${idA}"]`).getByText('requirements.txt', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(0);
});

test('only finalized assistant command code is enhanced, including ordered text blocks', async ({ page }) => {
  const { sent } = await fixtures(page, [
    { id: 'user', role: 'user', content: '`/user-command`', timestamp: 1 },
    { id: 'system', role: 'system', content: '`/system-command`', timestamp: 2 },
    { id: 'non-command', role: 'assistant', timestamp: 3,
      content: '`/tmp/example` `https://example.test` `openspec init`\n\n```text\n/first\n/second\n```' },
    { id: 'ordered', role: 'assistant', timestamp: 4, content: '`/part-one`\n\n`/part-two arg`',
      thinking: '`/thinking-command`',
      toolCalls: [{ id: 'tool', name: 'Read', input: { path: '/tool-input' }, result: '`/tool-result`', status: 'completed' }],
      contentBlocks: [{ type: 'thinking' }, { type: 'text', text: '`/part-one`' }, { type: 'tool', toolIndex: 0 }, { type: 'text', text: '`/part-two arg`' }] },
  ]);
  const pane = await openChat(page);
  await expect(pane.locator('.command-draft-btn')).toHaveCount(2);
  await expect(pane.getByRole('button', { name: '填入输入框：/part-one', exact: true })).toBeVisible();
  await pane.getByRole('button', { name: '填入输入框：/part-two arg', exact: true }).click();
  await expect(pane.locator('.chat-textarea')).toHaveValue('/part-two arg');
  await expect(pane.locator('.command-draft-btn')).toHaveCount(2);
  expect(sent).toHaveLength(0);
});

test('streaming suggestions wait until done; filling during a turn never queues and explicit send keeps preflight', async ({ page }) => {
  const { sent, emit } = await fixtures(page, [examples[0]]);
  const pane = await openChat(page);
  const input = pane.locator('.chat-textarea');
  await input.fill('模拟一个进行中的回答');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  emit(sent[0], 'text_delta', '请运行 `/custom-next draft`');
  await expect(pane).toContainText('/custom-next draft');
  await expect(pane.getByRole('button', { name: '填入输入框：/custom-next draft', exact: true })).toHaveCount(0);
  await pane.getByRole('button', { name: `填入输入框：${command}`, exact: true }).click();
  await expect(input).toHaveValue(command);
  expect(sent).toHaveLength(1);
  await input.press('Enter');
  await expect(pane.getByRole('alert')).toContainText('Skill 命令尚未发送');
  expect(sent).toHaveLength(1);
  emit(sent[0], 'done');
  await expect(pane.getByRole('button', { name: '填入输入框：/custom-next draft', exact: true })).toHaveCount(1);
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(2);
  await expect(pane.getByRole('status').filter({ hasText: '已填入' })).toHaveCount(0);
  // Filling does not discover/register commands. Without a cached catalog the
  // original slash text reaches the executor's authoritative send-time resolver.
  expect(sent[1].content).toBe(command);
  expect(sent[1].skillInvocation).toBeUndefined();
  expect(sent[1].kitApprovalDelegation).toBe(false);
  emit(sent[1], 'error', '[OPENSPEC_CLI_MISSING] 测试节点未安装 CLI；未执行命令。');
  emit(sent[1], 'done');
  await expect(pane).toContainText('OPENSPEC_CLI_MISSING');
});
