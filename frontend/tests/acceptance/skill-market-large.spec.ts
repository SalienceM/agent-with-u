import { test, expect } from '@playwright/test';

test('large market download is a background job and file audit is paginated', async ({ page }, testInfo) => {
  let finished = false;
  let starts = 0;
  let polls = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const item = {
    id: 'large', name: 'large-skill', description: 'Complete large Skill', sourceId: 'large-source',
    sourceName: 'Large source', repository: 'example/large', ref: 'main', path: 'skills/large-skill',
    digest: 'preview-digest', homepage: 'https://github.com/example/large', official: false,
    preview: '# Large Skill', fileCount: 13000, size: 80 * 1024 * 1024,
    fileNames: Array.from({ length: 13000 }, (_, i) => `assets/icon-${String(i).padStart(5, '0')}.svg`),
    risk: { level: 'low', flags: [] }, warnings: [], installed: false, sameSource: false,
    localModified: false, updateAvailable: false, conflict: false,
  };
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      const reply = (payload: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(payload) }));
      if (frame.method === 'skillMarketList') {
        expect(frame.params[2]).toBe(true);
        starts++;
        return reply({ status: 'ok', state: 'running', jobId: 'catalog-job' });
      }
      if (frame.method === 'skillMarketJobGet') {
        if (frame.params[0] === 'install-job') return reply({ status: 'ok', state: 'error', jobId: 'install-job', message: '模拟安装失败，可重试' });
        polls++;
        if (!finished) return reply({ status: 'ok', state: 'running', jobId: 'catalog-job',
          progress: [{ name: 'Large source', phase: 'downloading', downloaded: 80 * 1024 * 1024, total: 100 * 1024 * 1024 }],
        });
        return reply({ status: 'ok', state: 'done', jobId: 'catalog-job', result: { status: 'ok',
          sources: [{ id: 'large-source', name: 'Large source', repository: 'example/large', ref: 'main', effectiveRef: 'main', skillCount: 1 }],
          directories: [], items: [item],
        } });
      }
      if (frame.method === 'skillMarketInstall') {
        expect(frame.params).toEqual(['large-source', 'skills/large-skill', 'preview-digest', false, true]);
        return reply({ status: 'ok', state: 'running', jobId: 'install-job' });
      }
      server.send(message);
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /扩展市场/ }).click();
  const market = page.getByRole('tabpanel', { name: '扩展市场' });
  await expect(market.getByRole('status')).toContainText('80.0 MiB / 100.0 MiB');
  await page.getByRole('tab', { name: '工作总览', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '工作总览' })).toBeVisible();
  await page.getByRole('tab', { name: '扩展市场', exact: true }).click();
  // 工作台保留已挂载的市场页；切换标签应继续同一任务，不重复提交下载。
  expect(starts).toBe(1);
  finished = true;
  await expect(market.getByRole('heading', { name: 'large-skill', exact: true })).toBeVisible();
  await expect(market.getByText('assets/icon-00000.svg', { exact: true })).toBeVisible();
  await expect(market.getByText('assets/icon-00100.svg', { exact: true })).toHaveCount(0);
  await market.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(market.getByText('assets/icon-00100.svg', { exact: true })).toBeVisible();
  await expect(market.getByText('assets/icon-00000.svg', { exact: true })).toHaveCount(0);
  await market.getByRole('textbox', { name: '搜索安装文件' }).fill('icon-12999');
  await expect(market.getByText('assets/icon-12999.svg', { exact: true })).toBeVisible();
  await market.getByRole('checkbox').check();
  await market.getByRole('button', { name: '安装到 Skill 库', exact: true }).click();
  await expect(market.getByText('模拟安装失败，可重试', { exact: true })).toBeVisible();
  await expect(market.getByRole('button', { name: '安装到 Skill 库', exact: true })).toBeEnabled();
  expect(polls).toBeGreaterThan(1);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('large-skill-market.png'), fullPage: true });
});
