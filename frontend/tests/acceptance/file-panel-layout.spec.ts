import { test, expect, type Page, type Locator } from '@playwright/test';

const idleNotice = '目录按需读取，可手动刷新';

// Isolated QA sessions + held read-only RPC replies; never touch real workspace files.
async function openFiles(page: Page, beforeOpen?: () => Promise<void>): Promise<Locator> {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  if (await opener.isVisible()) await opener.click();
  await beforeOpen?.();
  await page.getByRole('navigation', { name: '功能栏' })
    .getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true }).click();
  const panel = page.locator('.ftp-panel');
  await expect(panel).toBeVisible();
  return panel;
}

const regions = '.ftp-hdr, .ftp-search, .ftp-local-identity, .ftp-local-actions, .ftp-status-slot, .ftp-git-toolbar, .ftp-tree-scroll';
async function geometry(panel: Locator) {
  return panel.locator(regions).evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
}
function unchanged(before: Awaited<ReturnType<typeof geometry>>, after: Awaited<ReturnType<typeof geometry>>) {
  expect(after).toHaveLength(before.length);
  before.forEach((rect, index) => {
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(rect[key] - after[index][key]), `region ${index} ${key}`).toBeLessThanOrEqual(1);
    }
  });
}

test('file panel reserves first-render slots through delayed local, directory, Git and stash responses', async ({ page }, testInfo) => {
  await page.clock.install();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { release = resolve; });
    Object.defineProperty(navigator.storage, 'persist', { value: () => pending });
    (window as any).__releaseLocalRestore = () => release(true);
  });
  let holdDirectories = true;
  let holdDetect = true;
  let holdStatus = true;
  let failDirectory = false;
  let failGit = false;
  let clean = false;
  let workingDir = '';
  const reads = { directory: 0, detect: 0, status: 0 };
  const directoryReplies: Array<() => void> = [];
  const detectReplies: Array<() => void> = [];
  const statusReplies: Array<() => void> = [];
  const stashReplies: Array<() => void> = [];
  const mutations: string[] = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listDirectory') {
        reads.directory++;
        workingDir = frame.params[1];
        const send = () => reply(failDirectory ? { error: '模拟目录读取失败' }
          : [{ name: 'README.md', path: 'README.md', isDir: false, mtime: 1_785_000_000_000 }]);
        if (holdDirectories) directoryReplies.push(send); else send();
        return;
      }
      if (frame.method === 'gitDetect') {
        reads.detect++;
        const send = () => reply({ isRepo: true, branch: 'feature/a-long-branch-name', ahead: 12, behind: 3 });
        if (holdDetect) detectReplies.push(send); else send();
        return;
      }
      if (frame.method === 'gitStatus') {
        reads.status++;
        const send = () => reply(failGit ? { error: '模拟 Git 同步失败' } : {
          branch: 'feature/a-long-branch-name', ahead: clean ? 0 : 12345, behind: clean ? 0 : 54321,
          files: clean ? [] : [{ path: 'README.md', staged: false, status: 'modified' }],
        });
        if (holdStatus) statusReplies.push(send); else send();
        return;
      }
      if (frame.method === 'gitStashList') {
        stashReplies.push(() => reply({ stashes: [{ hash: 'stash-test', message: '已有的测试暂存记录' }] }));
        return;
      }
      if (/^(git(Stage|Commit|Push|Pull|StashPush|StashPop|StashDrop)|sync(Write|Delete))/.test(frame.method)) {
        mutations.push(frame.method);
        return reply({ error: 'Layout tests must not mutate files or Git' });
      }
      server.send(message);
    });
  });
  const panel = await openFiles(page, async () => {
    await page.clock.fastForward(60_000);
    expect(reads).toEqual({ directory: 0, detect: 0, status: 0 });
    await page.evaluate(async () => {
      const modulePath = '/src/api.ts';
      const { api } = await import(modulePath);
      const original = api.onSessionConnectionStatus;
      api.onSessionConnectionStatus = (sessionId: string, callback: (online: boolean) => void) => {
        (window as any).__setFilePanelOnline = callback;
        return original(sessionId, callback);
      };
    });
  });
  const statusSlot = panel.locator('.ftp-status-slot');
  await expect(statusSlot).toHaveText(idleNotice);
  await expect.poll(() => detectReplies.length).toBeGreaterThan(0);
  await expect.poll(() => directoryReplies.length).toBeGreaterThan(0);
  expect(reads).toEqual({ directory: 1, detect: 1, status: 0 });
  await expect(panel.locator('.ftp-local-identity')).toContainText('同步中');
  await expect(panel.getByRole('status', { name: '目录同步中' })).toBeVisible();
  const git = panel.getByRole('region', { name: 'Git 工作区状态' });
  await expect(git).toContainText('Git 同步中');
  await expect(git.getByRole('button', { name: /提交/ })).toBeDisabled();
  const initial = await geometry(panel);
  expect(initial).toHaveLength(7);
  await page.screenshot({ path: testInfo.outputPath('file-panel-syncing.png'), fullPage: true });

  holdDetect = false;
  detectReplies.splice(0).forEach(reply => reply());
  await expect.poll(() => statusReplies.length).toBeGreaterThan(0);
  await expect(git).toContainText('Git 同步中');
  await expect(git).not.toContainText('工作区干净');
  unchanged(initial, await geometry(panel));

  holdDirectories = false;
  directoryReplies.splice(0).forEach(reply => reply());
  await expect(panel.locator('.ftp-row')).toContainText('README.md');
  unchanged(initial, await geometry(panel));
  await page.evaluate(async () => {
    const modulePath = '/src/utils/dirSync.ts';
    const { ManagedBrowserLocalFs } = await import(modulePath);
    const scan = ManagedBrowserLocalFs.prototype.scan;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (window as any).__metadataScanCount = 0;
    ManagedBrowserLocalFs.prototype.scan = async function (...args: unknown[]) {
      (window as any).__metadataScanCount++;
      await gate;
      return scan.apply(this, args);
    };
    (window as any).__releaseMetadataScan = () => {
      release();
    };
  });
  await page.evaluate(() => (window as any).__releaseLocalRestore());
  await expect(panel.locator('.ftp-local-identity')).toContainText('离线空间');
  await expect(statusSlot).toHaveText(idleNotice);
  unchanged(initial, await geometry(panel));
  await page.evaluate(() => (window as any).__releaseMetadataScan());
  await expect(statusSlot).toHaveText(idleNotice);
  await expect(panel.locator('.ftp-local-actions')).toHaveAttribute('aria-busy', 'false');
  unchanged(initial, await geometry(panel));

  holdStatus = false;
  statusReplies.splice(0).forEach(reply => reply());
  await expect(git).toContainText('1 未暂存');
  await expect(git.getByRole('button', { name: /提交/ })).toBeEnabled();
  unchanged(initial, await geometry(panel));

  // Idle panels make no periodic reads. Even reconnects must preserve the existing list.
  await statusSlot.evaluate(node => {
    (window as any).__noticeChanges = [];
    new MutationObserver(() => (window as any).__noticeChanges.push(node.textContent))
      .observe(node, { childList: true, subtree: true, characterData: true });
  });
  for (const online of [false, true]) {
    await page.evaluate(online => (window as any).__setFilePanelOnline(online), online);
    await page.clock.fastForward(60_000);
    expect(reads).toEqual({ directory: 1, detect: 1, status: 1 });
    await expect(git).toHaveAttribute('aria-busy', 'false');
    await expect(statusSlot).toHaveText(idleNotice);
    await expect(panel.locator('.ftp-row')).toContainText('README.md');
    unchanged(initial, await geometry(panel));
  }
  expect(await page.evaluate(() => (window as any).__noticeChanges)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__metadataScanCount)).toBe(1);

  // Publish synthetic progress only: no upload/download or filesystem RPC is executed.
  await page.evaluate(async workingDir => {
    const transferModule = '/src/utils/fileTransfers.ts';
    const apiModule = '/src/api.ts';
    const { fileTransfers } = await import(transferModule);
    const { getHomeExecKey } = await import(apiModule);
    const job = fileTransfers.start(JSON.stringify([getHomeExecKey(), workingDir]), 'layout-test', 'push', 'long/path/README.md');
    if (!job) throw new Error('Unexpected existing test transfer');
    fileTransfers.progress(job, { ...job.progress, fileIndex: 1, fileCount: 10, fileBytes: 1024 * 1024,
      fileSize: 4 * 1024 * 1024, doneBytes: 1024 * 1024, totalBytes: 40 * 1024 * 1024,
      activeCount: 3, startedAt: Date.now() - 10_000 });
    (window as any).__finishTestTransfer = () => fileTransfers.finish(job, '测试进度已结束');
  }, workingDir);
  await expect(statusSlot).toContainText('上传');
  const slotBox = (await statusSlot.boundingBox())!;
  const cancelBox = (await statusSlot.getByRole('button', { name: '取消', exact: true }).boundingBox())!;
  expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(slotBox.x + slotBox.width + 1);
  expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(slotBox.y + slotBox.height + 1);
  unchanged(initial, await geometry(panel));
  await page.screenshot({ path: testInfo.outputPath('file-panel-transfer.png'), fullPage: true });
  await page.evaluate(() => (window as any).__finishTestTransfer());
  await expect(statusSlot).toHaveText(idleNotice);
  await page.clock.fastForward(60_000);
  expect(reads).toEqual({ directory: 1, detect: 1, status: 1 });
  expect(await page.evaluate(() => (window as any).__metadataScanCount)).toBe(1);
  unchanged(initial, await geometry(panel));

  // Refresh never blanks the existing list. Error and recovery use the same slot.
  holdDirectories = true; holdStatus = true;
  await panel.locator('.ftp-hdr').hover();
  await panel.getByTitle('刷新本机与远端目录', { exact: true }).click();
  await expect.poll(() => directoryReplies.length).toBeGreaterThan(0);
  await expect.poll(() => statusReplies.length).toBeGreaterThan(0);
  await panel.getByTitle('刷新本机与远端目录', { exact: true }).click();
  expect(reads).toEqual({ directory: 2, detect: 2, status: 2 });
  expect(await page.evaluate(() => (window as any).__metadataScanCount)).toBe(2);
  await expect(panel.locator('.ftp-row')).toContainText('README.md');
  await expect(panel.getByRole('status', { name: '目录同步中' })).toHaveCount(0);
  await expect(statusSlot).toHaveText(idleNotice);
  unchanged(initial, await geometry(panel));
  failDirectory = true; failGit = true;
  holdDirectories = false; holdStatus = false;
  directoryReplies.splice(0).forEach(reply => reply());
  statusReplies.splice(0).forEach(reply => reply());
  await expect(panel.locator('.ftp-status-slot')).toContainText('目录读取失败');
  await expect(git.getByRole('button', { name: /提交/ })).toBeDisabled();
  await expect(panel.locator('.ftp-row')).toContainText('README.md');
  unchanged(initial, await geometry(panel));
  failDirectory = false; failGit = false; clean = true;
  await panel.getByTitle('刷新本机与远端目录', { exact: true }).click();
  await expect(git).toContainText('工作区干净');
  await expect(panel.locator('.ftp-status-slot')).not.toContainText('目录读取失败');
  await expect(git.getByRole('button', { name: /暂存/ })).toBeDisabled();
  unchanged(initial, await geometry(panel));

  // Expanding is explicit user intent; the subsequent async response must not move the tree.
  await panel.getByTitle('查看 Stash 列表', { exact: true }).click();
  await expect(panel.locator('.ftp-stash-list')).toContainText('Stash 同步中');
  const expanded = await geometry(panel);
  stashReplies.splice(0).forEach(reply => reply());
  await expect(panel.locator('.ftp-stash-list')).toContainText('已有的测试暂存记录');
  unchanged(expanded, await geometry(panel));
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('file-panel-synced.png'), fullPage: true });
  // Switching away and collapsing the sidebar both unmount the reader, not the transfer job.
  const settledReads = { ...reads };
  const settledScans = await page.evaluate(() => (window as any).__metadataScanCount);
  await page.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: 'Session 会话', exact: true }).click();
  await expect(page.locator('.ftp-panel')).toHaveCount(0);
  await page.clock.fastForward(60_000);
  expect(reads).toEqual(settledReads);
  expect(await page.evaluate(() => (window as any).__metadataScanCount)).toBe(settledScans);
  await page.getByTitle('收起侧栏', { exact: true }).click();
  await page.clock.fastForward(60_000);
  expect(reads).toEqual(settledReads);
});

