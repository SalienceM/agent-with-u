import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { CallDiagnostic } from '../../src/utils/loopDiagnostics';
import type { DeliveryReport, ProgressGuard } from '../../src/components/LoopDeliveryStatus';
import type { LoopDecision, LoopSourceSummary } from '../../src/types/loopContinuation';
import type { ExecutionEnvironment, EnvironmentCheck } from '../../src/types/loopEnvironment';

function recordFixture() {
  const now = Date.now() / 1000;
  return {
    seq: 1, round: 1, subStage: 'execute', goal: '修复当前回归', completed: false, error: '', result: '',
    createdAt: now - 60, updatedAt: now - 10, subStarted: { prepare: now - 60, execute: now - 50 }, analysis: null,
    callDiagnostics: [] as CallDiagnostic[],
    environmentChecks: [] as EnvironmentCheck[],
    delivery: {} as DeliveryReport,
    outcomeVersion: 0, terminalKind: '', decision: {} as LoopDecision, callResults: {} as Record<string, string>, taskResult: 'unknown',
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

async function fixture(page: Page, progressGuard: ProgressGuard = {}, options: { running?: boolean; source?: LoopSourceSummary; manual?: boolean; environment?: ExecutionEnvironment } = {}) {
  let record = recordFixture();
  let older: ReturnType<typeof recordFixture> | null = null;
  const sessionId = 'qa-loop-000';
  let socket: WebSocketRoute;
  let hold = false;
  let fail = false;
  let reads = 0;
  let source = options.source;
  let sourceReads = 0;
  let executionCalls = 0;
  let environment = options.environment;
  let environmentReads = 0, environmentChecks = 0;
  const pending: Array<() => void> = [];
  const state = () => ({ sessionId, stage: 'loopexecute', goal: '阶段审计回归', goalHistory: [], ideas: [],
    progressGuard, taskSource: source, executionEnvironment: environment, handoff: { available: true, source: 'conversion' },
    loops: (older ? [older, record] : [record]).map(item => ({ ...item, detailLoaded: false, result: '', delivery: {},
      callDiagnostics: item.callDiagnostics.slice(-1),
      orchestration: item.orchestration.map(step => ({ ...step, output: '', hasOutput: !!step.output })),
      stageDetails: Object.fromEntries(Object.entries(item.stageDetails).map(([key, value]) => [key,
        { status: value.status, message: value.message, ...('attemptCount' in value ? { attemptCount: value.attemptCount } : {}) }])),
    })), riskCoefficient: 0, maxLoops: 8, effectiveMaxLoops: 8, round: record.round, roundLoopCount: 1,
    status: 'active', stopReason: '', bestScore: 0, latestScore: 0, asides: [], addons: [],
    auto: false, running: options.running ?? true, resumable: false, controlMode: options.manual ? 'manual' : 'loop', canTakeover: false });
  await page.routeWebSocket(/.*/, ws => {
    socket = ws;
    const server = ws.connectToServer();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message));
      const reply = (value: unknown) => ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      if (frame.method === 'loopGetState' && frame.params[0] === sessionId) return reply(state());
      if (frame.method.startsWith('loopExecutionEnvironment')) {
        if (frame.method === 'loopExecutionEnvironmentGet') {
          environmentReads++;
          return reply({ status: 'ok', sessionId, environment, choices: [{ command: 'opsx-apply', skillId: 'openspec-apply-change', digest: 'fixture-digest' }] });
        }
        if (frame.method === 'loopExecutionEnvironmentCheck') environmentChecks++;
        const snapshot = { ...environment, revision: (environment?.revision || 0) + 1,
          status: 'passed' as const, latest: { ...environment?.latest, id: 'checked', status: 'passed' as const, reason: '', resumeCondition: '', quiesced: true }, blockers: [] };
        if (frame.method === 'loopExecutionEnvironmentSelectWorkflow') snapshot.workflowRef = { command: frame.params[1] };
        const send = () => { environment = snapshot; reply({ status: 'ok', sessionId, environment }); };
        if (hold) pending.push(send); else { send(); socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(state()) })); }
        return;
      }
      if (frame.method.startsWith('loopTaskSource')) {
        sourceReads++;
        if (frame.method === 'loopTaskSourceDiscover') {
          const send = () => reply({ status: 'ok', sessionId, revision: source?.revision || 0, discoveryId: 'fixture-discovery',
            candidates: [{ name: 'first-change' }, { name: 'second-change' }],
            binding: { executor: 'fixture-node', workspace: 'isolated workspace', backendId: 'fixture', cliVersion: '1.13.1' } });
          if (hold) pending.push(send); else send();
          return;
        }
        if (frame.method === 'loopTaskSourceSet') {
          const action = frame.params[1];
          source = { ...source, revision: (source?.revision || 0) + 1, status: action === 'unbind' ? 'unbound' : 'current',
            change: frame.params[4] || source?.change, executor: 'fixture-node', backendId: 'fixture', total: 25, checked: 2 };
          reply({ status: 'ok', sessionId, source });
          socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(state()) }));
          return;
        }
        return reply({ status: 'ok', sessionId, source });
      }
      if (['loopRunIteration', 'loopSetAuto'].includes(frame.method)) { executionCalls++; return reply({ status: 'ok' }); }
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
    sourceReads: () => sourceReads,
    executionCalls: () => executionCalls,
    environmentReads: () => environmentReads,
    environmentChecks: () => environmentChecks,
    setEnvironment: (value: ExecutionEnvironment) => { environment = value; socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(state()) })); },
    setSource: (value: LoopSourceSummary) => { source = value; socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(state()) })); },
    setHold: (value: boolean) => { hold = value; },
    setFail: (value: boolean) => { fail = value; },
    release: () => pending.splice(0).forEach(send => send()),
    seed: (change: (value: ReturnType<typeof recordFixture>) => void) => { change(record); },
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

