import { test, expect, type Page } from '@playwright/test';
import { docxBytes, pdfBytes, excelFixture, drawioXml, drawioFallback } from './preview-fixtures';

export async function mountPreview(page: Page, kind = 'excel', width = 390, hostWidth = width, host = 'component', height = 700) {
  await page.setViewportSize({ width, height });
  await page.routeWebSocket(/.*/, s => s.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}</style><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></html>' });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async ({ kind, hostWidth, docx, pdf, excel, host, height, drawioXml, drawioFallback }) => {
    const { React: R, createRoot } = await import('/tests/engine/react-harness.ts');
    const { FilePreviewToolbar } = await import('/src/components/FilePreviewToolbar.tsx');
    const { StructuredFilePreview } = await import('/src/components/StructuredFilePreview.tsx');
    const { MarkdownStyles } = await import('/src/components/MarkdownStyles.tsx');
    const m = (type: any, props: any = {}, ...children: any[]) => R.createElement(type, props, ...children);
    (window as any).previewFixture = { closed: false, copied: '', calls: [] as string[] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).previewFixture.copied = text; } } });
    let content;
    if (kind === 'excel') content = m(StructuredFilePreview, { preview: excel });
    else if (kind === 'docx') content = m((await import('/src/components/DocxPreview.tsx')).default, { data: new Uint8Array(docx) });
    else if (kind === 'pdf') content = m((await import('/src/components/PdfPreview.tsx')).default, { data: new Uint8Array(pdf) });
    else if (kind === 'drawio') content = m((await import('/src/components/DrawioPreview.tsx')).default, { xml: drawioXml, fallback: drawioFallback });
    else if (kind === 'word') content = m(StructuredFilePreview, { preview: { status: 'ok', kind: 'word', blocks: [{ type: 'paragraph', text: 'Word compatibility ' .repeat(100) }, { type: 'table', rows: [Array(15).fill('widecell')] }] } });
    else if (kind === 'ppt') content = m(StructuredFilePreview, { preview: { status: 'ok', kind: 'powerpoint', slides: [{ number: 1, title: 'PPT fixture', texts: ['title', 'long '.repeat(400)], images: [] }] } });
    else if (kind === 'markdown') content = m((await import('/src/components/MarkdownPreview.tsx')).default, { source: '# First\n\n' + 'paragraph\n\n'.repeat(90) + '## Last\n\nend', title: 'Long markdown title' });
    else if (kind === 'html') content = m((await import('/src/components/HtmlPreview.tsx')).default, { source: '<h1>HTML fixture</h1><input aria-label="Page input"><p style="height:1500px">long</p>', rel: 'index.html', root: 'C:/fixture', nodeLabel: 'test', readFile: async () => new Uint8Array(), onNavigate: () => {}, onReveal: () => {} });
    else if (kind === 'image') content = m('img', { alt: 'Image fixture', src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="teal"/></svg>'), style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } });
    else content = m('pre', { style: { overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, 'const text = "selectable";\n'.repeat(100));
    const theme = { '--theme-text': '#ddd', '--theme-text-muted': '#aaa', '--theme-bg-secondary': '#161b22', '--theme-bg-tertiary': '#222', '--theme-border': '#444' };
    const root = createRoot(document.getElementById('root')!);
    (window as any).previewFixture.unmount = () => root.unmount();
    if (host !== 'component') {
      const ext = kind.startsWith('excel-') ? 'xlsx' : kind === 'text-edit' ? 'txt' : kind === 'docx-broken' ? 'docx' : ({ excel: 'xlsx', word: 'doc', ppt: 'pptx', markdown: 'md', image: 'svg', text: 'txt' } as any)[kind] || kind;
      const name = 'Very long file name 文档'.repeat(3) + '.' + ext;
      const structured = kind === 'drawio' ? drawioFallback : kind === 'excel-empty' ? { status: 'ok', kind: 'excel', sheets: [] } : kind === 'excel-error' ? { status: 'error', kind: 'excel', message: 'Fixture parse failure' } : kind === 'excel-unsupported' ? { status: 'unsupported', kind: 'legacy-office', message: 'Fixture unsupported' } : kind === 'excel' ? excel : kind === 'word' || kind === 'docx-broken' ? { status: 'ok', kind: 'word', blocks: [{ type: 'paragraph', text: 'Word compatibility '.repeat(200) }, { type: 'table', rows: [Array(15).fill('widecell')] }] }
        : kind === 'ppt' ? { status: 'ok', kind: 'powerpoint', slides: [{ number: 1, title: 'PPT fixture', texts: ['title', 'long '.repeat(400)], images: [] }] } : undefined;
      const text = kind === 'markdown' ? '# First\n\n' + 'paragraph\n\n'.repeat(90) + '## Last\n\nend' : kind === 'html' ? '<h1>HTML fixture</h1><input aria-label="Page input">' : kind === 'image' ? '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="teal"/></svg>' : 'selectable source\n'.repeat(100);
      const bytes = new Uint8Array(kind === 'docx' ? docx : kind === 'pdf' ? pdf : new TextEncoder().encode(kind === 'drawio' ? drawioXml : text));
      const encoded = btoa(Array.from(bytes, v => String.fromCharCode(v)).join(''));
      const preview = { name, rel: name, source: 'remote', loading: false, structured, bytes,
        renderer: ['docx', 'pdf', 'drawio'].includes(kind) ? kind : undefined, drawioXml, text, isMarkdown: kind === 'markdown', isHtml: kind === 'html', isImage: kind === 'image', dataUrl: 'data:image/svg+xml;base64,' + encoded };
      if (host === 'detached') {
        history.replaceState(null, '', '?filePreview=isolated-preview');
        const bc = new BroadcastChannel('awu-file-preview-isolated-preview');
        const { getCurrentUserProfile } = await import('/src/api.ts');
        const identity = { ownerId: getCurrentUserProfile().userId, executorInstance: 'detached-fixture', sessionId: 'preview-test', workingDir: '/fixture', workspaceRevision: 'a'.repeat(64) };
        bc.onmessage = ({ data }) => {
          if (data.kind === 'ready') bc.postMessage({ kind: 'snapshot', snapshot: { preview, theme, root: '/fixture', nodeLabel: 'Original test node', dark: true, initialView: kind === 'text-edit' ? 'source' : 'preview' }, fullDocument: kind === 'text-edit' });
          else {
            (window as any).previewFixture.calls.push(data.method || data.kind);
            if (data.method === 'document') bc.postMessage({ kind: 'result', id: data.id, result: { identity, source: 'executor', readonly: false } });
            if (data.method === 'read') bc.postMessage({ kind: 'result', id: data.id, result: { status: 'ok', document: { workspace: identity, relativePath: name, canonicalPath: '/fixture/' + name, source: 'executor' }, version: { exists: true, sha256: 'a'.repeat(64), fileId: name, modifiedNs: '1', changedNs: '1', byteLength: bytes.length }, complete: true, byteLength: bytes.length, readByteLength: bytes.length, text, encoding: 'utf-8', bom: '', eol: 'lf', editable: true, canSave: true, controlRevision: 0 } });
          }
        };
        (window as any).previewFixture.disconnect = () => bc.postMessage({ kind: 'disconnected' });
        window.close = () => { (window as any).previewFixture.closed = true; };
        root.render(m((await import('/src/components/FilePreviewWindow.tsx')).FilePreviewWindow));
        return;
      }
      const { api, getCurrentUserProfile } = await import('/src/api.ts');
      const { FileTreePanel } = await import('/src/components/FileTreePanel.tsx');
      api.onSessionConnectionStatus = (_: string, cb: any) => { cb(true); return () => {}; };
      api.listDirectory = async () => [{ name, path: name, isDir: false, size: bytes.length }];
      api.gitDetect = async () => ({ isRepo: false });
      api.syncReadFile = async () => { (window as any).previewFixture.calls.push('read'); return { status: 'ok', data: encoded }; };
      api.syncFileStat = async () => ({ status: 'ok', size: bytes.length });
      api.syncReadChunk = async () => { (window as any).previewFixture.calls.push('chunk'); return { status: 'ok', data: encoded }; };
      api.filePreview = async () => { (window as any).previewFixture.calls.push('parse'); return kind === 'excel-loading' ? new Promise(() => {}) : structured; };
      api.syncWriteFile = async () => { (window as any).previewFixture.calls.push('WRITE'); throw new Error('Unexpected write'); };
      const workspace = { ownerId: getCurrentUserProfile().userId, executorInstance: 'fake-node', sessionId: 'preview-test', workingDir: '/fixture', workspaceRevision: 'a'.repeat(64) };
      api.workspaceDocuments = async () => ({ identity: workspace, source: 'executor', readonly: true, read: async () => ({ status: 'ok', document: { workspace, relativePath: name, canonicalPath: '/fixture/' + name, source: 'executor' }, version: { exists: true, sha256: 'a'.repeat(64), byteLength: bytes.length }, complete: true, byteLength: bytes.length, readByteLength: bytes.length, encoding: 'utf-8', eol: 'lf', text, editable: false, canSave: false, reasonCode: 'remote_readonly' }) });
      const holder = document.createElement('div'); holder.id = 'engine-preview-host';
      holder.style.cssText = `display:flex;flex-direction:column;width:${hostWidth}px;height:${height - 20}px;min-width:0;min-height:0;position:absolute;right:0;top:0;background:#161b22`;
      for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(key, value);
      if (host === 'engine') document.body.append(holder);
      root.render(m(FileTreePanel, { sessionId: 'preview-test', workingDir: '/fixture', execKey: 'fake-node', execMode: 'relay', documentHost: host === 'engine' ? holder : undefined }));
      return;
    }
    root.render(m('div', { className: 'app-root', id: 'preview-host', style: { width: hostWidth, height: height - 60, display: 'flex', flexDirection: 'column', overflow: 'hidden', ...theme } },
      m(MarkdownStyles), m(FilePreviewToolbar, { name: 'Very long file name 文件名文档.' + kind, relativePath: 'folder/'.repeat(15) + 'file.' + kind, source: 'remote', nodeLabel: 'Long node name', icon: '▤',
        trailing: m(R.Fragment, {}, m('button', { onClick: () => {} }, '最大化'), m('button', { 'aria-label': '关闭预览', onClick: () => { (window as any).previewFixture.closed = true; } }, '×')) }, m('button', {}, '定位'), m('button', {}, '独立窗口')),
      m('div', { id: 'preview-content', style: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' } }, content)));
  }, { kind, hostWidth, docx: docxBytes(), pdf: pdfBytes(), excel: excelFixture, host, height, drawioXml, drawioFallback });
  if (host === 'chat' || host === 'engine') await page.locator('.ftp-row').first().dblclick();
  await expect(page.locator('[data-file-preview-toolbar]')).toBeVisible();
}

for (const width of [320, 360, 390]) test(`excel mouse pan and close ${width}`, async ({ page }) => {
  await mountPreview(page, 'excel', width);
  await expect(page.getByRole('table')).toBeVisible();
  const grid = page.getByRole('table').locator('..');
  const box = (await grid.boundingBox())!;
  await page.mouse.move(box.x + 220, box.y + 180); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 80, { steps: 8 }); await page.mouse.up();
  console.log('EXCEL_GEOMETRY', width, await page.getByLabel('关闭预览').boundingBox(), await grid.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop })));
  expect(await grid.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  expect(await grid.evaluate(el => el.scrollTop)).toBeGreaterThan(80);
  await closeHit(page);
});

for (const kind of ['docx', 'pdf', 'word', 'ppt', 'markdown', 'html', 'image', 'text']) test(`renderer ${kind}`, async ({ page }) => {
  await mountPreview(page, kind, 360);
  if (kind === 'docx') await expect(page.locator('section.awu-docx').first()).toBeVisible();
  if (kind === 'pdf') { await expect(page.getByText('第 1 / 2 页', { exact: true })).toBeVisible(); await expect(page.getByText('正在渲染第 1 页…')).toHaveCount(0); }
  if (kind === 'html') await expect(page.frameLocator('iframe').getByText('HTML fixture')).toBeVisible();
  console.log('RENDERER_GEOMETRY', kind, await page.locator('#preview-content').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight })));
});

