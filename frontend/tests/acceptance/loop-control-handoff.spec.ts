import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { selectMode } from './engine-actions';

const sid = 'qa-loop-000', title = '首页交付 Loop 1';
async function fixture(page: Page, mode: 'loop' | 'manual' = 'loop', legacy = false, engineering = false, workbench = engineering) {
  let socket: WebSocketRoute;
  let operation: any;
  let revision = 0;
  let pending: any;
  let failChat = false, failLoop = false, offlineRead = false, staleMirror = false;
  let stage = 'loopexecute';
  let state: any;
  const writes: any[] = [], reads: string[] = [];
  const condition = { allowed: true, reasonCode: 'ready', message: '可以转交', nextStep: 'request' };
  const workspace = { ownerId: 'local', executorInstance: 'fixture', sessionId: sid, workingDir: 'C:/qa/loop-engine', workspaceRevision: 'a'.repeat(64) };
  let confirmStop = false;
  const terminal: any = { workspace, resourceId: 'loop-terminal', generation: 'loop-generation', requestId: 'prior-create', activityId: 'blocking-terminal',
    status: 'running', exitConfirmed: false, reasonCode: '', revision: 1, lastSequence: 0, inputSequence: 0, cols: 80, rows: 24,
    shell: { id: 'fake', executable: 'C:/qa/shell', args: [] } };
  const activities = () => engineering && !terminal.exitConfirmed ? [{ activityId: terminal.activityId, kind: 'terminal', workspace,
    status: terminal.status, resourceId: terminal.resourceId, generation: terminal.generation, relativePath: '' }] : [];
  let eligibility = { takeover: { ...condition }, release: { ...condition } };
  const summary = () => ({ protocolVersion: 1, sessionId: sid, controlMode: mode, controlRevision: revision,
    stage, round: 1, auto: false, eligibility, operation, engineeringActivities: activities() });
  const loopState = () => ({ ...state, sessionId: sid, stage, controlMode: mode, controlRevision: revision,
    running: false, resumable: false, auto: false, controlProtocolVersion: legacy ? undefined : 1, controlOperation: operation,
    controlEligibility: eligibility, canTakeover: eligibility.takeover.allowed, engineeringActivities: activities() });
  if (engineering) eligibility.release = { allowed: false, reasonCode: 'engineering_activity', message: '终端仍存活', nextStep: 'workbench' };
  await page.addInitScript(() => {
    window.confirm = () => { (window as any).handoffConfirmedAt = performance.now(); return true; };
  });
  await page.routeWebSocket(/127\.0\.0\.1:45421/, ws => {
    socket = ws;
    const server = ws.connectToServer();
    const requests = new Map<any, any>();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message));
      const respond = (result: any) => ws.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if ((workbench || engineering) && frame.params?.[0] === sid) {
        if (frame.method === 'sessionWorkbenchCapabilities') return respond({ status: 'ok', protocolVersion: 1, identity: workspace,
          capabilities: { viewMode: 1, documents: 1, windowHandoff: 0, terminal: engineering ? 1 : 0, languageServices: 0 } });
        if (frame.method === 'listDirectory') return respond([]);
        if (frame.method === 'gitDetect') return respond({ isRepo: false });
        if (frame.method === 'terminalList') return respond({ status: 'ok', workspace, terminals: [terminal], shells: [terminal.shell], controlRevision: revision });
        if (frame.method === 'terminalRead') return respond({ ...terminal, status: 'ok', terminalStatus: terminal.status, gap: false, through: 0, earliestSequence: 1, chunks: [] });
        if (frame.method === 'terminalResize') return respond(terminal);
        if (frame.method === 'terminalStop') {
          const input = JSON.parse(frame.params[2]);
          expect(input.resourceId).toBe(terminal.resourceId); expect(input.generation).toBe(terminal.generation);
          terminal.status = confirmStop ? 'stopped' : 'unknown'; terminal.exitConfirmed = confirmStop; terminal.revision++;
          if (confirmStop) eligibility.release = { ...condition };
          reads.push('terminalStop'); return respond(terminal);
        }
        if (frame.method === 'updateSessionWorkbench') return respond({ status: 'ok', viewMode: 'engine', summary: { id: sid, viewMode: 'engine', workingDir: workspace.workingDir } });
        if (['terminalCreate', 'terminalInput', 'workspaceDocumentSave', 'languageServiceStart'].includes(frame.method)) throw Error(`Unrequested engineering mutation ${frame.method}`);
      }
      if (['sendMessage', 'loopRunIteration', 'seqtaskTakeNext', 'loopSetAuto', 'loopContinue', 'seqtaskClear', 'abortMessage'].includes(frame.method)
        || (!legacy && ['loopTakeover', 'loopRelease'].includes(frame.method)))
        throw new Error(`Unexpected mutation ${frame.method}`);
      if (frame.params?.[0] === sid) reads.push(frame.method);
      if (frame.method === 'seqtaskGet' && frame.params[0] === sid) {
        respond({ status: 'ok', sessionId: sid, seqAuto: false, seqError: '',
          seqTasks: [{ id: 'qa-held', text: 'QA 待处理的序列任务', status: 'pending' }] }); return;
      }
      if (frame.method === 'loopControlGet' && frame.params[0] === sid) {
        if (offlineRead) ws.send(JSON.stringify({ id: frame.id, error: 'QA executor offline' }));
        else respond(legacy ? null : summary());
      } else if (['loopControlRequest', 'loopTakeover', 'loopRelease'].includes(frame.method)) {
        const input = frame.method === 'loopControlRequest' ? JSON.parse(frame.params[1])
          : { action: frame.method === 'loopTakeover' ? 'takeover' : 'release', requestId: 'legacy-fixture' };
        writes.push(input); pending = { frame, ws }; revision++;
        operation = { requestId: input.requestId, action: input.action, status: 'running', phase: 'snapshot',
          revision: 1, startedAt: Date.now() / 1000, updatedAt: Date.now() / 1000,
          committed: false, checkpointAvailable: null, controlRevision: revision, reasonCode: 'ready', message: '' };
      } else if (frame.method === 'loadSession' && frame.params[0] === sid && failChat) {
        ws.send(JSON.stringify({ id: frame.id, error: 'QA chat hydration failed' }));
      } else if (frame.method === 'loopGetState' && frame.params[0] === sid && failLoop) {
        ws.send(JSON.stringify({ id: frame.id, error: 'QA LOOP hydration failed' }));
      } else { requests.set(frame.id, frame); server.send(message); }
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message)), request = requests.get(frame.id);
      if (request?.params?.[0] === sid && frame.result) {
        let value: any; try { value = JSON.parse(frame.result); } catch { /* */ }
        if (request.method === 'loadSessionMeta' && value) Object.assign(value,
          { loopControlMode: staleMirror ? 'loop' : mode, controlRevision: staleMirror ? 0 : revision,
            ...(workbench || engineering ? { workingDir: workspace.workingDir } : {}),
            loopControlProtocolVersion: legacy ? undefined : 1 });
        if (request.method === 'loopGetState' && value) { state = value; value = loopState(); }
        if (value) frame.result = JSON.stringify(value);
      }
      ws.send(JSON.stringify(frame));
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(title, { exact: true }).click();
  const pane = page.locator(`[data-session-tab-panel="${sid}"]`);
  if (mode === 'loop') await pane.getByText('更多操作', { exact: true }).click();
  const expectSuccess = async (controlMode: 'manual' | 'loop') => {
    await expect.poll(() => page.evaluate(async sessionId => {
      // @ts-ignore Read the actual shared state without issuing RPCs.
      const { loopControls, loopControlTarget } = await import('/src/api.ts');
      const view = loopControls.get(loopControlTarget(sessionId));
      return { phase: view.phase, controlMode: view.summary?.controlMode, auto: view.summary?.auto,
        committed: view.summary?.operation?.committed, error: view.error };
    }, sid)).toEqual({ phase: 'succeeded', controlMode, auto: false, committed: true, error: '' });
    await expect(pane.locator(controlMode === 'manual' ? '.chat-textarea' : '.awu-loop')).toBeVisible();
    await expect(pane.getByTestId('loop-control-status')).toHaveCount(0);
  };
  return { pane, writes, reads, expectSuccess,
    engineering: (enabled: boolean) => { engineering = enabled; },
    confirmStop: () => { confirmStop = true; },
    push: () => socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(loopState()) })),
    complete: (push = true, reply = true, checkpointAvailable = true) => {
      mode = operation.action === 'takeover' ? 'manual' : 'loop'; revision++;
      operation = { ...operation, status: 'succeeded', phase: 'done', revision: 5, controlRevision: revision,
        updatedAt: Date.now() / 1000, committed: true, checkpointAvailable };
      if (push) socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(loopState()) }));
      if (reply && pending) pending.ws.send(JSON.stringify({ id: pending.frame.id, result: JSON.stringify({ status: 'accepted', ...summary() }) }));
    },
    failChat: (value: boolean) => { failChat = value; },
    failLoop: (value: boolean) => { failLoop = value; },
    failOperation: (status: 'failed' | 'blocked') => {
      operation = { ...operation, status, phase: 'done', revision: 5, message: 'QA 条件已变化', committed: false };
      socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(loopState()) }));
      pending.ws.send(JSON.stringify({ id: pending.frame.id, result: JSON.stringify({ status: 'accepted', ...summary() }) }));
    },
    staleMirror: () => { staleMirror = true; },
    offline: (value: boolean) => { offlineRead = value; },
    disconnect: () => socket.close({ code: 1012, reason: 'QA injected disconnect' }),
    loopout: () => { stage = 'loopout'; socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(loopState()) })); },
    block: (message: string, action = 'takeover', nextStep = 'check') => { eligibility = { ...eligibility,
      [action]: { ...condition, allowed: false, message, nextStep } };
      socket.send(JSON.stringify({ event: 'loopUpdated', data: JSON.stringify(loopState()) })); },
};
}