const environmentFixture = (): ExecutionEnvironment => ({ revision: 1, status: 'blocked', latest: {
  id: 'env-first', revision: 1, status: 'blocked', coverage: 'native_policy', backendId: 'fixture', role: 'prepare',
  access: 'read-only', transport: 'app-server', runnerVersion: '0.154.0', checkedAt: 1700000000,
  reasonCode: 'env_access_denied', reason: '当前受限环境拒绝访问所需入口。',
  resumeCondition: '在相同策略下恢复合法访问后重新检查。', quiesced: true,
}, blockers: [] });

test('environment check is explicit, coalesces clicks and never starts task work', async ({ page }, info) => {
  const data = await fixture(page, { pause: true }, { running: false, environment: environmentFixture() });
  const pane = await openFlow(page);
  const card = pane.getByTestId('loop-environment-card');
  await expect(card).toContainText('read-only');
  await expect(card).toContainText('部分覆盖');
  expect(data.environmentReads()).toBe(0);
  await card.getByRole('button', { name: '查看详情与工作流选项' }).click();
  await card.getByLabel('工作流依赖', { exact: true }).selectOption('opsx-apply');
  await card.getByRole('button', { name: '确认依赖选择' }).click();
  await expect(card).toContainText('工作流依赖：opsx-apply');
  data.setHold(true);
  await card.getByRole('button', { name: '重新检查环境' }).click();
  await expect(card.getByRole('button', { name: '重新检查环境' })).toBeDisabled();
  expect(data.environmentChecks()).toBe(1);
  data.setHold(false); data.release();
  await expect(card).toContainText('未开启 Auto 或恢复任务');
  expect(data.executionCalls()).toBe(0);
  for (let i = 0; i < 4; i++) data.update(() => {});
  expect(data.environmentReads()).toBe(1);
  await page.screenshot({ path: info.outputPath('environment-check.png') });
});

test('environment delayed reply cannot replace a newer revision; unknown and unsupported remain honest', async ({ page }) => {
  const data = await fixture(page, {}, { running: false });
  const pane = await openFlow(page);
  const card = pane.getByTestId('loop-environment-card');
  await expect(card).toContainText('环境未知');
  data.setEnvironment({ ...environmentFixture(), revision: 3, status: 'unsupported', latest: { ...environmentFixture().latest, status: 'unsupported' } });
  await expect(card).toContainText('不支持或覆盖不足');
  data.setHold(true);
  await card.getByRole('button', { name: '重新检查环境' }).click();
  data.setEnvironment({ ...environmentFixture(), revision: 10 });
  data.release(); data.setHold(false);
  await expect(card).toContainText('当前受限环境拒绝访问所需入口');
  expect(data.executionCalls()).toBe(0);
});