async function closeHit(page: Page, label = '关闭预览') {
  const close = page.getByLabel(label, { exact: true });
  const box = (await close.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await close.evaluate(el => { const r = el.getBoundingClientRect(); return [[r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2], [r.left + r.width / 2, r.top + r.height / 2]].every(([x, y]) => el.contains(document.elementFromPoint(x, y))); })).toBe(true);
  await close.click();
}

const formats = ['excel', 'docx', 'pdf', 'word', 'ppt', 'markdown', 'html', 'image', 'text', 'drawio'];
for (const host of ['chat', 'engine', 'detached']) for (const kind of formats) test(`${host} ${kind} real host narrow close`, async ({ page }, info) => {
  for (const width of [320, 360, 390]) {
    await mountPreview(page, kind, host === 'engine' ? 1100 : width, width, host);
    if (kind === 'excel') await expect(page.locator('[data-excel-grid]')).toBeVisible();
    if (kind === 'docx') await expect(page.locator('section.awu-docx').first()).toBeVisible();
    if (kind === 'pdf') { await expect(page.getByText('第 1 / 2 页', { exact: true })).toBeVisible(); await expect(page.getByText('正在渲染第 1 页…')).toHaveCount(0); }
    if (kind === 'markdown') await expect(page.locator('.awu-md-document')).toContainText('First');
    if (kind === 'html') await expect(page.frameLocator('iframe').getByText('HTML fixture')).toBeVisible();
    const reading = page.locator('[data-preview-reading]');
    expect(await reading.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    if (host === 'chat') expect((await page.locator('[data-preview-surface]').boundingBox())!.width).toBe(width);
    if (width === 360 && ['excel', 'docx', 'pdf', 'ppt'].includes(kind)) await page.screenshot({ path: info.outputPath(`${host}-${kind}.png`) });
    const calls = await page.evaluate(() => (window as any).previewFixture.calls.slice());
    await page.setViewportSize({ width: host === 'engine' ? 1100 : 620, height: 320 });
    await closeHit(page, host === 'engine' ? '关闭当前文件' : '关闭预览');
    if (host === 'detached') expect(await page.evaluate(() => (window as any).previewFixture.closed)).toBe(true);
    else await expect(page.locator('[data-preview-surface]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).previewFixture.calls)).toEqual(calls);
  }
});

test('Excel click suppression, capture cancellation, local keyboard and tools preserve state', async ({ page }) => {
  await mountPreview(page, 'excel', 1100, 360);
  const grid = page.locator('[data-excel-grid]');
  const selection = () => page.locator('[data-cell]').evaluateAll(els => els.find(e => (e as HTMLElement).style.outline)?.getAttribute('data-cell'));
  await grid.locator('[data-cell="B2"]').click(); expect(await selection()).toBe('B2');
  const box = (await grid.boundingBox())!;
  const drag = async () => { await page.mouse.move(box.x + 290, box.y + 160); await page.mouse.down(); await page.mouse.move(box.x + 160, box.y + 70, { steps: 6 }); };
  await drag(); await page.mouse.up(); expect(await selection()).toBe('B2');
  await grid.locator('[data-cell="A1"]').click(); expect(await selection()).toBe('A1');
  for (const event of ['pointercancel', 'blur']) {
    await drag(); await page.evaluate(event => window.dispatchEvent(new Event(event)), event); await page.mouse.up();
    expect(await grid.evaluate(e => getComputedStyle(e).cursor)).toBe('grab');
    await grid.locator('[data-cell="A1"]').click(); expect(await selection()).toBe('A1');
  }
  await page.getByRole('button', { name: '查找 / 缩放' }).click();
  const search = page.getByPlaceholder('在当前工作表查找'); await search.fill('value 80:20');
  const copied = await page.evaluate(() => (window as any).previewFixture.copied);
  await search.press('Control+a'); await search.press('Control+c');
  expect(await page.evaluate(() => (window as any).previewFixture.copied)).toBe(copied);
  await search.press('Enter'); expect(await selection()).toBe('U80');
  expect(await grid.evaluate(e => e.scrollTop)).toBeGreaterThan(500);
  const rect = await grid.locator('[data-cell="U80"]').boundingBox(); expect(rect!.x).toBeGreaterThan(box.x + 46);
  await grid.focus(); await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => (window as any).previewFixture.copied)).toBe('value 80:20');
  await page.keyboard.press('ArrowDown'); expect(await selection()).toBe('U81');
  await page.getByTitle('缩放', { exact: true }).selectOption('125');
  await page.locator('#preview-host').evaluate(e => (e as HTMLElement).style.width = '850px');
  await expect(search).toHaveValue('value 80:20');
  await expect(page.getByTitle('缩放', { exact: true })).toHaveValue('125');
  await page.locator('#preview-host').evaluate(e => (e as HTMLElement).style.width = '360px');
  await page.getByRole('button', { name: '内容', exact: true }).click();
  await expect(page.getByRole('region', { name: '单元格完整内容' })).toContainText('value 81:20');
  await page.getByRole('button', { name: '复制完整内容' }).click();
  expect(await page.evaluate(() => (window as any).previewFixture.copied)).toBe('value 81:20');
  await page.getByRole('button', { name: '收起内容' }).click();
  await page.getByTitle('Sheet 8 很长的工作表名称', { exact: true }).click();
  await expect(page.getByRole('table')).toHaveAttribute('aria-label', '工作表 Sheet 8 很长的工作表名称');
  expect(await grid.evaluate(e => [e.scrollLeft, e.scrollTop])).toEqual([0, 0]);
  await page.evaluate(() => (window as any).previewFixture.unmount());
  await page.mouse.move(0, 0); await page.mouse.up();
});

test('Excel long content and uncached formula remain readable and copied verbatim', async ({ page }) => {
  await mountPreview(page);
  await page.getByRole('button', { name: '内容', exact: true }).click();
  await expect(page.getByRole('region')).toContainText('Long content '.repeat(80).trim());
  await page.getByRole('button', { name: '复制完整内容' }).click();
  expect(await page.evaluate(() => (window as any).previewFixture.copied)).toBe('Long content '.repeat(80));
  await page.getByRole('button', { name: '收起内容' }).click();
  await page.locator('[data-cell="B3"]').click();
  await page.getByRole('button', { name: '内容', exact: true }).click();
  await expect(page.getByRole('region')).toContainText('文件未保存计算结果');
  await page.getByRole('button', { name: '复制完整内容' }).click();
  expect(await page.evaluate(() => (window as any).previewFixture.copied)).toBe('=SUM(A1:A2)');
});

test('native touch scroll keeps Excel selection and outer page, then tap selects', async ({ page, context }) => {
  await mountPreview(page, 'excel', 390);
  const client = await context.newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const grid = page.locator('[data-excel-grid]'), box = (await grid.boundingBox())!;
  await grid.locator('[data-cell="B2"]').click();
  for (const [dx, dy] of [[120, 0], [0, 110], [100, 90]]) {
    const before = await grid.evaluate(e => [e.scrollLeft, e.scrollTop]);
    const x = box.x + 300, y = box.y + 230;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - dx * i / 8, y: y - dy * i / 8 }] }); await page.waitForTimeout(20); }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => grid.evaluate(e => e.scrollLeft + e.scrollTop)).toBeGreaterThan(before[0] + before[1] + 30);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await grid.locator('[data-cell="B2"]').evaluate(e => (e as HTMLElement).style.outline)).not.toBe('');
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 80, y: box.y + 40 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => grid.locator('[data-cell="A1"]').evaluate(e => (e as HTMLElement).style.outline)).not.toBe('');
  await closeHit(page);
});

