const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRelativeFilePath,
  resolveFileLink,
  sameWorkspacePath,
} = require('../../.home-test-dist/utils/fileFocus.js');

test('Windows absolute file links resolve inside the current workspace', () => {
  assert.deepEqual(
    resolveFileLink(
      'C:/Users/Test/My%20Repo/src/backend/file.py:204:7',
      'c:\\users\\test\\My Repo',
    ),
    {
      relativePath: 'src/backend/file.py',
      filePath: 'C:/Users/Test/My Repo/src/backend/file.py',
      line: 204,
      column: 7,
    },
  );
});

test('browser-prefixed Windows links remain focusable in a Windows workspace', () => {
  assert.deepEqual(
    resolveFileLink(
      '/C:/Users/Test/My%20Repo/src/hooks/useConfig.ts:292',
      'C:\\Users\\Test\\My Repo',
    ),
    {
      relativePath: 'src/hooks/useConfig.ts',
      filePath: 'C:/Users/Test/My Repo/src/hooks/useConfig.ts',
      line: 292,
      column: undefined,
    },
  );
  assert.equal(
    resolveFileLink('/D:/Other/file.ts:7', 'C:/Users/Test/My Repo'),
    null,
  );
});

test('POSIX, file URI, and relative links resolve without using client OS rules', () => {
  assert.equal(
    resolveFileLink('/srv/agent/repo/src/main.ts#L18C3', '/srv/agent/repo')?.relativePath,
    'src/main.ts',
  );
  assert.equal(
    resolveFileLink('file:///C:/Work/Repo/docs/readme.md#L9', 'C:/Work/Repo')?.relativePath,
    'docs/readme.md',
  );
  assert.equal(
    resolveFileLink('.\\src\\components\\App.tsx:42', 'D:/repo')?.relativePath,
    'src/components/App.tsx',
  );
});

test('web links, escaping paths, and files outside the workspace are not focusable', () => {
  assert.equal(resolveFileLink('https://example.com/a.ts:12', 'C:/repo'), null);
  assert.equal(resolveFileLink('../outside.txt', 'C:/repo'), null);
  assert.equal(resolveFileLink('D:/other/file.ts:4', 'C:/repo'), null);
  assert.equal(normalizeRelativeFilePath('../../outside.txt'), null);
});

test('workspace comparison is case-insensitive only for Windows/UNC paths', () => {
  assert.equal(sameWorkspacePath('C:/Work/Repo/', 'c:\\work\\repo'), true);
  assert.equal(sameWorkspacePath('/Srv/Repo', '/srv/repo'), false);
});
