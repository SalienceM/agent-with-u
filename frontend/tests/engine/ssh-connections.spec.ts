import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
      :root{--theme-text:#e7edf7;--theme-text-muted:#a5b2c7;--theme-bg:#191d28;--theme-border:#394355}body{margin:0;font:14px system-ui;background:#121620;color:#e7edf7}button:disabled{opacity:.5}
      </style></head><body><div id="root"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>` });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => { const path = '/tests/engine/ssh-connections-harness.tsx'; (await import(/* @vite-ignore */ path)).mountSshFixture(); });
}
async function configure(page: Page) {
  await page.getByRole('button', { name: '添加连接' }).click();
  await page.getByLabel('名称', { exact: true }).fill('家里的 Linux');
  await page.getByLabel('主机地址', { exact: true }).fill('linux.example');
  await page.getByLabel('SSH 账户', { exact: true }).fill('deploy');
  await page.getByRole('button', { name: '读取服务器指纹' }).click();
}

for (const width of [1280, 390]) test(`explicit fingerprint confirmation and saved default at ${width}`, async ({ page }, info) => {
  await mount(page, width);
  await expect(page.getByRole('group', { name: '保存连接' })).toHaveCount(0);
  await configure(page);
  await expect(page.getByRole('button', { name: '确认指纹并保存' })).toBeDisabled();
  await page.getByRole('checkbox').check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath(`ssh-config-${width}.png`), fullPage: true });
  await page.getByRole('button', { name: '确认指纹并保存' }).click();
  await expect(page.getByLabel('已保存的 SSH 连接')).toHaveValue('saved-connection');
  await expect(page.getByRole('button', { name: '保存为密钥版' })).toBeDisabled();
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('status')).toContainText('密钥登录成功');
  expect(await page.evaluate(() => (window as any).sshFixture.uses.length)).toBe(0);
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '保存为密钥版' }).click();
  await expect(page.getByText('默认连接 · 下次自动使用')).toBeVisible();
  await expect(page.getByText('当前仍是密码版', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`ssh-saved-${width}.png`), fullPage: true });
  const saved = await page.evaluate(() => (window as any).sshFixture.writes[0]);
  expect(saved.data.confirmed).toBe(true);
  expect(saved.data).not.toHaveProperty('password');
});

test('editing endpoint invalidates confirmation; changed fingerprint fails visibly', async ({ page }) => {
  await mount(page); await configure(page);
  await page.getByRole('checkbox').check();
  await page.getByLabel('主机地址', { exact: true }).fill('another.example');
  await expect(page.getByRole('button', { name: '确认指纹并保存' })).toHaveCount(0);
  await page.getByRole('button', { name: '读取服务器指纹' }).click();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认指纹并保存' }).click();
  await page.evaluate(() => { (window as any).sshFixture.testError = true; });
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('alert')).toContainText('指纹不匹配');
  expect(await page.evaluate(() => (window as any).sshFixture.uses.length)).toBe(0);
});

test('lost save reply does not resubmit automatically; manual retry reuses request ID', async ({ page }) => {
  await mount(page); await configure(page);
  await page.getByRole('checkbox').check();
  await page.evaluate(() => { (window as any).sshFixture.loseReply = true; });
  await page.getByRole('button', { name: '确认指纹并保存' }).click();
  await expect(page.getByRole('alert')).toContainText('保存结果未确认');
  expect(await page.evaluate(() => (window as any).sshFixture.writes.length)).toBe(1);
  await page.evaluate(() => { (window as any).sshFixture.loseReply = false; });
  await page.getByRole('button', { name: '确认指纹并保存' }).click();
  await expect(page.getByLabel('已保存的 SSH 连接')).toHaveValue('saved-connection');
  expect(await page.evaluate(() => { const w = (window as any).sshFixture.writes; return w.length === 2 && w[0].request === w[1].request; })).toBe(true);
});

test('late probe does not populate another Session', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).sshFixture.delayProbe = true; });
  await configure(page);
  await page.evaluate(() => { (window as any).sshFixture.changeSession('different'); });
  await page.evaluate(() => (window as any).sshFixture.finish());
  await expect(page.getByRole('button', { name: '确认指纹并保存' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加连接' })).toBeVisible();
});
