import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { openSessionMenu, selectMode, seedLocalCopy } from './engine-actions';

// Both real App windows share only isolated fake protocol state. No model/file writes.
async function fixture(context: BrowserContext, page: Page, terminalEnabled = false, languageEnabled = false) {
  const sid = 'qa-chat-004', cwd = 'C:/qa/workspaces/window-fixture';
  const workspace = { ownerId: 'local', executorInstance: 'fixture', sessionId: sid, workingDir: cwd, workspaceRevision: 'd'.repeat(64) };
  const calls: string[] = [], sockets: any[] = [];
  let mode = 'chat', ownership: any, receipt: any, sequence = 0;
  let holdAck = false, releaseAck: (() => void) | undefined;
  const windowActions: string[] = [];
  const events: any[] = [];
  let terminal: any = null;
  const input: string[] = [];
  const language: any = { workspace, provider: 'python', resourceId: 'existing-language', generation: 'language-generation', requestId: 'earlier-explicit-start', revision: 1,
    planFingerprint: 'a'.repeat(64), status: 'ready', reasonCode: '', exitConfirmed: false, config: { provider: 'python' }, dependencies: {}, activityId: 'language-activity',
    capabilities: { completion: true, definition: true, references: true, rename: true, format: true }, documents: [] };
  const terminalOutput = 'PTY fixture ready\r\n\x1b]52;c;c2VjcmV0\x07\x1b]8;;https://invalid.example/\x1b\\safe-link\x1b]8;;\x07';
  await context.routeWebSocket(/127\.0\.0\.1:45421/, socket => {
    sockets.push(socket); const server = socket.connectToServer();
    const reply = (frame: any, result: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
    socket.onMessage(message => {
      const frame = JSON.parse(String(message)); calls.push(frame.method);
      if (/^(sendMessage|abortMessage|grantPermission|loopControlRequest|languageServiceStart|workspaceDocumentSave|syncWriteFile)$/.test(frame.method)) throw Error(`Forbidden mutation ${frame.method}`);
      if (frame.method.startsWith('languageService')) {
        expect(languageEnabled).toBe(true);
        const p = JSON.parse(frame.params[2] || '{}');
        if (frame.method === 'languageServiceList') return reply(frame, { status: 'ok', workspace, controlRevision: 0, services: [language] });
        expect(p.resourceId).toBe(language.resourceId); expect(p.generation).toBe(language.generation);
        if (frame.method === 'languageServiceDiagnostics') return reply(frame, { status: 'ok', service: language, diagnostics: [] });
        if (frame.method === 'languageServiceRequest') {
          expect(ownership.frozen).toBe(false); expect(frame.workbench.windowId).toBe(ownership.windowId);
          expect(frame.workbench.lease.generation).toBe(ownership.generation);
          return reply(frame, { status: 'ok', service: language, revision: p.revision, result: null, diagnostics: [] });
        }
        throw Error(`Unexpected language method: ${frame.method}`);
      }
      if (frame.method.startsWith('terminal')) {
        expect(terminalEnabled).toBe(true);
        const p = JSON.parse(frame.params[2] || '{}');
        if (frame.method === 'terminalList') return reply(frame, { status: 'ok', workspace, controlRevision: 0,
          shells: [{ id: 'fake', executable: 'C:/qa/fake-shell', args: [] }], terminals: terminal ? [terminal] : [] });
        if (frame.method === 'terminalRead') return reply(frame, { ...terminal, status: 'ok', terminalStatus: terminal.status,
          gap: false, earliestSequence: 1, through: 1, chunks: p.after < 1 ? [{ sequence: 1, text: terminalOutput }] : [] });
        expect(ownership.frozen).toBe(false); expect(frame.workbench.windowId).toBe(ownership.windowId);
        expect(frame.workbench.lease.generation).toBe(ownership.generation);
        if (frame.method === 'terminalCreate') {
          expect(terminal).toBeNull();
          terminal = { workspace, resourceId: 'terminal-fixture', generation: 'terminal-generation', requestId: p.requestId,
            shell: { id: 'fake', executable: 'C:/qa/fake-shell', args: [] }, cols: 80, rows: 24, revision: 1, status: 'running', reasonCode: '',
            lastSequence: 1, inputSequence: 0, activityId: 'fixture-activity', exitConfirmed: false };
          return reply(frame, terminal);
        }
        expect(p.resourceId).toBe(terminal.resourceId); expect(p.generation).toBe(terminal.generation);
        terminal.revision++;
        if (frame.method === 'terminalInput') { expect(p.sequence).toBe(terminal.inputSequence + 1);
          input.push(p.text); terminal.inputSequence = p.sequence;
          return reply(frame, { status: 'accepted', sequence: p.sequence, terminal }); }
        if (frame.method === 'terminalResize') { terminal.cols = p.cols; terminal.rows = p.rows; return reply(frame, terminal); }
        if (frame.method === 'terminalStop') { terminal.status = 'stopped'; terminal.exitConfirmed = true; return reply(frame, terminal); }
        throw Error(`Unexpected terminal method: ${frame.method}`);
      }
      if (frame.method === 'loadSessionMeta' && frame.params[0] === sid) return reply(frame, { id: sid, title: '窗口测试', sessionType: 'normal', backendId: 'qa-primary', workingDir: cwd, viewMode: mode });
      if (frame.method === 'sessionWorkbenchCapabilities') return reply(frame, { status: 'ok', protocolVersion: 1, identity: workspace,
        capabilities: { viewMode: 1, windowHandoff: 1, documents: 1, terminal: terminalEnabled ? 1 : 0, languageServices: languageEnabled ? 1 : 0 } });
      if (frame.method === 'updateSessionWorkbench') { mode = JSON.parse(frame.params[1]).viewMode; return reply(frame, { status: 'ok', viewMode: mode, summary: { id: sid, viewMode: mode } }); }
      if (frame.method === 'workbenchWindow') {
        const p = JSON.parse(frame.params[2]), meta = frame.workbench;
        windowActions.push(p.action);
        if (!meta) throw Error('Missing window identity');
        if (p.action === 'register') ownership ||= { status: 'ok', workspace, clientId: meta.clientId, windowId: meta.windowId, generation: 1, revision: 1, frozen: false, pending: null };
        if (p.action === 'prepare') {
          expect(meta.windowId).toBe(ownership.windowId); expect(p.generation).toBe(ownership.generation); expect(ownership.frozen).toBe(false);
          receipt = { requestId: p.requestId, sourceWindow: meta.windowId, targetWindow: p.targetWindow, generation: p.generation,
            stateDigest: p.stateDigest, stateVersion: p.stateVersion, fingerprint: 'f'.repeat(64), status: 'prepared' };
          ownership = { ...ownership, frozen: true, revision: ownership.revision + 1, pending: receipt }; return reply(frame, receipt);
        }
        if (p.action === 'ack') { expect(meta.windowId).toBe(receipt.targetWindow); expect(p.stateDigest).toBe(receipt.stateDigest);
          const complete = () => { receipt.status = 'acknowledged'; ownership.revision++; reply(frame, receipt); };
          if (holdAck) { releaseAck = complete; return; } complete(); return; }
        if (p.action === 'reclaim') {
          expect(p.expectedWindow).toBe(ownership.windowId); expect(p.generation).toBe(ownership.generation); expect(p.revision).toBe(ownership.revision);
          ownership = { ...ownership, windowId: meta.windowId, generation: ownership.generation + 1, revision: ownership.revision + 1, frozen: false, pending: null };
          return reply(frame, { status: 'reclaimed', requestId: p.requestId, windowId: ownership.windowId, generation: ownership.generation, revision: ownership.revision });
        }
        if (p.action === 'commit' || p.action === 'cancel') {
          expect(meta.windowId).toBe(receipt.sourceWindow);
          if (p.action === 'commit') { expect(receipt.status).toBe('acknowledged'); ownership.windowId = receipt.targetWindow; ownership.generation++; }
          ownership.revision++; ownership.frozen = false; ownership.pending = null;
          receipt = { ...receipt, status: p.action === 'commit' ? 'committed' : 'cancelled', ownerWindow: ownership.windowId,
            committedGeneration: ownership.generation, revision: ownership.revision }; return reply(frame, receipt);
        }
        return reply(frame, { ...ownership, ...(p.requestId ? { receipt } : {}) });
      }
      if (frame.method === 'workbenchStreamGet') return reply(frame, events.length ? { status: 'ok', workspace, sessionId: sid,
        streamEpoch: 'epoch', lastSequence: sequence, gap: false, events: events.filter(e => e.streamSequence > frame.params[3]) }
        : { status: 'unavailable', workspace, sessionId: sid });
      if (frame.method === 'workbenchPermissionGet') return reply(frame, { status: 'ok', sessionId: sid, pending: null });
      if (frame.method === 'workspaceDocumentRead') {
        const relative = frame.params[2], text = relative === 'hello.py' ? 'print("fixture")' : 'export const x = 1;';
        return reply(frame, { status: 'ok', document: { workspace, relativePath: relative, canonicalPath: cwd + '/' + relative, source: 'executor' },
          text, complete: true, editable: true, canSave: true, encoding: 'utf-8', bom: '', eol: 'none', reasonCode: '', writeReasonCode: '', controlRevision: 0,
          byteLength: text.length, readByteLength: text.length, version: { exists: true, sha256: createHash('sha256').update(text).digest('hex'), byteLength: text.length, fileId: relative, modifiedNs: '1', changedNs: '1' } });
      }
      if (frame.method === 'listDirectory') return reply(frame, ['hello.py', 'main.ts'].map(name => ({ name, path: name, isDir: false })));
      if (frame.method === 'gitDetect') return reply(frame, { isRepo: false });
      if (frame.method === 'syncReadFile') return reply(frame, { status: 'ok', data: Buffer.from('print("fixture")').toString('base64') });
      if (frame.method === 'assetPush') return reply(frame, { status: 'ok' });
      server.send(message);
    });
    server.onMessage(message => socket.send(message));
  });
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true }); if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText('客户工作会话 5', { exact: true }).click();
  const pane = page.locator(`[data-session-tab-panel="${sid}"]`);
  await seedLocalCopy(page, sid, { 'hello.py': 'print("fixture")', 'main.ts': 'export const x = 1;' });
  await expect((await openSessionMenu(page, pane)).getByRole('button', { name: '分离到独立窗口', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  return { pane, calls, sid, input, windowActions, delayAck: () => { holdAck = true; }, releaseAck: () => { holdAck = false; releaseAck?.(); }, emit: (text: string) => {
    const delta = { sessionId: sid, messageId: 'window-stream', type: 'text_delta', text, streamEpoch: 'epoch', streamSequence: ++sequence, streamMessageStart: sequence === 1 };
    events.push(delta); for (const socket of sockets) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify(delta) }));
  } };
}

