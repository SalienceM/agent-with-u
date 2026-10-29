import { test, expect, type Page, type WebSocketRoute, type Locator } from '@playwright/test';
import { OrthographicCamera, Vector3 } from 'three';
const { states, record, environmentStates } = require('../home/fixtures/loop-workbench.cjs');
const sid = 'qa-loop-000';
test.use({ video: { mode: 'on', size: { width: 1600, height: 1000 } } });

async function fixture(page: Page, name = 'legacy', runtime = false) {
  let value: any = { ...states()[name], sessionId: sid, policy: { executionMode: 'aimein', aimeinReviewers: [] } };
  let socket: WebSocketRoute;
  const calls: Array<{ method: string; params: any[] }> = [];
  const pending: Array<() => void> = [];
  let hold = false;
  let holdRun = false;
  let runRecord: any;
  let holdAuto = false;
  let rejectGoal = false;
  let rejectWrites = false;
  let unknownWrites = false;
  let offline = false;
  let memory: any = { revision: 0, profiles: [], calibrations: [] };
  const summary = () => ({ protocolVersion: 1, sessionId: sid, controlMode: 'loop', controlRevision: 0,
    stage: value.stage, round: value.round, auto: value.auto,
    eligibility: { takeover: { allowed: true, reasonCode: 'ready', message: '可以接管', nextStep: 'request' },
      release: { allowed: false, reasonCode: 'loop', message: '已在 LOOP', nextStep: 'check' } } });
  const push = () => socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify({ ...value,
    loops: value.loops.map((rec: any) => rec.aimeinSummary ? { ...rec, aimeinRun: {}, detailLoaded: false } : rec) }) }));
  await page.routeWebSocket(/127\.0\.0\.1:45421/, ws => {
    if (offline) { ws.close({ code: 1001 }); return; }
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage(message => ws.send(message));
    ws.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (['codexModelCatalog', 'codexSessionModelCatalog'].includes(frame.method)) {
        ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', modelOptions: ['Model Alpha', 'Model Beta', 'Model Gamma'].map(id => ({ id })), reasoningCapabilities: [] }) }));
        return;
      }
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
      if (frame.method === 'loopAimeinGet') {
        const models = new Set();
        return reply({ status: 'ok', memory, recommendations: memory.profiles.map((p: any) => {
          const recommended = models.size < 3 && !models.has(p.document.model); models.add(p.document.model);
          return { profileId: p.id, name: p.document.name, model: p.document.model, available: true, recommended, samples: 0, reasons: ['任务匹配：保存、恢复', '样本不足，不能据此认定专业能力'] };
        }) });
      }
      if (['loopAddAddon', 'loopAimeinUpdate'].includes(frame.method) && rejectWrites) return reply({ status: 'error', message: '隔离夹具拒绝保存' });
      if (frame.method === 'loopAddAddon' && unknownWrites) return reply({ status: 'unknown', message: '隔离夹具：保存结果未知' });
      if (frame.method === 'loopAimeinUpdate') {
        const command = JSON.parse(frame.params[1]);
        if (command.expectedRevision !== memory.revision) return reply({ status: 'error', message: '档案修订冲突' });
        if (command.action === 'select') value.policy.aimeinReviewers = command.profileIds.map((id: string) => ({ ...memory.profiles.find((p: any) => p.id === id).document, profileId: id }));
        else if (command.action === 'save' || command.action === 'import') {
          const old = memory.profiles.find((p: any) => p.id === command.profileId);
          const document = { ...command.document, revision: `rev-${memory.revision + 1}` };
          if (old) { old.history.push(old.document); old.document = document; }
          else memory.profiles.push({ id: `profile-${memory.profiles.length}`, document, history: [] });
        } else if (command.action === 'calibrate') memory.calibrations.push({ ...command, revision: 'r1', model: 'Model Alpha', profileId: 'p0' });
        memory.revision++;
        value.aimeinMemory = { revision: memory.revision, profiles: memory.profiles.length, calibrations: memory.calibrations.length };
        reply({ status: 'ok' }); push(); return;
      }
      if (frame.method === 'loopSetPolicy' && rejectGoal) return reply({ status: 'error', message: '隔离夹具拒绝保存' });
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
      if (['loopSetGoal', 'loopSealIdea'].includes(frame.method) && rejectGoal) return reply({ status: 'error', message: '隔离夹具拒绝保存' });
      if (frame.method === 'loopGetRecord') {
        const saved = value.loops.find((item: any) => item.seq === frame.params[1]);
        const result = { status: 'ok', record: { ...saved, detailLoaded: true,
          result: saved?.result || '隔离持久化成果', stageDetails: saved?.stageDetails || {}, callDiagnostics: saved?.callDiagnostics || [] } };
        if (hold) pending.push(() => reply(result)); else reply(result);
        return;
      }
      if (frame.method === 'loopSetAuto') value.auto = frame.params[1];
      else if (frame.method === 'loopRunIteration') { value.running = true; if (runRecord) value.loops = [runRecord]; }
      else if (frame.method === 'loopAdvanceToOut') { value.stage = 'loopout'; value.running = false; value.stopReason = '用户停止，保留成果'; }
      else if (frame.method === 'loopContinue') { value.stage = 'loopexecute'; value.round++; value.goal = frame.params[1]; }
      else if (frame.method === 'loopSetGoal') value.goal = frame.params[1];
      else if (frame.method === 'loopAddAddon') value.addons.push({ id: 'new-addon', text: frame.params[1], images: JSON.parse(frame.params[2] || '[]'), status: 'pending', feedback: frame.params[3] ? { ...JSON.parse(frame.params[3]), status: 'pending' } : undefined });
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
  if (!runtime && await pane.getByRole('button', { name: '建设场景', exact: true }).isVisible()) await pane.getByRole('button', { name: '建设场景', exact: true }).click();
  return { pane, calls, push, count: (method: string) => calls.filter(call => call.method === method).length,
    replace: (name: string, extra: any = {}) => { value = { ...states()[name], sessionId: sid, ...extra }; push(); },
    update: (fn: (state: any) => void) => { fn(value); push(); }, hold: (on: boolean) => { hold = on; },
    release: () => { pending.splice(0).forEach(reply => reply()); },
    holdRun: (on: boolean) => { holdRun = on; },
    startRecord: (value: any) => { runRecord = value; },
    holdAuto: (on: boolean) => { holdAuto = on; }, rejectGoal: (on: boolean) => { rejectGoal = on; },
    rejectWrites: (on: boolean) => { rejectWrites = on; },
    unknownWrites: (on: boolean) => { unknownWrites = on; },
    memory: (raw: any) => { memory = raw; value.aimeinMemory = { revision: raw.revision, profiles: raw.profiles.length, calibrations: raw.calibrations.length }; push(); },
    progress: () => socket.send(JSON.stringify({ event: 'loopProgress', data: JSON.stringify({ sessionId: sid, seq: 1, subStage: 'step1', text: '实时内容' }) })),
    emit: (seq: number, subStage: string, text: string) => socket.send(JSON.stringify({ event: 'loopProgress', data: JSON.stringify({ sessionId: sid, seq, subStage, text }) })),
    disconnect: () => { offline = true; socket.close({ code: 1001 }); },
  };
}

// 与 aimein_bridge 首次 publish / run_summary 一致：规划开始时 plan 是 {}。
function planningAttempt() {
  const reviews = ['Model Alpha', 'Model Beta', 'Model Gamma'].map((model, i) => ({ id: `review${i + 1}`, model, backendId: 'qa-primary', status: 'pending' }));
  return { ...record(), subStage: 'prepare', orchestration: [],
    aimeinRun: { plan: {}, reviews },
    aimeinSummary: { revision: 'planning-empty', sprintId: '1:1', sprintNumber: 1, attempt: 1, status: 'planning',
      accepted: false, complete: false, title: '', outcome: '', maturityTarget: null, maturityMeaning: '',
      flowBuild: '', infra: '', criteria: [], reviews, issues: [], targetCount: 0, artifact: {} } };
}

for (const mode of ['3D', 'static']) test(`advance tolerates empty planning lifecycle in ${mode}`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const f = await fixture(page);
  if (info.project.name === 'narrow-mobile-chromium' && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const main = f.pane.getByTestId('aimein-workbench');
  const observer = main.getByRole('region', { name: '场景观察' });
  if (mode === 'static') await main.getByRole('button', { name: '静态视图', exact: true }).click();
  f.startRecord(planningAttempt()); f.hold(true);
  await f.pane.getByRole('button', { name: '工坊：点火开工', exact: true }).click();
  await expect.poll(() => f.count('loopGetRecord')).toBe(1);
  await expect(main).toBeVisible();
  await main.getByRole('button', { name: '建设场景', exact: true }).click();
  await expect(observer).toContainText('正在读取阶段详情');
  f.hold(false); f.release();
  await expect(main).toBeVisible();
  await expect(observer).toContainText('正在拆解目标并生成阶段计划');
  if (mode === '3D') {
    const canvas = main.getByTestId('aimein-3d-viewport').locator('canvas');
    await expect(canvas).toHaveAttribute('data-flow-stage', 'planning');
    await expect(canvas).toHaveAttribute('data-flow-particles', '0');
    await expect(main.getByTestId('aimein-vessel-value')).toContainText('待核实');
  }
  await main.getByRole('button', { name: '阶段记录', exact: true }).click();
  await main.getByText('目标图与执行记录', { exact: true }).click();
  await expect(main).toContainText('正在拆解目标并生成阶段计划');
  await main.getByRole('button', { name: '评委工坊', exact: true }).click();
  await main.getByRole('button', { name: '建设场景', exact: true }).click();
  f.update(s => { s.loops = [flowAttempt('preparing')]; });
  await expect(observer.getByText('目标定义', { exact: true })).toBeVisible();
  await expect(observer).not.toContainText('正在拆解目标并生成阶段计划');
  // 旧/部分详情缺少 Sprint 或 deferred 时，记录视图仍应能显示已有目标。
  for (const sprint of [undefined, {}]) {
    f.update(s => { s.loops[0].aimeinRun.plan.sprint = sprint; s.loops[0].aimeinSummary.revision += '-partial'; });
    await main.getByRole('button', { name: '阶段记录', exact: true }).click();
    await main.getByText('目标图与执行记录', { exact: true }).click();
    await expect(main.getByTestId('aimein-records')).toContainText('目标定义');
    await main.getByRole('button', { name: '建设场景', exact: true }).click();
  }
  const failed: any = planningAttempt();
  failed.error = '规划器未返回有效计划'; failed.aimeinSummary.revision = 'planning-failed';
  f.update(s => { s.loops = [failed]; s.running = false; s.resumable = true; });
  await expect(observer).toContainText('尚未生成阶段计划');
  await expect(observer).not.toContainText('正在拆解目标并生成阶段计划');
  await main.getByRole('button', { name: '阶段记录', exact: true }).click();
  await expect(main.getByRole('region', { name: '阶段结论' })).toContainText(failed.error);
  await expect(f.pane.getByRole('button', { name: '工坊：继续建设', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath(`planning-${mode}-recovered.png`) });
  expect(f.count('loopRunIteration')).toBe(1);
  expect(errors).toEqual([]);
  await expect(page.getByText('应用渲染异常', { exact: true })).toHaveCount(0);
});

function attempt(seq: number, passed = false) {
  const reviews = ['Model Alpha', 'Model Beta', 'Model Gamma'].map((model, i) => ({ id: `review${i + 1}`, model, backendId: 'qa-primary',
    status: passed || i < 2 ? 'passed' : 'changes_requested', maturity: passed || i < 2 ? 40 : 25,
    summary: passed || i < 2 ? '保存与重开流程已有验证依据。' : '离线重开时缺少失败反馈。',
    criteria: [{ id: 'C1', status: 'verified', reason: '已核对行为验证记录', evidence: ['tests/flow.test.ts'] }, { id: 'C2', status: passed || i < 2 ? 'verified' : 'gap', reason: '核对失败反馈', evidence: ['tests/flow.test.ts'] }],
    targets: [{ id: 'T1', status: 'verified', reason: '已核对保存流程', evidence: ['tests/flow.test.ts'], fingerprints: { 'tests/flow.test.ts': 'fixture-fingerprint' } }, { id: 'T2', status: 'gap', reason: '协作留待后续', evidence: [] }] }));
  return { ...record(), seq, subStage: 'done', completed: true, detailLoaded: false,
    orchestration: [{ index: 1, status: 'done', mode: 'sequential', desc: '实现保存与重开流程', output: '隔离测试已通过' }],
    aimeinSummary: { revision: `r${seq}`, sprintId: '1:1', sprintNumber: 1, attempt: seq, status: passed ? 'accepted' : 'repair',
      title: '让第一条产品流程跑通', outcome: '用户能够创建、保存并重新打开自己的项目。', maturityTarget: 40,
      maturityMeaning: '主流程可使用，保存行为有测试；复杂异常与协作留给后续阶段。',
      flowBuild: '创建项目 → 编辑内容 → 保存 → 重新打开', infra: '复用本地持久化，补齐写入失败反馈与隔离测试。',
      accepted: passed, complete: false, targetCount: 2, criteria: [{ id: 'C1', lane: 'flow', acceptance: '保存后重新打开，内容一致。' }, { id: 'C2', lane: 'infra', acceptance: '写入失败提供可恢复反馈。' }],
      reviews, issues: passed ? [] : [{ id: 'C2', model: 'Model Gamma', reason: '离线重开时缺少失败反馈。' }],
      message: passed ? '三位评审均通过当前阶段' : '当前阶段需要修补，验收标准保持不变', artifact: { digest: 'abc123', files: 12 } },
    aimeinRun: { reviews, plan: { targets: [{ id: 'T1', title: '可持续使用的项目工作流', acceptance: '创建和保存稳定可用', dependsOn: [] }, { id: 'T2', title: '多人协作', acceptance: '协作不丢失修改', dependsOn: ['T1'] }], sprint: { deferred: ['多人协作'], criteria: [{ id: 'C1', targetId: 'T1', lane: 'flow' }] } } } };
}

function worldAttempt(seq: number, verified = 3) {
  const result: any = attempt(seq);
  const targets = ['目标定义', '创建项目', '内容编辑', '持久化', '离线恢复', '失败反馈', '协作同步', '交付审计'].map((title, i) => ({ id: `T${i + 1}`, title, acceptance: `${title}有可核实依据`, dependsOn: i ? [`T${i}`] : [] }));
  result.aimeinRun.plan.targets = targets;
  result.aimeinRun.plan.sprint.criteria = targets.slice(0, 6).map((t, i) => ({ id: `C${i + 1}`, targetId: t.id, lane: 'flow' }));
  result.aimeinSummary.targetCount = targets.length;
  result.aimeinSummary.title = '让创作、保存与恢复形成完整流程';
  result.aimeinRun.reviews.forEach((r: any) => { r.targets = targets.map((t, i) => ({ id: t.id, status: i < verified ? 'verified' : 'gap', reason: '隔离演示依据', evidence: ['tests/flow.test.ts'], fingerprints: i < verified ? { 'tests/flow.test.ts': 'fixture-fingerprint' } : {} })); });
  return result;
}

test('task landscape keeps plots clear, paginates all targets and follows cross-page dependencies', async ({ page }, info) => {
  test.setTimeout(65000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  const world = main.getByTestId('aimein-world');
  const canvas = world.locator('canvas'); const map = world.getByTestId('aimein-task-map');
  await expect(canvas).toHaveAttribute('data-task-ids', 'T1,T2,T3,T4,T5,T6,T7,T8');
  await page.mouse.move(5, 5); await page.waitForTimeout(1500);
  await main.screenshot({ path: info.outputPath('landscape-eight.png') });
  await worldControls(world); await sceneButton(world, '拆分目标'); await page.waitForTimeout(1200);
  await main.screenshot({ path: info.outputPath('landscape-split.png') });
  await world.getByRole('button', { name: '工具 2：装配' }).click();
  await expect(canvas).toHaveAttribute('data-assembled', 'T1,T2,T3,T4,T5,T6');
  await page.waitForTimeout(1200);
  await main.screenshot({ path: info.outputPath('landscape-assembly.png') });
  await main.getByRole('button', { name: '我想调整后续范围' }).click();
  await map.getByLabel('定位子目标').selectOption('T8');
  await expect(canvas).toHaveAttribute('data-assembled', 'T1,T2,T3,T4,T5,T6');
  await world.getByRole('button', { name: '工具 1：观察' }).click();
  f.update(s => {
    const value = worldAttempt(1, 0);
    value.aimeinRun.plan.targets = Array.from({ length: 40 }, (_, i) => ({ id: `T${i + 1}`, title: `目标 ${i + 1} · 跨端协作与离线恢复的完整产品流程和可审计验收依据`, acceptance: '以真实结果核实', dependsOn: i === 0 ? ['T13', 'missing'] : [`T${i}`] }));
    value.aimeinSummary.targetCount = 40; s.loops = [value];
  });
  await expect(map).toContainText('1–12 / 40');
  await expect(canvas).toHaveAttribute('data-task-edges', '0');
  const reached = new Set<string>();
  for (let p = 0; p < 4; p++) {
    await expect(map).toHaveAttribute('data-page', String(p));
    await expect(canvas).toHaveAttribute('data-task-ids', Array.from({ length: Math.min(12, 40 - p * 12) }, (_, i) => `T${p * 12 + i + 1}`).join(','));
    const positions = JSON.parse((await canvas.getAttribute('data-task-positions'))!);
    positions.forEach((t: any) => reached.add(t.id));
    expect(new Set(positions.map((t: any) => t.at[1])).size).toBe(1);
    if (p === 0) { await page.waitForTimeout(1200); await main.screenshot({ path: info.outputPath('landscape-forty.png') }); }
    if (p < 3) await map.getByRole('button', { name: '下一片任务' }).click();
  }
  expect(reached.size).toBe(40);
  f.push(); await expect(map).toHaveAttribute('data-page', '3');
  await map.getByLabel('定位子目标').selectOption('T1');
  await expect(map).toHaveAttribute('data-page', '0');
  await expect(canvas).toHaveAttribute('data-task-edges', '1');
  await map.locator('summary').click();
  await expect(map).toContainText('前置 missing · 缺少详情');
  await map.getByRole('button', { name: '前置 T13 · 第 2 片 ↗' }).click();
  await expect(map).toHaveAttribute('data-page', '1');
  await expect(canvas).toHaveAttribute('data-held-target', 'T13');
  await page.waitForTimeout(1200); await main.screenshot({ path: info.outputPath('landscape-dependency.png') });
  await world.getByRole('button', { name: '静态视图', exact: true }).click();
  await expect(world.getByTestId('aimein-world-static')).toBeVisible();
  await map.getByRole('button', { name: '下一片任务' }).click();
  await map.getByRole('button', { name: /^地块 T25：/ }).click();
  await expect(map.getByLabel('定位子目标')).toHaveValue('T25');
  await world.getByRole('button', { name: '切换 3D 沙盘' }).click();
  await expect(canvas).toHaveAttribute('data-task-ids', 'T25,T26,T27,T28,T29,T30,T31,T32,T33,T34,T35,T36');
  expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true);
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopAddAddon')).toBe(0); expect(f.count('loopSetPolicy')).toBe(0);
  expect(errors).toEqual([]);
});

async function clickReviewerMesh(page: Page, index: number) {
  await clickWorldPoint(page, [-1.5 + index * 2.15, 1.22, 3.5]);
}

async function clickWorldPoint(page: Page, point: [number, number, number]) {
  const canvas = page.getByTestId('aimein-3d-viewport').locator('canvas');
  const box = (await canvas.boundingBox())!;
  const camera = new OrthographicCamera(-box.width / 2, box.width / 2, box.height / 2, -box.height / 2, .1, 80);
  const actual = await canvas.evaluate(el => ({ pose: el.dataset.cameraPose?.split(',').map(Number), zoom: Number(el.dataset.cameraZoom) }));
  if (actual.pose?.length === 6) { camera.position.set(actual.pose[0], actual.pose[1], actual.pose[2]); camera.lookAt(actual.pose[3], actual.pose[4], actual.pose[5]); }
  else { camera.position.set(12, 11, 15); camera.lookAt(0, .5, 0); }
  camera.zoom = actual.zoom || Math.min(box.width / 19, box.height / 12); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const p = new Vector3(...point).project(camera);
  await canvas.click({ position: { x: (p.x + 1) * box.width / 2, y: (1 - p.y) * box.height / 2 } });
}

async function sceneButton(main: Locator, name: string | RegExp) {
  const button = main.getByRole('button', { name, exact: typeof name === 'string' });
  if (!await button.isVisible() && await main.getByRole('button', { name: '场景菜单', exact: true }).isVisible()) await main.getByRole('button', { name: '场景菜单', exact: true }).click();
  await button.click();
}

async function worldControls(main: Locator) {
  const menu = main.getByRole('button', { name: '场景菜单', exact: true });
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  const summary = main.getByText('拆分、聚合与路径', { exact: true });
  if (!await summary.evaluate(el => (el.parentElement as HTMLDetailsElement).open)) await summary.click();
}

function flowAttempt(status: string, done = 0, verified = 0) {
  const value = worldAttempt(1, verified);
  value.completed = ['repair', 'accepted'].includes(status);
  value.subStage = value.completed ? 'done' : status === 'reviewing' ? 'analysis' : status === 'executing' ? 'execute' : 'prepare';
  value.aimeinSummary.status = status;
  value.aimeinSummary.revision = `${status}-${done}-${verified}`;
  value.aimeinRun.plan.sprint.criteria[3].lane = 'infra';
  value.orchestration = Array.from({ length: 6 }, (_, i) => ({ index: i, mode: 'sequential', desc: ['定义创作流程', '搭建编辑交互', '保存作品', '离线恢复', '完善失败反馈', '收集验收依据'][i],
    status: i < done ? 'done' : i === done && status === 'executing' ? 'running' : 'pending', output: i < done ? `已保存步骤 ${i + 1} 的实施与验证记录` : '' }));
  if (!value.completed) value.aimeinSummary.reviews.forEach((r: any) => { r.status = status === 'reviewing' ? 'running' : 'pending'; });
  return value;
}

test('electric handoffs and ant traffic follow saved work with actual recording', async ({ page }, info) => {
  test.setTimeout(65000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const narrow = info.project.name === 'narrow-mobile-chromium';
  if (!narrow) await page.setViewportSize({ width: 1600, height: 1000 });
  const f = await fixture(page);
  if (narrow && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [flowAttempt('preparing')]; s.running = true; });
  const main = f.pane.getByTestId('aimein-workbench'); const world = main.getByTestId('aimein-world');
  const viewport = world.getByTestId('aimein-3d-viewport'); const canvas = viewport.locator('canvas');
  await viewport.scrollIntoViewIfNeeded();
  await expect(viewport).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-flow-stage', 'preparing');
  await page.waitForTimeout(1400);
  f.update(s => { s.loops = [flowAttempt('executing')]; });
  await expect(canvas).toHaveAttribute('data-flow-last-event', 'build,infra');
  await expect.poll(async () => Number(await canvas.getAttribute('data-flow-particles'))).toBeGreaterThan(50);
  await viewport.screenshot({ path: info.outputPath('flow-electric.png') });
  await page.waitForTimeout(2700);
  await expect(canvas).toHaveAttribute('data-flow-saved', '0');
  const serial = await canvas.getAttribute('data-flow-pulse-serial');
  f.push(); await page.waitForTimeout(300);
  expect(await canvas.getAttribute('data-flow-pulse-serial')).toBe(serial);
  for (let done = 1; done <= 6; done++) {
    f.update(s => { s.loops = [flowAttempt('executing', done)]; });
    await expect(canvas).toHaveAttribute('data-flow-saved', String(done));
    await page.waitForTimeout(650);
  }
  await viewport.screenshot({ path: info.outputPath('flow-accumulation.png') });
  f.update(s => { s.loops = [flowAttempt('reviewing', 6)]; });
  await expect(canvas).toHaveAttribute('data-flow-last-event', 'review0,review1,review2');
  await page.waitForTimeout(450);
  await viewport.screenshot({ path: info.outputPath('flow-review.png') });
  await page.waitForTimeout(1900);
  f.update(s => { s.loops = [flowAttempt('repair', 6, 5)]; s.running = false; });
  await expect(canvas).toHaveAttribute('data-flow-last-event', 'repair,verify0,verify1,verify2');
  await expect(world.getByTestId('aimein-vessel-value')).toContainText('5 / 8');
  await page.waitForTimeout(600);
  await viewport.screenshot({ path: info.outputPath('flow-return.png') });
  await page.waitForTimeout(2500);
  const frames = Number(await canvas.getAttribute('data-rendered-frames'));
  await page.waitForTimeout(500);
  expect(Number(await canvas.getAttribute('data-rendered-frames')) - frames).toBeLessThan(3);
  expect(Number(await canvas.getAttribute('data-flow-particles'))).toBe(0);
  await info.attach('flow-render-metrics', { contentType: 'application/json', body: JSON.stringify({ viewport: page.viewportSize(),
    capacity: await canvas.getAttribute('data-flow-capacity'), drawCalls: await canvas.getAttribute('data-draw-calls'), idleFramesOver500ms: Number(await canvas.getAttribute('data-rendered-frames')) - frames }) });
  await worldControls(world);
  await world.getByRole('button', { name: '路径：产出 → 评委 2', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Beta');
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopSetPolicy')).toBe(0);
  expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true); expect(errors).toEqual([]);
});

test('live flow cancels hidden events, respects reduced motion and never animates history', async ({ page }) => {
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [flowAttempt('executing', 1)]; s.running = true; });
  const main = f.pane.getByTestId('aimein-workbench'); const world = main.getByTestId('aimein-world');
  const viewport = world.getByTestId('aimein-3d-viewport'); const canvas = viewport.locator('canvas');
  await viewport.scrollIntoViewIfNeeded(); await expect(viewport).toHaveAttribute('data-ready', 'true');
  await expect.poll(async () => Number(await canvas.getAttribute('data-flow-particles'))).toBeGreaterThan(50);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(world).toHaveAttribute('data-active', 'false');
  await page.waitForTimeout(150);
  const frames = await canvas.getAttribute('data-rendered-frames');
  f.update(s => { s.loops = [flowAttempt('reviewing', 3)]; });
  await page.waitForTimeout(350);
  expect(await canvas.getAttribute('data-rendered-frames')).toBe(frames);
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(world).toHaveAttribute('data-active', 'true');
  await expect(canvas).toHaveAttribute('data-flow-stage', 'reviewing');
  await expect(canvas).toHaveAttribute('data-flow-pulses', '0');
  expect(await canvas.getAttribute('data-flow-pulse-serial')).toBeNull();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(canvas).toHaveAttribute('data-flow-particles', '0');
  await page.waitForTimeout(500); const reducedFrames = await canvas.getAttribute('data-rendered-frames');
  await page.waitForTimeout(350); expect(await canvas.getAttribute('data-rendered-frames')).toBe(reducedFrames);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(1100);
  // 探针优先航线，拿取/装配优先方块；点击真实曲线可达准确评委。
  await world.getByRole('button', { name: '工具 3：成果', exact: true }).click();
  await clickWorldPoint(page, [-.1, 2.4, 2.2]);
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Beta');
  f.update(s => { const next = flowAttempt('executing'); next.seq = 2; s.loops.push(next); });
  await main.getByLabel('查看 AIMEIN 阶段').selectOption('1');
  await viewport.scrollIntoViewIfNeeded();
  await expect(world.getByTestId('aimein-flow-status')).toContainText('历史观察');
  await expect(canvas).toHaveAttribute('data-flow-particles', '0');
  await expect(canvas).toHaveAttribute('data-flow-pulses', '0');
  // 超过展示上限的真实保存输出不创建永久动画队列。
  await main.getByLabel('查看 AIMEIN 阶段').selectOption('2');
  await viewport.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute('data-flow-stage', 'executing');
  f.update(s => { const last = s.loops.at(-1); last.completed = true; last.aimeinSummary.status = 'accepted'; last.aimeinSummary.revision = 'many-saved'; s.running = false;
    last.orchestration = Array.from({ length: 30 }, (_, i) => ({ index: i, mode: 'sequential', desc: `saved ${i}`, status: 'done', output: 'persisted result' })); });
  await expect(canvas).toHaveAttribute('data-flow-saved', '30');
  await expect(canvas).toHaveAttribute('data-flow-pile', '24');
  await page.waitForTimeout(3100);
  const cappedFrames = await canvas.getAttribute('data-rendered-frames');
  await page.waitForTimeout(350); expect(await canvas.getAttribute('data-rendered-frames')).toBe(cappedFrames);
  expect(f.count('loopRunIteration')).toBe(0);
});

test('3D sandbox animates real targets, settles, preserves history and opens independent reviewers', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  const world = main.getByTestId('aimein-world');
  await world.scrollIntoViewIfNeeded();
  const viewport = world.getByTestId('aimein-3d-viewport');
  await expect(viewport).toHaveAttribute('data-ready', 'true');
  const canvas = viewport.locator('canvas');
  await expect(world.getByTestId('aimein-vessel-value')).toContainText('3 / 8');
  await expect.poll(async () => Number(await canvas.getAttribute('data-vessel-fill'))).toBeCloseTo(.375, 2);
  await worldControls(world);
  await sceneButton(world, '拆分目标');
  await expect(world).toHaveAttribute('data-layout', 'split');
  await page.waitForTimeout(1400);
  await sceneButton(world, '聚合本阶段');
  const moving = await canvas.screenshot();
  await page.waitForTimeout(1300);
  const settled = await canvas.screenshot();
  expect(moving.equals(settled)).toBe(false);
  const frames = Number(await canvas.getAttribute('data-rendered-frames'));
  await page.waitForTimeout(500);
  const idleFrames = Number(await canvas.getAttribute('data-rendered-frames')) - frames;
  expect(idleFrames).toBeLessThan(3);
  await info.attach('3d-render-metrics', { contentType: 'application/json', body: JSON.stringify({ viewport: page.viewportSize(), idleFramesOver500ms: idleFrames,
    drawCalls: await canvas.getAttribute('data-draw-calls'), renderer: await canvas.evaluate((el: HTMLCanvasElement) => { const gl = el.getContext('webgl2')!; const info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown'; }) }) });
  f.push(); await page.waitForTimeout(500);
  await expect(world).toHaveAttribute('data-layout', 'cluster');
  await sceneButton(world, '▷ 回放拆分聚合');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(world).toHaveAttribute('data-active', 'false');
  const hiddenFrames = Number(await canvas.getAttribute('data-rendered-frames'));
  await page.waitForTimeout(300);
  expect(Number(await canvas.getAttribute('data-rendered-frames')) - hiddenFrames).toBeLessThan(2);
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(world).toHaveAttribute('data-active', 'true');
  await expect(world.getByText('视觉回放 · 拆分子目标', { exact: true })).toHaveCount(0);
  await sceneButton(world, '聚合本阶段');
  await page.waitForTimeout(1400);
  await viewport.scrollIntoViewIfNeeded();
  await viewport.screenshot({ path: info.outputPath('aimein-3d-world.png') });
  if (info.project.name === 'desktop-chromium') {
    await clickReviewerMesh(page, 2);
    await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Gamma');
  }
  await worldControls(world);
  await world.getByRole('button', { name: '观察评委 2', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Beta');
  await expect(main.getByRole('button', { name: '查看档案与校准' })).toBeVisible();
  f.update(s => { s.loops.push(worldAttempt(2, 6)); });
  await expect(world.getByTestId('aimein-vessel-value')).toContainText('6 / 8');
  await main.getByLabel('查看 AIMEIN 阶段').selectOption('1');
  f.push();
  await expect(world.getByTestId('aimein-vessel-value')).toContainText('3 / 8');
  await expect(main.getByLabel('查看 AIMEIN 阶段')).toHaveValue('1');
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopSetPolicy')).toBe(0);
  expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true);
  expect(errors).toEqual([]);
});

test('3D unavailable at creation degrades without blocking evidence or feedback', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind: any, ...args: any[]) { return kind === 'webgl2' ? null : original.apply(this, [kind, ...args] as any); } as any;
  });
  const f = await fixture(page); f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  await expect(main.getByTestId('aimein-world-static')).toBeVisible();
  await sceneButton(main, '观察评委 2');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Beta');
  await main.getByLabel('对象建议').fill('即使没有 3D，也能提出意见');
  await main.getByRole('button', { name: '交给下一次迭代' }).click();
  await expect(main.getByRole('region', { name: '意见流' })).toContainText('待规划');
  expect(f.count('loopRunIteration')).toBe(0);
});

test('3D reduced motion, static choice and context loss retain useful controls and drafts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench'); const world = main.getByTestId('aimein-world');
  await world.scrollIntoViewIfNeeded();
  await expect(world.getByTestId('aimein-3d-viewport')).toHaveAttribute('data-ready', 'true');
  await worldControls(world);
  await expect(world.getByRole('button', { name: '▷ 回放拆分聚合', exact: true })).toBeDisabled();
  await main.getByLabel('对象建议').fill('目标核实需要保留依据');
  await world.getByRole('button', { name: '静态视图', exact: true }).click();
  await expect(world.getByTestId('aimein-world-static')).toBeVisible();
  await expect(main.getByLabel('对象建议')).toHaveValue('目标核实需要保留依据');
  await world.getByRole('button', { name: '切换 3D 沙盘', exact: true }).click();
  await world.scrollIntoViewIfNeeded();
  await expect(world.locator('canvas')).toBeVisible();
  await world.locator('canvas').evaluate((canvas: HTMLCanvasElement) => { const gl = canvas.getContext('webgl2'); gl!.getExtension('WEBGL_lose_context')!.loseContext(); });
  await expect(world.getByTestId('aimein-world-static')).toBeVisible();
  await expect(world).toContainText('静态场景');
  await sceneButton(world, '观察评委 3');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Gamma');
  expect(f.count('loopRunIteration')).toBe(0);
});

test.describe('AIMEIN recorded motion', () => {
  test('actual 3D build, vessel and reviewer interaction', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-chromium', '录屏使用桌面视口，窄屏由交互验收覆盖');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const f = await fixture(page);
    f.update(s => { s.loops = [worldAttempt(1, 1)]; s.goal = '建设让用户安心创作、保存与协作的产品工作台'; });
    const main = f.pane.getByTestId('aimein-workbench'); const world = main.getByTestId('aimein-world');
    await world.scrollIntoViewIfNeeded();
    await expect(world.getByTestId('aimein-3d-viewport')).toHaveAttribute('data-ready', 'true');
    await page.waitForTimeout(1600);
    await worldControls(world);
    await sceneButton(world, '▷ 回放拆分聚合');
    await page.waitForTimeout(3700);
    f.update(s => { s.loops = [worldAttempt(1, 5)]; });
    await expect(world.getByTestId('aimein-vessel-value')).toContainText('5 / 8');
    await page.waitForTimeout(1900);
    await world.getByTestId('aimein-3d-viewport').scrollIntoViewIfNeeded();
    await world.getByTestId('aimein-3d-viewport').screenshot({ path: info.outputPath('aimein-3d-desktop.png') });
    await clickReviewerMesh(page, 1);
    await page.waitForTimeout(1900);
    await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Beta');
    await main.getByRole('button', { name: '查看档案与校准' }).click();
    await page.waitForTimeout(900);
    expect(f.count('loopRunIteration')).toBe(0);
  });
});

