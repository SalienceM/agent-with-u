import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
const { states, record, environmentStates } = require('../home/fixtures/loop-workbench.cjs');
const sid = 'qa-loop-000';

async function fixture(page: Page, name = 'idle') {
  let value: any = { ...states()[name], sessionId: sid };
  let socket: WebSocketRoute;
  const calls: Array<{ method: string; params: any[] }> = [];
  const pending: Array<() => void> = [];
  let hold = false;
  let holdRun = false;
  let holdAuto = false;
  let rejectGoal = false;
  const summary = () => ({ protocolVersion: 1, sessionId: sid, controlMode: 'loop', controlRevision: 0,
    stage: value.stage, round: value.round, auto: value.auto,
    eligibility: { takeover: { allowed: true, reasonCode: 'ready', message: '可以接管', nextStep: 'request' },
      release: { allowed: false, reasonCode: 'loop', message: '已在 LOOP', nextStep: 'check' } } });
  const push = () => socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify({ ...value,
    loops: value.loops.map((rec: any) => rec.openspecSummary ? { ...rec, openspecRun: {}, detailLoaded: false } : rec) }) }));
  await page.routeWebSocket(/127\.0\.0\.1:45421/, ws => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage(message => ws.send(message));
    ws.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'sessionWorkbenchCapabilities' && frame.params?.[0] === sid) {
        ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', protocolVersion: 1,
          identity: { ownerId: 'local', executorInstance: 'synthetic', sessionId: sid, workingDir: 'C:/qa/workspaces/project-0', workspaceRevision: 'a'.repeat(64) },
          capabilities: { viewMode: 1, windowHandoff: 0, documents: 0, languageServices: 0, terminal: 0 } }) }));
        return;
      }
      if (typeof frame.method !== 'string' || !frame.method.startsWith('loop') || frame.params?.[0] !== sid) { server.send(message); return; }
      calls.push(frame);
      const reply = (result: any) => ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'loopControlGet') return reply(summary());
      if (frame.method === 'loopAsideList') return reply({ status: 'ok', asides: [] });
      if (frame.method === 'loopGetState') return reply(value);
      if (frame.method === 'loopRepairTaskContract') {
        const request = JSON.parse(frame.params[1]);
        value.contractRepair = { ...request, version: 1, status: 'running', attemptCount: 1, reason: '核对原始任务图' };
        value.contractRepairActive = true;
        value.contractRepairEligibility.canRequest = false;
        value.contractRepairEligibility.message = '原修复正在执行，请等待回执';
        reply({ status: 'accepted', operation: value.contractRepair }); push(); return;
      }
      if (frame.method === 'loopTaskContractRepairGet') return reply({ status: 'ok', operation: value.contractRepair });
      if (frame.method === 'loopCancelTaskContractRepair') return reply({ status: 'accepted', message: '已请求停止，等待退出确认' });
      if (frame.method === 'loopRunIteration' && holdRun) { pending.push(() => reply({ status: 'ok' })); return; }
      if (frame.method === 'loopSetAuto' && holdAuto) { pending.push(() => { value.auto = frame.params[1]; reply({ status: 'ok' }); push(); }); return; }
      if (frame.method === 'loopSetGoal' && rejectGoal) return reply({ status: 'error', message: '隔离夹具拒绝保存' });
      if (frame.method === 'loopGetRecord') {
        const result = { status: 'ok', record: { ...value.loops.find((item: any) => item.seq === frame.params[1]), detailLoaded: true,
          result: '隔离持久化成果', stageDetails: {}, callDiagnostics: [] } };
        if (hold) pending.push(() => reply(result)); else reply(result);
        return;
      }
      if (frame.method === 'loopSetAuto') value.auto = frame.params[1];
      else if (frame.method === 'loopRunIteration') value.running = true;
      else if (frame.method === 'loopAdvanceToOut') { value.stage = 'loopout'; value.running = false; value.stopReason = '用户停止，保留成果'; }
      else if (frame.method === 'loopContinue') { value.stage = 'loopexecute'; value.round++; value.goal = frame.params[1]; }
      else if (frame.method === 'loopSetGoal') value.goal = frame.params[1];
      else if (frame.method === 'loopAddAddon') value.addons.push({ id: 'new-addon', text: frame.params[1], images: JSON.parse(frame.params[2] || '[]'), status: 'pending' });
      else if (frame.method === 'loopSetPolicy') value.policy = JSON.parse(frame.params[1]);
      else if (frame.method === 'loopDiscard') value.loops = [];
      else if (frame.method === 'loopSealIdea') { value.goal = frame.params[1]; value.stage = 'loopexecute'; }
      else throw new Error('Unexpected workbench mutation: ' + frame.method);
      reply({ status: 'ok' }); push();
    });
  });
  await page.goto('/');
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.locator('.awu-sidebar').getByText('首页交付 Loop 1', { exact: true }).click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  await expect(pane.getByTestId('loop-workbench')).toBeVisible();
  return { pane, calls, push, count: (method: string) => calls.filter(call => call.method === method).length,
    replace: (name: string, extra: any = {}) => { value = { ...states()[name], sessionId: sid, ...extra }; push(); },
    update: (fn: (state: any) => void) => { fn(value); push(); }, hold: (on: boolean) => { hold = on; },
    release: () => { pending.splice(0).forEach(reply => reply()); },
    holdRun: (on: boolean) => { holdRun = on; },
    holdAuto: (on: boolean) => { holdAuto = on; }, rejectGoal: (on: boolean) => { rejectGoal = on; },
    progress: () => socket.send(JSON.stringify({ event: 'loopProgress', data: JSON.stringify({ sessionId: sid, seq: 1, subStage: 'step1', text: '实时内容' }) })),
  };
}