test('running and inspectOnly environment cards expose no mutation controls', async ({ page }) => {
  const data = await fixture(page, {}, { running: true, environment: environmentFixture() });
  const pane = await openFlow(page);
  const card = pane.getByTestId('loop-environment-card');
  await expect(card.getByRole('button', { name: '重新检查环境' })).toHaveCount(0);
  await expect(card).toContainText('人工成功不能证明自动受限路径可用');
  expect(data.environmentChecks()).toBe(0);
});

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

test('delivery evidence and scoped blockers stay inspectable without extra polling', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = await fixture(page, { pause: true, reason: '连续 3 次评审未确认任务状态推进', noProgressCount: 3, readyIds: ['2.1'] });
  data.seed(record => {
    record.delivery = {
      mode: 'delivery', source: 'openspec/changes/example/tasks.md', scopeComplete: true, valid: true,
      items: [
        { id: '1.2', title: '恢复用户数据', status: 'blocked', dependsOn: [], evidence: '原哈希不能还原正文', manualBasis: '' },
        { id: '2.1', title: '独立组件', status: 'implemented', dependsOn: [], evidence: 'components/button.ts@abc；隔离测试通过', manualBasis: '' },
        { id: '3.1', title: '人工检查', status: 'manual', dependsOn: [], evidence: '', manualBasis: '用户明确要求真机人工检查' },
      ],
      blockers: [{ id: 'recovery', kind: 'local', affected: ['1.2'], reason: '没有可信备份', resolution: '提供备份后核对原哈希' }],
      verification: { status: 'pending', evidence: '仍有非人工项未验收' },
    };
  });
  const pane = await openFlow(page);
  await expect(pane.getByTestId('loop-progress-notice')).toContainText('自动执行已暂停');
  await expect(pane.getByTestId('loop-progress-notice')).toContainText('尚未宣称完成');
  await pane.getByRole('button', { name: '查看 Analysis 阶段', exact: true }).click();
  const report = pane.getByRole('region', { name: '任务与证据台账' });
  await expect(report).toContainText('局部阻塞');
  await expect(report).toContainText('已实现待验 1');
  await report.getByText('展开 3 项任务、依赖和证据', { exact: true }).click();
  await expect(report).toContainText('用户明确要求真机人工检查');
  expect(data.reads()).toBe(1);
  for (let i = 0; i < 3; i++) data.update(() => {});
  await expect(report).toContainText('提供备份后核对原哈希');
  expect(data.reads()).toBe(1);
  await report.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('loop-delivery-evidence.png'), fullPage: false });
  expect(errors).toEqual([]);
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

test('explicit source discovery, conflict confirmation and unbinding never start execution', async ({ page }, info) => {
  const data = await fixture(page, {}, { running: false });
  data.seed(record => { record.terminalKind = 'paused'; });
  const pane = await openFlow(page);
  const card = pane.getByTestId('loop-source-card');
  await expect(card).toContainText('未绑定（通用模式）');
  expect(data.sourceReads()).toBe(0);
  await card.getByRole('button', { name: '发现 OpenSpec 来源' }).click();
  await expect(card.getByLabel('选择 OpenSpec change')).toHaveValue('first-change');
  await expect(card).toContainText('即使只有一个候选');
  await card.getByLabel('选择 OpenSpec change').selectOption('second-change');
  await card.getByRole('button', { name: '确认绑定', exact: true }).click();
  await expect(card).toContainText('second-change');
  expect(data.executionCalls()).toBe(0);
  data.setSource({ status: 'unavailable', revision: 2, change: 'second-change', executor: 'fixture-node', total: 25, checked: 2, reason: '任务来源暂不可核对' });
  await expect(card).toContainText('任务来源暂不可核对');
  data.setSource({ status: 'stale', revision: 3, change: 'second-change', executor: 'fixture-node', total: 25, checked: 2 });
  await expect(card).toContainText('快照已过期');
  data.setSource({ status: 'conflict', revision: 4, change: 'second-change', executor: 'fixture-node', total: 25, checked: 2,
    diff: { removed: ['1.3'], added: ['1.26'], artifactsChanged: true } });
  await expect(card).toContainText('范围冲突');
  await expect(card.getByRole('button', { name: '确认范围修订' })).toBeDisabled();
  await card.getByLabel('来源范围处置依据').fill('用户确认新范围，旧损失继续保留');
  await card.getByRole('button', { name: '确认范围修订' }).click();
  await expect(card).toContainText('已核对');
  await card.getByLabel('来源范围处置依据').fill('转为通用核对，未完成项保留');
  await card.getByRole('button', { name: '确认解除绑定' }).click();
  await expect(card).toContainText('未绑定（通用模式）');
  expect(data.executionCalls()).toBe(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('loop-source-controls.png'), fullPage: false });
});

