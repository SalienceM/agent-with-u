import { test, expect, type Page, type Locator } from '@playwright/test';

// All fixtures below are read-only, synthetic WebSocket replies. They never touch a real workspace.
async function openFiles(page: Page): Promise<Locator> {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' })
    .getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true }).click();
  const panel = page.locator('.ftp-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function treeOffset(panel: Locator): Promise<number> {
  const [outer, tree] = await Promise.all([panel.boundingBox(), panel.locator('.ftp-tree-scroll').boundingBox()]);
  if (!outer || !tree) throw new Error('file panel geometry unavailable');
  return tree.y - outer.y;
}

test('directory expansion survives page and tree refresh without reading collapsed branches', async ({ page }) => {
  const reads: string[] = [];
  const forbidden: string[] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'gitDetect') return reply({ isRepo: false });
      if (['syncManifest', 'syncReadFile', 'syncWriteFile', 'sendMessage'].includes(frame.method)) {
        forbidden.push(frame.method); return reply({ error: 'Unexpected operation in expansion test' });
      }
      if (frame.method === 'listDirectory') {
        const rel = frame.params[0]; reads.push(rel);
        return reply(rel === '' ? [{ name: 'src', path: 'src', isDir: true }, { name: 'docs', path: 'docs', isDir: true }]
          : rel === 'src' ? [{ name: 'nested', path: 'src/nested', isDir: true }]
          : rel === 'src/nested' ? [{ name: 'deep.txt', path: 'src/nested/deep.txt', isDir: false }] : []);
      }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  const row = (name: string) => panel.locator('.ftp-row').filter({ hasText: name });
  await row('src').click(); await row('nested').click();
  await expect(row('deep.txt')).toBeVisible();
  const reopenFiles = async () => {
    const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
    if (await opener.isVisible()) await opener.click();
    await page.getByRole('navigation', { name: '功能栏' })
      .getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true }).click();
    await expect(row('src')).toBeVisible();
  };
  reads.length = 0;
  await page.reload(); await reopenFiles();
  await expect(row('deep.txt')).toBeVisible();
  expect(reads).toEqual(['', 'src', 'src/nested']);
  // 目录工具的刷新也不能丢掉收起父目录下的子级展开选择。
  await row('src').click();
  reads.length = 0;
  await panel.getByRole('button', { name: '刷新文件目录' }).click();
  await expect.poll(() => reads.length).toBe(1);
  await row('src').click();
  await expect(row('deep.txt')).toBeVisible();
  expect(reads).toEqual(['', 'src', 'src/nested']);
  await row('src').click();
  reads.length = 0;
  await page.reload(); await reopenFiles();
  await expect(row('nested')).toHaveCount(0);
  expect(reads).toEqual(['']);
  await row('src').click();
  await expect(row('deep.txt')).toBeVisible();
  expect(reads).not.toContain('docs');
  await panel.getByRole('button', { name: '更多文件工具', exact: true }).click();
  await page.getByRole('button', { name: '全部折叠', exact: true }).click();
  await expect(row('nested')).toHaveCount(0);
  reads.length = 0;
  await page.reload(); await reopenFiles();
  expect(reads).toEqual(['']);
  await row('src').click();
  await expect(row('nested')).toBeVisible();
  await expect(row('deep.txt')).toHaveCount(0);
  expect(forbidden).toEqual([]);
});

test('restored directory failures do not retry on rerender and removed paths are not read', async ({ page }) => {
  let fail = false;
  const reads: string[] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'gitDetect') return reply({ isRepo: false });
      if (frame.method === 'listDirectory') {
        const rel = frame.params[0]; reads.push(rel);
        if (rel === '') return reply([{ name: 'src', path: 'src', isDir: true },
          ...(!fail ? [{ name: 'removed', path: 'removed', isDir: true }] : [])]);
        return reply(fail ? { error: 'Fixture read denied' } : []);
      }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  await panel.locator('.ftp-row').filter({ hasText: 'src' }).click();
  await panel.locator('.ftp-row').filter({ hasText: 'removed' }).click();
  await expect.poll(() => reads.length).toBe(3);
  fail = true; reads.length = 0;
  await page.reload();
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('navigation', { name: '功能栏' })
    .getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true }).click();
  await expect(panel.getByText('目录同步失败，请点击刷新重试', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: /^工作目录 / }).click();
  await page.keyboard.press('Escape');
  expect(reads).toEqual(['', 'src']);
  await panel.getByRole('button', { name: '刷新文件目录' }).click();
  await expect.poll(() => reads.filter(rel => rel === 'src').length).toBe(2);
});