for (const width of [1366, 390]) test(`OpenSpec preparation has no false binding or range-conflict at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await fixture(page);
  if (width === 390 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(state => {
    state.goal = '基于 @docs/proposals/test-change 使用 OpenSpec 开发';
    state.taskSource = { status: 'unavailable', revision: 0, code: 'project_required', reason: '旧版：不会自动初始化' };
    const cause = { causeRef: 'wait:source', causeRevision: 1, round: 1, seq: 1 };
    state.loops = [{ ...record(), decision: { ...cause, action: 'wait', revision: 0, basisRefs: ['source:0'] } }];
    state.progressGuard = { ...cause, pause: true, reason: '旧版：不会自动初始化' };
  });
  const issue = f.pane.getByRole('region', { name: '需要处理', exact: true });
  await expect(issue).toContainText('OpenSpec 项目待准备');
  await expect(issue).not.toContainText('还有 1 个问题');
  await issue.getByRole('button', { name: '查看处理依据' }).click();
  const card = f.pane.getByTestId('loop-source-card');
  await expect(card).toContainText('点击推进会自动准备并衔接方案');
  await expect(card.getByRole('button', { name: '解除绑定…' })).toHaveCount(0);
  await expect(card).not.toContainText('正式任务勾选');
  expect(f.count('loopRunIteration')).toBe(0);
  expect(f.count('loopTaskSourceDiscover')).toBe(0);
  await page.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  f.update(state => {
    state.running = true; state.taskSource = { status: 'preparing', revision: 0 };
    state.progressGuard = {}; state.loops[0].decision = {};
    state.loops[0].stageDetails = { openspecSetup: { status: 'running', message: '正在准备 OpenSpec 项目与方案' } };
  });
  await expect(f.pane.getByTestId('loop-openspec-preparation')).toContainText('正在准备 OpenSpec 项目与方案');
  await expect(f.pane.getByRole('region', { name: '需要处理', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('openspec-preparation.png'), fullPage: true });
  f.update(state => {
    state.running = false;
    const reason = '准备调用报告：helper_unknown_error: setup refresh had errors';
    state.taskSource = { status: 'unavailable', revision: 0, code: 'preparation_blocked', reason };
    state.loops[0].stageDetails.openspecSetup = { status: 'blocked', message: reason };
  });
  await expect(issue).toContainText('OpenSpec 准备受阻');
  await expect(issue).toContainText('helper_unknown_error');
  await expect(issue).not.toContainText('尚未初始化');
  await issue.getByRole('button', { name: '查看问题详情' }).click();
  await expect(f.pane.getByRole('dialog')).toContainText('无需新建 Session');
  expect(f.count('loopRunIteration')).toBe(0);
  await page.screenshot({ path: info.outputPath('openspec-preparation-blocked.png'), fullPage: true });
});

for (const width of [1366, 390]) test(`contract recovery is explicit and one cause stays one card at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const f = await fixture(page);
  if (width === 390 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const cause = { causeRef: 'contract:fixture', causeRevision: 1 };
  f.update(state => {
    state.contractRepairProtocolVersion = 1;
    state.taskSource = { status: 'current', revision: 1, change: 'fixture', checked: 0, total: 3 };
    state.contractRepairEligibility = { ...cause, canRequest: true, round: 1, seq: 1, controlRevision: 0 };
    state.iterationRequest = { version: 1, sessionId: sid, round: 1, seq: 1, controlRevision: 0,
      sourceRevision: 1, environmentRevision: 0, canRequest: false, message: '先核对任务映射问题' };
    state.progressGuard = { ...cause, pause: true, round: 1, seq: 1, reason: '任务编号 U 遗漏' };
    state.loops = [{ ...record(), detailLoaded: false,
      decision: { ...cause, decisionId: 'contract-wait', round: 1, seq: 1, action: 'wait', reasonCode: 'task_contract_invalid',
        reasonText: '任务编号 U 遗漏', resumeCondition: '打开任务映射详情，核对原始证据；不必重新绑定正常来源。' },
      contractValidation: { ...cause, version: 1, status: 'exhausted', origin: 'output', attemptCount: 3,
        fields: ['taskPlan.tasks'], affectedIds: ['U'], reason: '任务编号 U 遗漏' } }];
  });
  const issue = f.pane.getByRole('region', { name: '需要处理', exact: true });
  await expect(issue).toContainText('任务计划仍不合格');
  await expect(f.pane.getByTestId('loop-progress-notice')).toHaveCount(0);
  await expect(issue.getByText(/还有/)).toHaveCount(0);
  await f.pane.getByRole('button', { name: '流程', exact: true }).click();
  await expect(issue.getByText(/还有/)).toHaveCount(0);
  await f.pane.getByRole('button', { name: '面板', exact: true }).click();
  await issue.getByRole('button', { name: '查看处理依据', exact: true }).click();
  const dialog = f.pane.getByRole('dialog');
  await expect(dialog).toContainText('错误字段：taskPlan.tasks');
  await expect(dialog).toContainText('规划调用 3/3');
  await expect(dialog).toContainText('受影响任务：U');
  expect(f.count('loopRepairTaskContract')).toBe(0);
  expect(f.count('loopRunIteration')).toBe(0);
  await page.screenshot({ path: info.outputPath(`contract-${width}-cause.png`) });
  const repair = dialog.getByRole('button', { name: '修复任务映射', exact: true });
  await repair.dispatchEvent('click'); await repair.dispatchEvent('click');
  await expect(dialog.getByRole('region', { name: '任务映射修复' })).toContainText('正在只读修复');
  expect(f.count('loopRepairTaskContract')).toBe(1);
  f.update(state => {
    state.contractRepair.status = 'succeeded'; state.contractRepair.reason = '映射已修复，尚未运行';
    state.contractRepairActive = false;
    state.contractRepairEligibility.message = '当前无待修复的协议问题';
    state.loops[0].contractValidation.status = 'repaired';
    state.iterationRequest.canRequest = true;
    state.iterationRequest.message = '';
  });
  await expect(dialog.getByRole('region', { name: '任务映射修复' })).toContainText('映射已修复，尚未运行');
  await expect(dialog).toHaveAttribute('aria-label', '映射已修复，尚未运行');
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopSetAuto')).toBe(0);
  await page.screenshot({ path: info.outputPath(`contract-${width}-repaired.png`) });
  await dialog.getByRole('button', { name: '关闭详情，返回工作台' }).press('Escape');
  await expect(issue.getByRole('button', { name: '查看处理依据', exact: true })).toBeFocused();
  await f.pane.getByRole('button', { name: '运行下一次', exact: true }).click();
  expect(f.count('loopRunIteration')).toBe(1);
});

