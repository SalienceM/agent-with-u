import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/tests/engine/react-harness.ts');
    const { api } = await import('/src/api.ts');
    const { FileTreePanel } = await import('/src/components/FileTreePanel.tsx');
    const { MessageBubble } = await import('/src/components/MessageBubble.tsx');
    const dir = (path: string) => ({ name: path.split('/').pop(), path, isDir: true });
    const file = (path: string) => ({ name: path.split('/').pop(), path, isDir: false, size: 10 });
    const f: any = { reads: [], active: 0, maxActive: 0, delay: 50, locate: () => {}, hold: '', release: () => {},
      listings: { '': [dir('src'), dir('other'), dir('wide')], src: [dir('src/a')], 'src/a': [dir('src/a/b')],
        'src/a/b': [dir('src/a/b/c')], 'src/a/b/c': [file('src/a/b/c/target.ts'), file('src/a/b/c/sibling.ts')],
        other: [file('other/second.ts')], wide: Array.from({ length: 250 }, (_, i) => file(`wide/f${String(i).padStart(3, '0')}.ts`)) } };
    (window as any).focusFixture = f;
    api.onSessionConnectionStatus = (_session, callback) => { callback(true); return () => {}; };
    api.gitDetect = async () => ({ isRepo: false });
    api.listDirectory = async rel => {
      f.reads.push(rel); f.active++; f.maxActive = Math.max(f.maxActive, f.active);
      try {
        if (rel === f.hold && f.hold) await new Promise<void>(resolve => { f.release = resolve; });
        await new Promise(resolve => setTimeout(resolve, f.delay));
        return structuredClone(f.listings[rel] || []);
      } finally { f.active--; }
    };
    for (const method of ['syncManifest', 'syncReadFile', 'workspaceDocuments', 'sendMessage']) {
      (api as any)[method] = async () => { throw new Error('Locating must not read bodies, scan or write: ' + method); };
    }
    const message = { id: 'focus-message', role: 'assistant', timestamp: 1,
      content: '[目标文件](/fixture/src/a/b/c/target.ts:9) [另一文件](/fixture/other/second.ts)' };
    const Harness = () => {
      const [request, setRequest] = React.useState<any>(null);
      const id = React.useRef(0);
      const locate = React.useCallback((relativePath: string) => setRequest({ sessionId: 'focus-fixture', workingDir: '/fixture', relativePath, requestId: ++id.current }), []);
      f.locate = locate;
      f.request = (scope: object) => setRequest({ sessionId: 'focus-fixture', workingDir: '/fixture', relativePath: 'other/second.ts', requestId: ++id.current, ...scope });
      return React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 340px', height: '700px' } },
        React.createElement(MessageBubble, { message: message as any, renderMarkdown: true, sessionId: 'focus-fixture', workingDir: '/fixture', onFocusFile: locate }),
        React.createElement(FileTreePanel, { sessionId: 'focus-fixture', workingDir: '/fixture', execKey: 'fixture-node', execMode: 'relay', focusRequest: request }));
    };
    createRoot(document.getElementById('root')!).render(React.createElement(Harness));
  });
  await expect(page.locator('.ftp-row').filter({ has: page.getByText('src', { exact: true }) })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).focusFixture; f.reads = []; f.maxActive = 0; });
}

test('chat locate reuses loaded ancestors, then repeats without directory RPCs', async ({ page }) => {
  await mount(page);
  await page.getByRole('link', { name: '目标文件', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /在文件面板中定位/ }).click();
  await expect(page.locator('.ftp-row.ftp-sel')).toContainText('target.ts');
  const first = await page.evaluate(() => ({ reads: (window as any).focusFixture.reads, max: (window as any).focusFixture.maxActive }));
  expect(first.reads.sort()).toEqual(['src', 'src/a', 'src/a/b', 'src/a/b/c']);
  expect(first.max).toBeGreaterThan(1);
  expect(first.max).toBeLessThanOrEqual(4);
  await page.evaluate(() => { const f = (window as any).focusFixture; f.reads = []; f.locate('src/a/b/c/sibling.ts'); });
  await expect(page.locator('.ftp-row.ftp-sel')).toContainText('sibling.ts');
  await page.getByRole('link', { name: '目标文件', exact: true }).click();
  await expect(page.locator('.ftp-row.ftp-sel')).toContainText('target.ts');
  expect(await page.evaluate(() => (window as any).focusFixture.reads)).toEqual([]);
});

