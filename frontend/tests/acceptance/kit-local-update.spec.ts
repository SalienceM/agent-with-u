import { test, expect } from '@playwright/test';

test('local update separates selection, frozen install confirmation and read-only recovery', async ({ page }, testInfo) => {
  const writes: any[] = [];
  let sid = '';
  let holdConfirmation = false;
  const artifact = { id: 'msi-a', fileName: 'fixture-a.msi', platform: 'windows', arch: 'x86_64', kind: 'msi', size: 128, sha256: 'a'.repeat(64) };
  const plan: any = { device: '执行设备 A', instanceId: 'installed-A', channel: 'stable',
    release: { version: '99.1.1', buildId: 'full-build-A', sequence: 999 }, artifacts: [artifact, { ...artifact, id: 'msi-b', fileName: 'fixture-b.msi' }], warnings: ['安装会退出目标节点；交接后无法保证撤回'] };
  const runtime: any = { phase: 'needs_selection', planId: 'install-plan', planFingerprint: 'selection-fingerprint', plan };
  const run: any = { id: 'update-run', kitId: 'combined-kit', status: 'waiting_approval', verdict: '', trigger: 'manual', owner: 'human', inputs: {}, currentStep: 1,
    artifactIds: [], assertions: [], assertionResults: [], stdout: '', stderr: '', error: '', createdAt: 1, startedAt: 1,
    steps: [{ id: 'publish', type: 'awu_capability', target: 'executor', title: '已成功发布', status: 'succeeded', stdout: '', stderr: '', error: '', config: { capability: 'release.publish_latest', capabilityRuntime: { phase: 'succeeded' } } },
      { id: 'install', type: 'awu_capability', target: 'executor', title: '安装并验收', status: 'waiting_approval', stdout: '', stderr: '', error: '', config: { capability: 'node.update_local_published', capabilityRuntime: runtime } }] };
  const kit = { id: 'combined-kit', title: '打包发布本机更新测试', description: '', objective: '', successCriteria: '', safetyConstraints: '', references: [],
    inputs: [], outputs: [], dependencies: [], assertions: [], steps: [], command: '', shell: 'powershell', cwd: '.', timeoutSeconds: 300,
    executionTarget: 'executor', enabled: true, controlMode: 'shared', lastRunId: run.id, versions: [], activeVersionId: '',
    schedule: { mode: 'manual' }, view: { default: 'summary', showLogs: true, showData: true, showTerminal: false } };
  let push: () => void = () => {};
  const payload = () => ({ sessionId: sid, kits: [kit], runs: [{ ...run, sessionId: sid }], artifacts: [], dataMarket: [] });
  await page.routeWebSocket(/.*/, socket => {
    // 账号/节点切换只使用拦截的假连接，不访问其他执行器。
    if (socket.url().includes(':45423')) { socket.onMessage(() => {}); return; }
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any; try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      const reply = (value: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(value) }));
      push = () => socket.send(JSON.stringify({ event: 'kitUpdated', data: JSON.stringify(payload()) }));
      if (frame.method === 'kitGetState') { sid = frame.params[0]; reply({ status: 'ok', ...payload() }); }
      else if (frame.method === 'kitUpdateSelect') {
        writes.push(frame); reply({ status: 'accepted' });
        runtime.phase = 'waiting_approval'; runtime.planFingerprint = 'install-fingerprint';
        plan.artifact = artifact; plan.desktop = { deviceId: '执行设备 A', instanceId: 'installed-A' }; plan.current = { version: '1', buildId: 'old-build' };
        plan.preflight = ['聊天仍在运行']; push();
      } else if (frame.method === 'kitCapabilityRespond') {
        writes.push(frame);
        if (holdConfirmation) return;
        const attempts = writes.filter(item => item.method === frame.method).length;
        if (attempts === 1) reply({ status: 'error', message: '任务仍在运行，请结束后重新确认' });
        else if (attempts === 2) {
          runtime.planFingerprint = 'new-fingerprint';
          reply({ status: 'error', message: '安装计划已过期，请核对新计划' }); push();
        } else if (attempts === 3) reply({ status: 'error', message: '当前用户无设备管理权限' });
        else { runtime.phase = run.status = run.steps[1].status = 'waiting_restart'; reply({ status: 'ok', run }); push(); }
      } else if (frame.method === 'kitUpdateReconcile') {
        writes.push(frame); runtime.phase = run.status = run.steps[1].status = 'result_unknown';
        runtime.message = '启动验收超时，没有重新安装'; reply({ status: 'ok' }); push();
      } else if (/^(kitRun|kitCancel|kitResume|sendMessage)$/.test(frame.method)) {
        writes.push(frame); reply({ status: 'error', message: 'Forbidden in isolated test' });
      } else server.send(message);
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  await page.getByTitle('Workspace Kits · Session 标准配件（实验）').click();
  const panel = page.locator('.awu-kits-panel');
  await panel.getByRole('button', { name: '详情', exact: true }).click();
  const card = panel.getByRole('region', { name: '本机更新安装计划' });
  await expect(card.getByRole('button', { name: /确认安装/ })).toHaveCount(0);
  await card.getByRole('button', { name: /选择 fixture-a/ }).click();
  await expect(card.getByText('SHA-256：' + 'a'.repeat(64), { exact: true })).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: '确认安装并重启目标节点' }).click();
  await expect(panel.getByText('任务仍在运行，请结束后重新确认', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '确认安装并重启目标节点' }).click();
  await expect(panel.getByText('安装计划已过期，请核对新计划', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '确认安装并重启目标节点' }).click();
  await expect(panel.getByText('当前用户无设备管理权限', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '确认安装并重启目标节点' }).click();
  await expect(card.getByRole('button', { name: '只读核对原安装结果' })).toBeVisible();
  const confirms = writes.filter(item => item.method === 'kitCapabilityRespond');
  expect(confirms).toHaveLength(4);
  expect(confirms[0].params[4]).toBe('install-fingerprint');
  expect(confirms[0].params[5]).toBeTruthy();
  expect(confirms[1].params[5]).toBe(confirms[0].params[5]);
  expect(confirms[2].params[4]).toBe('new-fingerprint');
  expect(confirms[2].params[5]).not.toBe(confirms[0].params[5]);
  expect(confirms[3].params[5]).toBe(confirms[2].params[5]);
  await card.getByRole('button', { name: '只读核对原安装结果' }).click();
  await expect(card.getByText('启动验收超时，没有重新安装', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('kit-local-update-unknown.png'), fullPage: true });
  const count = writes.length;
  await page.waitForTimeout(800);
  expect(writes).toHaveLength(count);
  expect(writes.some(item => ['kitRun', 'kitCancel', 'kitResume', 'sendMessage'].includes(item.method))).toBe(false);
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForTimeout(300);
  expect(writes).toHaveLength(count);
  await page.getByTitle('Workspace Kits · Session 标准配件（实验）').click();
  await expect(card.getByText('启动验收超时，没有重新安装', { exact: true })).toBeVisible();
  runtime.phase = run.status = run.steps[1].status = 'failed';
  runtime.message = '安装失败，发布仍然成功'; push();
  await expect(card.getByText('安装失败，发布仍然成功', { exact: true })).toBeVisible();
  await expect(panel.getByText('已成功发布', { exact: true }).first()).toBeVisible();
  // 换成另一个真实 run 后，旧卡片状态/反馈不串入。
  run.id = 'new-update-run'; kit.lastRunId = run.id;
  runtime.phase = run.status = run.steps[1].status = 'waiting_approval'; runtime.message = '新运行待确认'; push();
  await expect(card.getByText('新运行待确认', { exact: true })).toBeVisible();
  await expect(card.getByText('安装失败，发布仍然成功', { exact: true })).toHaveCount(0);
  const missingTarget = await page.evaluate(async () => {
    const path = '/src/api.ts'; const { api } = await import(/* @vite-ignore */ path);
    try { await api.kitUpdateReconcile('unknown-session', 'unknown-run'); return 'unexpected'; }
    catch (error) { return String(error); }
  });
  expect(missingTarget).toContain('尚未确认 Session 执行设备');
  holdConfirmation = true;
  await card.getByRole('button', { name: '确认安装并重启目标节点' }).click();
  const beforeSwitch = writes.length;
  await page.evaluate(async () => {
    const path = '/src/api.ts'; const { setConnectionTarget } = await import(/* @vite-ignore */ path);
    await setConnectionTarget({ mode: 'relay', url: 'ws://127.0.0.1:45423', token: 'inert-test-token',
      deviceId: 'fixture-node-B', user: { userId: 'fixture-user-B', username: 'fixture-user-B', displayName: '隔离账号 B' } });
  });
  await expect(page.getByText('新运行待确认', { exact: true })).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(writes).toHaveLength(beforeSwitch);
});
