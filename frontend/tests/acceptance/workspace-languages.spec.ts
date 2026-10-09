import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { selectMode } from './engine-actions';

for (const remoteReadonly of [false, true]) test(`${remoteReadonly ? 'remote readonly' : 'local executor'}: explicit language trust and source-bound semantic editing`, async ({ page }) => {
  const sid = 'qa-chat-004', root = 'C:/qa/engine-language';
  const workspace = { ownerId: 'local', executorInstance: 'fixture', sessionId: sid, workingDir: root, workspaceRevision: 'a'.repeat(64) };
  let mode = 'chat', service: any = null;
  const files: Record<string, string> = { 'main.py': 'from models import greet\nvalue=greet("x")\n', 'models.py': 'def greet(name):\n    return name\n' };
  const documents = new Map<string, any>(), calls: string[] = [], starts: any[] = [], closed: string[] = [];
  const uri = (path: string) => `file:///${root}/${path}`;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.routeWebSocket(/127\.0\.0\.1:45421/, socket => {
    const server = socket.connectToServer();
    const reply = (frame: any, value: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
    socket.onMessage(message => {
      const frame = JSON.parse(String(message)); calls.push(frame.method);
      const p = frame.params[2] ? (() => { try { return JSON.parse(frame.params[2]); } catch { return {}; } })() : {};
      if (/^(sendMessage|workspaceDocumentSave|syncWriteFile|terminalCreate|loopControlRequest)$/.test(frame.method)) throw Error(`Unexpected write ${frame.method}`);
      if (frame.method === 'loadSessionMeta' && frame.params[0] === sid) return reply(frame, { id: sid, title: '客户工作会话 5', sessionType: 'normal', backendId: 'qa-primary', workingDir: root, viewMode: mode });
      if (frame.method === 'sessionWorkbenchCapabilities') return reply(frame, { status: 'ok', protocolVersion: 1, identity: workspace,
        capabilities: { viewMode: 1, documents: 1, windowHandoff: 0, terminal: 0, languageServices: 1 } });
      if (frame.method === 'updateSessionWorkbench') { mode = JSON.parse(frame.params[1]).viewMode; return reply(frame, { status: 'ok', viewMode: mode,
        summary: { id: sid, title: '客户工作会话 5', sessionType: 'normal', backendId: 'qa-primary', workingDir: root, viewMode: mode } }); }
      if (frame.method === 'languageServiceList') return reply(frame, { status: 'ok', workspace, controlRevision: 0, services: service ? [service] : [] });
      if (frame.method === 'languageServicePlan') return reply(frame, { status: 'planned', workspace, provider: 'python', config: p.config,
        planFingerprint: 'b'.repeat(64), dependencies: { pyright: '1.1.400', ruff: '0.11.13' }, effects: { projectCode: true, workspaceWrite: true, automaticDownloads: false, buildImport: false }, notice: '隔离 fake 提供器，没有创建真实进程。' });
      if (frame.method === 'languageServiceStart') {
        starts.push(p); service = { workspace, provider: 'python', resourceId: 'language', generation: 'generation', requestId: p.requestId, revision: 1,
          planFingerprint: p.planFingerprint, status: 'ready', reasonCode: '', exitConfirmed: false, config: { provider: 'python' }, dependencies: {}, activityId: 'activity',
          capabilities: { completion: true, definition: true, references: true, rename: true, format: true }, documents: [] };
        return reply(frame, service);
      }
      if (frame.method === 'languageServiceDiagnostics') return reply(frame, { status: 'ok', service, diagnostics: [...documents.values()].map(doc => ({ relativePath: doc.relativePath,
        revision: doc.revision, freshness: 'current', items: doc.relativePath === 'main.py' ? [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 2, message: 'fake 当前版本诊断', source: 'QA' }] : [], truncated: false })) });
      if (frame.method === 'languageServiceRequest') {
        let result: any = null;
        if (p.action === 'close') { documents.delete(p.relativePath); closed.push(p.relativePath); service.revision++;
          service.documents = service.documents.filter((d: any) => d.relativePath !== p.relativePath);
        } else if (p.relativePath) {
          documents.set(p.relativePath, p); service.revision++;
          service.documents = [...documents.values()].map((doc, i) => ({ relativePath: doc.relativePath, revision: doc.revision, protocolVersion: i + 1 }));
        }
        if (p.action === 'completion') result = [{ label: 'greetProject', insertText: 'greetProject', kind: 3 }];
        if (p.action === 'definition' || p.action === 'references') result = [{ uri: uri('models.py'), range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }];
        if (p.action === 'format') result = [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 16 } }, newText: 'value = greet("x")' }];
        if (p.action === 'rename') result = { changes: Object.fromEntries([...documents.values()].map(doc => {
          const offset = doc.text.indexOf('greet'), prefix = doc.text.slice(0, offset), line = prefix.split('\n').length - 1, character = offset - prefix.lastIndexOf('\n') - 1;
          return [uri(doc.relativePath), [{ range: { start: { line, character }, end: { line, character: character + 5 } }, newText: p.newName }]];
        })) };
        return reply(frame, { status: 'ok', service, revision: p.revision, result, diagnostics: [] });
      }
      if (frame.method === 'languageServiceStop') { service = { ...service, status: 'stopped', exitConfirmed: true, revision: service.revision + 1 }; return reply(frame, service); }
      if (frame.method === 'listDirectory') return reply(frame, Object.keys(files).map(name => ({ name, path: name, isDir: false })));
      if (frame.method === 'gitDetect') return reply(frame, { isRepo: false });
      if (frame.method === 'syncReadFile') return reply(frame, { status: 'ok', data: Buffer.from(files[frame.params.at(-1)] || files['main.py']).toString('base64') });
      if (frame.method === 'workspaceDocumentRead') {
        const path = frame.params[2], text = files[path];
        return reply(frame, { status: 'ok', document: { workspace, relativePath: path, source: 'executor', canonicalPath: root + '/' + path }, text,
          complete: true, editable: true, canSave: true, encoding: 'utf-8', bom: '', eol: 'lf', reasonCode: '', writeReasonCode: '', controlRevision: 0,
          byteLength: text.length, readByteLength: text.length, version: { exists: true, sha256: createHash('sha256').update(text).digest('hex'), byteLength: text.length, fileId: path, modifiedNs: '1', changedNs: '1' } });
      }
      server.send(message);
    });
    server.onMessage(message => socket.send(message));
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true }); if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText('客户工作会话 5', { exact: true }).click();
  const pane = page.locator(`[data-session-tab-panel="${sid}"]`);
  if (!remoteReadonly) await page.evaluate(() => { (window as any).__TAURI_INTERNALS__ = {}; });
  await selectMode(page, pane, 'Engine');
  await pane.getByRole('button', { name: '工程语言服务', exact: true }).click();
  const languagePanel = page.getByRole('dialog', { name: '工程语言服务', exact: true });
  expect(starts).toHaveLength(0);
  for (const label of ['执行节点 Node 可执行文件', '固定提供器 node_modules 目录', '项目 Python 解释器', 'Ruff 0.11.13 可执行文件']) await languagePanel.getByRole('textbox', { name: label, exact: true }).fill(`C:/qa/${label}`);
  await languagePanel.getByRole('button', { name: '检查依赖并生成启用计划' }).click();
  await expect(languagePanel.getByRole('button', { name: '按此计划启用' })).toBeDisabled();
  await languagePanel.getByRole('checkbox', { name: '允许此固定提供器读取项目配置并执行其分析代码' }).check();
  await languagePanel.getByRole('checkbox', { name: '允许该服务写入所列工作区/独立缓存（不是 OS 沙箱）' }).check();
  await languagePanel.getByRole('button', { name: '按此计划启用' }).click();
  await expect(languagePanel).toContainText('python · ready');
  expect(starts).toHaveLength(1); expect(starts[0].allowProjectCode).toBe(true); expect(starts[0].allowWorkspaceWrite).toBe(true);
  await page.keyboard.press('Escape');
  const tree = pane.getByRole('complementary', { name: 'Engine 文件目录' });
  await tree.locator('.ftp-row').filter({ hasText: 'main.py' }).dblclick();
  const document = pane.getByRole('region', { name: 'Engine 文件工作区' });
  await expect(document.locator('.cm-content')).toContainText('value=greet');
  if (remoteReadonly) {
    await expect(document.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(document.getByRole('button', { name: '格式化 ⇧Alt+F' })).toHaveCount(0);
    await expect(document.getByRole('button', { name: '重命名 F2' })).toHaveCount(0);
    expect(calls).not.toContain('workspaceDocumentSave');
    expect(calls).not.toContain('languageServiceRequest');
    return;
  }
  await document.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Space');
  await expect(document.getByText('greetProject', { exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await document.locator('summary').filter({ hasText: '问题 ·' }).click();
  await expect(document).toContainText('fake 当前版本诊断');
  await document.getByRole('button', { name: '格式化 ⇧Alt+F' }).click();
  await expect(document.locator('.cm-content')).toContainText('value = greet');
  await document.locator('.cm-content').click(); await page.keyboard.press('Control+z');
  await expect(document.locator('.cm-content')).toContainText('value=greet');
  await document.getByRole('button', { name: '定义 F12', exact: true }).click();
  await expect(document.locator('.cm-content')).toContainText('def greet(name)');
  page.once('dialog', dialog => dialog.accept('hello'));
  await document.getByRole('button', { name: '重命名 F2' }).click();
  const preview = document.getByRole('dialog', { name: '跨文件重命名预览' });
  await expect(preview).toContainText('2 个文件');
  await preview.getByRole('button', { name: '确认应用到全部草稿' }).click();
  await expect(document.locator('.cm-content')).toContainText('def hello(name)');
  await document.getByRole('tab').filter({ hasText: 'main.py' }).click();
  await expect(document.locator('.cm-content')).toContainText('from models import hello');
  expect(calls).not.toContain('workspaceDocumentSave');
  expect(starts).toHaveLength(1);
  await document.getByRole('button', { name: '关闭文件 main.py', exact: true }).click();
  await document.getByRole('button', { name: '放弃草稿并关闭', exact: true }).click();
  await expect.poll(() => closed).toContain('main.py');
  await tree.locator('.ftp-row').filter({ hasText: 'main.py' }).dblclick();
  await expect.poll(() => documents.has('main.py')).toBe(true);
});
