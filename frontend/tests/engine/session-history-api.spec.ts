import { test, expect } from '@playwright/test';

test('real history API preserves executor routing and visibility metadata; never uses legacy clear or offline mock', async ({ page }) => {
  const frames: any[] = [];
  const source = { id: 'source', title: '原会话', workingDir: '', ownerId: 'local', isPrivate: true, privacyRevision: 0, backendId: 'dsh' };
  const next = { ...source, id: 'next', historyRootId: 'source', historySourceId: 'source' };
  let peer: any, offline = false;
  await page.routeWebSocket(/.*/, ws => {
    if (offline) { ws.close(); return; }
    peer = ws;
    ws.onMessage(message => {
      const input = JSON.parse(String(message)); frames.push(input);
      const result: any = input.method === 'listSessions' ? [source]
        : input.method === 'loadSessionMeta' ? source
          : input.method === 'sessionRenew' || input.method === 'sessionRenewStatus' ? { status: 'succeeded', session: next }
            : input.method === 'sessionHistory' ? { status: 'ok', items: [next, source], nextOffset: null }
              : input.method === 'sessionNativeLogLocation' ? { status: 'ok', sessionsPath: '/fixture/native' } : null;
      ws.send(JSON.stringify({ id: input.id, result: result == null ? null : JSON.stringify(result) }));
    });
  });
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://127.0.0.1:55191') return route.abort();
    return u.pathname === '/' ? route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }) : route.continue();
  });
  await page.goto('/');
  await page.evaluate(async () => { const p = '/src/api.ts'; (window as any).historyApi = await import(/* @vite-ignore */ p); });
  await expect.poll(() => page.evaluate(async () => (await (window as any).historyApi.api.listSessions()).length)).toBe(1);
  const result = await page.evaluate(async () => {
    const m = (window as any).historyApi;
    const renewal = await m.api.sessionRenew('source', 'same-request', 'local');
    const history = await m.api.sessionHistory(renewal.session.id);
    const log = await m.api.sessionNativeLogLocation(renewal.session.id);
    return { renewal, history, log, executor: m.getSessionExecKey('next') };
  });
  expect(result.executor).toBe('local');
  expect(result.renewal.session.isPrivate).toBe(true);
  expect(result.history.items).toHaveLength(2);
  expect(result.log.sessionsPath).toBe('/fixture/native');
  expect(frames.find(row => row.method === 'sessionRenew').params).toEqual(['source', 'same-request']);
  expect(frames.some(row => ['clearSessionContext', 'createSession', 'sendMessage'].includes(row.method))).toBe(false);
  const before = frames.length;
  const missing = await page.evaluate(async () => {
    try { await (window as any).historyApi.api.sessionRenew('source', 'other', 'missing-node'); return ''; }
    catch (e: any) { return e.message; }
  });
  expect(missing).toContain('找不到指定的执行节点');
  expect(frames.length).toBe(before);
  offline = true;
  peer.close();
  await expect.poll(async () => page.evaluate(async () => {
    try { await (window as any).historyApi.api.sessionRenewStatus('source', 'same-request', 'local'); return false; }
    catch { return true; }
  })).toBe(true);
});
