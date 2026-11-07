import { test, expect, type Page } from '@playwright/test';

async function mount(page: Page, restored = false) {
  await page.routeWebSocket(/.*/, socket => socket.close());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script>window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>' });
    if (url.pathname === '/src/api.ts') return route.fulfill({ contentType: 'application/javascript', body: `
      const node = { key: 'fixture', label: '测试节点', connected: true, isHome: true };
      const state = { phase: '${restored ? 'downloading' : 'error'}', busy: ${restored}, updateProtocol: 2,
        stageRequestId: '${restored ? 'restored-stage' : ''}', current: { version: '1' }, release: { version: '2' },
        config: { manifestUrl: 'https://fixture.invalid/manifest', channel: 'stable' },
        platform: 'windows', arch: 'x86_64', desktop: true, artifact: { id: 'fixture' }, selectionFingerprint: 'frozen' };
      const f = window.updateFixture = { state, stages: [], applies: [], checks: 0, polls: 0, fails: 0, configure: 0 };
      export const getExecutors = () => [node];
      export const onExecStatus = () => () => {};
      export const api = {
        nodeUpdateStatus: async () => {
          if (f.fails > 0) { f.fails--; throw Error('simulated connection loss'); }
          if (state.phase === 'downloading' && ++f.polls >= 3) Object.assign(state, { phase: 'staged', busy: false });
          return { ...state };
        },
        nodeUpdateConfigure: async () => { f.configure++; return {status:'ok'}; },
        nodeUpdateCheck: async () => { f.checks++; Object.assign(state, {phase:'available', available:true, busy:false}); return {...state}; },
        nodeUpdateStage: async (...args) => {
          f.stages.push(args); Object.assign(state, {phase:'downloading', busy:true, stageRequestId:args[4]});
          f.fails = 2; throw Error('lost stage reply');
        },
        nodeUpdateApply: async (...args) => {
          f.applies.push(args); Object.assign(state, {phase:'installing', busy:true, applyRequestId:args[1]});
          f.fails = 1; throw Error('lost apply reply');
        },
        nodeUpdateCancel: async () => { Object.assign(state, {phase:'cancelled', busy:false}); return {...state}; },
      };
    ` });
    return route.continue();
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { UpdateCenter } = await import('/src/components/UpdateCenter.tsx');
    createRoot(document.getElementById('root')!).render(React.createElement(UpdateCenter));
  });
  await expect(page.getByText('测试节点', { exact: true })).toBeVisible();
}

test('double click and lost stage/apply replies submit one of each, with frozen identity', async ({ page }) => {
  await mount(page);
  const update = page.getByRole('button', { name: '继续 / 重新更新', exact: true });
  await expect(update).toBeEnabled();
  await update.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByText('安装/重启中', { exact: false })).toBeVisible({ timeout: 15000 });
  const calls = await page.evaluate(() => (window as any).updateFixture);
  expect(calls.stages).toHaveLength(1);
  expect(calls.applies).toHaveLength(1);
  expect(calls.stages[0][4]).toMatch(/^[a-f0-9]{32}$/);
  expect(calls.stages[0][5]).toBe('frozen');
  expect(calls.applies[0][2]).toBe(calls.stages[0][4]);
});

test('reopened panel continues existing download without another submission', async ({ page }) => {
  await mount(page, true);
  await page.getByRole('button', { name: '继续跟进更新', exact: true }).click();
  await expect(page.getByText('安装/重启中', { exact: false })).toBeVisible({ timeout: 10000 });
  const calls = await page.evaluate(() => (window as any).updateFixture);
  expect(calls.stages).toHaveLength(0);
  expect(calls.checks).toBe(0);
  expect(calls.applies).toHaveLength(1);
  expect(calls.applies[0][2]).toBe('restored-stage');
});
