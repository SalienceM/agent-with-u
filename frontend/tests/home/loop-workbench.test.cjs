const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loopWorkbenchView } = require('../../.home-test-dist/utils/loopWorkbenchView.js');
const { base, record, states, migrations, environmentStates, restored } = require('./fixtures/loop-workbench.cjs');

test('reported OpenSpec preparation failure keeps its reason and original-session recovery', () => {
  const state = { ...base(), taskSource: { status: 'unavailable', code: 'preparation_blocked', revision: 0,
    reason: '准备调用报告：helper_unknown_error: setup refresh had errors' } };
  const issue = loopWorkbenchView(state).issues[0];
  assert.equal(issue.title, 'OpenSpec 准备受阻');
  assert.match(issue.reason, /helper_unknown_error/);
  assert.match(issue.next, /原会话/);
  assert.doesNotMatch(issue.reason, /尚未初始化/);
});

test('OpenSpec preparation is observable without fake conflicts or duplicate current pauses', () => {
  const cause = { causeRef: 'wait:setup', causeRevision: 1, round: 1, seq: 1 };
  const state = { ...base(), taskSource: { status: 'unavailable', code: 'project_required', revision: 0, reason: 'old no init message' },
    loops: [{ ...record(), decision: { ...cause, action: 'wait', revision: 0, basisRefs: ['source:0'] } }],
    progressGuard: { ...cause, pause: true, reason: 'old no init message' } };
  const view = loopWorkbenchView(state);
  assert.equal(view.issues.length, 1);
  assert.equal(view.issues[0].title, 'OpenSpec 项目待准备');
  assert.match(view.issues[0].next, /点击推进/);
  assert.doesNotMatch(view.issues[0].reason, /old no init/);
  state.taskSource.revision = 1;
  assert.equal(loopWorkbenchView(state).issues.length, 2);
  state.taskSource.status = 'preparing'; state.progressGuard = {}; state.loops[0].decision = {};
  assert.equal(loopWorkbenchView(state).issues.length, 0);
  state.taskSource.status = 'conflict';
  assert.match(loopWorkbenchView(state).issues[0].next, /核对范围差异/);
});
test('only matching current causal revisions merge decision and guard with task evidence', () => {
  const decision = { action: 'wait', decisionId: 'd', reasonCode: 'task_contract_invalid', reasonText: 'same',
    round: 1, seq: 1, causeRef: 'contract:c', causeRevision: 3, affectedIds: ['A'] };
  const state = { ...base(), loops: [{ ...record(), decision, contractValidation: { status: 'exhausted',
    causeRef: 'contract:c', causeRevision: 3, affectedIds: ['B'], evidenceRefs: ['audit:1'] } }],
    progressGuard: { pause: true, reason: 'same', round: 1, seq: 1, causeRef: 'contract:c', causeRevision: 3 } };
  let view = loopWorkbenchView(state);
  assert.equal(view.issues.length, 1);
  assert.equal(view.issues[0].title, '任务计划仍不合格');
  assert.deepEqual(view.issues[0].affectedIds, ['A', 'B']);
  assert.ok(view.issues[0].refs.includes('audit:1'));
  state.progressGuard.causeRevision = 2;
  assert.equal(loopWorkbenchView(state).issues.length, 2);
  state.progressGuard.causeRevision = 3; state.progressGuard.round = 0;
  assert.equal(loopWorkbenchView(state).issues.length, 2);
  delete state.progressGuard.causeRef;
  assert.equal(loopWorkbenchView(state).issues.length, 2);
  state.executionEnvironment = environmentStates().unconfirmed.executionEnvironment;
  view = loopWorkbenchView(state);
  assert.match(view.issues[0].title, /退出/);
  assert.equal(view.issues.length, 3);
});
test('restore fixtures reproduce unsupported preflight without a real blocker', () => {
  const cases = environmentStates();
  assert.equal(restored.length, 8);
  assert.deepEqual(cases.unsupported.executionEnvironment.blockers, []);
  assert.equal(loopWorkbenchView(cases.unsupported).primary, 'resume');
});
test('synthetic states and removal mapping cover the operation table without I/O', () => {
  const expected = { idea: 'seal', idle: 'run', running: 'running', resumable: 'resume', multi: 'run', result: 'continue', manual: 'manual', legacy: 'run', human: 'continue' };
  for (const [name, state] of Object.entries(states())) assert.equal(loopWorkbenchView(state).primary, expected[name], name);
  assert.equal(Object.keys(migrations).length, 8);
});
test('structured source cause is grouped, remaining issues stay ordered and identifiable', () => {
  const view = loopWorkbenchView(states().multi);
  assert.equal(view.issues.length, 3);
  assert.match(view.issues[0].title, /退出/);
  assert.equal(view.issues[1].refs.length, 3);
  assert.equal(view.issues[2].section, 'evidence');
});

