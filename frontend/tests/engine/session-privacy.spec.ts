import { test, expect, type Page } from '@playwright/test';
async function setup(page: Page, options: any = {}, url = '/') {
  await page.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const request = JSON.parse(String(message)); socket.send(JSON.stringify({ id: request.id, result: null }));
  }));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://127.0.0.1:55191') return route.abort();
    if (u.pathname === '/src/utils/desktopNotifications.ts') return route.fulfill({ contentType: 'application/javascript', body: "export async function notifyTaskCompletion(title) { window.privacyFixture.notifications.push(title); }" });
    if (u.pathname === '/src/components/SessionWorkbench.tsx') return route.fulfill({ contentType: 'application/javascript', body: "export { SessionWorkbench } from '/tests/engine/privacy-workbench-stub.tsx';" });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body style="margin:0"><div id="root"></div>
      <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>` });
    return route.continue();
  });
  await page.goto(url); await mount(page, options);
}
async function mount(page: Page, options: any = {}) {
  await page.waitForFunction(() => (window as any).__vite_plugin_react_preamble_installed__);
  await page.evaluate(async opts => { const source='/tests/engine/session-privacy-harness.tsx'; const { mountPrivacyFixture }=await import(/* @vite-ignore */ source); mountPrivacyFixture(opts); }, options);
  await expect(page.getByRole('tab', { name: '工作总览', exact: true })).toBeVisible();
}
async function sidebar(page: Page) {
  const opener=page.getByRole('button',{name:'打开会话列表',exact:true}); if(await opener.isVisible()) await opener.click();
  return page.locator('.awu-sidebar');
}
async function show(page: Page) { await (await sidebar(page)).getByRole('switch',{name:'显示私密 Session'}).click(); }
async function select(page: Page, name: string) { await (await sidebar(page)).getByText(name,{exact:true}).click(); }

test('sidebar collapse persists through rename and refresh; same-name nodes stay separate', async ({page}) => {
  await setup(page); const side=await sidebar(page);
  const buttons=side.locator('.awu-session-group-toggle').filter({hasText:'同名节点'});
  await expect(buttons).toHaveCount(2); await buttons.first().click();
  await expect(buttons.first()).toHaveAttribute('aria-expanded','false'); await expect(buttons.nth(1)).toHaveAttribute('aria-expanded','true');
  await page.evaluate(()=>{const f=(window as any).privacyFixture; f.rows.filter((r:any)=>r.execKey==='node-b').forEach((r:any)=>r.execLabel='已改名'); f.publish();});
  await expect(side.locator('.awu-session-group-toggle').filter({hasText:'已改名'})).toHaveAttribute('aria-expanded','false');
  await page.evaluate(() => {
    const f=(window as any).privacyFixture; f.saved=f.rows.splice(0); window.dispatchEvent(new Event('focus'));
  });
  await expect(side.locator('.awu-session-group-toggle')).toHaveCount(0);
  await page.evaluate(() => { const f=(window as any).privacyFixture; f.rows.push(...f.saved); window.dispatchEvent(new Event('focus')); });
  await expect(side.locator('.awu-session-group-toggle').filter({hasText:'已改名'})).toHaveAttribute('aria-expanded','false');
  await page.reload(); await mount(page);
  await expect(page.locator('.awu-session-group-toggle').filter({hasText:'已改名'})).toHaveAttribute('aria-expanded','false');
  await expect(page.locator('.awu-session-group-toggle').filter({hasText:'同名节点'})).toHaveAttribute('aria-expanded','true');
});

test('split layout restores exact pane assignment and focus', async ({ page }) => {
  await setup(page); await select(page, '公开 A');
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('menuitem', { name: /分屏布局/ }).click();
  await page.getByRole('tab', { name: '工作总览', exact: true }).click();
  await select(page, '公开 C');
  // 使用真实导航操作保留两栏；第二个空栏点击只改变焦点。
  await page.getByRole('button', { name: '返回工作总览', exact: true }).click();
  await select(page, '公开 A');
  const before = await page.evaluate(() => (window as any).privacyFixture.snapshot());
  expect(before.layout).toBe('1x2');
  await page.reload(); await mount(page);
  expect(await page.evaluate(() => (window as any).privacyFixture.snapshot())).toEqual(before);
  expect(await page.evaluate(() => (window as any).privacyFixture.mounts.length)).toBeLessThanOrEqual(2);
});

for(const width of [1280,390]) test(`private group, favorites, search and keyboard toggle ${width}`,async({page}, info)=>{
  await page.setViewportSize({width,height:900}); await setup(page);
  const side=await sidebar(page); const toggle=side.getByRole('switch',{name:'显示私密 Session'});
  await expect(side.getByText('私密标题 X',{exact:true})).toHaveCount(0); await expect(side.getByText('公开子项',{exact:true})).toBeVisible();
  await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).toHaveAttribute('aria-checked','true');
  await expect(side.getByText('私密标题 X',{exact:true})).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('private-group.png') });
  await side.getByText('私密标题 X',{exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'取消私密',exact:true}).click();
  await expect(side.locator('section').filter({has: page.locator('.awu-session-group-toggle').filter({hasText:'收藏'})}).getByText('私密标题 X',{exact:true})).toBeVisible();
  await side.getByText('私密标题 X',{exact:true}).click({button:'right'}); await page.getByRole('menuitem',{name:'设为私密',exact:true}).click();
  await toggle.click(); await expect(side.getByText('私密标题 X',{exact:true})).toHaveCount(0);
  const search=side.getByPlaceholder(/搜索/); await search.fill('私密标题'); await expect(side.getByText('私密标题 X',{exact:true})).toHaveCount(0);
  await search.fill('公开子项'); await expect(side.getByText('公开子项',{exact:true})).toBeVisible(); await expect(side.getByText('私密标题 X',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('App preserves hidden drafts, files and portal; reveal restores tabs without stealing focus',async({page})=>{
  await setup(page); await select(page,'公开 A'); await select(page,'公开 B'); await select(page,'公开 C');
  await page.getByRole('button',{name:'关闭公开 B',exact:true}).click();
  await show(page); await select(page,'私密标题 X');
  await page.getByLabel('文件缓冲').last().fill('未保存文件'); await page.locator('.chat-textarea:visible').fill('私密草稿');
  await page.getByRole('button',{name:'打开会话浮层'}).click(); await expect(page.getByRole('dialog',{name:'会话浮层'})).toBeVisible();
  const before=await page.evaluate(()=>(window as any).privacyFixture.snapshot().workbench.tabs);
  await show(page); await expect(page.getByRole('tab',{name:'私密标题 X',exact:true})).toHaveCount(0);
  await expect(page.getByRole('dialog',{name:'会话浮层'})).not.toBeVisible(); await expect(page.getByText('/secret/path',{exact:true})).not.toBeVisible();
  expect(await page.evaluate(()=>(window as any).privacyFixture.snapshot().workbench.tabs)).toEqual(before);
  await select(page,'公开 A'); await show(page); await expect(page.getByRole('tab',{name:'公开 A',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('tab',{name:'私密标题 X',exact:true}).click();
  await expect(page.locator('.chat-textarea:visible')).toHaveValue('私密草稿'); await expect(page.getByLabel('文件缓冲').last()).toHaveValue('未保存文件');
  expect(await page.evaluate(()=>(window as any).privacyFixture.unmounts)).not.toContain('secret');
  expect(await page.evaluate(()=>(window as any).privacyFixture.mutations)).toEqual([]);
  await page.reload(); await mount(page);
  await expect(page.getByRole('tab',{name:'私密标题 X',exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'公开 A',exact:true})).toBeVisible(); await expect(page.getByRole('tab',{name:'公开 C',exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:'公开 B',exact:true})).toHaveCount(0); await expect(page.getByRole('tab',{name:'未打开 D',exact:true})).toHaveCount(0);
  await page.evaluate(()=>sessionStorage.clear()); await page.reload(); await mount(page); await show(page);
  expect(await page.evaluate(()=>(window as any).privacyFixture.snapshot().workbench.tabs)).toEqual(before);
});

test('cold private and unknown targets stay neutral; refs disappear immediately when hidden',async({page})=>{
  await setup(page,{seed:true,unknown:true}); await expect(page.getByLabel('Session 暂不可显示')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).privacyFixture.mounts)).toEqual([]);
  await page.evaluate(()=>{ const f=(window as any).privacyFixture;f.unknown=false;f.publish(); window.dispatchEvent(new Event('focus')); });
  await expect(page.getByText('此 Session 已隐藏',{exact:true})).toBeVisible(); await expect(page.getByText('/secret/path',{exact:true})).toHaveCount(0);
  await select(page,'公开 A'); await show(page); await page.locator('.chat-textarea:visible').fill('@SESSION:');
  await expect(page.locator('[data-session-ref-picker]').getByText('私密标题 X',{exact:true})).toBeVisible();
  await show(page); await expect(page.locator('[data-session-ref-picker]').getByText('私密标题 X',{exact:true})).toHaveCount(0);
  await page.locator('.chat-textarea:visible').press('Escape'); await show(page);
  await page.getByLabel('高级提示').fill('@SESSION:');
  await expect(page.getByRole('option').filter({hasText:'私密标题 X'})).toBeVisible();
  await page.evaluate(() => (window as any).privacyFixture.show(false));
  await expect(page.getByRole('option').filter({hasText:'私密标题 X'})).toHaveCount(0);
});

test('home activity and completion notifications do not disclose private titles', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const f=(window as any).privacyFixture;
    f.callbacks.forEach((cb:any)=>cb({type:'session_changed',sessionId:'secret',summary:f.rows.find((r:any)=>r.id==='secret')}));
    for (const id of ['a','secret']) f.streams.forEach((cb:any)=>cb({sessionId:id,type:'done',messageId:'finish-'+id}));
  });
  await expect.poll(() => page.evaluate(() => (window as any).privacyFixture.notifications)).toEqual(['公开 A']);
  await expect(page.getByText('私密标题 X',{exact:true})).toHaveCount(0);
  await expect(page.getByText('/secret/path',{exact:true})).toHaveCount(0);
});

test('two main windows keep own tabs and detached routes cannot replace cold-start fallback', async ({ page, context }) => {
  await setup(page); await select(page, '公开 A');
  const second = await context.newPage(); await setup(second); await select(second, '公开 C');
  await page.evaluate(() => (window as any).privacyFixture.publish());
  await page.reload(); await mount(page);
  await expect(page.getByRole('tab', { name: '公开 A', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '公开 C', exact: true })).toHaveCount(0);
  const detached = await context.newPage();
  await setup(detached, {}, '/?sessionWindow=1&windowSession=secret&windowExecutor=node-b&workbenchWindow=detached&workbenchHome=original');
  await expect(detached.getByText('此 Session 已隐藏', { exact: true })).toBeVisible();
  expect(await detached.evaluate(() => (window as any).privacyFixture.mounts)).toEqual([]);
  await detached.getByRole('button', { name: '显示私密 Session', exact: true }).click();
  await expect(detached.getByRole('heading', { name: '私密标题 X', exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.clear()); await page.reload(); await mount(page);
  await expect(page.getByRole('tab', { name: '公开 C', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '私密标题 X', exact: true })).toHaveCount(0);
  await second.close(); await detached.close();
});