test('compact header keeps the tree within 80px and refresh is independent of pending Git', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { release = resolve; });
    Object.defineProperty(navigator.storage, 'persist', { value: () => pending });
    (window as any).__releaseFilePanelLocalRestore = () => release(true);
  });
  let rootReads = 0;
  let gitReads = 0;
  let finishGit: (() => void) | undefined;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'gitDetect') return reply({ isRepo: true });
      if (frame.method === 'gitStatus') { gitReads++; finishGit = () => reply({ branch: 'a-very-long-feature-branch', files: [] }); return; }
      if (frame.method === 'listDirectory') {
        const rel = frame.params[0];
        if (!rel) rootReads++;
        return reply(rel ? [{ name: 'child.txt', path: 'src/child.txt', isDir: false, size: 0 }]
          : [
            { name: 'src', path: 'src', isDir: true },
            { name: 'empty.txt', path: 'empty.txt', isDir: false, size: 0 },
            { name: `read-${rootReads}.txt`, path: `read-${rootReads}.txt`, isDir: false, size: 1536 },
          ]);
      }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  const firstFile = panel.locator('.ftp-row').filter({ hasText: 'read-1.txt' });
  await expect(firstFile).toBeVisible();
  await expect(firstFile.locator('.ftp-file-size')).toHaveText('1.5 KB');
  await expect(panel.locator('.ftp-row').filter({ hasText: 'empty.txt' }).locator('.ftp-file-size')).toHaveText('0 B');
  await expect(panel.locator('.ftp-row').filter({ hasText: 'src' }).locator('.ftp-file-size')).toHaveCount(0);
  expect(await treeOffset(panel)).toBeLessThanOrEqual(80);
  await expect(panel.getByRole('button', { name: /^工作目录 / })).toBeVisible();
  await expect(panel.getByRole('button', { name: '刷新文件目录' })).toBeVisible();
  await expect(panel.locator('.ftp-git-summary')).toContainText('Git …');
  expect(gitReads).toBe(1);
  await page.evaluate(() => (window as any).__releaseFilePanelLocalRestore());
  await expect.poll(() => treeOffset(panel)).toBeLessThanOrEqual(80);

  await panel.getByRole('button', { name: '刷新文件目录' }).click();
  await expect(panel.locator('.ftp-row').filter({ hasText: 'read-2.txt' })).toBeVisible();
  expect(gitReads).toBe(1);
  expect(await treeOffset(panel)).toBeLessThanOrEqual(80);
  finishGit?.();
  await expect(panel.locator('.ftp-git-summary')).toContainText('a-very-long-feature-branch');
  expect(await treeOffset(panel)).toBeLessThanOrEqual(80);
  await page.screenshot({ path: testInfo.outputPath('compact-file-panel.png'), fullPage: true });
  if ((await page.viewportSize())!.width > 800) {
    await page.locator('.awu-sidebar').evaluate(node => {
      const element = node as HTMLElement;
      element.style.width = '420px'; element.style.minWidth = '420px'; element.style.maxWidth = '420px';
    });
    await expect.poll(() => panel.evaluate(node => node.clientWidth)).toBeGreaterThan(360);
    await page.screenshot({ path: testInfo.outputPath('wide-file-panel.png'), fullPage: true });
    await page.locator('.app-root').evaluate(node => {
      const element = node as HTMLElement;
      element.style.setProperty('--theme-bg', '#ffffff');
      element.style.setProperty('--theme-bg-secondary', '#f6f8fa');
      element.style.setProperty('--theme-bg-tertiary', '#eef1f4');
      element.style.setProperty('--theme-panel-solid', '#ffffff');
      element.style.setProperty('--theme-sidebar-solid', '#f6f8fa');
      element.style.setProperty('--theme-popover-bg', '#ffffff');
      element.style.setProperty('--theme-input-bg', '#ffffff');
      element.style.setProperty('--theme-text', '#1f2328');
      element.style.setProperty('--theme-text-muted', '#59636e');
      element.style.setProperty('--theme-border', '#d0d7de');
    });
    await page.screenshot({ path: testInfo.outputPath('light-wide-file-panel.png'), fullPage: true });
  }
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const sourceDirectory = panel.locator('.ftp-row').filter({ hasText: 'src' });
  await sourceDirectory.click();
  const child = panel.locator('.ftp-row').filter({ hasText: 'child.txt' });
  await expect(child).toBeVisible();
  const refresh = panel.getByRole('button', { name: '刷新文件目录' });
  await refresh.focus();
  await refresh.press('Enter');
  await expect(sourceDirectory).toHaveClass(/ftp-sel/);
  await expect(child).toBeVisible();
});

