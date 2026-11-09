import { test, expect } from '@playwright/test';

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