test('latest click wins and shares in-flight parent reads', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { const f = (window as any).focusFixture; f.hold = 'src/a'; f.locate('src/a/b/c/target.ts'); });
  await expect.poll(() => page.evaluate(() => (window as any).focusFixture.reads.includes('src/a'))).toBe(true);
  await page.evaluate(() => (window as any).focusFixture.locate('src/a/b/c/sibling.ts'));
  await page.evaluate(() => (window as any).focusFixture.release());
  await expect(page.locator('.ftp-row.ftp-sel')).toContainText('sibling.ts');
  const reads = await page.evaluate(() => (window as any).focusFixture.reads as string[]);
  expect(reads.length).toBe(new Set(reads).size);
});

test('a newly created target refreshes only its cached parent', async ({ page }) => {
  await mount(page);
  await page.getByRole('link', { name: '另一文件', exact: true }).click();
  await expect(page.locator('.ftp-row.ftp-sel')).toContainText('second.ts');
  await page.evaluate(() => {
    const f = (window as any).focusFixture; f.reads = [];
    f.listings.other.push({ name: 'new.ts', path: 'other/new.ts', isDir: false });
    f.locate('other/new.ts');
  });
  await expect(page.locator('.ftp-row.ftp-sel')).toContainText('new.ts');
  expect(await page.evaluate(() => (window as any).focusFixture.reads)).toEqual(['other']);
});

test('a late response cannot move focus away from a newer path', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { const f = (window as any).focusFixture; f.hold = 'src/a'; f.locate('src/a/b/c/target.ts'); });
  await expect.poll(() => page.evaluate(() => (window as any).focusFixture.reads.includes('src/a'))).toBe(true);
  await page.getByRole('link', { name: '另一文件', exact: true }).click();
  const selected = page.locator('.ftp-row.ftp-sel');
  await expect(selected).toContainText('second.ts');
  await expect(selected).toBeFocused();
  await page.evaluate(() => (window as any).focusFixture.release());
  await expect.poll(() => page.evaluate(() => (window as any).focusFixture.active)).toBe(0);
  await expect(selected).toContainText('second.ts');
  await expect(selected).toBeFocused();
});

test('requests for another session or workspace are ignored', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).focusFixture.request({ sessionId: 'other-session' }));
  await page.evaluate(() => (window as any).focusFixture.request({ workingDir: '/other-workspace' }));
  await expect(page.locator('.ftp-row.ftp-sel')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).focusFixture.reads)).toEqual([]);
});

test('missing paths and paths outside the workspace do not trigger broad search', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).focusFixture.locate('other/missing.ts'));
  await expect(page.locator('.ftp-panel')).toContainText('无法在当前工作目录中定位');
  expect(await page.evaluate(() => (window as any).focusFixture.reads)).toEqual(['other']);
  await page.evaluate(() => { const f = (window as any).focusFixture; f.reads = []; f.locate('../outside.ts'); });
  expect(await page.evaluate(() => (window as any).focusFixture.reads)).toEqual([]);
});

test('locating beyond a paginated directory exposes and focuses the exact row', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).focusFixture.locate('wide/f249.ts'));
  const row = page.locator('.ftp-row.ftp-sel');
  await expect(row).toContainText('f249.ts');
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => (window as any).focusFixture.reads)).toEqual(['wide']);
  await page.evaluate(() => (window as any).focusFixture.locate('wide/f000.ts'));
  await expect(row).toContainText('f000.ts');
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  expect(await page.evaluate(() => (window as any).focusFixture.reads)).toEqual(['wide']);
});