test('non-repository has no disabled Git toolbar or duplicate empty status', async ({ page }) => {
  const reads = { directory: 0, detect: 0, status: 0 };
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'gitDetect') { reads.detect++; return reply({ isRepo: false }); }
      if (frame.method === 'gitStatus') { reads.status++; return reply({ branch: '', files: [] }); }
      if (frame.method === 'listDirectory') { reads.directory++; return reply([{ name: 'README.md', path: 'README.md', isDir: false }]); }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  await expect(panel.locator('.ftp-row').filter({ hasText: 'README.md' })).toBeVisible();
  await expect(panel.locator('.ftp-git-toolbar')).toHaveCount(0);
  await expect(panel.locator('.ftp-git-summary')).toHaveCount(0);
  await expect(panel.getByText('此目录未启用 Git', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '刷新文件目录' }).click();
  await expect.poll(() => reads.directory).toBe(2);
  expect(reads).toEqual({ directory: 2, detect: 2, status: 0 });
});

test('delayed Git and directory errors do not move or erase the tree; feedback keeps multiple issues', async ({ page }, testInfo) => {
  let failDirectory = false;
  let statusReply: ((value: unknown) => void) | undefined;
  let workingDir = '';
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'gitDetect') return reply({ isRepo: true });
      if (frame.method === 'gitStatus') { statusReply = reply; return; }
      if (frame.method === 'listDirectory') {
        workingDir = frame.params[1];
        return failDirectory ? reply({ error: '模拟目录读取失败' }) : reply([{ name: 'kept.txt', path: 'kept.txt', isDir: false }]);
      }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  await expect(panel.locator('.ftp-row').filter({ hasText: 'kept.txt' })).toBeVisible();
  const top = await treeOffset(panel);
  statusReply?.({ error: '模拟 Git 状态失败' });
  await expect(panel.locator('.ftp-feedback')).toContainText('Git 状态同步失败');
  expect(await treeOffset(panel)).toBe(top);

  failDirectory = true;
  await panel.getByRole('button', { name: '刷新文件目录' }).click();
  await expect(panel.locator('.ftp-row').filter({ hasText: 'kept.txt' })).toBeVisible();
  await expect(panel.locator('.ftp-feedback')).toContainText('+1');
  expect(await treeOffset(panel)).toBe(top);

  await page.evaluate(async dir => {
    const { fileTransfers } = await import('/src/utils/fileTransfers.ts');
    const { getHomeExecKey } = await import('/src/api.ts');
    const key = JSON.stringify([getHomeExecKey(), dir]);
    const job = fileTransfers.start(key, 'fixture', 'push', 'kept.txt');
    if (!job) throw new Error('unexpected transfer');
    fileTransfers.progress(job, { ...job.progress, fileIndex: 1, fileCount: 2, totalBytes: 20, doneBytes: 10 });
  }, workingDir);
  await expect(panel.locator('.ftp-feedback')).toContainText('+2');
  const feedbackButton = panel.locator('.ftp-feedback').getByRole('button').first();
  await feedbackButton.focus();
  await feedbackButton.press('Enter');
  const details = page.getByRole('dialog', { name: '文件面板状态' });
  await expect(details).toContainText('模拟目录读取失败');
  await expect(details).toContainText('Git 状态同步失败');
  await expect(details).toContainText('上传 · kept.txt');
  await page.screenshot({ path: testInfo.outputPath('file-panel-feedback.png'), fullPage: true });
  await details.getByRole('button', { name: '取消传输' }).click();
});

