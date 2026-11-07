const test = require('node:test');
const assert = require('node:assert/strict');
const { HARNESS_IMAGE_CONTRACT: contract, matchesHarnessImageExtension: matches } =
  require('../../.home-test-dist/types/harnessImages.js');

test('Harness static budget is immutable and never asserts model support', () => {
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.limits), true);
  assert.equal(Object.isFrozen(contract.formats), true);
  assert.deepEqual(contract.formats, ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(contract.supported, undefined);
  assert.equal(contract.admitted, undefined);
  assert.equal(contract.limits.maxFrameBytes, 16 * 1024 * 1024);
});

test('Harness extension matching rejects legacy, wrong types and every mixed limit', () => {
  const extension = { version: contract.version, bridgeVersion: contract.bridgeVersion, limits: { ...contract.limits } };
  assert.equal(matches(extension), true);
  for (const value of [null, undefined, true, {}, { ...extension, version: true },
    { ...extension, version: 2 }, { ...extension, bridgeVersion: 2 },
    { ...extension, limits: null }, { ...extension, limits: { ...extension.limits, extra: 1 } }]) {
    assert.equal(matches(value), false);
  }
  for (const key of Object.keys(contract.limits)) {
    assert.equal(matches({ ...extension, limits: { ...extension.limits, [key]: extension.limits[key] + 1 } }), false);
    assert.equal(matches({ ...extension, limits: { ...extension.limits, [key]: String(extension.limits[key]) } }), false);
    const missing = { ...extension.limits };
    delete missing[key];
    assert.equal(matches({ ...extension, limits: missing }), false);
  }
});
