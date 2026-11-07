import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

async function mount(page: Page, width = 1200) {
  await page.setViewportSize({ width, height: 850 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { React, createRoot, ChatInput, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const root = createRoot(document.getElementById('root')!);
    const callbacks = new Set<any>();
    const f = { enabled: false, session: 's', sent: [] as any[], settingsCalls: [] as any[], configs: {} as Record<string, any>, failSettings: false,
      cancelled: [] as string[], render: () => {}, emit: (_state: string, _id = 'r') => {} };
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.followupSuggestionSettings = async (session, _executor, enabled, config) => {
      if (enabled !== undefined) f.enabled = enabled;
      if (config) { f.settingsCalls.push({ session, config }); if (f.failSettings) throw Error('lost reply'); f.configs[session] = config; }
      return { version: 2, enabled: f.enabled, config: f.configs[session] || { backendId: '', model: '', reasoningEffort: '', timeoutSeconds: 30 } };
    };
    api.followupSuggestionDismiss = async (_session, _executor, id) => { f.cancelled.push(id); };
    api.onFollowupSuggestion = cb => { callbacks.add(cb); return () => { callbacks.delete(cb); }; };
    f.emit = (state, id = 'r') => callbacks.forEach(cb => cb({ version: 1, sessionId: 's', requestId: id, messageId: 'answer', state, text: state === 'ready' ? '请先核对两个目录中不同的文件。' : '', notice: '' }, 'local'));
    f.render = () => root.render(React.createElement(ChatInput, { sessionId: f.session, execKey: 'local', historyKey: f.session, isStreaming: false,
      activeBackendId: 'fake', backends: [{ id: 'fake', label: '主对话', type: 'openai-compatible', model: 'large-model' },
        { id: 'light', label: '轻量服务', type: 'openai-compatible', model: 'small-model' }], onAbort: () => {}, onSend: (...args: any[]) => f.sent.push(args) }));
    (window as any).followupFixture = f; f.render();
  });
  await expect(page.getByRole('switch', { name: '影子续写建议' })).toHaveAttribute('aria-checked', 'false');
}
async function enable(page: Page) {
  await page.getByRole('switch', { name: '影子续写建议' }).click();
  await expect(page.getByRole('switch', { name: '影子续写建议' })).toHaveAttribute('aria-checked', 'true');
}
async function emit(page: Page, state: string, id = 'r') {
  await page.evaluate(([state, id]) => (window as any).followupFixture.emit(state, id), [state, id]);
}

for (const width of [1200, 390]) test(`suggestion model and wait limit save independently without generating (${width}px)`, async ({ page }) => {
  await mount(page, width);
  await page.locator('.chat-textarea').fill('保留原草稿');
  await page.getByRole('button', { name: '建议模型设置', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '建议模型设置' });
  await panel.getByLabel('建议 Backend').selectOption('light');
  await panel.getByLabel('建议模型', { exact: true }).fill('tiny-model');
  await panel.getByLabel('建议最长等待').selectOption('120');
  await panel.getByRole('button', { name: '保存建议设置' }).click();
  await expect(panel).toContainText('已保存');
  await expect(page.getByRole('switch', { name: '影子续写建议' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.chat-textarea')).toHaveValue('保留原草稿');
  expect(await page.evaluate(() => (window as any).followupFixture.settingsCalls)).toEqual([
    { session: 's', config: { backendId: 'light', model: 'tiny-model', reasoningEffort: '', timeoutSeconds: 120 } },
  ]);
  expect(await page.evaluate(() => (window as any).followupFixture.sent)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await fs.mkdir(path.resolve('../.qa/followup-model'), { recursive: true });
  await panel.screenshot({ path: path.resolve(`../.qa/followup-model/settings-${width}.png`) });
  await panel.getByRole('button', { name: '收起建议模型设置' }).click();
  await page.evaluate(() => { const f = (window as any).followupFixture; f.session = 'other'; f.render(); });
  await page.getByRole('button', { name: '建议模型设置', exact: true }).click();
  await expect(panel.getByLabel('建议模型', { exact: true })).toHaveValue('');
  await panel.getByRole('button', { name: '收起建议模型设置' }).click();
  await page.evaluate(() => { const f = (window as any).followupFixture; f.session = 's'; f.render(); });
  await page.getByRole('button', { name: '建议模型设置', exact: true }).click();
  await expect(panel.getByLabel('建议模型', { exact: true })).toHaveValue('tiny-model');
});

test('lost suggestion settings receipt retains edits without automatic retry', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '建议模型设置', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '建议模型设置' });
  await panel.getByLabel('建议模型', { exact: true }).fill('my-small-model');
  await page.evaluate(() => { (window as any).followupFixture.failSettings = true; });
  await panel.getByRole('button', { name: '保存建议设置' }).click();
  await expect(panel).toContainText('设置未确认');
  await expect(panel.getByLabel('建议模型', { exact: true })).toHaveValue('my-small-model');
  expect(await page.evaluate(() => (window as any).followupFixture.settingsCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).followupFixture.sent)).toEqual([]);
});

for (const width of [1200, 390]) test(`default off and accept only edits draft (${width}px)`, async ({ page }) => {
  await mount(page, width);
  await emit(page, 'generating'); await emit(page, 'ready');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  await enable(page); await emit(page, 'generating', 'next'); await emit(page, 'ready', 'next');
  await expect(page.getByLabel('影子建议', { exact: true })).toContainText('核对');
  if (width === 390) await page.getByRole('button', { name: 'Tab 采纳' }).click();
  else { await page.locator('.chat-textarea').focus(); await page.locator('.chat-textarea').press('Tab'); }
  await expect(page.locator('.chat-textarea')).toHaveValue('请先核对两个目录中不同的文件。');
  expect(await page.evaluate(() => (window as any).followupFixture.sent)).toEqual([]);
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认' })).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('late suggestions never revive after text edits, attachments or IME', async ({ page }) => {
  await mount(page); await enable(page);
  const input = page.locator('.chat-textarea');
  await emit(page, 'generating'); await input.fill('my words'); await input.fill(''); await emit(page, 'ready');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  await emit(page, 'generating', 'ime'); await input.dispatchEvent('compositionstart'); await emit(page, 'ready', 'ime');
  await input.dispatchEvent('compositionend'); await expect(input).toHaveValue('');
  await emit(page, 'generating', 'file');
  await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('kept file') });
  await emit(page, 'ready', 'file'); await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).followupFixture.cancelled)).toEqual(expect.arrayContaining(['r', 'ime', 'file']));
});

