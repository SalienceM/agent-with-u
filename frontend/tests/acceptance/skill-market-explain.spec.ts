import { test, expect } from '@playwright/test';

const makeItem = (id: string, digest = 'digest1') => ({
  id, sourceId: 'demo-source', name: id, sourceName: 'Demo', repository: 'example/skills', ref: 'master', path: `skills/${id}`,
  digest, homepage: 'https://github.com/example/skills/tree/master', official: false,
  description: `${id} original English description`, preview: `# ${id}\nOriginal instructions: read scripts/check.py`,
  fileNames: ['SKILL.md', 'scripts/check.py'], fileCount: 2, size: 512,
  risk: { level: 'medium', flags: ['包含脚本，请检查'] }, warnings: [], installed: false,
  sameSource: false, localModified: false, updateAvailable: false, conflict: false,
});

async function openMarket(page: any) {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '扩展', exact: true }).click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /扩展市场/ }).click();
  return page.getByRole('tabpanel', { name: '扩展市场' });
}

test('explicit branch and AI original/explanation switch preserve source and isolate pending results', async ({ page }, testInfo) => {
  const addCalls: unknown[][] = [];
  let generations = 0;
  let polls = 0;
  let betaFailed = false;
  const jobs = new Map<string, any>();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      const reply = (payload: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(payload) }));
      if (frame.method === 'skillMarketList') return reply({ status: 'ok', directories: [],
        sources: [{ id: 'demo-source', name: 'Demo', repository: 'example/skills', ref: 'master', effectiveRef: 'master', skillCount: 2 }],
        items: [makeItem('alpha'), makeItem('beta')],
      });
      if (frame.method === 'getBackends') return reply([
        { id: 'text-api', label: '测试文本 API', type: 'openai-compatible', enabled: true },
        { id: 'agent', label: '不能执行的 Agent', type: 'codex-office', enabled: true },
      ]);
      if (frame.method === 'skillMarketAddSource') { addCalls.push(frame.params); return reply({ status: 'ok' }); }
      if (frame.method === 'skillMarketExplainStart') {
        const key = frame.params.slice(0, 4).join(':');
        expect(frame.params[3]).toBe('text-api');
        if (frame.params[4] || !jobs.has(key)) {
          generations++;
          const beta = frame.params[1].includes('beta');
          const fail = beta && !betaFailed;
          if (beta) betaFailed = true;
          jobs.set(key, { status: 'ok', jobId: key, state: fail ? 'error' : beta ? 'done' : 'running',
            text: beta && !fail ? '## 有什么用\nbeta 中文说明' : '', message: fail ? '模拟模型连接失败' : '' });
        }
        return reply(jobs.get(key));
      }
      if (frame.method === 'skillMarketExplainGet') {
        polls++;
        const job = jobs.get(frame.params[0]);
        job.state = 'done'; job.text = '## 有什么用\nalpha 中文说明\n## 如何使用\n输入主题和页数\n## 依赖与准备\n原文未说明\n## 注意事项\n不要直接执行未知脚本';
        // 延迟模拟：切走之后的完成结果不能覆盖另一个 Skill。
        setTimeout(() => reply(job), 350);
        return;
      }
      if (frame.method === 'skillMarketInstall' || frame.method === 'sendMessage' || frame.method.startsWith('skillRuntime')) {
        throw new Error('UI explanation must not install or execute anything');
      }
      server.send(message);
    });
  });
  const market = await openMarket(page);
  await expect(market.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
  const sourceToggle = market.getByRole('button', { name: /来源与添加/ });
  if (await sourceToggle.getAttribute('aria-expanded') === 'false') await sourceToggle.click();
  await market.getByRole('textbox', { name: 'GitHub 仓库地址' }).fill('example/skills');
  await market.getByRole('combobox', { name: '来源分支' }).fill('release/2026');
  await market.getByRole('button', { name: '＋ 添加源', exact: true }).click();
  await expect.poll(() => addCalls.length).toBe(1);
  expect(addCalls[0]).toEqual(['example/skills', '', 'release/2026']);
  await expect(market.getByRole('combobox', { name: '来源分支' })).toHaveValue('');
  await expect(market.locator('.skill-market-source').getByText('@master')).toBeVisible();
  await market.getByRole('button', { name: /来源与添加/ }).click();
  expect(generations).toBe(0);
  await expect(market.getByRole('combobox', { name: 'AI 解读 Backend' })).toHaveValue('text-api');
  await expect(market.getByRole('combobox', { name: 'AI 解读 Backend' }).locator('option')).toHaveCount(1);
  await market.getByRole('button', { name: 'AI 中文解读', exact: true }).click();
  await expect(market.getByText(/正在生成中文解读/)).toBeVisible();
  await expect.poll(() => polls).toBe(1);
  await market.locator('.skill-market-item').filter({ hasText: 'beta original' }).click();
  await expect(market.getByRole('button', { name: '原文', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await market.getByRole('button', { name: 'AI 中文解读', exact: true }).click();
  await expect(market.getByRole('alert')).toContainText('模拟模型连接失败');
  await market.getByRole('button', { name: '重试解读', exact: true }).click();
  await expect(market.getByText('beta 中文说明', { exact: true })).toBeVisible();
  await expect(market.getByText('alpha 中文说明', { exact: true })).toHaveCount(0);
  await market.locator('.skill-market-item').filter({ hasText: 'alpha original' }).click();
  await market.getByRole('button', { name: 'AI 中文解读', exact: true }).click();
  await expect(market.getByText('alpha 中文说明', { exact: true })).toBeVisible();
  expect(generations).toBe(3);
  await expect(market.getByRole('button', { name: '安装到 Skill 库', exact: true })).toBeDisabled();
  for (const name of ['有什么用', '如何使用', '依赖与准备', '注意事项']) {
    await expect(market.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await market.locator('.skill-market-detail').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('market-ai-explanation.png'), fullPage: true });
  await market.getByRole('button', { name: '原文', exact: true }).click();
  await expect(market.getByText('alpha original English description', { exact: true }).last()).toBeVisible();
  await market.getByRole('button', { name: 'AI 中文解读', exact: true }).click();
  await expect(market.getByText('alpha 中文说明', { exact: true })).toBeVisible();
  expect(generations).toBe(3);
  expect(pageErrors).toEqual([]);
});

test('missing text API backend is explicit and never starts an agent', async ({ page }) => {
  let calls = 0;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      const reply = (payload: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(payload) }));
      if (frame.method === 'getBackends') return reply([{ id: 'agent', type: 'codex-office', label: 'Agent' }]);
      if (frame.method === 'skillMarketList') return reply({ status: 'ok', sources: [], directories: [], items: [makeItem('alpha')] });
      if (frame.method === 'skillMarketExplainStart') { calls++; return reply({ status: 'error' }); }
      server.send(message);
    });
  });
  const market = await openMarket(page);
  await market.getByRole('button', { name: 'AI 中文解读', exact: true }).click();
  await expect(market.getByRole('status')).toContainText('请先在 Backend 管理中配置');
  expect(calls).toBe(0);
  await market.getByRole('button', { name: '原文', exact: true }).click();
  await expect(market.getByRole('button', { name: '安装到 Skill 库', exact: true })).toBeDisabled();
});