test('idle terminal blocks release, locates Engine, and unknown stop stays protected until confirmed', async ({ page }) => {
  const f = await fixture(page, 'manual', false, true);
  const feedback = f.pane.getByLabel('LOOP 工程阻塞活动').first();
  await expect(feedback).toContainText('空闲 Shell 仍占用');
  await feedback.getByRole('button', { name: '定位工程活动' }).click();
  await expect(f.pane.locator('[data-view-mode="engine"]')).toBeVisible();
  await expect(f.pane.getByRole('region', { name: 'Engine 终端区域' })).toBeVisible();
  // 窄屏工程区一次只展示一个区域；定位终端后显式返回 LOOP 查看共享保护状态。
  const conversation = f.pane.getByRole('button', { name: '对话 / LOOP', exact: true });
  if (await conversation.isVisible()) await conversation.click();
  await feedback.getByRole('button', { name: '停止此活动及所属进程' }).click();
  await expect(feedback).toContainText('退出未确认');
  expect(f.writes).toHaveLength(0); expect(f.reads.filter(r => r === 'terminalStop')).toHaveLength(1);
  f.confirmStop();
  await feedback.getByRole('button', { name: '停止此活动及所属进程' }).click();
  await expect(feedback.getByText('空闲 Shell 仍占用', { exact: false })).toHaveCount(0);
  expect(f.writes).toHaveLength(0); // Explicit stop never auto-releases or starts a loop.
});

