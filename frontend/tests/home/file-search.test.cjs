const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fileSearchScore,
  rankFileSearchPaths,
} = require('../../.home-test-dist/utils/fileSearch.js');

test('file search prioritizes filename matches and supports fuzzy Quick Open input', () => {
  const ranked = rankFileSearchPaths([
    'docs/file-tree-panel.md',
    'frontend/src/components/FileTreePanel.tsx',
    'frontend/src/components/RepoPanel.tsx',
  ], 'ftpnltsx');

  assert.equal(ranked.results[0].path, 'frontend/src/components/FileTreePanel.tsx');
  assert.equal(fileSearchScore('src/FileTreePanel.tsx', 'FILETREE'), fileSearchScore('src/FileTreePanel.tsx', 'filetree'));
});

test('file search understands path fragments, deduplicates, and enforces result limits', () => {
  const ranked = rankFileSearchPaths([
    'src/backend/bridge_ws.py',
    'src/backend/bridge_ws.py',
    'src/backend/session_store.py',
    'frontend/src/api.ts',
  ], 'src back', 1);

  assert.equal(ranked.matched, 2);
  assert.equal(ranked.results.length, 1);
  assert.equal(ranked.truncated, true);
  assert.equal(fileSearchScore('frontend/src/api.ts', 'no-such-file'), null);
});
