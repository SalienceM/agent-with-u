const test = require('node:test');
const assert = require('node:assert/strict');
const { IncrementalSha256, sha256BlobHex } = require('../../.home-test-dist/utils/sha256.js');

test('incremental SHA-256 matches standard vectors across chunk boundaries', () => {
  const encoder = new TextEncoder();
  const hasher = new IncrementalSha256();
  hasher.update(encoder.encode('a'));
  hasher.update(encoder.encode('b'));
  hasher.update(encoder.encode('c'));
  assert.equal(
    hasher.digestHex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );

  assert.equal(
    new IncrementalSha256().digestHex(),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('blob SHA-256 produces the same digest used by the executor manifest', async () => {
  assert.equal(
    await sha256BlobHex(new Blob(['AgentWithU offline'])),
    'b3d21c10db3191d566bbc72275b3ce0f3b0a9acb6d3cc4142809e8cf6d3dcb14',
  );
});
