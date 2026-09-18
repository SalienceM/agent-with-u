import { test, expect, type Page } from '@playwright/test';

const item = {
  id: 'target-demo', name: 'target-demo', sourceId: 'source', sourceName: 'Demo',
  repository: 'example/skills', ref: 'main', path: 'skills/target-demo', digest: 'digest-demo',
  homepage: 'https://example.com/skills', official: false, description: 'Installation routing fixture',
  preview: '# Demo', fileNames: ['SKILL.md'], fileCount: 1, size: 128,
  risk: { level: 'low', flags: [] }, warnings: [], installed: false, sameSource: false,
  localModified: false, updateAvailable: false, conflict: false,
};
const catalog = { status: 'ok', sources: [], directories: [], items: [item] };
const location = (node: string) => ({ status: 'ok', host: `${node}-host`, platform: 'Linux',
  libraryPath: `/data/${node}/skill-library`, runtimePath: `/data/${node}/skill-runtime` });
const profile = { userId: 'target-test', username: 'target-test', displayName: 'Target QA', managed: false };
const target = (deviceId: string) => ({ mode: 'relay', url: 'ws://127.0.0.1:45421/market-target-qa',
  token: 'qa-fixture-not-a-credential', deviceId, deviceName: `工作站 ${deviceId}`, user: profile });

async function openMarket(page: Page) {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /扩展市场/ }).click();
  return page.getByRole('tabpanel', { name: '扩展市场' });
}

test('market shows the real server location before allowing installation, with stable loading and error slots', async ({ page }, testInfo) => {
  const releases: Array<() => void> = [];
  let fail = false;
  let installs = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'skillMarketList') return reply(catalog);
      if (frame.method === 'skillMarketLocation') {
        if (fail) return reply(null); // older executor / unsupported RPC
        releases.push(() => reply(location('direct-server')));
        return;
      }
      if (frame.method === 'skillMarketInstall') { installs++; return reply({ status: 'error', message: 'Not authorized in this test' }); }
      server.send(message);
    });
  });
  const market = await openMarket(page);
  const installLocation = market.getByRole('region', { name: 'Skill 安装位置' });
  await expect(installLocation).toContainText('直连执行节点（服务器）');
  await expect(installLocation).toContainText('同步中');
  const box = await installLocation.boundingBox();
  await expect(market.getByRole('heading', { name: 'target-demo', exact: true })).toBeVisible();
  const install = market.getByRole('button', { name: '安装到 Skill 库', exact: true });
  const review = market.getByRole('checkbox');
  await review.check();
  await expect(install).toBeDisabled();
  await expect.poll(() => releases.length).toBeGreaterThan(0);
  releases.splice(0).forEach(release => release());
  await expect(installLocation).toContainText('/data/direct-server/skill-library');
  await expect(installLocation).toContainText('/data/direct-server/skill-runtime');
  await expect(installLocation).toContainText('文件写入上述节点，不存入浏览器');
  await expect(install).toBeEnabled();
  expect((await installLocation.boundingBox())?.height).toBe(box?.height);
  fail = true;
  await market.getByRole('button', { name: '刷新安装位置' }).click();
  await expect(installLocation).toContainText('该节点未提供安装位置');
  await expect(review).not.toBeChecked();
  await review.check();
  await expect(install).toBeDisabled();
  expect((await installLocation.boundingBox())?.height).toBe(box?.height);
  expect(installs).toBe(0);
  expect(errors).toEqual([]);
  await installLocation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('market-install-location.png'), fullPage: true });
});

test('remote install and environment inspection use the displayed node, never the browser or a new default', async ({ page }, testInfo) => {
  await page.addInitScript(value => localStorage.setItem('awu.connectionTarget', JSON.stringify(value)), target('A'));
  const installs: string[] = [];
  const inspections: string[] = [];
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    let node = 'direct-server';
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.t === 'hello') { node = frame.deviceId; socket.send(JSON.stringify({ t: 'ready' })); return; }
      if (frame.method === 'skillMarketLocation') return reply(location(node));
      if (frame.method === 'skillMarketList') return reply(catalog);
      if (frame.method === 'skillMarketInstall') {
        installs.push(node);
        return reply({ status: 'ok', state: 'running', jobId: `install-on-${node}` });
      }
      if (frame.method === 'skillMarketJobGet') {
        expect(frame.params[0]).toBe(`install-on-${node}`);
        return reply({ status: 'ok', state: 'done', jobId: frame.params[0], result: { status: 'ok', skill: { name: item.name } } });
      }
      if (frame.method === 'skillRuntimeInspect') {
        inspections.push(node);
        return reply({ status: 'ok', plan: { status: 'ready', node: { host: `${node}-host`, os: 'Linux' },
          fileCount: 1, environment: `/data/${node}/skill-runtime/demo`, steps: [] } });
      }
      if (frame.method === 'skillRuntimePrepare' || frame.method === 'sendMessage') {
        mutations.push(frame.method); return reply({ status: 'error' });
      }
      if (frame.method === 'listSessions' || frame.method === 'getBackends') return reply([]);
      server.send(message);
    });
  });
  const market = await openMarket(page);
  const installLocation = market.getByRole('region', { name: 'Skill 安装位置' });
  await expect(installLocation).toContainText('远端执行节点 · 工作站 A');
  await expect(installLocation).toContainText('/data/A/skill-library');
  await market.getByRole('checkbox').check();
  await market.getByRole('button', { name: '安装到 Skill 库', exact: true }).click();
  const runtime = page.getByRole('dialog', { name: 'Skill 运行准备' });
  await expect(market.getByRole('button', { name: '查看运行准备', exact: true })).toBeVisible();
  await expect(runtime).toHaveCount(0);
  expect(inspections).toEqual([]);
  await market.getByRole('button', { name: '查看运行准备', exact: true }).click();
  await expect(runtime).toContainText('A-host');
  await expect(runtime.getByRole('checkbox')).toHaveCount(0);
  await expect(runtime).toContainText('无需重复准备');
  await expect(runtime.getByTestId('skill-import-node')).toContainText('工作站 A');
  await expect(runtime.getByRole('combobox', { name: '运行准备节点' })).toHaveValue('relay:target-test:A');
  expect(installs).toEqual(['A']);
  expect(inspections).toEqual(['A']);

  // A different default affects the market only after resetting its catalog/review.
  // The already-open preparation dialog must retain the actual installation node.
  await page.evaluate(async value => {
    const modulePath = '/src/api.ts';
    const { setConnectionTarget } = await import(modulePath);
    await setConnectionTarget(value);
  }, target('B'));
  await expect(runtime.getByRole('combobox', { name: '运行准备节点' })).toHaveValue('relay:target-test:A');
  await expect(runtime).toContainText('A-host');
  await runtime.getByRole('button', { name: '关闭运行准备' }).click();
  await expect(installLocation).toContainText('/data/B/skill-library');
  await expect(market.getByRole('checkbox')).not.toBeChecked();
  await expect(market.getByRole('button', { name: '安装到 Skill 库', exact: true })).toBeDisabled();
  expect(installs).toEqual(['A']);
  expect(inspections).toEqual(['A']);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await installLocation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('market-remote-install-location.png'), fullPage: true });
});
