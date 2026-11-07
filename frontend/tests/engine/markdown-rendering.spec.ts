import { test, expect, type Page } from '@playwright/test';

const table = '| 左列 | 居中 | 右列 |\n| :--- | :---: | ---: |\n| **内容** | `code` | [链接](https://example.test "链接标题") |\n| 第二行 | | 42 |';
const syntax = '# 渲染验收\n\n## 层级与内容\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级\n\n**粗体** *强调* ~~删除~~\n下一行\n\n3. 第三项\n4. 第四项\n   - 嵌套条目\n\n- [x] 完成\n- [ ] 待办\n\n> 引用第一段\n>\n> 第二段\n\n---\n\n' + table + '\n\n```js title="demo"\nconst answer = 42;\n```';
const wide = '| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n| ' + Array(6).fill('identifier_' + 'x'.repeat(25)).join(' | ') + ' |';
const longCode = '  const data = "' + 'x'.repeat(240) + '";  ';
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS7kAAAAASUVORK5CYII=';

type Surface = 'chat' | 'reader' | 'shared';

// Empty page + production components; every WebSocket and non-fixture HTTP blocked.
async function mount(page: Page, { width = 1200, theme = 'dark', surface = 'chat' as Surface, source = syntax } = {}) {
  await page.setViewportSize({ width, height: 920 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><div id="root"></div>
      <style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}#root{min-height:100vh}</style>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async ({ theme, surface, source, image }) => {
    const { React, createRoot } = await import('/tests/engine/react-harness.ts');
    const { MessageBubble } = await import('/src/components/MessageBubble.tsx');
    const { MarkdownPreview } = await import('/src/components/MarkdownPreview.tsx');
    const { MarkdownStyles } = await import('/src/components/MarkdownStyles.tsx');
    const { MarkdownBody } = await import('/src/components/MarkdownBody.tsx');
    const { markdownToHtml } = await import('/src/utils/markdown.ts');
    const { themes } = await import('/src/hooks/useConfig.ts');
    const { api } = await import('/src/api.ts');
    const palette = themes[theme];
    localStorage.setItem('agentwithu.markdownPreview.theme', theme);
    localStorage.setItem('agentwithu.markdownPreview.tocOpen', '0');
    const fixture = { copied: '', draft: '', focused: [] as unknown[], sessions: [] as unknown[], images: [] as string[],
      message: { id: 'md-fixture', role: 'assistant', content: source, timestamp: 1 } as any,
      update: (_value: any) => {}, export: (_text: string) => '' };
    (window as any).mdFixture = fixture;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { fixture.copied = text; } } });
    window.addEventListener('awu-open-workspace-session', (event: any) => fixture.sessions.push(event.detail));
    api.getSkillImage = async (filename: string) => { fixture.images.push(filename); return { ok: true, mime: 'image/png', base64: image }; };
    api.sendMessage = async () => { throw new Error('Rendering must never send'); };
    const root = createRoot(document.getElementById('root')!);
    const render = () => root.render(React.createElement('div', { className: 'app-root', 'data-markdown-theme': theme, style: {
      '--theme-bg': palette.bg, '--theme-bg-secondary': palette.bgSecondary, '--theme-bg-tertiary': palette.bgTertiary,
      '--theme-text': palette.text, '--theme-text-muted': palette.textMuted, '--theme-accent': palette.accent,
      '--theme-border': palette.border, '--theme-code-bg': palette.codeBg, '--theme-message-bg': 'transparent',
      '--md-panel': palette.bgSecondary, '--md-soft': palette.bgTertiary, '--md-code': palette.codeBg,
      color: palette.text, background: `linear-gradient(140deg, ${palette.bg}, ${palette.bgSecondary})`, minHeight: '100vh',
    } }, React.createElement(MarkdownStyles), surface === 'reader'
      ? React.createElement('div', { style: { height: '900px', minWidth: 0 } }, React.createElement(MarkdownPreview, { source: fixture.message.content, initialDark: theme === 'dark' }))
      : surface === 'shared'
        ? React.createElement(MarkdownBody, { style: { padding: 16, minWidth: 0 }, text: fixture.message.content })
        : React.createElement(MessageBubble, { message: fixture.message, renderMarkdown: true, sessionId: 'md-fixture', workingDir: 'C:/fixture',
          onFocusFile: (...args: unknown[]) => fixture.focused.push(args), onInsertCommand: (value: string) => { fixture.draft = value; } })));
    fixture.update = (patch: any) => { fixture.message = { ...fixture.message, ...patch }; render(); };
    const { buildStandaloneMarkdownHtml } = await import('/src/utils/markdownExport.ts');
    fixture.export = (text: string) => buildStandaloneMarkdownHtml('验收.md', markdownToHtml(text));
    render();
  }, { theme, surface, source, image });
  await expect(page.locator('.md-content').first()).toBeVisible();
}

