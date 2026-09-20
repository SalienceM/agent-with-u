import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

interface UsageEvent {
  id: string;
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
  stage?: string;
  source?: string;
  usageSource?: string;
  qwenAccounting?: Record<string, unknown>;
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
  let detailReads = 0;
  let captureEnabled = false;
  let cleared = false;
  let failDetail = false;
  await page.routeWebSocket(/.*/, socket => {
    sockets.add(socket);
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'getSessionTokenUsage') {
        reads++;
        sessionId = frame.params[0];
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ ...summary(events), captureEnabled }) }));
      } else if (frame.method === 'setSessionCallCapture') {
        captureEnabled = frame.params[1];
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ ...summary(events), captureEnabled }) }));
      } else if (frame.method === 'clearSessionCallDetails') {
        cleared = true;
        socket.send(JSON.stringify({ id: frame.id, result: true }));
      } else if (frame.method === 'getSessionCallDetail') {
        detailReads++;
        if (failDetail) { failDetail = false; socket.send(JSON.stringify({ id: frame.id, error: 'fixture read failed' })); return; }
        const event = events.find(item => item.id === frame.params[1]);
        const trace = cleared || event?.id === 'legacy' ? null : {
          redacted: true, truncated: true, attempts: [{ status: 'returned', output: 'fixture reply 正文',
            sent: event?.id === 'sdk-only' ? [{ scope: 'qwen-sdk', body: { prompt: '你是谁' } }] : [{ scope: 'qwen-model-request', note: '实际模型请求 JSON（脱敏）', body: { body: { model: 'fixture', messages: [{ role: 'system', content: '项目系统说明 fixture' }, { role: 'user', content: '你是谁' }] }, structure: { jsonChars: 50000, messageCount: 2, messageJsonChars: 30000, toolCount: 20, toolJsonChars: 19000 } } }],
            received: [{ scope: 'qwen-sdk', body: { type: 'result', usage: { input_tokens: 38100 } } }],
          }],
        };
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ event, trace, message: '此笔没有保留输入/输出，不能从聊天记录还原原始请求。' }) }));
      } else server.send(message);
    });
  });
  return {
    reads: () => reads,
    detailReads: () => detailReads,
    failNextDetail: () => { failDetail = true; },
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

test('call evidence is opt-in, lazy, scoped to the selected entry and clearable', async ({ page }, info) => {
  const fixture = await usageFixture(page, [{ id: 'legacy', inputTokens: 120, outputTokens: 3 }, { id: 'current', inputTokens: 38100, outputTokens: 272 }]);
  const dialog = await openMonitor(page);
  const capture = dialog.getByRole('checkbox', { name: '记录本 Session 后续调用的输入 / 输出' });
  await expect(capture).not.toBeChecked();
  expect(fixture.detailReads()).toBe(0);
  await capture.click();
  await expect(capture).toBeChecked();
  expect(fixture.detailReads()).toBe(0);
  await dialog.getByRole('button', { name: '查看此笔输入 / 输出' }).click();
  const evidence = dialog.getByLabel('此笔调用输入输出');
  await expect(evidence).toContainText('项目系统说明 fixture');
  await expect(evidence).toContainText('fixture reply 正文');
  await expect(evidence).toContainText('部分已截断');
  expect(fixture.detailReads()).toBe(1);
  await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('call-evidence.png') });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: '收起输入 / 输出' }).click();
  await dialog.getByRole('button', { name: '查看此笔输入 / 输出' }).click();
  expect(fixture.detailReads()).toBe(1);
  await dialog.getByRole('combobox', { name: '查看某次调用的 Token' }).selectOption('legacy');
  await expect(evidence).toHaveCount(0);
  await dialog.getByRole('button', { name: '查看此笔输入 / 输出' }).click();
  await expect(evidence).toContainText('没有保留');
  await expect(evidence).not.toContainText('fixture reply 正文');
  await dialog.getByRole('combobox', { name: '查看某次调用的 Token' }).selectOption('current');
  fixture.failNextDetail();
  await dialog.getByRole('button', { name: '查看此笔输入 / 输出' }).click();
  await expect(evidence.getByRole('alert')).toContainText('读取失败');
  await evidence.getByRole('button', { name: '重试读取' }).click();
  await expect(evidence).toContainText('fixture reply 正文');
  page.once('dialog', popup => popup.accept());
  await dialog.getByRole('button', { name: '清除已保存明细' }).click();
  await dialog.getByRole('button', { name: '查看此笔输入 / 输出' }).click();
  await expect(evidence).toContainText('没有保留');
  await expect(dialog.getByLabel('累计输入统计', { exact: true })).toContainText('3.82万');
});

test('LOOP calls share directional statistics and retain stage labels', async ({ page }) => {
  await usageFixture(page, [{ id: 'loop-call', inputTokens: 2400, outputTokens: 320, source: 'loop', stage: 'execute' }]);
  const dialog = await openMonitor(page, true);
  await expect(dialog.getByLabel('最近一次 · LOOP · 执行', { exact: true })).toContainText('输出 320 Token');
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('LOOP · 执行');
  await expect(dialog.locator('polyline')).toHaveCount(2);
});

test('Qwen reply counts, native delta and unattributed remainder stay separate', async ({ page }, info) => {
  const pair = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
  await usageFixture(page, [{ id: 'sdk-only', inputTokens: 20598, outputTokens: 290,
    usageSource: 'qwen-assistant-turn', qwenAccounting: {
      version: 2, status: 'unattributed', replyUsage: pair(20598, 290), countedUsage: pair(20598, 290),
      cumulativeBefore: pair(36721, 229), cumulativeAfter: pair(72221, 984),
      cumulativeDelta: pair(35500, 755), unattributedDelta: pair(14902, 465),
      baselineKind: 'recorded', baselineEventId: 'chat:previous', usageEventCount: 2, zeroUsageEventCount: 1,
    } }]);
  const dialog = await openMonitor(page);
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输入 20,598 Token');
  await expect(dialog.getByLabel('所选调用统计', { exact: true })).toContainText('输出 290 Token');
  await dialog.getByRole('button', { name: '查看此笔输入 / 输出' }).click();
  const audit = dialog.getByLabel('Qwen 用量对账');
  await expect(audit.getByRole('row').filter({ hasText: '本笔记账' })).toContainText('20,598');
  await expect(audit.getByRole('row').filter({ hasText: '原生累计增量' })).toContainText('35,500');
  await expect(audit.getByRole('row').filter({ hasText: '未归因差额' })).toContainText('14,902');
  await expect(audit.getByLabel('累计差分计算')).toContainText('984 − 229 = 755');
  await expect(audit).toContainText('事件数不是网络请求数');
  await expect(dialog.getByLabel('此笔调用输入输出')).toContainText('未捕获完整模型输入');
  await expect(dialog.getByLabel('此笔调用输入输出')).not.toContainText('已捕获模型请求 JSON');
  await audit.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('qwen-accounting.png') });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
