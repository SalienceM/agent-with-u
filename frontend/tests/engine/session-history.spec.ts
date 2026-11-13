import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
      :root{--theme-text:#273244;--theme-text-muted:#687487;--theme-bg:#fff;--theme-bg-secondary:#f6f8fa;--theme-border:#dce1e8;--theme-accent:#4b82f0;--theme-accent-bg:#4b82f014}body{margin:0;font:14px system-ui}
      </style></head><body><div id="root"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => { const path = '/tests/engine/session-history-harness.tsx'; (await import(/* @vite-ignore */ path)).mountHistoryFixture(); });
}
async function renew(page: Page, name = '新会话 · 同目录') {
  await page.getByRole('button', { name: '更多输入工具', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}

for (const width of [1280, 390]) test(`renewal preserves drafts and history; bounded timeline and DSH log paths ${width}`, async ({ page }, info) => {
  await mount(page, width);
  await page.locator('.chat-textarea').fill('旧会话中尚未发送的重要草稿');
  await renew(page);
  await expect(page.getByTestId('selected')).toHaveText('new');
  await expect(page.locator('.chat-textarea')).toHaveValue('');
  await expect(page.getByRole('dialog', { name: '开启新会话' })).toHaveCount(0);
  await page.getByRole('button', { name: '会话历史', exact: true }).click();
  await expect(page.getByRole('list', { name: '会话时间轴' })).toContainText('原会话：需要保留的线索');
  await expect(page.getByText('私密旧会话', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'DSH 原始日志位置' }).click();
  await expect(page.getByLabel('会话日志目录')).toHaveValue(/home\\sessions$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath(`history-${width}.png`), fullPage: true });
  await page.getByRole('button').filter({ hasText: '原会话：需要保留的线索' }).click();
  await expect(page.getByTestId('selected')).toHaveText('old');
  await expect(page.locator('.chat-textarea')).toHaveValue('旧会话中尚未发送的重要草稿');
  expect(await page.evaluate(() => (window as any).historyFixture.writes.length)).toBe(1);
});

test('lost reply checks once, never rewrites and preserves the receipt through an offline status read', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.mode = 'unknown'; f.status = 'offline'; });
  await renew(page);
  await expect(page.getByText('连接中断，创建结果尚未确认。请核对结果，旧记录仍保留。')).toBeVisible();
  await page.getByRole('button', { name: '核对结果', exact: true }).click();
  expect(await page.evaluate(() => (window as any).historyFixture.writes.length)).toBe(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('awu:session-renew:')))).toBe(true);
  await page.evaluate(() => { (window as any).historyFixture.status = 'succeeded'; });
  await page.getByRole('button', { name: '核对结果', exact: true }).click();
  await expect(page.getByTestId('selected')).toHaveText('new');
  expect(await page.evaluate(() => (window as any).historyFixture.writes.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).historyFixture.reads.every((r: any) => r.request === (window as any).historyFixture.writes[0].request))).toBe(true);
});

test('unsubmitted offline operation retains the draft and can be attempted later', async ({ page }) => {
  await mount(page);
  await page.locator('.chat-textarea').fill('do not lose');
  await page.evaluate(() => { (window as any).historyFixture.mode = 'offline'; });
  await renew(page);
  await expect(page.getByText('节点离线，未提交')).toBeVisible();
  await expect(page.locator('.chat-textarea')).toHaveValue('do not lose');
  expect(await page.evaluate(() => (window as any).historyFixture.reads.length)).toBe(0);
});

test('late result does not steal focus; explicit retry uses the original request ID', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).historyFixture.mode = 'delay'; });
  await renew(page);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.focus(false); });
  await expect(page.getByTestId('selected')).toHaveAttribute('data-active', 'false');
  await page.evaluate(() => (window as any).historyFixture.finish());
  await expect(page.getByTestId('selected')).toHaveText('old');
  expect(await page.evaluate(() => (window as any).historyFixture.opens)).toEqual([]);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.focus(true); f.mode = 'unknown'; f.status = 'not_found'; });
  await renew(page);
  await expect(page.getByRole('button', { name: '继续开启同一新会话' })).toBeVisible();
  await page.evaluate(() => { (window as any).historyFixture.mode = 'success'; });
  await page.getByRole('button', { name: '继续开启同一新会话' }).click();
  await expect(page.getByTestId('selected')).toHaveText('new');
  expect(await page.evaluate(() => { const w = (window as any).historyFixture.writes; return w[1].request === w[2].request; })).toBe(true);
});

test('history privacy gate reacts live and Escape returns focus', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '会话历史', exact: true }).click();
  await expect(page.getByText('私密旧会话', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).historyFixture.show(true));
  await expect(page.getByText('私密旧会话', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).historyFixture.show(false));
  await expect(page.getByText('私密旧会话', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'DSH 原始日志位置' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '会话历史', exact: true })).toBeFocused();
});

test('/new uses the latest renewal callback after focus changes', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).historyFixture.focus(false));
  await expect(page.getByTestId('selected')).toHaveAttribute('data-active', 'false');
  await page.evaluate(() => (window as any).historyFixture.command('/new'));
  expect(await page.evaluate(() => (window as any).historyFixture.writes.length)).toBe(0);
  await page.evaluate(() => (window as any).historyFixture.focus(true));
  await expect(page.getByTestId('selected')).toHaveAttribute('data-active', 'true');
  await page.evaluate(() => (window as any).historyFixture.command('/new'));
  await expect(page.getByTestId('selected')).toHaveText('new');
  expect(await page.evaluate(() => (window as any).historyFixture.writes.length)).toBe(1);
});
