const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGitDirectoryStatuses } = require('../../.home-test-dist/utils/fileTreeGit.js');

test('Git directory badges aggregate once, respect priority and whole path boundaries', () => {
  const files = {
    'src/a.txt': { status: 'modified', staged: false },
    'src/deep/b.txt': { status: 'deleted', staged: true },
    'src/deep/c.txt': { status: 'conflicted', staged: true },
    'src-extra/a.txt': { status: 'added', staged: true },
    'root.txt': { status: 'untracked', staged: false },
  };
  const result = buildGitDirectoryStatuses(files);
  assert.equal(result.get('src').status, 'conflicted');
  assert.equal(result.get('src/deep').status, 'conflicted');
  assert.equal(result.get('src-extra').status, 'added');
  assert.equal(result.size, 3);
  assert.equal(buildGitDirectoryStatuses({}).size, 0);
  assert.equal(buildGitDirectoryStatuses({ 'src/new.txt': files['root.txt'] }).get('src').status, 'untracked');
});
