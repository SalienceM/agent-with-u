import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const mod = await import('/tests/engine/chat-errors-harness.ts');
    const { React, createRoot, MessageBubble, processStreamDelta, buildStreamingMessage } = mod;
    mod.clearAllStreamStates();
    const root = createRoot(document.getElementById('root')!);
    (window as any).errorsFixture = { mod, render(message: any) {
      root.render(React.createElement(MessageBubble, { message, renderMarkdown: true }));
    }, send(type: string, extra = {}) {
      const { state } = processStreamDelta('fixture', { sessionId: 'fixture', messageId: 'm', type, ...extra });
      const message = buildStreamingMessage(state, { id: 'm', role: 'assistant', content: '', timestamp: 1 });
      this.render(message); return message;
    } };
  });
});

test('partial Markdown cannot swallow error; done and saved reload preserve it', async ({ page }) => {
  const message = await page.evaluate(() => {
    const fixture = (window as any).errorsFixture;
    fixture.send('text_delta', { text: '```sql\nCANCE' });
    fixture.send('error', { error: 'Harness stream_gap：回复不完整。' });
    return fixture.send('done');
  });
  expect(message.content).toBe('```sql\nCANCE');
  expect(message.streaming).toBe(false);
  await expect(page.getByRole('alert')).toContainText('stream_gap');
  await expect(page.locator('.msg-content [role="alert"]')).toHaveCount(0);
  await page.evaluate(message => {
    const fixture = (window as any).errorsFixture;
    fixture.mod.clearAllStreamStates();
    fixture.render({ ...message, contentBlocks: undefined });
  }, message);
  await expect(page.getByRole('alert')).toContainText('回复不完整');
});

test('error-only reply remains visible and recoverable error does not end the stream', async ({ page }) => {
  const active = await page.evaluate(() => (window as any).errorsFixture.send('error', { error: '<img src=x onerror=alert(1)>' }));
  expect(active.streaming).toBe(true);
  await expect(page.getByRole('alert')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.getByRole('alert').locator('img')).toHaveCount(0);
  await page.evaluate(() => (window as any).errorsFixture.send('done'));
  await expect(page.getByRole('alert')).toBeVisible();
});

test('diagnostics survive stream handoff but cannot leak to another node or new reply', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { mod } = (window as any).errorsFixture;
    mod.configureStreamIdentity((session: string, executor = 'local') => `${executor}:${session}`);
    const state = mod.processStreamDelta('s', { executor: 'node-a', messageId: 'm', type: 'error', error: 'DSH failure' }).state;
    const saved = JSON.parse(JSON.stringify(state));
    mod.clearAllStreamStates();
    mod.restoreStreamState('s', saved, 'node-a');
    const restored = mod.getStreamState('s', 'node-a').error;
    const other = mod.getStreamState('s', 'node-b').error;
    const next = mod.processStreamDelta('s', { executor: 'node-a', messageId: 'new', type: 'text_delta', text: 'next reply' }).state.error;
    return { restored, other, next };
  });
  expect(result).toEqual({ restored: 'DSH failure', other: '', next: '' });
});