test('AIMEIN responsive workbench preserves attempts and lazy evidence', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(f.pane.getByTestId('aimein-controls')).toBeVisible();
  await expect(f.pane.getByRole('button', { name: '配置评审组' })).toBeVisible();
  f.update(state => { state.loops = [attempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  await expect(main.getByRole('region', { name: '阶段成熟度' })).toContainText('本阶段目标成熟度');
  await expect(main.getByRole('region', { name: '评审验收' })).toContainText('2 / 3 通过');
  await expect.poll(() => f.count('loopGetRecord')).toBe(1);
  await main.getByRole('button', { name: '阶段记录', exact: true }).click();
  await main.getByText('目标图与执行记录', { exact: true }).click();
  await expect(main).toContainText('可持续使用的项目工作流');
  await main.getByText('目标图与执行记录', { exact: true }).click();
  await f.pane.getByRole('main').evaluate(el => el.scrollTop = 0);
  const viewport = page.viewportSize()!;
  if (viewport.width >= 600) await page.setViewportSize({ width: viewport.width, height: 1200 });
  await page.screenshot({ path: info.outputPath('aimein-stage.png') });
  if (viewport.width >= 600) await page.setViewportSize(viewport);
  await main.getByRole('region', { name: '评审验收' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('aimein-reviews.png') });
  expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true);
  f.update(state => { state.loops.push(attempt(2, true)); });
  await expect(main.getByRole('region', { name: '评审验收' })).toContainText('3 / 3 通过');
  await main.getByLabel('查看 AIMEIN 阶段').selectOption('1');
  await expect(main.getByRole('region', { name: '评审验收' })).toContainText('2 / 3 通过');
  f.push(); await expect(main.getByLabel('查看 AIMEIN 阶段')).toHaveValue('1');
  await main.getByRole('button', { name: '返回最新阶段' }).click();
  await expect(main.getByLabel('查看 AIMEIN 阶段')).toHaveValue('2');
  expect(f.count('loopRunIteration')).toBe(0);
  await f.pane.getByRole('button', { name: '工坊：点火开工', exact: true }).click();
  expect(f.count('loopRunIteration')).toBe(1);
  page.once('dialog', d => d.accept());
  await f.pane.getByRole('button', { name: '停止本轮并查看结果', exact: true }).click();
  await expect(main).toContainText('用户停止，保留成果');
  expect(errors).toEqual([]);
});

test('review retry preserves the attempt and exposes failure history', async ({ page }) => {
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(state => {
    const rec = attempt(1, true);
    rec.completed = false; rec.subStage = 'analysis';
    Object.assign(rec.aimeinSummary, { status: 'needs_attention', accepted: false,
      message: '第二位评审未完成，继续时保留已完成的实施与有效评审。' });
    Object.assign(rec.aimeinSummary.reviews[1], { status: 'error', error: '模型响应不完整', attemptCount: 1,
      attempts: [{ number: 1, status: 'error', error: '模型响应不完整', rawOutput: '隔离测试返回的不完整结果' }] });
    state.loops = [rec]; state.resumable = true;
    state.iterationRequest = { version: 1, sessionId: sid, round: state.round, seq: 1,
      controlRevision: state.controlRevision || 0, environmentRevision: state.executionEnvironment?.revision || 0,
      sourceRevision: state.taskSource?.revision || 0, action: 'resume', canRequest: true,
      recheckRequired: true, basisRefs: [], reasonCode: '', message: '' };
  });
  const main = f.pane.getByTestId('aimein-workbench');
  await expect(f.pane.getByRole('button', { name: '工坊：继续建设', exact: true })).toBeVisible();
  await main.getByRole('button', { name: '阶段记录', exact: true }).click();
  const reviewer = main.getByRole('article').nth(1);
  await reviewer.getByText('查看依据与原文', { exact: true }).click();
  await expect(reviewer).toContainText('第 1 次核对失败：模型响应不完整');
  expect(f.count('loopRunIteration')).toBe(0);
  await f.pane.getByRole('button', { name: '工坊：继续建设', exact: true }).click();
  expect(f.count('loopRunIteration')).toBe(1);
});

test('review settings are explicit, saved errors retain the draft and do not run', async ({ page }) => {
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await f.pane.getByRole('button', { name: '配置评审组', exact: true }).click();
  const dialog = f.pane.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: 'AIMEIN 独立评审' })).toBeVisible();
  for (let i = 1; i <= 3; i++) await dialog.getByLabel(`评审 ${i} Backend`).selectOption('qa-primary');
  await expect(dialog).toContainText('启用的评委需要不同模型');
  f.rejectGoal(true);
  await dialog.getByRole('button', { name: /保存/, exact: false }).last().click();
  await expect(dialog).toContainText('隔离夹具拒绝保存');
  await expect(dialog.getByLabel('评审 3 Backend')).toHaveValue('qa-primary');
  expect(f.count('loopRunIteration')).toBe(0);
});

