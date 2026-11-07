import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, width = 1300) {
  await page.setViewportSize({ width, height: 900 });
  await page.routeWebSocket(/.*/, socket => socket.close());
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
    const { React, createRoot, ChatInput, api, composerSubmissions, harnessImageScope } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] } as any);
    api.listSessions = async () => [];
    const root = createRoot(document.getElementById('root')!);
    const fixture = { sent: [] as any[], sessionId: 'editor-fixture', render: () => {}, receipts: false, requests: [] as any[], reply: (_state: string, _index = 0) => {} };
    (composerSubmissions as any).io.write = async (_scope: any, payload: any) => {
      fixture.requests.push(payload); return { ...payload, revision: 1, state: 'preparing' };
    };
    fixture.reply = (state, index = 0) => composerSubmissions.observe(harnessImageScope(fixture.sessionId), { ...fixture.requests[index], state, revision: 2 });
    fixture.render = () => root.render(React.createElement(ChatInput, { sessionId: fixture.sessionId, historyKey: fixture.sessionId,
      isStreaming: false, activeBackendId: 'api', backends: [{ id: 'api', type: 'openai-compatible' }],
      onAbort: () => {}, onSend: (...args: any[]) => { fixture.sent.push(args);
        if (fixture.receipts) return api.composerSend({ sessionId: fixture.sessionId, backendId: 'api', content: args[0], images: args[1], textAttachments: args[2], kitApprovalDelegation: args[3] }, false, args[5]);
      } }));
    (window as any).composerFixture = fixture; fixture.render();
  });
}

for (const width of [1300, 390]) test(`three blocks share edit, order and undo with compact send (${width})`, async ({ page }) => {
  await mount(page, width);
  await page.locator('.chat-textarea').fill('main kept');
  await page.locator('input[type=file]').setInputFiles(['one', 'two', 'three'].map(name => ({ name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`${name} original`) })));
  await page.getByRole('button', { name: '展开编辑消息和文本块' }).click();
  const panel = page.getByRole('dialog', { name: '展开编辑消息' });
  for (const name of ['one', 'two', 'three']) {
    await panel.getByRole('button', { name: new RegExp(`\\d ${name}.txt`) }).click();
    await panel.getByRole('textbox', { name: `编辑文本块 ${name}.txt` }).fill(`${name} edited`);
  }
  await panel.getByRole('button', { name: '撤销本块' }).click();
  await expect(panel.getByRole('textbox', { name: '编辑文本块 three.txt' })).toHaveText('three original');
  await panel.getByRole('button', { name: '上移' }).click();
  await panel.getByLabel('文本块名称').fill('renamed.txt');
  await panel.getByRole('button', { name: '返回输入框' }).click();
  await expect(page.locator('.chat-textarea')).toHaveValue('main kept');
  await page.evaluate(() => { const f = (window as any).composerFixture; f.sessionId = 'other'; f.render(); });
  await expect(page.locator('.chat-textarea')).toHaveValue('');
  await page.evaluate(() => { const f = (window as any).composerFixture; f.sessionId = 'editor-fixture'; f.render(); });
  await page.getByRole('button', { name: '展开编辑消息和文本块' }).click();
  await panel.getByRole('button', { name: /1 one.txt/ }).click();
  await panel.getByRole('button', { name: '撤销本块' }).click();
  await expect(panel.getByRole('textbox', { name: '编辑文本块 one.txt' })).toHaveText('one original');
  await panel.getByRole('button', { name: '重做本块' }).click();
  await panel.getByRole('button', { name: '发送当前消息' }).click();
  const sent = await page.evaluate(() => (window as any).composerFixture.sent[0]);
  expect(sent[0]).toBe('main kept');
  expect(sent[2].map((x: any) => [x.name, x.content])).toEqual([['one.txt', 'one edited'], ['renamed.txt', 'three original'], ['two.txt', 'two edited']]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('packing is reversible at 4000/6000 boundaries and restored text stays editable', async ({ page }) => {
  await mount(page);
  const input = page.locator('.chat-textarea');
  await input.fill('before after');
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(7, 7);
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '长'.repeat(4000));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(input).toHaveValue('before after');
  await page.getByRole('button', { name: '撤销文本收纳 / 恢复' }).click();
  await expect(input).toHaveValue(`before ${'长'.repeat(4000)}after`);
  await input.press('Control+End'); await input.type(' changed');
  await expect(input).toHaveValue(`before ${'长'.repeat(4000)}after changed`);
  await page.evaluate(() => { const f = (window as any).composerFixture; f.sessionId = 'boundary'; f.render(); });
  await expect(input).toHaveValue('');
  await input.fill('x'.repeat(5999)); await expect(input).toHaveValue('x'.repeat(5999));
  await input.type('x'); await expect(input).toHaveValue('');
  await input.press('Control+z'); await expect(input).toHaveValue('x'.repeat(6000));
  await input.type('y'); await expect(input).toHaveValue('x'.repeat(6000) + 'y');
});

test('IME Enter does not send, expanded Enter inserts newline, Escape returns focus', async ({ page }) => {
  await mount(page);
  const input = page.locator('.chat-textarea');
  await input.fill('中文');
  await input.dispatchEvent('compositionstart'); await input.press('Enter');
  expect(await page.evaluate(() => (window as any).composerFixture.sent)).toEqual([]);
  await input.dispatchEvent('compositionend');
  await input.fill('中文'); // 合成 composition 事件不会像真实 IME 那样消费浏览器默认换行。
  await page.getByRole('button', { name: '展开编辑消息和文本块' }).click();
  const editor = page.getByRole('textbox', { name: '编辑主消息' });
  await editor.press('Control+End'); await editor.press('Enter'); await editor.type('second');
  expect(await page.evaluate(() => (window as any).composerFixture.sent)).toEqual([]);
  await editor.press('Escape');
  await expect(input).toBeFocused(); await expect(input).toHaveValue('中文\nsecond');
});

test('submission clears only an accepted matching draft, never late edits or unknown requests', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).composerFixture.receipts = true; });
  const input = page.locator('.chat-textarea');
  await input.fill('original'); await input.press('Enter');
  await expect(input).toHaveValue('original');
  await input.fill('new draft during submission');
  await page.evaluate(() => (window as any).composerFixture.reply('accepted'));
  await expect(input).toHaveValue('new draft during submission');
  await input.press('Enter');
  await page.evaluate(() => (window as any).composerFixture.reply('unknown', 1));
  await input.press('Enter');
  expect(await page.evaluate(() => (window as any).composerFixture.requests.length)).toBe(2);
  await expect(input).toHaveValue('new draft during submission');
});

