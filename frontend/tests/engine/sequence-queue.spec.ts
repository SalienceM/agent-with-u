import { test, expect, type Page } from '@playwright/test';

async function mountLongQueue(page: Page) {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <style>body{margin:0;font-family:Arial,sans-serif;--theme-bg:#161820;--theme-bg-secondary:#20232d;
      --theme-bg-tertiary:#292d38;--theme-text:#e6e7eb;--theme-text-muted:#a4aabb;
      --theme-border:#424754;--theme-accent:#9fbcff;--theme-accent-bg:#283b64;background:var(--theme-bg);color:var(--theme-text)}</style>
      <div id="root"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const { React, createRoot, SeqTaskPanel, ChatInput, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.listSessions = async () => [];
    const original = 'java.lang.IllegalStateException: queue regression fixture\n' +
      '    at example.service.Task.execute(Task.java:123)\n'.repeat(5000) + 'FINAL_LOG_MARKER';
    const f = {
      original, error: '', saved: [] as string[], steered: [] as string[], render: () => {},
      tasks: [{ id: 'large', text: original, status: 'pending' }] as any[],
    };
    api.seqtaskEdit = async (_session: string, _id: string, text: string) => {
      f.saved.push(text); return { status: 'ok' } as any;
    };
    const root = createRoot(document.getElementById('root')!);
    f.render = () => root.render(React.createElement('main', {
      style: { height: '100vh', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' },
    }, React.createElement('div', { 'data-testid': 'messages', style: { flex: 1, minHeight: 0, overflow: 'auto' } }, '聊天内容'),
    React.createElement(SeqTaskPanel, {
      sessionId: 'queue-layout-fixture', tasks: f.tasks, chainActive: true, queueError: f.error,
      isStreaming: true, canSteer: true, onSendNext: () => {}, onPause: () => {},
      onSteerTask: async (id: string) => { f.steered.push(id); return { status: 'ok' }; },
    }), React.createElement(ChatInput, {
      sessionId: 'queue-layout-fixture', historyKey: 'queue-layout-fixture', isStreaming: true,
      activeBackendId: 'backend', backends: [{ id: 'backend', type: 'deepseek-harness' }],
      canSteer: true, onAbort: () => {}, onSend: () => {}, onQueueTask: () => {},
    })));
    (window as any).longQueueFixture = f; f.render();
  });
  await page.getByTitle('展开队列', { exact: true }).click();
}

async function expectBoundedQueue(page: Page) {
  const size = page.viewportSize()!;
  const queue = await page.getByRole('region', { name: '序列队列', exact: true }).boundingBox();
  expect(queue!.height).toBeLessThanOrEqual(Math.min(320, size.height * 0.35) + 1);
  const input = page.locator('.chat-textarea');
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '引导当前轮', exact: true })).toBeInViewport({ ratio: 1 });
  expect((await page.getByTestId('messages').boundingBox())!.height).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
}

