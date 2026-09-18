import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { CallDiagnostic } from '../../src/utils/loopDiagnostics';

function recordFixture() {
  const now = Date.now() / 1000;
  return {
    seq: 1, round: 1, subStage: 'execute', goal: '修复当前回归', completed: false, error: '', result: '',
    createdAt: now - 60, updatedAt: now - 10, subStarted: { prepare: now - 60, execute: now - 50 }, analysis: null,
    callDiagnostics: [] as CallDiagnostic[],
    orchestration: [
      { index: 1, desc: '核实现状', mode: 'sequential', access: 'read', status: 'done', output: '第一步核实完成', endedAt: 3 },
      { index: 2, desc: '修复缺口', mode: 'sequential', access: 'write', status: 'running', output: '', endedAt: 0 },
      { index: 3, desc: '验证回归', mode: 'sequential', access: 'read', status: 'pending', output: '', endedAt: 0 },
    ],
    stageDetails: {
      prepare: { status: 'done', attemptCount: 1, message: '结构校验通过', attempts: [
        { kind: 'initial', rawOutput: '规划阶段原始内容：独立保存', parsed: { steps: [{ desc: '修复缺口' }] }, valid: true, validation: ['三个步骤均有说明；只做结构校验。'] },
      ] },
      execute: { status: 'running', message: '正在执行分步' },
    },
  };
}

async function fixture(page: Page) {
  let record = recordFixture();
  let older: ReturnType<typeof recordFixture> | null = null;
  const sessionId = 'qa-loop-000';
  let socket: WebSocketRoute;
  let hold = false;
  let fail = false;
  let reads = 0;
  const pending: Array<() => void> = [];
  const state = () => ({ sessionId, stage: 'loopexecute', goal: '阶段审计回归', goalHistory: [], ideas: [],
    loops: (older ? [older, record] : [record]).map(item => ({ ...item, detailLoaded: false, result: '',
      callDiagnostics: item.callDiagnostics.slice(-1),
      orchestration: item.orchestration.map(step => ({ ...step, output: '', hasOutput: !!step.output })),
      stageDetails: Object.fromEntries(Object.entries(item.stageDetails).map(([key, value]) => [key,
        { status: value.status, message: value.message, ...('attemptCount' in value ? { attemptCount: value.attemptCount } : {}) }])),
    })), riskCoefficient: 0, maxLoops: 8, effectiveMaxLoops: 8, round: record.round, roundLoopCount: 1,
    status: 'active', stopReason: '', bestScore: 0, latestScore: 0, asides: [], addons: [],
    auto: false, running: true, resumable: false, controlMode: 'loop', canTakeover: false });
  await page.routeWebSocket(/.*/, ws => {
    socket = ws;
    const server = ws.connectToServer();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'loopGetState' && frame.params[0] === sessionId) return reply(state());
      if (frame.method === 'loopGetRecord' && frame.params[0] === sessionId) {
        reads++;
        const snapshot = structuredClone(older?.seq === frame.params[1] ? older : record);
        const send = () => reply(fail ? { status: 'error', message: '模拟详情读取失败' } : { status: 'ok', record: { ...snapshot, detailLoaded: true } });
        if (hold) pending.push(send); else send();
        return;
      }
      server.send(message);
    });
  });
  return {
    enableHistory: () => { older = structuredClone(record); record.seq = 2; record.round = 2; },
    diagnostic: (call: CallDiagnostic) => {
      record.callDiagnostics = [call];
      socket.send(JSON.stringify({ event: 'loopProgress', data: JSON.stringify({ sessionId, seq: record.seq, subStage: call.stage, text: '', diagnostic: call }) }));
    },
    reads: () => reads,
    setHold: (value: boolean) => { hold = value; },
    setFail: (value: boolean) => { fail = value; },
    release: () => pending.splice(0).forEach(send => send()),
    update: (change: (value: ReturnType<typeof recordFixture>) => void) => { change(record); socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(state()) })); },
    progress: (text: string) => socket.send(JSON.stringify({ event: 'loopProgress', data: JSON.stringify({ sessionId, seq: 1, subStage: 'step2', text }) })),
  };
}

async function openFlow(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '返回工作总览', exact: true })).toBeVisible();
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.locator('.awu-sidebar').getByText('首页交付 Loop 1', { exact: true }).click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  await pane.getByRole('button', { name: '🔀 流程', exact: true }).click();
  await expect(pane.getByRole('button', { name: '查看 Prepare 阶段', exact: true }).first()).toBeVisible();
  return pane;
}

