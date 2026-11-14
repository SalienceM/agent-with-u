import { test, expect } from '@playwright/test';

test('Kit delegation is an explicit one-send flag, never inferred or carried to another session', async ({ page }, testInfo) => {
  const sent: any[] = [];
  let finish: (() => void) | undefined;
  // 所有聊天发送被拦截；验收不调用模型，也不执行任何真实 Kit / 发布。
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      if (frame.method === 'seqtaskGet') {
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false }) }));
      } else if (frame.method === 'composerSubmit' || frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[frame.method === 'composerSubmit' ? 1 : 0]);
        sent.push(payload);
        if (frame.method === 'composerSubmit') {
          socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ ...payload, revision: 1, state: 'accepted' }) }));
        }
        finish = () => {
          for (const type of ['text_delta', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
            sessionId: payload.sessionId, messageId: payload.messageId, type, text: type === 'text_delta' ? '隔离测试完成' : '',
          }) }));
        };
      } else if (['seqtaskAdd', 'steerMessage', 'redirectMessage', 'harnessImageSubmit', 'harnessImageQueue'].includes(frame.method)) {
        throw new Error(`Unexpected model write in Kit fixture: ${frame.method}`);
      } else server.send(message);
    });
  });
  const openSidebar = async () => {
    const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
    if (await opener.isVisible()) await opener.click();
  };
  await page.goto('/');
  await openSidebar();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  const optIn = page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true });
  const enableDelegation = async () => {
    await pane.getByRole('button', { name: '更多输入工具', exact: true }).click();
    const section = page.getByRole('dialog', { name: '更多输入工具', exact: true }).locator('details:not([open]) > summary').filter({ hasText: '确认与提醒' });
    if (await section.count()) await section.click();
    await page.getByRole('dialog', { name: '更多输入工具', exact: true }).getByRole('switch', { name: '本次允许 Kit 代确认' }).click();
    await page.keyboard.press('Escape');
  };
  const input = pane.locator('.chat-textarea');
  await expect(optIn).not.toBeChecked();
  await expect(optIn).toBeEnabled();
  await input.fill('我授权你代确认（正文不等于开关）');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].kitApprovalDelegation).toBe(false);
  await expect(optIn).toBeDisabled();
  finish!();
  await expect(optIn).toBeEnabled();

  await enableDelegation();
  await expect(optIn).toBeChecked();
  await expect(optIn).toContainText('仅本次');
  await input.fill('按顺序打包并发布，请核对本次发布计划');
  await page.screenshot({ path: testInfo.outputPath('kit-delegation-opt-in.png'), fullPage: true });
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].kitApprovalDelegation).toBe(true);
  await expect(optIn).not.toBeChecked();
  await expect(optIn).toBeDisabled();
  finish!();
  await expect(optIn).toBeEnabled();

  await input.fill('普通后续消息');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2].kitApprovalDelegation).toBe(false);
  finish!();
  await expect(optIn).toBeEnabled();
  await enableDelegation();
  await openSidebar();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).nth(1).click();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', checked: true, includeHidden: true })).toHaveCount(0);
  await openSidebar();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', checked: true, includeHidden: true })).toHaveCount(0);
  await enableDelegation();
  await page.reload();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', checked: true, includeHidden: true })).toHaveCount(0);
  expect(sent).toHaveLength(3);
});
