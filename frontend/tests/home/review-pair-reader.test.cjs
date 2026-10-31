const {test}=require('node:test'); const assert=require('node:assert/strict');
const {ReviewPairReader}=require('../../.home-test-dist/utils/reviewPairReader.js');
const {compareSnapshot}=require('../../.home-test-dist/utils/directorySyncReview.js');
const scope={workspace:{ownerId:'u',executorInstance:'e',sessionId:'s',workingDir:'/w',workspaceRevision:'v'},execKey:'node',bindingId:'b',includeGitMetadata:false};
test('coalesce only active pair; no prefetch/cache, missing never inferred from error',async()=>{
 let resolve; let calls=[]; const missing={kind:'missing',version:{exists:false}};
 const reader=new ReviewPairReader(p=>{calls.push(p);return new Promise(r=>resolve=r);},async()=>{throw new Error('offline');});
 const snap=compareSnapshot(scope,1,{'a':{hash:'x',size:1},'unselected':{hash:'y',size:1}},{});
 const a=reader.read(snap,'a',1),b=reader.read(snap,'a',2); assert.deepEqual(calls,['a']); resolve(missing);
 assert.equal((await a).remote.kind,'unavailable'); assert.equal((await b).readRevision,2);
 const c=reader.read(snap,'a',3); assert.deepEqual(calls,['a','a']); resolve(missing); await c;
});
