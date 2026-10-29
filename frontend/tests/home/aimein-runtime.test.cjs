const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aimeinRuntime, aimeinCurrent, AIMEIN_OUTPUT_LIMIT } = require('../../.home-test-dist/utils/aimeinRuntime.js');
const { aimeinObservation } = require('../../.home-test-dist/utils/aimeinRuntime.js');
const record = (seq = 1) => ({ seq, round: 1, subStage: 'prepare', completed: false, error: '', orchestration: [], stageDetails: {}, callDiagnostics: [] });
const state = r => ({ loops: [r], running: true, round: 1, goal: '建设目标', resumable: false });
const call = stage => ({ id: stage, stage, status: 'running', phase: 'tools', model: 'model-a', startedAt: 100, eventCounts: { tool_result: 1 } });

test('pre-Sprint setup is visible with its real target and output', () => {
  const r = record(); r.stageDetails.openspecSetup = { status: 'running' }; r.callDiagnostics = [call('prepare')];
  const s = state(r), view = aimeinRuntime(s, aimeinCurrent(s), { '1:prepare': '正在读取源方案', '2:prepare': '别的尝试' });
  assert.equal(view.title, 'OpenSpec 准备'); assert.equal(view.goal, '建设目标'); assert.equal(view.live, true);
  assert.deepEqual(view.channels.map(c => c.text), ['正在读取源方案']);
});
test('parallel reviews retain independent active channels and historical records never run', () => {
  const r = record(); r.subStage = 'analysis'; r.callDiagnostics = [call('aimein-review1'), call('aimein-review2')];
  const s = state(r), progress = { '1:aimein-review1': '证据一', '1:aimein-review2': '证据二' };
  const v = aimeinRuntime(s, r, progress); assert.equal(v.activeCalls.length, 2);
  assert.deepEqual(v.channels.map(c => c.text), ['证据一', '证据二']);
  s.loops.push(record(2)); const old = aimeinRuntime(s, r, progress);
  assert.equal(old.historical, true); assert.equal(old.live, false); assert.ok(old.channels.every(c => !c.active));
  assert.equal(old.goal, '');
});
test('saved output wins after completion, live output is bounded, offline is unconfirmed', () => {
  const r = record(); r.callDiagnostics = [call('aimein-plan')]; r.stageDetails['aimein-plan'] = { rawOutput: '保存结果' };
  const s = state(r), p = { '1:aimein-plan': 'x'.repeat(AIMEIN_OUTPUT_LIMIT + 10) };
  const active = aimeinRuntime(s, r, p); assert.equal(active.channel.text.length, AIMEIN_OUTPUT_LIMIT); assert.equal(active.channel.truncated, true);
  const offline = aimeinRuntime(s, r, p, false); assert.equal(offline.live, false); assert.match(offline.title, /连接中断/);
  assert.equal(offline.channel.text, active.channel.text);
  r.completed = true; r.callDiagnostics[0].status = 'done'; s.running = false;
  assert.equal(aimeinRuntime(s, r, p).channel.text, '保存结果');
});
test('actual failure keeps its reason without creating a completion claim', () => {
  const r = record(); r.error = '命令执行失败'; r.callDiagnostics = [call('prepare')];
  const v = aimeinRuntime(state(r), r, {}); assert.equal(v.live, false); assert.equal(v.error, r.error); assert.equal(v.title, '需要处理');
});

test('observation distinguishes saved progress, active work and measured quality without invented green scores', () => {
  const r = record(); r.orchestration = [{ index: 1, desc: '保存', status: 'done', output: '真实输出' }, { index: 2, desc: '恢复', status: 'running', output: '' }, { index: 3, status: 'done', output: '' }];
  r.callDiagnostics = [call('step2')]; const s = state(r);
  let v = aimeinObservation(s, r); assert.equal(v.saved, 1); assert.equal(v.total, 3); assert.equal(v.coverage.known, false);
  assert.equal(v.health, 'working'); assert.equal(v.current, '恢复'); assert.match(v.measurement, /未测量/);
  r.callDiagnostics[0].phase = 'retry_wait'; assert.equal(aimeinObservation(s, r).health, 'waiting');
  r.callDiagnostics = []; assert.equal(aimeinObservation(s, r).health, 'waiting');
  assert.equal(aimeinObservation(s, r, false).health, 'offline');
  r.orchestration[1].status = 'error'; assert.equal(aimeinObservation(s, r).health, 'attention');
  s.loops.push(record(2)); assert.equal(aimeinObservation(s, r).health, 'history');
});
