import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, capability: string) {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>` });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async capability => {
    const { React, createRoot, WorkspaceKitsPanel, api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
    const local = capability === 'node.update_local_build';
    const artifact = { id: 'msi', fileName: 'fixture.msi', platform: 'windows', arch: 'x86_64', kind: 'msi', size: 128,
      sha256: 'a'.repeat(64), url: local ? 'C:/fixture/project/dist/fixture.msi' : 'https://fixture.invalid/fixture.msi' };
    const plan: any = { device: 'fixture-executor', instanceId: 'fixture-installed', channel: local ? 'local' : 'stable',
      sourceKind: local ? 'local_build' : 'configured', sourcePath: local ? 'C:/fixture/project' : '',
      release: { version: '2.0.0', buildId: 'new-build', sequence: 2 }, artifacts: [artifact], warnings: [] };
    const runtime = { phase: 'needs_selection', planId: 'plan', planFingerprint: 'selection-fingerprint', plan, message: '' };
    const step: any = { id: 'install', title: '安装并验收', type: 'awu_capability', target: 'executor', status: 'waiting_approval',
      config: { capability, capabilityRuntime: runtime } };
    const kit: any = { id: 'kit', title: '本机更新测试', enabled: true, steps: [step], inputs: [], outputs: [], assertions: [],
      description: '', objective: '本机打包直接更新', successCriteria: '', safetyConstraints: '', references: [],
      command: '', shell: 'powershell', cwd: '.', timeoutSeconds: 300, generationWarnings: [], view: { default: 'summary', showLogs: true },
      lastRunId: 'run', versions: [], dependencies: [], currentVersion: '1', controlMode: 'shared', schedule: { mode: 'manual' }, executionTarget: 'executor' };
    const run: any = { id: 'run', kitId: 'kit', status: 'waiting_approval', currentStep: 0, steps: [step], assertions: [], artifactIds: [], startedAt: 1 };
    const state = { status: 'ok', sessionId: 'fixture', kits: [kit], runs: [run], artifacts: [], dataMarket: [], terminalConnectedKitIds: [] };
    const f = { calls: [] as any[], push: () => {}, runtime, run, step };
    let update = (_state: any) => {};
    f.push = () => update(structuredClone(state));
    api.kitGetState = async () => structuredClone(state) as any;
    api.kitGenerationGet = async () => ({ status: 'ok', job: null });
    api.onKitUpdated = callback => { update = callback; return () => {}; };
    api.kitUpdateSelect = async (...args: any[]) => {
      f.calls.push(['select', ...args]); runtime.phase = 'waiting_approval'; runtime.planFingerprint = 'install-fingerprint';
      plan.artifact = artifact; plan.current = { version: '1.0.0', buildId: 'old-build' };
      plan.desktop = { deviceId: 'fixture-executor', instanceId: 'fixture-installed' };
      f.push(); return { status: 'accepted' };
    };
    api.kitCapabilityRespond = async (...args: any[]) => {
      f.calls.push(['confirm', ...args]);
      if (args[3]) {
        if (f.calls.filter(c => c[0] === 'confirm').length === 1) return { status: 'error', message: '聊天仍在运行' };
        runtime.phase = run.status = step.status = 'waiting_restart';
      } else runtime.phase = run.status = step.status = 'cancelled';
      f.push(); return { status: 'ok', run: structuredClone(run) };
    };
    api.kitUpdateReconcile = async (...args: any[]) => {
      f.calls.push(['reconcile', ...args]); runtime.phase = run.status = step.status = 'result_unknown';
      runtime.message = '没有收到实际启动验收，没有重新安装'; f.push(); return { status: 'ok' };
    };
    (window as any).updateFixture = f;
    createRoot(document.getElementById('root')!).render(React.createElement(WorkspaceKitsPanel, {
      sessionId: 'fixture', open: true, onClose: () => {}, targetRunId: 'run', targetStepId: 'install' }));
  }, capability);
}

test('local install editor does not expose publication parameters', async ({ page }) => {
  await mount(page, 'node.update_local_build');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByText('高级实现 · Shell、命令与机器判言', { exact: true }).click();
  await expect(page.getByText('使用本次构建登记的本地安装包；可在严格绑定发布后直装，不重新下载。点击运行时确认本次安装与重启。', { exact: true })).toBeVisible();
  await expect(page.getByText('发布通道', { exact: true })).toHaveCount(0);
  await expect(page.getByText('平台筛选（可选，逗号分隔）', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).updateFixture.calls)).toEqual([]);
});

for (const width of [1200, 360]) {
  test(`${width}px published local build keeps channel and local source through approval`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, 'node.update_local_build');
    const card = page.getByRole('region', { name: '本机更新安装计划' });
    await expect(card).toBeVisible();
    await page.evaluate(() => {
      const f = (window as any).updateFixture;
      f.runtime.plan.publishedRelease = { runId: 'run', stepId: 'publish', channel: 'stable' };
      f.runtime.plan.channel = 'stable'; f.push();
    });
    await expect(card.getByText('来源：本次本机构建 · 已发布 · 使用本地安装包', { exact: true })).toBeVisible();
    await expect(card.getByText(/通道：stable/)).toBeVisible();
    await expect(card.getByText(/未上传|未发布/)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).updateFixture.calls)).toEqual([]);
    await card.getByRole('button', { name: /选择 fixture.msi/ }).click();
    await expect(card.getByText('本地安装包：C:/fixture/project/dist/fixture.msi', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '确认安装并重启目标节点' })).toBeVisible();
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  for (const capability of ['node.update_local_build', 'node.update_local_published', 'node.check_update_local']) {
    test(`${width}px ${capability}: selection, independent approval and read-only recovery`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, capability);
      const card = page.getByRole('region', { name: '本机更新安装计划' });
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: /确认安装/ })).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).updateFixture.calls)).toEqual([]);
      if (capability === 'node.update_local_build') {
        await expect(card.getByText('来源：本次本机构建 · 未上传', { exact: true })).toBeVisible();
        await expect(card.getByText('构建目录：C:/fixture/project', { exact: true })).toBeVisible();
      } else await expect(card.getByText('来源：本次本机构建 · 未上传', { exact: true })).toHaveCount(0);
      await card.getByRole('button', { name: /选择 fixture.msi/ }).click();
      await expect(card.getByText('SHA-256：' + 'a'.repeat(64), { exact: true })).toBeVisible();
      if (capability === 'node.update_local_build') {
        await expect(card.getByText('本地安装包：C:/fixture/project/dist/fixture.msi', { exact: true })).toBeVisible();
        await expect(card.getByText('选择已提交，等待执行端复制并校验本地安装包', { exact: true })).toHaveCount(0);
      }
      const dialogs: string[] = [];
      page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
      await card.getByRole('button', { name: '确认安装并重启目标节点' }).click();
      await expect(page.getByText('聊天仍在运行', { exact: true })).toBeVisible();
      await card.getByRole('button', { name: '确认安装并重启目标节点' }).click();
      await expect(card.getByRole('button', { name: '只读核对原安装结果' })).toBeVisible();
      const confirms = await page.evaluate(() => (window as any).updateFixture.calls.filter((c: any[]) => c[0] === 'confirm'));
      expect(confirms).toHaveLength(2);
      expect(confirms[0].slice(1, 6)).toEqual(['fixture', 'run', 'install', true, 'install-fingerprint']);
      expect(confirms[0][6]).toBeTruthy();
      expect(confirms[1][6]).toBe(confirms[0][6]);
      expect(dialogs.every(s => s.includes('安装计划中的版本') && !s.includes('正式发布'))).toBe(true);
      await card.getByRole('button', { name: '只读核对原安装结果' }).click();
      await expect(card.getByText('没有收到实际启动验收，没有重新安装', { exact: true })).toBeVisible();
      if (capability === 'node.update_local_build') {
        await page.screenshot({ path: testInfo.outputPath('local-build-update.png'), fullPage: true });
        expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
    });
  }

  test(`${width}px local build staging and cancellation keep source labels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, 'node.update_local_build');
    const card = page.getByRole('region', { name: '本机更新安装计划' });
    await expect(card).toBeVisible();
    await page.evaluate(() => { const f = (window as any).updateFixture; f.runtime.phase = 'staging'; f.push(); });
    await expect(card.getByText('本机更新 · 复制并校验本地安装包', { exact: true })).toBeVisible();
    await page.evaluate(() => { const f = (window as any).updateFixture; f.runtime.phase = 'waiting_approval'; f.push(); });
    await card.getByRole('button', { name: '取消本次安装' }).click();
    await expect(page.getByText('已取消本次安装，原制品保留', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).updateFixture.calls[0].slice(0, 5))).toEqual(['confirm', 'fixture', 'run', 'install', false]);
  });
}