for (const kind of ['docx', 'pdf']) test(`${kind} fit width, manual zoom, pan and resize preserve loaded document`, async ({ page }) => {
  await mountPreview(page, kind, 390);
  const scroller = page.locator(kind === 'docx' ? '[data-docx-scroll]' : '[data-pdf-scroll]');
  const paper = page.locator(kind === 'docx' ? 'section.awu-docx' : 'canvas').first();
  await expect(paper).toBeVisible();
  await expect.poll(() => scroller.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(2);
  await paper.evaluate(e => (window as any).originalPaper = e);
  await page.getByLabel(kind === 'docx' ? 'Word 缩放' : 'PDF 缩放').selectOption('1.5');
  if (kind === 'docx') await page.getByRole('button', { name: '选择文字' }).click();
  await expect.poll(() => scroller.evaluate(e => e.scrollWidth)).toBeGreaterThan(900);
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + 290, box.y + 190); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 70, { steps: 8 }); await page.mouse.up();
  expect(await scroller.evaluate(e => e.scrollLeft)).toBeGreaterThan(100);
  expect(await scroller.evaluate(e => e.scrollTop)).toBeGreaterThan(70);
  await page.locator('#preview-host').evaluate(e => (e as HTMLElement).style.width = '320px');
  await expect(page.getByLabel(kind === 'docx' ? 'Word 缩放' : 'PDF 缩放')).toHaveValue('1.5');
  expect(await paper.evaluate(e => e === (window as any).originalPaper)).toBe(true);
  if (kind === 'pdf') { await page.getByLabel('下一页').click(); await expect(page.getByText('第 2 / 2 页')).toBeVisible(); await expect(page.locator('canvas')).toHaveCount(1); }
});

