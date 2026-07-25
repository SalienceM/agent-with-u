const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDashboardViewModel, DASHBOARD_MODULES } = require('../../.home-test-dist/home/dashboardModel.js');
const {
  mapSettledWithConcurrency,
  mergeSuccessfulSnapshots,
} = require('../../.home-test-dist/home/dashboardPerformance.js');
const { normalizeDashboardPreferences } = require('../../.home-test-dist/home/dashboardPreferences.js');

function snapshot(overrides = {}) {
  return {
    sessions: [],
    loopStates: {},
    taskStates: {},
    backends: [{ id: 'primary', label: 'Primary', type: 'codex-office' }],
    executors: [{ key: 'local', label: 'Local', connected: true, isHome: true }],
    activeBackendId: 'primary',
    connected: true,
    streamingSessionIds: new Set(),
    completedSessionIds: new Set(),
    activity: [],
    loadState: 'ready',
    updatedAt: Date.now(),
    ...overrides,
  };
}

test('large snapshot stays bounded while metrics retain the full counts', () => {
  const sessions = Array.from({ length: 250 }, (_, index) => ({
    id: `s-${index}`,
    title: `Session ${index}`,
    updatedAt: index,
    sessionType: index < 80 ? 'loop' : 'normal',
  }));
  const loopStates = Object.fromEntries(sessions.slice(0, 80).map((session, index) => [
    session.id,
    {
      sessionId: session.id,
      stage: index % 3 === 0 ? 'loopout' : 'loopexecute',
      running: index < 15,
      updatedAt: index,
      latestScore: 70 + (index % 20),
    },
  ]));
  const taskStates = Object.fromEntries(sessions.slice(80).map((session, sessionIndex) => [
    session.id,
    {
      sessionId: session.id,
      seqTasks: Array.from({ length: 120 }, (_, taskIndex) => ({
        id: `${session.id}-t-${taskIndex}`,
        text: `Task ${taskIndex}`,
        status: taskIndex % 5 === 0 ? 'done' : 'pending',
        updatedAt: sessionIndex * 1000 + taskIndex,
      })),
    },
  ]));
  const activity = Array.from({ length: 500 }, (_, index) => ({
    id: `event-${index}`,
    at: index,
    kind: 'system',
    title: `Event ${index}`,
  }));

  const view = buildDashboardViewModel(snapshot({ sessions, loopStates, taskStates, activity }));
  const expectedPending = 170 * 96;

  assert.equal(view.sessions.length, 8);
  assert.equal(view.loops.length, 6);
  assert.equal(view.tasks.length, 8);
  assert.equal(view.activity.length, 50);
  assert.equal(view.metrics.find((metric) => metric.id === 'pending-tasks').value, expectedPending);
  assert.equal(view.tasks[0].id, 's-249-t-119');
});

test('navigation prioritizes resumable loop and maps task actions to its session', () => {
  const view = buildDashboardViewModel(snapshot({
    sessions: [
      { id: 'chat', title: 'Chat', updatedAt: 10 },
      { id: 'loop', title: 'Loop', updatedAt: 5, sessionType: 'loop' },
    ],
    loopStates: { loop: { sessionId: 'loop', stage: 'loopexecute', resumable: true } },
    taskStates: {
      chat: { sessionId: 'chat', seqTasks: [{ id: 'task', text: 'Next', status: 'pending' }] },
    },
  }));

  assert.deepEqual(view.quickActions.find((action) => action.id === 'resume-work').destination, {
    kind: 'loop',
    sessionId: 'loop',
  });
  assert.deepEqual(view.quickActions.find((action) => action.id === 'open-tasks').destination, {
    kind: 'tasks',
    sessionId: 'chat',
  });
  assert.deepEqual(
    Object.fromEntries(view.quickActions.map((action) => [action.id, action.destination])),
    {
      'new-chat': { kind: 'new-session', sessionType: 'normal' },
      'new-loop': { kind: 'new-session', sessionType: 'loop' },
      'resume-work': { kind: 'loop', sessionId: 'loop' },
      'open-tasks': { kind: 'tasks', sessionId: 'chat' },
      'manage-models': { kind: 'settings', section: 'models' },
    },
  );
});

test('disconnected and stale snapshots remain explicit without inventing online data', () => {
  const view = buildDashboardViewModel(snapshot({
    connected: false,
    loadState: 'stale',
    errorMessage: '服务连接已断开，当前显示最后一次成功同步的数据。',
    executors: [{ key: 'local', label: 'Local', connected: false, isHome: true }],
  }));
  const connection = view.globalStatus.find((item) => item.id === 'connection');

  assert.equal(view.loadState, 'stale');
  assert.equal(view.errorMessage, '服务连接已断开，当前显示最后一次成功同步的数据。');
  assert.equal(connection.value, '已断开');
  assert.equal(connection.tone, 'danger');
  assert.equal(view.metrics.find((metric) => metric.id === 'online-executors').value, 0);
  assert.equal(view.modelStatus.detail.includes('等待连接'), true);
});

test('preference normalization repairs corrupt order and protects critical modules', () => {
  const preferences = normalizeDashboardPreferences({
    density: 'invalid',
    order: ['activity', 'tasks', 'unknown', 'global-status'],
    visible: { 'global-status': false, 'quick-actions': false, loops: false, tasks: false, activity: false },
  });
  const protectedIds = DASHBOARD_MODULES.filter((module) => module.minimumVisible).map((module) => module.id);

  assert.equal(preferences.density, 'comfortable');
  assert.deepEqual(preferences.order.slice(0, protectedIds.length).sort(), [...protectedIds].sort());
  assert.equal(new Set(preferences.order).size, DASHBOARD_MODULES.length);
  for (const id of protectedIds) assert.equal(preferences.visible[id], true);
  assert.equal(preferences.visible.activity, false);
});

test('limited mapper preserves result order and never exceeds its concurrency budget', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapSettledWithConcurrency(
    Array.from({ length: 24 }, (_, index) => index),
    3,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      active -= 1;
      if (value === 7) throw new Error('expected');
      return value * 2;
    },
  );

  assert.equal(peak, 3);
  assert.equal(results.length, 24);
  assert.equal(results[7].status, 'rejected');
  assert.deepEqual(results[12], { status: 'fulfilled', value: 24 });
});

test('partial refresh preserves failed sources and drops sources no longer in inventory', () => {
  const previous = {
    healthy: { value: 'old healthy' },
    failed: { value: 'last successful snapshot' },
    removed: { value: 'obsolete' },
  };
  const merged = mergeSuccessfulSnapshots(
    previous,
    ['healthy', 'failed', 'new'],
    {
      healthy: { value: 'new healthy' },
      new: { value: 'new source' },
    },
  );

  assert.deepEqual(merged, {
    healthy: { value: 'new healthy' },
    failed: { value: 'last successful snapshot' },
    new: { value: 'new source' },
  });
});
