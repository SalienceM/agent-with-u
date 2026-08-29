const test = require('node:test');
const assert = require('node:assert/strict');
const { markdownToHtml } = require('../../.home-test-dist/utils/markdown.js');

test('large inline images bypass marked tokenization without losing the image', () => {
  // marked v9 本身在约 8MB 的 data URI 上会触发 Maximum call stack size exceeded。
  const payload = 'A'.repeat(8 * 1024 * 1024);
  const html = markdownToHtml(
    `before\n\n![generated](data:image/png;base64,${payload})\n\nafter`,
  );

  assert.match(html, /before/);
  assert.match(html, /after/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /alt="generated"/);
  assert.doesNotMatch(html, /AWUINLINEIMAGEPLACEHOLDER/);
});

test('malformed inline image payload is removed before markdown parsing', () => {
  const html = markdownToHtml(
    `before\n\n![broken](data:image/png;base64,${'A'.repeat(256 * 1024)}`,
  );

  assert.match(html, /内联图片数据不完整/);
  assert.doesNotMatch(html, /A{1000}/);
});