test('draft-only release can be cancelled and never saves or discards a buffer', async ({ page }) => {
  const f = await fixture(page, 'manual');
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  await page.evaluate(async sessionId => {
    // @ts-ignore Vite serves this module in the isolated acceptance page.
    const { documentStore } = await import('/src/utils/documentStore.ts');
    const workspace = { ownerId: 'local', executorInstance: 'fixture', sessionId, workingDir: '/qa', workspaceRevision: 'a'.repeat(64) };
    const doc = await documentStore.open({ identity: workspace, read: async (relativePath: string) => ({ document: { workspace, source: 'executor', relativePath }, text: 'base', editable: true }) }, 'draft.py');
    documentStore.edit(doc.key, 'unsaved');
    (window as any).confirm = (text: string) => { (window as any).draftWarning = text; return false; };
  }, sid);
  await page.getByRole('button', { name: 'Manual LOOP 人工接管中', exact: true }).click();
  await page.getByRole('button', { name: /交还 LOOP.*封存人工轮/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).draftWarning)).toContain('未保存草稿');
  expect(f.writes).toHaveLength(0);
  await page.evaluate(() => { window.confirm = () => true; });
  await page.getByRole('button', { name: /交还 LOOP.*封存人工轮/ }).click();
  await expect.poll(() => f.writes.length).toBe(1); f.complete();
  expect(await page.evaluate(async () => {
    // @ts-ignore Vite fixture import.
    const { documentStore } = await import('/src/utils/documentStore.ts');
    return documentStore.all().some((doc: any) => doc.dirty && doc.text === 'unsaved');
  })).toBe(true);
});