test('old issue form cannot repair a new revision and legacy endpoint never runs as fallback', async ({ page }) => {
  const f = await fixture(page);
  f.update(state => {
    const cause = { causeRef: 'contract:c', causeRevision: 1 };
    state.contractRepairProtocolVersion = 1;
    state.contractRepairEligibility = { ...cause, canRequest: true, round: 1, seq: 1, controlRevision: 0 };
    state.loops = [{ ...record(), contractValidation: { ...cause, status: 'paused' },
      decision: { ...cause, decisionId: 'd', round: 1, seq: 1, action: 'wait', reasonCode: 'task_contract_invalid' } }];
  });
  await f.pane.getByRole('button', { name: '查看处理依据', exact: true }).click();
  const dialog = f.pane.getByRole('dialog');
  f.update(state => { state.loops[0].decision.causeRevision++; state.loops[0].contractValidation.causeRevision++; state.contractRepairEligibility.causeRevision++; });
  await expect(dialog).toContainText('旧目标不能执行操作');
  await expect(dialog.getByRole('button', { name: '修复任务映射', exact: true })).toBeDisabled();
  f.update(state => { delete state.contractRepairProtocolVersion; });
  await expect(dialog).toContainText('当前执行端未提供修复协议');
  expect(f.count('loopRepairTaskContract')).toBe(0); expect(f.count('loopRunIteration')).toBe(0);
});

