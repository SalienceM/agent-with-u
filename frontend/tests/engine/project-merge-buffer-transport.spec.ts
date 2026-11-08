import { test, expect } from '@playwright/test';

test('local and same-node Relay both acknowledge buffer probes without duplicating broadcasts', async ({ page }) => {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
    if (url.pathname !== '/src/api.ts') return route.continue();
    const response = await route.fetch();
    // 只在隔离测试响应中暴露实际消息路由，产品不添加调试 RPC 或导出。
    return route.fulfill({ response, body: await response.text() + `
      export function mergeBufferFixture() {
        for (const connection of pool.values()) connection.dispose();
        pool.clear(); localPhysicalDeviceId = 'fixture-device';
        const replies = []; let broadcasts = 0;
        const local = { key: 'local', isOpen: true, target: { mode: 'local' },
          request: async (method, params) => { replies.push({ side: 'local', method, params }); } };
        const relay = { key: 'relay:fixture', isOpen: true, target: { mode: 'relay', deviceId: 'fixture-device' },
          request: async (method, params) => { replies.push({ side: 'relay', method, params }); } };
        pool.set(local.key, local); pool.set(relay.key, relay);
        projectMergeCallbacks.add(() => broadcasts++);
        return {
          emit: (side, event, data) => handleMessage({ data: JSON.stringify({ event, data }) }, side === 'relay' ? relay : local),
          stale: () => pool.set(relay.key, { ...relay }),
          replies, locks: () => documentStore.projectLocks(), broadcasts: () => broadcasts,
        };
      }
    ` });
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { mergeBufferFixture } = await import('/src/api.ts') as any;
    const f = mergeBufferFixture();
    const data = { probeId: 'probe', operationId: 'operation', workspace: {
      ownerId: 'tester', executorInstance: 'fixture-device', sessionId: 'main', workingDir: 'C:/fixture', workspaceRevision: 'revision',
    } };
    f.emit('local', 'projectBufferFreeze', data);
    f.emit('relay', 'projectBufferFreeze', data);
    const locksAfterBoth = f.locks().length;
    f.emit('local', 'projectMergeUpdated', { id: 'operation' });
    f.emit('relay', 'projectMergeUpdated', { id: 'operation' });
    // 释放可能只在 Relay 路径到达，仍须处理，且重复释放无副作用。
    f.emit('relay', 'projectBufferRelease', { ...data, committed: false });
    const locksAfterRelease = f.locks().length;
    f.emit('local', 'projectBufferRelease', { ...data, committed: false });
    f.stale();
    f.emit('relay', 'projectBufferFreeze', { ...data, probeId: 'stale-probe' });
    await Promise.resolve();
    return { replies: f.replies, locksAfterBoth, locksAfterRelease, finalLocks: f.locks().length, broadcasts: f.broadcasts() };
  });
  expect(result).toEqual({ replies: [
    { side: 'local', method: 'projectBufferReply', params: ['probe', true] },
    { side: 'relay', method: 'projectBufferReply', params: ['probe', true] },
  ], locksAfterBoth: 1, locksAfterRelease: 0, finalLocks: 0, broadcasts: 1 });
});
