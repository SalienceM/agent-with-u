import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, options: { ordinary?: boolean; inputs?: boolean; failed?: boolean } = {}) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async options => {
    const { React, createRoot, WorkspaceKitsPanel, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const kit: any = { id: 'kit', title: '打包发布并更新', enabled: true, steps: [],
      inputs: options.inputs ? [{ key: 'tag', label: '版本标记', type: 'string', required: true }] : [],
      outputs: [], assertions: [], description: '', objective: '', successCriteria: '', safetyConstraints: '', references: [],
      command: 'echo fixture', shell: 'powershell', cwd: '.', timeoutSeconds: 300, generationWarnings: [],
      view: { default: 'summary', showLogs: true }, lastRunId: '', versions: [], dependencies: [], currentVersion: '1',
      controlMode: 'shared', schedule: { mode: 'manual' }, executionTarget: 'executor' };
    const calls: any[] = [];
    (window as any).buttonFixture = { calls };
    api.kitGetState = async () => ({ status: 'ok', sessionId: 'fixture', kits: [kit], runs: [], artifacts: [], dataMarket: [], terminalConnectedKitIds: [] });
    api.kitGenerationGet = async () => ({ status: 'ok', job: null });
    api.onKitUpdated = () => () => {};
    api.kitRunPreview = async (...args: any[]) => {
      calls.push(['preview', ...args]);
      if (options.failed) return { status: 'error', message: '执行设备离线' };
      return { status: 'ok', previewId: options.ordinary ? '' : 'frozen-preview',
        actions: options.ordinary ? [] : ['发布本次构建 → release-bucket / stable', '安装并重启执行设备 fixture-executor\n优先复用匹配的本机安装包'] };
    };
    api.kitRun = async (...args: any[]) => { calls.push(['run', ...args]); return { status: 'ok' }; };
    createRoot(document.getElementById('root')!).render(React.createElement(WorkspaceKitsPanel, {
      sessionId: 'fixture', open: true, onClose: () => {} }));
  }, options);
}

test('run button confirms publication and restart before starting', async ({ page }) => {
  await mount(page);
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.getByRole('button', { name: '▶ 运行', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).buttonFixture.calls.length)).toBe(2);
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain('release-bucket / stable');
  expect(dialogs[0]).toContain('安装并重启执行设备 fixture-executor');
  expect(dialogs[0]).toContain('仅本次流程');
  expect(await page.evaluate(() => (window as any).buttonFixture.calls[1])).toEqual(['run', 'fixture', 'kit', {}, 'frozen-preview']);
});

test('cancelling run confirmation starts nothing', async ({ page }) => {
  await mount(page);
  page.on('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '▶ 运行', exact: true }).click();
  await expect(page.getByRole('button', { name: '▶ 运行', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).buttonFixture.calls.map((c: any[]) => c[0]))).toEqual(['preview']);
});

test('ordinary command runs without an extra confirmation', async ({ page }) => {
  await mount(page, { ordinary: true });
  let dialogs = 0;
  page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  await page.getByRole('button', { name: '▶ 运行', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).buttonFixture.calls.length)).toBe(2);
  expect(dialogs).toBe(0);
});

test('failed preview cannot start a run', async ({ page }) => {
  await mount(page, { failed: true });
  await page.getByRole('button', { name: '▶ 运行', exact: true }).click();
  await expect(page.getByText('启动失败：执行设备离线', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).buttonFixture.calls.map((c: any[]) => c[0]))).toEqual(['preview']);
});

test('details run includes entered inputs in the same confirmation', async ({ page }) => {
  await mount(page, { inputs: true });
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '▶ 运行', exact: true }).click();
  const panel = page.getByRole('button', { name: '▶ 执行并验收', exact: true });
  await expect(panel).toBeVisible();
  await page.getByLabel('版本标记', { exact: false }).fill('fixture-tag');
  await panel.click();
  await expect.poll(() => page.evaluate(() => (window as any).buttonFixture.calls.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).buttonFixture.calls[1])).toEqual(['run', 'fixture', 'kit', { tag: 'fixture-tag' }, 'frozen-preview']);
});