test('non-Git and initial failure retain reserved controls and do not masquerade as an empty directory', async ({ page }) => {
  await page.clock.install();
  let release = false;
  let recover = false;
  let holdDetect = false;
  const detectReplies: Array<() => void> = [];
  const replies: Array<() => void> = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'gitDetect' || frame.method === 'listDirectory') {
        const send = () => reply(frame.method === 'gitDetect' ? { isRepo: false }
          : recover ? [] : { error: '不可读取测试目录' });
        if (frame.method === 'gitDetect' && holdDetect) { detectReplies.push(send); return; }
        if (release) send(); else replies.push(send);
        return;
      }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  await expect(panel.locator('.ftp-status-slot')).toHaveText(idleNotice);
  await expect(panel.getByRole('status', { name: '目录同步中' })).toBeVisible();
  const initial = await geometry(panel);
  await expect.poll(() => replies.length).toBeGreaterThanOrEqual(2);
  release = true;
  replies.splice(0).forEach(reply => reply());
  await expect(panel.locator('.ftp-git-toolbar')).toContainText('此目录未启用 Git');
  await expect(panel.locator('.ftp-tree-scroll')).toContainText('目录同步失败');
  await expect(panel.locator('.ftp-tree-scroll')).not.toContainText('空目录');
  unchanged(initial, await geometry(panel));
  recover = true;
  await panel.locator('.ftp-hdr').hover();
  await panel.getByTitle('刷新本机与远端目录', { exact: true }).click();
  await expect(panel.locator('.ftp-tree-scroll')).toContainText('空目录');
  await expect(panel.locator('.ftp-status-slot')).toHaveText(idleNotice);
  await expect(panel.locator('.ftp-git-toolbar')).toHaveAttribute('aria-busy', 'false');
  holdDetect = true;
  await page.clock.fastForward(60_000);
  expect(detectReplies).toHaveLength(0);
  // A manual refresh still detects a repository created since the last read.
  await panel.getByTitle('刷新本机与远端目录', { exact: true }).click();
  await expect.poll(() => detectReplies.length).toBeGreaterThan(0);
  await expect(panel.locator('.ftp-hdr')).toContainText('无 Git');
  await expect(panel.locator('.ftp-git-toolbar')).toContainText('此目录未启用 Git');
  await expect(panel.locator('.ftp-git-toolbar')).not.toContainText('同步中');
  await expect(panel.locator('.ftp-status-slot')).toHaveText(idleNotice);
  holdDetect = false;
  detectReplies.splice(0).forEach(reply => reply());
  unchanged(initial, await geometry(panel));
});