test('rejected original remains editable; accepted unchanged text and blocks clear together', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).composerFixture.receipts = true; });
  const input = page.locator('.chat-textarea');
  await input.fill('original'); await input.press('Enter');
  await page.evaluate(() => (window as any).composerFixture.reply('rejected'));
  await expect(input).toHaveValue('original');
  await page.locator('input[type=file]').setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('contents') });
  await expect(page.getByText('a.txt', { exact: true })).toBeVisible();
  await input.press('Enter');
  await page.evaluate(() => (window as any).composerFixture.reply('accepted', 1));
  await expect(input).toHaveValue('');
  await expect(page.getByText('a.txt', { exact: true })).toHaveCount(0);
});

test('controller and handoff isolate identities, preserve cursor and discard authorization fields', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { ComposerDrafts, ComposerSubmissions, validateComposerMeta } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const drafts = new ComposerDrafts();
    const img = { id: 'image', base64: 'YQ==', mime_type: 'image/png', size: 1 };
    drafts.update('owner-a/node/same', { text: 'prefix', images: [img], textAttachments: [], kitApprovalDelegation: true } as any);
    drafts.update('owner-b/node/same', { text: 'other', images: [], textAttachments: [] });
    drafts.select('owner-a/node/same', 'main', { start: 2, end: 2, scrollTop: 50 });
    drafts.pack('owner-a/node/same', { id: 'voice', name: 'voice.txt', content: '语音', size: 2, source: 'voice' }, 2, 2, true);
    const packed = drafts.get('owner-a/node/same')!;
    drafts.undoTransform('owner-a/node/same');
    const restored = drafts.get('owner-a/node/same')!;
    const scope = { key: 'source', owner: 'owner-a', executor: 'node', session: 'same' };
    let id = 0, writes = 0;
    const io = { current: () => true, id: () => String(++id), write: async () => { writes++; throw Error('lost'); }, read: async () => ({}) };
    const source = new ComposerSubmissions(io), destination = new ComposerSubmissions(io);
    await source.submit(scope, { content: 'draft', kitApprovalDelegation: true }, { scopeKey: scope.key, draftRevision: 5 }, false);
    const handoff = source.handoff(scope, 5);
    const targetScope = { ...scope, key: 'target' };
    destination.adopt(targetScope, handoff, { content: 'draft' }, 9);
    await destination.submit(targetScope, { content: 'draft' }, { scopeKey: 'target', draftRevision: 9 }, false);
    let invalid = false;
    try { validateComposerMeta({ selections: {}, activeBlock: 'main', keepLongText: false, references: [], kitApprovalDelegation: true }, []); } catch { invalid = true; }
    return { packed: packed.textAttachments.length, restored: restored.text, cursor: restored.selections.main.start,
      images: restored.images.length, other: drafts.get('owner-b/node/same')!.text,
      authorized: 'kitApprovalDelegation' in restored || JSON.stringify(handoff).includes('kitApproval'), writes, invalid };
  });
  expect(result).toEqual({ packed: 1, restored: 'pr语音efix', cursor: 4, images: 1, other: 'other', authorized: false, writes: 1, invalid: true });
});
