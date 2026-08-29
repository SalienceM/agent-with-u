const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeExecutorSessionBatches,
  selectExactExecutor,
} = require('../../.home-test-dist/utils/executorSessions.js');

test('an explicit remote executor never falls back to home', () => {
  const home = { key: 'local' };
  const remote = { key: 'relay:user:pc_47' };
  const connections = new Map([[remote.key, remote]]);

  assert.equal(selectExactExecutor(connections, home), home);
  assert.equal(selectExactExecutor(connections, home, remote.key), remote);
  assert.equal(selectExactExecutor(connections, home, 'relay:user:offline'), null);
});

test('the same sidecar exposed through local and Relay is rendered once', () => {
  const shared = { id: 'session-1', title: '同一会话' };
  const relay = {
    execKey: 'relay:user:pc_home', execLabel: 'pc_home', execMode: 'relay',
    execIsHome: true, sessions: [shared],
  };
  const local = {
    execKey: 'local', execLabel: '本机', execMode: 'local',
    execIsHome: false, sessions: [shared],
  };
  for (const rows of [
    mergeExecutorSessionBatches([relay, local]),
    mergeExecutorSessionBatches([local, relay]),
  ]) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].execKey, 'local');
    assert.equal(rows[0].execMode, 'local');
  }
});

test('different sessions from different executors remain visible', () => {
  const rows = mergeExecutorSessionBatches([
    {
      execKey: 'local', execLabel: '本机', execMode: 'local',
      execIsHome: true, sessions: [{ id: 'local-1' }],
    },
    {
      execKey: 'relay:user:pc_47', execLabel: 'pc_47', execMode: 'relay',
      execIsHome: false, sessions: [{ id: 'remote-1' }],
    },
  ]);

  assert.deepEqual(rows.map((row) => row.id), ['local-1', 'remote-1']);
});