test('Markdown narrow pane TOC is local and HTML short pane controls remain usable', async ({ page }) => {
  await mountPreview(page, 'markdown', 1100, 320);
  await expect(page.locator('.awu-md-toc')).toHaveCSS('position', 'absolute');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开目录' })).toBeVisible();
  await expect.poll(() => page.locator('.awu-md-document-scroll').evaluate(e => e.scrollTop)).toBeGreaterThan(500);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await mountPreview(page, 'html', 360, 360, 'component', 320);
  const input = page.frameLocator('iframe').getByLabel('Page input');
  await input.fill('retained'); await expect(input).toHaveValue('retained');
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await closeHit(page);
});

test('legacy detached protocol remains explicit and protected', async ({ page }) => {
  await mountPreview(page, 'excel', 360, 360, 'detached');
  await expect(page.locator('[data-excel-grid]')).toBeVisible();
  await page.evaluate(() => (window as any).previewFixture.disconnect());
  await expect(page.getByRole('alert')).toContainText('旧版代理预览');
  await closeHit(page);
});

for (const kind of ['excel-loading', 'excel-empty', 'excel-error', 'excel-unsupported', 'docx-broken']) test(`Chat ${kind} remains closable`, async ({ page }) => {
  await mountPreview(page, kind, 320, 320, 'chat');
  if (kind === 'docx-broken') await expect(page.getByText('Word compatibility', { exact: false })).toBeVisible();
  if (kind === 'excel-empty') await expect(page.getByText('工作簿没有可显示的数据')).toBeVisible();
  if (kind === 'excel-error') await expect(page.getByText('Fixture parse failure')).toBeVisible();
  if (kind === 'excel-unsupported') await expect(page.getByText('Fixture unsupported')).toBeVisible();
  await closeHit(page); await expect(page.locator('[data-preview-surface]')).toHaveCount(0);
});

