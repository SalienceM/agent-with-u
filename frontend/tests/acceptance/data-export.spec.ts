import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

test('Export Data downloads executor archive to the browser client without sending a client path', async ({ page }) => {
  const archive = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x41, 0x57, 0x55, 0x00]);
  const calls: Array<{ method: string; params: unknown[] }> = [];

  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      calls.push({ method: frame.method, params: frame.params || [] });
      const reply = (value: unknown) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'exportData') throw new Error('不得把客户端路径交给执行端');
      if (frame.method === 'exportDataStart') return reply({
        status: 'ok', transferId: 'fixtureexport1234', fileName: 'agent-with-u-export-fixture.tar.gz',
        size: archive.length, sha256: createHash('sha256').update(archive).digest('hex'),
      });
      if (frame.method === 'exportDataChunk') return reply({
        status: 'ok', offset: frame.params[1], size: archive.length, total: archive.length,
        eof: true, data: archive.toString('base64'),
      });
      if (frame.method === 'exportDataFinish') return reply({ status: 'ok' });
      server.send(raw);
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^用户与设置：/ }).click();
  await page.getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: /数据与系统/ }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export Data/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('agent-with-u-export-fixture.tar.gz');
  await expect.poll(() => calls.some(call => call.method === 'exportDataFinish')).toBe(true);
  expect(calls.filter(call => call.method === 'exportDataStart')).toHaveLength(1);
  expect(calls.find(call => call.method === 'exportDataStart')?.params).toEqual([]);
  expect(calls.some(call => call.method === 'exportData')).toBe(false);
});