test('takeover immediately reports pending, slow snapshot and push-before-response', async ({ page }, info) => {
  const f = await fixture(page);
  const button = f.pane.getByRole('button', { name: '✋ 人工接管', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  const status = f.pane.getByTestId('loop-control-status');
  await expect(status).toContainText('正在申请人工接管');
  expect(await page.evaluate(() => performance.now() - (window as any).handoffConfirmedAt)).toBeLessThan(200);
  await expect(button).toBeDisabled();
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect.poll(() => f.writes.length).toBe(1);
  f.push();
  await expect(status).toContainText('正在保存工作区快照');
  await expect(status).toContainText('耗时较长', { timeout: 7000 });
  await expect(f.pane.locator('.chat-textarea')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('slow-handoff.png') });
  f.complete(true, false);
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  await f.expectSuccess('manual');
  const reads = f.reads.length;
  await page.waitForTimeout(1500);
  expect(f.writes).toHaveLength(1);
  expect(f.reads.length).toBe(reads);
});

test('release feedback stays after menu closes and does not enable Auto', async ({ page }, info) => {
  const f = await fixture(page, 'manual', false, false, true);
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Manual LOOP 人工接管中', exact: true });
  await menu.click();
  await page.getByRole('button', { name: /交还 LOOP.*封存人工轮/ }).click();
  await menu.click();
  await expect(page.getByRole('dialog', { name: 'Manual LOOP 控制' })).toHaveCount(0);
  await expect(f.pane.getByTestId('loop-control-status')).toContainText('正在申请交还 LOOP');
  f.complete(false, true);
  await expect(f.pane.locator('.awu-loop')).toBeVisible();
  await f.expectSuccess('loop');
  expect(f.writes).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('returned-loop.png') });
});

