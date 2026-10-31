import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

// 隔离浏览器、不连接真实 Backend：核对实际窗口通信和现有渲染器。
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.routeWebSocket(/.*/, socket => socket.close());
  const page = await context.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  async function closeByButton(popup) {
    const closed = popup.waitForEvent('close');
    await popup.getByRole('button', { name: '关闭预览', exact: true }).click({ noWaitAfter: true }).catch(error => {
      if (!popup.isClosed()) throw error;
    });
    await closed;
  }
  async function open(preview, full = false, readOnly = false) {
    const popupReady = page.waitForEvent('popup');
    await page.evaluate(async ({ preview, full, readOnly }) => {
      const { openPreviewWindow } = await import('/src/utils/previewWindow.ts');
      const identity = { ownerId: 'fixture', executorInstance: 'fake', sessionId: 'isolated', workingDir: 'test-workspace', workspaceRevision: '1' };
      window.fixtureText = preview.text || '';
      window.fixtureConflict = false;
      window.fixtureSaveUnknown = false;
      window.fixtureResolveUnknown = false;
      window.fixtureReads = 0;
      window.fixtureSaves = 0;
      const version = async text => ({ exists: true, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join(''), byteLength: new TextEncoder().encode(text).length, fileId: 'fixture-file', modifiedNs: '1', changedNs: '1' });
      const receipts = new Map();
      const services = full ? {
        load: async rel => ({ ...preview, rel, name: rel.split('/').pop(), text: window.fixtureText }),
        reveal: async rel => { window.fixtureRevealed = rel; }, review: async rel => { window.fixtureReviewed = rel; },
        documentClient: async () => ({ identity, source: 'executor', readonly: readOnly,
          read: async rel => { window.fixtureReads++; return { status: 'ok', document: { workspace: identity, relativePath: rel, source: 'executor' },
            text: window.fixtureText, version: await version(window.fixtureText), encoding: 'utf-8', bom: '', eol: 'lf', complete: true,
            editable: !readOnly, canSave: !readOnly, reasonCode: readOnly ? 'remote_readonly' : '', writeReasonCode: readOnly ? 'remote_readonly' : '', byteLength: new TextEncoder().encode(window.fixtureText).length,
            readByteLength: new TextEncoder().encode(window.fixtureText).length, controlRevision: 0 }; },
          save: async input => {
            window.fixtureSaves++;
            const conflict = window.fixtureConflict || input.baseVersion.sha256 !== (await version(window.fixtureText)).sha256;
            if (!conflict && !window.fixtureSaveUnknown) window.fixtureText = input.text;
            const receipt = { status: window.fixtureSaveUnknown ? 'unknown' : conflict ? 'failed' : 'succeeded', reasonCode: conflict ? 'disk_conflict' : '',
              requestId: input.requestId, workspace: identity, relativePath: input.relativePath, bufferRevision: input.bufferRevision,
              version: await version(window.fixtureText) };
            receipts.set(input.requestId, receipt); return receipt;
          }, saveGet: async id => {
            const receipt = receipts.get(id) || { status: 'unknown', requestId: id };
            return receipt.status === 'unknown' && window.fixtureResolveUnknown
              ? { ...receipt, status: 'failed', reasonCode: 'fixture_not_written' } : receipt;
          },
        }),
      } : undefined;
      window.previewTest = openPreviewWindow({ preview, root: 'test-workspace', nodeLabel: '隔离测试节点', dark: true,
        theme: { '--theme-bg': '#151c27', '--theme-text': '#e2e8f0', '--theme-bg-secondary': '#202c3d', '--theme-text-muted': '#a8b1c0', '--theme-border': '#364152' },
      }, async rel => {
        window.previewResourcePath = rel;
        return new TextEncoder().encode('body { color: rgb(22, 44, 66); }');
      }, services);
      await window.previewTest.opened;
    }, { preview, full, readOnly });
    const popup = await popupReady;
    await popup.locator('.app-root[data-preview-connected="true"]').waitFor();
    await popup.locator('[data-file-preview-toolbar]').getByText(preview.name, { exact: true }).waitFor();
    return popup;
  }
  const markdown = await open({ rel: 'test.md', name: 'test.md', source: 'remote', loading: false,
    isMarkdown: true, text: '# Detached file\n\nSnapshot content.' });
  assert.equal(await markdown.getByRole('heading', { name: 'Detached file' }).count(), 1);
  assert.equal(await markdown.locator('.app-root').evaluate(element => getComputedStyle(element).color), 'rgb(226, 232, 240)');
  await markdown.setViewportSize({ width: 500, height: 400 });
  assert.equal(await markdown.getByRole('heading', { name: 'Detached file' }).isVisible(), true);
  await page.evaluate(() => window.previewTest.dispose());
  await markdown.getByRole('alert').filter({ hasText: '原预览窗口已关闭' }).waitFor();
  assert.equal(await markdown.getByRole('heading', { name: 'Detached file' }).count(), 0);
  await closeByButton(markdown);

  const html = await open({ rel: 'pages/test.html', name: 'test.html', source: 'remote', loading: false, isHtml: true,
    text: '<!doctype html><link rel="stylesheet" href="./style.css"><h1>Detached HTML</h1>' });
  const heading = html.frameLocator('iframe[title="HTML 页面预览"]').getByRole('heading', { name: 'Detached HTML' });
  await heading.waitFor();
  assert.equal(await heading.evaluate(element => getComputedStyle(element).color), 'rgb(22, 44, 66)');
  assert.equal(await page.evaluate(() => window.previewResourcePath), 'pages/style.css');
  await html.close();
  await page.evaluate(() => window.previewTest.dispose());
  const linked = await open({ rel: 'pages/first.html', name: 'first.html', source: 'remote', loading: false, isHtml: true,
    text: '<!doctype html><h1>Linked preview</h1><a href="./second.html">Second file</a>' }, true);
  await linked.frameLocator('iframe[title="HTML 页面预览"]').getByRole('link', { name: 'Second file' }).click();
  await linked.locator('[data-file-preview-toolbar]').getByText('second.html', { exact: true }).waitFor();
  assert.equal(await linked.title(), 'second.html · 预览 — AgentWithU');
  await linked.close();
  await page.evaluate(() => window.previewTest.dispose());
  const editor = await open({ rel: 'editable.md', name: 'editable.md', source: 'remote', loading: false, isMarkdown: true,
    text: '# Editable file\n\nOriginal.' }, true);
  await editor.setViewportSize({ width: 1100, height: 800 });
  assert.equal(await editor.locator('[data-file-preview-toolbar]').evaluate(el => el.getBoundingClientRect().height), 42);
  assert.equal(await editor.getByRole('button', { name: '✏️ 编辑', exact: true }).evaluate(el => getComputedStyle(el).fontSize), '11px');
  assert.equal(await editor.getByRole('button', { name: '✏️ 编辑', exact: true }).evaluate(el => !!el.closest('[data-file-preview-toolbar]')), true);
  await editor.screenshot({ path: '../downloads/detached-preview-toolbar-fixed.png' });
  await editor.setViewportSize({ width: 400, height: 500 });
  const closeBounds = await editor.getByRole('button', { name: '关闭预览', exact: true }).boundingBox();
  assert.ok(closeBounds.x >= 0 && closeBounds.x + closeBounds.width <= 400);
  assert.equal(await editor.locator('[data-file-preview-toolbar]').evaluate(el => el.getBoundingClientRect().height), 42);
  await editor.screenshot({ path: '../downloads/detached-preview-toolbar-narrow.png' });
  await editor.setViewportSize({ width: 1100, height: 800 });
  await editor.getByRole('button', { name: '📂 定位', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: '已在原文件窗口定位' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureRevealed), 'editable.md');
  await editor.getByRole('button', { name: '</> 源码', exact: true }).click();
  await editor.locator('.cm-content[contenteditable="false"]').waitFor();
  await editor.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  const input = editor.locator('.cm-content[contenteditable="true"]');
  await input.waitFor();
  await input.fill('# Edited file\n\nSaved through original context.');
  await editor.getByRole('button', { name: '💾 保存', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: '已保存到原文件' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureText), '# Edited file\n\nSaved through original context.');
  await editor.getByRole('button', { name: '预览窗口操作', exact: true }).click();
  await editor.getByRole('button', { name: '↻ 重新加载', exact: true }).click();
  await editor.getByRole('heading', { name: 'Edited file', exact: true }).waitFor();
  await editor.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  await input.waitFor();
  await editor.getByRole('button', { name: '并排', exact: true }).click();
  await editor.getByRole('heading', { name: 'Edited file', exact: true }).waitFor();
  await page.evaluate(() => { window.fixtureConflict = true; });
  await input.fill('# Unsaved conflict');
  await editor.getByRole('button', { name: '💾 保存', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: 'disk_conflict' }).first().waitFor();
  assert.equal(await page.evaluate(() => window.fixtureSaves), 2);
  assert.equal(await input.innerText(), '# Unsaved conflict');
  await editor.getByRole('button', { name: '关闭预览', exact: true }).click();
  assert.equal(editor.isClosed(), false);
  await page.evaluate(() => window.previewTest.dispose());
  await editor.getByRole('alert').filter({ hasText: '原预览窗口已关闭' }).waitFor();
  await editor.close();
  const readonly = await open({ rel: 'readonly.md', name: 'readonly.md', source: 'remote', loading: false, isMarkdown: true, text: '# Read only' }, true, true);
  await readonly.getByRole('button', { name: '</> 源码', exact: true }).click();
  await readonly.locator('.cm-content[contenteditable="false"]').waitFor();
  assert.equal(await readonly.getByRole('button', { name: '💾 保存', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.fixtureSaves), 0);
  await readonly.close();
  await page.evaluate(() => window.previewTest.dispose());
  // 使用实际 Tauri JS SDK 和仓库能力清单，模拟原生关闭事件而非直接 page.close。
  // 权限缺失时真实 SDK 的 destroy 路径必须失败，此测试能回归原来的“关不掉”。
  const capability = JSON.parse(readFileSync('../src-tauri/capabilities/file-preview.json', 'utf8'));
  assert.deepEqual(capability.windows, ['file-preview-*']);
  await context.addInitScript(({ permissions }) => {
    let serial = 0, maximized = false;
    const callbacks = new Map(), listeners = new Map();
    const label = `file-preview-${new URLSearchParams(location.search).get('filePreview')}`;
    window.nativeCommands = [];
    window.nativeDestroyDenied = false;
    const emit = async event => {
      for (const [id, entry] of [...listeners]) {
        if (entry.event === event) await callbacks.get(entry.handler)?.({ event, id, payload: {} });
      }
    };
    window.fixtureNativeClose = () => emit('tauri://close-requested');
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label }, currentWebview: { label } },
      transformCallback: callback => { const id = ++serial; callbacks.set(id, callback); return id; },
      unregisterCallback: id => callbacks.delete(id),
      invoke: async (command, args = {}) => {
        window.nativeCommands.push(command);
        if (command === 'plugin:event|listen') { const id = ++serial; listeners.set(id, args); return id; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
        if (command.startsWith('plugin:window|')) {
          const action = command.split('|')[1];
          if (args.label !== label) throw new Error('Unexpected window target');
          if (!permissions.includes(`core:window:allow-${action.replaceAll('_', '-')}`)) throw new Error(`Denied: ${action}`);
          if (action === 'close') return emit('tauri://close-requested');
          if (action === 'destroy') {
            if (window.nativeDestroyDenied) throw new Error('fixture destroy denied');
            window.close(); return;
          }
          if (action === 'is_maximized') return maximized;
          if (action === 'toggle_maximize') { maximized = !maximized; return emit('tauri://resize'); }
          if (action === 'set_always_on_top') return;
        }
        if (command === 'plugin:webview|set_webview_zoom' || command === 'report_desktop_log') return;
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  }, { permissions: capability.permissions });
  const desktop = await open({ rel: 'desktop.md', name: 'desktop.md', source: 'remote', loading: false, isMarkdown: true,
    text: '# Native close' }, true);
  assert.equal(await desktop.evaluate(() => typeof window.__TAURI_INTERNALS__?.invoke), 'function');
  await desktop.getByRole('button', { name: '⛶ 最大化', exact: true }).click();
  await desktop.getByRole('button', { name: '🗗 还原', exact: true }).waitFor();
  await desktop.evaluate(() => { window.nativeDestroyDenied = true; });
  await desktop.getByRole('button', { name: '关闭预览', exact: true }).click();
  await desktop.getByRole('alert').filter({ hasText: '关闭窗口失败' }).waitFor();
  assert.equal(desktop.isClosed(), false);
  await desktop.evaluate(() => { window.nativeDestroyDenied = false; });
  await closeByButton(desktop);
  assert.equal(page.isClosed(), false);

  const guarded = await open({ rel: 'guarded.md', name: 'guarded.md', source: 'remote', loading: false, isMarkdown: true,
    text: '# Guarded native close' }, true);
  await guarded.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  await guarded.locator('.cm-content[contenteditable="true"]').fill('# Keep my draft');
  await guarded.evaluate(() => window.fixtureNativeClose()).catch(error => { if (!guarded.isClosed()) throw error; });
  await guarded.getByRole('status').filter({ hasText: '文档存在未保存改动' }).waitFor();
  assert.equal(await guarded.evaluate(() => window.nativeCommands.includes('plugin:window|destroy')), false);
  await guarded.getByRole('button', { name: '💾 保存', exact: true }).click();
  await guarded.getByRole('status').filter({ hasText: '已保存到原文件' }).waitFor();
  const nativeClosed = guarded.waitForEvent('close');
  await guarded.evaluate(() => window.fixtureNativeClose());
  await nativeClosed;
  assert.equal(await page.evaluate(() => window.fixtureText), '# Keep my draft');
  assert.equal(page.isClosed(), false);
  const uncertain = await open({ rel: 'uncertain.md', name: 'uncertain.md', source: 'remote', loading: false, isMarkdown: true,
    text: '# Original uncertain' }, true);
  await uncertain.getByRole('button', { name: '✏️ 编辑', exact: true }).click();
  const uncertainInput = uncertain.locator('.cm-content[contenteditable="true"]');
  await uncertainInput.fill('# Pending write');
  await page.evaluate(() => { window.fixtureSaveUnknown = true; });
  await uncertain.getByRole('button', { name: '💾 保存', exact: true }).click();
  await uncertain.getByRole('status').filter({ hasText: '保存结果未确认' }).waitFor();
  // 即使编辑回原文（dirty=false），结果未知的请求也不能被关闭绕过。
  await uncertainInput.fill('# Original uncertain');
  assert.equal(await uncertain.evaluate(async () => {
    const { documentStore } = await import('/src/utils/documentStore.ts');
    return documentStore.all().find(doc => doc.identity.relativePath === 'uncertain.md').dirty;
  }), false);
  await uncertain.getByRole('button', { name: '关闭预览', exact: true }).click();
  await uncertain.getByRole('status').filter({ hasText: '文档存在未保存改动' }).waitFor();
  await uncertain.evaluate(() => window.fixtureNativeClose());
  assert.equal(await uncertain.evaluate(() => window.nativeCommands.includes('plugin:window|destroy')), false);
  await page.evaluate(() => { window.fixtureResolveUnknown = true; });
  await uncertain.getByRole('button', { name: '核对保存', exact: true }).click();
  await uncertain.getByRole('status').filter({ hasText: 'fixture_not_written' }).first().waitFor();
  assert.equal(await page.evaluate(() => window.fixtureSaves), 1);
  await closeByButton(uncertain);
  console.log('PASS: detached Markdown, theme, resize, disconnect clearing, HTML resource routing');
  console.log('PASS: source editor input, original-context save, split preview, disk conflict, close guard');
  console.log('PASS: reload saved content, original read-only policy preserved');
  console.log('PASS: HTML internal links navigate within original source');
  console.log('PASS: shared single-row toolbar, narrow close visibility, source/read-only versus edit');
  console.log('PASS: Tauri SDK + capability checked close/destroy, native X guard, save then close, failure feedback and retry');
  console.log('PASS: unknown save blocks both close paths even with a clean buffer; reconciliation never retries the write');
} finally {
  await browser.close();
  await server.close();
}
