const {test}=require('node:test'), assert=require('node:assert/strict');
const {submitReviewTransfer, reviewTransfers,reviewDirty}=require('../../.home-test-dist/utils/directorySyncTransfers.js');
const {fileTransfers}=require('../../.home-test-dist/utils/fileTransfers.js');
const {documentStore}=require('../../.home-test-dist/utils/documentStore.js');
const {reviewScopeKey}=require('../../.home-test-dist/utils/directorySyncReview.js');
const {byteHash}=require('../../.home-test-dist/utils/documentCodec.js');
const {RemoteSyncReview,ReviewNotSubmitted}=require('../../.home-test-dist/utils/syncReviewProtocol.js');
const io=new Map(); global.localStorage={getItem:k=>io.get(k)||null,setItem:(k,v)=>io.set(k,v)};
let serial=0;
function fixture(){
 const id=String(++serial), scope={workspace:{ownerId:'u',executorInstance:'e',sessionId:id,workingDir:'/w'+id,workspaceRevision:'v'},execKey:'node',bindingId:'b'+id,includeGitMetadata:false};
 const side=(text,rev)=>{const bytes=new TextEncoder().encode(text);return {kind:'file',bytes,version:{exists:true,sha256:byteHash(bytes),byteLength:bytes.length,fileId:id,modifiedNs:rev,changedNs:rev}};};
 let l=side('local','1'),r=side('remote','1'),writes=0,gets=0;
 const pair={scopeKey:reviewScopeKey(scope),compareRevision:1,readRevision:1,path:'a.txt',local:l,remote:r};
 let receipt;
 const remote={check:async()=>r,apply:async req=>{writes++;r=side('local','2');return receipt={status:'succeeded',requestId:req.requestId,scopeKey:req.scopeKey,relativePath:req.relativePath,sourceHash:byteHash(req.bytes),version:r.version};},get:async()=>{gets++;return receipt;}};
 const local={bindingId:scope.bindingId,canCreate:true,check:async()=>l};
 return {scope,pair,remote,local,input:{scope,pair,local,remote,direction:'push',transferKey:id,label:id,assertCurrent:()=>{}},
  changeLocal:()=>{l=side('next','3');},changeRemote:()=>{r=side('next','3');},writes:()=>writes,gets:()=>gets};
}
test('changed source/destination refuses submission and no baseline',async()=>{
 for(const change of ['changeLocal','changeRemote']){const f=fixture(), before=io.size;f[change]();await submitReviewTransfer(f.input);
  assert.equal(f.writes(),0);assert.equal(io.size,before);assert.equal(reviewTransfers.getSnapshot().at(-1).status,'stale');}
});
test('source changes after verified publication: real transfer completed, not synced or baseline',async()=>{
 const f=fixture(), apply=f.remote.apply,before=io.size;
 f.remote.apply=async req=>{const r=await apply(req);f.changeLocal();return r;};
 await submitReviewTransfer(f.input);assert.equal(f.writes(),1);assert.equal(io.size,before);
 assert.equal(reviewTransfers.getSnapshot().at(-1).status,'stale');assert.equal(fileTransfers.active(f.input.transferKey),undefined);
});
test('unknown is reserved, one auto query, explicit query never writes again',async()=>{
 const f=fixture();let writes=0,gets=0;
 f.remote.apply=async()=>{writes++;throw new Error('lost response');};f.remote.get=async requestId=>{gets++;return {status:'unknown',requestId};};
 await submitReviewTransfer(f.input);assert.equal(writes,1);assert.equal(gets,1);
 const job=fileTransfers.active(f.input.transferKey);assert.equal(job.status,'unresolved');fileTransfers.cancel(job);fileTransfers.dismiss(job);
 assert.equal(fileTransfers.active(f.input.transferKey),job);assert.equal(job.abort.current,false);
 await job.reconcile();assert.equal(writes,1);assert.equal(gets,2);
 await assert.rejects(submitReviewTransfer(f.input),/transfer_busy/);
});
test('known dirty local or remote documents block; other identities do not',async()=>{
 const f=fixture(); const workspace={...f.scope.workspace,workingDir:f.scope.bindingId,executorInstance:'local-copy:'+f.scope.bindingId};
 const client={source:'local-copy',identity:workspace,read:async()=>({status:'ok',document:{workspace,relativePath:'a.txt',source:'local-copy'},text:'base',version:f.pair.local.version,editable:true})};
 const doc=await documentStore.open(client,'a.txt');documentStore.edit(doc.key,'draft');
 assert.equal(reviewDirty(f.scope,'a.txt'),true);assert.equal(reviewDirty(f.scope,'other.txt'),false);
 await assert.rejects(submitReviewTransfer(f.input),/dirty_document/);assert.equal(f.writes(),0);
});
test('authoritative refusal releases only this job; transport or invalid receipt remains unknown',async()=>{
 const f=fixture();let gets=0;
 f.remote.apply=async()=>{throw new ReviewNotSubmitted('control_changed');};f.remote.get=async()=>{gets++;};
 await submitReviewTransfer(f.input);
 assert.equal(reviewTransfers.getSnapshot().at(-1).status,'failed');assert.equal(fileTransfers.active(f.input.transferKey),undefined);assert.equal(gets,0);
 const workspace={...f.scope.workspace,workspaceRevision:'a'.repeat(64)};
 let mode='refusal';
 const remote=await RemoteSyncReview.connect({user:workspace.ownerId,executor:'node',session:workspace.sessionId,workingDir:workspace.workingDir},async (_e,method)=>{
  if(method==='syncReviewCapabilities')return {status:'ok',protocolVersion:1,workspace,read:true,apply:true,controlRevision:0,maxBytes:2*1024*1024};
  if(mode==='refusal')return {status:'error',reasonCode:'control_changed'};
  if(mode==='lost')throw new Error('lost');
  return {status:'succeeded'};
 },()=>true);
 const req={requestId:'r',relativePath:f.pair.path,baseVersion:f.pair.remote.version,bytes:f.pair.local.bytes,scopeKey:f.pair.scopeKey};
 await assert.rejects(remote.apply(req),e=>e instanceof ReviewNotSubmitted);
 for(mode of ['lost','invalid'])await assert.rejects(remote.apply(req),e=>!(e instanceof ReviewNotSubmitted));
});
