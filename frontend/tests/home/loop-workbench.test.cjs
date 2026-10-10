const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loopWorkbenchView } = require('../../.home-test-dist/utils/loopWorkbenchView.js');
const { base, record, states, migrations } = require('./fixtures/loop-workbench.cjs');
test('synthetic states and removal mapping cover the operation table without I/O', () => {
  const expected = { idea: 'seal', idle: 'run', running: 'running', resumable: 'resume', multi: 'issues', result: 'continue', manual: 'manual', legacy: 'run', human: 'continue' };
  for (const [name, state] of Object.entries(states())) assert.equal(loopWorkbenchView(state).primary, expected[name], name);
  assert.equal(Object.keys(migrations).length, 8);
});
test('structured source cause is grouped, remaining issues stay ordered and identifiable', () => {
  const view = loopWorkbenchView(states().multi);
  assert.equal(view.issues.length, 3);
  assert.match(view.issues[0].title, /退出/);
  assert.equal(view.issues[1].refs.length, 2);
  assert.equal(view.issues[2].section, 'evidence');
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
