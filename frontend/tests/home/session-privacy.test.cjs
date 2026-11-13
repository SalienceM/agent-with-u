const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionPrivacy, mergePrivacyRemote } = require('../../.home-test-dist/utils/sessionPrivacy.js');
const { favoriteKey } = require('../../.home-test-dist/utils/sessionFavorites.js');
const v = require('../../.home-test-dist/utils/sessionVisibility.js');
const target = { scope: 'alice@qa', node: 'node-a', session: 'secret' };
const tick = () => new Promise(resolve => setImmediate(resolve));
class Repository {
  rows = new Map(); fail = false;
  async all() { if(this.fail) throw Error('storage'); return [...this.rows.values()]; }
  async edit(key, fn) { if(this.fail) throw Error('storage'); const row = fn(this.rows.get(key) || null); row ? this.rows.set(key,row) : this.rows.delete(key); return row; }
  async clear() { this.rows.clear(); }
}
function fixture(repository = new Repository()) {
  const state = { online: 'offline', calls: [], remote: { status: 'ok', protocolVersion: 1, isPrivate: false, privacyRevision: 0 }, received: [] };
  const controller = new SessionPrivacy(repository, {
    available: () => state.online, changed() {},
    remote(t, value) { state.received.push(value); },
    async call(t, method, params) {
      state.calls.push({ t, method, params });
      if(state.handler) return state.handler(t, method, params);
      if(method === 'sessionPrivacyGet') return { ...state.remote };
      assert.equal(method, 'sessionPrivacySet'); const patch = JSON.parse(params[1]); assert.equal('pinned' in patch, false);
      state.remote = { ...state.remote, isPrivate: patch.isPrivate, privacyRevision: state.remote.privacyRevision+1, lastRequestId: patch.requestId };
      return { ...state.remote };
    }
  }); return { c: controller, state, repository };
}
test('private offline latest choice survives restart and never alters favorites', async () => {
  const { c, repository, state } = fixture();
  assert.equal(c.project(target, { isPrivate: false }).privacyKnown, false);
  await c.choose(target,true,0); await c.choose(target,false,0); await c.choose(target,true,0); await tick();
  const other = fixture(repository).c; await other.reload();
  const view = other.project(target, { isPrivate: false, pinned: true, favoriteRevision: 8 });
  assert.equal(view.isPrivate,true); assert.equal(view.pinned,true); assert.equal(view.favoriteRevision,8); assert.equal(view.privacyStatus,'pending');
  assert.equal(v.canShowSession(view,false),false); assert.equal(state.calls.length,0);
  for(const patch of [{scope:'bob@qa'}, {node:'node-b'}, {session:'different'}]) assert.equal(other.project({...target,...patch},{isPrivate:false}).isPrivate,false);
  state.online='online'; c.reconnect(); await tick(); await tick();
  assert.deepEqual(state.calls.map(r=>r.method),['sessionPrivacyGet','sessionPrivacySet']);
  assert.equal(state.received.at(-1).isPrivate,true); assert.equal('pinned' in state.received.at(-1),false);
});
test('unreadable local storage fails closed and prevents remote writes', async () => {
  const {c, repository, state}=fixture(); repository.fail=true; state.online='online';
  await assert.rejects(c.reload(),/storage/); await assert.rejects(c.choose(target,true,0),/storage/);
  assert.equal(v.canShowSession(c.project(target,{isPrivate:false}),true),false); assert.equal(state.calls.length,0);
  repository.fail=false; await c.reload(); assert.equal(v.canShowSession(c.project(target,{isPrivate:false}),false),true);
});
test('lost write receipt only reads until proven; explicit conflict resolution remains independent', async () => {
  const {c,state}=fixture(); await c.choose(target,true,0); await tick(); state.online='online';
  state.handler=async(_t,method)=>{ if(method==='sessionPrivacyGet') return {...state.remote}; throw Error('receipt lost'); };
  await c.sync(target); assert.equal(c.get(target).phase,'unknown');
  await c.sync(target); await c.sync(target);
  assert.equal(state.calls.filter(r=>r.method==='sessionPrivacySet').length,1);
  state.remote={...state.remote,privacyRevision:2}; await c.sync(target); assert.equal(c.get(target).phase,'conflict');
  await c.resolve(target,'remote'); assert.equal(c.get(target),undefined);
});
test('late receipt does not revert a newer local choice or enter another identity', async () => {
  const {c,state}=fixture(); let release; await c.choose(target,true,0); await tick(); state.online='online';
  state.handler=async(_t,method)=> method==='sessionPrivacyGet' ? {...state.remote} : new Promise(resolve=>release=resolve);
  const work=c.sync(target); while(!release) await tick();
  await c.choose(target,false,0); assert.equal(c.project(target,{isPrivate:true}).isPrivate,false);
  c.invalidate(); release({...state.remote,isPrivate:true,privacyRevision:1}); await work; await tick();
  assert.equal(state.received.length,1); assert.equal(c.get({...target,scope:'bob@qa'}),undefined);
});
test('old node retains private choice with local-only feedback', async () => {
  const {c,state}=fixture(); await c.choose(target,true,0); await tick(); state.online='online'; state.handler=async()=>null;
  await c.sync(target); const view=c.project(target,{isPrivate:false,pinned:true});
  assert.equal(view.privacyStatus,'unsupported'); assert.match(view.privacyMessage,/私密/); assert.equal(view.pinned,true); assert.equal(view.isPrivate,true);
  assert.equal(mergePrivacyRemote({isPrivate:true,privacyRevision:4},{isPrivate:false,privacyRevision:1}).isPrivate,true);
});
test('visibility and navigation projection preserve raw members, panes and order without revealing unknown metadata', () => {
  const state={tabs:['chat','session:a','session:secret','session:unknown','session:c'],active:'session:secret'};
  const panes=['secret','a',null,null], before=JSON.stringify({state,panes});
  const meta=id=> id==='unknown'?null:{id,title:id,isPrivate:id==='secret'};
  const hidden=v.projectSessionNavigation(state,panes,meta,false);
  assert.deepEqual(hidden.workbench.tabs,['chat','session:a','session:c']); assert.equal(hidden.workbench.active,'chat'); assert.equal(hidden.panes[0],null);
  const shown=v.projectSessionNavigation(state,panes,meta,true,new Set(['secret']));
  assert.deepEqual(shown.workbench.tabs,['chat','session:a','session:secret','session:c']); assert.equal(shown.workbench.active,'chat'); assert.equal(shown.panes[0],null);
  assert.equal(JSON.stringify({state,panes}),before);
  assert.equal(v.sessionVisibility({id:'not-loaded'}),'unknown'); assert.equal(v.sessionVisibility({title:'legacy'}),'public');
  assert.equal(v.canNotifySession(meta('secret')),false); assert.equal(v.canNotifySession(null),false);
});
test('reveal is ephemeral, subscribable and never writes or broadcasts', () => {
  let changes=0; const off=v.subscribeSessionVisibility(()=>changes++);
  global.localStorage={setItem(){throw Error('unexpected persistent reveal');}};
  assert.equal(v.privateSessionsShown(),false); v.showPrivateSessions(true); v.showPrivateSessions(true); assert.equal(changes,1);
  v.showPrivateSessions(false); assert.equal(changes,2); off();
});
