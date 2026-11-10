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
    const f: any = { calls: [], nativeConfirms: 0, reads: [], previews: [], automatic: false, fail: '', finish: null, connection: () => {}, render: () => {} };
    (window as any).deletionFixture = f;
    window.confirm = () => { f.nativeConfirms++; return true; };
    api.onSessionConnectionStatus = (_session, callback) => { f.connection = callback; callback(true); return () => {}; };
    api.gitDetect = async () => ({ isRepo: false });
    api.listDirectory = async rel => { f.reads.push(rel); return rel === '资料目录' ? [
      { name: 'child.txt', path: '资料目录/child.txt', isDir: false, size: 10 },
    ] : rel ? [] : [
      { name: 'report.txt', path: 'report.txt', isDir: false, size: 32 },
      { name: 'second.txt', path: 'second.txt', isDir: false, size: 32 },
      { name: 'third.txt', path: 'third.txt', isDir: false, size: 32 },
      { name: '.git', path: '.git', isDir: true },
      { name: '资料目录', path: '资料目录', isDir: true },
    ]; };
    api.syncReadFile = async (...args) => { f.previews.push(args); throw new Error('Selection must not open files'); };
    api.searchFiles = async () => ({ status: 'ok', results: [{ name: 'second.txt', path: 'second.txt', size: 32 }], matched: 1, truncated: false });
    api.syncDeleteEntry = async (...args) => {
      f.calls.push(args);
      if (f.automatic) return args[1] === f.fail ? { status: 'error', message: '测试：删除结果未知' } : { status: 'ok' };
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

test('batch selection sends nothing until one confirmation, deduplicates descendants and consumes double-click once', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '多选文件', exact: true }).click();
  await page.getByRole('button', { name: '展开 资料目录', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 资料目录/child.txt', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 资料目录', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 report.txt', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: '选择 .git', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).deletionFixture.calls)).toEqual([]);
  await page.getByRole('button', { name: '删除选中项', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '确认批量删除 2 项' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('全部内容（含隐藏文件）');
  await expect(dialog).not.toContainText('child.txt');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).deletionFixture.calls)).toEqual([]);
  await page.getByRole('button', { name: '删除选中项', exact: true }).click();
  await page.evaluate(() => { (window as any).deletionFixture.automatic = true; });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: '文件批量操作' })).toContainText('已选 0 项');
  expect(await page.evaluate(() => (window as any).deletionFixture.calls.map((args: any[]) => args[1]))).toEqual(['资料目录', 'report.txt']);
  expect(await page.evaluate(() => (window as any).deletionFixture.nativeConfirms)).toBe(0);
});