test('Chat tab menu owns window and recovery actions without a toolbar; safe close preserves the draft', async ({ context, page }, info) => {
  const f = await fixture(context, page);
  await expect(f.pane.locator('[data-workbench-header], [data-window-handoff-status]')).toHaveCount(0);
  const chat = f.pane.locator('.awu-chat-pane');
  expect(Math.abs((await chat.boundingBox())!.y - (await f.pane.boundingBox())!.y)).toBeLessThanOrEqual(1);
  await f.pane.locator('.chat-textarea').fill('Chat 菜单交接草稿');
  await page.screenshot({ path: info.outputPath('chat-no-duplicate-toolbar.png') });
  const menu = await openSessionMenu(page, f.pane);
  await expect(menu.getByRole('button', { name: '交接恢复包' })).toBeVisible();
  await expect(menu.getByRole('region', { name: '交接恢复记录' })).toHaveCount(0);
  expect(f.windowActions.filter(action => ['prepare', 'ack', 'commit'].includes(action))).toEqual([]);
  await page.screenshot({ path: info.outputPath('chat-tab-context-menu.png') });
  const popup = context.waitForEvent('page');
  await menu.getByRole('button', { name: '分离到独立窗口', exact: true }).click();
  const child = await popup, target = child.locator(`[data-session-tab-panel="${f.sid}"]`);
  await expect(target.locator('.chat-textarea')).toHaveValue('Chat 菜单交接草稿');
  const childMenu = await openSessionMenu(child, target, true);
  await expect(childMenu.getByRole('button', { name: '安全合并并关闭' })).toBeEnabled();
  await expect(target.locator('[data-workbench-header]')).toHaveCount(0);
  const closed = child.waitForEvent('close');
  await childMenu.getByRole('button', { name: '安全合并并关闭' }).click();
  await closed;
  await expect(f.pane.locator('.chat-textarea')).toHaveValue('Chat 菜单交接草稿');
  await expect(f.pane.locator('[data-workbench-header], [data-window-handoff-status]')).toHaveCount(0);
  expect(f.windowActions.filter(action => action === 'commit')).toHaveLength(2);
});