test('opening compact tools is lazy, stash reads are coalesced and idle does not poll', async ({ page }, testInfo) => {
  await page.clock.install();
  const reads = { directory: 0, detect: 0, status: 0, stash: 0 };
  let finishStash: (() => void) | undefined;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'listDirectory') { reads.directory++; return reply([{ name: 'one.txt', path: 'one.txt', isDir: false }]); }
      if (frame.method === 'gitDetect') { reads.detect++; return reply({ isRepo: true }); }
      if (frame.method === 'gitStatus') { reads.status++; return reply({ branch: 'main', files: [] }); }
      if (frame.method === 'gitStashList') { reads.stash++; finishStash = () => reply({ stashes: [] }); return; }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  await expect(panel.locator('.ftp-git-summary')).toContainText('main');
  const baseline = { ...reads };
  await panel.getByRole('button', { name: '更多文件工具' }).click();
  const more = page.getByRole('dialog', { name: '更多文件工具' });
  await expect(more).toBeVisible();
  await more.getByRole('button', { name: '本机副本与同步' }).click();
  const sync = page.getByRole('dialog', { name: '本机副本与同步' });
  await expect(sync).toBeVisible();
  expect(reads).toEqual(baseline);
  await page.screenshot({ path: testInfo.outputPath('file-panel-sync-tool.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await panel.locator('.ftp-git-summary').click();
  const git = page.getByRole('dialog', { name: 'Git 工作区' });
  await expect(git).toBeVisible();
  expect(reads).toEqual(baseline);
  const stashToggle = git.getByRole('button', { name: /查看 Stash|收起 Stash/ });
  await stashToggle.click();
  await stashToggle.click();
  await stashToggle.click();
  await expect.poll(() => reads.stash).toBe(1);
  finishStash?.();
  await expect(git).toContainText('没有 Stash');
  await page.screenshot({ path: testInfo.outputPath('file-panel-git-tool.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.clock.fastForward(120_000);
  expect(reads).toEqual({ ...baseline, stash: 1 });
});

test('file search drops superseded and hidden late replies while preserving result budgets', async ({ page }) => {
  const pending: Array<{ query: string; reply: (value: unknown) => void }> = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'listDirectory') return reply([{ name: 'root.txt', path: 'root.txt', isDir: false }]);
      if (frame.method === 'gitDetect') return reply({ isRepo: false });
      if (frame.method === 'syncFileSearch') { pending.push({ query: frame.params[1], reply }); return; }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  const input = panel.getByRole('searchbox', { name: '搜索工作区文件' });
  await input.fill('alpha');
  await expect.poll(() => pending.length).toBe(1);
  await input.fill('beta');
  await expect.poll(() => pending.length).toBe(2);
  pending[0].reply({ status: 'ok', matched: 1, results: [{ path: 'alpha.txt', name: 'alpha.txt', size: 1 }] });
  await expect(panel.getByText('alpha.txt', { exact: true })).toHaveCount(0);
  pending[1].reply({ status: 'ok', matched: 3, truncated: true, results: [{ path: 'beta.txt', name: 'beta.txt', size: 1 }] });
  await expect(panel.getByText('beta.txt', { exact: true })).toBeVisible();
  await expect(panel.locator('.ftp-search')).toContainText('1/3');

  await input.fill('late');
  await expect.poll(() => pending.length).toBe(3);
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: 'Session 会话' }).click();
  pending[2].reply({ status: 'ok', matched: 1, results: [{ path: 'late.txt', name: 'late.txt', size: 1 }] });
  await expect(panel).toBeHidden();
  await page.getByRole('navigation', { name: '功能栏' })
    .getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true }).click();
  await expect(panel.getByText('late.txt', { exact: true })).toHaveCount(0);
});