test('each stage opens independently and completed step output refreshes while the next runs', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = await fixture(page);
  let pane = await openFlow(page);
  await pane.getByRole('button', { name: '查看 Prepare 阶段', exact: true }).click();
  let detail = pane.getByLabel('Loop #1 阶段详情', { exact: true });
  await expect(detail).toContainText('三个步骤均有说明');
  await detail.getByText('原始输出 · 第 1 次', { exact: true }).click();
  await expect(detail).toContainText('规划阶段原始内容：独立保存');
  await expect(detail).not.toContainText('本次执行结果');
  await pane.getByRole('button', { name: '查看步骤 2：修复缺口', exact: true }).click();
  await expect(detail.getByRole('button', { name: '步骤 2 详情' })).toHaveAttribute('aria-expanded', 'true');
  data.progress('第二步实时输出仍可展开');
  await expect(detail).toContainText('第二步实时输出仍可展开');
  expect(data.reads()).toBe(1);
  data.setHold(true);
  data.update(record => {
    record.orchestration[1] = { ...record.orchestration[1], status: 'done', endedAt: 11, output: '第二步持久化结果：缺口已修复' };
    record.orchestration[2].status = 'running';
  });
  await expect.poll(data.reads).toBe(2);
  await expect(detail).toContainText('第二步实时输出仍可展开');
  data.update(record => { record.orchestration[2].endedAt = 12; });
  data.setHold(false);
  data.release();
  await expect(detail).toContainText('第二步持久化结果：缺口已修复');
  await expect.poll(data.reads).toBe(3); // Coalesces the update that arrived during the held read.
  await pane.getByRole('button', { name: '查看 Analysis 阶段', exact: true }).click();
  await expect(detail).toContainText('Analysis · 阶段记录');
  await expect(detail).not.toContainText('第二步持久化结果');
  for (let i = 0; i < 5; i++) data.update(() => {});
  await pane.getByRole('button', { name: '查看步骤 2：修复缺口', exact: true }).click();
  await expect(detail).toContainText('第二步持久化结果：缺口已修复');
  expect(data.reads()).toBe(3);
  await page.screenshot({ path: info.outputPath('completed-step-live-next.png'), fullPage: false });
  await page.getByRole('button', { name: '返回工作总览', exact: true }).click();
  data.update(record => { record.orchestration[2].endedAt = 13; });
  await expect(page.locator('[data-session-tab-panel]:visible')).toHaveCount(0);
  expect(data.reads()).toBe(3);
  await page.getByRole('tab', { name: /首页交付 Loop 1/ }).click();
  await expect.poll(data.reads).toBe(4);
  pane = await openFlow(page);
  await pane.getByRole('button', { name: '查看步骤 2：修复缺口', exact: true }).click();
  detail = pane.getByLabel('Loop #1 阶段详情', { exact: true });
  await expect(detail).toContainText('第二步持久化结果：缺口已修复');
  expect(errors).toEqual([]);
});

test('detail loading errors are retryable and degraded planning never appears as normal success', async ({ page }, info) => {
  const data = await fixture(page);
  data.setFail(true);
  const pane = await openFlow(page);
  data.update(record => {
    record.stageDetails.prepare.status = 'degraded';
    record.stageDetails.prepare.message = '规划重试耗尽，已降级为系统单步执行';
    record.stageDetails.prepare.attempts[0].valid = false;
    record.stageDetails.prepare.attempts[0].validation = ['计划结构校验失败'];
  });
  const prepare = pane.getByRole('button', { name: '查看 Prepare 阶段', exact: true });
  await expect(prepare).toHaveAttribute('data-stage-status', 'degraded');
  await prepare.click();
  await expect(pane.getByRole('alert')).toContainText('模拟详情读取失败');
  expect(data.reads()).toBe(1);
  data.setFail(false);
  await pane.getByRole('button', { name: '重试加载详情', exact: true }).click();
  const detail = pane.getByLabel('Loop #1 阶段详情', { exact: true });
  await expect(detail).toContainText('规划重试耗尽，已降级为系统单步执行');
  await detail.getByText('原始输出 · 第 1 次', { exact: true }).click();
  await expect(detail).toContainText('规划阶段原始内容：独立保存');
  expect(data.reads()).toBe(2);
  await detail.getByRole('button', { name: '重新加载详情', exact: true }).click();
  await expect.poll(data.reads).toBe(3);
  await page.screenshot({ path: info.outputPath('degraded-plan-audit.png'), fullPage: false });
});

