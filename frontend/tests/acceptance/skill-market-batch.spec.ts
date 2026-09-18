import { test, expect, type Page } from '@playwright/test';

const items = ['alpha', 'beta', 'gamma', 'foreign'].map((name, i) => ({
  id: name, name, sourceId: i === 3 ? 'other' : 'repo', sourceName: i === 3 ? 'Other' : 'Repo',
  repository: i === 3 ? 'example/other' : 'example/skills', ref: 'main', path: `skills/${name}`, digest: `digest-${name}`,
  homepage: 'https://example.com/skills', official: false, description: `${name} instructions`,
  preview: '# Demo\n' + 'Documentation line\n'.repeat(40), fileNames: ['SKILL.md'], fileCount: 1, size: 128,
  risk: { level: 'low', flags: [] }, warnings: [], installed: false, sameSource: false,
  localModified: false, updateAvailable: false, conflict: false,
}));
const catalog = { status: 'ok', sources: [{ id: 'repo', name: 'Repo', repository: 'example/skills', skillCount: 3 },
  { id: 'other', name: 'Other', repository: 'example/other', skillCount: 1 }], directories: [], items };

async function openMarket(page: Page) {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /扩展市场/ }).click();
  return page.getByRole('tabpanel', { name: '扩展市场' });
}

for (const uncertain of [false, true]) {
  test(`repository batch ignores search and ${uncertain ? 'rechecks uncertain receipt with same ID' : 'retries only terminal failures'}`, async ({ page }, testInfo) => {
    const submissions: any[][] = [];
    const inspections: string[] = [];
    const forbidden: string[] = [];
    let transportFailed = false;
    await page.routeWebSocket(/.*/, socket => {
      const server = socket.connectToServer();
      socket.onMessage(message => {
        const frame = JSON.parse(String(message));
        const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
        if (frame.method === 'skillMarketList') return reply(catalog);
        if (frame.method === 'skillMarketLocation') return reply({ status: 'ok', host: 'batch-host', platform: 'Linux', libraryPath: '/batch/library', runtimePath: '/batch/runtime' });
        if (frame.method === 'skillMarketInstallBatch') {
          submissions.push(frame.params);
          const selected = JSON.parse(frame.params[1]);
          return reply({ status: 'ok', state: 'running', jobId: 'batch-job', batch: { total: selected.length, completed: 0,
            items: selected.map((item: any) => ({ ...item, name: item.path.split('/')[1], status: 'pending', message: '' })) } });
        }
        if (frame.method === 'skillMarketJobGet' && frame.params[0] === 'batch-job') {
          if (uncertain && !transportFailed) {
            transportFailed = true;
            socket.send(JSON.stringify({ id: frame.id, error: '模拟连接中断，回执未知' }));
            return;
          }
          const selected = JSON.parse(submissions[submissions.length - 1][1]);
          const batch = { total: selected.length, completed: selected.length, items: selected.map((item: any) => ({
            ...item, name: item.path.split('/')[1],
            status: item.path.endsWith('beta') ? 'skipped' : !uncertain && submissions.length === 1 && item.path.endsWith('gamma') ? 'failed' : 'installed',
            message: item.path.endsWith('beta') ? '已是当前版本' : '',
          })) };
          return reply({ status: 'ok', state: 'done', jobId: 'batch-job', result: { status: 'ok', batch } });
        }
        if (frame.method === 'skillRuntimeInspect') {
          inspections.push(frame.params[0]);
          return reply({ status: 'ok', plan: { status: 'ready', node: { host: 'batch-host', os: 'Linux' }, steps: [], fileCount: 1 } });
        }
        if (['skillMarketInstall', 'skillRuntimePrepare', 'sendMessage'].includes(frame.method)) {
          forbidden.push(frame.method); return reply({ status: 'error' });
        }
        server.send(message);
      });
    });
    const market = await openMarket(page);
    await expect(market.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
    await expect(market.getByRole('button', { name: /来源与添加/ })).toHaveAttribute('aria-expanded', 'false');
    if (testInfo.project.name.includes('desktop') || testInfo.project.name === 'web-chromium') {
      expect((await market.locator('.skill-market-list').boundingBox())!.height).toBeGreaterThan(280);
      expect((await market.locator('.skill-market-audit').boundingBox())!.height).toBeGreaterThan(210);
    }
    await page.screenshot({ path: testInfo.outputPath('compact-market.png'), fullPage: true });
    await market.getByRole('textbox', { name: '搜索扩展' }).fill('alpha');
    await expect(market.locator('.skill-market-item')).toHaveCount(1);
    await market.getByRole('button', { name: '安装此仓库全部（3）', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '安装仓库全部 Skill', exact: true });
    await expect(dialog).toContainText('beta');
    await expect(dialog).toContainText('gamma');
    await expect(dialog).not.toContainText('foreign');
    const submit = dialog.getByRole('button', { name: '确认安装全部', exact: true });
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: /允许覆盖/ })).not.toBeChecked();
    await dialog.getByRole('checkbox', { name: /我已核对/ }).check();
    await submit.click();
    if (uncertain) {
      await dialog.getByRole('button', { name: '重查原批次结果', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('成功 2 · 跳过 1');
      expect(submissions[1]).toEqual(submissions[0]);
    } else {
      await expect(dialog.getByRole('status')).toContainText('成功 1 · 跳过 1 · 失败 / 未完成 1');
      await dialog.getByRole('button', { name: '仅重试失败 / 未完成项', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('成功 2 · 跳过 1');
      expect(JSON.parse(submissions[1][1])).toEqual([{ path: 'skills/gamma', digest: 'digest-gamma' }]);
      expect(submissions[1][3]).not.toBe(submissions[0][3]);
    }
    expect(submissions).toHaveLength(2);
    expect(submissions[0][0]).toBe('repo');
    expect(submissions[0][2]).toBe(false);
    expect(JSON.parse(submissions[0][1])).toEqual(items.slice(0, 3).map(({ path, digest }) => ({ path, digest })));
    await dialog.getByRole('button', { name: '关闭批量安装', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await market.getByRole('button', { name: '查看安装批次', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('成功 2 · 跳过 1');
    expect(submissions).toHaveLength(2);
    expect(inspections).toEqual([]);
    await expect(page.getByRole('dialog', { name: 'Skill 运行准备', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '查看运行准备（2）', exact: true }).click();
    const runtime = page.getByRole('dialog', { name: 'Skill 运行准备', exact: true });
    await expect(runtime).toContainText('无需重复准备');
    await expect(runtime.getByRole('checkbox')).toHaveCount(0);
    expect(inspections).toEqual(['alpha']);
    expect(forbidden).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
