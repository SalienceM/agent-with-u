import { test, expect } from '@playwright/test';

const profile = { userId: 'workspace-qa', username: 'workspace-qa', displayName: 'Workspace QA', managed: false };
const target = (deviceId: string) => ({ mode: 'relay', url: 'ws://127.0.0.1:45421/workspace-qa',
  token: 'qa-fixture-not-a-credential', deviceId, deviceName: deviceId, user: profile });
const homeId = 'relay:workspace-qa:home';
const homeSession = { id: 'workspace-created', title: '拆分的需求', workingDir: '/home/workspaces/requirements',
  backendId: 'home-model', createdAt: 1, updatedAt: 1, sessionType: 'normal', messages: [], ownerId: profile.userId };

test('chat discovers a non-roster node, routes template/plan precisely, confirms one batch and opens the resulting Session', async ({ page }, testInfo) => {
  await page.addInitScript(value => localStorage.setItem('awu.connectionTarget', JSON.stringify(value)), target('work_1'));
  const calls: Array<{ node: string; method: string; params: any[] }> = [];
  const errors: string[] = [];
  const replies: Record<string, any> = {};
  page.on('pageerror', error => errors.push(error.message));
  let turn: any;
  let originSocket: any;
  let committed = false;
  const plan = { action: 'create_session', session: homeSession, totalBytes: 24, policy: '仅新增，不覆盖',
    files: [{ path: 'requirements/01.md', bytes: 12, sha256: 'a'.repeat(64) },
            { path: 'requirements/02.md', bytes: 12, sha256: 'b'.repeat(64) }] };
  const emitRequest = (id: string, phase: string, args: any) => originSocket.send(JSON.stringify({
    event: 'workspaceToolRequest', data: { id, phase, sessionId: turn.sessionId, arguments: args },
  }));

  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    let node = 'work_1';
    const reply = (frame: any, result: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.t === 'hello') {
        node = frame.deviceId;
        socket.send(JSON.stringify({ t: 'ready', profile }));
        return;
      }
      if (frame.t === 'list') {
        socket.send(JSON.stringify({ t: 'devices', profile, devices: [{ id: 'work_1', name: 'work_1' }, { id: 'home', name: 'home' }] }));
        return;
      }
      if (frame.method === 'sendMessage') {
        turn = JSON.parse(frame.params[0]);
        expect(turn.workspaceToolsVersion).toBe(1);
        originSocket = socket;
        emitRequest('nodes', 'query', { action: 'nodes' });
        return;
      }
      if (frame.method?.startsWith('workspace')) calls.push({ node, method: frame.method, params: frame.params });
      if (frame.method === 'workspaceToolReply') {
        const [id, raw] = frame.params;
        replies[id] = JSON.parse(raw);
        reply(frame, true);
        if (id === 'nodes') emitRequest('template', 'query', { action: 'read_file', node: 'home', session: '规范', path: 'template.md' });
        if (id === 'template') emitRequest('plan', 'prepare', { action: 'create_session', node: 'home', requestId: 'split-qa',
          title: '拆分的需求', files: [{ path: 'requirements/01.md', text: '# 需求一' }, { path: 'requirements/02.md', text: '# 需求二' }] });
        if (id === 'plan') originSocket.send(JSON.stringify({ event: 'permissionRequest', data: JSON.stringify({
          sessionId: turn.sessionId, messageId: turn.messageId, requestId: 'review-qa', allowSkip: false,
          tools: [{ id: 'plan-review', name: 'awu_workspace', status: 'pending', input: JSON.stringify({ ...plan, node: replies.plan.node }) }],
        }) }));
        if (id === 'commit') {
          for (const type of ['text_delta', 'done']) originSocket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
            sessionId: turn.sessionId, messageId: turn.messageId, type,
            text: type === 'text_delta' ? `已创建并校验两个需求文件。[打开拆分的需求](${replies.commit.sessionLink})` : '',
          }) }));
        }
        return;
      }
      if (frame.method === 'workspaceQuery') {
        const args = JSON.parse(frame.params[0]);
        expect(node).toBe('home'); expect(args.node).toBe(homeId);
        return reply(frame, { status: 'ok', text: '# 需求\n## 验收标准', sha256: 'c'.repeat(64), nextOffset: null });
      }
      if (frame.method === 'workspacePrepare') {
        expect(node).toBe('home'); expect(JSON.parse(frame.params[1]).node).toBe(homeId);
        return reply(frame, { status: 'prepared', plan, fingerprint: 'frozen-qa', requestId: 'split-qa' });
      }
      if (frame.method === 'grantPermission') {
        expect(frame.params).toEqual([turn.sessionId, true, false, 'review-qa']);
        emitRequest('commit', 'commit', { node: homeId, requestId: 'split-qa', fingerprint: 'frozen-qa' });
        return reply(frame, null);
      }
      if (frame.method === 'workspaceCommit') {
        expect(node).toBe('home'); expect(frame.params).toEqual([`session:${turn.sessionId}`, 'split-qa', 'frozen-qa']);
        committed = true;
        socket.send(JSON.stringify({ event: 'sessionUpdated', data: JSON.stringify({ type: 'session_created', sessionId: homeSession.id, summary: homeSession }) }));
        return reply(frame, { status: 'succeeded', receipt: { session: homeSession, files: plan.files, verified: true } });
      }
      if (node === 'home' && ['loadSession', 'loadSessionMeta'].includes(frame.method)) return reply(frame, homeSession);
      if (frame.method === 'seqtaskGet') return reply(frame, { status: 'ok', seqTasks: [], seqAuto: false });
      if (node === 'home' && frame.method === 'listSessions') return reply(frame, committed ? [homeSession] : []);
      server.send(message);
    });
  });

  await page.goto('/');
  const sidebar = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  const input = pane.locator('.chat-textarea');
  await input.fill('参考 home 的规范，把 work_1 的需求拆分，并在 home 新建 Session 存放');
  await input.press('Enter');
  await expect(pane.getByText('🌐 确认工作区操作', { exact: true })).toBeVisible();
  expect(replies.nodes.nodes.map((item: any) => item.name)).toEqual(expect.arrayContaining(['home', 'work_1']));
  expect(replies.template.text).toContain('验收标准');
  expect(committed).toBe(false);
  await expect(pane.getByText('/home/workspaces/requirements', { exact: false })).toBeVisible();
  await expect(pane.getByRole('button', { name: '✅ 允许并跳过后续', exact: true })).toHaveCount(0);
  await pane.getByText('requirements/01.md · 12 字节', { exact: true }).click();
  await expect(pane.getByText(`SHA-256: ${'a'.repeat(64)}`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workspace-plan-review.png'), fullPage: true });
  await pane.getByRole('button', { name: '▶ 允许一次', exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  const link = pane.getByRole('link', { name: '打开拆分的需求', exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('[data-session-tab-panel]:visible')).toHaveAttribute('data-session-tab-panel', homeSession.id);
  expect(calls.filter(item => item.method === 'workspaceCommit')).toHaveLength(1);
  expect(calls.filter(item => item.method === 'workspacePrepare')).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('awu.execRoster') || '[]').map((item: any) => item.deviceId))).toContain('home');
  expect(errors).toEqual([]);
});

