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
  let busy = false;
  let nativeSteer = false;
  let capabilityError = false;
  let capabilityRequests = 0;
  let holdCapabilities = false;
  const heldCapabilities: Array<() => void> = [];
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
      if (frame.method === 'getSessionRunState') return reply({ status: 'ok', busy });
      if (frame.method === 'getFollowUpCapabilities') {
        capabilityRequests += 1;
        const response = capabilityError
          ? { status: 'error', message: '测试：能力查询暂时失败' }
          : { status: 'ok', queue: true, nativeSteer, interruptResume: false, steerAttachments: nativeSteer };
        if (holdCapabilities) heldCapabilities.push(() => reply(response));
        else reply(response);
        return;
      }
      if (frame.method === 'steerSeqTask') {
        actions.push(`steer:${frame.params[1]}`);
        if (!busy || !nativeSteer) return reply({ status: 'unsupported' });
        tasks = tasks.filter(task => task.id !== frame.params[1]);
        reply({ status: 'ok' }); emit('seqtaskUpdated', snapshot()); return;
      }
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
    capabilities: (supported: boolean, failed = false) => { nativeSteer = supported; capabilityError = failed; },
    capabilityRequests: () => capabilityRequests,
    holdCapabilities: (hold: boolean) => { holdCapabilities = hold; },
    releaseCapabilities: () => { heldCapabilities.splice(0).forEach(reply => reply()); },
    disconnect: () => socket.close({ code: 1001, reason: 'QA reconnect' }),
    pauseRemotely: () => { auto = false; emit('seqtaskUpdated', snapshot()); },
    fail: () => {
      auto = false; error = '测试：并发不足，核对后重试';
      tasks[0] = { ...tasks[0], status: 'error', error };
      emit('seqtaskUpdated', snapshot());
    },
    start: (n: number) => {
      busy = true;
      emit('sessionUpdated', { type: 'chat_turn_started', sessionId: sid, messages: [
        { id: `seq-u-${n}`, role: 'user', content: `服务端自动消息 ${n}`, timestamp: Date.now() / 1000 },
        { id: `seq-a-${n}`, role: 'assistant', content: '', streaming: true, timestamp: Date.now() / 1000 },
      ] });
    },
    finish: (n: number) => {
      busy = false;
      emit('streamDelta', { sessionId: sid, messageId: `seq-a-${n}`, type: 'text_delta', text: `服务端完成回复 ${n}` });
      emit('streamDelta', { sessionId: sid, messageId: `seq-a-${n}`, type: 'done' });
    },
    progress: (n: number, text: string) => {
      emit('streamDelta', { sessionId: sid, messageId: `seq-a-${n}`, type: 'text_delta', text });
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

test('native queue steering is available only during a supported active turn', async ({ page }, info) => {
  const fixture = await mockSequence(page);
  fixture.capabilities(true);
  await page.goto('/');
  const pane = await openChat(page);
  await pane.getByTitle('展开队列', { exact: true }).click();
  const steer = pane.getByRole('button', { name: '↪ 引导', exact: true });
  await expect(steer).toHaveCount(0);
  fixture.start(1);
  await expect(steer).toBeVisible();
  fixture.finish(1);
  await expect(steer).toHaveCount(0);
  fixture.start(2);
  await expect(steer).toBeVisible();
  const requests = fixture.capabilityRequests();
  fixture.progress(2, '持续输出不重复查询能力');
  await expect(pane.getByText('持续输出不重复查询能力', { exact: true })).toBeVisible();
  expect(fixture.capabilityRequests()).toBe(requests);
  await page.screenshot({ path: info.outputPath('native-steering.png') });
  await steer.click();
  await expect.poll(() => fixture.state().seqTasks.length).toBe(0);
  expect(fixture.actions).toEqual(['steer:queued-1']);
});

test('failed capability lookup recovers at the next active turn', async ({ page }) => {
  const fixture = await mockSequence(page);
  fixture.capabilities(true, true);
  await page.goto('/');
  const pane = await openChat(page);
  await pane.getByTitle('展开队列', { exact: true }).click();
  await expect.poll(fixture.capabilityRequests).toBeGreaterThan(0);
  fixture.capabilities(true);
  fixture.start(1);
  await expect(pane.getByRole('button', { name: '↪ 引导', exact: true })).toBeVisible();
  expect(fixture.actions).toEqual([]);
});

test('reconnection refreshes failed steering capabilities without changing backend', async ({ page }) => {
  const fixture = await mockSequence(page);
  fixture.capabilities(true, true);
  await page.goto('/');
  const pane = await openChat(page);
  await pane.getByTitle('展开队列', { exact: true }).click();
  fixture.start(1);
  await expect(pane.getByText('服务端自动消息 1', { exact: true })).toBeVisible();
  await expect.poll(fixture.capabilityRequests).toBeGreaterThan(0);
  fixture.capabilities(true);
  fixture.disconnect();
  await expect(pane.getByRole('button', { name: '↪ 引导', exact: true })).toBeVisible();
  expect(fixture.actions).toEqual([]);
});

test('unsupported backend never offers native steering', async ({ page }) => {
  const fixture = await mockSequence(page);
  await page.goto('/');
  const pane = await openChat(page);
  await pane.getByTitle('展开队列', { exact: true }).click();
  fixture.start(1);
  await expect(pane.getByText('服务端自动消息 1', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: '↪ 引导', exact: true })).toHaveCount(0);
  expect(fixture.actions).toEqual([]);
});

test('capability failure is visible and retry never sends a queued task', async ({ page }, info) => {
  const fixture = await mockSequence(page);
  fixture.capabilities(true, true);
  await page.goto('/');
  const pane = await openChat(page);
  fixture.start(1);
  await expect(pane.getByText(/引导能力暂未确认/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('steering-capability-error.png') });
  fixture.capabilities(true);
  await pane.getByRole('button', { name: '重新检查引导能力', exact: true }).click();
  await expect(pane.getByText(/引导能力暂未确认/)).toHaveCount(0);
  await pane.getByTitle('展开队列', { exact: true }).click();
  await expect(pane.getByRole('button', { name: '↪ 引导', exact: true })).toBeVisible();
  expect(fixture.state().seqTasks.length).toBe(1);
  expect(fixture.actions).toEqual([]);
});

test('a late capability success cannot overwrite the current turn result', async ({ page }) => {
  const fixture = await mockSequence(page);
  fixture.capabilities(true);
  fixture.holdCapabilities(true);
  await page.goto('/');
  const pane = await openChat(page);
  await pane.getByTitle('展开队列', { exact: true }).click();
  await expect.poll(fixture.capabilityRequests).toBeGreaterThan(0);
  const requests = fixture.capabilityRequests();
  fixture.capabilities(false, true);
  fixture.holdCapabilities(false);
  fixture.start(1);
  await expect.poll(fixture.capabilityRequests).toBeGreaterThan(requests);
  await expect(pane.getByText(/引导能力暂未确认/)).toBeVisible();
  fixture.releaseCapabilities();
  fixture.progress(1, '迟到响应已释放');
  await expect(pane.getByText('迟到响应已释放', { exact: true })).toBeVisible();
  await expect(pane.getByText(/引导能力暂未确认/)).toBeVisible();
  await expect(pane.getByRole('button', { name: '↪ 引导', exact: true })).toHaveCount(0);
  expect(fixture.actions).toEqual([]);
});
