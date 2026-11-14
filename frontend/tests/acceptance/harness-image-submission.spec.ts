import { test, expect, type Page } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6NLsAAAAASUVORK5CYII=', 'base64');
async function setup(page: Page, mode: 'normal' | 'legacy' | 'lost' = 'normal', queued = false) {
  const writes: any[] = [], methods: string[] = [];
  let emit: (index: number, state: string, revision: number) => void = () => { throw new Error('not connected'); };
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    const backends = new Set<unknown>();
    const reply = (id: unknown, result: unknown) => socket.send(JSON.stringify({ id, result: JSON.stringify(result) }));
    const receipt = (p: any, state = 'platform_accepted', revision = 1) => ({ version: 1, requestId: p.requestId,
      sessionId: p.sessionId, state, revision, nativeReceived: ['native_received', 'failed', 'succeeded'].includes(state), reason: '' });
    emit = (index, state, revision) => socket.send(JSON.stringify({ event: 'sessionUpdated', data: JSON.stringify({
      type: 'harness_image_submission', ...receipt(writes[index], state, revision),
    }) }));
    server.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (backends.delete(frame.id)) {
        const rows = JSON.parse(frame.result);
        frame.result = JSON.stringify(rows.map((b: any) => ({ ...b, type: 'deepseek-harness' })));
        socket.send(JSON.stringify(frame));
      } else socket.send(message);
    });
    socket.onMessage(message => {
      const f = JSON.parse(String(message)); methods.push(f.method);
      if (f.method === 'getBackends') { backends.add(f.id); server.send(message); }
      else if (f.method === 'seqtaskGet') reply(f.id, { status: 'ok', seqAuto: false, seqTasks: queued ? [{
        id: 'existing', text: '保持排队', images: [], status: 'pending', createdAt: 1,
      }] : [] });
      else if (f.method === 'harnessImageCapabilities') {
        if (mode === 'legacy') socket.send(JSON.stringify({ id: f.id, error: 'Unknown method' }));
        else reply(f.id, { version: 1, submit: true, queue: true, status: true });
      } else if (['harnessImageSubmit', 'harnessImageQueue'].includes(f.method)) {
        const p = JSON.parse(f.params[1]); writes.push(p);
        if (mode !== 'lost') reply(f.id, receipt(p, f.method === 'harnessImageQueue' ? 'queued' : 'platform_accepted'));
        // lost 模拟提交帧已写出但回执丢失。不得让真实 Backend 接到模型请求。
      } else if (f.method === 'harnessImageStatus') reply(f.id, { version: 1, requestId: f.params[1], sessionId: f.params[0], state: 'unknown' });
      else if (['sendMessage', 'seqtaskAdd', 'steerMessage', 'redirectMessage'].includes(f.method)) {
        throw new Error(`Harness image silently fell back to ${f.method}`);
      } else server.send(message);
    });
  });
  await page.goto('/');
  await openSession(page);
  return { writes, methods, emit: (index: number, state: string, revision: number) => emit(index, state, revision) };
}
async function openSession(page: Page, index = 0) {
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).nth(index).click();
  return page.locator('[data-session-tab-panel]:visible');
}
async function draftImage(page: Page, content = '原图片草稿') {
  const pane = page.locator('[data-session-tab-panel]:visible');
  await pane.locator('input[type="file"]').setInputFiles({ name: 'isolated.png', mimeType: 'image/png', buffer: png });
  const input = pane.locator('.chat-textarea');
  await input.fill(content);
  await expect(pane.locator('img[src^="data:image"]')).toHaveCount(1);
  return { pane, input, preview: pane.locator('img[src^="data:image"]') };
}
test('attachments, acceptance and completion have no extra image guidance or controls', async ({ page }, testInfo) => {
  const f = await setup(page); const { pane, input, preview } = await draftImage(page);
  const expectNoGuidance = async () => {
    await expect(pane.getByTestId('harness-image-status')).toHaveCount(0);
    await expect(pane.getByLabel('图片发送详情')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: /^(刷新状态|恢复此输入|替换并恢复)$/ })).toHaveCount(0);
    await expect(pane.getByText('静态 PNG / JPEG / WebP', { exact: false })).toHaveCount(0);
    await expect(pane.getByText('发送时核对当前端点声明', { exact: false })).toHaveCount(0);
    await expect(pane.getByText(/^(1 张图片待发送|平台已接单，尚无原生接收回执|本轮已完成)$/)).toHaveCount(0);
  };
  await expectNoGuidance();
  expect(f.methods.filter(m => m.startsWith('harnessImage'))).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('image-draft-no-guidance.png'), fullPage: true });
  await input.press('Enter'); await expect.poll(() => f.writes.length).toBe(1);
  await expect(input).toHaveValue('原图片草稿'); await expect(preview).toHaveCount(1);
  await expectNoGuidance();
  f.emit(0, 'succeeded', 3);
  await expect(input).toHaveValue(''); await expect(preview).toHaveCount(0);
  await expectNoGuidance();
  expect(f.methods.filter(m => m === 'harnessImageStatus')).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('image-complete-no-guidance.png'), fullPage: true });
  expect(f.writes).toHaveLength(1);
});