test('workbench chrome stays compact and readable over wallpaper; recovery/settings are keyboard-accessible on demand', async ({ context, page }, info) => {
  const f = await fixture(context, page);
  await selectMode(page, f.pane, 'Engine');
  const header = f.pane.locator('[data-workbench-header]');
  const workspace = f.pane.getByRole('region', { name: 'Engine 文件工作区' });
  await expect(f.pane.locator('[data-window-handoff-status]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '交接恢复包', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '安全合并并关闭', exact: true })).toHaveCount(0);
  const coarsePointer = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(coarsePointer ? 56 : 48);
  if (coarsePointer) expect((await f.pane.getByRole('button', { name: '当前会话菜单', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(36);
  const more = f.pane.getByRole('button', { name: '窗口与布局', exact: true });
  await more.focus(); await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: '窗口与布局', exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: '核对窗口归属', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(f.pane.locator('[data-window-handoff-status]')).toHaveCount(0);
  await more.click(); await menu.getByRole('button', { name: '交接恢复包', exact: true }).click();
  await expect(menu.getByRole('region', { name: '交接恢复记录' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(more).toBeFocused();
  for (const light of [false, true]) {
    await page.evaluate(async light => {
      const { themes } = await import('/src/hooks/useConfig.ts');
      const theme = themes[light ? 'light' : 'dark'];
      const root = document.querySelector<HTMLElement>('.app-root')!;
      for (const [key, value] of Object.entries(theme)) if (key !== 'name') root.style.setProperty('--theme-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value);
      root.style.setProperty('--theme-panel-solid', theme.bg); root.style.setProperty('--theme-sidebar-solid', theme.sidebarBg);
      root.style.setProperty('--theme-popover-bg', theme.bgSecondary); root.style.setProperty('--theme-panel-bg', theme.bg);
      for (const key of ['bg', 'bg-secondary', 'bg-tertiary', 'sidebar-bg']) root.style.setProperty('--theme-' + key, 'transparent');
      root.style.background = 'linear-gradient(140deg, #87bfdb, #eedba1 55%, #426252)';
      root.style.color = theme.text;
    }, light);
    const surface = await workspace.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(surface).toMatch(/^rgb\(/);
    expect(await header.evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
    await page.screenshot({ path: info.outputPath(`workbench-${light ? 'light' : 'dark'}-wallpaper.png`) });
  }
  await f.pane.locator('.ftp-row').filter({ hasText: 'hello.py' }).dblclick();
  await expect(workspace.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await workspace.locator('.cm-content').fill('unsaved visual check');
  await workspace.getByRole('button', { name: '文件与草稿操作' }).click();
  await expect(page.getByRole('dialog', { name: '文件与草稿操作' }).getByRole('button', { name: '导出草稿' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('workbench-editor.png') });
  await page.setViewportSize({ width: 650, height: 800 });
  await expect(page.locator('.awu-sidebar')).toBeHidden();
  await f.pane.getByRole('button', { name: '工程语言服务', exact: true }).click();
  const languages = page.getByRole('dialog', { name: '工程语言服务', exact: true });
  await expect(languages).toBeVisible();
  const box = (await languages.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(650);
  await page.screenshot({ path: info.outputPath('workbench-narrow-language.png') });
  await page.keyboard.press('Escape');
  await expect(f.pane.getByRole('button', { name: '工程语言服务', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 780 });
  expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workbench-phone.png') });
  expect(f.calls).not.toContain('terminalCreate'); expect(f.calls).not.toContain('languageServiceStart');
});

test('real two-window detach/attach retains dirty editor undo, input attachment and active output without send/save', async ({ context, page }) => {
  const f = await fixture(context, page);
  await selectMode(page, f.pane, 'Engine');
  await f.pane.locator('.chat-textarea').fill('未发送的窗口草稿');
  await f.pane.locator('.chat-textarea').evaluate(el => {
    (el as HTMLElement).focus(); const dt = new DataTransfer();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    dt.items.add(new File([png], 'qa.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(f.pane.getByRole('button', { name: '预览待发送图片' })).toBeVisible();
  await f.pane.locator('.ftp-row').filter({ hasText: 'hello.py' }).dblclick();
  const editor = f.pane.locator('.cm-content'); await editor.click(); await editor.press('Control+End'); await editor.pressSequentially(' # dirty');
  f.emit('原窗口流内容'); await expect(f.pane).toContainText('原窗口流内容');
  const childPromise = context.waitForEvent('page'); await f.pane.getByRole('button', { name: '分离到独立窗口', exact: true }).click();
  const child = await childPromise; await child.setViewportSize({ width: 1500, height: 950 });
  const target = child.locator(`[data-session-tab-panel="${f.sid}"]`);
  await expect(target.getByRole('button', { name: '合并回主窗口', exact: true })).toBeEnabled({ timeout: 25000 });
  await expect(target.locator('.chat-textarea')).toHaveValue('未发送的窗口草稿');
  await expect(target.getByRole('button', { name: '预览待发送图片' })).toBeVisible();
  await expect(target.locator('.cm-content')).toContainText(' # dirty');
  await expect(f.pane.locator('.awu-chat-pane')).toHaveCount(0);
  expect(child.url()).not.toContain('草稿'); expect(child.url()).not.toContain('token');
  await expect(page.getByRole('tablist', { name: '工作区标签页' })).toBeVisible();
  await expect(child.getByRole('tablist', { name: '工作区标签页' })).toHaveCount(0);
  await expect(child.locator('.awu-sidebar')).toBeHidden();
  // 列表再次选择只唤醒原子窗口，不能产生第二份可写聊天。
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText('客户工作会话 5', { exact: true }).click();
  await expect(f.pane.locator('.awu-chat-pane')).toHaveCount(0);
  expect(context.pages()).toHaveLength(2);
  child.once('dialog', dialog => dialog.accept()); page.once('dialog', dialog => dialog.accept());
  await Promise.all([page.reload(), child.reload()]);
  await expect(f.pane.locator('.awu-chat-pane')).toHaveCount(0);
  await expect(target.getByRole('button', { name: '恢复最后交接状态', exact: true })).toBeVisible();
  await expect(target.getByRole('button', { name: '合并回主窗口', exact: true })).toBeDisabled();
  await target.getByRole('button', { name: '核对窗口归属', exact: true }).click();
  await expect(target.getByRole('button', { name: '合并回主窗口', exact: true })).toBeDisabled();
  await target.getByRole('button', { name: '恢复最后交接状态', exact: true }).click();
  await expect(target.getByRole('button', { name: '合并回主窗口', exact: true })).toBeEnabled();
  await expect(target.locator('.chat-textarea')).toHaveValue('未发送的窗口草稿');
  await expect(target.getByRole('button', { name: '预览待发送图片' })).toBeVisible();
  f.emit('后续唯一片段'); await expect(target).toContainText('原窗口流内容后续唯一片段');
  const moved = target.locator('.cm-content'); await moved.click(); await moved.press('Control+z');
  await expect(moved).not.toContainText(' # dirty'); await moved.press('Control+y'); await expect(moved).toContainText(' # dirty');
  await target.locator('.chat-textarea').fill('合并后的草稿');
  await target.getByRole('button', { name: '合并回主窗口', exact: true }).click();
  await expect(f.pane.getByRole('button', { name: '分离到独立窗口', exact: true })).toBeEnabled({ timeout: 25000 });
  await expect(f.pane.locator('.chat-textarea')).toHaveValue('合并后的草稿');
  await expect(page.getByRole('tablist', { name: '工作区标签页' })).toHaveCount(0);
  await expect(page.locator('.awu-sidebar')).toBeHidden();
  await expect(f.pane.locator('.cm-content')).toContainText(' # dirty');
  await expect(f.pane.getByRole('button', { name: '预览待发送图片' })).toBeVisible();
  expect(f.calls.filter(c => c === 'workbenchPermissionGet')).toHaveLength(3);
});

test('popup blocked never prepares or hides source', async ({ context, page }) => {
  const f = await fixture(context, page); await f.pane.locator('.chat-textarea').fill('保留');
  await page.evaluate(() => { window.open = () => null; });
  await (await openSessionMenu(page, f.pane)).getByRole('button', { name: '分离到独立窗口', exact: true }).click();
  await expect(f.pane.locator('[data-window-handoff-status]')).toContainText('浏览器阻止');
  await expect(f.pane.locator('.chat-textarea')).toHaveValue('保留');
  await expect((await openSessionMenu(page, f.pane)).getByRole('button', { name: '分离到独立窗口', exact: true })).toBeEnabled();
  expect(f.windowActions).not.toContain('prepare');
});

test('keyboard detach reports slow ACK, keeps source until commit and rejects duplicate clicks', async ({ context, page }) => {
  const f = await fixture(context, page); f.delayAck();
  await f.pane.locator('.chat-textarea').fill('慢连接不丢草稿');
  const button = (await openSessionMenu(page, f.pane, true)).getByRole('button', { name: '分离到独立窗口', exact: true });
  const popup = context.waitForEvent('page'); await button.focus(); await button.press('Enter');
  const child = await popup;
  await expect.poll(() => f.windowActions.filter(a => a === 'ack').length).toBe(1);
  await openSessionMenu(page, f.pane, true);
  await expect(button).toBeDisabled();
  await button.evaluate((el: HTMLButtonElement) => el.click());
  await expect(f.pane.locator('[data-window-handoff-status]')).toContainText('等待');
  await expect(f.pane.locator('.chat-textarea')).toHaveValue('慢连接不丢草稿');
  expect(f.windowActions.filter(a => a === 'prepare')).toHaveLength(1);
  expect(f.windowActions.filter(a => a === 'commit')).toHaveLength(0);
  f.releaseAck();
  const target = child.locator(`[data-session-tab-panel="${f.sid}"]`);
  await expect((await openSessionMenu(child, target)).getByRole('button', { name: '合并回主窗口', exact: true })).toBeEnabled();
  await expect(f.pane.locator('.awu-chat-pane')).toHaveCount(0);
  await expect(target.locator('[data-workbench-header]')).toHaveCount(0);
  await child.getByRole('button', { name: '合并回主窗口', exact: true }).click();
  await expect(f.pane.locator('.chat-textarea')).toHaveValue('慢连接不丢草稿');
  await expect((await openSessionMenu(page, f.pane)).getByRole('button', { name: '分离到独立窗口', exact: true })).toBeEnabled();
  expect(f.windowActions.filter(a => a === 'prepare')).toHaveLength(2);
});

test('lost home window keeps child draft and recovery export; explicit reclaim fences former owner', async ({ context, page }) => {
  const f = await fixture(context, page);
  await f.pane.locator('.chat-textarea').fill('可靠交接草稿');
  const popup = context.waitForEvent('page'); await (await openSessionMenu(page, f.pane)).getByRole('button', { name: '分离到独立窗口', exact: true }).click();
  const child = await popup;
  const childPane = child.locator(`[data-session-tab-panel="${f.sid}"]`);
  await expect((await openSessionMenu(child, childPane)).getByRole('button', { name: '合并回主窗口', exact: true })).toBeEnabled();
  await page.close();
  await child.getByRole('button', { name: '合并回主窗口', exact: true }).click();
  await expect(child.locator('[data-window-handoff-status]')).toContainText('目标窗口未在时限内确认', { timeout: 20000 });
  await expect(child.locator('.chat-textarea')).toHaveValue('可靠交接草稿');
  await openSessionMenu(child, childPane);
  await child.getByRole('button', { name: '交接恢复包', exact: true }).click();
  const download = child.waitForEvent('download'); await child.getByRole('button', { name: '导出恢复包' }).first().click();
  expect((await download).suggestedFilename()).toMatch(/^awu-window-recovery-/);
  await child.keyboard.press('Escape');
  expect(f.windowActions.filter(a => a === 'prepare')).toHaveLength(1);
  // 新主窗口没有旧导航身份，必须显式收回而不是自动抢占。
  const recovered = await context.newPage();
  await recovered.addInitScript(() => sessionStorage.clear());
  await recovered.goto('/');
  const opener = recovered.getByRole('button', { name: '打开会话列表', exact: true }); if (await opener.isVisible()) await opener.click();
  await recovered.locator('.awu-sidebar').getByText('客户工作会话 5', { exact: true }).click();
  const target = recovered.locator(`[data-session-tab-panel="${f.sid}"]`);
  await expect(target.getByRole('button', { name: '显式收回视图归属', exact: true })).toBeVisible();
  expect(f.windowActions).not.toContain('reclaim');
  recovered.once('dialog', dialog => dialog.accept());
  await target.getByRole('button', { name: '显式收回视图归属', exact: true }).click();
  await expect((await openSessionMenu(recovered, target)).getByRole('button', { name: '分离到独立窗口', exact: true })).toBeEnabled();
  await child.getByRole('button', { name: '核对窗口归属', exact: true }).click();
  await expect((await openSessionMenu(child, childPane)).getByRole('button', { name: '合并回主窗口', exact: true })).toBeDisabled();
  expect(f.windowActions.filter(a => a === 'reclaim')).toHaveLength(1);
});

test('terminal is explicit, paste cancellable, and window/mode changes restore the same resource without input replay', async ({ context, page }) => {
  const f = await fixture(context, page, true, true);
  await selectMode(page, f.pane, 'Engine');
  await f.pane.getByRole('button', { name: '终端区域', exact: true }).click();
  const region = f.pane.getByRole('region', { name: 'Engine 终端区域' });
  await expect(region.getByRole('button', { name: '创建终端', exact: true })).toBeEnabled();
  expect(f.calls.filter(c => c === 'terminalCreate')).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept());
  await region.getByRole('button', { name: '创建终端', exact: true }).click();
  await expect(region.getByRole('button', { name: /fake · termin · running/ })).toBeVisible();
  const paste = async (root: any) => root.getByLabel('终端交互内容', { exact: true }).evaluate((el: HTMLElement) => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'echo first\necho second\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await paste(region); await expect(region.getByRole('dialog', { name: '检查终端多行粘贴' })).toBeVisible();
  expect(f.input).toEqual([]); await region.getByRole('button', { name: '取消粘贴' }).click(); expect(f.input).toEqual([]);
  await paste(region); await region.getByRole('button', { name: '确认发送' }).click();
  await expect.poll(() => f.input.join('')).toBe('echo first\necho second\n');
  await selectMode(page, f.pane, 'Chat');
  await selectMode(page, f.pane, 'Engine');
  const popup = page.waitForEvent('popup'); await f.pane.getByRole('button', { name: '分离到独立窗口', exact: true }).click();
  const child = await popup;
  await expect(child.getByRole('button', { name: '合并回主窗口', exact: true })).toBeEnabled({ timeout: 25000 });
  const childRegion = child.getByRole('region', { name: 'Engine 终端区域' });
  await expect(childRegion.getByRole('button', { name: /fake · termin · running/ })).toBeVisible();
  await expect(child.getByRole('button', { name: '工程语言服务', exact: true })).toContainText('1');
  await expect(child.getByRole('button', { name: '安全合并并关闭' })).toHaveCount(0);
  await child.getByRole('button', { name: '窗口与布局', exact: true }).click();
  await child.getByRole('button', { name: '安全合并并关闭' }).click();
  await expect(f.pane.getByRole('button', { name: '分离到独立窗口', exact: true })).toBeEnabled({ timeout: 25000 });
  expect(f.calls.filter(c => c === 'terminalCreate')).toHaveLength(1);
  expect(f.calls.filter(c => c === 'terminalStop')).toHaveLength(0); expect(f.input).toHaveLength(1);
  expect(f.calls.filter(c => c === 'languageServiceStart')).toHaveLength(0);
  await region.getByRole('button', { name: '停止所属进程树' }).click();
  await expect(region.getByRole('button', { name: '关闭已结束标签' })).toBeVisible();
});