test('reviewer count configures one two or three seats and preserves the historical roster', async ({ page }, info) => {
  test.setTimeout(65000);
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const main = f.pane.getByTestId('aimein-workbench');
  await f.pane.getByRole('button', { name: '配置评审组', exact: true }).click();
  const dialog = f.pane.getByRole('dialog');
  const counts = dialog.getByRole('group', { name: '评委人数' });
  await counts.getByRole('button', { name: '1 位', exact: true }).click();
  await dialog.getByLabel('评审 1 Backend').selectOption('qa-primary');
  await expect(dialog.getByLabel('评审 2 Backend')).toHaveCount(0);
  await expect(dialog).toContainText('1 位评委已配置');
  await counts.getByRole('button', { name: '2 位', exact: true }).click();
  await expect(dialog.getByLabel('评审 1 Backend')).toHaveValue('qa-primary');
  await expect(dialog.getByLabel('评审 2 Backend')).toBeVisible();
  await counts.getByRole('button', { name: '3 位', exact: true }).click();
  await expect(dialog.getByLabel('评审 3 Backend')).toBeVisible();
  await counts.getByRole('button', { name: '1 位', exact: true }).click();
  await page.screenshot({ path: info.outputPath('reviewer-count-settings.png') });
  await dialog.getByRole('button', { name: /保存/, exact: false }).last().click();
  await expect.poll(() => f.count('loopSetPolicy')).toBe(1);
  await dialog.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await expect(dialog).toBeHidden();
  expect(JSON.parse(f.calls.filter(c => c.method === 'loopSetPolicy').at(-1)!.params[1]).aimeinReviewers).toHaveLength(1);
  const canvas = main.getByTestId('aimein-world').locator('canvas');
  for (const count of [1, 2, 3]) {
    const r: any = worldAttempt(count);
    r.aimeinRun.reviewerCount = count; r.aimeinRun.reviews = r.aimeinRun.reviews.slice(0, count);
    r.aimeinSummary.reviewerCount = count; r.aimeinSummary.reviews = r.aimeinRun.reviews;
    if (count < 3) { r.aimeinSummary.accepted = true; r.aimeinSummary.status = 'accepted'; r.aimeinSummary.issues = []; r.aimeinSummary.message = `${count} 位评委均通过当前阶段`; }
    r.aimeinSummary.revision = `roster-${count}`;
    f.update(s => { s.loops = [r]; s.running = false; });
    await expect(canvas).toHaveAttribute('data-reviewer-count', String(count));
    await main.getByRole('button', { name: '工具 4：评委' }).click();
    await expect(main.getByTestId('aimein-review-overview')).toContainText(`汇总 ${count} 位评委报告`);
    await expect(main.getByTestId('aimein-review-overview')).toBeInViewport();
    if (count < 3) await expect(main.getByTestId('aimein-review-overview')).toContainText('本阶段通过');
    await page.screenshot({ path: info.outputPath(`reviewer-${count}-seats.png`) });
    await main.getByRole('button', { name: '静态视图', exact: true }).click();
    const world = main.getByTestId('aimein-world');
    await expect(world.getByRole('button', { name: `观察评委 ${count}`, exact: true })).toBeVisible();
    await expect(world.getByRole('button', { name: `观察评委 ${count + 1}`, exact: true })).toHaveCount(0);
    await world.getByRole('button', { name: '切换 3D 沙盘', exact: true }).click();
  }
  const old: any = attempt(4, true); old.aimeinRun.reviews = old.aimeinRun.reviews.slice(0, 1); old.aimeinSummary.reviews = old.aimeinRun.reviews;
  f.update(s => { s.loops = [old]; });
  await expect(canvas).toHaveAttribute('data-reviewer-count', '3');
  await expect(main.getByTestId('aimein-review-overview')).toContainText('1/3 已返回');
  await expect(main.getByTestId('aimein-vessel-value')).toContainText('待核实');
  expect(f.count('loopRunIteration')).toBe(0);
});

