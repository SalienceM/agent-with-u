import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

function recordFixture() {
  return {
    seq: 1, round: 1, subStage: 'execute', goal: '修复当前回归', completed: false, error: '', result: '',
    createdAt: 1, updatedAt: 10, subStarted: { prepare: 1, execute: 2 }, analysis: null,
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
  const sessionId = 'qa-loop-000';
  let socket: WebSocketRoute;
  let hold = false;
  let fail = false;
  let reads = 0;
  const pending: Array<() => void> = [];
  const state = () => ({ sessionId, stage: 'loopexecute', goal: '阶段审计回归', goalHistory: [], ideas: [],
    loops: [{ ...record, detailLoaded: false, result: '',
      orchestration: record.orchestration.map(step => ({ ...step, output: '', hasOutput: !!step.output })),
      stageDetails: Object.fromEntries(Object.entries(record.stageDetails).map(([key, value]) => [key,
        { status: value.status, message: value.message, ...('attemptCount' in value ? { attemptCount: value.attemptCount } : {}) }])),
    }], riskCoefficient: 0, maxLoops: 8, effectiveMaxLoops: 8, round: 1, roundLoopCount: 1,
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
        const snapshot = structuredClone(record);
        const send = () => reply(fail ? { status: 'error', message: '模拟详情读取失败' } : { status: 'ok', record: { ...snapshot, detailLoaded: true } });
        if (hold) pending.push(send); else send();
        return;
      }
      server.send(message);
    });
  });
  return {
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
  await expect(pane.getByRole('button', { name: '查看 Prepare 阶段', exact: true })).toBeVisible();
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