test('flow switches newer → older → newer using status, blank area, keyboard and the detail navigator', async ({ page }, info) => {
  const data = await fixture(page);
  data.enableHistory();
  const pane = await openFlow(page);
  const newer = pane.getByRole('group', { name: 'Loop #2 流程', exact: true });
  const older = pane.getByRole('group', { name: 'Loop #1 流程', exact: true });
  await expect(newer.getByRole('button', { name: '查看 Execute 阶段', exact: true })).toHaveAttribute('data-stage-status', 'running');
  await expect(older.getByRole('button', { name: '查看 Execute 阶段', exact: true })).toHaveAttribute('data-stage-status', 'current');
  await newer.getByRole('button', { name: '查看 Prepare 阶段', exact: true }).getByText('已完成', { exact: true }).click();
  await expect(pane.getByLabel('Loop #2 阶段详情', { exact: true })).toBeVisible();
  data.setHold(true);
  await older.getByRole('button', { name: '查看 Prepare 阶段', exact: true }).click({ position: { x: 10, y: 55 } });
  await expect(older).toHaveAttribute('data-selected', 'true');
  await expect.poll(data.reads).toBe(2);
  // Switch back while the older detail response is in flight.
  const target = newer.getByRole('button', { name: '查看 Prepare 阶段', exact: true });
  await target.scrollIntoViewIfNeeded();
  await target.focus();
  await target.press('Enter');
  await expect(newer).toHaveAttribute('data-selected', 'true');
  data.setHold(false); data.release();
  await expect(pane.getByLabel('Loop #2 阶段详情', { exact: true })).toBeVisible();
  await pane.getByRole('combobox', { name: '查看流程轮次' }).selectOption('1');
  await expect(pane.getByLabel('Loop #1 阶段详情', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: '返回最新 Loop', exact: true }).click();
  await expect(pane.getByLabel('Loop #2 阶段详情', { exact: true })).toBeVisible();
  expect(data.reads()).toBe(2);
  await page.screenshot({ path: info.outputPath('flow-reselection.png'), fullPage: false });
});

test('live prepare diagnostics distinguish rate limiting, thinking and text without repeated detail reads', async ({ page }, info) => {
  const data = await fixture(page);
  const pane = await openFlow(page);
  await pane.getByRole('button', { name: '查看 Prepare 阶段', exact: true }).click();
  await expect.poll(data.reads).toBe(1);
  const start = Date.now() / 1000 - 70;
  const call: CallDiagnostic = { id: 'call-fixture', stage: 'prepare', status: 'running', phase: 'retry_wait',
    startedAt: start, dispatchedAt: start + 1, observedAt: start + 60, localPrepareMs: 1000,
    backendType: 'openai-compatible', model: 'fixture-model', promptChars: 32000, estimatedPromptTokens: 8000, imageCount: 2,
    textChars: 0, thinkingChars: 0, eventCounts: {}, transportAttempts: 2, retryCount: 1, retryWaitSeconds: 8,
    lastError: { category: 'rate_limit', httpStatus: 429 },
    timeline: [{ phase: 'response_headers', at: start + 59, elapsedMs: 59000, httpStatus: 429 },
      { phase: 'retry_wait', at: start + 60, elapsedMs: 60000, delaySeconds: 8 }],
  };
  data.diagnostic(call);
  const diagnostics = pane.getByRole('region', { name: '模型调用诊断' });
  await expect(diagnostics).toContainText('HTTP 429');
  await expect(diagnostics).toContainText('不一定是并发');
  await expect(diagnostics).toContainText('32,000');
  await expect(diagnostics).toContainText('尚未观察到');
  for (let i = 1; i <= 10; i++) data.diagnostic({ ...call, phase: 'thinking', observedAt: start + 60 + i,
    firstEventAt: start + 61, thinkingChars: i * 100, eventCounts: { thinking: i } });
  await expect(diagnostics).toContainText('思考 1,000 字符');
  expect(data.reads()).toBe(1);
  await diagnostics.getByText('事件时间线（最近 32 个状态变化，无请求原文／密钥）', { exact: true }).click();
  await expect(diagnostics).toContainText('等待 8s');
  await diagnostics.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('prepare-diagnostics.png'), fullPage: false });
});
