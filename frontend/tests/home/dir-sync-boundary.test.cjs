const test = require('node:test');
const assert = require('node:assert/strict');
const { filterGitMetadata, isGitMetadataPath, isIgnored } = require('../../.home-test-dist/utils/dirSyncPolicy.js');

test('git metadata is excluded by default and only explicit opt-in enables it', () => {
  assert.equal(isGitMetadataPath('.git/config'), true);
  assert.equal(isGitMetadataPath('nested/.git/HEAD'), true);
  assert.equal(isGitMetadataPath('.gitignore'), false);
  assert.equal(isIgnored('.git/config', []), true);
  assert.equal(isIgnored('.git/config', [], true), false);
  assert.equal(isIgnored('.git/config', ['.git'], true), false);
});

test('ordinary ignore rules remain unchanged outside .git', () => {
  assert.equal(isIgnored('node_modules/react/index.js', ['node_modules']), true);
  assert.equal(isIgnored('src/app.ts', ['node_modules']), false);
});

test('old executor manifests are filtered again on the client boundary', () => {
  const files = {
    '.git/HEAD': { size: 10 },
    'nested/.git/config': { size: 20 },
    '.gitignore': { size: 30 },
    'src/app.ts': { size: 40 },
  };
  assert.deepEqual(filterGitMetadata(files), {
    '.gitignore': { size: 30 },
    'src/app.ts': { size: 40 },
  });
  assert.equal(filterGitMetadata(files, true), files);
});