test('release without checkpoint removes the whole success banner in Chat and Engine', async ({ page }, info) => {
  const f = await fixture(page, 'manual', false, false, true);
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Manual LOOP 人工接管中', exact: true });
  await menu.click();
  await page.getByRole('button', { name: /交还 LOOP.*封存人工轮/ }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  await menu.click();
  f.complete(true, true, false);
  await f.expectSuccess('loop');
  const checkpoint = () => page.evaluate(async sessionId => {
    // @ts-ignore Inspect the receipt; removing UI must not erase recovery evidence.
    const { loopControls, loopControlTarget } = await import('/src/api.ts');
    return loopControls.get(loopControlTarget(sessionId)).summary?.operation?.checkpointAvailable;
  }, sid);
  for (const mode of ['Chat', 'Engine'] as const) {
    if (mode === 'Engine') {
      await selectMode(page, f.pane, mode);
      await expect(f.pane.locator('[data-view-mode="engine"]')).toBeVisible();
      const conversation = f.pane.getByRole('button', { name: '对话 / LOOP', exact: true });
      if (await conversation.isVisible()) await conversation.click();
    }
    await f.expectSuccess('loop');
    expect(await checkpoint()).toBe(false);
    await expect(f.pane.getByText('文件检查点不可用，不能依赖它恢复。', { exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      const pane = (await f.pane.locator('.awu-chat-pane').boundingBox())!;
      const panel = (await f.pane.locator('.awu-loop').boundingBox())!;
      return Math.abs(panel.y - pane.y);
    }).toBeLessThanOrEqual(2); // No hidden banner wrapper or reserved top height.
    await page.screenshot({ path: info.outputPath(`settled-${mode.toLowerCase()}.png`) });
  }
  expect(f.writes).toHaveLength(1);
});

test('settled takeover still shows new read errors and engineering blockers without the old success receipt', async ({ page }) => {
  const f = await fixture(page);
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.complete();
  await f.expectSuccess('manual');
  f.offline(true);
  await page.evaluate(async sessionId => {
    // @ts-ignore Trigger a user-equivalent read, not another control write.
    const { loopControls, loopControlTarget } = await import('/src/api.ts');
    await loopControls.check(loopControlTarget(sessionId));
  }, sid);
  const status = f.pane.getByTestId('loop-control-status');
  await expect(status).toContainText('控制权状态核对失败');
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).not.toContainText('已人工接管');
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  f.offline(false);
  await status.getByRole('button', { name: '检查状态', exact: true }).click();
  await f.expectSuccess('manual');
  f.engineering(true); f.push();
  await expect(status).toContainText('交还前请处理以下工程活动');
  await expect(status.getByLabel('LOOP 工程阻塞活动')).toContainText('空闲 Shell 仍占用');
  await expect(status).not.toContainText('已人工接管');
  f.engineering(false); f.push();
  await f.expectSuccess('manual');
  expect(f.writes).toHaveLength(1);
});

for (const result of ['failed', 'blocked'] as const) test(`${result} handoff retains actionable feedback`, async ({ page }) => {
  const f = await fixture(page);
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.failOperation(result);
  const status = f.pane.getByTestId('loop-control-status');
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toContainText('QA 条件已变化');
  await expect(status.getByRole('button', { name: '重新申请', exact: true })).toBeVisible();
  await expect(f.pane.locator('.awu-loop')).toBeVisible();
  await expect(f.pane.locator('.chat-textarea')).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
});

test('consecutive takeover release and takeover keep each new request busy until its own receipt', async ({ page }) => {
  const f = await fixture(page);
  const status = f.pane.getByTestId('loop-control-status');
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.complete();
  await f.expectSuccess('manual');
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Manual LOOP 人工接管中', exact: true });
  await menu.click();
  const release = page.getByRole('button', { name: /交还 LOOP.*封存人工轮/ });
  await release.click();
  await expect.poll(() => f.writes.length).toBe(2);
  await expect(status).toContainText('正在申请交还 LOOP');
  const pendingRelease = page.getByRole('dialog', { name: 'Manual LOOP 控制' }).getByRole('button', { name: /交还/ });
  await expect(pendingRelease).toBeDisabled();
  await pendingRelease.evaluate(element => (element as HTMLButtonElement).click());
  expect(f.writes).toHaveLength(2);
  await menu.click();
  await page.waitForTimeout(250); // 让上一笔已加载聊天的 effect 有机会运行。
  await expect(status).toContainText('正在申请交还 LOOP');
  f.complete();
  await f.expectSuccess('loop');
  const takeover = f.pane.getByRole('button', { name: '✋ 人工接管', exact: true });
  await f.pane.getByText('更多操作', { exact: true }).click();
  await takeover.click();
  await expect.poll(() => f.writes.length).toBe(3);
  await page.waitForTimeout(250);
  await expect(status).toContainText('正在申请人工接管');
  await expect(takeover).toBeDisabled();
  await expect(f.pane.locator('.chat-textarea')).toHaveCount(0);
  f.complete();
  await f.expectSuccess('manual');
  expect(new Set(f.writes.map(input => input.requestId)).size).toBe(3);
});

test('release timeout after successful takeover reconciles without losing the active request', async ({ page }) => {
  const f = await fixture(page);
  const status = f.pane.getByTestId('loop-control-status');
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.complete();
  await f.expectSuccess('manual');
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Manual LOOP 人工接管中', exact: true });
  await menu.click();
  await page.getByRole('button', { name: /交还 LOOP.*封存人工轮/ }).click();
  await expect.poll(() => f.writes.length).toBe(2);
  await menu.click();
  f.offline(true);
  await expect(status).toContainText('正在申请交还 LOOP');
  await expect(status).toContainText('转交结果待确认', { timeout: 15000 });
  await expect(status.getByRole('button', { name: '检查状态', exact: true })).toBeEnabled();
  f.complete(false, false); f.offline(false);
  await status.getByRole('button', { name: '检查状态', exact: true }).click();
  await f.expectSuccess('loop');
  expect(f.writes).toHaveLength(2);
});

test('committed takeover with failed view retries reads only', async ({ page }) => {
  const f = await fixture(page);
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.failChat(true); f.complete();
  const status = f.pane.getByTestId('loop-control-status');
  await expect(status).toContainText('切换已完成，界面加载失败');
  f.failChat(false);
  await status.getByRole('button', { name: '重试加载聊天', exact: true }).click();
  await f.expectSuccess('manual');
  expect(f.writes).toHaveLength(1);
});

test('disabled reasons are visible in workbench secondary actions', async ({ page }) => {
  const f = await fixture(page);
  await expect(f.pane.getByRole('button', { name: '✋ 人工接管', exact: true })).toBeEnabled();
  for (const view of ['任务设置', '任务设置']) {
    await f.pane.getByRole('button', { name: view, exact: true }).click();
    for (const message of ['LOOP 正在运行，请等待当前轮结束', '存在未完成的 LOOP，请先处理断点', '旧调用或环境检查尚未退出']) {
      f.block(message);
      await expect(f.pane.getByText(`人工接管：${message}`, { exact: true })).toBeVisible();
      await expect(f.pane.getByRole('button', { name: '✋ 人工接管', exact: true })).toBeDisabled();
    }
  }
  expect(f.writes).toHaveLength(0);
});

test('lost response and offline query recover by checking without another write', async ({ page }) => {
  const f = await fixture(page);
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.offline(true); await f.disconnect();
  const status = f.pane.getByTestId('loop-control-status');
  await expect(status).toContainText('转交结果待确认', { timeout: 15000 });
  await expect(status.getByRole('button', { name: '检查状态', exact: true })).toBeEnabled({ timeout: 15000 });
  await expect(f.pane.locator('.chat-textarea')).toHaveCount(0);
  f.complete(false, false); f.offline(false);
  await status.getByRole('button', { name: '检查状态', exact: true }).click();
  await f.expectSuccess('manual');
  expect(f.writes).toHaveLength(1);
});

test('late result updates original session without stealing another tab', async ({ page }) => {
  const f = await fixture(page);
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const current = page.locator('[data-session-tab-panel]:visible');
  const selected = await current.getAttribute('data-session-tab-panel');
  f.complete();
  await expect(current).toHaveAttribute('data-session-tab-panel', selected!);
  await expect(current.getByTestId('loop-control-status')).toHaveCount(0);
  await page.getByRole('tab', { name: title, exact: true }).click();
  await f.expectSuccess('manual');
  expect(f.writes).toHaveLength(1);
});

test('loopout manual entry preserves edited goal and waits for ownership', async ({ page }) => {
  const f = await fixture(page);
  await expect(f.pane.getByRole('button', { name: '✋ 人工接管', exact: true })).toBeEnabled();
  f.loopout();

  await f.pane.getByPlaceholder('新一轮目标（支持 @ 文件/SESSION；默认沿用上一轮，可修改或追加）').fill('QA 新人工轮目标');
  await f.pane.getByRole('button', { name: /开启人工轮（第/ }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].goal).toBe('QA 新人工轮目标');
  await expect(f.pane.locator('.chat-textarea')).toHaveCount(0);
  f.complete();
  await f.expectSuccess('manual');
});

