import { expect, test } from '@playwright/test';

for (const registered of [false, true]) test(`real upload transport includes window lease (registered=${registered})`, async ({ page }) => {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
    if (url.pathname !== '/src/api.ts') return route.continue();
    const response = await route.fetch();
    // 暴露真实 Conn.request / windowTransport，只替换隔离 WebSocket 对端。
    return route.fulfill({ response, body: await response.text() + `
      export function directoryTransportFixture(registered) {
        for (const connection of pool.values()) connection.dispose();
        pool.clear(); windowTransport.clear();
        const user = getCurrentUserProfile().userId, frames = [];
        const workspace = { ownerId: user, sessionId: 'upload-session', workingDir: 'C:/fixture',
          executorInstance: 'fixture', workspaceRevision: 'a'.repeat(64) };
        const state = { status: 'ok', workspace, clientId: 'client', windowId: 'window',
          generation: 3, revision: 4, frozen: false, pending: null };
        windowTransport.activate({ clientId: 'client', windowId: 'window' });
        if (registered) windowTransport.observe('upload-node', state);
        const connection = new Conn('upload-node', { mode: 'relay', deviceId: 'fixture' }, false);
        connection.ready = Promise.resolve();
        connection.ws = { readyState: WebSocket.OPEN, send(raw) {
          const frame = JSON.parse(raw); frames.push(frame);
          let result;
          if (frame.method === 'loadSessionMeta') result = { id: workspace.sessionId, workingDir: workspace.workingDir };
          else if (frame.method === 'sessionWorkbenchCapabilities') result = { status: 'ok', protocolVersion: 1,
            identity: workspace, capabilities: { viewMode: 1, documents: 1, windowHandoff: 1, terminal: 0, languageServices: 0 } };
          else if (frame.method === 'workbenchWindow') result = state;
          else if (frame.method === 'syncTransferCommit') {
            const lease = frame.workbench?.lease;
            if (lease?.generation !== 3 || lease.sessionId !== workspace.sessionId || lease.workspaceRevision !== workspace.workspaceRevision) {
              handleMessage({ data: JSON.stringify({ id: frame.id, error: 'window_lease_required' }) }, connection); return;
            }
            result = { status: 'ok', state: 'succeeded' };
          } else if (frame.method === 'syncTransferStatus') result = { status: 'ok', state: 'succeeded' };
          else throw Error(frame.method);
          handleMessage({ data: JSON.stringify({ id: frame.id, result: JSON.stringify(result) }) }, connection);
        } };
        pool.set(connection.key, connection);
        return { frames, commit: () => api.directoryTransferCall(connection.key, 'Commit', [workspace.sessionId, JSON.stringify(workspace), workspace.workingDir, 'plan']),
          status: () => api.directoryTransferCall(connection.key, 'Status', [workspace.sessionId, JSON.stringify(workspace), 'plan']),
          hold: () => windowTransport.hold(connection.key, workspace.sessionId, true) };
      }
    ` });
  });
  await page.goto('/');
  const result = await page.evaluate(async registered => {
    const { directoryTransportFixture } = await import('/src/api.ts') as any;
    const f = directoryTransportFixture(registered);
    const committed = await f.commit();
    f.hold();
    let denied: any;
    try { await f.commit(); } catch (error: any) { denied = { message: error.message, notSubmitted: error.notSubmitted }; }
    const status = await f.status();
    return { committed, denied, status, frames: f.frames };
  }, registered);
  expect(result.committed.state).toBe('succeeded');
  expect(result.status.state).toBe('succeeded');
  expect(result.denied.notSubmitted).toBe(true);
  expect(result.denied.message).toContain('归属');
  const commits = result.frames.filter((f: any) => f.method === 'syncTransferCommit');
  expect(commits).toHaveLength(1);
  expect(commits[0].workbench.lease).toEqual({ sessionId: 'upload-session', generation: 3, workspaceRevision: 'a'.repeat(64) });
  expect(result.frames.filter((f: any) => f.method === 'workbenchWindow')).toHaveLength(registered ? 0 : 1);
  expect(result.frames.at(-1).workbench.lease).toBeUndefined();
});