for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`workbench states fit ${size.width} and keyboard details return focus`, async ({ page }, info) => {
    await page.setViewportSize(size);
    const f = await fixture(page);
    for (const name of ['idea', 'idle', 'running', 'resumable', 'multi', 'result', 'legacy', 'human']) {
      f.replace(name);
      const bench = f.pane.getByTestId('loop-workbench');
      await expect(bench.getByTestId('loop-goal-summary')).toBeInViewport();
      await expect(bench.getByTestId('loop-current-status')).toBeInViewport();
      await expect(bench.getByTestId('loop-stage-rail')).toBeInViewport();
      await expect(bench.getByRole('button', { name: '面板', exact: true })).toBeVisible();
      await expect(bench.getByRole('button', { name: '流程', exact: true })).toBeVisible();
      await expect(bench.getByRole('group', { name: 'LOOP 统一操作' }).getByRole('button').first()).toBeInViewport();
      await expect(bench.getByTestId('loop-source-card')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`workbench-${size.width}-${name}.png`) });
    }
    f.replace('running');
    await expect(f.pane.getByTestId('loop-current-status')).toContainText('正在执行');
    const more = f.pane.getByText('更多操作', { exact: true });
    await more.click();
    const menu = await f.pane.getByTestId('loop-more-actions').boundingBox();
    expect(menu).not.toBeNull();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: info.outputPath(`workbench-${size.width}-more.png`) });
    await more.click();
    const trigger = f.pane.getByRole('button', { name: '运行诊断', exact: true });
    await trigger.focus(); await trigger.press('Enter');
    const close = f.pane.getByRole('button', { name: '关闭详情，返回工作台' });
    await expect(close).toBeFocused();
    const kit = await f.pane.getByTitle('Workspace Kits · Session 标准配件（实验）').boundingBox();
    expect(kit).not.toBeNull();
    expect(await f.pane.getByRole('dialog').evaluate((dialog, box) =>
      dialog.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), kit!)).toBe(true);
    await page.screenshot({ path: info.outputPath(`workbench-${size.width}-details.png`) });
    await close.press('Escape');
    await expect(trigger).toBeFocused();
    expect(f.count('loopGetRecord')).toBe(0);
    expect(f.calls.some(call => /Source|Environment/.test(call.method))).toBe(false);
  });
}

test('each main action sends one matching RPC; Auto stop never discards current work', async ({ page }) => {
  const f = await fixture(page, 'running');
  await f.pane.getByRole('button', { name: '停止后续自动执行', exact: true }).click();
  expect(f.count('loopSetAuto')).toBe(1); expect(f.count('loopDiscard')).toBe(0);
  await expect(f.pane.getByTestId('loop-current-status')).toContainText('正在执行');
  page.once('dialog', dialog => dialog.accept());
  await f.pane.getByRole('button', { name: '停止本轮并查看结果', exact: true }).click();
  expect(f.count('loopAdvanceToOut')).toBe(1); expect(f.count('loopDiscard')).toBe(0);
  await expect(f.pane.getByTestId('loop-current-status')).toContainText('本轮结果');
  await f.pane.getByRole('button', { name: '开启新一轮', exact: true }).click();
  expect(f.count('loopContinue')).toBe(1);
  f.replace('resumable');
  await f.pane.getByRole('button', { name: '恢复 Loop #1', exact: true }).click();
  expect(f.count('loopRunIteration')).toBe(1);
  f.replace('idea');
  await f.pane.getByPlaceholder('直接写目标，或留空让模型汇总下方想法').fill('明确本轮目标');
  page.once('dialog', dialog => dialog.accept());
  await f.pane.getByRole('button', { name: '确认目标，进入执行', exact: true }).click();
  expect(f.count('loopSealIdea')).toBe(1);
});

test('two primary views keep scores separate from 7/25 task and subtask evidence', async ({ page }, info) => {
  const f = await fixture(page);
  f.update(state => {
    state.taskSource = { status: 'current', revision: 3, change: 'fixture', checked: 7, total: 25 };
    state.roundLoopCount = 1;
    state.loops = [{ ...record(), detailLoaded: false, analysis: { score: 99, scoreObserved: true },
      deliverySummary: { counts: { implemented: 2, verified: 7, manual: 1 }, milestones: { counts: { verified: 3 } } } }];
  });
  await expect(f.pane.getByTestId('loop-score-ring')).toHaveAttribute('aria-label', '评审 99 分');
  await expect(f.pane).toContainText('正式任务勾选 7/25');
  await expect(f.pane).toContainText('子项台账（不计入正式任务分母）：已实现待验 0 · 已验证 3');
  await expect(f.pane.getByTestId('loop-acceptance')).toContainText('尚未确认');
  await expect(f.pane.getByText('可交付', { exact: true })).toHaveCount(0);
  f.update(state => { state.loops[0].deliverySummary.milestones.counts.implemented = 1; state.latestScore = 85; state.loops[0].analysis.score = 85; });
  await expect(f.pane).toContainText('正式任务勾选 7/25');
  await expect(f.pane).toContainText('子项台账（不计入正式任务分母）：已实现待验 1 · 已验证 3');
  await f.pane.getByRole('button', { name: 'Loop #1 第 1 轮 · 未完成', exact: false }).click();
  await expect.poll(() => f.count('loopGetRecord')).toBe(1);
  const stateReads = f.count('loopGetState');
  for (let i = 0; i < 3; i++) {
    await f.pane.getByRole('button', { name: '流程', exact: true }).click();
    await expect(f.pane.getByRole('group', { name: 'Loop #1 流程' })).toBeVisible();
    await f.pane.getByRole('button', { name: '面板', exact: true }).click();
  }
  expect(f.count('loopGetRecord')).toBe(1);
  expect(f.count('loopGetState')).toBe(stateReads);
  expect(f.calls.some(call => /Source|Environment|RunIteration/.test(call.method))).toBe(false);
  for (const width of [1366, 390]) {
    // 在宽屏状态先收起，再缩小视口，避免移动端自动折叠与点击竞争。
    const collapse = page.getByRole('button', { name: '收起侧栏', exact: true });
    // 折叠后的桌面图标栏也有 .awu-sidebar，必须检查展开状态的真实按钮。
    if (width === 390 && await collapse.isVisible()) await collapse.click();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    if (width === 390) await expect(page.locator('.awu-sidebar')).toBeHidden();
    await f.pane.getByRole('button', { name: '流程', exact: true }).click();
    const lane = f.pane.getByRole('group', { name: 'Loop #1 流程' });
    await lane.scrollIntoViewIfNeeded();
    const bounds = await lane.boundingBox();
    const main = await f.pane.getByRole('main', { name: 'LOOP 当前任务' }).boundingBox();
    expect(bounds!.width / main!.width).toBeGreaterThan(.85);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`restored-flow-${width}.png`) });
  }
});

