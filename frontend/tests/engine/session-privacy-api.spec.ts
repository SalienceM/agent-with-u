import { test, expect, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';

test('real API: separate clients sync private markers but keep navigation and reveal local; identity reset closes reveal', async ({ browser }) => {
  const contexts: BrowserContext[] = [], sockets: WebSocketRoute[] = [], calls: string[] = [];
  let denied = false;
  const record = { id: 'api-session', title: '跨端私密会话', workingDir: '', backendId: 'qa', sessionType: 'normal', pinned: true, favoriteRevision: 3, isPrivate: false, privacyRevision: 0 };
  async function client() {
    const context = await browser.newContext(); contexts.push(context);
    await context.routeWebSocket(/.*/, ws => { sockets.push(ws); ws.onMessage(message => {
      const input = JSON.parse(String(message)); calls.push(input.method); let result: any = null;
      if (input.method === 'listSessions') result = [{ ...record }];
      if (input.method === 'getBackends') result = [];
      if (input.method === 'loadSessionMeta') { if (denied) { ws.send(JSON.stringify({id: input.id, error:'QA denied'})); return; } result = { ...record }; }
      if (input.method === 'sessionPrivacyGet') result = { ...record, status: 'ok', protocolVersion: 1 };
      if (input.method === 'sessionPrivacySet') {
        const patch = JSON.parse(input.params[1]);
        if (patch.expectedRevision !== record.privacyRevision) result = { status: 'conflict' };
        else { record.isPrivate = patch.isPrivate; record.privacyRevision++;
          result = { ...record, status: 'ok', protocolVersion: 1, lastRequestId: patch.requestId };
          for(const peer of sockets) peer.send(JSON.stringify({ event: 'sessionUpdated', data: JSON.stringify({ type: 'session_changed', sessionId: record.id, summary: { ...record } }) }));
        }
      }
      ws.send(JSON.stringify({ id: input.id, result: result === null ? null : JSON.stringify(result) }));
    }); });
    await context.route('**/*', route => {
      const u = new URL(route.request().url()); if(u.origin !== 'http://127.0.0.1:55191') return route.abort();
      if(u.pathname === '/') return route.fulfill({contentType:'text/html', body:`<html><body><div class="app-root" id="root"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>`});
      return route.continue();
    });
    const page=await context.newPage(); await page.goto('/');
    await page.evaluate(async()=>{ const path='/src/api.ts'; (window as any).apiModule=await import(/* @vite-ignore */ path); });
    await expect.poll(()=>page.evaluate(async()=>(await (window as any).apiModule.api.listSessions()).length)).toBe(1);
    await page.evaluate(async()=>{
      const path='/tests/engine/chat-kit-feedback-harness.ts'; const {React,createRoot,Sidebar}=await import(/* @vite-ignore */ path);
      createRoot(document.getElementById('root')!).render(React.createElement(Sidebar,{activeSessionId:null,onSelectSession:()=>{},onNewSession:()=>{},onDeleteSession:()=>{},streamingSessions:new Set(),collapsed:false}));
    });
    await expect(page.getByText('跨端私密会话',{exact:true})).toBeVisible(); return page;
  }
  try {
    const a=await client(), b=await client();
    await a.getByRole('switch',{name:'显示私密 Session'}).click();
    await a.evaluate(async()=>{
      const p='/src/utils/workbench.ts'; const n=await import(/* @vite-ignore */ p), m=(window as any).apiModule;
      n.saveWorkbenchSnapshot(m.getCurrentUserProfile(), n.normalizeWorkbenchSnapshot({version:1,workbench:{tabs:['chat','session:api-session'],active:'session:api-session'}}));
      await m.api.setSessionPrivacy('api-session',true,'local');
    });
    await expect.poll(()=>record.isPrivate).toBe(true);
    await expect(a.getByText('跨端私密会话',{exact:true})).toBeVisible(); await expect(b.getByText('跨端私密会话',{exact:true})).toHaveCount(0);
    await expect(b.getByRole('switch',{name:'显示私密 Session'})).toHaveAttribute('aria-checked','false');
    expect(await b.evaluate(async()=>{const p='/src/utils/workbench.ts', n=await import(/* @vite-ignore */ p);return n.loadWorkbenchSnapshot((window as any).apiModule.getCurrentUserProfile()).workbench.tabs;})).toEqual(['chat']);
    expect(record.pinned).toBe(true); expect(record.favoriteRevision).toBe(3); expect(calls.filter(m=>m==='sessionPrivacySet')).toHaveLength(1);
    denied=true;
    expect(await b.evaluate(async()=>{const api=(window as any).apiModule.api;try {await api.loadSessionMeta('api-session');} catch {} return api.peekSessionMeta('api-session').privacyKnown;})).toBe(false);
    denied=false;
    expect(await b.evaluate(async()=>{const api=(window as any).apiModule.api;return (await api.loadSessionMeta('api-session')).privacyKnown;})).toBe(true);
    await a.evaluate(async()=>{await (window as any).apiModule.setConnectionTarget({mode:'relay',url:'ws://127.0.0.1:55191/qa',token:'fixture-only',deviceId:'fixture-node',user:{userId:'bob',username:'bob'}});});
    await expect(a.getByRole('switch',{name:'显示私密 Session'})).toHaveAttribute('aria-checked','false');
    expect(await a.evaluate(async()=>{const p='/src/utils/workbench.ts',n=await import(/* @vite-ignore */ p);return n.loadWorkbenchSnapshot((window as any).apiModule.getCurrentUserProfile()).workbench.tabs;})).toEqual(['chat']);
    expect(calls.some(m=>['sendMessage','abortMessage','seqtaskTakeNext','deleteSession','workbenchWindowTransfer'].includes(m))).toBe(false);
  } finally { for(const context of contexts) await context.close(); }
});
