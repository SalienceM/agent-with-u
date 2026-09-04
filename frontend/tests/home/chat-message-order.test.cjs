const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeAuthoritativeChatMessages,
  mergeCachedHistoryWithStreamTail,
} = require('../../.home-test-dist/utils/chatMessageOrder.js');

const msg = (id, role = 'assistant', extra = {}) => ({
  id,
  role,
  content: id,
  streaming: false,
  ...extra,
});

test('authoritative load removes stale completed bubbles instead of appending them', () => {
  const loaded = [msg('a'), msg('c'), msg('d')];
  const staleCache = [msg('a'), msg('b'), msg('c'), msg('d')];

  const merged = mergeAuthoritativeChatMessages(loaded, staleCache, new Set());

  assert.deepEqual(merged.map((message) => message.id), ['a', 'c', 'd']);
});

test('messages sent while loadSession is in flight remain until the backend confirms them', () => {
  const loaded = [msg('old')];
  const current = [
    msg('old'),
    msg('new-user', 'user'),
    msg('new-assistant', 'assistant', {
      content: '',
      streaming: true,
      waitingForFirstDelta: true,
    }),
  ];
  const pending = new Set(['new-user', 'new-assistant']);

  const merged = mergeAuthoritativeChatMessages(loaded, current, pending);

  assert.deepEqual(merged.map((message) => message.id), [
    'old',
    'new-user',
    'new-assistant',
  ]);
});

test('backend order wins once it returns the same optimistic ids', () => {
  const loaded = [msg('old'), msg('new-user', 'user'), msg('new-assistant')];
  const current = [msg('old'), msg('new-assistant'), msg('new-user', 'user')];

  const merged = mergeAuthoritativeChatMessages(
    loaded,
    current,
    new Set(['new-user', 'new-assistant']),
  );

  assert.deepEqual(merged.map((message) => message.id), [
    'old',
    'new-user',
    'new-assistant',
  ]);
});

test('a pending follow-up keeps its position before the authoritative assistant', () => {
  const loaded = [msg('old'), msg('running-assistant', 'assistant', { streaming: true })];
  const current = [
    msg('old'),
    msg('follow-up', 'user'),
    msg('running-assistant', 'assistant', { streaming: true }),
  ];

  const merged = mergeAuthoritativeChatMessages(
    loaded,
    current,
    new Set(['follow-up']),
  );

  assert.deepEqual(merged.map((message) => message.id), [
    'old',
    'follow-up',
    'running-assistant',
  ]);
});

test('completed stream tail never guesses a new position, active tail may append', () => {
  const cached = [msg('a'), msg('c')];
  const completedTail = msg('b');
  const activeTail = msg('live', 'assistant', { streaming: true });

  assert.deepEqual(
    mergeCachedHistoryWithStreamTail(cached, completedTail, false).map((message) => message.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    mergeCachedHistoryWithStreamTail(cached, activeTail, true).map((message) => message.id),
    ['a', 'c', 'live'],
  );
});

test('completed stream tail replaces the cached copy in place', () => {
  const cached = [msg('a'), msg('b', 'assistant', { content: 'stale' }), msg('c')];
  const completedTail = msg('b', 'assistant', { content: 'final' });

  const merged = mergeCachedHistoryWithStreamTail(cached, completedTail, false);

  assert.deepEqual(merged.map((message) => message.id), ['a', 'b', 'c']);
  assert.equal(merged[1].content, 'final');
});
