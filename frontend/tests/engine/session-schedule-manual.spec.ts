import { test, expect } from '@playwright/test';

for (const width of [1200, 390]) test(`scheduled prompt documents are embedded and searchable offline (${width}px)`, async ({ page }) => {
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
    const { React, createRoot, ManualPanel } = await import('/tests/engine/session-schedules-harness.ts');
    createRoot(document.getElementById('root')!).render(React.createElement(ManualPanel, { onClose: () => {} }));
  });
  await page.getByRole('button', { name: /Session 定时任务/ }).click();
  await page.context().setOffline(true);
  const guide = page.locator('article').filter({ hasText: '配置定时指令' });
  await guide.getByText('展开完整文档', { exact: true }).click();
  await expect(guide).toContainText('普通 Session 顶部');
  await expect(guide).toContainText('结果未知');
  await page.getByPlaceholder('搜索功能、入口、快捷键……').fill('回滚');
  const release = page.locator('article').filter({ hasText: '发布说明与兼容限制' });
  await release.getByText('展开完整文档', { exact: true }).click();
  await expect(release).toContainText('不能只移除 pending 项');
  await expect(release).toContainText('不提供一键回滚');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