test('same decision and 2/25 milestone evidence in panel and flow, without polling', async ({ page }, info) => {
  const data = await fixture(page, {}, { running: false });
  data.seed(record => {
    record.outcomeVersion = 1; record.terminalKind = 'completed'; record.completed = true;
    record.callResults = { execute: 'normal', analysis: 'normal' };
    record.decision = { action: 'replan', reasonCode: 'ready_work', reasonText: '外壳已有增量，父任务未验收', nextStep: '选择属性/技能就绪任务', decisionId: 'decision-1' };
    record.delivery = { mode: 'delivery', source: 'fixture/tasks.md', valid: true, scopeComplete: true,
      items: [{ id: '1.3', title: '外壳父任务', status: 'pending', dependsOn: [], evidence: '', manualBasis: '' }], blockers: [],
      reconciliation: { valid: false, checked: 2, total: 25 },
      milestoneSummary: { counts: { verified: 1 }, credited: ['shell'] },
      milestoneReview: { valid: true, milestones: [{ id: 'shell', parentId: '1.3', acceptance: '可操作外壳', status: 'verified', validity: 'current' }] } };
  });
  const pane = await openFlow(page);
  await expect(pane.getByTestId('loop-decision').first()).toContainText('选择属性/技能就绪任务');
  await pane.getByRole('button', { name: '查看 Analysis 阶段', exact: true }).click();
  const report = pane.getByRole('region', { name: '任务与证据台账' });
  await expect(report.getByTestId('loop-formal-count')).toContainText('2/25');
  await report.getByTestId('loop-milestones').locator('summary').click();
  await expect(report).toContainText('本轮认可增量：shell');
  await expect(report).toContainText('不代表父任务集成验收通过');
  await pane.getByRole('button', { name: '🗂 面板', exact: true }).click();
  await expect(pane.getByTestId('loop-decision').first()).toContainText('选择属性/技能就绪任务');
  expect(data.sourceReads()).toBe(0);
  expect(data.reads()).toBe(1);
  data.update(record => { record.decision = { action: 'wait', reasonText: '需补充授权', resumeCondition: '由用户完成授权确认', decisionId: 'decision-2' }; });
  await expect(pane.getByTestId('loop-decision').first()).toContainText('由用户完成授权确认');
  await page.screenshot({ path: info.outputPath('loop-decision-milestone.png'), fullPage: false });
});

