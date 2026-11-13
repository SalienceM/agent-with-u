import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1300, backendType = 'deepseek-harness') {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async (backendType) => {
    const { React, createRoot, ChatInput, api, composerSubmissions, harnessImageScope } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.listSessions = async () => [];
    const root = createRoot(document.getElementById('root')!);
    const f = { session: 'steer-fixture', streaming: true, capable: true, queued: [] as any[], sent: [] as any[], requests: [] as any[], render: () => {}, reply: (_state: string, _index = 0) => {} };
    (composerSubmissions as any).io.write = async (_scope: any, payload: any) => {
      f.requests.push(payload); return { ...payload, revision: 1, state: 'preparing' };
    };
    f.reply = (state, index = 0) => composerSubmissions.observe(harnessImageScope(f.requests[index].sessionId), { ...f.requests[index], state, revision: 2 });
    f.render = () => root.render(React.createElement(ChatInput, { sessionId: f.session, historyKey: f.session,
      isStreaming: f.streaming, canSteer: f.capable, steerAttachments: backendType === 'codex-office',
      activeBackendId: 'backend', backends: [{ id: 'backend', type: backendType }],
      onAbort: () => {}, onSend: (...args: any[]) => { f.sent.push(args); },
      onQueueTask: (...args: any[]) => { f.queued.push(args); } }));
    (window as any).steerFixture = f; f.render();
  }, backendType);
}

for (const backend of ['deepseek-harness', 'codex-office']) for (const width of [1300, 390]) test(`${backend} 共用当前轮引导与排队交互 (${width})`, async ({ page }) => {
  await mount(page, width, backend);
  const input = page.locator('.chat-textarea');
  await input.fill('普通下一轮'); await input.press('Enter');
  expect(await page.evaluate(() => (window as any).steerFixture.queued.length)).toBe(1);
  await input.fill('改查旧金山');
  await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('只看今天') });
  await page.getByRole('button', { name: '引导当前轮', exact: true }).click();
  await expect(input).toHaveValue('改查旧金山');
  const request = await page.evaluate(() => (window as any).steerFixture.requests[0]);
  expect(request.deliveryMode).toBe('steer'); expect(request.queue).toBe(false);
  expect(request.textAttachments[0].content).toBe('只看今天');
  await input.press('Control+Enter');
  expect(await page.evaluate(() => (window as any).steerFixture.requests.length)).toBe(1);
  await page.evaluate(() => (window as any).steerFixture.reply('accepted'));
  await expect(input).toHaveValue('');
  await input.fill('后续补充'); await input.press('Control+Enter');
  expect(await page.evaluate(() => (window as any).steerFixture.requests.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).steerFixture.sent.length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

for (const backend of ['deepseek-harness', 'codex-office']) test(`${backend} 拒绝、未知及迟到回执保留正确草稿，不回退为队列或发送`, async ({ page }) => {
  await mount(page, 1300, backend);
  const input = page.locator('.chat-textarea');
  await input.fill('第一条'); await input.press('Control+Enter');
  await page.evaluate(() => (window as any).steerFixture.reply('rejected'));
  await expect(input).toHaveValue('第一条');
  await input.fill('第二条'); await input.press('Control+Enter');
  await page.evaluate(() => (window as any).steerFixture.reply('unknown', 1));
  await input.press('Enter'); await input.press('Control+Enter');
  expect(await page.evaluate(() => (window as any).steerFixture.queued.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).steerFixture.requests.length)).toBe(2);
  await input.fill('回执期间的新编辑');
  await page.evaluate(() => (window as any).steerFixture.reply('accepted', 1));
  await expect(input).toHaveValue('回执期间的新编辑');
  await page.evaluate(() => { const f = (window as any).steerFixture; f.session = 'other'; f.render(); });
  await expect(input).toHaveValue('');
  await input.fill('其他会话');
  await page.evaluate(() => (window as any).steerFixture.reply('accepted', 0));
  await expect(input).toHaveValue('其他会话');
});

for (const backend of ['deepseek-harness', 'codex-office']) test(`${backend} 图片按能力控制，空闲或不支持时没有引导入口`, async ({ page }) => {
  await mount(page, 1300, backend);
  await page.locator('input[type=file]').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5E4AAAAASUVORK5CYII=', 'base64') });
  const button = page.getByRole('button', { name: '引导当前轮', exact: true });
  if (backend === 'deepseek-harness') await expect(button).toBeDisabled();
  else await expect(button).toBeEnabled();
  await page.locator('.chat-textarea').fill('带图'); await page.locator('.chat-textarea').press('Control+Enter');
  expect(await page.evaluate(() => (window as any).steerFixture.requests.length)).toBe(backend === 'deepseek-harness' ? 0 : 1);
  await page.evaluate(() => { const f = (window as any).steerFixture; f.capable = false; f.render(); });
  await expect(button).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).steerFixture; f.capable = true; f.streaming = false; f.render(); });
  await expect(button).toHaveCount(0);
});
