import { test, expect, type Page } from '@playwright/test';

async function mountFiles(page: Page, local = false, reload = false, engine = false) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root" style="height:900px"></div>
      <script type="module">import R from '/@react-refresh'; R.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;</script>` });
    return route.continue();
  });
  if (reload) await page.reload(); else await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async ({ local, engine }) => {
    const { React, createRoot } = await import('/tests/engine/react-harness.ts');
    const { api, getCurrentUserProfile } = await import('/src/api.ts');
    const { WorkspaceDocuments } = await import('/src/utils/workspaceDocuments.ts');
    const { byteHash } = await import('/src/utils/documentCodec.ts');
    const { useManagedLocalDir } = await import('/src/utils/dirSync.ts');
    const { FileTreePanel } = await import('/src/components/FileTreePanel.tsx');
    const files: Record<string, string> = { 'a.py': 'old a', 'b.java': 'old b', 'large.txt': 'x'.repeat(220_000), 'binary.txt': 'preview' };
    if (engine) Object.assign(files, { 'view.vue': '<template><h1>Vue</h1></template>', 'app.tsx': 'export const App = () => <div />;',
      'readme.md': '# Original markdown', 'page.html': '<h1>Static</h1><script>document.querySelector("h1").textContent="Script ran"</script>',
      'tiny.png': atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==') });
    const generations: Record<string, number> = {};
    const workspace = { ownerId: getCurrentUserProfile().userId, executorInstance: 'isolated-executor',
      sessionId: 'test-session', workingDir: '/test-workspace', workspaceRevision: 'a'.repeat(64) };
    const version = (rel: string) => ({ exists: true, sha256: byteHash(new TextEncoder().encode(files[rel])),
      byteLength: files[rel].length, fileId: rel, modifiedNs: String(generations[rel] || 1), changedNs: String(generations[rel] || 1) });
    const read = (rel: string) => ({ status: 'ok', document: { workspace, relativePath: rel, canonicalPath: '/test-workspace/' + rel, source: 'executor' },
      version: version(rel), complete: true, byteLength: files[rel].length, readByteLength: files[rel].length,
      encoding: 'utf-8', bom: '', eol: 'none', text: files[rel], controlRevision: 0,
      editable: rel !== 'binary.txt', canSave: rel !== 'binary.txt', reasonCode: rel === 'binary.txt' ? 'binary' : '', writeReasonCode: '' });
    const calls: string[] = []; const saves: any[] = [];
    (window as any).fixture = { calls, saves, files, finish: null, old: false, immediate: false };
    api.onSessionConnectionStatus = (_session: string, callback: (value: boolean) => void) => { callback(true); return () => {}; };
    api.listDirectory = async () => local ? [] : Object.keys(files).map(name => ({ name, path: name, isDir: false }));
    api.gitDetect = async () => ({ isRepo: false });
    api.syncReadFile = async (_dir: string, rel: string) => { calls.push('preview'); return { status: 'ok', data: btoa(files[rel]) }; };
    api.syncFileStat = async (_dir: string, rel: string) => ({ status: 'ok', size: files[rel].length });
    api.syncReadChunk = async (_dir: string, rel: string) => ({ status: 'ok', data: btoa(files[rel]), read: files[rel].length });
    api.syncWriteFile = async () => { throw new Error('UNSAFE SAVE CALLED'); };
    api.workspaceDocuments = async (session: string, executor: string, workingDir: string, current: () => boolean) => {
      return WorkspaceDocuments.connect({ user: workspace.ownerId, executor, session, workingDir }, async (_executor, method, params) => {
        calls.push(method);
        if (method === 'sessionWorkbenchCapabilities') return (window as any).fixture.old ? null
          : { status: 'ok', protocolVersion: 1, identity: workspace,
            capabilities: { viewMode: 1, documents: 1, windowHandoff: 0, terminal: 0, languageServices: 0 } };
        if (method === 'workspaceDocumentRead') return read(params[2] as string);
        if (method === 'workspaceSearchCancel') { (window as any).fixture.cancelled = params[2]; return { status: 'ok' }; }
        if (method === 'workspaceSearch') {
          const result = { status: 'ok', requestId: params[2], workspace, truncated: false,
            results: [{ relativePath: 'a.py', ...(params[3] === 'content' ? { line: 2, column: 3, preview: 'target' } : {}) }] };
          if ((window as any).fixture.holdSearch) return new Promise(resolve => { (window as any).fixture.finishSearch = () => resolve(result); });
          return result;
        }
        if (method === 'workspaceGitComparison') return { status: 'ok', requestId: params[2], workspace, relativePath: params[3],
          baseline: { source: 'git-head', text: 'committed baseline' }, disk: { source: 'disk', text: files[params[3] as string], version: version(params[3] as string) } };
        if (method === 'workspaceDocumentSave') {
          const request = JSON.parse(params[2] as string); saves.push(request);
          if (JSON.stringify(request.baseVersion) !== JSON.stringify(version(request.relativePath))) return {
            status: 'failed', reasonCode: 'disk_conflict', requestId: request.requestId, workspace,
            relativePath: request.relativePath, bufferRevision: request.bufferRevision };
          return new Promise(resolve => { (window as any).fixture.finish = () => {
            files[request.relativePath] = request.text; generations[request.relativePath] = (generations[request.relativePath] || 1) + 1;
            resolve({ status: 'succeeded', requestId: request.requestId, relativePath: request.relativePath,
              bufferRevision: request.bufferRevision, workspace, version: version(request.relativePath), document: read(request.relativePath).document });
          }; if ((window as any).fixture.immediate) (window as any).fixture.finish(); });
        }
        throw new Error('Unexpected RPC ' + method);
      }, current);
    };
    if (local) {
      const fs = await useManagedLocalDir('test-session');
      await fs.writeBlob!('local.py', new Blob(['old local\r\n']));
      (window as any).fixture.fs = fs;
    }
    const host = document.getElementById('root')!;
    const tree = document.createElement('div'), documentHost = document.createElement('div');
    if (engine) {
      host.style.display = 'grid'; host.style.gridTemplateColumns = '260px minmax(0, 1fr)';
      documentHost.id = 'document-host'; documentHost.style.cssText = 'display:flex;flex-direction:column;min-width:0;min-height:0';
      host.append(tree, documentHost);
    }
    const root = createRoot(engine ? tree : host);
    // 本机执行端编辑能力使用桌面判定，所有 I/O 仍由上面的隔离协议替身处理。
    // 浏览器/Relay 的真实下载后本机编辑另在 acceptance 验证。
    if (!local) (window as any).__TAURI_INTERNALS__ = {};
    const render = (focusRequest?: any) => root.render(React.createElement(FileTreePanel, { sessionId: 'test-session', workingDir: '/test-workspace', execKey: 'fake-node', execMode: local ? 'relay' : 'local',
      documentHost: engine ? documentHost : undefined, focusRequest }));
    (window as any).fixture.focus = (relativePath: string, line?: number, column?: number) => render({ requestId: Date.now(), sessionId: 'test-session', workingDir: '/test-workspace', relativePath, line, column });
    render();
  }, { local, engine });
  await expect(page.locator('.ftp-panel')).toBeVisible();
}

async function edit(page: Page, filename: string) {
  await page.locator('.ftp-row').filter({ has: page.getByText(filename, { exact: true }) }).dblclick();
  await page.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  return page.locator('.cm-content');
}

test('Engine unified navigation retains line/column, offers keyboard search/replace and read-only Git diff', async ({ page }) => {
  await mountFiles(page, false, false, true);
  await page.evaluate(() => { const f = (window as any).fixture; f.files['a.py'] = 'first\nxy target\nlast'; f.focus('a.py', 2, 3); });
  const editor = page.locator('.cm-content'); await expect(editor).toContainText('xy target');
  await expect.poll(() => page.evaluate(async () => {
    const { documentStore } = await import('/src/utils/documentStore.ts');
    return (documentStore.all().find(d => d.identity.relativePath === 'a.py')?.editor as any)?.state.selection.main.head;
  })).toBe(8);
  await page.getByRole('button', { name: '编辑导航', exact: true }).click();
  await page.getByRole('button', { name: '查找 / 替换', exact: true }).click();
  const search = page.locator('.cm-search input[name="search"]');
  await expect(search).toBeFocused(); await search.fill('target');
  await page.locator('.cm-search input[name="replace"]').fill('new draft');
  await page.locator('.cm-search button[name="replaceAll"]').click();
  await expect(editor).toContainText('new draft');
  await page.getByRole('button', { name: 'Git 差异（只读）' }).click();
  const query = page.getByRole('region', { name: '工程文件查询' });
  await expect(query.getByLabel('Git HEAD', { exact: true })).toHaveValue('committed baseline');
  await expect(query.getByLabel('当前磁盘', { exact: true })).toHaveValue('first\nxy target\nlast');
  await expect(query.getByLabel('当前草稿', { exact: true })).toHaveValue('first\nxy new draft\nlast');
  await query.getByRole('button', { name: '关闭查询' }).click();
  await editor.focus(); await page.keyboard.press('Control+p');
  await expect(page.getByLabel('文件名查询')).toBeFocused();
  await page.getByLabel('文件名查询').fill('a'); await page.getByLabel('文件名查询').press('Enter');
  await query.getByRole('button', { name: 'a.py', exact: true }).click();
  await expect(editor).toContainText('new draft');
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
  await page.getByRole('button', { name: '编辑导航', exact: true }).click();
  await page.getByRole('button', { name: '跳到行', exact: true }).click();
  const lineInput = page.getByRole('textbox', { name: 'Go to line:' });
  await expect(lineInput).toBeFocused();
  await lineInput.fill('3'); await lineInput.press('Enter');
  await expect.poll(() => page.evaluate(async () => {
    const { documentStore } = await import('/src/utils/documentStore.ts');
    const state = (documentStore.all().find(d => d.identity.relativePath === 'a.py')?.editor as any)?.state;
    return state.doc.lineAt(state.selection.main.head).number;
  })).toBe(3);
  await page.evaluate(() => { (window as any).fixture.immediate = true; });
  await editor.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.saves.length)).toBe(1);
  await expect(editor).toContainText('new draft');
});

test('Engine cancelled or hidden search ignores late results; content result goes to its exact position', async ({ page }) => {
  await mountFiles(page, false, false, true);
  await page.evaluate(() => { const f = (window as any).fixture; f.files['a.py'] = 'first\nxy target'; f.holdSearch = true; });
  await page.getByRole('button', { name: '项目搜索', exact: true }).click();
  await page.getByLabel('项目内容查询').fill('target'); await page.getByLabel('项目内容查询').press('Enter');
  await page.waitForFunction(() => (window as any).fixture.finishSearch);
  await page.getByRole('button', { name: '取消查询', exact: true }).click();
  await page.evaluate(() => (window as any).fixture.finishSearch());
  await expect(page.getByRole('list', { name: '查询结果' }).locator('li')).toHaveCount(0);
  expect(await page.evaluate(() => !!(window as any).fixture.cancelled)).toBe(true);
  await page.evaluate(() => { (window as any).fixture.holdSearch = false; });
  await page.getByLabel('项目内容查询').press('Enter');
  await page.getByRole('button', { name: 'a.py:2:3 · target', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('xy target');
  await expect.poll(() => page.evaluate(async () => {
    const { documentStore } = await import('/src/utils/documentStore.ts');
    return (documentStore.all().find(d => d.identity.relativePath === 'a.py')?.editor as any)?.state.selection.main.head;
  })).toBe(8);
});

test('two-window file state transfer verifies bounded journal, tabs, dirty text and undo without a save', async ({ page, context }) => {
  await mountFiles(page, false, false, true);
  await page.locator('.ftp-row').filter({ hasText: 'a.py' }).dblclick();
  await page.locator('.cm-content').fill('first draft');
  await page.locator('.cm-content').press('End'); await page.locator('.cm-content').press('!');
  await page.locator('.ftp-row').filter({ hasText: 'b.java' }).dblclick();
  await page.locator('.cm-content').fill('java draft');
  await page.evaluate(async () => {
    const { handoffParticipants, handoffScope, handoffEnvelope, handoffJournal } = await import('/src/utils/workbenchHandoffState.ts');
    const { getCurrentUserProfile } = await import('/src/api.ts');
    const owner = getCurrentUserProfile().userId;
    const parts = await handoffParticipants.capture(handoffScope(owner, 'fake-node', 'test-session', '/test-workspace'));
    const workspace = { ownerId: owner, executorInstance: 'isolated-executor', sessionId: 'test-session', workingDir: '/test-workspace', workspaceRevision: 'a'.repeat(64) };
    const envelope = handoffEnvelope({ format: 1, workspace, clientId: 'client', sourceWindow: 'source', targetWindow: 'target', requestId: 'test-op', version: 1, parts });
    await handoffJournal.put(envelope);
  });
  const target = await context.newPage(); await mountFiles(target, false, false, true);
  await target.evaluate(async () => {
    const { handoffParticipants, handoffScope, readHandoffEnvelope, handoffJournal } = await import('/src/utils/workbenchHandoffState.ts');
    const { getCurrentUserProfile } = await import('/src/api.ts');
    const owner = getCurrentUserProfile().userId;
    const workspace = { ownerId: owner, executorInstance: 'isolated-executor', sessionId: 'test-session', workingDir: '/test-workspace', workspaceRevision: 'a'.repeat(64) };
    const record = await handoffJournal.get(workspace, 'client', 'test-op');
    const envelope = readHandoffEnvelope(record!.payload, workspace, 'client', 'target', record!.digest);
    await handoffParticipants.restore(handoffScope(owner, 'fake-node', 'test-session', '/test-workspace'), envelope.state.parts, () => true);
    if ((await handoffJournal.list('another-user')).length) throw Error('foreign records leaked');
  });
  await expect(target.locator('.cm-content')).toHaveText('java draft');
  await expect(target.getByRole('tab')).toHaveCount(2);
  await target.getByRole('tab', { name: /a.py/ }).click();
  await expect(target.locator('.cm-content')).toHaveText('first draft!');
  await target.locator('.cm-content').press('Control+z');
  await expect(target.locator('.cm-content')).toHaveText('first draft');
  expect(await target.evaluate(() => (window as any).fixture.saves)).toEqual([]);
  await target.close();
});

test('Chat editor retains edits during save and restores per-file undo history', async ({ page }) => {
  await mountFiles(page);
  const editor = await edit(page, 'a.py'); await expect(editor).toHaveText('old a');
  await editor.fill('draft a'); await page.getByRole('button', { name: '💾 保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.saves.length)).toBe(1);
  await editor.fill('newer a');
  await page.evaluate(() => (window as any).fixture.finish());
  await expect(editor).toHaveText('newer a');
  await expect(page.getByRole('button', { name: '💾 保存', exact: true })).toBeEnabled();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await edit(page, 'b.java'); await expect(editor).toHaveText('old b'); await editor.fill('draft b');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await edit(page, 'a.py'); await expect(editor).toHaveText('newer a');
  await editor.press('Control+z'); await expect(editor).toHaveText('draft a');
  expect(await page.evaluate(() => (window as any).fixture.files['a.py'])).toBe('draft a');
});

test('preview truncation is never used as a save baseline; readonly and old nodes cannot write', async ({ page }) => {
  await mountFiles(page);
  await edit(page, 'large.txt');
  await expect.poll(() => page.evaluate(async () => {
    const { documentStore } = await import('/src/utils/documentStore.ts');
    return documentStore.all().find(doc => doc.identity.relativePath === 'large.txt')?.text.length;
  })).toBe(220_000);
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await edit(page, 'binary.txt');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: '💾 保存', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.evaluate(() => { (window as any).fixture.old = true; });
  await edit(page, 'b.java');
  await expect(page.locator('.cm-content')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
});

test('Chat edits managed local copies without uploading or calling executor save', async ({ page }) => {
  await mountFiles(page, true);
  const editor = await edit(page, 'local.py'); await expect(editor).toHaveText('old local');
  await editor.fill('local draft'); await page.getByRole('button', { name: '💾 保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '💾 保存', exact: true })).toBeDisabled();
  expect(await page.evaluate(async () => (await (window as any).fixture.fs.readBlob('local.py')).text())).toBe('local draft');
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  await expect(editor).toHaveText('local draft');
});

test('save all lists partial conflicts and merge needs explicit application before save', async ({ page }) => {
  await mountFiles(page);
  page.on('dialog', dialog => dialog.accept());
  const editor = await edit(page, 'a.py'); await editor.fill('draft a');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await edit(page, 'b.java'); await editor.fill('draft b');
  await page.evaluate(() => { (window as any).fixture.files['b.java'] = 'agent edit'; (window as any).fixture.immediate = true; });
  await page.getByRole('button', { name: '保存此来源全部', exact: true }).click();
  await expect(page.getByText('a.py：已保存', { exact: true })).toBeVisible();
  await expect(page.getByText('b.java：disk_conflict', { exact: true })).toBeVisible();
  await expect(editor).toHaveText('draft b');
  await page.getByRole('button', { name: '比较 / 合并', exact: true }).click();
  const comparison = page.getByRole('region', { name: '基线磁盘草稿比较' });
  await expect(comparison.getByLabel('原基线', { exact: true })).toHaveValue('old b');
  await expect(comparison.getByLabel('磁盘版本', { exact: true })).toHaveValue('agent edit');
  await comparison.getByLabel('合并结果（仅修改草稿，不自动保存）').fill('discarded merge');
  await comparison.getByRole('button', { name: '取消合并' }).click();
  await expect(editor).toHaveText('draft b');
  await page.getByRole('button', { name: '比较 / 合并', exact: true }).click();
  await comparison.getByLabel('合并结果（仅修改草稿，不自动保存）').fill('combined');
  await comparison.getByRole('button', { name: '采用合并并更新基线' }).click();
  await expect(editor).toHaveText('combined');
  expect(await page.evaluate(() => (window as any).fixture.files['b.java'])).toBe('agent edit');
  await page.getByRole('button', { name: '💾 保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '💾 保存', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).fixture.files['b.java'])).toBe('combined');
});

test('refresh restores persisted draft/history without saving; explicit discard clears the local branch', async ({ page }) => {
  await mountFiles(page);
  const editor = await edit(page, 'a.py'); await editor.fill('persistent draft');
  await expect(page.getByRole('status').filter({ hasText: '草稿已存本设备' })).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await mountFiles(page, false, true);
  await edit(page, 'a.py'); await expect(editor).toHaveText('persistent draft');
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
  expect(await page.evaluate(() => (window as any).fixture.files['a.py'])).toBe('old a');
  await editor.press('Control+z'); await expect(editor).toHaveText('old a');
  // CodeMirror uses Mod-Y for redo on Windows (Mod-Shift-Z is macOS).
  await editor.press('Control+y'); await expect(editor).toHaveText('persistent draft');
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await expect(editor).toHaveText('old a');
  await editor.press('Control+z'); await expect(editor).toHaveText('old a');
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
});

test('quota failure exposes warning and draft export, without pretending recovery or saving the file', async ({ page }) => {
  await mountFiles(page);
  await page.evaluate(async () => {
    const { IndexedDraftRepository } = await import('/src/utils/documentDrafts.ts');
    IndexedDraftRepository.prototype.put = async () => { throw new DOMException('test quota', 'QuotaExceededError'); };
    (window as any).showSaveFilePicker = async options => ({ name: options.suggestedName, createWritable: async () => ({
      write: async blob => { (window as any).exported = { text: await blob.text(), options }; }, close: async () => {},
    }) });
  });
  const editor = await edit(page, 'a.py'); await editor.fill('important draft');
  await expect(page.getByRole('status').filter({ hasText: '草稿持久化不可用' })).toBeVisible();
  // 编辑的执行端为隔离本机模拟；导出单独走此测试安装的浏览器文件选择器。
  await page.evaluate(() => { delete (window as any).__TAURI_INTERNALS__; });
  await page.getByRole('button', { name: '导出草稿', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).exported?.text)).toBe('important draft');
  expect(await page.evaluate(() => (window as any).exported.options.suggestedName)).toBe('a.py.draft.txt');
  expect(await page.evaluate(() => (window as any).fixture.files['a.py'])).toBe('old a');
});

test('abrupt page close retains a recoverable branch; offline draft view exports and cleans without RPC', async ({ page, context }) => {
  await mountFiles(page);
  const editor = await edit(page, 'a.py'); await editor.fill('recover after crash');
  await expect(page.getByRole('status').filter({ hasText: '草稿已存本设备' })).toBeVisible();
  // 默认不运行 beforeunload：模拟没有退出处理机会的页面销毁。
  await page.close();
  const next = await context.newPage(); await mountFiles(next);
  await next.evaluate(() => {
    (window as any).fixture.old = true;
    (window as any).showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async blob => { (window as any).exported = await blob.text(); }, close: async () => {},
    }) });
  });
  await next.locator('.ftp-hdr').hover(); await next.getByRole('button', { name: '本设备草稿', exact: true }).click();
  const recovery = next.getByRole('dialog', { name: '本设备草稿恢复' });
  await recovery.getByRole('button', { name: '只读恢复草稿' }).click();
  await expect(recovery.getByLabel('离线恢复的草稿（只读）')).toHaveValue('recover after crash');
  await next.evaluate(() => { delete (window as any).__TAURI_INTERNALS__; });
  await recovery.getByRole('button', { name: '导出恢复草稿' }).click();
  await expect.poll(() => next.evaluate(() => (window as any).exported)).toBe('recover after crash');
  expect(await next.evaluate(() => (window as any).fixture.calls)).toEqual([]);
  next.on('dialog', dialog => dialog.accept());
  await recovery.getByRole('button', { name: '删除此草稿记录' }).click();
  await expect(recovery.getByText('本设备没有此账号的持久草稿。')).toBeVisible();
  expect(await next.evaluate(() => (window as any).fixture.saves)).toEqual([]);
});

test('storage disabled preserves editable memory and beforeunload protection', async ({ page }) => {
  await mountFiles(page);
  await page.evaluate(async () => {
    const { IndexedDraftRepository } = await import('/src/utils/documentDrafts.ts');
    for (const method of ['list', 'put', 'remove']) IndexedDraftRepository.prototype[method] = async () => { throw new DOMException('disabled', 'SecurityError'); };
  });
  const editor = await edit(page, 'a.py'); await editor.fill('only in memory');
  await expect(page.getByRole('status').filter({ hasText: '草稿持久化不可用' })).toBeVisible();
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await expect(editor).toHaveText('only in memory');
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
});

test('account switch removes old editor and recovery content; late inventory cannot leak it', async ({ page }) => {
  await mountFiles(page);
  const editor = await edit(page, 'a.py'); await editor.fill('private old-user draft');
  await expect(page.getByRole('status').filter({ hasText: '草稿已存本设备' })).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.locator('.ftp-hdr').hover(); await page.getByRole('button', { name: '本设备草稿', exact: true }).click();
  const recovery = page.getByRole('dialog', { name: '本设备草稿恢复' });
  await recovery.getByRole('button', { name: '只读恢复草稿' }).click();
  await expect(recovery.getByLabel('离线恢复的草稿（只读）')).toHaveValue('private old-user draft');
  await page.evaluate(async () => {
    const { IndexedDraftRepository } = await import('/src/utils/documentDrafts.ts');
    const original = IndexedDraftRepository.prototype.listOwner;
    IndexedDraftRepository.prototype.listOwner = async function(owner) {
      const result = await original.call(this, owner);
      if (owner === 'local') await new Promise(resolve => { (window as any).releaseInventory = resolve; });
      return result;
    };
  });
  await recovery.getByRole('button', { name: '刷新草稿列表' }).click();
  await page.waitForFunction(() => !!(window as any).releaseInventory);
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.evaluate(async () => {
    const { setConnectionTarget } = await import('/src/api.ts');
    await setConnectionTarget({ mode: 'relay', url: 'ws://127.0.0.1:55191/test-only-no-server', token: 'fake-test-only', deviceId: 'fake',
      user: { userId: 'test-bob', username: 'bob', displayName: 'Bob', avatarData: '', avatarColor: '', managed: false } });
    (window as any).releaseInventory();
  });
  await expect(recovery).toHaveCount(0); await expect(page.locator('.cm-content')).toHaveCount(0);
  await page.locator('.ftp-hdr').hover(); await page.getByRole('button', { name: '本设备草稿', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('本设备没有此账号的持久草稿。')).toBeVisible();
  await expect(page.getByLabel('离线恢复的草稿（只读）')).toHaveCount(0);
});

test('real IndexedDB quota does not evict drafts and cleanup rejects stale snapshots', async ({ page }) => {
  await mountFiles(page);
  const result = await page.evaluate(async () => {
    const { IndexedDraftRepository } = await import('/src/utils/documentDrafts.ts');
    const repo = new IndexedDraftRepository();
    const make = n => ({ id: 'quota-' + n, documentKey: 'isolated-' + n, ownerId: 'quota-test', branch: 'test', updatedAt: n, payload: '{}'});
    for (let i = 0; i < 64; i++) await repo.put(make(i));
    let full = false; try { await repo.put(make(64)); } catch { full = true; }
    const old = make(0); await repo.put({ ...old, payload: '{"new":true}' });
    let stale = false; try { await repo.removeRecord(old); } catch { stale = true; }
    return { full, stale, count: (await repo.listOwner('quota-test')).length,
      latest: (await repo.list('isolated-0', 'quota-test'))[0].payload, foreign: (await repo.listOwner('another-user')).length };
  });
  expect(result).toEqual({ full: true, stale: true, count: 64, latest: '{"new":true}', foreign: 0 });
});

for (const engine of [false, true]) test(`${engine ? 'Engine' : 'Chat'} PDF and Office use specialized previews, including parser failures, never generic editor saves`, async ({ page }) => {
  await mountFiles(page, false, false, engine);
  await page.evaluate(async () => {
    const { api } = await import('/src/api.ts');
    for (const name of ['sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.pptx']) (window as any).fixture.files[name] = 'invalid fixture bytes';
    api.syncFileStat = async () => ({ status: 'ok', size: 21 });
    api.syncReadChunk = async () => ({ status: 'ok', data: btoa('invalid fixture bytes'), read: 21 });
    api.filePreview = async () => ({ status: 'ok', kind: 'word', blocks: [{ type: 'paragraph', text: 'Specialized Office fixture' }] });
  });
  await page.locator('.ftp-hdr').hover(); await page.getByTitle('刷新本机与远端目录', { exact: true }).click();
  for (const name of ['sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.pptx']) {
    await page.locator('.ftp-row').filter({ has: page.getByText(name, { exact: true }) }).dblclick();
    await expect(name.endsWith('.pdf') ? page.getByText('PDF 预览失败：', { exact: false }) : page.getByText('Specialized Office fixture', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '✏️ 编辑', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '💾 保存', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: engine ? `关闭文件 ${name}` : '关闭预览', exact: true }).click();
  }
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
  expect(await page.evaluate(() => (window as any).fixture.calls.filter(name => name.startsWith('workspaceDocument')))).toEqual([]);
});

test('Engine late preview cannot replace another active document or forget its tab', async ({ page }) => {
  await mountFiles(page, false, false, true);
  await page.evaluate(async () => {
    const { api } = await import('/src/api.ts'); const read = api.syncReadFile;
    api.syncReadFile = async (...args: Parameters<typeof read>) => {
      if (args[1] !== 'a.py' || (window as any).fixture.previewReleased) return read(...args);
      return new Promise(resolve => { (window as any).fixture.releasePreview = async () => {
        (window as any).fixture.previewReleased = true; resolve(await read(...args));
      }; });
    };
  });
  await page.locator('.ftp-row').filter({ has: page.getByText('a.py', { exact: true }) }).click();
  await page.waitForFunction(() => !!(window as any).fixture.releasePreview);
  await page.locator('.ftp-row').filter({ has: page.getByText('b.java', { exact: true }) }).click();
  const host = page.locator('#document-host'); await expect(host.locator('.cm-content')).toHaveText('old b');
  await page.evaluate(() => (window as any).fixture.releasePreview());
  await expect(host.locator('.cm-content')).toHaveText('old b');
  await expect(host.getByRole('tab')).toHaveCount(2);
  await host.getByRole('tab', { name: 'a.py', exact: true }).click();
  await expect(host.locator('.cm-content')).toHaveText('old a');
});

test('Engine opens four code families directly, with independent tabs/history and safe save staying in editor', async ({ page }) => {
  await mountFiles(page, false, false, true);
  const host = page.locator('#document-host'), editor = host.locator('.cm-content');
  for (const name of ['a.py', 'b.java', 'view.vue', 'app.tsx']) {
    await page.locator('.ftp-row').filter({ has: page.getByText(name, { exact: true }) }).click();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill(`draft ${name}`);
  }
  await expect(host.getByRole('tab')).toHaveCount(4);
  await host.getByRole('tab', { name: '● a.py', exact: true }).click();
  await expect(editor).toHaveText('draft a.py');
  await editor.press('Control+z'); await expect(editor).toHaveText('old a');
  await editor.press('Control+y'); await expect(editor).toHaveText('draft a.py');
  await host.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.saves.length)).toBe(1);
  await editor.fill('newer a.py'); await page.evaluate(() => (window as any).fixture.finish());
  await expect(editor).toHaveText('newer a.py');
  await expect(host.getByRole('tab', { name: '● a.py', exact: true })).toHaveAttribute('aria-selected', 'true');
  await host.getByRole('button', { name: '关闭文件 a.py', exact: true }).click();
  await expect(host.getByRole('alertdialog', { name: '关闭未保存文件' })).toBeVisible();
  await host.getByRole('button', { name: '取消关闭', exact: true }).click();
  await expect(editor).toHaveText('newer a.py');
  await host.getByRole('button', { name: '关闭文件 b.java', exact: true }).click();
  await host.getByRole('button', { name: '放弃草稿并关闭', exact: true }).click();
  await expect(host.getByRole('tab')).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).fixture.files['b.java'])).toBe('old b');
  await page.evaluate(() => { (window as any).fixture.immediate = true; });
  await host.getByRole('button', { name: '关闭文件 a.py', exact: true }).click();
  await host.getByRole('button', { name: '保存并关闭', exact: true }).click();
  await expect(host.getByRole('tab')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).fixture.files['a.py'])).toBe('newer a.py');
});

test('Engine Markdown preview/source/split share the unsaved buffer and retain editor instance', async ({ page }) => {
  await mountFiles(page, false, false, true);
  const host = page.locator('#document-host'), editor = host.locator('.cm-content');
  await page.locator('.ftp-row').filter({ has: page.getByText('readme.md', { exact: true }) }).click();
  await expect(host.getByRole('heading', { name: 'Original markdown' })).toBeVisible();
  await expect(editor).toBeHidden();
  await host.getByRole('group', { name: '文档显示方式' }).getByRole('button', { name: '并排', exact: true }).click();
  await expect(editor).toHaveAttribute('contenteditable', 'true'); const original = await editor.elementHandle();
  await editor.fill('# Unsaved preview');
  await expect(host.getByRole('heading', { name: 'Unsaved preview' })).toBeVisible();
  await host.getByRole('group', { name: '文档显示方式' }).getByRole('button', { name: '预览', exact: true }).click();
  await expect(editor).toBeHidden(); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await host.getByRole('group', { name: '文档显示方式' }).getByRole('button', { name: '源码', exact: true }).click();
  await editor.press('Control+z'); await expect(editor).toHaveText('# Original markdown');
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
});

test('Engine HTML remains sandboxed and script trust is not inherited by another file', async ({ page }) => {
  await mountFiles(page, false, false, true);
  const host = page.locator('#document-host');
  await page.locator('.ftp-row').filter({ has: page.getByText('page.html', { exact: true }) }).click();
  await expect(host.frameLocator('iframe').getByRole('heading', { name: 'Static' })).toBeVisible();
  await host.getByRole('group', { name: '文档显示方式' }).getByRole('button', { name: '并排', exact: true }).click();
  await host.locator('.cm-content').fill('<h1>Unsaved HTML</h1><script>document.querySelector("h1").textContent="Script ran"</script>');
  await expect(host.frameLocator('iframe').getByRole('heading', { name: 'Unsaved HTML' })).toBeVisible();
  await host.getByRole('button', { name: '启用页面脚本', exact: true }).click();
  await expect(host.frameLocator('iframe').getByRole('heading', { name: 'Script ran' })).toBeVisible();
  await expect(host.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await page.locator('.ftp-row').filter({ has: page.getByText('a.py', { exact: true }) }).click();
  await host.getByRole('tab', { name: '● page.html', exact: true }).click();
  await expect(host.frameLocator('iframe').getByRole('heading', { name: 'Unsaved HTML' })).toBeVisible();
  await expect(host.getByRole('button', { name: '启用页面脚本', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('Engine image, binary, large complete text and old-node read-only defaults never bypass save gates', async ({ page }) => {
  await mountFiles(page, false, false, true);
  const host = page.locator('#document-host');
  await page.locator('.ftp-row').filter({ has: page.getByText('tiny.png', { exact: true }) }).click();
  await expect(host.getByRole('img', { name: 'tiny.png' })).toBeVisible();
  await expect(host.locator('.cm-content')).toHaveCount(0);
  await page.locator('.ftp-row').filter({ has: page.getByText('binary.txt', { exact: true }) }).click();
  await expect(host).toContainText('二进制文件只读'); await expect(host.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await page.locator('.ftp-row').filter({ has: page.getByText('large.txt', { exact: true }) }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { documentStore } = await import('/src/utils/documentStore.ts');
    return documentStore.all().find(doc => doc.identity.relativePath === 'large.txt')?.text.length;
  })).toBe(220_000);
  await page.evaluate(() => { (window as any).fixture.old = true; });
  await page.locator('.ftp-row').filter({ has: page.getByText('b.java', { exact: true }) }).click();
  await expect(host).toContainText('无法安全编辑');
  await expect(host.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(host.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fixture.saves)).toEqual([]);
});