test('new AIMEIN session opens an immersive world before creation and persists without model calls', async ({ page }, info) => {
  const calls: string[] = [];
  await page.routeWebSocket(/127\.0\.0\.1:45421/, ws => {
    const server = ws.connectToServer();
    server.onMessage(m => ws.send(m));
    ws.onMessage(m => {
      const frame = JSON.parse(String(m)); calls.push(frame.method);
      if (/^(sendMessage|loopRunIteration|loopSealIdea|loopSubmitIdea)$/.test(frame.method)) throw new Error('Unexpected model execution');
      server.send(m);
    });
  });
  await page.goto('/');
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.getByTitle('New session', { exact: true }).click();
  await page.getByRole('button', { name: /◎ AIMEIN/ }).click();
  const entrance = page.getByRole('dialog', { name: '进入 AIMEIN 世界' });
  await expect(entrance.getByTestId('aimein-setup-world')).toBeVisible();
  await expect(entrance.getByTestId('aimein-3d-viewport')).toHaveAttribute('data-ready', 'true');
  expect(calls.filter(m => m === 'createSession')).toHaveLength(0);
  await expect(entrance.getByLabel('工坊工作目录')).toBeHidden();
  await entrance.getByRole('button', { name: '调整连接与位置', exact: true }).click();
  await expect(entrance.getByLabel('工坊工作目录')).toBeVisible();
  await entrance.getByRole('button', { name: '收起工坊设置', exact: true }).click();
  await entrance.evaluate(el => el.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('immersive-entry.png') });
  expect(await entrance.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await entrance.getByRole('button', { name: '安放工坊，下一步 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Session' })).toHaveCount(0);
  await expect(page.getByTestId('aimein-controls')).toBeVisible();
  await expect(page.getByTestId('aimein-preparation')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('aimein-controls')).toBeVisible();
  expect(calls.filter(m => m === 'createSession')).toHaveLength(1);
  expect(calls.filter(m => m === 'loopSetPolicy')).toHaveLength(0);
});

