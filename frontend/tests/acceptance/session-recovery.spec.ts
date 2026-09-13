import { test, expect, type WebSocketRoute } from '@playwright/test';

const sid = 'qa-loop-000';
const title = '首页交付 Loop 1';

for (const recovery of ['retry', 'reconnect', 'other-consumer', 'timeout'] as const) {
  test(`manual LOOP metadata recovers via ${recovery} without remounting`, async ({ page }, info) => {
    test.skip(info.project.name.includes('mobile') && recovery !== 'retry');
    const sockets: WebSocketRoute[] = [];
    const reads: string[] = [];
    let healthy = false;
    let blockedRequest: { socket: WebSocketRoute; id: string } | undefined;
    await page.routeWebSocket(/127\.0\.0\.1:45421/, socket => {
      sockets.push(socket);
      const server = socket.connectToServer();
      socket.onMessage(message => {
        const frame = JSON.parse(String(message));
        if (frame.params?.[0] === sid) reads.push(frame.method);
        if (['sendMessage', 'abortMessage', 'deleteSession', 'loopRunIteration', 'seqtaskTakeNext'].includes(frame.method)) throw new Error('Unexpected mutation in recovery test');
        if (frame.method === 'loadSessionMeta' && frame.params?.[0] === sid) {
          if (!healthy && recovery === 'timeout') { blockedRequest = { socket, id: frame.id }; return; }
          socket.send(JSON.stringify(healthy ? { id: frame.id, result: JSON.stringify({
            id: sid, title, sessionType: 'loop', loopControlMode: 'manual', backendId: 'qa-primary',
          }) } : { id: frame.id, error: 'QA injected metadata failure' }));
        } else server.send(message);
      });
    });
    await page.goto('/');
    const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
    if (await opener.isVisible()) await opener.click();
    await page.locator('.awu-sidebar').getByText(title, { exact: true }).click();
    const pane = page.locator(`[data-session-tab-panel="${sid}"]`);
    const originalPane = await pane.elementHandle();
    await expect(pane.getByRole('alert')).toBeVisible({ timeout: 16000 });
    expect(reads).not.toContain('loadSession');
    await expect(pane.getByRole('button', { name: '重试恢复会话', exact: true })).toBeEnabled();
    if (recovery === 'timeout') await expect(pane.getByRole('alert')).toContainText('超时');
    healthy = true;
    if (recovery === 'reconnect') {
      const count = sockets.length;
      await sockets.at(-1)!.close({ code: 1012, reason: 'QA reconnect' });
      await expect.poll(() => sockets.length, { timeout: 12000 }).toBeGreaterThan(count);
    } else if (recovery === 'other-consumer') {
      await page.getByRole('tab', { name: '工作总览', exact: true }).click();
      await page.getByRole('tab', { name: title, exact: true }).click();
    } else await pane.getByRole('button', { name: '重试恢复会话', exact: true }).click();
    await expect(pane.locator('.chat-textarea')).toBeVisible();
    await expect(pane.getByRole('alert')).toHaveCount(0);
    expect(await originalPane!.evaluate(node => node.isConnected)).toBe(true);
    expect(reads).toContain('loadSession');
    if (blockedRequest) {
      // 超时的旧应答不得再把人工会话改回自动 LOOP。
      blockedRequest.socket.send(JSON.stringify({ id: blockedRequest.id, result: JSON.stringify({
        id: sid, title, sessionType: 'loop', loopControlMode: 'loop', backendId: 'qa-primary',
      }) }));
      await expect(pane.locator('.chat-textarea')).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath(`recovered-${recovery}.png`) });
  });
}
