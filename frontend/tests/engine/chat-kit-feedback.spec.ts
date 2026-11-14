import { test, expect, type Page } from '@playwright/test';

async function openToolSection(page: Page, name: string) {
  const menu = page.getByRole('dialog', { name: '更多输入工具', exact: true });
  if (!await menu.isVisible()) await page.getByRole('button', { name: '更多输入工具', exact: true }).click();
  const closed = menu.locator('details:not([open]) > summary').filter({ hasText: name });
  if (await closed.count()) await closed.click();
}

async function mount(page: Page) {
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
  await page.evaluate(async () => {
    const { React, createRoot, ChatInput, api, KitDelegationBadge, KitDelegationStatus, kitDelegations, OPEN_KIT_RECEIPT } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.listSessions = async () => [];
    api.kitDelegationList = async () => [];
    api.onSessionConnectionStatus = (_session, callback) => { callback(true); return () => {}; };
    const root = createRoot(document.getElementById('root')!);
    const fixture = { sent: [] as any[], opened: [] as any[], receipts: kitDelegations, props: { isFocused: true, isStreaming: false, sessionId: 'fixture', activeBackendId: 'api', seqCount: 0 },
      render: () => {}, finish: () => {} };
    fixture.render = () => root.render(React.createElement(React.Fragment, null, React.createElement(ChatInput, { ...fixture.props, onAbort: () => {}, historyKey: 'fixture',
      backends: [{ id: 'api', type: 'openai-compatible' }], onSend: (...args: any[]) => {
        fixture.sent.push(args); fixture.props.isStreaming = true; fixture.render();
        return new Promise<void>(resolve => { fixture.finish = () => { fixture.props.isStreaming = false; fixture.render(); resolve(); }; });
      } }), React.createElement(KitDelegationBadge, { sessionId: 'fixture', messageId: 'message' }),
      React.createElement(KitDelegationStatus, { sessionId: 'fixture', executor: 'local' })));
    window.addEventListener(OPEN_KIT_RECEIPT, (e: any) => fixture.opened.push(e.detail));
    (window as any).kitFixture = fixture;
    fixture.render();
  });
}

test('explicit toggle survives direct send and asynchronous completion; prose does not authorize', async ({ page }) => {
  await mount(page);
  const opt = page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true });
  const input = page.locator('.chat-textarea');
  await openToolSection(page, '确认与提醒');
  await opt.click();
  await page.keyboard.press('Escape');
  await input.fill('执行发布 Kit');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).kitFixture.sent.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).kitFixture.sent[0][3])).toBe(true);
  await expect(opt).not.toBeChecked();
  await expect(opt).toBeDisabled();
  await page.evaluate(() => (window as any).kitFixture.finish());
  await input.fill('我同意代确认');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as any).kitFixture.sent[1][3])).toBe(false);
});

test('ordinary pane focus changes preserve opt-in; actual Session and busy changes clear it', async ({ page }) => {
  await mount(page);
  const opt = page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true });
  await openToolSection(page, '确认与提醒');
  await opt.click();
  await page.keyboard.press('Escape');
  await expect(opt).toBeChecked();
  await page.evaluate(() => { const f = (window as any).kitFixture; f.props.isFocused = false; f.render(); });
  await expect(opt).toBeChecked();
  await page.evaluate(() => { const f = (window as any).kitFixture; f.props.sessionId = 'another'; f.render(); });
  await expect(opt).not.toBeChecked();
  await openToolSection(page, '确认与提醒');
  await opt.click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const f = (window as any).kitFixture; f.props.seqCount = 1; f.render(); });
  await expect(opt).not.toBeChecked();
});

test('image reading and async completion retain frozen opt-in, receipt survives switch reset', async ({ page }) => {
  await mount(page);
  const opt = page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true });
  await openToolSection(page, '确认与提醒');
  await opt.click();
  await page.keyboard.press('Escape');
  await page.locator('input[type=file]').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX6kAAAAASUVORK5CYII=', 'base64') });
  await expect(page.locator('img').first()).toBeVisible();
  await page.locator('.chat-textarea').fill('执行发布');
  await page.locator('.chat-textarea').press('Enter');
  const call = await page.evaluate(() => (window as any).kitFixture.sent[0]);
  expect(call[1]).toHaveLength(1); expect(call[3]).toBe(true);
  await page.evaluate(() => (window as any).kitFixture.receipts.accept('local', { id: 'receipt', sessionId: 'fixture', messageId: 'message', revision: 1, status: 'accepted' }));
  await expect(page.locator('summary').filter({ hasText: /^Kit 代确认/ })).toContainText('已接收');
  await expect(opt).not.toBeChecked();
  await page.evaluate(() => (window as any).kitFixture.receipts.accept('local', { id: 'receipt', sessionId: 'fixture', messageId: 'message', revision: 2, status: 'bound', runId: 'real-run', stepId: 'publish', runStatus: 'waiting_approval' }));
  await page.getByRole('button', { name: 'Kit 等待确认 · 查看步骤' }).click();
  expect(await page.evaluate(() => (window as any).kitFixture.opened[0])).toMatchObject({ runId: 'real-run', stepId: 'publish' });
  await page.evaluate(() => (window as any).kitFixture.receipts.accept('local', { id: 'receipt', sessionId: 'fixture', messageId: 'message', revision: 3, status: 'used', runId: 'real-run', runStatus: 'succeeded' }));
  await expect(page.locator('summary').filter({ hasText: /^Kit 代确认/ })).toContainText('已用于本运行');
  await expect(page.getByRole('button', { name: 'Kit 等待确认 · 查看步骤' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).kitFixture.sent.length)).toBe(1);
});