test('immersive preparation guides missing fields, retains drafts and starts only explicitly', async ({ page }, info) => {
  test.setTimeout(60_000);
  if (info.project.name === 'narrow-mobile-chromium') await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await fixture(page, 'idea');
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const preparation = f.pane.getByTestId('aimein-preparation');
  const guide = preparation.getByRole('complementary', { name: '场景准备指引' });
  const persistentWorld = f.pane.getByTestId('aimein-world');
  await expect(persistentWorld.getByTestId('aimein-3d-viewport')).toHaveAttribute('data-ready', 'true');
  await expect(guide.getByTestId('aimein-goal-target')).toBeVisible();
  const goal = guide.getByLabel('AIMEIN 建设目标');
  await goal.fill('让灵感能被保存、分类，并在需要时轻松找回。');
  await f.pane.getByRole('button', { name: '收起面板', exact: true }).click();
  await expect(guide).toBeHidden();
  await f.pane.getByTestId('aimein-workbench').getByRole('button', { name: '继续建设准备', exact: true }).click();
  await expect(goal).toHaveValue('让灵感能被保存、分类，并在需要时轻松找回。');
  await preparation.screenshot({ path: info.outputPath('immersive-goal.png') });
  expect(f.count('loopSealIdea')).toBe(0); expect(f.count('loopRunIteration')).toBe(0);
  f.rejectGoal(true);
  await guide.getByRole('button', { name: '保存目标，下一步 →' }).click();
  await expect(guide).toContainText('隔离夹具拒绝保存');
  await expect(goal).toHaveValue('让灵感能被保存、分类，并在需要时轻松找回。');
  f.rejectGoal(false);
  await guide.getByRole('button', { name: '保存目标，下一步 →' }).click();
  await expect(guide.getByTestId('aimein-reviewers-target')).toBeVisible();
  await expect(guide.getByRole('button', { name: /下一步，检查准备/ })).toBeDisabled();
  for (let i = 1; i <= 3; i++) await guide.getByLabel(`评审 ${i} Backend`).selectOption('qa-primary');
  await expect(guide).toContainText('启用的评委需要不同模型');
  for (const [i, model] of ['Model Alpha', 'Model Beta', 'Model Gamma'].entries()) await guide.getByLabel('Codex 模型', { exact: true }).nth(i).fill(model);
  f.rejectGoal(true);
  await guide.getByRole('button', { name: '保存评委，下一步 →' }).click();
  await expect(guide).toContainText('隔离夹具拒绝保存');
  await expect(guide.getByLabel('Codex 模型', { exact: true }).nth(2)).toHaveValue('Model Gamma');
  await preparation.screenshot({ path: info.outputPath('immersive-reviewers.png') });
  f.rejectGoal(false);
  await guide.getByRole('button', { name: '保存评委，下一步 →' }).click();
  await expect(guide.getByRole('button', { name: '开始建设 →' })).toBeEnabled();
  expect(f.count('loopRunIteration')).toBe(0);
  await persistentWorld.getByRole('button', { name: '静态视图', exact: true }).click();
  await expect(persistentWorld.getByTestId('aimein-world-static')).toBeVisible();
  await persistentWorld.evaluate(el => el.setAttribute('data-persistence-check', 'same-world'));
  await preparation.getByRole('navigation', { name: 'AIMEIN 建设准备步骤' }).getByRole('button', { name: /点亮目标/ }).click();
  await expect(goal).toHaveValue('让灵感能被保存、分类，并在需要时轻松找回。');
  await preparation.getByRole('navigation', { name: 'AIMEIN 建设准备步骤' }).getByRole('button', { name: /开始建设/ }).click();
  expect(await preparation.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  f.startRecord(planningAttempt()); f.holdRun(true);
  await guide.getByRole('button', { name: '开始建设 →' }).dblclick();
  await expect.poll(() => f.count('loopRunIteration')).toBe(1);
  f.holdRun(false); f.release(); f.update(s => { s.running = true; s.loops = [planningAttempt()]; });
  await expect(f.pane.getByTestId('aimein-workbench')).toBeVisible();
  await expect(preparation).toHaveCount(0);
  await expect(persistentWorld).toHaveAttribute('data-persistence-check', 'same-world');
  await expect(persistentWorld.getByTestId('aimein-world-static')).toBeVisible();
  expect(errors).toEqual([]);
});

test('immersive entrance recovers missing connections and exits with the keyboard', async ({ page }, info) => {
  let available = false;
  const calls: string[] = [];
  await page.routeWebSocket(/127\.0\.0\.1:45421/, ws => {
    const server = ws.connectToServer(); server.onMessage(message => ws.send(message));
    ws.onMessage(message => {
      const frame = JSON.parse(String(message)); calls.push(frame.method);
      if (frame.method === 'getBackends') {
        ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify(available ? [{ id: 'qa-primary', type: 'openai-compatible', enabled: true, label: '已连接的建设模型', model: 'Model Alpha', baseUrl: 'http://127.0.0.1:9/v1' }] : []) })); return;
      }
      if (/^(createSession|sendMessage|loopRunIteration|loopSealIdea|loopSubmitIdea|saveBackend)$/.test(frame.method)) throw new Error('Read-only entrance must not submit writes');
      server.send(message);
    });
  });
  await page.goto('/');
  if (!await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await page.getByTitle('New session', { exact: true }).click();
  await page.getByRole('button', { name: /◎ AIMEIN/ }).click();
  const entrance = page.getByRole('dialog', { name: '进入 AIMEIN 世界' });
  await expect(entrance.getByTestId('aimein-world')).toBeVisible();
  await expect(entrance).toContainText('当前节点还没有可用的建设模型连接');
  await expect(entrance.getByRole('button', { name: '安放工坊，下一步 →' })).toBeDisabled();
  await entrance.getByLabel('工坊工作目录').fill('C:/qa/unused-draft');
  available = true;
  await entrance.getByRole('button', { name: '配置模型连接', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Backend 配置', exact: true })).toBeVisible();
  await expect(entrance).toBeVisible();
  await expect(entrance.getByTestId('aimein-world')).toBeInViewport();
  expect(await entrance.locator('canvas').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height * .3)); })).toBe(true);
  await page.screenshot({ path: info.outputPath('persistent-connection.png') });
  await page.getByRole('button', { name: '关闭 Backend 配置', exact: true }).click();
  await expect(entrance).toBeVisible();
  await expect(entrance.getByRole('button', { name: '安放工坊，下一步 →' })).toBeEnabled();
  await entrance.getByRole('button', { name: '调整连接与位置', exact: true }).click();
  await expect(entrance.getByLabel('工坊工作目录')).toHaveValue('C:/qa/unused-draft');
  expect(await entrance.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(entrance).toHaveCount(0);
  expect(calls.filter(method => /^(createSession|loopRunIteration|saveBackend)$/.test(method))).toEqual([]);
});

