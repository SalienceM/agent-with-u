import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const first = { id: 'readonly-qa', title: '只读项目验收', messageCount: 0, updatedAt: 1,
  workingDir: 'C:/isolated-readonly-project', backendId: 'qa-backend', sessionType: 'normal' };
const second = { ...first, id: 'readonly-other', title: '另一个验收项目' };

async function fixture(context: BrowserContext) {
  const asks: any[][] = [];
  const requests: string[] = [];
  const histories: Record<string, any[]> = { [first.id]: [], [second.id]: [] };
  let channel: any;
  let accept: (() => void) | undefined;
  let hold = false;
  const push = (sid = first.id) => channel.send(JSON.stringify({ event: 'chatAsideUpdated', data: JSON.stringify({ sessionId: sid, asides: histories[sid] }) }));
  const update = (phase: string, options: Record<string, any> = {}, sid = first.id) => {
    const turn = histories[sid].at(-1)!;
    const { inspection, ...fields } = options;
    Object.assign(turn, { status: ['done', 'error', 'cancelled'].includes(phase) ? phase : 'answering', ...fields });
    turn.inspection = { ...turn.inspection, phase, sequence: turn.inspection.sequence + 1, ...options.inspection };
    push(sid);
  };
  await context.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      requests.push(frame.method);
      const reply = (value: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'listSessions') return reply([first, second]);
      if (frame.method === 'loadSessionMeta') return reply(frame.params[0] === second.id ? second : first);
      if (frame.method === 'loadSession') return reply({ ...(frame.params[0] === second.id ? second : first), messages: [] });
      if (frame.method === 'chatAsideList') return reply({ status: 'ok', asides: histories[frame.params[0]] || [] });
      if (frame.method === 'chatAsk') {
        channel = socket;
        asks.push(frame.params);
        const attention = JSON.parse(frame.params[3]);
        const turn = { id: `question-${asks.length}`, question: frame.params[1], answer: '', status: 'answering',
          contextKey: attention.key, contextKind: attention.kind, contextLabel: attention.label,
          inspection: { phase: 'preparing', sequence: 0, message: '正在准备只读项目答疑' } };
        histories[frame.params[0]].push(turn);
        accept = () => { reply({ status: 'ok', turnId: turn.id }); push(frame.params[0]); };
        if (!hold) accept();
        return;
      }
      if (frame.method === 'chatAsideAbort') {
        update('unknown', { inspection: { message: '结果待确认：正在确认旁路退出；主线不受影响' } }, frame.params[0]);
        return reply({ status: 'ok', aborting: true });
      }
      if (['loopRunIteration', 'loopSetAuto', 'sendMessage', 'skillRuntimePrepare'].includes(frame.method)) throw new Error(`Unexpected main mutation: ${frame.method}`);
      server.send(message);
    });
  });
  return { asks, requests, update, histories, push, hold: () => { hold = true; }, accept: () => accept!() };
}

async function open(page: Page) {
  await page.goto('/');
  const sidebar = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.awu-sidebar').getByText(first.title, { exact: true }).click();
  await page.getByRole('button', { name: /俺寻思/ }).first().click();
  return page.getByRole('complementary', { name: '俺寻思注意力助手' });
}