test('Word default mouse selects text and mode toggle does not reparse', async ({ page }) => {
  await mountPreview(page, 'docx', 1000, 900);
  const paragraph = page.locator('section.awu-docx p').first(); await expect(paragraph).toBeVisible();
  const box = (await paragraph.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Word');
  await page.getByRole('button', { name: '选择文字' }).click();
  await page.getByRole('button', { name: '手形浏览' }).click();
  await expect(paragraph).toBeVisible();
});

test('Drawio official and compatibility retain pan, zoom and Sheet', async ({ page }) => {
  await mountPreview(page, 'drawio', 360);
  const frame = page.frameLocator('iframe');
  const graph = frame.locator('svg').first(); await expect(graph).toBeVisible();
  const g = frame.locator('svg g').first(); const before = await g.getAttribute('transform');
  const box = (await graph.boundingBox())!;
  await page.mouse.move(box.x + 240, box.y + 180); await page.mouse.down(); await page.mouse.move(box.x + 170, box.y + 120, { steps: 6 }); await page.mouse.up();
  await expect(g).not.toHaveAttribute('transform', before || '');
  await page.getByTitle('放大', { exact: true }).click();
  await page.getByTitle('Page 2', { exact: true }).click(); await expect(page.locator('iframe')).toHaveAttribute('title', 'Draw.io Page 2');
  await page.getByRole('button', { name: '兼容预览', exact: true }).click();
  const image = page.getByRole('img', { name: 'Page 2' }); await expect(image).toBeVisible();
  const area = image.locator('..'), a = (await area.boundingBox())!;
  const initial = await image.evaluate(e => (e as HTMLElement).style.transform);
  await page.mouse.move(a.x + 220, a.y + 150); await page.mouse.down(); await page.mouse.move(a.x + 140, a.y + 80, { steps: 6 }); await page.mouse.up();
  expect(await image.evaluate(e => (e as HTMLElement).style.transform)).not.toBe(initial);
  await page.getByTitle('放大', { exact: true }).click();
  await page.getByTitle('Page 1', { exact: true }).click(); await expect(page.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await closeHit(page);
});

test('file identity and compact tools are readable without hover and return focus', async ({ page }) => {
  await mountPreview(page, 'excel', 320);
  await page.getByLabel('查看文件名和来源').click();
  await expect(page.getByText('执行端 · Long node name', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起详情' }).click();
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '定位', exact: true }).focus(); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '工具', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '查找 / 缩放' }).click();
  await page.getByPlaceholder('在当前工作表查找').focus(); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '查找 / 缩放' })).toBeFocused();
  await closeHit(page);
});

