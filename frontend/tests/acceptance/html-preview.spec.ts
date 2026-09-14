import { test, expect, type Page } from '@playwright/test';

const files: Record<string, string> = {
  'index.html': `<!doctype html><html><head><title>Interactive preview</title>
    <link rel="stylesheet" href="styles/main.css"></head><body>
    <h1>执行节点页面</h1><button id="counter">计数 0</button><div id="data">读取中</div>
    <div id="module">模块加载中</div><img id="logo" src="assets/logo.svg">
    <a href="docs/next.html#destination">打开关联页面</a><a href="#counter">页面内锚点</a>
    <script src="app.js" defer></script><script type="module" src="modules/main.js"></script>
    </body></html>`,
  'app.js': `let count=0; document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent='计数 '+(++count);
    fetch('./data.json').then(r=>r.json()).then(value=>document.querySelector('#data').textContent=value.message);`,
  'modules/main.js': `import { label } from './label.js'; document.querySelector('#module').textContent=label;
    window.moduleBase=import.meta.url;`,
  'modules/label.js': `import { getLabel } from './cycle.js'; export const label=getLabel();`,
  'modules/cycle.js': `import './label.js'; export function getLabel() { return '模块正常'; }`,
  'data.json': '{"message":"原执行端 JSON"}',
  'styles/main.css': '@import "colors.css"; body { background: rgb(246, 249, 252); } #logo { width: 60px; height: 60px; }',
  'styles/colors.css': 'h1 { color: rgb(15, 90, 140); }',
  'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="teal"/></svg>',
  'docs/next.html': '<!doctype html><h1 id="destination">关联页面正常</h1><img src="../assets/logo.svg"><a href="../index.html">返回首页</a>',
};

async function setup(page: Page) {
  const reads: string[] = []; const roots = new Set<string>(); const writes: string[] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listDirectory') return reply([{ name: 'index.html', path: 'index.html', isDir: false, size: files['index.html'].length }]);
      if (['syncFileStat', 'syncReadChunk'].includes(frame.method)) {
        const [root, rel, offset, size] = frame.params;
        roots.add(root); reads.push(rel);
        if (!(rel in files)) return reply({ status: 'error', message: 'fixture file missing: ' + rel });
        const bytes = Buffer.from(files[rel]);
        return reply(frame.method === 'syncFileStat' ? { status: 'ok', size: bytes.length }
          : { status: 'ok', data: bytes.subarray(offset, offset + size).toString('base64') });
      }
      if (/^sync(Write|Delete)/.test(frame.method)) { writes.push(frame.method); return reply({ status: 'error' }); }
      server.send(message);
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true }).click();
  await page.locator('.ftp-panel').getByText('index.html', { exact: true }).click();
  return { reads, roots, writes };
}

test('HTML renders styles, images, scripts, modules and fetch; source toggle preserves interaction; links retain workspace', async ({ page }, info) => {
  const { roots, reads, writes } = await setup(page);
  const preview = page.frameLocator('iframe[title="HTML 页面预览"]');
  await expect(preview.getByRole('heading', { name: '执行节点页面' })).toHaveCSS('color', 'rgb(15, 90, 140)');
  expect(reads).not.toContain('app.js');
  await preview.getByRole('link', { name: '页面内锚点' }).click();
  await expect(preview.getByRole('heading', { name: '执行节点页面' })).toBeVisible();
  await page.getByRole('button', { name: '启用页面脚本', exact: true }).click();
  await expect(preview.locator('#data')).toHaveText('原执行端 JSON');
  await expect(preview.locator('#module')).toHaveText('模块正常');
  await expect.poll(() => preview.locator('#logo').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(60);
  await preview.getByRole('button', { name: '计数 0' }).click();
  await expect(preview.getByRole('button', { name: '计数 1' })).toBeVisible();
  const count = reads.length;
  await page.getByRole('button', { name: '</> 源码', exact: true }).click();
  await page.getByRole('button', { name: '🌐 页面', exact: true }).click();
  await expect(preview.getByRole('button', { name: '计数 1' })).toBeVisible();
  expect(reads.length).toBe(count);
  await preview.locator('body').evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: info.outputPath('html-render.png') });
  await preview.getByRole('link', { name: '打开关联页面' }).click();
  await expect(preview.getByRole('heading', { name: '关联页面正常' })).toBeVisible();
  await expect(page.getByRole('button', { name: /实际位置.*docs\/next.html/ })).toBeVisible();
  expect(roots.size).toBe(1); expect(writes).toEqual([]);
  expect(reads).toContain('docs/next.html'); expect(reads).toContain('styles/colors.css');
});

test('HTML sandbox cannot access host identity, hidden files or invoke write APIs', async ({ page }) => {
  const { reads, writes } = await setup(page);
  const preview = page.frameLocator('iframe[title="HTML 页面预览"]');
  await expect(preview.getByRole('button', { name: '计数 0' })).toBeVisible();
  await page.getByRole('button', { name: '启用页面脚本', exact: true }).click();
  await expect(preview.locator('#module')).toHaveText('模块正常');
  const result = await preview.locator('body').evaluate(async () => {
    let parentBlocked = false; let secretsBlocked = false; let writeBlocked = false;
    try { void parent.document.body; } catch { parentBlocked = true; }
    try { await fetch('.env'); } catch { secretsBlocked = true; }
    try { await fetch('/api/config', { method: 'POST', body: 'unsafe' }); } catch { writeBlocked = true; }
    return { parentBlocked, secretsBlocked, writeBlocked };
  });
  expect(result).toEqual({ parentBlocked: true, secretsBlocked: true, writeBlocked: true });
  expect(reads).not.toContain('.env'); expect(writes).toEqual([]);
  await expect(page.locator('iframe[title="HTML 页面预览"]')).toHaveAttribute('sandbox', 'allow-scripts');
});

test('manual exposes searchable Relay onboarding steps without executing them', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('menuitem', { name: '使用手册', exact: true }).click();
  await page.getByPlaceholder('搜索功能、入口、快捷键……').fill('新执行节点');
  const card = page.locator('article').filter({ hasText: '新执行节点接入 Relay' });
  await card.getByText('展开操作步骤与命令', { exact: true }).click();
  await expect(card).toContainText('不是 Session ID');
  await expect(card).toContainText('Get-Content "$HOME\\.agent-with-u\\device-id"');
  await expect(card).toContainText('user grant "Relay用户名" "新节点ID"');
  await expect(card).toContainText('同一份 users.json');
  await page.screenshot({ path: info.outputPath('relay-manual.png') });
});
