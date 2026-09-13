import { test, expect } from '@playwright/test';

test('market reserves sync space and retains geometry across data, backend and error responses', async ({ page }, testInfo) => {
  let releaseCatalog = false;
  let holdBackends = false;
  let starts = 0;
  const backendReplies: Array<() => void> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const backend = { id: 'text-api', type: 'openai-compatible', label: '已同步的文本 API', enabled: true };
  const item = {
    id: 'demo', name: 'demo-skill', description: 'Read the documentation before installing.',
    sourceId: 'demo-source', sourceName: 'Demo', repository: 'example/skills', ref: 'main',
    path: 'skills/demo-skill', digest: 'digest-1', homepage: 'https://github.com/example/skills',
    official: false, preview: '# Skill instructions', fileNames: ['SKILL.md', 'scripts/demo.py'],
    fileCount: 2, size: 1000, risk: { level: 'medium', flags: ['包含脚本'] }, warnings: [],
    installed: false, sameSource: false, localModified: false, updateAvailable: false, conflict: false,
  };
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      const reply = (value: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'getBackends') {
        if (holdBackends) backendReplies.push(() => reply([backend]));
        else reply([backend]);
        return;
      }
      if (frame.method === 'skillMarketList') {
        starts++;
        return reply({ status: 'ok', state: 'running', jobId: `catalog-${starts}` });
      }
      if (frame.method === 'skillMarketJobGet') {
        if (!releaseCatalog) return reply({ status: 'ok', state: 'running', jobId: frame.params[0], progress: [] });
        return reply({ status: 'ok', state: 'done', jobId: frame.params[0], result: starts > 1
          ? { status: 'error', message: '模拟同步失败，保留已有内容' }
          : { status: 'ok', items: [item], sources: [
            { id: 'demo-source', name: 'Demo', repository: 'example/skills', ref: 'main', effectiveRef: 'main', skillCount: 1 },
            { id: 'failed-source', name: '另一来源', repository: 'example/missing', ref: 'main', error: '测试加载失败，不能移动下方输入框和列表' },
          ], directories: [{ name: '公开目录链接', url: 'https://example.com/docs' }] },
        });
      }
      if (frame.method === 'skillMarketExplainStart') return reply({ status: 'ok', state: 'done', jobId: 'explanation',
        text: '## 有什么用\n' + '这是同步完成后的解读内容。\n'.repeat(100),
      });
      if (frame.method === 'skillMarketInstall') throw new Error('layout test must not install');
      server.send(message);
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  holdBackends = true;
  await page.locator('.awu-sidebar').getByRole('button', { name: /扩展市场/ }).click();
  const market = page.getByRole('tabpanel', { name: '扩展市场' });
  const sourceToggle = market.getByRole('button', { name: /来源与添加/ });
  if (await sourceToggle.getAttribute('aria-expanded') === 'false') await sourceToggle.click();
  await expect(market.getByTestId('market-list-placeholder')).toBeVisible();
  await expect(market.getByTestId('market-detail-placeholder')).toContainText('同步中');
  await expect(market.getByText('从左侧选择一个 Skill 查看完整内容', { exact: true })).toHaveCount(0);

  const geometry = async () => market.locator('.skill-market-source-inputs, .skill-market-layout, .skill-market-list, .skill-market-detail').evaluateAll(nodes =>
    nodes.map(node => {
      const rect = node.getBoundingClientRect();
      const root = node.closest('.skill-market-dialog')!;
      const parent = root.getBoundingClientRect();
      return { x: rect.x - parent.x, y: rect.y - parent.y + root.scrollTop, width: rect.width, height: rect.height };
    }));
  const unchanged = (before: any[], after: any[]) => {
    expect(after.length).toBe(before.length);
    before.forEach((rect, index) => Object.keys(rect).forEach(key => expect(Math.abs(rect[key] - after[index][key]), `region ${index} ${key}`).toBeLessThanOrEqual(1)));
  };
  const pendingGeometry = await geometry();
  await page.screenshot({ path: testInfo.outputPath('market-sync-placeholder.png'), fullPage: true });
  releaseCatalog = true;
  await expect(market.getByRole('heading', { name: 'demo-skill', exact: true })).toBeVisible();
  unchanged(pendingGeometry, await geometry());
  await expect(market.getByRole('combobox', { name: 'AI 解读 Backend' })).toBeDisabled();
  await expect(market.getByRole('combobox', { name: 'AI 解读 Backend' })).toContainText('同步中');
  await market.getByRole('button', { name: 'AI 中文解读', exact: true }).click();
  await expect(market.getByRole('status')).toContainText('Backend 同步中');
  const footerTop = () => market.locator('.skill-market-footer').evaluate(node => {
    const parent = node.closest('.skill-market-detail')!;
    return node.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
  });
  const pendingFooter = await footerTop();
  await expect.poll(() => backendReplies.length).toBeGreaterThan(0);
  holdBackends = false;
  backendReplies.splice(0).forEach(reply => reply());
  await expect(market.getByRole('heading', { name: '有什么用', exact: true })).toBeVisible();
  expect(Math.abs(await footerTop() - pendingFooter)).toBeLessThanOrEqual(1);

  releaseCatalog = false;
  await market.getByRole('button', { name: '↻ 刷新源', exact: true }).click();
  await expect(market.getByRole('status')).toContainText('同步中');
  await expect(market.getByRole('heading', { name: 'demo-skill', exact: true })).toBeVisible();
  await expect(market.getByTestId('market-list-placeholder')).toHaveCount(0);
  unchanged(pendingGeometry, await geometry());
  releaseCatalog = true;
  await expect(market.getByText('模拟同步失败，保留已有内容', { exact: true })).toBeVisible();
  unchanged(pendingGeometry, await geometry());
  await expect(market.getByRole('heading', { name: 'demo-skill', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('market-synced-stable-layout.png'), fullPage: true });
});
