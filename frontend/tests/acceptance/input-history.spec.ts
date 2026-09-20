import { test, expect, type Page } from '@playwright/test';

async function mockChat(page: Page, sent: any[], legacyText = '') {
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    const loads = new Set<unknown>();
    server.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (legacyText && loads.delete(frame.id)) {
        const session = JSON.parse(frame.result);
        session.messages.unshift({ id: 'legacy-input', role: 'user', content: legacyText, timestamp: 1785000000 });
        session.messagesTotal = (session.messagesTotal || 1) + 1;
        frame.result = JSON.stringify(session);
        socket.send(JSON.stringify(frame));
      } else socket.send(message);
    });
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'loadSession') loads.add(frame.id);
      if (frame.method === 'seqtaskGet') {
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false }) }));
      } else if (frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[0]);
        sent.push(payload);
        for (const type of ['text_delta', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
          sessionId: payload.sessionId, messageId: payload.messageId, type, text: type === 'text_delta' ? '输入历史隔离测试完成' : '',
        }) }));
      } else server.send(message);
    });
  });
}

async function openSession(page: Page, index = 0) {
  const sidebar = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).nth(index).click();
  return page.locator('[data-session-tab-panel]:visible');
}

test('input recall survives reload and a fresh browser context without attachments or Kit approval', async ({ page, browser }, testInfo) => {
  const sent: any[] = [];
  await mockChat(page, sent);
  await page.goto('/');
  const pane = await openSession(page);
  const input = pane.locator('.chat-textarea');
  const optIn = pane.getByRole('switch', { name: '本次允许 Kit 代确认' });
  const first = '保留上一条操作：只检查目录';
  const latest = '请检查当前项目\n再整理需求，不要发布';
  await expect(optIn).toBeEnabled();
  await input.fill(first);
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  await expect(optIn).toBeEnabled();
  await optIn.click();
  await pane.locator('input[type="file"]').setInputFiles({
    name: 'reference.txt', mimeType: 'text/plain', buffer: Buffer.from('ATTACHMENT_BODY_MUST_NOT_BE_RECALLED'),
  });
  await input.fill(latest);
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].kitApprovalDelegation).toBe(true);
  expect(JSON.stringify(sent[1].textAttachments)).toContain('ATTACHMENT_BODY_MUST_NOT_BE_RECALLED');
  await expect(optIn).toBeEnabled();
  await page.reload();
  await expect(input).toBeVisible();
  await input.fill('尚未发送的草稿');
  await input.press('ArrowUp');
  await expect(input).toHaveValue(latest);
  await expect(optIn).not.toBeChecked();
  await input.press('ArrowUp'); // 多行记录可继续翻，不被末行光标困住。
  await expect(input).toHaveValue(first);
  await input.press('ArrowDown');
  await expect(input).toHaveValue(latest);
  await input.press('ArrowDown');
  await expect(input).toHaveValue('尚未发送的草稿');
  await input.press('ArrowUp');
  await input.press('Escape');
  await expect(input).toHaveValue('尚未发送的草稿');
  await input.fill('');
  const id = await pane.getAttribute('data-session-tab-panel');
  const url = page.url();
  // 只携带磁盘 localStorage，不保留组件、模块内存或 sessionStorage，模拟退出后重开。
  const state = await page.context().storageState();
  const historyRecords = state.origins.flatMap(origin => origin.localStorage.filter(item => item.name.startsWith('agent-with-u:input-history:')));
  expect(JSON.stringify(historyRecords)).not.toContain('ATTACHMENT_BODY_MUST_NOT_BE_RECALLED');
  await page.close();
  const restarted = await browser.newContext({ storageState: state, viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch });
  try {
    const next = await restarted.newPage();
    await mockChat(next, sent);
    await next.goto(url);
    const restoredPane = next.locator('[data-session-tab-panel]:visible');
    await expect(restoredPane).toHaveAttribute('data-session-tab-panel', id!);
    const restoredInput = restoredPane.locator('.chat-textarea');
    await restoredInput.press('ArrowUp');
    await expect(restoredInput).toHaveValue(latest);
    await expect(restoredPane.getByRole('switch', { name: '本次允许 Kit 代确认' })).not.toBeChecked();
    expect(sent).toHaveLength(2); // 回看并不会重新发送。
    const another = await openSession(next, 1);
    const anotherInput = another.locator('.chat-textarea');
    await anotherInput.press('ArrowUp');
    await expect(anotherInput).not.toHaveValue(latest);
    await openSession(next);
    await restoredInput.fill('');
    await restoredInput.press('ArrowUp');
    await expect(restoredInput).toHaveValue(latest);
    await next.screenshot({ path: testInfo.outputPath('input-history-restarted.png'), fullPage: true });
  } finally { await restarted.close(); }
});

test('legacy user messages seed recall and local slash commands remain newer after reload', async ({ page }) => {
  const sent: any[] = [];
  const legacyText = '从旧会话恢复这条用户输入';
  await mockChat(page, sent, legacyText);
  await page.goto('/');
  const pane = await openSession(page);
  const input = pane.locator('.chat-textarea');
  const id = await pane.getAttribute('data-session-tab-panel');
  // 让当前 Session 的正常水合完成；不为回看增加消息读取。
  await expect(pane.getByText('这是用于首页运行态验收的固定数据。', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(session => {
    const key = Object.keys(localStorage).find(item => item.startsWith('agent-with-u:input-history:v1:') && item.endsWith(`:${session}`));
    return key ? JSON.parse(localStorage.getItem(key)!).entries : [];
  }, id)).toEqual([legacyText]);
  await input.press('ArrowUp');
  await expect(input).toHaveValue(legacyText);
  await input.fill('/cost');
  await input.press('Escape'); // 关闭补全，按普通发送路径提交本地命令。
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await page.reload();
  await expect(input).toBeVisible();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('/cost');
  expect(sent).toHaveLength(0);
});
