import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { openSessionMenu, selectMode, seedLocalCopy, expectTreeFillsColumn } from './engine-actions';

// Full App/ChatPane/LOOP under the isolated home QA backend. All new file reads are fixed
// fixtures; writes, models, control transfers, terminals and language services are blocked.
async function fixture(page: Page, kind: 'normal' | 'loop' | 'manual' = 'normal', capability = 'supported', copies = true, sourceText = 'print("fixture")') {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const sid = kind === 'normal' ? 'qa-chat-004' : 'qa-loop-000';
  const title = kind === 'normal' ? '客户工作会话 5' : '首页交付 Loop 1';
  let mode = 'chat'; let pending: (() => void) | undefined;
  const calls: string[] = [], patches: any[] = [];
  const meta = { id: sid, title, sessionType: kind === 'normal' ? 'normal' : 'loop',
    loopControlMode: kind === 'manual' ? 'manual' : 'loop', controlRevision: 1,
    loopControlProtocolVersion: 1, backendId: 'qa-primary', workingDir: 'C:/qa/workspaces/engine-fixture' };
  const identity = () => ({ ownerId: 'local', executorInstance: 'fixture', sessionId: sid,
    workingDir: meta.workingDir, workspaceRevision: 'a'.repeat(64) });
  await page.routeWebSocket(/127\.0\.0\.1:45421/, socket => {
    const server = socket.connectToServer(); const requests = new Map<any, any>();
    const reply = (frame: any, result: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
    socket.onMessage(message => {
      const frame = JSON.parse(String(message)); calls.push(frame.method);
      if (/^(sendMessage|abortMessage|loopControlRequest|loopTakeover|loopRelease|loopRunIteration|loopContinue|loopSetAuto|seqtaskTakeNext|terminalCreate|languageServiceStart|workspaceDocumentSave|syncWriteFile)$/.test(frame.method))
        throw new Error(`Unexpected mutation: ${frame.method}`);
      if (frame.method === 'loadSessionMeta' && frame.params[0] === sid) return reply(frame, { ...meta, viewMode: mode });
      if (frame.method === 'loopControlGet' && frame.params[0] === sid) return reply(frame, {
        protocolVersion: 1, sessionId: sid, controlMode: meta.loopControlMode, controlRevision: 1,
        auto: false, stage: 'loopexecute', round: 1, operation: {}, eligibility: { takeover: { allowed: true }, release: { allowed: true } },
      });
      if (frame.method === 'sessionWorkbenchCapabilities') {
        if (capability === 'old') return reply(frame, null);
        if (capability === 'offline') return socket.send(JSON.stringify({ id: frame.id, error: 'QA executor offline' }));
        return reply(frame, { status: 'ok', protocolVersion: 1,
          identity: { ownerId: 'local', executorInstance: 'fixture', sessionId: sid, workingDir: meta.workingDir, workspaceRevision: 'a'.repeat(64) },
          capabilities: { viewMode: 1, windowHandoff: 0, documents: 1, languageServices: 0, terminal: 0 } });
      }
      if (frame.method === 'workspaceDocumentRead') {
        const text = sourceText;
        return reply(frame, { status: 'ok', document: { workspace: identity(), relativePath: 'hello.py', canonicalPath: meta.workingDir + '/hello.py', source: 'executor' },
          text, complete: true, editable: true, canSave: true, encoding: 'utf-8', bom: '', eol: 'none', reasonCode: '', writeReasonCode: '', controlRevision: 1,
          byteLength: text.length, readByteLength: text.length, version: { exists: true, sha256: createHash('sha256').update(text).digest('hex'), byteLength: text.length, fileId: 'hello', modifiedNs: '1', changedNs: '1' } });
      }
      if (frame.method === 'updateSessionWorkbench') {
        patches.push(JSON.parse(frame.params[1]));
        const saved = { ...meta, viewMode: patches.at(-1).viewMode };
        pending = () => { mode = saved.viewMode; reply(frame, { status: 'ok', viewMode: mode, summary: saved }); };
        if (capability === 'missing-receipt') return reply(frame, null);
        if (capability !== 'held') pending();
        return;
      }
      if (frame.method === 'listDirectory') return reply(frame, [{ name: 'hello.py', path: 'hello.py', isDir: false }]);
      if (frame.method === 'gitDetect') return reply(frame, { isRepo: false });
      if (frame.method === 'syncReadFile') return reply(frame, { status: 'ok', data: Buffer.from(sourceText).toString('base64') });
      if (frame.method === 'syncFileStat') return reply(frame, { status: 'ok', size: Buffer.byteLength(sourceText) });
      if (frame.method === 'syncReadChunk') { const bytes = Buffer.from(sourceText).subarray(frame.params[2], frame.params[2] + frame.params[3]);
        return reply(frame, { status: 'ok', data: bytes.toString('base64'), size: bytes.length }); }
      requests.set(frame.id, frame); server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message)), request = requests.get(frame.id);
      if (request?.method === 'loopGetState' && request.params[0] === sid && frame.result) {
        const state = JSON.parse(frame.result);
        frame.result = JSON.stringify({ ...state, controlMode: meta.loopControlMode, controlRevision: 1, auto: false, running: false });
      }
      socket.send(JSON.stringify(frame));
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(title, { exact: true }).click();
  const pane = page.locator(`[data-session-tab-panel="${sid}"]`);
  await expect((await openSessionMenu(page, pane)).getByRole('menuitemradio', { name: 'Engine · 工程工作区' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await seedLocalCopy(page, sid, copies ? { 'hello.py': sourceText } : {});
  return { pane, calls, patches, complete: () => pending?.(), moveWorkspace: () => { meta.workingDir = 'C:/qa/workspaces/changed'; } };
}

for (const kind of ['normal', 'loop'] as const) test(`${kind}: Chat has no duplicate row and the tab menu anchors, dismisses and restores focus`, async ({ page }, info) => {
  const f = await fixture(page, kind);
  const chat = f.pane.locator('.awu-chat-pane'), original = await chat.elementHandle();
  const sid = await f.pane.getAttribute('data-session-tab-panel');
  const tab = page.locator(`[id="workbench-tab-session:${sid}"]`);
  await expect(f.pane.locator('[data-workbench-header]')).toHaveCount(0);
  await expect(f.pane.getByRole('button', { name: '当前会话菜单' })).toHaveCount(0);
  await expect(f.pane.getByRole('button', { name: '分离到独立窗口' })).toHaveCount(0);
  // 此夹具不提供窗口交接能力：真实降级提示保留，但不能另有工具栏/空白占位。
  const notice = f.pane.locator('[data-window-handoff-status]');
  await expect(notice).toContainText('执行端尚不支持安全窗口交接');
  expect(Math.abs((await chat.boundingBox())!.y - (await f.pane.boundingBox())!.y - (await notice.boundingBox())!.height)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath(`chat-${kind}-no-toolbar.png`) });
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 600) await page.getByTitle('收起侧栏', { exact: true }).click();
    const menu = await openSessionMenu(page, f.pane, true);
    await expect(menu.getByRole('menuitemradio', { name: 'Chat · 多会话' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('button', { name: '分离到独立窗口' })).toBeVisible();
    const box = (await menu.boundingBox())!, anchor = (await tab.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
    expect(Math.abs(box.y - anchor.y - anchor.height - 6)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`chat-${kind}-menu-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(tab).toBeFocused(); await expect(menu).toHaveCount(0);
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  }
  expect(f.patches).toEqual([]);
  await openSessionMenu(page, f.pane);
  await page.getByRole('tab', { name: '工作总览', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '当前会话菜单' })).toHaveCount(0);
  await tab.click();
  await expect(page.getByRole('dialog', { name: '当前会话菜单' })).toHaveCount(0);
});

for (const kind of ['normal', 'loop', 'manual'] as const) {
  test(`${kind}: Engine keeps conversation/control routing, uses central non-modal files and no processes`, async ({ page }, info) => {
    const f = await fixture(page, kind);
    const chat = f.pane.locator('.awu-chat-pane'); const original = await chat.elementHandle();
    if (kind !== 'loop') await f.pane.locator('.chat-textarea').fill('未发送草稿');
    await selectMode(page, f.pane, 'Engine');
    await expect(f.pane.locator('.awu-session-workbench')).toHaveAttribute('data-view-mode', 'engine');
    const files = f.pane.getByRole('complementary', { name: 'Engine 文件目录' });
    const document = f.pane.getByRole('region', { name: 'Engine 文件工作区' });
    await expect(files).toBeVisible(); await expect(document).toBeVisible(); await expect(chat).toBeVisible();
    const [left, center, right] = await Promise.all([files.boundingBox(), document.boundingBox(), chat.boundingBox()]);
    expect(left!.x + left!.width).toBeLessThanOrEqual(center!.x + 1);
    expect(center!.x + center!.width).toBeLessThanOrEqual(right!.x + 1);
    await expect(document.getByRole('button', { name: '打开文件目录' })).toBeVisible();
    await files.locator('.ftp-row').filter({ hasText: 'hello.py' }).dblclick();
    await expect(document).toContainText('print("fixture")');
    await expect(page.getByRole('button', { name: '⛶ 最大化', exact: true })).toHaveCount(0);
    await f.pane.getByRole('button', { name: '终端区域', exact: true }).click();
    await expect(f.pane.getByRole('region', { name: 'Engine 终端区域' })).toContainText('节点不支持受管理终端');
    if (kind === 'loop') await expect(f.pane.locator('.chat-textarea')).toHaveCount(0);
    else await expect(f.pane.locator('.chat-textarea')).toHaveValue('未发送草稿');
    await page.screenshot({ path: info.outputPath(`engine-${kind}.png`) });
    await selectMode(page, f.pane, 'Chat');
    await expect(files).toBeHidden(); await expect(document).toBeHidden();
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await selectMode(page, f.pane, 'Engine');
    await expect(document).toContainText('print("fixture")');
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(f.patches).toEqual([{ viewMode: 'engine' }, { viewMode: 'chat' }, { viewMode: 'engine' }]);
  });
}

test('only a known old executor gets local-only mode; it survives reload', async ({ page }) => {
  const f = await fixture(page, 'normal', 'old');
  await selectMode(page, f.pane, 'Engine');
  await expect(f.pane).toContainText('仅记在本设备'); expect(f.patches).toEqual([]);
  await page.reload();
  await expect(f.pane.locator('.awu-session-workbench')).toHaveAttribute('data-view-mode', 'engine');
  await expect(f.pane).toContainText('仅记在本设备');
});

for (const capability of ['offline', 'missing-receipt']) test(`${capability}: failure cannot claim local or server success`, async ({ page }) => {
  const f = await fixture(page, 'normal', capability);
  await selectMode(page, f.pane, 'Engine');
  await expect(f.pane.getByRole('alert')).toContainText(capability === 'offline' ? 'offline' : '结果未知');
  await expect(f.pane.locator('.awu-session-workbench')).toHaveAttribute('data-view-mode', 'chat');
  expect(f.patches.length).toBe(capability === 'offline' ? 0 : 1);
  expect(await page.evaluate(() => localStorage.getItem('awu-session-view-local-v1'))).toBeNull();
});

test('pending mode requests cannot be submitted twice and narrow regions remain accessible', async ({ page }) => {
  const f = await fixture(page, 'normal', 'held');
  await selectMode(page, f.pane, 'Engine');
  await openSessionMenu(page, f.pane);
  const engine = page.getByRole('menuitemradio', { name: 'Engine · 工程工作区', exact: true });
  await expect(engine).toBeDisabled(); await expect(f.pane).toContainText('保存展示模式…');
  await engine.evaluate(button => { (button as HTMLButtonElement).click(); });
  await page.keyboard.press('Escape');
  f.complete();
  await expect(f.pane.locator('.awu-session-workbench')).toHaveAttribute('data-view-mode', 'engine');
  expect(f.patches).toHaveLength(1);
  await page.setViewportSize({ width: 650, height: 900 });
  await expect(page.locator('.awu-sidebar')).toBeHidden();
  const regions = f.pane.getByRole('group', { name: 'Engine 区域' }); await expect(regions).toBeVisible();
  await regions.getByRole('button', { name: '目录', exact: true }).click();
  await f.pane.locator('.ftp-row').filter({ hasText: 'hello.py' }).dblclick();
  await expect(f.pane.getByRole('region', { name: 'Engine 文件工作区' })).toContainText('print("fixture")');
  await regions.getByRole('button', { name: '对话 / LOOP', exact: true }).click();
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
});

test('a late saved-mode receipt cannot restore an obsolete workspace or mode', async ({ page }) => {
  const f = await fixture(page, 'normal', 'held');
  await page.evaluate(async () => {
    const { api } = await import('/src/api.ts');
    const update = api.updateSessionWorkbench;
    api.updateSessionWorkbench = async (...args: Parameters<typeof update>) => {
      try { return await update(...args); } finally { (window as any).modeReplyFinished = true; }
    };
  });
  await selectMode(page, f.pane, 'Engine');
  await expect.poll(() => f.patches.length).toBe(1);
  f.moveWorkspace();
  await page.evaluate(async () => { const { api } = await import('/src/api.ts'); await api.loadSessionMeta('qa-chat-004'); });
  f.complete();
  await page.waitForFunction(() => (window as any).modeReplyFinished);
  await expect(f.pane.locator('.awu-session-workbench')).toHaveAttribute('data-view-mode', 'chat');
  expect(await page.evaluate(async () => { const { api } = await import('/src/api.ts'); return api.peekSessionMeta('qa-chat-004').workingDir; }))
    .toBe('C:/qa/workspaces/changed');
  expect(f.patches).toHaveLength(1);
});

test('layout resizes with pointer/keyboard, collapses without destroying state and restores after narrow/reload', async ({ page }) => {
  const f = await fixture(page);
  await f.pane.locator('.chat-textarea').fill('布局草稿');
  await selectMode(page, f.pane, 'Engine');
  await f.pane.locator('.ftp-row').filter({ hasText: 'hello.py' }).dblclick();
  const editor = f.pane.locator('.cm-content');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('unsaved layout file');
  const originalEditor = await editor.elementHandle();
  const handle = f.pane.getByRole('separator', { name: '目录宽度' });
  await handle.focus(); await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '256');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 42, box.y + 30); await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '296');
  await expectTreeFillsColumn(f.pane);
  await handle.focus(); await page.keyboard.press('ArrowLeft');
  await expectTreeFillsColumn(f.pane);
  await page.keyboard.press('ArrowRight'); await expectTreeFillsColumn(f.pane);
  await expect(editor).toHaveText('unsaved layout file');
  expect(await originalEditor!.evaluate(node => node.isConnected)).toBe(true);
  const chat = await f.pane.locator('.awu-chat-pane').elementHandle();
  await f.pane.getByRole('button', { name: '对话区域', exact: true }).click();
  await expect(f.pane.locator('.chat-textarea')).toBeHidden();
  expect(await chat!.evaluate(node => node.isConnected)).toBe(true);
  await f.pane.getByRole('button', { name: '对话区域', exact: true }).click();
  await expect(f.pane.locator('.chat-textarea')).toHaveValue('布局草稿');
  await selectMode(page, f.pane, 'Chat');
  await selectMode(page, f.pane, 'Engine');
  await expect(handle).toHaveAttribute('aria-valuenow', '296');
  await expect(editor).toHaveText('unsaved layout file');
  expect(await originalEditor!.evaluate(node => node.isConnected)).toBe(true);
  await page.setViewportSize({ width: 650, height: 700 });
  await expect(page.locator('.awu-sidebar')).toBeHidden();
  await f.pane.getByRole('group', { name: 'Engine 区域' }).getByRole('button', { name: '终端', exact: true }).click();
  await expect(f.pane.getByRole('region', { name: 'Engine 终端区域' })).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(handle).toHaveAttribute('aria-valuenow', '296');
  await expectTreeFillsColumn(f.pane);
  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', '296');
  await f.pane.getByRole('button', { name: '窗口与布局', exact: true }).click();
  await page.getByRole('dialog', { name: '窗口与布局' }).getByRole('button', { name: '重置布局', exact: true }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', '240');
});

test('Session context menu enters one workspace; Chat restores other tabs, split panes and drafts', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agent-with-u:layout', '1x2'));
  const f = await fixture(page);
  await f.pane.locator('.chat-textarea').fill('current draft');
  await page.getByRole('heading', { name: '工作总览', exact: true }).click();
  await page.locator('.awu-sidebar').getByText('客户工作会话 6', { exact: true }).click();
  const other = page.locator('[data-session-tab-panel="qa-chat-005"]');
  await other.locator('.chat-textarea').fill('background draft');
  const original = await other.locator('.chat-textarea').elementHandle();
  await page.locator('.awu-sidebar').getByText('客户工作会话 5', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Engine · 工程工作区', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '工作区标签页' })).toHaveCount(0);
  await expect(page.locator('.awu-sidebar')).toBeHidden();
  await expect(other).toBeHidden(); await expect(f.pane).toBeVisible();
  await expect(page.getByRole('button', { name: '返回工作总览' })).toHaveCount(0);
  await expect(f.pane.getByRole('group', { name: '展示模式' })).toHaveCount(0);
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /分屏布局|Skills 与 Prompts/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('awu-open-workspace-session', { detail: { node: 'local', session: 'qa-chat-005' } })));
  await expect(page.getByText('当前窗口专注此工程。请从当前会话菜单返回 Chat 后再切换会话。', { exact: true })).toBeVisible();
  await expect(f.pane).toBeVisible(); await expect(other).toBeHidden();
  await f.pane.getByRole('button', { name: '当前会话菜单', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitemradio', { name: 'Chat · 多会话', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '工作区标签页' })).toBeVisible();
  await expect(page.locator('[data-session-tab-panel]:visible')).toHaveCount(2);
  await expect(other.locator('.chat-textarea')).toHaveValue('background draft');
  await expect(f.pane.locator('.chat-textarea')).toHaveValue('current draft');
  expect(await original!.evaluate(el => el.isConnected)).toBe(true);
  await page.getByRole('tab', { name: '客户工作会话 5', exact: true }).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('dialog', { name: '当前会话菜单' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a background Engine mode receipt does not lock a foreground extension tab', async ({ page }) => {
  const f = await fixture(page, 'normal', 'held');
  await openSessionMenu(page, f.pane);
  await page.getByRole('menuitemradio', { name: 'Engine · 工程工作区', exact: true }).click();
  await expect.poll(() => f.patches.length).toBe(1);
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Skills 与 Prompts', exact: true }).click();
  f.complete();
  await expect(f.pane.locator('.awu-session-workbench')).toHaveAttribute('data-view-mode', 'engine');
  await expect(page.getByRole('tablist', { name: '工作区标签页' })).toBeVisible();
  await expect(page.locator('#workbench-panel-library')).toBeVisible();
  await page.getByRole('tab', { name: '客户工作会话 5', exact: true }).click();
  await expect(f.pane).toBeVisible();
  await expect(page.getByRole('tablist', { name: '工作区标签页' })).toHaveCount(0);
});

test('remote text stays read-only; downloading opens editable local mixed-EOL copy without upload', async ({ page }) => {
  const original = 'first\r\nsecond\nthird\rlast';
  const f = await fixture(page, 'normal', 'supported', false, original);
  await selectMode(page, f.pane, 'Engine');
  const tree = f.pane.getByRole('complementary', { name: 'Engine 文件目录' });
  await tree.locator('.ftp-row').filter({ hasText: 'hello.py' }).dblclick();
  const document = f.pane.getByRole('region', { name: 'Engine 文件工作区' });
  await expect(document.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(document).toContainText('远端文件 · 只读');
  await expect(document.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await document.getByRole('button', { name: '下载到本机并打开' }).click();
  await expect(document.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await expect(document).toContainText('本机副本 · 保存不上传');
  await expect(document).not.toContainText('只读：mixed_eol');
  await document.locator('.cm-content').fill('FIRST\nsecond\nthird\nlast');
  await document.getByRole('button', { name: '保存', exact: true }).click();
  await expect(document.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  expect(await page.evaluate(async () => {
    const { restoreLocalDir } = await import('/src/utils/dirSync.ts');
    return atob(await (await restoreLocalDir('qa-chat-004'))!.readFile('hello.py'));
  })).toBe('FIRST\r\nsecond\nthird\rlast');
  expect(f.calls).not.toContain('workspaceDocumentSave'); expect(f.calls).not.toContain('syncWriteFile');
  await tree.locator('.ftp-row').filter({ hasText: 'hello.py' }).click({ button: 'right' });
  await page.getByRole('button', { name: '查看远端（只读）', exact: true }).click();
  await expect(document.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await document.getByRole('button', { name: '打开本机副本', exact: true }).click();
  await expect(document.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await expect(document.locator('.cm-content')).toContainText('FIRST');
  await selectMode(page, f.pane, 'Chat');
  await page.getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true }).click();
  await page.locator('.awu-sidebar .ftp-row').filter({ hasText: 'hello.py' }).dblclick();
  await expect(page.getByRole('button', { name: '✏️ 编辑', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  await expect(page.locator('.cm-content:visible')).toHaveAttribute('contenteditable', 'true');
});