test('manual refresh skips collapsed subtrees; user Git actions refresh once without polling', async ({ page }) => {
  await page.clock.install();
  const directoryReads: string[] = [];
  let gitReads = 0;
  let staged = false;
  let stageCalls = 0;
  let holdSrc = true;
  const srcReplies: Array<() => void> = [];
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listDirectory') {
        const rel = frame.params[0] as string;
        directoryReads.push(rel);
        const entries = rel === '' ? [['src', true], ['docs', true]]
          : rel === 'src' ? [['deep', true]] : [['example.md', false]];
        const send = () => reply(entries.map(([name, isDir]) => ({
          name, isDir, path: rel ? `${rel}/${name}` : name, mtime: 1_785_000_000_000,
        })));
        if (rel === 'src' && holdSrc) srcReplies.push(send); else send();
        return;
      }
      if (frame.method === 'gitDetect') return reply({ isRepo: true, branch: 'test' });
      if (frame.method === 'gitStatus') {
        gitReads++;
        return reply({ branch: 'test', files: [{ path: 'src/deep/example.md', status: 'modified', staged }] });
      }
      // Synthetic mutation receipt only; nothing is forwarded to the executor's Git.
      if (frame.method === 'gitStage') { staged = true; stageCalls++; return reply({ status: 'ok' }); }
      server.send(message);
    });
  });
  const panel = await openFiles(page);
  const row = (name: string) => panel.locator('.ftp-row').filter({ has: page.getByText(name, { exact: true }) });
  await expect(row('src')).toBeVisible();
  await expect(panel.locator('.ftp-git-toolbar')).toContainText('1 未暂存');
  await row('src').click();
  await expect.poll(() => srcReplies.length).toBe(1);
  await row('src').click();
  await row('src').click();
  expect(directoryReads.filter(rel => rel === 'src')).toHaveLength(1);
  holdSrc = false;
  srcReplies.splice(0).forEach(reply => reply());
  await expect(row('deep')).toBeVisible();
  await row('deep').click();
  await expect(row('example.md')).toBeVisible();
  await row('src').click(); // deep remains logically expanded under a closed parent
  await row('docs').click();
  await expect(row('example.md')).toBeVisible();

  const beforeRefresh = directoryReads.length;
  await panel.locator('.ftp-hdr').hover();
  await panel.getByTitle('刷新本机与远端目录', { exact: true }).click();
  await expect.poll(() => directoryReads.length).toBe(beforeRefresh + 2);
  expect(directoryReads.slice(beforeRefresh).sort()).toEqual(['', 'docs']);
  await expect.poll(() => gitReads).toBe(2);
  await row('docs').click();
  await row('src').click();
  await expect(row('deep')).toBeVisible();
  await expect(row('example.md')).toHaveCount(0);
  await row('deep').click();
  await expect(row('example.md')).toBeVisible();
  expect(directoryReads.filter(rel => rel === 'src')).toHaveLength(2);
  expect(directoryReads.filter(rel => rel === 'src/deep')).toHaveLength(2);

  await panel.getByTitle('暂存所有变更', { exact: true }).click();
  await expect(panel.locator('.ftp-git-toolbar')).toContainText('1 已暂存');
  expect(stageCalls).toBe(1);
  expect(gitReads).toBe(3);
  const settledReads = [...directoryReads];
  await page.clock.fastForward(60_000);
  expect(gitReads).toBe(3);
  expect(directoryReads).toEqual(settledReads);
  await page.getByTitle('收起侧栏', { exact: true }).click();
  await expect(page.locator('.ftp-panel')).toHaveCount(0);
  await page.clock.fastForward(60_000);
  expect(gitReads).toBe(3);
  expect(directoryReads).toEqual(settledReads);
});
