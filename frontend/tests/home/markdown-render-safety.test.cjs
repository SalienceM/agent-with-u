const test = require('node:test');
const assert = require('node:assert/strict');
const {
  markdownHtmlWithOutline,
  markdownToHtml,
} = require('../../.home-test-dist/utils/markdown.js');

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

test('document outline injects unique anchors and keeps rendered heading text', () => {
  const rendered = markdownHtmlWithOutline(markdownToHtml(
    '# Overview\n\n## **Install** & use\n\n## **Install** & use',
  ));

  assert.deepEqual(rendered.outline.map(({ id, level, title }) => ({ id, level, title })), [
    { id: 'awu-md-heading-1', level: 1, title: 'Overview' },
    { id: 'awu-md-heading-2', level: 2, title: 'Install & use' },
    { id: 'awu-md-heading-3', level: 2, title: 'Install & use' },
  ]);
  assert.match(rendered.html, /id="awu-md-heading-1" tabindex="-1"/);
  assert.match(rendered.html, /id="awu-md-heading-3" tabindex="-1"/);
});