test('world objects preserve evidence and route opinions to the next iteration', async ({ page }, info) => {
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(state => { state.loops = [attempt(1)]; state.goal = '建设一个让用户安心创作、保存与协作的产品工作台'; });
  const main = f.pane.getByTestId('aimein-workbench');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('1 / 2');
  await worldControls(main);
  await main.getByRole('button', { name: '观察功能工坊', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('创建项目 → 编辑内容 → 保存');
  f.rejectWrites(true);
  await main.getByLabel('对象建议').fill('保存失败时保留内容，并明确告诉我如何恢复。');
  await main.getByRole('button', { name: '交给下一次迭代' }).click();
  await expect(main.getByRole('region', { name: '对象意见' })).toContainText('隔离夹具拒绝保存');
  await expect(main.getByLabel('对象建议')).toHaveValue('保存失败时保留内容，并明确告诉我如何恢复。');
  f.rejectWrites(false);
  await main.getByRole('button', { name: '交给下一次迭代' }).click();
  await expect(main.getByRole('region', { name: '意见流' })).toContainText('待规划');
  const sent = f.calls.filter(c => c.method === 'loopAddAddon').at(-1)!;
  expect(JSON.parse(sent.params[3])).toEqual({ kind: 'flow', seq: 1 });
  expect(f.count('loopRunIteration')).toBe(0);
  f.update(state => { Object.assign(state.addons.at(-1).feedback, { status: 'planned', resultSeq: 1, reason: '映射到保存反馈条件 C2', criteriaIds: ['C2'] }); });
  await expect(main.getByRole('region', { name: '意见流' })).toContainText('已纳入阶段');
  expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true);
  const viewport = page.viewportSize()!;
  if (viewport.width >= 600) await page.setViewportSize({ width: viewport.width, height: 1200 });
  await f.pane.getByRole('main').evaluate(el => el.scrollTop = 0);
  await page.screenshot({ path: info.outputPath('aimein-world.png') });
  await main.getByTestId('aimein-world').screenshot({ path: info.outputPath('aimein-world-scene.png') });
  await main.getByRole('region', { name: '对象意见' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('aimein-world-feedback.png') });
});

test('reviewer workshop keeps drafts, version history, recommendations and calibration distinct', async ({ page }, info) => {
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const documents = ['体验观察员', '工程审计员', '产品验收员'].map((name, i) => ({ name, backendId: 'qa-primary', model: `Model ${i}`, reasoningEffort: '', domain: '产品 保存 恢复', flavor: ['用户理解优先', '可靠性优先', '目标达成优先'][i], focus: ['首次使用与失败反馈', '持久化与恢复证据', '成熟度和目标范围'][i], revision: 'r1' }));
  f.memory({ revision: 1, profiles: documents.map((document, i) => ({ id: `p${i}`, document, history: [] })), calibrations: [] });
  f.update(state => {
    const rec = attempt(1, true);
    rec.aimeinRun.reviews.forEach((r: any, i: number) => { r.profile = { ...documents[i], id: `p${i}`, calibrations: [] }; r.profileName = documents[i].name; });
    state.loops = [rec];
  });
  const main = f.pane.getByTestId('aimein-workbench');
  expect(f.count('loopAimeinGet')).toBe(0);
  await main.getByRole('button', { name: '评委工坊', exact: true }).click();
  const library = main.getByRole('region', { name: '评委工坊', exact: true });
  await expect(library).toContainText('样本不足');
  await library.getByRole('button', { name: '勾选推荐组合' }).click();
  await library.getByRole('button', { name: '选用 3 位评委', exact: true }).click();
  await expect(library).toContainText('已选用');
  const card = library.getByRole('article').filter({ hasText: '体验观察员' });
  await card.getByRole('button', { name: '编辑档案', exact: true }).click();
  const editor = library.getByRole('form', { name: '评委档案编辑' });
  await editor.getByLabel('聚焦 / 核对重点').fill('更关注断网后重开的恢复体验');
  f.rejectWrites(true);
  await editor.getByRole('button', { name: '保存档案', exact: true }).click();
  await expect(library).toContainText('隔离夹具拒绝保存');
  await main.getByRole('button', { name: '建设场景', exact: true }).click();
  await main.getByRole('button', { name: '评委工坊', exact: true }).click();
  await expect(editor.getByLabel('聚焦 / 核对重点')).toHaveValue('更关注断网后重开的恢复体验');
  f.rejectWrites(false);
  await editor.getByRole('button', { name: '保存档案', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(card).toContainText('版本与校准 (1 / 0)');
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: '导出文档' }).click();
  expect((await download).suggestedFilename()).toBe('aimein-reviewer.json');
  await library.getByLabel('导入评委档案').setInputFiles({ name: 'reviewer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'aimein-reviewer', version: 1, document: { ...documents[0], name: '导入的聚焦档案' } })) });
  await expect(editor.getByLabel('档案名称')).toHaveValue('导入的聚焦档案');
  await editor.getByRole('button', { name: '保存档案', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await library.getByLabel('选择 导入的聚焦档案', { exact: true }).check();
  await library.getByLabel('选择 体验观察员', { exact: true }).check();
  await expect(library.getByRole('button', { name: '选用 3 位评委' })).toBeDisabled();
  await expect(library).toContainText('同一模型的不同档案不能重复占位');
  await library.getByRole('button', { name: '勾选推荐组合' }).click();
  const calibration = library.getByRole('form', { name: '评委校准' });
  await calibration.getByLabel('观察类型').selectOption('missed');
  await calibration.getByLabel('具体依据 / 下次应如何理解').fill('离线恢复失败曾被忽略，下一次应核对错误状态。');
  await calibration.getByRole('button', { name: '保存用户校准' }).click();
  await expect(calibration.getByLabel('具体依据 / 下次应如何理解')).toHaveValue('');
  expect(f.count('loopRunIteration')).toBe(0);
  expect(await library.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true);
  if ((page.viewportSize()?.width || 1600) >= 600) await page.setViewportSize({ width: 1600, height: 1200 });
  await library.getByRole('region', { name: '评委推荐' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('aimein-reviewer-workshop.png') });
});

test('persistent sandbox retains camera and drafts through audit, reviewers and settings', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const f = await fixture(page);
  if ((page.viewportSize()?.width || 1600) < 600 && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  const viewport = main.getByTestId('aimein-3d-viewport');
  const canvas = viewport.locator('canvas');
  await expect(viewport).toHaveAttribute('data-ready', 'true');
  await expect(main.getByTestId('aimein-vessel-value')).toContainText('3 / 8');
  const original = await canvas.elementHandle();
  await main.getByLabel('对象建议').fill('保持我的观察位置，让建议回到对应阶段。');
  const bounds = (await canvas.boundingBox())!;
  expect(bounds.height).toBeGreaterThan(100);
  const initial = await canvas.getAttribute('data-camera-pose');
  await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .55);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height * .6, { steps: 8 }); await page.mouse.up();
  await expect(canvas).not.toHaveAttribute('data-camera-pose', initial || '');
  const pose = await canvas.getAttribute('data-camera-pose');
  const assertWorld = async () => {
    expect(await original!.evaluate(el => el === document.querySelector('[data-testid="aimein-3d-viewport"] canvas'))).toBe(true);
    await expect(canvas).toHaveAttribute('data-camera-pose', pose!);
    await expect(viewport).toBeInViewport({ ratio: .99 });
    const rect = (await canvas.boundingBox())!;
    expect(rect.height).toBeGreaterThan(100);
    expect(await canvas.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  };
  await main.getByRole('button', { name: '阶段记录', exact: true }).click();
  await assertWorld();
  await main.getByText('目标图与执行记录', { exact: true }).click();
  await main.getByTestId('aimein-scene-panel').evaluate(el => el.scrollTo(0, el.scrollHeight));
  await assertWorld();
  await main.getByRole('button', { name: '评委工坊', exact: true }).click();
  await expect(main.getByRole('region', { name: '评委工坊', exact: true })).toBeVisible();
  await assertWorld();
  await main.getByRole('button', { name: '建设场景', exact: true }).click();
  await expect(main.getByLabel('对象建议')).toHaveValue('保持我的观察位置，让建议回到对应阶段。');
  await main.getByRole('button', { name: '评审与执行设置', exact: true }).click();
  const settings = f.pane.getByRole('dialog');
  await expect(settings).toHaveAttribute('aria-modal', 'false');
  await settings.getByLabel('评审 1 Backend').selectOption('qa-primary');
  await settings.getByLabel('Codex 模型', { exact: true }).first().fill('Model Alpha');
  await assertWorld();
  await settings.getByRole('button', { name: '关闭详情，返回工作台' }).focus();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(main.getByRole('button', { name: '评审与执行设置', exact: true })).toBeFocused();
  await assertWorld();
  await main.getByRole('button', { name: '评审与执行设置', exact: true }).click();
  await expect(settings.getByLabel('Codex 模型', { exact: true }).first()).toHaveValue('Model Alpha');
  await settings.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await sceneButton(main, '观察评委 2');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Beta');
  await expect(viewport).toBeInViewport({ ratio: .99 });
  await page.screenshot({ path: info.outputPath('persistent-world.png') });
  await main.getByRole('button', { name: '收起面板', exact: true }).click();
  await expect(main.getByTestId('aimein-scene-panel')).toBeHidden();
  await expect(viewport).toBeInViewport({ ratio: .99 });
  await sceneButton(main, '观察功能工坊');
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('创建项目');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(f.calls.filter(c => !/Get|List/.test(c.method))).toEqual([]);
  expect(errors).toEqual([]);
});

test('persistent canvas survives explicit preparation to execution', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const f = await fixture(page, 'idle');
  if (info.project.name === 'narrow-mobile-chromium' && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const main = f.pane.getByTestId('aimein-workbench');
  const canvas = main.getByTestId('aimein-3d-viewport').locator('canvas');
  await expect(main.getByTestId('aimein-3d-viewport')).toHaveAttribute('data-ready', 'true');
  const original = await canvas.elementHandle();
  f.update(s => { s.goal = '保存与找回灵感'; s.policy.aimeinReviewers = ['Alpha', 'Beta', 'Gamma'].map(model => ({ backendId: 'qa-primary', model: `Model ${model}` })); });
  const begin = main.getByRole('button', { name: '开始建设 →', exact: true });
  await expect(begin).toBeEnabled();
  f.startRecord(planningAttempt());
  await begin.click();
  await expect(main.getByTestId('aimein-preparation')).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-flow-stage', 'planning');
  expect(await original!.evaluate(el => el === document.querySelector('[data-testid="aimein-3d-viewport"] canvas'))).toBe(true);
  expect(f.count('loopRunIteration')).toBe(1);
});


async function adjustAssembly(main: Locator, clear = false) {
  const adjust = main.getByRole('button', { name: '我想调整后续范围', exact: true });
  if (await adjust.isVisible()) await adjust.click();
  if (clear) {
      const roots = main.locator('[aria-label="模块背包"] button[aria-pressed="true"]');
    while (await roots.count()) await roots.first().click();
  }
}

test('playable workshop builds a recipe then runs and probes a real UI lifecycle with recording', async ({ page }, info) => {
  test.setTimeout(65000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await fixture(page);
  const narrow = info.project.name === 'narrow-mobile-chromium';
  if (narrow && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  const world = main.getByTestId('aimein-world');
  const canvas = world.locator('canvas');
  await expect(world.getByTestId('aimein-vessel-value')).toContainText('3 / 8');
  const original = await canvas.elementHandle();
  await world.getByRole('button', { name: '工具 2：装配' }).click();
  await adjustAssembly(main, true);
  await expect(main.getByRole('button', { name: '模块 T3：内容编辑' })).toBeVisible();
  // 等待分离动画后，用真实 Canvas 点击模块，不以 DOM 替代三维拾取。
  await page.waitForTimeout(1200);
  await clickWorldPoint(page, [-2.26, .4, -1.16]);
  await expect(canvas).toHaveAttribute('data-held-target', 'T3');
  await expect(canvas).toHaveAttribute('data-assembled', 'T1,T2,T3');
  await expect(main.getByRole('region', { name: '阶段装配' })).toContainText('1 个主动选择 · 2 个依赖自动纳入');
  await page.waitForTimeout(1100);
  await page.screenshot({ path: info.outputPath('playable-assembly.png') });
  await main.getByLabel('装配意图', { exact: true }).fill('先让我完成创作，再接上离线保存。');
  expect(f.count('loopAddAddon')).toBe(0); expect(f.count('loopRunIteration')).toBe(0);
  await main.getByRole('button', { name: '交给下次规划', exact: true }).click();
  await expect(main.getByRole('region', { name: '阶段装配' })).toContainText('组合已保存');
  const request = f.calls.find(c => c.method === 'loopAddAddon')!;
  expect(request.params[1]).toContain('来源尝试 #1');
  expect(request.params[1]).toContain('传递依赖：T1、T2');
  expect(JSON.parse(request.params[3])).toMatchObject({ kind: 'flow', seq: 1 });
  await expect(world.getByTestId('aimein-vessel-value')).toContainText('3 / 8');
  const next = flowAttempt('preparing'); next.seq = 2;
  f.startRecord(next);
  await world.getByRole('button', { name: '工坊：点火开工', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-flow-stage', 'preparing');
  await expect(world.getByRole('button', { name: '工坊：建设中', exact: true })).toBeDisabled();
  for (let done = 0; done < 3; done++) {
    f.update(s => { const step = flowAttempt('executing', done); step.seq = 2; s.loops = [worldAttempt(1), step]; });
    await expect(canvas).toHaveAttribute('data-flow-stage', 'executing');
    await page.waitForTimeout(1000);
  }
  f.update(s => { const review = flowAttempt('reviewing', 6); review.seq = 2; s.loops = [worldAttempt(1), review]; });
  await expect(canvas).toHaveAttribute('data-flow-stage', 'reviewing'); await page.waitForTimeout(1600);
  f.update(s => { const repair = flowAttempt('repair', 6, 3); repair.seq = 2; s.loops = [worldAttempt(1), repair]; s.running = false; });
  await expect(canvas).toHaveAttribute('data-flow-stage', 'repair');
  await world.getByRole('button', { name: '工具 3：成果' }).click();
  const probe = main.getByRole('region', { name: '成果与验证' });
  await expect(probe).toContainText('离线重开时缺少失败反馈');
  await probe.getByText('▣ 已保存 · 离线恢复', { exact: true }).click();
  await expect(probe).toContainText('已保存步骤 4 的实施与验证记录');
  await page.screenshot({ path: info.outputPath('playable-probe.png') });
  await probe.getByRole('button', { name: '追到评审依据' }).click();
  await expect(main.getByRole('region', { name: '场景观察' })).toContainText('Model Gamma');
  await sceneButton(world, /足迹 #1：/);
  await expect(world.getByRole('button', { name: '工坊：返回当前' })).toBeVisible();
  await expect(main.getByLabel('查看 AIMEIN 阶段', { exact: true })).toHaveValue('1');
  await world.getByRole('button', { name: '工坊：返回当前' }).click();
  expect(await original!.evaluate(el => el === document.querySelector('[data-testid="aimein-world"] canvas'))).toBe(true);
  expect(f.count('loopAddAddon')).toBe(1); expect(f.count('loopRunIteration')).toBe(1);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('playable assembly keeps failed drafts, separates changed plans and stops unknown resubmission in static view', async ({ page }, info) => {
  const f = await fixture(page);
  if (info.project.name === 'narrow-mobile-chromium' && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  await main.getByRole('button', { name: '静态视图', exact: true }).click();
  await main.getByRole('button', { name: '工具 2：装配' }).click();
  await adjustAssembly(main);
  await main.getByRole('button', { name: '模块 T2：创建项目' }).click();
  await main.getByLabel('装配意图', { exact: true }).fill('先保留这套组合');
  f.rejectWrites(true);
  const submit = main.getByRole('button', { name: '交给下次规划', exact: true });
  await submit.click();
  await expect(main.getByRole('region', { name: '阶段装配' })).toContainText('隔离夹具拒绝保存');
  await expect(main.getByLabel('装配意图', { exact: true })).toHaveValue('先保留这套组合');
  f.update(s => { s.loops = [worldAttempt(1), worldAttempt(2)]; });
  await sceneButton(main, /足迹 #2：/);
  await expect(main.getByLabel('装配意图', { exact: true })).toHaveCount(0);
  await main.getByRole('button', { name: '工具 2：装配' }).click();
  await adjustAssembly(main);
  await expect(main.getByLabel('装配意图', { exact: true })).toHaveValue('');
  await expect(submit).toBeEnabled();
  await sceneButton(main, /足迹 #1：/);
  await main.getByRole('button', { name: '工具 2：装配' }).click();
  await adjustAssembly(main);
  await expect(main.getByLabel('装配意图', { exact: true })).toHaveValue('先保留这套组合');
  await expect(submit).toBeDisabled();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  f.rejectWrites(false); f.unknownWrites(true);
  await expect(submit).toBeEnabled(); await submit.click();
  await expect(main.getByRole('region', { name: '阶段装配' })).toContainText('保存结果未知');
  await expect(submit).toBeDisabled();
  await main.getByRole('button', { name: '工具 3：成果' }).click();
  await main.getByRole('button', { name: '工具 2：装配' }).click();
  await adjustAssembly(main);
  await expect(submit).toBeDisabled();
  expect(f.count('loopAddAddon')).toBe(2); expect(f.count('loopRunIteration')).toBe(0);
  await expect(main.getByTestId('aimein-world-static')).toBeInViewport({ ratio: .99 });
});

test('playable tools respect keyboard editing and select the exact reviewer for calibration', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const f = await fixture(page);
  if (info.project.name === 'narrow-mobile-chromium' && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const documents = ['体验', '工程', '产品'].map((name, i) => ({ name, backendId: 'qa-primary', model: `Model ${i}`, reasoningEffort: '', domain: '保存 恢复', flavor: '可靠体验', focus: '离线失败', revision: 'r1' }));
  f.memory({ revision: 1, profiles: documents.map((document, i) => ({ id: `p${i}`, document, history: [] })), calibrations: [] });
  f.update(s => { const r = worldAttempt(1); r.aimeinRun.reviews.forEach((v: any, i: number) => { v.profile = { ...documents[i], id: `p${i}`, calibrations: [] }; }); s.loops = [r]; });
  const main = f.pane.getByTestId('aimein-workbench'); const world = main.getByTestId('aimein-world');
  await world.focus(); await page.keyboard.press('2');
  await expect(world).toHaveAttribute('data-tool', 'assemble');
  await adjustAssembly(main);
  await main.getByLabel('装配意图', { exact: true }).fill('1234');
  await expect(world).toHaveAttribute('data-tool', 'assemble');
  await world.focus(); await page.keyboard.press('4');
  await main.getByRole('region', { name: '评委席', exact: true }).getByRole('button', { name: '校准这位评委' }).nth(2).click();
  const calibration = main.getByRole('form', { name: '评委校准' });
  await expect(calibration.getByLabel('被校准的评委')).toHaveValue('review3');
  await calibration.getByLabel('观察类型').selectOption('missed');
  await calibration.getByLabel('具体依据 / 下次应如何理解').fill('第三位应核对断网后的用户反馈。');
  await calibration.getByRole('button', { name: '保存用户校准' }).click();
  await expect(calibration.getByLabel('具体依据 / 下次应如何理解')).toHaveValue('');
  const command = JSON.parse(f.calls.find(c => c.method === 'loopAimeinUpdate')!.params[1]);
  expect(command).toMatchObject({ action: 'calibrate', seq: 1, reviewId: 'review3', kind: 'missed' });
  expect(f.count('loopRunIteration')).toBe(0);
});

test('playable plan revisions, missing dependencies and execution gates remain authoritative', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const f = await fixture(page);
  if (info.project.name === 'narrow-mobile-chromium' && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  f.update(s => { s.loops = [worldAttempt(1)]; });
  const main = f.pane.getByTestId('aimein-workbench');
  await main.getByRole('button', { name: '工具 2：装配' }).click();
  await adjustAssembly(main);
  await main.getByRole('button', { name: '模块 T2：创建项目' }).click();
  await main.getByLabel('装配意图', { exact: true }).fill('只属于旧版的方案');
  f.update(s => { s.loops[0].aimeinRun.plan.targets[1].acceptance = '新的验收要求'; s.loops[0].aimeinSummary.revision = 'changed-plan'; });
  await expect(main.getByLabel('装配意图', { exact: true })).toHaveCount(0);
  await adjustAssembly(main);
  await expect(main.getByLabel('装配意图', { exact: true })).toHaveValue('');
  f.update(s => { s.loops[0].aimeinRun.plan.targets[1].dependsOn = ['missing']; s.loops[0].aimeinSummary.revision = 'missing-plan'; });
  await expect(main.getByRole('region', { name: '阶段装配' })).toContainText('缺少依赖详情：missing');
  await adjustAssembly(main);
  await expect(main.getByRole('button', { name: '交给下次规划', exact: true })).toBeDisabled();
  f.replace('manual', { policy: { executionMode: 'aimein' }, loops: [worldAttempt(1)] });
  await expect(main.getByRole('button', { name: '工坊：点火开工' })).toBeDisabled();
  f.replace('legacy', { policy: { executionMode: 'aimein' }, loops: [worldAttempt(1)], executionEnvironment: { revision: 1, status: 'unknown', latest: { quiesced: false } } });
  await expect(main.getByRole('button', { name: '工坊：点火开工' })).toBeDisabled();
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopAddAddon')).toBe(0);
});



function activeCall(stage: string, phase = 'tools', model = 'Model Alpha') {
  return { id: stage, stage, status: 'running', phase, startedAt: Date.now() / 1000 - 25,
    observedAt: Date.now() / 1000, lastActivityAt: Date.now() / 1000, model, textChars: 40,
    eventCounts: { tool_start: 3 }, promptChars: 100, estimatedPromptTokens: 30, imageCount: 0,
    thinkingChars: 0, transportAttempts: 1, retryCount: 0, retryWaitSeconds: 0 };
}

test('runtime field follows preparation planning execution and review with visible flow', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const f = await fixture(page, 'legacy', true);
  if (info.project.name === 'narrow-mobile-chromium' && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const main = f.pane.getByTestId('aimein-workbench');
  const canvas = main.getByTestId('aimein-world').locator('canvas');
  const initial = { ...record(), seq: 1, completed: false, subStage: 'prepare', orchestration: [], goal: '建设创作、保存与恢复工作台',
    stageDetails: { openspecSetup: { status: 'running', message: '正在准备正式来源' } }, callDiagnostics: [activeCall('prepare')] };
  f.update(s => { s.running = true; s.goal = initial.goal; s.loops = [initial]; });
  const field = main.getByTestId('aimein-runtime');
  await expect(field).toBeVisible();
  await expect(field.getByTestId('aimein-runtime-title')).toHaveText('OpenSpec 准备');
  await expect(field).toContainText(initial.goal);
  await expect(main.getByText('开始前，选好评审组', { exact: true })).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-flow-activity', 'prepare');
  await expect.poll(() => canvas.getAttribute('data-flow-particles').then(Number)).toBeGreaterThan(0);
  f.emit(1, 'prepare', '正在核对 OpenSpec 与现有方案。\n');
  await expect(field.getByTestId('aimein-live-output')).toContainText('正在核对 OpenSpec');
  await page.screenshot({ path: info.outputPath('runtime-preparation.png') });
  await page.waitForTimeout(1600);
  f.update(s => { s.loops[0].callDiagnostics[0].phase = 'turn_accepted'; });
  await expect(canvas).toHaveAttribute('data-flow-activity', '');
  await expect.poll(() => canvas.getAttribute('data-flow-particles').then(Number)).toBe(0);
  const plan: any = planningAttempt(); plan.goal = initial.goal; plan.callDiagnostics = [activeCall('aimein-plan', 'text')];
  f.update(s => { s.loops = [plan]; });
  f.emit(1, 'aimein-plan', '将目标拆解为创作、保存、恢复三个可核实的流程。\n');
  await expect(field.getByTestId('aimein-runtime-title')).toHaveText('目标拆解');
  await expect(canvas).toHaveAttribute('data-flow-activity', 'plan');
  await expect(field.getByTestId('aimein-live-output')).toContainText('将目标拆解');
  await page.waitForTimeout(1600);
  const executing = flowAttempt('executing'); executing.goal = initial.goal; executing.callDiagnostics = [activeCall('execute', 'text')];
  f.update(s => { s.loops = [executing]; });
  f.emit(1, 'execute', Array.from({ length: 80 }, (_, i) => `真实输出行 ${i} · 正在实施保存与恢复`).join('\n'));
  await expect(canvas).toHaveAttribute('data-flow-activity', 'build,infra,store');
  await expect(field.getByTestId('aimein-observation')).toHaveAttribute('data-health', 'working');
  await expect(field.getByTestId('aimein-observation')).toContainText('已保存步骤');
  await expect(field.getByRole('navigation', { name: '输出通道' })).toBeHidden();
  if (info.project.name === 'desktop-chromium') await expect(field.getByTestId('aimein-observation')).toContainText('性能 / 效率：未测量');
  const output = field.getByTestId('aimein-live-output');
  await expect(output).toContainText('真实输出行 79');
  await field.getByRole('button', { name: '暂停跟随', exact: true }).click();
  await output.evaluate(el => { el.scrollTop = 0; });
  f.emit(1, 'execute', '\n末尾新增：阅读不应被打断');
  await expect(output).toContainText('末尾新增');
  expect(await output.evaluate(el => el.scrollTop)).toBeLessThan(30);
  await field.getByRole('button', { name: '回到最新', exact: true }).click();
  await expect.poll(() => output.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(30);
  await expect(field.getByTestId('aimein-runtime-title')).toBeInViewport();
  expect((await output.boundingBox())!.height).toBeGreaterThan(45);
  await page.screenshot({ path: info.outputPath('runtime-execution.png') });
  await page.waitForTimeout(1800);
  const reviewing = flowAttempt('reviewing', 6); reviewing.goal = initial.goal;
  reviewing.callDiagnostics = [activeCall('aimein-review1', 'tools'), activeCall('aimein-review2', 'thinking', 'Model Beta')];
  f.update(s => { s.loops = [reviewing]; });
  f.emit(1, 'aimein-review1', '评委一：保存重开已经有验证。');
  f.emit(1, 'aimein-review2', '评委二：正在核对离线恢复。');
  await expect(canvas).toHaveAttribute('data-flow-activity', 'review0,review1');
  await expect(output).toContainText('评委二');
  await field.getByRole('button', { name: '查看完整输出' }).click();
  await field.getByRole('navigation', { name: '输出通道' }).getByRole('button', { name: /评委 1/ }).click();
  await expect(output).toContainText('评委一');
  f.emit(1, 'aimein-review2', '第二份输出不应混入第一份。');
  await expect(output).not.toContainText('第二份输出');
  await expect(field.getByTestId('aimein-review-overview')).toBeVisible();
  await page.screenshot({ path: info.outputPath('runtime-review.png') });
  await page.waitForTimeout(1800);
  const stopped = flowAttempt('repair', 6, 3); stopped.goal = initial.goal;
  f.update(s => { s.running = false; s.loops = [stopped]; });
  await expect(field.getByTestId('aimein-runtime-title')).toHaveText('需要处理');
  await page.waitForTimeout(2800);
  await expect.poll(() => canvas.getAttribute('data-flow-particles').then(Number)).toBe(0);
  await main.getByRole('button', { name: '工具 4：评委' }).click();
  await expect(main.getByTestId('aimein-review-overview')).toContainText('整体意见');
  await page.screenshot({ path: info.outputPath('runtime-overall-opinion.png') });
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopAddAddon')).toBe(0);
  expect(errors).toEqual([]);
});

test('runtime output preserves history and offline state while assembly is automatic', async ({ page }, info) => {
  const f = await fixture(page, 'legacy', true);
  if (info.project.name === 'narrow-mobile-chromium' && await page.locator('.awu-sidebar').isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const main = f.pane.getByTestId('aimein-workbench');
  const current = flowAttempt('executing'); current.seq = 2;
  current.callDiagnostics = [activeCall('execute')]; current.stageDetails = { execute: { rawOutput: '重连后保存的执行输出' } };
  const old = attempt(1); (old as any).stageDetails = { execute: { rawOutput: '旧尝试保存输出' } };
  f.update(s => { s.running = true; s.loops = [old, current]; });
  const field = main.getByTestId('aimein-runtime');
  await expect(field.getByTestId('aimein-live-output')).toContainText('重连后保存的执行输出');
  await field.getByRole('button', { name: '查看完整输出' }).click();
  await field.getByLabel('运行记录').selectOption('1');
  await expect(field.getByTestId('aimein-runtime-title')).toHaveText('历史尝试 #1');
  f.emit(2, 'execute', '仅当前运行的新输出');
  await expect(field.getByTestId('aimein-live-output')).not.toContainText('仅当前运行');
  await expect(main.locator('canvas')).toHaveAttribute('data-flow-activity', '');
  await field.getByRole('button', { name: '返回现场' }).click();
  await expect(field.getByTestId('aimein-live-output')).toContainText('仅当前运行');
  await main.getByRole('button', { name: '工具 2：装配' }).click();
  const assembly = main.getByRole('region', { name: '阶段装配' });
  await expect(assembly).toContainText('无需手动装配');
  await expect(assembly.getByRole('button', { name: '装配槽 T1', exact: true })).toBeVisible();
  await expect(assembly.getByLabel('装配意图', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('automatic-assembly.png') });
  await main.getByRole('button', { name: '工具 3：成果' }).click();
  await expect(main.getByRole('region', { name: '成果与验证' })).toContainText('有什么验证依据');
  await main.getByRole('button', { name: /运行现场/, exact: false }).click();
  f.disconnect();
  await expect(field.getByTestId('aimein-runtime-title')).toHaveText('连接中断 · 状态待核对');
  await expect(main.locator('canvas')).toHaveAttribute('data-flow-activity', '');
  await expect(field.getByTestId('aimein-live-output')).toContainText('仅当前运行的新输出');
  expect(f.count('loopAddAddon')).toBe(0); expect(f.count('loopRunIteration')).toBe(0);
});


test('runtime saved output can be read completely in bounded pages', async ({ page }) => {
  const f = await fixture(page, 'legacy', true);
  const saved = { ...record(), seq: 1, completed: true, subStage: 'done', orchestration: [], stageDetails: { prepare: { status: 'done', rawOutput: '原文开头' + '甲'.repeat(60000) + '原文末尾' } } };
  f.update(s => { s.running = false; s.loops = [saved]; });
  const field = f.pane.getByTestId('aimein-runtime');
  const output = field.getByTestId('aimein-live-output');
  await expect(output).toContainText('原文末尾');
  await expect(output).not.toContainText('原文开头');
  await output.evaluate(el => { el.scrollTop = 0; });
  await output.getByRole('button', { name: '分段查看已保存内容' }).click();
  await expect(output).toContainText('原文开头');
  await expect(output).not.toContainText('原文末尾');
  await output.getByRole('button', { name: '下一段' }).click();
  await expect(output).toContainText('原文末尾');
  await output.getByRole('button', { name: '上一段' }).click();
  await expect(output).toContainText('原文开头');
  expect(f.count('loopRunIteration')).toBe(0);
});


test('overall review exposes conflicting evidence without a majority pass', async ({ page }, info) => {
  const f = await fixture(page);
  const r = attempt(1);
  r.aimeinRun.reviews[2].criteria[0] = { id: 'C1', status: 'gap', reason: '断网重开会丢失未同步内容', evidence: ['tests/offline.test.ts'] };
  r.aimeinSummary.issues = [{ id: 'C1', model: 'Model Gamma', reason: '断网重开会丢失未同步内容' }];
  f.update(s => { s.loops = [r]; });
  const main = f.pane.getByTestId('aimein-workbench');
  await main.getByRole('button', { name: '工具 4：评委' }).click();
  const overview = main.getByTestId('aimein-review-overview');
  await expect(overview).toContainText('本阶段尚未通过');
  await overview.getByText('有分歧 · 保存后重新打开，内容一致。', { exact: true }).click();
  await expect(overview).toContainText('Model Alpha');
  await expect(overview).toContainText('Model Beta');
  await expect(overview).toContainText('断网重开会丢失未同步内容');
  await expect(overview).toContainText('tests/offline.test.ts');
  await main.screenshot({ path: info.outputPath('overall-review.png') });
  expect(f.count('loopRunIteration')).toBe(0);
  expect(f.count('loopAddAddon')).toBe(0);
});
