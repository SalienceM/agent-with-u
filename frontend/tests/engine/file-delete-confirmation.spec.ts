import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root" style="height:700px"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/tests/engine/react-harness.ts');
    const { api } = await import('/src/api.ts');
    const { FileTreePanel } = await import('/src/components/FileTreePanel.tsx');
    const f: any = { calls: [], nativeConfirms: 0, finish: null, connection: () => {}, render: () => {} };
    (window as any).deletionFixture = f;
    window.confirm = () => { f.nativeConfirms++; return true; };
    api.onSessionConnectionStatus = (_session, callback) => { f.connection = callback; callback(true); return () => {}; };
    api.gitDetect = async () => ({ isRepo: false });
    api.listDirectory = async rel => rel ? [] : [
      { name: 'report.txt', path: 'report.txt', isDir: false, size: 32 },
      { name: '资料目录', path: '资料目录', isDir: true },
    ];
    api.syncDeleteEntry = async (...args) => {
      f.calls.push(args);
      return new Promise(resolve => { f.finish = (failed = false) => resolve(failed
        ? { status: 'error', message: '测试：删除结果未知' } : { status: 'ok' }); });
    };
    const root = createRoot(document.getElementById('root')!);
    f.render = (extra = {}) => root.render(React.createElement(FileTreePanel, {
      sessionId: 'delete-fixture', workingDir: 'C:/测试项目/workspace', execKey: 'fixture-node', execLabel: '远端测试设备', execMode: 'relay', ...extra,
    }));
    f.render();
  });
  await expect(page.locator('.ftp-panel')).toBeVisible();
}

async function askFileDeletion(page: Page) {
  const row = page.locator('.ftp-row').filter({ has: page.getByText('report.txt', { exact: true }) });
  await row.hover();
  await row.getByTitle('删除执行端文件（保留本地副本）', { exact: true }).click();
  return page.getByRole('alertdialog', { name: '确认删除远端文件' });
}

test('row delete only opens app confirmation, cancellation and Enter do not delete', async ({ page }) => {
  await mount(page);
  let dialog = await askFileDeletion(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('report.txt');
  await expect(dialog).toContainText('远端测试设备');
  await expect(dialog).toContainText('C:/测试项目/workspace');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as any).deletionFixture.calls)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  dialog = await askFileDeletion(page);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).deletionFixture.calls)).toEqual([]);
  expect(await page.evaluate(() => (window as any).deletionFixture.nativeConfirms)).toBe(0);
});

test('only the explicit confirmation sends one deletion to the captured node', async ({ page }) => {
  await mount(page);
  const dialog = await askFileDeletion(page);
  await dialog.getByRole('button', { name: '确认删除', exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).deletionFixture.calls)).toEqual([
    ['C:/测试项目/workspace', 'report.txt', false, 'fixture-node'],
  ]);
  await page.evaluate(() => (window as any).deletionFixture.finish());
  await expect(page.locator('.ftp-row').filter({ has: page.getByText('report.txt', { exact: true }) })).toHaveCount(0);
});

for (const width of [1200, 360]) {
  test(`${width}px context-menu directory deletion explains recursive scope and traps focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await mount(page);
    await page.locator('.ftp-row').filter({ has: page.getByText('资料目录', { exact: true }) }).click({ button: 'right' });
    await page.getByRole('button', { name: '🗑 删除执行端目录及全部内容（保留本地副本）', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: '确认删除远端目录' });
    await expect(dialog).toContainText('全部内容（含隐藏文件）');
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: '确认删除', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    if (width === 360) await page.screenshot({ path: '../.qa/file-delete-confirmation.png' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).deletionFixture.calls)).toEqual([]);
  });
}

test('switching workspace or going offline cancels pending confirmation', async ({ page }) => {
  await mount(page);
  await askFileDeletion(page);
  await page.evaluate(() => (window as any).deletionFixture.render({ workingDir: 'C:/another-workspace', execKey: 'another-node' }));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await askFileDeletion(page);
  await page.evaluate(() => (window as any).deletionFixture.connection(false));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).deletionFixture.calls)).toEqual([]);
});

test('failed deletion keeps the entry and does not retry without a fresh confirmation', async ({ page }) => {
  await mount(page);
  const dialog = await askFileDeletion(page);
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.evaluate(() => (window as any).deletionFixture.finish(true));
  await expect(page.locator('.ftp-row').filter({ has: page.getByText('report.txt', { exact: true }) })).toBeVisible();
  await askFileDeletion(page);
  expect(await page.evaluate(() => (window as any).deletionFixture.calls.length)).toBe(1);
  await page.keyboard.press('Escape');
});
