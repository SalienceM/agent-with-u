const test = require('node:test');
const assert = require('node:assert/strict');
const { previewFileUrl, previewRelativePath, resolvePreviewUrl, previewMime } = require('../../.home-test-dist/utils/htmlPreview.js');

test('HTML relative assets resolve against executor workspace, not controller origin', () => {
  const base = previewFileUrl('pages/页面.html');
  assert.equal(previewRelativePath(resolvePreviewUrl('../assets/图片.svg?v=1', base, 'C:/project')), 'assets/图片.svg');
  assert.equal(previewRelativePath(resolvePreviewUrl('/css/main.css', base, 'C:/project')), 'css/main.css');
  assert.equal(resolvePreviewUrl('../assets/', base, 'C:/project'), previewFileUrl('assets/'));
});
test('HTML absolute file links must belong to the original executor root', () => {
  const base = previewFileUrl('index.html');
  assert.equal(previewRelativePath(resolvePreviewUrl('file:///C:/project/docs/a.html', base, 'C:\\project')), 'docs/a.html');
  assert.equal(previewRelativePath(resolvePreviewUrl('c:\\PROJECT\\docs\\a.html', base, 'C:/project')), 'docs/a.html');
  assert.throws(() => resolvePreviewUrl('file:///C:/other/private.html', base, 'C:/project'));
  assert.throws(() => resolvePreviewUrl('file://remote/share/private.html', base, 'C:/project'));
});
test('HTML read bridge rejects traversal, hidden configuration, keys, foreign origins and separators', () => {
  const base = previewFileUrl('pages/index.html');
  for (const path of ['.env', '.git/config', 'config/private.key', 'x\\..\\secret', 'a\u0000b', 'C:/Windows/file']) {
    assert.throws(() => previewRelativePath(previewFileUrl(path)), path);
  }
  assert.throws(() => resolvePreviewUrl('../../outside.html', base, '/srv/project'));
  assert.throws(() => resolvePreviewUrl('%2e%2e/%2e%2e/outside.html', base, '/srv/project'));
  assert.throws(() => previewRelativePath('https://controller.example/api/config'));
  assert.equal(previewMime('scripts/main.mjs?v=1'), 'text/javascript');
});