for (const acknowledgement of ['before-failure', 'after-failure']) {
  test(`selection acknowledgement ${acknowledgement} never survives failed preparation`, async ({ page }) => {
    await mount(page, 'node.update_local_build');
    const card = page.getByRole('region', { name: '本机更新安装计划' });
    await page.evaluate(async () => {
      const { api } = await import('/tests/engine/chat-kit-feedback-harness.ts');
      const f = (window as any).updateFixture;
      api.kitUpdateSelect = async (...args: any[]) => {
        f.calls.push(['select', ...args]);
        f.runtime.phase = 'staging'; f.push();
        return await new Promise<any>(resolve => { f.ack = () => resolve({ status: 'accepted' }); });
      };
    });
    await card.getByRole('button', { name: /选择 fixture.msi/ }).click();
    await expect(card.getByText('本机更新 · 复制并校验本地安装包', { exact: true })).toBeVisible();
    if (acknowledgement === 'before-failure') {
      await page.evaluate(() => (window as any).updateFixture.ack());
      await expect(card.getByText('选择已提交，等待执行端复制并校验本地安装包', { exact: true })).toBeVisible();
    }
    await page.evaluate(() => {
      const f = (window as any).updateFixture;
      f.runtime.phase = 'failed'; f.run.status = f.step.status = 'error';
      f.runtime.message = '活动记录损坏或不可读；不能确认节点空闲'; f.push();
    });
    await expect(card.getByText('本机更新 · 本机更新失败', { exact: true })).toBeVisible();
    if (acknowledgement === 'after-failure') await page.evaluate(() => (window as any).updateFixture.ack());
    await expect(card.getByText(/选择已提交/)).toHaveCount(0);
    await expect(card.getByText('活动记录损坏或不可读；不能确认节点空闲', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: /确认安装/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).updateFixture.calls.map((c: any[]) => c[0]))).toEqual(['select']);
  });
}