test('unsupported diagnosis does not lock resume and duplicate requests stay single across view changes', async ({ page }) => {
  const f = await fixture(page);
  f.replace('resumable', environmentStates().unsupported);
  // Keep the fixture identity, not the synthetic unit-test identity.
  f.update(state => { state.sessionId = sid; });
  const resume = f.pane.getByRole('button', { name: '恢复 Loop #1', exact: true });
  await expect(resume).toBeEnabled();
  await expect(f.pane.getByRole('region', { name: '需要处理' })).toHaveCount(0);
  f.holdRun(true);
  await resume.click();
  await expect(f.pane.getByRole('button', { name: '正在提交执行…', exact: true })).toBeDisabled();
  await f.pane.getByRole('button', { name: '流程', exact: true }).click();
  await expect(f.pane.getByRole('button', { name: '正在提交执行…', exact: true })).toBeDisabled();
  expect(f.count('loopRunIteration')).toBe(1);
  f.release();
  await expect(resume).toBeEnabled();
  await f.pane.getByRole('button', { name: '运行诊断', exact: true }).click();
  await expect(f.pane.getByRole('dialog')).toContainText('不支持或覆盖不足');
  expect(f.count('loopRunIteration')).toBe(1);
  expect(f.count('loopExecutionEnvironmentCheck')).toBe(0);
});

