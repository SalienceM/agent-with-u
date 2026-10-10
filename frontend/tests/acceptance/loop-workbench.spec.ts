import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
const { states, record } = require('../home/fixtures/loop-workbench.cjs');
const sid = 'qa-loop-000';

async function fixture(page: Page, name = 'idle') {
  let value: any = { ...states()[name], sessionId: sid };
  let socket: WebSocketRoute;
  const calls: Array<{ method: string; params: any[] }> = [];
  const pending: Array<() => void> = [];
  let hold = false;
  const summary = () => ({ protocolVersion: 1, sessionId: sid, controlMode: 'loop', controlRevision: 0,
    stage: value.stage, round: value.round, auto: value.auto,
    eligibility: { takeover: { allowed: true, reasonCode: 'ready', message: '可以接管', nextStep: 'request' },
      release: { allowed: false, reasonCode: 'loop', message: '已在 LOOP', nextStep: 'check' } } });
  const push = () => socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(value) }));
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
    progress: () => socket.send(JSON.stringify({ event: 'loopProgress', data: JSON.stringify({ sessionId: sid, seq: 1, subStage: 'step1', text: '实时内容' }) })),
  };
}

for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`workbench states fit ${size.width} and keyboard details return focus`, async ({ page }, info) => {
    await page.setViewportSize(size);
    const f = await fixture(page);
    for (const name of ['idea', 'idle', 'running', 'resumable', 'multi', 'result', 'legacy', 'human']) {
      f.replace(name);
      const bench = f.pane.getByTestId('loop-workbench');
      await expect(bench.getByTestId('loop-goal-summary')).toBeInViewport();
      await expect(bench.getByTestId('loop-current-status')).toBeInViewport();
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
    const trigger = f.pane.getByRole('button', { name: '过程与历史', exact: true });
    await trigger.focus(); await trigger.press('Enter');
    const close = f.pane.getByRole('button', { name: '关闭详情，返回工作台' });
    await expect(close).toBeFocused();
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
  await f.pane.getByRole('button', { name: '继续未完成步骤', exact: true }).click();
  expect(f.count('loopRunIteration')).toBe(1);
  f.replace('idea');
  await f.pane.getByPlaceholder('直接写目标，或留空让模型汇总下方想法').fill('明确本轮目标');
  page.once('dialog', dialog => dialog.accept());
  await f.pane.getByRole('button', { name: '确认目标，进入执行', exact: true }).click();
  expect(f.count('loopSealIdea')).toBe(1);
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
  await f.pane.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  f.update(state => { state.loops[0].updatedAt++; });
  await page.waitForTimeout(150);
  expect(f.count('loopGetRecord')).toBe(1);
  await f.pane.getByRole('button', { name: '过程与历史', exact: true }).click();
  await expect.poll(() => f.count('loopGetRecord')).toBe(2);
  expect(f.calls.some(call => /Source|Environment/.test(call.method))).toBe(false);
});

test('goal and Addon drafts survive opening details; supplement is queued without altering current step', async ({ page }) => {
  const f = await fixture(page, 'running');
  await f.pane.getByText('补充要求 · 0 条待纳入', { exact: true }).click();
  const input = f.pane.getByPlaceholder('补充要求 / 修正…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）');
  await input.fill('保留正在执行的步骤');
  await f.pane.getByRole('button', { name: '目标与补充', exact: true }).click();
  await f.pane.getByRole('button', { name: '编辑', exact: true }).click();
  const goal = f.pane.getByLabel('LOOP 详情').locator('textarea').first();
  await goal.fill('未提交的目标草稿');
  await f.pane.getByLabel('详情分类').selectOption('settings');
  await f.pane.getByLabel('详情分类').selectOption('goal');
  await expect(goal).toHaveValue('未提交的目标草稿');
  await f.pane.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  await expect(f.pane.getByRole('button', { name: '目标与补充', exact: true })).toBeFocused();
  await expect(input).toHaveValue('保留正在执行的步骤');
  await input.press('Control+Enter');
  await expect.poll(() => f.count('loopAddAddon')).toBe(1);
  await expect(f.pane.getByTestId('loop-current-status')).toContainText('正在执行');
  expect(f.count('loopRunIteration')).toBe(0); expect(f.count('loopSetGoal')).toBe(0);
});

test('same Session on a different executor cannot receive a late cached detail', async ({ page }, info) => {
  await page.goto('/');
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
  await bench.getByRole('button', { name: '关闭详情，返回工作台' }).click();
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await expect(bench.getByTestId('loop-current-status')).toContainText('只读总览');
    await expect(bench.getByRole('button', { name: '返回人工工作区' })).toBeInViewport();
    await expect(bench.getByText('更多操作', { exact: true })).toHaveCount(0);
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
  const details = f.pane.getByLabel('LOOP 详情');
  await expect(details).toContainText('旧调用退出尚未确认');
  await expect(details).toContainText('核对任务来源');
  await expect(details).toContainText('存在未解决任务阻塞');
  await details.getByLabel('详情分类').selectOption('settings');
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
  const details = f.pane.getByLabel('LOOP 详情');
  await details.getByRole('button', { name: /目标演变/ }).click();
  await expect(details).toContainText('原始目标'); await expect(details).toContainText('修订目标');
  await details.getByRole('button', { name: /原始诉求/ }).click();
  await expect(details).toContainText('带图原始想法');
  await details.getByRole('button', { name: /Addon 历史/ }).click();
  await expect(details).toContainText('带图已纳入补充');
  await expect(details.locator('img')).toHaveCount(2);
  expect(f.calls.filter(call => !/Get|List/.test(call.method))).toHaveLength(0);
});