test('current Session confirmation offers skip-rest, but the next cross-Session plan still requires its own click', async ({ page }, testInfo) => {
  const grants: any[][] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let turn: any;
  let originSocket: any;
  const emitPermission = (cross: boolean) => originSocket.send(JSON.stringify({ event: 'permissionRequest', data: JSON.stringify({
    sessionId: turn.sessionId, messageId: turn.messageId, requestId: cross ? 'cross-review' : 'current-review', allowSkip: !cross,
    tools: [{ id: cross ? 'cross-tool' : 'current-tool', name: 'awu_workspace', status: 'pending', input: JSON.stringify({
      action: 'write_files', node: { id: 'local', name: '本机', isCurrent: true },
      session: { id: cross ? 'another-session' : turn.sessionId, title: cross ? '另一个 Session' : '当前会话',
        workingDir: cross ? '/work/another' : '/work/current', backendId: 'qa' },
      totalBytes: 12, files: [{ path: 'requirement.md', bytes: 12, sha256: 'a'.repeat(64) }],
    }) }],
  }) }));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    const reply = (frame: any, result: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'sendMessage') {
        turn = JSON.parse(frame.params[0]);
        expect(turn.skipPermissions).toBe(false);
        originSocket = socket;
        emitPermission(false);
        return;
      }
      if (frame.method === 'grantPermission') {
        grants.push(frame.params);
        reply(frame, null);
        socket.send(JSON.stringify({ event: 'permissionRequest', data: JSON.stringify({
          sessionId: turn.sessionId, messageId: turn.messageId, requestId: frame.params[3], resolved: true, tools: [],
        }) }));
        if (grants.length === 2) {
          for (const type of ['text_delta', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
            sessionId: turn.sessionId, messageId: turn.messageId, type, text: type === 'text_delta' ? '确认边界测试完成' : '',
          }) }));
        }
        return;
      }
      if (frame.method === 'seqtaskGet') return reply(frame, { status: 'ok', seqTasks: [], seqAuto: false });
      server.send(message);
    });
  });
  await page.goto('/');
  const sidebar = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  const toggle = pane.getByRole('button', { name: '跳过确认', exact: true });
  if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await pane.locator('.chat-textarea').fill('先在当前 Session 新增需求，再写入另一个 Session');
  await pane.locator('.chat-textarea').press('Enter');
  await expect(pane.getByText('📝 确认当前 Session 写入', { exact: true })).toBeVisible();
  const skip = pane.getByRole('button', { name: '✅ 允许并跳过后续', exact: true });
  await expect(skip).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('current-session-confirmation.png'), fullPage: true });
  await skip.click();
  await expect.poll(() => grants.length).toBe(1);
  expect(grants[0]).toEqual([turn.sessionId, true, true, 'current-review']);
  await expect(pane.getByText('📝 确认当前 Session 写入', { exact: true })).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  emitPermission(true);
  await expect(pane.getByText('🌐 确认工作区操作', { exact: true })).toBeVisible();
  await expect(skip).toHaveCount(0);
  expect(grants).toHaveLength(1);
  await pane.getByRole('button', { name: '▶ 允许一次', exact: true }).click();
  await expect(pane.getByText('确认边界测试完成', { exact: true })).toBeVisible();
  expect(grants[1]).toEqual([turn.sessionId, true, false, 'cross-review']);
  expect(errors).toEqual([]);
});