test('partial failure keeps failed and unattempted entries selected without automatic retry', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '多选文件', exact: true }).click();
  for (const path of ['report.txt', 'second.txt', 'third.txt']) await page.getByRole('checkbox', { name: `选择 ${path}`, exact: true }).check();
  await page.evaluate(() => { const f = (window as any).deletionFixture; f.automatic = true; f.fail = 'second.txt'; });
  await page.getByRole('button', { name: '删除选中项', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('.ftp-panel')).toContainText('已删除 1/3 项；未执行 1 项');
  await expect(page.getByRole('checkbox', { name: '选择 report.txt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '选择 second.txt', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '选择 third.txt', exact: true })).toBeChecked();
  expect(await page.evaluate(() => (window as any).deletionFixture.calls.map((args: any[]) => args[1]))).toEqual(['report.txt', 'second.txt']);
  await page.getByRole('button', { name: '删除选中项', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '确认批量删除 2 项' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).deletionFixture.calls.length)).toBe(2);
  await page.keyboard.press('Escape');
});

for (const width of [1200, 360]) {
  test(`${width}px marquee and Shift selection never preview or delete; select-all excludes Git metadata`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await mount(page);
    await page.getByRole('button', { name: '多选文件', exact: true }).click();
    const first = page.locator('[data-file-select="report.txt"]'), last = page.locator('[data-file-select="second.txt"]');
    const start = (await first.boundingBox())!, end = (await last.boundingBox())!;
    await page.mouse.move(start.x + 90, start.y + 4);
    await page.mouse.down();
    await page.mouse.move(end.x + 170, end.y + end.height - 4, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole('checkbox', { name: '选择 report.txt', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '选择 second.txt', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '选择 third.txt', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: '清空', exact: true }).click();
    await first.click();
    await page.locator('[data-file-select="third.txt"]').click({ modifiers: ['Shift'] });
    await expect(page.getByRole('toolbar', { name: '文件批量操作' })).toContainText('已选 3 项');
    await page.getByRole('button', { name: '全选已显示', exact: true }).click();
    await expect(page.getByRole('toolbar', { name: '文件批量操作' })).toContainText('已选 4 项');
    await expect(page.getByRole('checkbox', { name: '选择 .git', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: '删除选中项', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: '确认批量删除 4 项' })).toBeVisible();
    expect(await page.locator('.ftp-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (width === 360) await page.screenshot({ path: '../.qa/file-batch-delete.png' });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => ({ calls: (window as any).deletionFixture.calls, previews: (window as any).deletionFixture.previews }))).toEqual({ calls: [], previews: [] });
    expect(await page.evaluate(() => (window as any).deletionFixture.reads)).toEqual(['']);
  });
}

test('disconnect during batch prevents sending the next deletion', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '多选文件', exact: true }).click();
  for (const path of ['report.txt', 'second.txt']) await page.getByRole('checkbox', { name: `选择 ${path}`, exact: true }).check();
  await page.getByRole('button', { name: '删除选中项', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await page.evaluate(() => (window as any).deletionFixture.connection(false));
  await expect(page.getByRole('checkbox', { name: '选择 second.txt', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).deletionFixture.finish());
  await expect(page.locator('.ftp-panel')).toContainText('已停止后续删除');
  expect(await page.evaluate(() => (window as any).deletionFixture.calls.length)).toBe(1);
});

test('workspace switch during batch never sends the next deletion or carries selection to the new node', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '多选文件', exact: true }).click();
  await page.getByRole('button', { name: '全选已显示', exact: true }).click();
  await page.getByRole('button', { name: '删除选中项', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await page.evaluate(() => (window as any).deletionFixture.render({ workingDir: 'C:/another-workspace', execKey: 'another-node' }));
  await expect(page.getByRole('button', { name: '多选文件', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).deletionFixture.finish());
  await expect.poll(() => page.evaluate(async () => {
    const { fileTransfers } = await import('/src/utils/fileTransfers.ts');
    return fileTransfers.getSnapshot()[0]?.status;
  })).toBe('error');
  expect(await page.evaluate(() => (window as any).deletionFixture.calls.length)).toBe(1);
  await expect(page.getByRole('toolbar', { name: '文件批量操作' })).toHaveCount(0);
});

test('changing search clears old selection and batches only the chosen results', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '多选文件', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 report.txt', exact: true }).check();
  await page.locator('.ftp-search input').fill('second');
  await expect(page.getByRole('toolbar', { name: '文件批量操作' })).toContainText('已选 0 项');
  await expect(page.getByRole('checkbox', { name: '选择 second.txt', exact: true })).toBeVisible();
  await page.locator('.ftp-search input').press('Enter');
  await expect(page.getByRole('checkbox', { name: '选择 second.txt', exact: true })).toBeChecked();
  await page.evaluate(() => { (window as any).deletionFixture.automatic = true; });
  await page.getByRole('button', { name: '删除选中项', exact: true }).click();
  await page.getByRole('alertdialog', { name: '确认批量删除 1 项' }).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择 second.txt', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).deletionFixture.calls.map((args: any[]) => args[1]))).toEqual(['second.txt']);
  expect(await page.evaluate(() => (window as any).deletionFixture.previews)).toEqual([]);
});
