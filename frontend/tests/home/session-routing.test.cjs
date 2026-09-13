const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SessionRoutingCache, mergeSessionRouting } = require('../../.home-test-dist/utils/sessionRouting.js');

test('partial Session updates do not reset manual ownership', () => {
  const current = { id: 'manual', sessionType: 'loop', loopControlMode: 'manual' };
  for (const loopControlMode of [undefined, null, '']) {
    assert.equal(mergeSessionRouting(current, { title: 'updated', loopControlMode }).loopControlMode, 'manual');
  }
  assert.equal(mergeSessionRouting(current, { loopControlMode: 'loop' }).loopControlMode, 'loop');
});

test('successful metadata loads notify every retained consumer and keep newer event ownership', () => {
  const cache = new SessionRoutingCache();
  const seen = [];
  const off = cache.subscribe('a', value => seen.push(value));
  cache.update('a', { sessionType: 'loop', loopControlMode: 'loop' });
  const revision = cache.revision('a');
  cache.update('a', { loopControlMode: 'manual' });
  cache.loaded('a', { title: 'Loaded title', loopControlMode: 'loop' }, revision);
  assert.equal(seen.at(-1).loopControlMode, 'manual');
  assert.equal(seen.at(-1).title, 'Loaded title');
  assert.equal(cache.get('a').title, 'Loaded title');
  cache.clear();
  assert.equal(seen.at(-1), null);
  off();
  const length = seen.length;
  cache.update('a', { title: 'ignored' });
  assert.equal(seen.length, length);
});

test('delayed metadata response cannot overwrite a takeover event', () => {
  const cache = new SessionRoutingCache();
  cache.update('session-A', { sessionType: 'loop', loopControlMode: 'loop' });
  const revision = cache.revision('session-A');
  cache.update('session-A', { loopControlMode: 'manual' });
  assert.equal(cache.loaded('session-A', { loopControlMode: 'loop' }, revision).loopControlMode, 'manual');
  cache.update('session-B', { loopControlMode: 'loop' });
  assert.equal(cache.get('session-A').loopControlMode, 'manual');
  const freshRevision = cache.revision('session-A');
  assert.equal(cache.loaded('session-A', { loopControlMode: 'loop' }, freshRevision).loopControlMode, 'loop');
  cache.clear();
  assert.equal(cache.get('session-A'), null);
});
