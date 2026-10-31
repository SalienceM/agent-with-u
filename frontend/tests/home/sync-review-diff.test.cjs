const {test} = require('node:test');
const assert = require('node:assert/strict');
const {calculateReviewDiff, foldedReviewRows} = require('../../.home-test-dist/utils/syncReviewDiff.js');
const bytes = text => new TextEncoder().encode(text);
const diff = (a,b,options) => calculateReviewDiff(bytes(a),bytes(b),'file.ts',options);
test('over 500 lines sparse changes retain real mappings and fold context',()=>{
 const a = Array.from({length:1300},(_,i)=>`line ${i}`), b=[...a]; b[20]='changed'; b.splice(900,0,'new');
 const r=diff(a.join('\n'),b.join('\n')); assert.equal(r.status,'ok'); assert.equal(r.hunks.length,2);
 assert.equal(r.rows.filter(x=>x.kind==='equal').length,1299); assert.ok(foldedReviewRows(r.rows,new Set()).length<40);
});
test('empty/blank/repeated lines and final newline are not invented',()=>{
 for(const [a,b] of [['',''],['','\n'],['a\n\na\nb','a\na\n\nb'],['x\ny','z\nx\ny\nq'],['a','']]){
  const r=diff(a,b); assert.equal(r.status,'ok');
  const l=r.rows.filter(x=>x.left!==null).map(x=>r.left.lines[x.left]);
  const right=r.rows.filter(x=>x.right!==null).map(x=>r.right.lines[x.right]);
  assert.deepEqual(l,r.left.lines); assert.deepEqual(right,r.right.lines);
  for(const row of r.rows.filter(x=>x.kind==='equal')) assert.equal(r.left.lines[row.left],r.right.lines[row.right]);
 }
 assert.equal(diff('a\r\n','a\n').formatDifferent,true); assert.equal(diff('a','a\n').formatDifferent,true);
 assert.equal(diff('\uFEFFa','a').formatDifferent,true);
});
test('bounded budgets/cancel/lines/bytes/long lines never pretend complete',()=>{
 for(const [a,b,opts,reason] of [['a','b',{maxOperations:0},'diff_budget_exceeded'],['a','b',{cancelled:()=>true},'diff_cancelled'],
  ['x'.repeat(65537),'',{},'line_too_long'],['\n'.repeat(20000),'',{},'too_many_lines'],['x'.repeat(2*1024*1024+1),'',{},'too_large']]){
  const result=diff(a,b,opts);assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,reason);
 }
});
test('random small edits reconstruct both sources with valid equal lines',()=>{
 let seed=12; const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
 for(let n=0;n<200;n++){
  const a=Array.from({length:rnd()%20},()=>String(rnd()%4)).join('\n'), b=Array.from({length:rnd()%20},()=>String(rnd()%4)).join('\n');
  const r=diff(a,b); assert.equal(r.status,'ok');
  assert.deepEqual(r.rows.filter(x=>x.left!==null).map(x=>x.left),r.left.lines.map((_,i)=>i));
  assert.deepEqual(r.rows.filter(x=>x.right!==null).map(x=>x.right),r.right.lines.map((_,i)=>i));
  for(const row of r.rows.filter(x=>x.kind==='equal'))assert.equal(r.left.lines[row.left],r.right.lines[row.right]);
 }
});