test('bound source explains effective dependency without selecting an extra workflow or hiding invalid declarations', async ({ page }) => {
  const f = await fixture(page);
  f.update(state => {
    state.taskSource = { status: 'current', revision: 4, change: 'fixture', checked: 7, total: 25 };
    state.executionEnvironment = { revision: 3, status: 'unknown', effectiveDependencies: { version: 1, sessionId: sid,
      sourceRevision: 4, environmentRevision: 3, items: [{ id: 'openspec', required: true, origins: [
        { kind: 'task_source', status: 'current', ref: 'source:4' }, { kind: 'declaration', status: 'invalid', ref: 'opsx-apply' }] }] } };
  });
  await f.pane.getByRole('button', { name: '运行诊断', exact: true }).click();
  const dialog = f.pane.getByRole('dialog');
  await expect(dialog).toContainText('来自任务来源 · 来源已核对');
  await expect(dialog).toContainText('来自显式声明 · 声明失效，需重新核对');
  await expect(dialog).toContainText('额外工作流选择：无额外选择');
  await expect(dialog).not.toContainText('未选择（通用');
  await dialog.getByRole('button', { name: '关闭详情，返回工作台' }).press('Shift+Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  expect(f.calls.some(call => /Source|Environment|RunIteration/.test(call.method))).toBe(false);
});

test('normal source inspection has no unbind form, cancellation and long text do not write or overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  f.update(state => { state.goal = '很长的目标说明'.repeat(150); state.taskSource = {
    status: 'current', revision: 4, change: 'long-source-name-'.repeat(20), checked: 7, total: 25 };
  });
  await f.pane.getByRole('button', { name: /^来源：/ }).click();
  const card = f.pane.getByTestId('loop-source-card');
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await card.getByRole('button', { name: '解除绑定…', exact: true }).click();
  await card.getByLabel('来源范围处置依据').fill('仅草稿，取消不提交');
  await card.getByRole('button', { name: '取消', exact: true }).click();
  await expect(card.getByRole('textbox')).toHaveCount(0);
  expect(f.count('loopTaskSourceSet')).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('specific issue navigation is read only and obsolete targets cannot act on another revision', async ({ page }) => {
  const f = await fixture(page, 'multi');
  await f.pane.getByRole('button', { name: '查看处理依据', exact: true }).click();
  const dialog = f.pane.getByRole('dialog');
  await expect(dialog).toHaveAttribute('aria-label', '旧调用退出尚未确认');
  await expect(dialog.getByLabel('指定检查依据')).toBeVisible();
  await expect(dialog.getByTestId('loop-source-card')).toHaveCount(0);
  await expect(dialog.getByLabel('详情分类')).toHaveCount(0);
  f.update(state => { state.executionEnvironment = { revision: 4, status: 'passed', blockers: [] }; });
  await expect(dialog).toContainText('该问题已更新或解决');
  await expect(dialog.getByRole('button', { name: '重新检查环境' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await f.pane.getByRole('button', { name: '还有 1 个问题', exact: true }).click();
  await expect(dialog).toContainText('核对任务来源');
  await expect(dialog).toContainText('存在未解决任务阻塞');
  await dialog.getByRole('button', { name: '核对范围差异' }).click();
  await expect(dialog.getByTestId('loop-source-card')).toBeVisible();
  expect(f.calls.some(call => /Source|Environment|RunIteration/.test(call.method))).toBe(false);
});

test('discard has separate record and disk confirmations; cancellation is read only', async ({ page }) => {
  const f = await fixture(page, 'resumable');
  f.update(state => { state.loops = [{ ...record(), seq: 1, hasGitCheckpoint: false },
    { ...record(), seq: 2, hasGitCheckpoint: true }]; });
  await f.pane.getByText('更多操作', { exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await f.pane.getByRole('button', { name: '丢弃本次记录…', exact: true }).click();
  expect(f.count('loopDiscard')).toBe(0);
  let dialogs = 0;
  page.on('dialog', async dialog => {
    dialogs++;
    if (dialogs === 1) { expect(dialog.message()).toContain('Loop #2'); await dialog.accept(); }
    else await dialog.dismiss();
  });
  await f.pane.getByRole('button', { name: '丢弃本次记录…', exact: true }).click();
  expect(dialogs).toBe(2);
  expect(f.calls.find(call => call.method === 'loopDiscard')?.params).toEqual([sid, 0, false]);
});

test('hidden details, repeated pushes and streaming do not reload; selected history survives live updates', async ({ page }) => {
  const f = await fixture(page, 'running');
  f.update(state => { state.loops = [1, 2].map(seq => ({ ...record(), seq, detailLoaded: false, updatedAt: seq })); });
  await f.pane.getByRole('button', { name: '过程与历史', exact: true }).click();
  await f.pane.getByRole('group', { name: 'Loop #1 流程', exact: true }).getByRole('button', { name: '查看 Execute 阶段', exact: true }).click();
  await expect.poll(() => f.count('loopGetRecord')).toBe(1);
  for (let i = 0; i < 5; i++) { f.push(); f.progress(); }
  await expect(f.pane.getByLabel('查看流程轮次')).toHaveValue('1');
  expect(f.count('loopGetRecord')).toBe(1);
  await f.pane.getByRole('button', { name: '运行诊断', exact: true }).click();
  f.update(state => { state.loops[0].updatedAt++; });
  await page.waitForTimeout(150);
  expect(f.count('loopGetRecord')).toBe(1);
  await f.pane.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await expect.poll(() => f.count('loopGetRecord')).toBe(2);
  expect(f.calls.some(call => /Source|Environment/.test(call.method))).toBe(false);
});

test('goal and Addon drafts survive opening details; supplement is queued without altering current step', async ({ page }) => {
  const f = await fixture(page, 'running');
  const input = f.pane.getByPlaceholder('补充要求 / 修正…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）');
  await input.fill('保留正在执行的步骤');
  await input.focus();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=">');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await f.pane.getByRole('button', { name: '目标与补充', exact: true }).click();
  await f.pane.getByRole('button', { name: '编辑', exact: true }).click();
  const goal = f.pane.getByRole('dialog').locator('textarea').first();
  await goal.fill('未提交的目标草稿');
  await f.pane.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await f.pane.getByRole('button', { name: '流程', exact: true }).click();
  await f.pane.getByRole('button', { name: '目标与补充', exact: true }).click();
  await expect(goal).toHaveValue('未提交的目标草稿');
  await f.pane.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await expect(f.pane.getByRole('button', { name: '目标与补充', exact: true })).toBeFocused();
  await expect(input).toHaveValue('保留正在执行的步骤');
  await input.press('Control+Enter');
  await expect.poll(() => f.count('loopAddAddon')).toBe(1);
  expect(JSON.parse(f.calls.find(call => call.method === 'loopAddAddon')!.params[2])).toHaveLength(1);
  await expect(f.pane.getByTestId('loop-current-status')).toContainText('正在执行');
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopSetGoal')).toBe(0);
});

test('same Session on a different executor cannot receive a late cached detail', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async () => {
    // @ts-ignore Vite serves this test-only module; all LOOP reads are in-memory fakes.
    const { mountWorkbenchHarness } = await import('/tests/acceptance/workbench-harness.tsx');
    (window as any).loopHarness = mountWorkbenchHarness();
    (window as any).loopHarness.render('node-a');
  });
  const bench = page.getByTestId('loop-workbench');
  await expect(bench.getByTestId('loop-goal-summary')).toHaveText('节点 node-a');
  await bench.getByRole('button', { name: '成果与证据', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).loopHarness.reads.length)).toBe(1);
  await page.evaluate(() => (window as any).loopHarness.render('node-b'));
  await expect(bench.getByTestId('loop-goal-summary')).toHaveText('节点 node-b');
  await page.evaluate(() => (window as any).loopHarness.release());
  await expect(bench).not.toContainText('node-a 的独立原文');
  await bench.getByRole('button', { name: '成果与证据', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).loopHarness.reads.length)).toBe(2);
  await page.evaluate(() => (window as any).loopHarness.release());
  await bench.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(bench).toContainText('node-b 的独立原文');
  await bench.getByLabel('Loop #1 阶段详情').getByRole('button', { name: '✕', exact: true }).click();
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await expect(bench.getByTestId('loop-current-status')).toContainText('只读总览');
    await expect(bench.getByRole('button', { name: '返回人工工作区' })).toBeInViewport();
    await expect(bench.getByText('更多操作', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`workbench-${width}-manual.png`) });
  }
  await bench.getByRole('button', { name: '目标与补充', exact: true }).click();
  await expect(bench.getByText('尚未纳入的图片补充', { exact: true })).toBeVisible();
  await expect(bench.getByRole('img', { name: '待纳入补充图片' })).toBeVisible();
  await expect(bench.getByRole('button', { name: '＋ 添加', exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).loopHarness.close());
});