async function tableStyles(page: Page) {
  return page.locator('thead th').evaluateAll(cells => cells.map(cell => {
    const css = getComputedStyle(cell);
    return { align: css.textAlign, border: parseFloat(css.borderTopWidth), style: css.borderTopStyle, padding: parseFloat(css.paddingLeft), background: css.backgroundColor };
  }));
}

for (const width of [1200, 360]) for (const theme of ['dark', 'light']) {
  test(`chat grammar, table grid and theme (${theme}, ${width})`, async ({ page }, info) => {
    await mount(page, { width, theme });
    const styles = await tableStyles(page);
    expect(styles.map(cell => cell.align)).toEqual(['left', 'center', 'right']);
    for (const cell of styles) { expect(cell.border).toBeGreaterThan(0); expect(cell.style).toBe('solid'); expect(cell.padding).toBeGreaterThan(4); expect(cell.background).not.toBe('rgba(0, 0, 0, 0)'); }
    for (let level = 1; level <= 6; level++) await expect(page.locator(`.md-content h${level}`)).toBeVisible();
    await expect(page.locator('ol')).toHaveAttribute('start', '3');
    await expect(page.locator('ol ul')).toContainText('嵌套');
    await expect(page.locator('input[type=checkbox]').first()).toBeChecked();
    await expect(page.locator('input[type=checkbox]').first()).toBeDisabled();
    await expect(page.locator('blockquote p')).toHaveCount(2);
    await expect(page.locator('del')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.locator('pre > code .hljs-keyword')).toHaveText('const');
    await expect(page.getByRole('link', { name: '链接', exact: true })).toHaveAttribute('title', '链接标题');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`markdown-${theme}-${width}.png`), fullPage: true });
  });

  test(`wide content scrolls locally (${theme}, ${width})`, async ({ page }) => {
    await mount(page, { width, theme, source: wide + '\n\n```text\n' + longCode + '\n```\n\n' + 'url'.repeat(250) + '\n\n`' + 'inline'.repeat(130) + '`' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const selector of ['.md-table-wrap', 'pre.md-pre']) {
      const box = page.locator(selector);
      expect(await box.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await box.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      expect(await box.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    }
    await page.locator('.md-table-wrap').focus();
    await expect(page.locator('.md-table-wrap')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('pre > code')).toHaveText(longCode);
  });
}

for (const surface of ['reader', 'shared'] as Surface[]) {
  test(`${surface} without App retains layout and local highlight theme`, async ({ page }, info) => {
    await mount(page, { surface, width: 360 });
    expect((await tableStyles(page)).map(cell => cell.align)).toEqual(['left', 'center', 'right']);
    expect((await tableStyles(page))[0].border).toBeGreaterThan(0);
    await expect(page.locator('.md-content pre > code')).toHaveCSS('padding-left', '0px');
    await expect(page.locator('.md-content pre > code')).toHaveCSS('overflow-x', 'visible');
    const keyword = page.locator('.hljs-keyword');
    const dark = await keyword.evaluate(el => getComputedStyle(el).color);
    if (surface === 'reader') {
      await page.getByRole('button', { name: /白天/ }).click();
      await expect(keyword).not.toHaveCSS('color', dark);
      await page.getByRole('button', { name: /展开目录/ }).click();
      await expect(page.getByRole('navigation')).toContainText('渲染验收');
      await page.getByRole('button', { name: '关闭目录', exact: true }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (surface === 'reader') await page.locator('pre.md-pre').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`markdown-${surface}.png`), fullPage: true });
  });
}

test('code copy, draft insertion, file and Session links retain existing behavior', async ({ page }) => {
  const code = '/review "演示 <文件>"  ';
  await mount(page, { source: '```text title="not copied"\n' + code + '\n```\n\n[文件](<C:/fixture/a b.ts:12> "作者标题")\n\n[会话](#awu-session=target&node=local "Session 标题")' });
  await page.getByRole('button', { name: '复制代码' }).click();
  expect(await page.evaluate(() => (window as any).mdFixture.copied)).toBe(code);
  expect(await page.locator('pre.md-pre').evaluate(pre => {
    const code = pre.querySelector('code')!.getBoundingClientRect();
    const button = pre.querySelector('.code-copy-btn')!.getBoundingClientRect();
    return button.top >= code.bottom;
  })).toBe(true);
  await page.getByRole('button', { name: /填入输入框/ }).click();
  expect(await page.evaluate(() => (window as any).mdFixture.draft)).toBe(code.trim());
  const file = page.getByRole('link', { name: '文件', exact: true });
  await expect(file).toHaveAttribute('title', '作者标题');
  await file.click();
  expect(await page.evaluate(() => (window as any).mdFixture.focused)).toEqual([['a b.ts', 12, undefined]]);
  await page.getByRole('link', { name: '会话', exact: true }).click();
  expect(await page.evaluate(() => (window as any).mdFixture.sessions)).toEqual([{ node: 'local', session: 'target' }]);
  await expect(page.locator('.code-copy-btn')).toHaveCount(1);
  await expect(page.locator('.command-draft-btn')).toHaveCount(1);
});

test('streaming prefixes converge, actions remain unique and tool blocks stay ordered', async ({ page }) => {
  const source = table + '\n\n```text\n/review demo\n```';
  await mount(page, { source: 'start' });
  for (const length of [8, 28, 65, source.length - 2, source.length]) {
    await page.evaluate(content => (window as any).mdFixture.update({ content, streaming: true }), source.slice(0, length));
    await expect(page.locator('.command-draft-btn')).toHaveCount(0);
  }
  await page.evaluate(() => (window as any).mdFixture.update({ streaming: false }));
  await expect(page.locator('.command-draft-btn')).toHaveCount(1);
  const final = await page.locator('.md-content').innerHTML();
  await page.evaluate(source => (window as any).mdFixture.update({ id: 'history', content: source }), source);
  await expect(page.locator('.command-draft-btn')).toHaveCount(1);
  expect(await page.locator('.md-content').innerHTML()).toBe(final);
  await page.evaluate(() => (window as any).mdFixture.update({ content: 'unused total', thinking: 'internal thought',
    toolCalls: [{ id: 'tool1', name: 'Read', input: 'fixture', output: 'fixture output', status: 'done' }],
    contentBlocks: [{ type: 'thinking' }, { type: 'text', text: 'before table' }, { type: 'tool', toolIndex: 0 }, { type: 'text', text: 'after table' }],
  }));
  await expect(page.locator('.msg-content')).toHaveCount(2);
  await expect(page.locator('.msg-content').first()).toHaveText('before table');
  await expect(page.locator('.msg-content').last()).toHaveText('after table');
  await expect(page.locator('.message-bubble-wrapper')).not.toContainText('unused total');
  const text = await page.locator('.message-bubble-wrapper').innerText();
  expect(text.indexOf('before table')).toBeLessThan(text.indexOf('Read'));
  expect(text.indexOf('Read')).toBeLessThan(text.indexOf('after table'));
});

test('generated image loads by RPC, retains metadata and opens the image viewer', async ({ page }) => {
  await mount(page, { source: '![测试图片](http://127.0.0.1:9999/api/skill-images/fixture.png "图片说明")' });
  const img = page.getByAltText('测试图片');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('title', '图片说明');
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await page.evaluate(() => (window as any).mdFixture.images)).toEqual(['fixture.png']);
  await img.click();
  await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('standalone export retains grid, alignment, scrolling and themes offline', async ({ page }, info) => {
  await mount(page, { width: 360 });
  const html = await page.evaluate(source => (window as any).mdFixture.export(source), syntax + '\n\n' + wide);
  await page.setContent(html);
  expect((await tableStyles(page)).slice(0, 3).map(cell => cell.align)).toEqual(['left', 'center', 'right']);
  expect((await tableStyles(page))[0].border).toBeGreaterThan(0);
  const last = page.locator('.md-table-wrap').last();
  expect(await last.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await last.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  expect(await last.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const before = await page.locator('html').getAttribute('data-awu-theme');
  await page.locator('#awu-theme-toggle').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-awu-theme', before!);
  if (await page.locator('html').getAttribute('data-awu-toc') === 'open') await page.locator('#awu-toc-toggle').click();
  await expect(page.locator('.awu-reader-toc')).toHaveCSS('opacity', '0');
  await last.evaluate(el => { el.scrollLeft = 0; });
  // 兼容历史调用者提供的裸 table，不仅验证新 wrapper。
  await page.locator('.md-content').evaluate(el => {
    const legacy = document.createElement('table');
    legacy.innerHTML = '<tr><td align="center">legacy</td></tr>';
    legacy.dataset.legacy = 'true'; el.appendChild(legacy);
  });
  await expect(page.locator('[data-legacy] td')).toHaveCSS('text-align', 'center');
  await expect(page.locator('[data-legacy] td')).toHaveCSS('border-top-width', '1px');
  await page.screenshot({ path: info.outputPath('markdown-export.png'), fullPage: true, animations: 'disabled' });
});

test('shared styles do not restyle non-Markdown code previews', async ({ page }) => {
  await mount(page, { surface: 'shared' });
  const result = await page.evaluate(() => {
    const pre = document.createElement('pre');
    pre.innerHTML = '<code class="hljs"><span class="hljs-keyword">const</span> value = 1;</code>';
    document.querySelector('.app-root')!.appendChild(pre);
    const measure = () => [pre, pre.firstElementChild!, pre.querySelector('span')!].map(el => {
      const css = getComputedStyle(el); return [css.fontSize, css.padding, css.color, css.backgroundColor, css.overflowX];
    });
    const before = measure();
    (document.querySelector('style[data-awu-markdown-styles]') as HTMLStyleElement).sheet!.disabled = true;
    return { before, after: measure() };
  });
  expect(result.after).toEqual(result.before);
});
