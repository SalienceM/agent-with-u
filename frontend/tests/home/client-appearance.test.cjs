const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CLIENT_APPEARANCE,
  clientAppearanceStorageKey,
  loadClientAppearance,
  resolveClientAppearance,
  saveClientAppearance,
  stripClientAppearance,
} = require('../../.home-test-dist/utils/clientAppearance.js');

class MemoryMetadataStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

class MemoryImageStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async set(key, value) { this.values.set(key, value); }
  async remove(key) { this.values.delete(key); }
}

function memoryStorage() {
  return {
    metadata: new MemoryMetadataStorage(),
    images: new MemoryImageStorage(),
  };
}

const alice = { mode: 'relay', userId: 'user-alice' };
const bob = { mode: 'relay', userId: 'user-bob' };

test('two users on one executor keep independent controller-side appearances', async () => {
  const storage = memoryStorage();
  const aliceAppearance = {
    theme: 'cyber', bgImage: 'data:image/png;base64,alice', bgOpacity: 0.25, uiOpacity: 0.8,
  };
  const bobAppearance = {
    theme: 'light', bgImage: 'data:image/png;base64,bob', bgOpacity: 0.65, uiOpacity: 1,
  };

  await saveClientAppearance(alice, aliceAppearance, storage);
  await saveClientAppearance(bob, bobAppearance, storage);

  assert.notEqual(clientAppearanceStorageKey(alice), clientAppearanceStorageKey(bob));
  assert.deepEqual(await loadClientAppearance(alice, storage), aliceAppearance);
  assert.deepEqual(await loadClientAppearance(bob, storage), bobAppearance);
});

test('metadata-only changes preserve the current user background without touching another user', async () => {
  const storage = memoryStorage();
  await saveClientAppearance(alice, {
    theme: 'dark', bgImage: 'data:image/png;base64,alice', bgOpacity: 0.3, uiOpacity: 1,
  }, storage);
  await saveClientAppearance(bob, {
    theme: 'classic', bgImage: 'data:image/png;base64,bob', bgOpacity: 0.4, uiOpacity: 0.9,
  }, storage);

  await saveClientAppearance(alice, {
    theme: 'midnight', bgImage: 'this-value-must-not-rewrite-the-image', bgOpacity: 0.7, uiOpacity: 0.6,
  }, { ...storage, backgroundChanged: false });

  assert.deepEqual(await loadClientAppearance(alice, storage), {
    theme: 'midnight', bgImage: 'data:image/png;base64,alice', bgOpacity: 0.7, uiOpacity: 0.6,
  });
  assert.equal((await loadClientAppearance(bob, storage)).bgImage, 'data:image/png;base64,bob');
});

test('executor payloads never contain controller appearance fields', () => {
  assert.deepEqual(stripClientAppearance({
    fontSize: 16,
    renderMarkdown: true,
    theme: 'cyber',
    bgImage: 'data:image/png;base64,secret',
    bgOpacity: 0.2,
    uiOpacity: 0.7,
  }), {
    fontSize: 16,
    renderMarkdown: true,
  });
});

test('legacy executor appearance migrates once and never replaces an existing user preference', () => {
  const firstLoad = resolveClientAppearance(null, {
    theme: 'ocean', bgImage: 'legacy-image', bgOpacity: 4, uiOpacity: 0,
  });
  assert.equal(firstLoad.migrated, true);
  assert.deepEqual(firstLoad.appearance, {
    theme: 'midnight', bgImage: 'legacy-image', bgOpacity: 1, uiOpacity: 0.1,
  });

  const existing = { ...DEFAULT_CLIENT_APPEARANCE, theme: 'classic', uiOpacity: 0.75 };
  const laterLoad = resolveClientAppearance(existing, {
    theme: 'cyber', bgImage: 'other-user-image', bgOpacity: 0.9, uiOpacity: 0.9,
  });
  assert.equal(laterLoad.migrated, false);
  assert.deepEqual(laterLoad.appearance, existing);
});
