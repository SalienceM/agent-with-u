import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

interface UsageEvent {
  id: string;
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
  stage?: string;
  source?: string;
}

function summary(events: UsageEvent[]) {
  const inputTokens = events.reduce((sum, event) => sum + event.inputTokens, 0);
  const outputTokens = events.reduce((sum, event) => sum + event.outputTokens, 0);
  const estimatedTurns = events.filter(event => event.estimated).length;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, events,
    turnCount: events.length, actualTurns: events.length - estimatedTurns, estimatedTurns,
    contextEvents: [], contextEventCount: 0 };
}

async function usageFixture(page: Page, events: UsageEvent[]) {
  const sockets = new Set<WebSocketRoute>();
  let sessionId = '';
  let reads = 0;
  await page.routeWebSocket(/.*/, socket => {
    sockets.add(socket);
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'getSessionTokenUsage') {
        reads++;
        sessionId = frame.params[0];
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(summary(events)) }));
      } else server.send(message);
    });
  });
  return {
    reads: () => reads,
    push(next: UsageEvent[], target = sessionId) {
      events = next;
      for (const socket of sockets) socket.send(JSON.stringify({ event: 'sessionUpdated',
        data: JSON.stringify({ sessionId: target, type: 'token_usage_updated', tokenUsage: summary(next) }) }));
    },
  };
}

async function openMonitor(page: Page, loop = false) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '返回工作总览', exact: true })).toBeVisible();
  if (!await page.locator('.awu-sidebar').isVisible()) {
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  }
  await page.locator('.awu-sidebar').getByText(loop ? '首页交付 Loop 1' : /^客户工作会话 \d+$/, { exact: true }).first().click();
  await page.locator('[data-session-tab-panel]:visible').getByRole('button', { name: /累计.*Token/ }).click();
  const dialog = page.getByRole('dialog', { name: '本会话 Token 使用情况' });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const theme of ['dark', 'light']) {
  test(`${theme}: input/output statistics, independently scaled lines and exact call details`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('agent-with-u:appearance:v1:local:local', JSON.stringify({
      version: 1, theme: value, bgOpacity: .3, uiOpacity: 1, background: 'none',
    })), theme);
    const events = [100000, 120000, 80000, 150000].map((inputTokens, i) => ({ id: `call-${i}`, inputTokens,
      outputTokens: [100, 500, 200, 300][i], estimated: i === 1, stage: 'reply' }));
    await usageFixture(page, events);
    const dialog = await openMonitor(page);
    await expect(dialog.getByLabel('累计输入统计', { exact: true })).toContainText('45万');
    await expect(dialog.getByLabel('累计输出统计', { exact: true })).toContainText('1,100');
    const latest = dialog.getByLabel('最近一次 · 普通对话', { exact: true });
    await expect(latest).toContainText('输入 15万 Token');
    await expect(latest).toContainText('输出 300 Token');
    const average = dialog.getByLabel('近 6 次平均', { exact: true });
    await expect(average).toContainText('输入 11.25万 Token');
    await expect(average).toContainText('输出 275 Token');
    const peak = dialog.getByLabel('近 16 次各项峰值', { exact: true });
    await expect(peak).toContainText('输入 15万 Token');
    await expect(peak).toContainText('输出 500 Token');
    await expect(peak).toContainText('单次合计峰值 15.03万 Token');
    const chart = dialog.getByRole('img', { name: '最近调用趋势：输入与输出' });
    await chart.scrollIntoViewIfNeeded();
    await expect(chart.locator('polyline')).toHaveCount(2);
    const before = (await chart.locator('[data-token-series="output"]').getAttribute('points'))!;
    expect(await chart.locator('[data-token-series="input"]').getAttribute('points')).not.toBe(before);
    await expect(chart.locator('title').nth(1)).toContainText('输入 120,000 Token，输出 500 Token，合计 120,500 Token（文本估算）');
    await dialog.getByRole('button', { name: '只看输出', exact: true }).click();
    const outputChart = dialog.getByRole('img', { name: '最近调用趋势：输出', exact: true });
    await expect(outputChart.locator('polyline')).toHaveCount(1);
    const after = (await outputChart.locator('polyline').getAttribute('points'))!;
    const yRange = (points: string) => {
      const ys = points.split(' ').map(point => Number(point.split(',')[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(yRange(after)).toBeGreaterThan(100);
    expect(yRange(before)).toBeLessThan(1);
    await dialog.getByRole('combobox', { name: '查看某次调用的 Token' }).selectOption('call-1');
    await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输入 120,000 Token');
    await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输出 500 Token');
    await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('文本估算');
    await dialog.getByRole('button', { name: '只看输入', exact: true }).click();
    await expect(dialog.locator('[data-token-series="input"]')).toHaveCount(1);
    await expect(dialog.locator('[data-token-series="output"]')).toHaveCount(0);
    await dialog.getByRole('button', { name: '输入 + 输出', exact: true }).click();
    await expect(dialog.locator('polyline')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath(`token-trends-${theme}.png`), fullPage: false });
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await chart.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(180);
    expect(errors).toEqual([]);
  });
}

test('empty and single-point trends accept live usage without extra reads or session leakage', async ({ page }) => {
  const fixture = await usageFixture(page, []);
  const dialog = await openMonitor(page);
  await expect(dialog).toContainText('完成一轮后显示趋势');
  const reads = fixture.reads();
  fixture.push([{ id: 'foreign', inputTokens: 9, outputTokens: 9 }], 'another-session');
  await expect(dialog).toContainText('完成一轮后显示趋势');
  fixture.push([{ id: 'zero', inputTokens: 0, outputTokens: 0, estimated: true }]);
  await expect(dialog.locator('svg circle')).toHaveCount(2);
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输出 0 Token');
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('文本估算');
  fixture.push([{ id: 'first', inputTokens: 200, outputTokens: 50 }]);
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输出 50 Token');
  await expect(dialog.getByLabel('累计输入统计', { exact: true })).toContainText('200');
  expect(fixture.reads()).toBe(reads);
  expect(await dialog.locator('polyline').first().getAttribute('points')).not.toMatch(/NaN|Infinity/);
  fixture.push(Array.from({ length: 24 }, (_, i) => ({ id: `window-${i}`, inputTokens: 100 + i, outputTokens: i })));
  await expect(dialog.locator('svg circle')).toHaveCount(32);
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输出 23 Token');
  await dialog.getByRole('combobox', { name: '查看某次调用的 Token' }).selectOption('window-8');
  fixture.push([{ id: 'replacement', inputTokens: 25, outputTokens: 15 }]);
  await expect(dialog.getByRole('combobox')).toHaveValue('');
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输出 15 Token');
  expect(fixture.reads()).toBe(reads);
});

test('LOOP calls share directional statistics and retain stage labels', async ({ page }) => {
  await usageFixture(page, [{ id: 'loop-call', inputTokens: 2400, outputTokens: 320, source: 'loop', stage: 'execute' }]);
  const dialog = await openMonitor(page, true);
  await expect(dialog.getByLabel('最近一次 · LOOP · 执行', { exact: true })).toContainText('输出 320 Token');
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('LOOP · 执行');
  await expect(dialog.locator('polyline')).toHaveCount(2);
});