test('issue details never auto-resume; explicit continuation retains known source and environment gates', async ({ page }) => {
  const f = await fixture(page, 'multi');
  await f.pane.getByRole('button', { name: '还有 2 个问题', exact: true }).click();
  const resume = f.pane.getByRole('button', { name: '按原条件运行下一次', exact: true });
  await expect(resume).toBeDisabled();
  expect(f.count('loopRunIteration')).toBe(0);
  f.replace('idle', { progressGuard: { pause: true, reason: '连续无进展' } });
  await expect(resume).toBeEnabled();
  expect(f.count('loopRunIteration')).toBe(0);
  await resume.click();
  await expect.poll(() => f.count('loopRunIteration')).toBe(1);
  expect(f.count('loopSetAuto')).toBe(0);
});

test('custom strategy survives settings edits and every unresolved issue stays inspectable', async ({ page }) => {
  const f = await fixture(page, 'multi');
  f.update(state => { state.policy = { maxLoops: 13, workMode: 'delivery', strategy: '用户自定义：先看证据，再实现',
    backends: { analysis: 'qa-reviewer' }, runtimes: { execute: { model: 'fixture-model', reasoningEffort: 'high' } } }; });
  await f.pane.getByRole('button', { name: '还有 2 个问题', exact: true }).click();
  const details = f.pane.getByRole('dialog');
  await expect(details).toContainText('旧调用退出尚未确认');
  await expect(details).toContainText('核对任务来源');
  await expect(details).toContainText('存在未解决任务阻塞');
  await details.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await f.pane.getByRole('button', { name: '策略与心智', exact: true }).click();
  await details.getByRole('button', { name: /策略与心智/ }).click();
  const strategy = details.getByPlaceholder('描述 loop 的策略与评分心智，会注入到每次 prepare / analysis 提示中…');
  await expect(strategy).toHaveValue('用户自定义：先看证据，再实现');
  await details.getByLabel('LOOP 推进方式').selectOption('explore');
  await details.getByRole('button', { name: '保存策略', exact: true }).click();
  await expect.poll(() => f.count('loopSetPolicy')).toBe(1);
  const saved = JSON.parse(f.calls.find(call => call.method === 'loopSetPolicy')!.params[1]);
  expect(saved).toMatchObject({ maxLoops: 13, workMode: 'explore', strategy: '用户自定义：先看证据，再实现',
    backends: { analysis: 'qa-reviewer' }, runtimes: { execute: { model: 'fixture-model', reasoningEffort: 'high' } } });
  expect(f.count('loopRunIteration')).toBe(0);
});

