import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>body{--theme-text:#eee;--theme-bg-secondary:#222;--theme-border:#666;--theme-input-bg:#333;background:#111;font:14px sans-serif}</style><div id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const { React, createRoot, UserInteractionsPanel, InteractionBadge, api, interactionIndex } = await import('/tests/engine/user-interactions-harness.ts');
    const option = (id: string) => ({ id, label: id, description: '' });
    const question = (id: string, question: string, options: any[], multiple = false) => ({ id, question, options, multiple, allowOther: !options.length, required: true, secret: false, header: '' });
    const row = { id: 'request', sessionId: 'fixture', messageId: 'message', revision: 1, kind: 'question', status: 'pending', title: '请补充需求', detail: '', canSkip: false,
      deadline: Date.now() / 1000 + 300, notice: '此问题仍需回答：原生协议没有已验证的跳过方式',
      questions: [question('choice', '选择方案', [option('A'), option('B')]), question('multi', '选择平台', [option('Windows'), option('Linux')], true), question('path', '工作目录', [])] };
    const fixture = { rows: [row], calls: [] as any[], fail: false, push: (_r: any, _e = '') => {}, connected: (_value: boolean) => {} };
    (window as any).interactionFixture = fixture;
    api.userInteractionList = async () => ({ items: [...fixture.rows] as any });
    api.onUserInteraction = callback => { fixture.push = (r, executor = '') => { interactionIndex.accept(executor || 'local', r); callback(r, executor); }; return () => {}; };
    api.onSessionConnectionStatus = (_session, callback) => { fixture.connected = callback; callback(true); return () => {}; };
    api.userInteractionRespond = async (session, executor, id, value) => {
      fixture.calls.push({ session, executor, id, value });
      if (fixture.fail) throw new Error('回执丢失');
      const updated = { ...fixture.rows.find(r => r.id === id), status: 'answered', revision: 2, answers: (value as any).answers };
      fixture.rows = fixture.rows.map(r => r.id === id ? updated : r) as any;
      return updated as any;
    };
    createRoot(document.getElementById('root')!).render(React.createElement(React.Fragment, null,
      React.createElement('input', { 'aria-label': '主对话草稿', defaultValue: '保留草稿' }),
      React.createElement(InteractionBadge, { sessionId: 'fixture', executor: 'local', onOpen: () => {} }),
      React.createElement(UserInteractionsPanel, { sessionId: 'fixture' })));
  });
}

for (const width of [1366, 390]) {
  test(`multiple questions validate and return exactly one original request (${width})`, async ({ page }) => {
    await mount(page, width);
    const panel = page.getByRole('region', { name: '原生交互' });
    await panel.getByRole('button', { name: '提交答案' }).click();
    await expect(panel.getByRole('alert')).toContainText('选择方案');
    await expect(panel.getByRole('radio').first()).toBeFocused();
    await panel.getByLabel('B', { exact: true }).check();
    await panel.getByLabel('Windows', { exact: true }).check();
    await panel.getByLabel('Linux', { exact: true }).check();
    await panel.getByLabel('你的回答').fill('C:/project');
    await panel.getByRole('button', { name: '提交答案' }).click();
    await expect(panel.locator('summary').last()).toContainText('已回传');
    expect(await page.evaluate(() => (window as any).interactionFixture.calls)).toEqual([
      { session: 'fixture', executor: '', id: 'request', value: { kind: 'answers', answers: { choice: ['B'], multi: ['Windows', 'Linux'], path: ['C:/project'] } } },
    ]);
    await expect(page.getByLabel('主对话草稿')).toHaveValue('保留草稿');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });
}

test('unknown reply retains draft; reconnect only reads and never replays', async ({ page }) => {
  await mount(page, 390);
  const panel = page.getByRole('region', { name: '原生交互' });
  await panel.getByLabel('A', { exact: true }).check();
  await panel.getByLabel('Windows', { exact: true }).check();
  await panel.getByLabel('你的回答').fill('draft/path');
  await page.evaluate(() => { (window as any).interactionFixture.fail = true; });
  await panel.getByRole('button', { name: '提交答案' }).click();
  await expect(panel.getByRole('alert')).toContainText('未自动重发');
  await expect(panel.getByRole('button', { name: '提交答案' })).toBeDisabled();
  await page.evaluate(() => {
    const f = (window as any).interactionFixture;
    f.rows = f.rows.map((row: any) => ({ ...row, status: 'unknown', revision: 3 }));
    f.connected(false); f.connected(true);
  });
  await panel.locator('summary').last().click();
  await expect(panel.getByLabel('你的回答')).toHaveValue('draft/path');
  expect(await page.evaluate(() => (window as any).interactionFixture.calls.length)).toBe(1);
});

test('late old revision and another Session never replace current questions or steal focus', async ({ page }) => {
  await mount(page, 1366);
  await page.getByLabel('主对话草稿').focus();
  await page.evaluate(() => {
    const f = (window as any).interactionFixture;
    f.push({ ...f.rows[0], id: 'elsewhere', sessionId: 'other', title: '其他会话问题' });
    f.push({ ...f.rows[0], revision: 3, title: '最新问题' });
    f.push({ ...f.rows[0], revision: 2, title: '旧问题' });
  });
  await expect(page.getByLabel('主对话草稿')).toBeFocused();
  await expect(page.getByRole('region', { name: '原生交互' })).toContainText('最新问题');
  await expect(page.getByRole('region', { name: '原生交互' })).not.toContainText('旧问题');
  await expect(page.getByRole('region', { name: '原生交互' })).not.toContainText('其他会话问题');
});

test('two pending requests have a badge and user-directed keyboard focus', async ({ page }) => {
  await mount(page, 1366);
  await page.getByLabel('主对话草稿').focus();
  await page.evaluate(() => {
    const f = (window as any).interactionFixture;
    f.push(f.rows[0]);
    f.push({ ...f.rows[0], id: 'request-2', title: '第二个独立问题', questions: [{ ...f.rows[0].questions[2], question: '第二个目录' }] });
  });
  await expect(page.getByLabel('主对话草稿')).toBeFocused();
  await expect(page.getByRole('button', { name: '2 个问题待回答' })).toBeVisible();
  await page.getByRole('button', { name: '2 个问题待回答' }).click();
  await expect(page.getByRole('region').locator('details[open] summary').first()).toBeFocused();
  await expect(page.getByRole('button', { name: '提交答案' })).toHaveCount(2);
});
