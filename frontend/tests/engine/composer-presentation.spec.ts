import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width: number, dark: boolean) {
  await page.setViewportSize({ width, height: 800 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div class="app-root" id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async ({ dark, width }) => {
    const { React, createRoot, ChatInput, UserInteractionsPanel, KitDelegationStatus, RoleReviewPanel, ProjectTasksPanel, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    document.body.style.cssText = 'margin:0;font:14px "Segoe UI","Microsoft Yahei",sans-serif';
    const root = document.getElementById('root')!;
    root.style.cssText = `height:100vh;display:flex;flex-direction:column;justify-content:flex-end;color:${dark ? '#dbe2ed' : '#273244'};background:${dark ? 'linear-gradient(145deg,#33433c,#1a2630 60%,#19212c)' : 'linear-gradient(145deg,#e7ede4,#e7edf3 60%,#f4f6fa)'};
      --theme-bg:${dark ? '#10171f' : '#ffffff'};--theme-bg-secondary:${dark ? '#18212b' : '#f7f9fc'};--theme-bg-tertiary:${dark ? '#232f3e' : '#ecf0f6'};--theme-input-bg:${dark ? '#151e29' : '#f9fafc'};--theme-border:${dark ? '#2a3645' : '#dce3ed'};--theme-text:${dark ? '#dbe2ed' : '#273244'};--theme-text-muted:${dark ? '#98a7bc' : '#63738a'};--theme-accent:${dark ? '#76a4ff' : '#3975db'};--theme-accent-bg:${dark ? '#76a4ff18' : '#3975db12'};`;
    const f = { pushed: (_value: any) => {}, sent: [] as any[] };
    (window as any).presentation = f;
    api.onSessionConnectionStatus = (_session, callback) => { callback(true); return () => {}; };
    api.userInteractionList = async () => ({ items: [], capability: { questions: true, permissionNotice: '已设置跳过执行确认。必要问题仍需回答。' } } as any);
    api.onUserInteraction = callback => { f.pushed = row => callback(row, ''); return () => {}; };
    api.kitDelegationList = async () => [];
    api.collaborationList = async () => ({ items: [], nextOffset: null });
    api.onReviewUpdated = () => () => {};
    api.onTaskWorkspaceUpdated = () => () => {};
    api.followupSuggestionSettings = async () => ({ version: 1, enabled: false });
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    function Fixture() {
      const [review, setReview] = React.useState(false);
      return React.createElement(ChatInput, { sessionId: 'ui-fixture', historyKey: 'ui-fixture', backends: [{ id: 'api', type: 'openai-compatible' }], activeBackendId: 'api',
        isStreaming: false, isMobile: width < 500, skipPermissions: true, onSend: (...args: any[]) => { f.sent.push(args); }, onAbort: () => {}, onAdjustFontSize: () => {},
        onOpenOpinions: () => setReview(true),
        workflowTools: React.createElement(React.Fragment, null,
          React.createElement(ProjectTasksPanel, { session: 'ui-fixture', executor: 'local', backendId: 'api', backends: [] }),
          React.createElement(RoleReviewPanel, { session: 'ui-fixture', executor: 'local', open: review, onOpen: () => setReview(true), onClose: () => setReview(false), onReference: () => {} }),
          React.createElement(UserInteractionsPanel, { sessionId: 'ui-fixture', compact: true }),
          React.createElement(KitDelegationStatus, { sessionId: 'ui-fixture', executor: 'local', compact: true })) });
    }
    createRoot(root).render(React.createElement(Fixture));
  }, { dark, width });
}

for (const width of [1366, 390]) for (const dark of [true, false]) test(`compact composer surface ${width} ${dark ? 'dark' : 'light'}`, async ({ page }, info) => {
  await mount(page, width, dark);
  await expect(page.getByRole('button', { name: '交互状态', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '核对问答状态' })).not.toBeVisible();
  await expect(page.getByLabel('提醒 Kit 待确认')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '查看角色评议' })).toHaveCount(0);
  const bar = page.getByLabel('会话协作工具');
  const box = await bar.boundingBox();
  expect(box!.height).toBeLessThan(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('.awu-composer').screenshot({ path: info.outputPath('composer.png') });
  await page.getByRole('button', { name: '交互状态', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '交互状态' });
  await expect(panel).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  await page.getByRole('button', { name: 'Kit 提醒设置', exact: true }).click();
  await page.getByLabel('提醒 Kit 待确认').uncheck();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认' })).not.toBeChecked();
  await page.locator('.chat-textarea').fill('保留我的草稿');
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await expect(page.getByRole('dialog', { name: '分支副本', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '分支副本', exact: true }).screenshot({ path: info.outputPath('project.png') });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('保留我的草稿');
});

test('new question opens compact panel without stealing draft focus; collapsing and reopening preserves answer', async ({ page }, info) => {
  await mount(page, 390, true);
  const input = page.locator('.chat-textarea'); await input.fill('正在编辑'); await input.focus();
  await page.evaluate(() => (window as any).presentation.pushed({ id: 'question', sessionId: 'ui-fixture', messageId: 'message', revision: 1, kind: 'question', status: 'pending', title: '需要确认目标目录', canSkip: false,
    questions: [{ id: 'dir', header: '', question: '将成果保存到哪里？', required: true, multiple: false, secret: false, allowOther: true, options: [] }] }));
  await expect(page.getByRole('dialog', { name: '交互状态' })).toBeVisible();
  await expect(input).toBeFocused();
  await page.getByLabel('你的回答').fill('D:/project');
  await page.getByRole('button', { name: '收起交互状态', exact: true }).click();
  await page.getByRole('button', { name: '交互状态', exact: true }).click();
  await expect(page.getByLabel('你的回答')).toHaveValue('D:/project');
  await page.screenshot({ path: info.outputPath('pending-question.png') });
  expect(await page.evaluate(() => (window as any).presentation.sent)).toEqual([]);
});