test('reminder preference never selects opt-in; unknown is checked read-only', async ({ page }) => {
  await mount(page);
  await page.getByLabel('提醒 Kit 待确认').uncheck();
  await page.evaluate(() => { const f = (window as any).kitFixture;
    f.receipts.accept('local', { id: 'receipt', sessionId: 'fixture', messageId: 'message', revision: 1, status: 'unknown' });
    f.receipts.updateRuns('local', 'fixture', [{ id: 'ungranted-run', status: 'waiting_approval', stepId: 'install' }]);
  });
  await expect(page.getByRole('button', { name: 'Kit 等待确认 · 查看步骤' })).toHaveCount(0);
  await page.getByLabel('提醒 Kit 待确认').check();
  await expect(page.getByRole('button', { name: 'Kit 等待确认 · 查看步骤' })).toBeVisible();
  await page.locator('summary').filter({ hasText: /^Kit 代确认/ }).click();
  await page.getByRole('button', { name: '核对回执', exact: true }).click();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true })).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).kitFixture.sent)).toEqual([]);
  await mount(page);
  await expect(page.getByLabel('提醒 Kit 待确认')).toBeChecked();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true })).not.toBeChecked();
});

test('receipt opens the exact historic run and panel approval advances without chat', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { React, createRoot, WorkspaceKitsPanel, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const step = { id: 'publish', title: '冻结发布', type: 'awu_capability', target: 'executor', status: 'waiting_approval',
      config: { capability: 'release.publish_latest', capabilityRuntime: { planId: 'plan', planFingerprint: 'fingerprint',
        plan: { id: 'plan', status: 'ready', channel: 'stable', candidate: { version: '1.2.3' }, artifacts: [{ id: 'windows', fileName: 'original.msi', platform: 'windows' }], warnings: [], blockers: [] } } } };
    const kit = { id: 'kit', title: '发布 Kit', description: '', enabled: true, steps: [step], inputs: [], outputs: [], assertions: [],
      lastRunId: 'newer-run', versions: [], dependencies: [], currentVersion: '1', controlMode: 'shared', schedule: { enabled: false }, executionTarget: 'executor' };
    const run = { id: 'original-run', kitId: 'kit', status: 'waiting_approval', currentStep: 0, steps: [step], assertions: [], artifacts: [], startedAt: 1 };
    const state = { status: 'ok', sessionId: 'fixture', kits: [kit], runs: [run, { ...run, id: 'newer-run', status: 'succeeded', steps: [] }], dataMarket: [], events: [], terminalConnectedKitIds: [] };
    let update = (_state: any) => {};
    api.kitGetState = async () => state as any;
    api.kitGenerationGet = async () => ({ status: 'ok', job: null });
    api.onKitUpdated = callback => { update = callback; return () => {}; };
    api.kitCapabilityRespond = async (...args: any[]) => {
      (window as any).kitFixture.panelApproval = args;
      state.runs[0] = { ...run, status: 'succeeded', steps: [{ ...step, status: 'succeeded' }] };
      update({ ...state }); return { status: 'ok', run: state.runs[0] } as any;
    };
    const host = document.body.appendChild(document.createElement('div'));
    createRoot(host).render(React.createElement(WorkspaceKitsPanel, { sessionId: 'fixture', open: true, onClose: () => {}, targetRunId: 'original-run', targetStepId: 'publish' }));
  });
  await expect(page.getByText('original.msi', { exact: true })).toBeVisible();
  const approve = page.getByRole('button', { name: /确认.*发布/ });
  page.once('dialog', dialog => dialog.accept());
  await approve.click();
  await expect.poll(() => page.evaluate(() => !!(window as any).kitFixture.panelApproval)).toBeTruthy();
  expect(await page.evaluate(() => (window as any).kitFixture.panelApproval.slice(0, 4))).toEqual(['fixture', 'original-run', 'publish', true]);
  await expect(approve).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).kitFixture.sent)).toEqual([]);
});
