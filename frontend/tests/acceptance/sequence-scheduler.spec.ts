import { test, expect, type Page } from '@playwright/test';

async function openChat(page: Page) {
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  return page.locator('[data-session-tab-panel]:visible');
}

async function mockSequence(page: Page) {
  let sid = '';
  let auto = true;
  let error = '';
  let tasks: any[] = [{ id: 'queued-1', text: '执行端队列第一条', status: 'pending' }];
  let socket: any;
  const actions: string[] = [];
  const snapshot = () => ({ status: 'ok', sessionId: sid, seqTasks: tasks, seqAuto: auto, seqError: error });
  const emit = (event: string, data: unknown) => socket.send(JSON.stringify({ event, data: JSON.stringify(data) }));
  await page.routeWebSocket(/.*/, ws => {
    socket = ws;
    const server = ws.connectToServer();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (data: unknown) => ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify(data) }));
      if (frame.method === 'seqtaskTakeNext' || frame.method === 'sendMessage') {
        actions.push(frame.method);
        throw new Error('Controller must not dispatch executor-owned sequence');
      }
      if (frame.method === 'seqtaskGet') { sid = frame.params[0]; return reply(snapshot()); }
      if (frame.method === 'seqtaskSetAuto') {
        actions.push(`auto:${frame.params[1]}`);
        auto = frame.params[1]; error = '';
        if (auto) tasks = tasks.map(task => task.status === 'error' ? { ...task, status: 'pending', error: '' } : task);
        reply(snapshot()); emit('seqtaskUpdated', snapshot()); return;
      }
      if (frame.method === 'seqtaskAdd') {
        tasks.push({ id: `queued-${tasks.length + 1}`, text: frame.params[1], status: 'pending' });
        reply(snapshot()); emit('seqtaskUpdated', snapshot()); return;
      }
      server.send(message);
    });
  });
  return {
    actions,
    state: () => snapshot(),
    pauseRemotely: () => { auto = false; emit('seqtaskUpdated', snapshot()); },
    fail: () => {
      auto = false; error = '测试：并发不足，核对后重试';
      tasks[0] = { ...tasks[0], status: 'error', error };
      emit('seqtaskUpdated', snapshot());
    },
    start: (n: number) => {
      emit('sessionUpdated', { type: 'chat_turn_started', sessionId: sid, messages: [
        { id: `seq-u-${n}`, role: 'user', content: `服务端自动消息 ${n}`, timestamp: Date.now() / 1000 },
        { id: `seq-a-${n}`, role: 'assistant', content: '', streaming: true, timestamp: Date.now() / 1000 },
      ] });
    },
    finish: (n: number) => {
      emit('streamDelta', { sessionId: sid, messageId: `seq-a-${n}`, type: 'text_delta', text: `服务端完成回复 ${n}` });
      emit('streamDelta', { sessionId: sid, messageId: `seq-a-${n}`, type: 'done' });
    },
  };
}

test('executor auto state persists across reload; pause and resume only mutate state', async ({ page }, info) => {
  const fixture = await mockSequence(page);
  await page.goto('/');
  let pane = await openChat(page);
  await expect(pane.getByRole('button', { name: '⏸ 暂停', exact: true })).toBeVisible();
  await pane.getByRole('button', { name: '⏸ 暂停', exact: true }).click();
  await expect(pane).toContainText('执行端已暂停后续任务');
  const input = pane.locator('.chat-textarea');
  await input.fill('暂停期间新增任务');
  await input.press('Enter');
  await expect.poll(() => fixture.state().seqTasks.length).toBe(2);
  expect(fixture.state().seqAuto).toBe(false);
  await page.reload();
  pane = await openChat(page);
  await expect(pane.getByRole('button', { name: '▶ 继续', exact: true })).toBeVisible();
  await pane.getByRole('button', { name: '▶ 继续', exact: true }).click();
  await expect(pane.getByRole('button', { name: '⏸ 暂停', exact: true })).toBeVisible();
  expect(fixture.actions).toEqual(['auto:false', 'auto:true']);
  await page.screenshot({ path: info.outputPath('sequence-controls.png') });
});

test('another controller can pause; failures show retry without model dispatch', async ({ page }) => {
  const fixture = await mockSequence(page);
  await page.goto('/');
  const pane = await openChat(page);
  await expect(pane).toContainText('序列队列');
  fixture.pauseRemotely();
  await expect(pane.getByRole('button', { name: '▶ 继续', exact: true })).toBeVisible();
  fixture.fail();
  await expect(pane).toContainText('并发不足');
  await pane.getByRole('button', { name: '↻ 重试并继续', exact: true }).click();
  await expect(pane.getByRole('button', { name: '⏸ 暂停', exact: true })).toBeVisible();
  expect(fixture.actions).toEqual(['auto:true']);
});

test('executor-originated turns render user and assistant in order without frontend send', async ({ page }) => {
  const fixture = await mockSequence(page);
  await page.goto('/');
  const pane = await openChat(page);
  await expect(pane).toContainText('序列队列');
  for (const n of [1, 2]) {
    fixture.start(n);
    await expect(pane.getByText(`服务端自动消息 ${n}`, { exact: true })).toBeVisible();
    fixture.finish(n);
    await expect(pane.getByText(`服务端完成回复 ${n}`, { exact: true })).toBeVisible();
  }
  const content = await pane.innerText();
  expect(content.indexOf('服务端自动消息 1')).toBeLessThan(content.indexOf('服务端完成回复 1'));
  expect(content.indexOf('服务端完成回复 1')).toBeLessThan(content.indexOf('服务端自动消息 2'));
  expect(fixture.actions).toEqual([]);
});