test('slow receipts preserve later edits without restoring or resending; grants stay cleared', async ({ page }) => {
  const f = await setup(page); const { pane, input, preview } = await draftImage(page);
  await pane.getByRole('button', { name: '更多输入工具', exact: true }).click();
  await page.getByRole('dialog', { name: '更多输入工具', exact: true }).locator('summary').filter({ hasText: '确认与提醒' }).click();
  await page.getByRole('switch', { name: '本次允许 Kit 代确认' }).click();
  await page.keyboard.press('Escape');
  expect(f.methods.filter(m => m === 'harnessImageCapabilities')).toHaveLength(0);
  await input.press('Enter'); await expect.poll(() => f.writes.length).toBe(1);
  await expect(input).toHaveValue('原图片草稿'); await expect(preview).toHaveCount(1);
  await input.fill('等待时的新编辑'); await input.press('Enter'); expect(f.writes).toHaveLength(1);
  f.emit(0, 'native_received', 3);
  await expect(input).toHaveValue('等待时的新编辑');
  f.emit(0, 'failed', 4);
  await expect(pane.getByTestId('harness-image-status')).toHaveCount(0);
  await expect(input).toHaveValue('等待时的新编辑');
  await expect(preview).toHaveCount(1);
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true })).not.toBeChecked();
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain(png.toString('base64')); expect(f.writes).toHaveLength(1);
});
test('matching draft clears at native receipt, not platform acceptance, and remains clear after failure', async ({ page }) => {
  const f = await setup(page); const { input, preview, pane } = await draftImage(page);
  await input.press('Enter'); await expect.poll(() => f.writes.length).toBe(1);
  await expect(input).toHaveValue('原图片草稿');
  f.emit(0, 'native_received', 3); await expect(input).toHaveValue(''); await expect(preview).toHaveCount(0);
  f.emit(0, 'failed', 4); await expect(pane.getByTestId('harness-image-status')).toHaveCount(0);
  await expect(input).toHaveValue(''); await expect(preview).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
});
test('legacy protocol keeps text/image and does not fall back; viewing and attaching are passive', async ({ page }) => {
  const f = await setup(page, 'legacy'); const { input, pane, preview } = await draftImage(page);
  expect(f.methods.filter(m => m.startsWith('harnessImage'))).toHaveLength(0);
  await input.press('Enter'); await expect(pane.getByRole('alert')).toContainText('不支持新版图片回执协议');
  await expect(input).toHaveValue('原图片草稿'); await expect(preview).toHaveCount(1); expect(f.writes).toHaveLength(0);
});
test('image limits still report errors through existing feedback without submitting or clearing', async ({ page }) => {
  const f = await setup(page); const { input, pane, preview } = await draftImage(page);
  await pane.locator('input[type="file"]').setInputFiles(Array.from({ length: 4 }, (_, i) => ({
    name: `extra-${i}.png`, mimeType: 'image/png', buffer: png,
  })));
  await expect(preview).toHaveCount(5);
  await input.press('Enter'); await expect(pane.getByRole('alert')).toContainText('请保留 1–4 张图片');
  await expect(input).toHaveValue('原图片草稿'); await expect(preview).toHaveCount(5);
  expect(f.methods.filter(m => m.startsWith('harnessImage'))).toHaveLength(0);
  expect(f.writes).toHaveLength(0);
});

test('queue acknowledgement clears matching draft without an extra status notice', async ({ page }) => {
  const f = await setup(page, 'normal', true); const { input, pane, preview } = await draftImage(page);
  await input.press('Enter'); await expect.poll(() => f.writes.length).toBe(1);
  await expect(input).toHaveValue(''); await expect(preview).toHaveCount(0);
  await expect(pane.getByTestId('harness-image-status')).toHaveCount(0);
  await expect(pane.getByText('已排队，尚未提交给模型', { exact: true })).toHaveCount(0);
  expect(f.methods.filter(m => m === 'harnessImageSubmit')).toHaveLength(0);
  expect(f.writes[0].kitApprovalDelegation).toBeUndefined();
});
test('late receipt belongs to original session and remount does not send again', async ({ page }) => {
  const f = await setup(page); const { input } = await draftImage(page);
  await input.press('Enter'); await expect.poll(() => f.writes.length).toBe(1);
  const other = await openSession(page, 1); const otherInput = other.locator('.chat-textarea');
  await otherInput.fill('另一个 Session 的草稿');
  f.emit(0, 'native_received', 3); await expect(otherInput).toHaveValue('另一个 Session 的草稿');
  const original = await openSession(page); await expect(original.locator('.chat-textarea')).toHaveValue('');
  await expect(original.locator('img[src^="data:image"]')).toHaveCount(0); expect(f.writes).toHaveLength(1);
});
test('lost response reconciles once, keeps input through remount and never retries write', async ({ page }) => {
  const f = await setup(page, 'lost'); const { input, pane } = await draftImage(page);
  await input.press('Enter'); await expect.poll(() => f.writes.length).toBe(1);
  await expect(pane.getByRole('alert')).toContainText('结果未知', { timeout: 16000 });
  await expect.poll(() => f.methods.filter(m => m === 'harnessImageStatus').length).toBe(1);
  await input.press('Enter');
  await openSession(page, 1); const original = await openSession(page);
  await expect(original.locator('.chat-textarea')).toHaveValue('原图片草稿');
  await expect(original.locator('img[src^="data:image"]')).toHaveCount(1);
  await original.locator('.chat-textarea').press('Enter'); expect(f.writes).toHaveLength(1);
  expect(f.methods.filter(m => m === 'harnessImageStatus')).toHaveLength(1);
  await expect(original.getByTestId('harness-image-status')).toHaveCount(0);
  await expect(original.getByRole('button', { name: '刷新状态' })).toHaveCount(0);
});