test('Escape dismisses and session switch discards old completion instead of replaying', async ({ page }) => {
  await mount(page); await enable(page); await emit(page, 'generating'); await emit(page, 'ready');
  await page.locator('.chat-textarea').focus(); await page.locator('.chat-textarea').press('Escape');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  await emit(page, 'generating'); await emit(page, 'ready');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  await emit(page, 'generating', 'switch');
  await page.evaluate(() => { const f = (window as any).followupFixture; f.session = 'other'; f.render(); });
  await expect(page.locator('.chat-textarea')).toHaveValue('');
  await emit(page, 'ready', 'switch');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).followupFixture; f.session = 's'; f.render(); });
  await emit(page, 'ready', 'switch');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
});

test('Slash menu owns Tab and disabling cancels the active helper', async ({ page }) => {
  await mount(page); await enable(page); await emit(page, 'generating'); await emit(page, 'ready');
  await page.locator('.chat-textarea').fill('/hel'); await page.locator('.chat-textarea').press('Tab');
  await expect(page.locator('.chat-textarea')).toHaveValue('/help ');
  await page.locator('.chat-textarea').fill(''); await emit(page, 'generating', 'disable');
  await page.getByRole('switch', { name: '影子续写建议' }).click(); await emit(page, 'ready', 'disable');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).followupFixture.cancelled)).toContain('disable');
});

for (const [width, dark] of [[1200, false], [390, true]] as const) test(`combined pending questions, Kit receipt, editor and session switch (${width})`, async ({ page }) => {
  await mount(page, width); await enable(page);
  await page.evaluate(async ({ dark }) => {
    const { React, createRoot, UserInteractionsPanel, KitDelegationBadge, interactionIndex, kitDelegations, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    document.body.style.background = dark ? '#111' : '#fff'; document.body.style.color = dark ? '#eee' : '#222';
    Object.assign(document.getElementById('root')!.style, { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minHeight: '70vh' });
    const row = { id: 'pending', sessionId: 's', messageId: 'answer', revision: 1, kind: 'question', status: 'pending', title: '待补充需求', detail: '', canSkip: false,
      questions: [{ id: 'q', question: '补充要求', options: [], multiple: false, allowOther: true, required: true, secret: false, header: '' }] };
    api.userInteractionList = async () => ({ items: [row] as any });
    api.onSessionConnectionStatus = (_s, cb) => { cb(true); return () => {}; };
    api.onUserInteraction = () => () => {};
    api.collaborationList = async () => ({ items: [{ id: 'role', revision: 1, name: '审查者', enabled: true, archived: false, updatedAt: 1 }], nextOffset: null });
    interactionIndex.accept('local', row as any);
    kitDelegations.accept('local', { id: 'grant', sessionId: 's', messageId: 'message', revision: 1, status: 'accepted' } as any);
    const panel = document.createElement('div'); document.body.prepend(panel);
    createRoot(panel).render(React.createElement(React.Fragment, null,
      React.createElement(UserInteractionsPanel, { sessionId: 's' }), React.createElement(KitDelegationBadge, { sessionId: 's', messageId: 'message' })));
  }, { dark });
  await emit(page, 'generating', 'pending'); await emit(page, 'ready', 'pending');
  await expect(page.getByLabel('影子建议', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '原生交互' })).toContainText('待补充需求');
  await page.locator('input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('kept attachment') });
  await page.locator('.chat-textarea').fill('#审');
  await expect(page.getByRole('option', { name: '#审查者', exact: true })).toBeVisible();
  await page.locator('.chat-textarea').press('Escape');
  await page.locator('.chat-textarea').fill('原会话编辑草稿');
  await page.locator('.chat-textarea').dispatchEvent('compositionstart');
  await page.locator('.chat-textarea').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await page.locator('.chat-textarea').dispatchEvent('compositionend');
  await page.getByRole('switch', { name: '本次允许 Kit 代确认' }).click();
  await page.evaluate(() => { const f = (window as any).followupFixture; f.session = 'other'; f.render(); });
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认' })).not.toBeChecked();
  await page.evaluate(() => { const f = (window as any).followupFixture; f.session = 's'; f.render(); });
  await expect(page.locator('.chat-textarea')).toHaveValue('原会话编辑草稿');
  await expect(page.getByRole('switch', { name: '本次允许 Kit 代确认' })).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).followupFixture.sent)).toEqual([]);
});
