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
      --theme-bg:${dark ? '#10171f' : '#ffffff'};--theme-panel-solid:${dark ? '#18212b' : '#f7f9fc'};--theme-bg-secondary:${dark ? '#18212b88' : '#f7f9fc88'};--theme-bg-tertiary:${dark ? '#232f3e' : '#ecf0f6'};--theme-input-bg:${dark ? '#151e29' : '#f9fafc'};--theme-border:${dark ? '#2a3645' : '#dce3ed'};--theme-text:${dark ? '#dbe2ed' : '#273244'};--theme-text-muted:${dark ? '#98a7bc' : '#63738a'};--theme-accent:${dark ? '#76a4ff' : '#3975db'};--theme-accent-bg:${dark ? '#76a4ff18' : '#3975db12'};`;
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
        realtimeVoice: { sessionId: 'ui-fixture', backendLabel: 'fixture', voice: '', rate: 1, onSend: () => {} },
        workflowTools: React.createElement(React.Fragment, null,
          React.createElement(ProjectTasksPanel, { session: 'ui-fixture', executor: 'local', backendId: 'api', backends: [] }),
          React.createElement(RoleReviewPanel, { session: 'ui-fixture', executor: 'local', open: review, onOpen: () => setReview(true), onClose: () => setReview(false), onReference: () => {} }),
          React.createElement(UserInteractionsPanel, { sessionId: 'ui-fixture', compact: true }),
          React.createElement(KitDelegationStatus, { sessionId: 'ui-fixture', executor: 'local', compact: true })) });
    }
    createRoot(root).render(React.createElement(Fixture));
  }, { dark, width });
}

for (const width of [1366, 840, 390]) for (const dark of [true, false]) test(`compact composer surface ${width} ${dark ? 'dark' : 'light'}`, async ({ page }, info) => {
  await mount(page, width, dark);
  await expect(page.getByRole('button', { name: '交互状态', exact: true })).not.toBeVisible();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认' })).not.toBeVisible();
  await expect(page.getByRole('switch', { name: '影子续写建议' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '建议模型设置', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '开启实时语音对话' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '核对问答状态' })).not.toBeVisible();
  await expect(page.getByLabel('提醒 Kit 待确认')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '查看角色评议' })).toHaveCount(0);
  const bar = page.getByLabel('输入工具栏', { exact: true });
  const box = await bar.boundingBox();
  expect(box!.height).toBeLessThan(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('.awu-composer').screenshot({ path: info.outputPath('composer.png') });
  await page.getByRole('button', { name: '更多输入工具', exact: true }).click();
  const more = page.getByRole('dialog', { name: '更多输入工具', exact: true });
  await expect(more.getByRole('button', { name: '转为文本附件' })).toBeVisible();
  await expect(more).toContainText('随消息一起发送');
  await expect(more.getByRole('button', { name: '开启实时语音对话' })).not.toBeVisible();
  const moreBounds = await more.boundingBox();
  expect(moreBounds!.x).toBeGreaterThanOrEqual(0); expect(moreBounds!.x + moreBounds!.width).toBeLessThanOrEqual(width);
  expect(moreBounds!.y).toBeGreaterThanOrEqual(0);
  await more.screenshot({ path: info.outputPath('more-tools.png') });
  await more.locator('summary').filter({ hasText: '确认与提醒' }).click();
  await expect(more.getByRole('button', { name: '开启实时语音对话' })).toBeVisible();
  await page.getByRole('button', { name: '交互状态', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '交互状态' });
  await expect(panel).toBeVisible();
  await expect(more).not.toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  await expect(page.getByRole('button', { name: '更多输入工具', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '更多输入工具', exact: true }).click();
  await page.getByRole('button', { name: 'Kit 提醒设置', exact: true }).click();
  await page.getByLabel('提醒 Kit 待确认').uncheck();
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await page.locator('.chat-textarea').fill('保留我的草稿');
  await page.getByRole('button', { name: '分支副本与合并' }).click();
  await expect(page.getByRole('dialog', { name: '分支副本', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '分支副本', exact: true }).screenshot({ path: info.outputPath('project.png') });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('保留我的草稿');
});

for (const width of [1366, 390]) for (const dark of [true, false]) test(`document composer ${width} ${dark ? 'dark' : 'light'}`, async ({ page }, info) => {
  await mount(page, width, dark);
  await page.evaluate(({ dark }) => {
    const root = document.querySelector<HTMLElement>('.app-root')!;
    root.style.setProperty('--theme-panel-solid', dark ? '#10171f' : '#ffffff');
    root.style.setProperty('--theme-bg', dark ? 'rgba(16,23,31,.6)' : 'rgba(255,255,255,.6)');
  }, { dark });
  await page.locator('.chat-textarea').fill('# 控制台改造计划\n\n先整理目前的配置和运行状态，让日常操作更清楚。\n\n## 本次调整\n\n- 配置查看与修改\n- 计划详情和依赖关系\n- 运行干预与局部重跑\n\n保持现有目录和工作成果，逐步验证每个操作。');
  await page.getByRole('button', { name: '展开编辑消息和文本块' }).click();
  const panel = page.getByRole('dialog', { name: '展开编辑消息' });
  expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(dark ? 'rgb(16, 23, 31)' : 'rgb(255, 255, 255)');
  if (width > 760) await panel.getByRole('button', { name: '对照', exact: true }).click();
  await panel.screenshot({ path: info.outputPath('document-editor.png') });
  await panel.getByRole('button', { name: '预览', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '本次调整' })).toBeVisible();
  await panel.screenshot({ path: info.outputPath('document-preview.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const box = await panel.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  await panel.getByRole('button', { name: '发送当前消息' }).focus();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: '返回输入框' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-textarea')).toBeFocused();
});

test('menu actions preserve text selection and authorization stays explicit when the menu closes', async ({ page }) => {
  await mount(page, 840, true);
  const input = page.locator('.chat-textarea');
  const moreButton = page.getByRole('button', { name: '更多输入工具', exact: true });
  await input.fill('前言 详细资料 后记');
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 7));
  await moreButton.click();
  await page.getByRole('button', { name: '转为文本附件', exact: true }).click();
  await expect(input).toHaveValue('前言  后记');
  await expect(page.getByText('selected-text-1.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销文本收纳 / 恢复' }).click();
  await expect(input).toHaveValue('前言 详细资料 后记');
  await moreButton.click();
  await page.getByRole('dialog', { name: '更多输入工具', exact: true }).locator('summary').filter({ hasText: '回复辅助' }).click();
  await page.getByRole('button', { name: '建议模型设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '更多输入工具', exact: true })).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: '建议模型设置', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(moreButton).toBeFocused();
  await expect(input).toHaveValue('前言 详细资料 后记');
  await moreButton.click();
  await page.getByRole('dialog', { name: '更多输入工具', exact: true }).locator('summary').filter({ hasText: '确认与提醒' }).click();
  await page.getByRole('switch', { name: '本次允许 Kit 代确认' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '取消本次 Kit 代确认' })).toBeVisible();
  await page.getByRole('button', { name: '取消本次 Kit 代确认' }).click();
  await expect(page.getByRole('button', { name: '取消本次 Kit 代确认' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认', includeHidden: true })).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).presentation.sent)).toEqual([]);
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
