import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

// 隔离浏览器、不连接真实 Backend：核对实际窗口通信和现有渲染器。
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.routeWebSocket(/.*/, socket => socket.close());
  const page = await context.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  async function open(preview, full = false, readOnly = false) {
    const popupReady = page.waitForEvent('popup');
    await page.evaluate(async ({ preview, full, readOnly }) => {
      const { openPreviewWindow } = await import('/src/utils/previewWindow.ts');
      const identity = { ownerId: 'fixture', executorInstance: 'fake', sessionId: 'isolated', workingDir: 'test-workspace', workspaceRevision: '1' };
      window.fixtureText = preview.text || '';
      window.fixtureConflict = false;
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
            if (!conflict) window.fixtureText = input.text;
            const receipt = { status: conflict ? 'failed' : 'succeeded', reasonCode: conflict ? 'disk_conflict' : '',
              requestId: input.requestId, workspace: identity, relativePath: input.relativePath, bufferRevision: input.bufferRevision,
              version: await version(window.fixtureText) };
            receipts.set(input.requestId, receipt); return receipt;
          }, saveGet: async id => receipts.get(id) || { status: 'unknown', requestId: id },
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
    await popup.getByText(full ? '原文件预览 / 编辑' : '只读预览', { exact: false }).waitFor();
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
  await markdown.close();

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
  await linked.getByText(/pages\/second\.html · 原文件预览/).waitFor();
  assert.equal(await linked.title(), 'second.html · 预览 — AgentWithU');
  await linked.close();
  await page.evaluate(() => window.previewTest.dispose());
  const editor = await open({ rel: 'editable.md', name: 'editable.md', source: 'remote', loading: false, isMarkdown: true,
    text: '# Editable file\n\nOriginal.' }, true);
  await editor.getByRole('button', { name: '定位', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: '已在原文件窗口定位' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureRevealed), 'editable.md');
  await editor.getByRole('button', { name: '源码 / 编辑', exact: true }).click();
  const input = editor.locator('.cm-content[contenteditable="true"]');
  await input.waitFor();
  await input.fill('# Edited file\n\nSaved through original context.');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: '已保存到原文件' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureText), '# Edited file\n\nSaved through original context.');
  await editor.getByRole('button', { name: '重新加载', exact: true }).click();
  await editor.getByRole('heading', { name: 'Edited file', exact: true }).waitFor();
  await editor.getByRole('button', { name: '源码 / 编辑', exact: true }).click();
  await input.waitFor();
  await editor.getByRole('button', { name: '并排', exact: true }).click();
  await editor.getByRole('heading', { name: 'Edited file', exact: true }).waitFor();
  await page.evaluate(() => { window.fixtureConflict = true; });
  await input.fill('# Unsaved conflict');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await editor.getByRole('status').filter({ hasText: 'disk_conflict' }).first().waitFor();
  assert.equal(await page.evaluate(() => window.fixtureSaves), 2);
  assert.equal(await input.innerText(), '# Unsaved conflict');
  await editor.getByRole('button', { name: '关闭窗口', exact: true }).click();
  assert.equal(editor.isClosed(), false);
  await page.evaluate(() => window.previewTest.dispose());
  await editor.getByRole('alert').filter({ hasText: '原预览窗口已关闭' }).waitFor();
  await editor.close();
  const readonly = await open({ rel: 'readonly.md', name: 'readonly.md', source: 'remote', loading: false, isMarkdown: true, text: '# Read only' }, true, true);
  await readonly.getByRole('button', { name: '源码 / 编辑', exact: true }).click();
  await readonly.locator('.cm-content[contenteditable="false"]').waitFor();
  assert.equal(await readonly.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.fixtureSaves), 0);
  await readonly.close();
  await page.evaluate(() => window.previewTest.dispose());
  console.log('PASS: detached Markdown, theme, resize, disconnect clearing, HTML resource routing');
  console.log('PASS: source editor input, original-context save, split preview, disk conflict, close guard');
  console.log('PASS: reload saved content, original read-only policy preserved');
  console.log('PASS: HTML internal links navigate within original source');
} finally {
  await browser.close();
  await server.close();
}