test('diagnostic severity never schedules; snapshots bind revisions and offline never falls back', () => {
  const cases = environmentStates();
  for (const key of ['unsupported', 'stale']) {
    assert.equal(loopWorkbenchView(cases[key]).issues.length, 0);
    assert.equal(loopWorkbenchView(cases[key]).canRequest, true);
  }
  for (const key of ['actualFault', 'incomplete', 'unconfirmed', 'source', 'paused', 'local'])
    assert.ok(loopWorkbenchView(cases[key]).issues.length, key);
  const state = base();
  state.iterationRequest = { version: 1, sessionId: state.sessionId, round: 1, seq: 0, controlRevision: 0,
    sourceRevision: 0, environmentRevision: 0, canRequest: true, action: 'run', message: '' };
  assert.equal(loopWorkbenchView(state).canRequest, true);
  assert.equal(loopWorkbenchView(state, { offline: true }).canRequest, false);
  state.iterationRequest.sessionId = 'other';
  assert.equal(loopWorkbenchView(state).canRequest, false);
  state.iterationRequest.sessionId = state.sessionId;
  state.iterationRequest.environmentRevision++;
  assert.equal(loopWorkbenchView(state).canRequest, false);
  assert.match(loopWorkbenchView(cases.legacy).requestCompatibility, /旧端/);
});
test('local blockers do not create a global scheduling gate, text does not establish identity', () => {
  const state = { ...base(), unresolvedBlockers: { available: true }, loops: [record()] };
  assert.equal(loopWorkbenchView(state).primary, 'run');
  state.loops[0].decision = { action: 'wait', reasonText: '任务范围或来源需要核对', decisionId: 'independent' };
  state.taskSource = { status: 'conflict' };
  assert.equal(loopWorkbenchView(state).issues.length, 3);
});
test('score, normal call, result stage and partial policy evidence are never success', () => {
  for (const state of Object.values(states())) assert.equal(loopWorkbenchView(state).full, false);
  assert.match(loopWorkbenchView(states().human).acceptance, /待人工/);
  assert.equal(loopWorkbenchView({ ...base(), stage: 'future' }).primary, 'check');
  assert.equal(loopWorkbenchView(base(), { controlPending: true }).primary, 'check');
  assert.equal(loopWorkbenchView(base(), { controlError: 'offline' }).primary, 'check');
  assert.equal(loopWorkbenchView({ ...states().result, running: true }).primary, 'continue');
  const state = { ...base(), executionEnvironment: { revision: 1, status: 'passed', latest: { coverage: 'native_policy', status: 'passed' } } };
  assert.equal(loopWorkbenchView(state).full, false);
});

test('only exact current check references merge environmental waits, preserving unrelated evidence', () => {
  const state = environmentStates().actualFault;
  state.loops[0].decision = { action: 'wait', decisionId: 'wait1', round: 1, seq: 1, basisRefs: ['environment:fault:3'] };
  assert.equal(loopWorkbenchView(state).issues.length, 1);
  assert.deepEqual(loopWorkbenchView(state).issues[0].refs, ['environment:fault:3', 'decision:wait1']);
  state.loops[0].decision.basisRefs = ['environment:fault:2'];
  assert.equal(loopWorkbenchView(state).issues.length, 2);
  state.loops[0].decision.basisRefs = ['environment:fault:3'];
  state.loops[0].decision.round = 0;
  assert.equal(loopWorkbenchView(state).issues.length, 2);
});