test('Word compatibility tables scroll locally and PPT cards fit less than 330px', async ({ page }) => {
  await mountPreview(page, 'word', 320);
  const table = page.locator('table').locator('..');
  expect(await table.evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  expect((await table.boundingBox())!.width).toBeLessThan(320);
  await mountPreview(page, 'ppt', 320);
  const slide = page.locator('section');
  expect((await slide.boundingBox())!.width).toBeLessThan(320);
  await slide.hover(); await page.mouse.wheel(0, 400);
  await expect.poll(() => slide.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
});

test('Excel jitter, outside release, capture loss, right click and wheel cleanup', async ({ page }) => {
  await mountPreview(page, 'excel', 1100, 650);
  const grid = page.locator('[data-excel-grid]'); const b2 = grid.locator('[data-cell="B2"]');
  const b = (await b2.boundingBox())!;
  await page.mouse.move(b.x + 15, b.y + 10); await page.mouse.down(); await page.mouse.move(b.x + 17, b.y + 12); await page.mouse.up();
  expect(await b2.evaluate(e => (e as HTMLElement).style.outline)).not.toBe('');
  const box = (await grid.boundingBox())!;
  for (const cancelled of [false, true]) {
    await page.mouse.move(box.x + 280, box.y + 180); await page.mouse.down(); await page.mouse.move(box.x + 150, box.y + 70, { steps: 6 });
    if (cancelled) await grid.dispatchEvent('lostpointercapture');
    await page.mouse.move(1000, 690); await page.mouse.up();
    expect(await grid.evaluate(e => getComputedStyle(e).cursor)).toBe('grab');
    await grid.locator('[data-cell="A1"]').click();
  }
  const before = await grid.evaluate(e => [e.scrollLeft, e.scrollTop]);
  await page.mouse.move(box.x + 220, box.y + 180); await page.mouse.down({ button: 'right' }); await page.mouse.move(box.x + 150, box.y + 100); await page.mouse.up({ button: 'right' });
  expect(await grid.evaluate(e => [e.scrollLeft, e.scrollTop])).toEqual(before);
  await page.mouse.wheel(50, 100);
  await expect.poll(() => grid.evaluate(e => e.scrollLeft + e.scrollTop)).toBeGreaterThan(before[0] + before[1]);
});

test('visual viewport resize keeps Excel state and close inside usable rectangle', async ({ page }) => {
  await mountPreview(page, 'excel', 360, 360, 'chat');
  await page.locator('[data-cell="B2"]').click();
  await page.getByRole('button', { name: '查找 / 缩放' }).click();
  await page.getByPlaceholder('在当前工作表查找').fill('keep query');
  await page.evaluate(() => {
    const viewport = Object.assign(new EventTarget(), { width: 360, height: 300, offsetTop: 40, offsetLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.locator('[data-preview-surface]').evaluate(e => e.getBoundingClientRect().height)).toBe(300);
  await expect(page.getByPlaceholder('在当前工作表查找')).toHaveValue('keep query');
  expect(await page.locator('[data-cell="B2"]').evaluate(e => (e as HTMLElement).style.outline)).not.toBe('');
  const close = (await page.getByLabel('关闭预览').boundingBox())!;
  expect(close.y).toBeGreaterThanOrEqual(40); expect(close.y + close.height).toBeLessThan(340);
  await closeHit(page);
});

for (const kind of ['docx', 'pdf']) test(`${kind} native touch pan after zoom`, async ({ page, context }) => {
  await mountPreview(page, kind, 390);
  await expect(page.locator(kind === 'docx' ? 'section.awu-docx' : 'canvas').first()).toBeVisible();
  await page.getByLabel(kind === 'docx' ? 'Word 缩放' : 'PDF 缩放').selectOption('1.5');
  const area = page.locator(kind === 'docx' ? '[data-docx-scroll]' : '[data-pdf-scroll]');
  await expect.poll(() => area.evaluate(e => e.scrollWidth)).toBeGreaterThan(900);
  const box = (await area.boundingBox())!, x = box.x + 300, y = box.y + 250;
  const client = await context.newCDPSession(page); await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 15 * i, y: y - 15 * i }] }); await page.waitForTimeout(20); }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => area.evaluate(e => Math.min(e.scrollLeft, e.scrollTop))).toBeGreaterThan(50);
  await closeHit(page);
});

test('detached narrow close preserves real dirty document guard without a write', async ({ page }) => {
  await mountPreview(page, 'text-edit', 360, 360, 'detached');
  const editor = page.locator('.cm-content'); await expect(editor).toBeVisible();
  await editor.fill('detached dirty text');
  await closeHit(page);
  expect(await page.evaluate(() => (window as any).previewFixture.closed)).toBe(false);
  await expect(page.getByText('文档存在未保存改动或待核对保存，请先保存、导出或明确放弃草稿。')).toBeVisible();
  await expect(editor).toContainText('detached dirty text');
  expect(await page.evaluate(() => (window as any).previewFixture.calls.includes('save'))).toBe(false);
});