test('waiting, failure, budget stop and completion remain distinct in both views', async ({ page }) => {
  const data = await fixture(page, {}, { running: false });
  data.seed(record => { record.outcomeVersion = 1; record.completed = true; });
  const pane = await openFlow(page);
  const scenarios: Array<{ decision: LoopDecision; call: string; expected: string[] }> = [
    { decision: { action: 'wait', reasonText: '等待必要输入', resumeCondition: '用户补充条件' }, call: 'normal', expected: ['调度：等待', '正常结束', '解除条件：用户补充条件'] },
    { decision: { action: 'retry', reasonText: '真实调用失败，有限重试' }, call: 'error', expected: ['调度：有限重试', '真实失败'] },
    { decision: { action: 'stop', reasonCode: 'budget_exhausted', reasonText: '轮次预算耗尽，目标尚未完成' }, call: 'normal', expected: ['调度：停止', '预算耗尽，目标尚未完成'] },
    { decision: { action: 'complete', completionScope: 'full', reasonText: '完整验收已核对' }, call: 'normal', expected: ['调度：完成', '完整验收已核对'] },
    { decision: { action: 'complete', completionScope: 'automatic', reasonText: '人工真机核验保留' }, call: 'normal', expected: ['自动范围完成，待人工核验', '人工真机核验保留'] },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    data.update(record => { record.decision = { ...scenario.decision, decisionId: `result-${index}` }; record.callResults = { execute: scenario.call }; record.taskResult = scenario.decision.action === 'complete' ? 'verified' : 'partial'; });
    const acceptance = scenario.decision.action === 'complete' ? '累计任务验收：已验证' : '累计任务验收：部分成果';
    for (const expected of scenario.expected) await expect(pane.getByTestId('loop-decision').first()).toContainText(expected);
    await expect(pane.getByTestId('loop-decision').first()).toContainText(acceptance);
    await pane.getByRole('button', { name: '🗂 面板', exact: true }).click();
    for (const expected of scenario.expected) await expect(pane.getByTestId('loop-decision').first()).toContainText(expected);
    await expect(pane.getByTestId('loop-decision').first()).toContainText(acceptance);
    await pane.getByRole('button', { name: '🔀 流程', exact: true }).click();
  }
  expect(data.executionCalls()).toBe(0);
  expect(data.sourceReads()).toBe(0);
});

test('running and manual takeover are read-only; ordinary chat does not query sources', async ({ page }) => {
  const data = await fixture(page, {}, { running: false, manual: true });
  const pane = await openFlow(page);
  await expect(pane.getByTestId('loop-source-card').getByRole('button', { name: '发现 OpenSpec 来源' })).toBeDisabled();
  await expect(pane.getByTestId('loop-environment-card').getByRole('button', { name: '重新检查环境' })).toHaveCount(0);
  expect(data.sourceReads()).toBe(0);
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.locator('.awu-sidebar').getByText('客户工作会话 5', { exact: true }).click();
  await expect(page.locator('[data-session-tab-panel]:visible').getByTestId('loop-source-card')).toHaveCount(0);
  expect(data.sourceReads()).toBe(0);
  expect(data.executionCalls()).toBe(0);
  expect(data.environmentChecks()).toBe(0);
  expect(data.environmentReads()).toBe(0);
});

test('a late environment check belongs only to its original session', async ({ page }) => {
  const data = await fixture(page, {}, { running: false, environment: environmentFixture() });
  const pane = await openFlow(page);
  data.setHold(true);
  await pane.getByTestId('loop-environment-card').getByRole('button', { name: '重新检查环境' }).click();
  await expect.poll(data.environmentChecks).toBe(1);
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.locator('.awu-sidebar').getByText('首页交付 Loop 2', { exact: true }).click();
  const card = page.locator('[data-session-tab-panel]:visible').getByTestId('loop-environment-card');
  data.setHold(false); data.release();
  await expect(card).toContainText('环境未知');
  await expect(card).not.toContainText('对应检查项通过');
  expect(data.executionCalls()).toBe(0);
});

test('a late source discovery belongs only to its original session', async ({ page }) => {
  const data = await fixture(page, {}, { running: false });
  const pane = await openFlow(page);
  data.setHold(true);
  await pane.getByTestId('loop-source-card').getByRole('button', { name: '发现 OpenSpec 来源' }).click();
  await expect.poll(data.sourceReads).toBe(1);
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.locator('.awu-sidebar').getByText('首页交付 Loop 2', { exact: true }).click();
  const current = page.locator('[data-session-tab-panel]:visible');
  await expect(current.getByTestId('loop-source-card')).toContainText('未绑定');
  data.setHold(false); data.release();
  await expect(current.getByLabel('选择 OpenSpec change')).toHaveCount(0);
  expect(data.sourceReads()).toBe(1);
  expect(data.executionCalls()).toBe(0);
});