test('release view failure only reloads LOOP and does not resubmit', async ({ page }) => {
  const f = await fixture(page, 'manual');
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  await page.getByRole('button', { name: 'Manual LOOP 人工接管中', exact: true }).click();
  await page.getByRole('button', { name: /交还 LOOP.*封存人工轮/ }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.failLoop(true); f.complete();
  const status = f.pane.getByTestId('loop-control-status');
  await expect(status).toContainText('切换已完成，界面加载失败');
  f.failLoop(false);
  await status.getByRole('button', { name: '重试加载LOOP 面板', exact: true }).click();
  await f.expectSuccess('loop');
  expect(f.writes).toHaveLength(1);
});

test('legacy executor explains limited phases and verifies final ownership', async ({ page }) => {
  const f = await fixture(page, 'loop', true);
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  const status = f.pane.getByTestId('loop-control-status');
  await expect(status).toContainText('旧执行端不支持阶段详情');
  f.complete(false, true);
  await f.expectSuccess('manual');
  expect(f.writes).toHaveLength(1);
});

test('manual blockers offer navigation without stopping or clearing tasks', async ({ page }) => {
  const f = await fixture(page, 'manual');
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  f.block('回答仍在生成，结束后才能转交控制权。', 'release', 'chat');
  const menu = page.getByRole('button', { name: 'Manual LOOP 人工接管中', exact: true });
  await menu.click();
  await expect(page.getByRole('dialog', { name: 'Manual LOOP 控制' })).toContainText('回答仍在生成');
  await page.getByRole('button', { name: '返回聊天', exact: true }).click();
  f.block('仍有待发送的序列任务，请先查看并处理队列。', 'release', 'queue');
  await menu.click();
  await expect(page.getByRole('dialog', { name: 'Manual LOOP 控制' })).toContainText('待发送的序列任务');
  await page.getByRole('button', { name: '查看队列', exact: true }).click();
  await expect(f.pane.getByText('QA 待处理的序列任务', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(0);
});

test('reload recovers committed ownership despite stale session mirror and lost completion', async ({ page }) => {
  const f = await fixture(page);
  await f.pane.getByRole('button', { name: '✋ 人工接管', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  f.staleMirror(); f.complete(false, false);
  await page.reload();
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(title, { exact: true }).click();
  await expect(f.pane.locator('.chat-textarea')).toBeVisible();
  await f.expectSuccess('manual');
  expect(f.writes).toHaveLength(1);
});