for (const width of [1366, 390]) {
  test(`budget reasons, typed ranges and confirmed timeout at ${width}px`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(context);
    const panel = await open(page);
    await panel.locator('textarea').first().fill('第三方模块怎么接入，配置和代码入口在哪里？');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => f.asks.length).toBe(1);
    f.update('answering', { inspection: { message: '正在整理已有证据：查询发现阶段已结束', sources: [
      { operation: 'list_directory', path: 'project', status: 'ok', complete: true, offset: 0, entryCount: 3 },
      { operation: 'list_directory', path: 'project/docs', status: 'ok', complete: false, offset: 0 },
      { operation: 'search_text', path: 'project/base', status: 'ok', complete: false, visited: 20, matchCount: 2, limitReason: 'search_bytes' },
      { operation: 'read_text', path: 'project/base/entry.ts', status: 'ok', complete: false, offset: 0, end: 120 },
      ...['file_bytes', 'total_bytes', 'context_chars'].map(limitReason => ({ operation: 'read_text', status: 'limit', limitReason })),
      { operation: 'read_text', status: 'limit' },
    ] } });
    await panel.locator('summary').filter({ hasText: '查询来源' }).click();
    await expect(panel).toContainText('目录项：本页 3 项');
    await expect(panel).toContainText('目录分页（偏移 0）');
    await expect(panel).toContainText('搜索覆盖：检查 20 个文件目标，命中 2 处');
    await expect(panel).toContainText('字符范围：0–120（非全文）');
    await expect(panel).not.toContainText('0–?');
    for (const reason of ['搜索读取额度已用尽', '单文件超过 256 KiB', '累计读取额度已用尽', '项目证据上下文已满', '达到查询上限']) {
      await expect(panel).toContainText(reason);
    }
    await page.screenshot({ path: info.outputPath(`budget-sources-${width}.png`) });
    f.update('unknown', { answer: '❌ 旁路回答超时，未生成完整回答。', inspection: {
      errorCode: 'timeout', message: '结果待确认：旁路调用尚未确认退出，主线不受影响',
    } });
    await expect(panel).toContainText('结果待确认 · 查询超时');
    f.update('error', { inspection: { message: '旁路回答超时，未生成完整回答；旁路退出已确认，主线不受影响。' } });
    await expect(panel).toContainText('查询失败 · 查询超时');
    await expect(panel).toContainText('退出已确认');
    await expect(panel).not.toContainText('正在确认');
    await expect(panel).not.toContainText('结果待确认');
    await expect(panel.getByRole('button', { name: '编辑后重新提问' })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`budget-timeout-${width}.png`) });
    expect(f.asks).toHaveLength(1);
    expect(f.requests).not.toContain('abortMessage');
  });

  test(`readonly phases, sources, failure and stop at ${width}px`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(context);
    const panel = await open(page);
    await expect(panel).toContainText('可按问题只读查询当前项目与运行进度');
    expect(f.asks).toHaveLength(0);
    expect(f.requests).not.toContain('listWorkingDirTree');
    f.hold();
    await panel.locator('textarea').first().fill('当前目录 OpenSpec 进度如何？');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await expect(panel).toContainText('正在提交问题');
    expect(f.asks).toHaveLength(1);
    f.accept();
    await expect(panel).toContainText('准备查询');
    f.update('reading', { inspection: { message: '正在读取 OpenSpec 任务' } });
    await expect(panel).toContainText('正在读取项目');
    await page.screenshot({ path: info.outputPath(`reading-${width}.png`) });
    f.update('answering', { inspection: { message: '正在整理任务证据' } });
    await expect(panel).toContainText('正在回答');
    f.update('done', { answer: '原清单 6/10，60%。人工待办仍未勾选，自动范围 6/8。', inspection: {
      sampledAt: 1791670000, message: '回答完成', sources: [{ operation: 'openspec_tasks', path: 'openspec/changes/example/tasks.md',
        change: 'example', revision: 'abc1234567890123456', readAt: 1791670001, status: 'ok', complete: true, checked: 6, total: 10 }],
    } });
    await expect(panel).toContainText('原清单 6/10');
    await panel.locator('summary').filter({ hasText: '查询来源' }).click();
    await expect(panel).toContainText('openspec/changes/example/tasks.md');
    await expect(panel).toContainText('不等于人工验收');
    const terminal = JSON.parse(JSON.stringify(f.histories[first.id][0]));
    f.histories[first.id][0] = { ...terminal, status: 'answering', inspection: { phase: 'reading', sequence: 1 } };
    f.push();
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`sources-${width}.png`) });
    f.histories[first.id][0] = terminal;
    await panel.locator('textarea').first().fill('再查一次');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => f.asks.length).toBe(2); f.accept();
    f.update('error', { answer: '读取失败，未推断完成率', inspection: { errorCode: 'denied', message: '访问被拒绝', sources: [{ operation: 'read_text', status: 'denied' }] } });
    await expect(panel).toContainText('查询失败 · 访问被拒绝');
    await panel.getByRole('button', { name: '编辑后重新提问' }).click();
    await expect(panel.locator('textarea').first()).toHaveValue('再查一次');
    expect(f.asks).toHaveLength(2);
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => f.asks.length).toBe(3); f.accept();
    await panel.getByTitle('停止当前俺寻思回答（不影响主线）').click();
    await expect(panel).toContainText('结果待确认');
    f.update('cancelled', { inspection: { message: '本次旁路已停止，主线不受影响' } });
    await expect(panel).toContainText('已停止旁路');
    expect(f.requests).not.toContain('abortMessage');
    await page.screenshot({ path: info.outputPath(`failure-stop-${width}.png`) });
    const bounds = await panel.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  });
}

test('fixed focus, new question freshness and late reply stay with the original Session', async ({ page, context }) => {
  const f = await fixture(context);
  const panel = await open(page);
  await panel.getByRole('button', { name: /固定/ }).click();
  await page.locator('.awu-sidebar').getByText(second.title, { exact: true }).click();
  await panel.locator('textarea').first().fill('读取固定项目');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => f.asks.length).toBe(1);
  expect(f.asks[0][0]).toBe(first.id);
  f.update('done', { answer: '第一轮证据', inspection: { sampledAt: 10 } });
  await expect(panel).toContainText('第一轮证据');
  await panel.getByRole('button', { name: /解除固定/ }).click();
  await expect(panel).not.toContainText('第一轮证据');
  f.push(first.id);
  await expect(panel).not.toContainText('第一轮证据');
  await panel.locator('textarea').first().fill('新项目现在到哪里');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => f.asks.length).toBe(2);
  expect(f.asks[1][0]).toBe(second.id);
  f.update('done', { answer: '新采样的进度', inspection: { sampledAt: 20 } }, second.id);
  await expect(panel).toContainText('新采样的进度');
  await expect(panel).not.toContainText('第一轮证据');
});