for (const width of [1366, 390]) test(`native OpenSpec actions show waiting receipts progress and defects at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await fixture(page);
  if (width === 390 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.holdRun(true);
  await f.pane.getByRole('button', { name: '运行下一次', exact: true }).click();
  await expect(f.pane.getByTestId('loop-action-feedback')).toContainText('执行 LOOP：正在提交');
  await expect(f.pane.getByRole('button', { name: '正在提交执行…', exact: true })).toBeDisabled();
  await f.pane.getByRole('button', { name: '流程', exact: true }).click();
  await expect(f.pane.getByTestId('loop-action-feedback')).toContainText('正在提交');
  expect(f.count('loopRunIteration')).toBe(1);
  await page.screenshot({ path: info.outputPath(`native-${width}-sending.png`) });
  f.release();
  f.update(state => { state.running = true; state.startup = { status: 'running', message: '正在准备工作区快照…' }; });
  await expect(f.pane.getByTestId('loop-action-feedback')).toContainText('请求已接收');
  await expect(f.pane).toContainText('正在准备工作区快照');
  f.update(state => {
    state.startup = { status: 'done' }; state.running = false;
    state.loops = [{ ...record(), openspecSummary: { change: 'test-change', phase: 'verify', status: 'done',
      checked: 24, total: 25, pending: 0, manual: 1, fixes: 1, verified: true, message: '发现必修问题' },
      openspecRun: { verify: { issues: [{ id: 'bug', severity: 'critical', summary: '重复保存导致任务丢失', evidence: 'fixture.ts:12', requiresFix: true, manual: false }] } } }];
  });
  await expect(f.pane.getByTestId('loop-openspec-status')).toContainText('任务 24/25');
  await expect(f.pane.getByTestId('loop-openspec-status')).toContainText('人工未验收 1');
  await expect(f.pane.getByTestId('loop-openspec-status')).toContainText('必修问题 1');
  f.holdAuto(true);
  await f.pane.getByRole('button', { name: '开启 Auto', exact: true }).click();
  await expect(f.pane.getByTestId('loop-action-feedback')).toContainText('开启 Auto：正在提交');
  f.release();
  await expect(f.pane.getByTestId('loop-action-feedback')).toContainText('已完成');
  await expect(f.pane.getByRole('button', { name: '停止后续自动执行', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`native-${width}-progress.png`) });
  await f.pane.getByRole('button', { name: '成果与证据', exact: true }).click();
  await expect(f.pane.getByText('重复保存导致任务丢失', { exact: false })).toBeVisible();
  expect(f.count('loopTaskSourceDiscover')).toBe(0);
  expect(f.count('loopSetAuto')).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('pending Run does not freeze another Session and failed goal save retains the draft', async ({ page }) => {
  const f = await fixture(page);
  f.holdRun(true);
  await f.pane.getByRole('button', { name: '运行下一次', exact: true }).click();
  await expect(f.pane.getByTestId('loop-action-feedback')).toContainText('正在提交');
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const current = page.locator('[data-session-tab-panel]:visible');
  const selected = await current.getAttribute('data-session-tab-panel');
  await expect(current.getByTestId('loop-action-feedback')).toHaveCount(0);
  f.release();
  await expect(current).toHaveAttribute('data-session-tab-panel', selected!);
  await page.getByRole('tab', { name: '首页交付 Loop 1', exact: true }).click();
  await f.pane.getByRole('button', { name: '目标与补充', exact: true }).click();
  const details = f.pane.getByRole('dialog');
  await details.getByRole('button', { name: '编辑', exact: true }).click();
  const input = details.locator('textarea').first();
  await input.fill('保留失败后的目标草稿');
  f.rejectGoal(true);
  await details.getByRole('button', { name: '保存', exact: true }).click();
  await expect(details.getByTestId('loop-action-feedback')).toContainText('隔离夹具拒绝保存');
  await expect(input).toHaveValue('保留失败后的目标草稿');
  expect(f.count('loopRunIteration')).toBe(1);
});

test('original ideas, goal revisions and applied Addon images remain readable', async ({ page }) => {
  const f = await fixture(page);
  const img = { id: 'synthetic-image', mime_type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  f.update(state => {
    state.goalHistory = [{ goal: '原始目标', hint: '', source: 'seal', createdAt: 1 }, { goal: '修订目标', hint: '新的想法', source: 'manual', createdAt: 2 }];
    state.ideas = [{ id: 'idea1', prompt: '带图原始想法', status: 'done', result: '保留展开结果', error: '', images: [img] }];
    state.addons = [{ id: 'addon1', text: '带图已纳入补充', status: 'applied', appliedSeq: 1, images: [img] }];
    state.loops = [record()];
  });
  await f.pane.getByRole('button', { name: '目标与补充', exact: true }).click();
  const details = f.pane.getByRole('dialog');
  await details.getByRole('button', { name: /目标演变/ }).click();
  await expect(details).toContainText('原始目标'); await expect(details).toContainText('修订目标');
  await details.getByRole('button', { name: /原始诉求/ }).click();
  await expect(details).toContainText('带图原始想法');
  await details.getByRole('button', { name: /Addon 历史/ }).click();
  await expect(details).toContainText('带图已纳入补充');
  await expect(details.locator('img')).toHaveCount(2);
  expect(f.calls.filter(call => !/Get|List/.test(call.method))).toHaveLength(0);
});
