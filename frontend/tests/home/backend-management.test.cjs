const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sessionsForBackendExecutor,
} = require('../../.home-test-dist/utils/backendManagement.js');

test('remote Backend deletion only considers sessions on that executor', () => {
  const sessions = [
    { id: 'local-legacy', backendId: 'shared' },
    { id: 'local-explicit', execKey: 'local', backendId: 'shared' },
    { id: 'remote-a', execKey: 'relay:user:node-a', backendId: 'shared' },
    { id: 'remote-b', execKey: 'relay:user:node-b', backendId: 'shared' },
  ];

  assert.deepEqual(
    sessionsForBackendExecutor(sessions, 'relay:user:node-a', 'local').map((item) => item.id),
    ['remote-a'],
  );
  assert.deepEqual(
    sessionsForBackendExecutor(sessions, 'local', 'local').map((item) => item.id),
    ['local-legacy', 'local-explicit'],
  );
});