for (const viewport of [{ width: 1233, height: 590 }, { width: 390, height: 700 }]) {
  test(`large queue preserves full text and composer space (${viewport.width})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountLongQueue(page);
    const card = page.locator('[data-seq-task-id="large"]');
    const preview = card.locator('[aria-label="任务内容预览"]');
    expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(57);
    expect((await preview.textContent())!.length).toBeLessThanOrEqual(1001);
    await expectBoundedQueue(page);
    await card.getByRole('button', { name: '查看全文', exact: true }).click();
    const full = card.getByRole('region', { name: '任务完整内容' });
    expect(await full.textContent()).toBe(await page.evaluate(() => (window as any).longQueueFixture.original));
    expect((await full.boundingBox())!.height).toBeLessThanOrEqual(Math.min(180, viewport.height * 0.2) + 1);
    expect(await full.evaluate(el => el.scrollHeight > el.clientHeight)).toBeTruthy();
    await full.click();
    await expect(card.locator('textarea')).toHaveCount(0);
    await full.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expectBoundedQueue(page);
    await page.screenshot({ path: testInfo.outputPath('long-queue-expanded.png') });
    await card.getByRole('button', { name: '收起全文', exact: true }).click();
    await preview.click();
    const editor = card.locator('textarea');
    expect(await editor.inputValue()).toBe(await page.evaluate(() => (window as any).longQueueFixture.original));
    await editor.evaluate(el => { el.style.height = '1000px'; });
    expect((await editor.boundingBox())!.height).toBeLessThanOrEqual(Math.min(180, viewport.height * 0.2) + 1);
    await expectBoundedQueue(page);
    await card.getByRole('button', { name: '保存', exact: true }).click();
    expect(await page.evaluate(() => {
      const f = (window as any).longQueueFixture; return f.saved.length === 1 && f.saved[0] === f.original;
    })).toBeTruthy();
    await card.getByRole('button', { name: '↪ 引导', exact: true }).click();
    expect(await page.evaluate(() => (window as any).longQueueFixture.steered)).toEqual(['large']);

    await page.evaluate(() => {
      const f = (window as any).longQueueFixture;
      f.error = '连接异常 '.repeat(2000);
      f.tasks.push(...Array.from({ length: 12 }, (_, i) => ({ id: `task-${i}`, text: 'X'.repeat(20000), status: 'pending' })),
        { id: 'history', text: f.original, status: 'done', error: '历史错误 '.repeat(2000) });
      f.render();
    });
    await expect(page.locator('[data-seq-task-id]')).toHaveCount(13);
    await expectBoundedQueue(page);
    const body = page.getByRole('region', { name: '序列队列内容', exact: true });
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBeTruthy();
    await page.getByRole('button', { name: /执行历史/ }).click();
    const history = page.locator('[data-seq-task-id="history"]');
    await history.getByRole('button', { name: '查看全文', exact: true }).click();
    expect(await history.getByRole('region', { name: '任务完整内容' }).textContent()).toBe(await page.evaluate(() => (window as any).longQueueFixture.original));
    await expect(history.getByRole('button', { name: '保存图片' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '⏸ 暂停', exact: true })).toBeInViewport({ ratio: 1 });
    await expectBoundedQueue(page);
  });
}

test('wrapped short text exposes full view after narrowing the pane', async ({ page }) => {
  await page.setViewportSize({ width: 1233, height: 700 });
  await mountLongQueue(page);
  await page.evaluate(() => {
    const f = (window as any).longQueueFixture;
    f.tasks = [{ id: 'wrapped', text: '这段内容会在窄窗口内换行。'.repeat(18), status: 'pending' }]; f.render();
  });
  const card = page.locator('[data-seq-task-id="wrapped"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '查看全文' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 700 });
  await card.getByRole('button', { name: '查看全文' }).click();
  await expect(card.getByRole('region', { name: '任务完整内容' })).toHaveText('这段内容会在窄窗口内换行。'.repeat(18));
  await expectBoundedQueue(page);
});

test('empty paused queue stays hidden; pending, running and failed tasks keep their controls', async ({ page }) => {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { React, createRoot, SeqTaskPanel } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const root = createRoot(document.getElementById('root')!);
    const f = { tasks: [] as any[], active: false, error: '', actions: [] as string[], render: () => {} };
    f.render = () => root.render(React.createElement(SeqTaskPanel, {
      sessionId: 'queue-fixture', tasks: f.tasks, chainActive: f.active, queueError: f.error, isStreaming: false,
      onSendNext: () => { f.actions.push('resume'); f.active = true; f.render(); },
      onPause: () => { f.actions.push('pause'); f.active = false; f.render(); },
    }));
    (window as any).queueFixture = f; f.render();
  });
  await expect(page.getByText('序列队列', { exact: false })).toHaveCount(0);
  await page.evaluate(() => {
    const f = (window as any).queueFixture;
    f.tasks = [{ id: 'pending', text: '保留这个任务', status: 'pending' }]; f.render();
  });
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
  await expect(page.getByText(/重新打开控制端/)).toHaveCount(0);
  await page.getByRole('button', { name: '▶ 继续', exact: true }).click();
  await expect(page.getByText('等待执行', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '⏸ 暂停', exact: true }).click();
  await page.evaluate(() => {
    const f = (window as any).queueFixture;
    f.tasks[0].status = 'running'; f.render();
  });
  await expect(page.getByText('执行中 · 后续已暂停', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).queueFixture;
    f.tasks[0].status = 'error'; f.tasks[0].error = '任务失败'; f.render();
  });
  await expect(page.getByRole('button', { name: '↻ 重试并继续', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).queueFixture;
    f.tasks[0].status = 'done'; f.render();
  });
  await expect(page.getByText('序列队列', { exact: false })).toHaveCount(0);
  await page.evaluate(() => {
    const f = (window as any).queueFixture;
    f.error = '队列状态无法读取'; f.render();
  });
  await expect(page.getByText('⚠ 队列状态无法读取', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).queueFixture.actions)).toEqual(['resume', 'pause']);
});
