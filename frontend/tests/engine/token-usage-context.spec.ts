import { test, expect, type Page } from '@playwright/test';

// Synthetic snapshots in an isolated browser profile; no AWU node or live Session.
async function mount(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
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
    const { React, createRoot } = await import('/tests/engine/react-harness.ts');
    const { TokenUsageMonitor } = await import('/src/components/TokenUsageMonitor.tsx');
    const { api } = await import('/src/api.ts');
    const summary = { inputTokens: 6040059, outputTokens: 51482, actualTurns: 12, estimatedTurns: 0,
      events: [], contextEvents: [], legacyHistory: true, latestContext: { contextTokens: 171859, source: 'chat' } };
    const fixture = { summary, push: (_event: any) => {} };
    (window as any).usageFixture = fixture;
    api.getSessionTokenUsage = async () => summary;
    api.onSessionUpdated = callback => { fixture.push = callback; return () => {}; };
    createRoot(document.getElementById('root')!).render(React.createElement(TokenUsageMonitor, { sessionId: 'usage-fixture' }));
  });
}

for (const width of [1366, 390]) {
  test(`context without window never displays million-token lifetime badge (${width})`, async ({ page }) => {
    await mount(page, width);
    const trigger = page.getByRole('button', { name: /上下文/ });
    await expect(trigger).toContainText('17.19万 Token');
    await expect(trigger).not.toContainText('累计');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '本会话 Token 使用情况' });
    await expect(dialog).toContainText('窗口上限未知，因此不计算占比');
    await expect(dialog).toContainText('历史口径未重新核验');
    await expect(dialog.getByText('最近请求上下文', { exact: true })).toBeVisible();
  });
}

test('zero, reset and configured-window updates do not retain stale context', async ({ page }) => {
  await mount(page, 1366);
  const trigger = page.getByRole('button', { name: /上下文/ });
  await expect(trigger).toContainText('17.19万 Token');
  await page.evaluate(() => {
    const fixture = (window as any).usageFixture;
    fixture.push({ sessionId: 'usage-fixture', type: 'token_usage_updated', tokenUsage: {
      ...fixture.summary, latestContext: { contextTokens: 0, contextWindow: 100000, contextWindowSource: 'configured' },
    } });
  });
  await expect(trigger).toHaveText('上下文 0%');
  await trigger.click();
  await expect(page.getByRole('dialog')).toContainText('窗口来源：Backend 配置上限');
  await page.evaluate(() => {
    const fixture = (window as any).usageFixture;
    fixture.push({ sessionId: 'usage-fixture', type: 'context_cleared', tokenUsage: { ...fixture.summary, latestContext: null } });
  });
  await expect(trigger).toHaveText('上下文 未知');
  await expect(page.getByRole('dialog')).toContainText('上下文暂无有效测量');
});
