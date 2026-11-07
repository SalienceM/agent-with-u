const test = require('node:test');
const assert = require('node:assert/strict');
const {
  markdownHtmlWithOutline,
  markdownToHtml,
} = require('../../.home-test-dist/utils/markdown.js');

test('GFM tables retain structure, alignment, empty cells and inline formatting', () => {
  const html = markdownToHtml('| Left | Center | Right |\n| :--- | :---: | ---: |\n| **bold** | `x` | [link](https://example.test) |\n| a\\|b | | end |');
  assert.equal((html.match(/class="md-table-wrap"/g) || []).length, 1);
  assert.match(html, /role="region"[^>]*tabindex="0"><table class="md-table">/);
  for (const align of ['left', 'center', 'right']) {
    assert.match(html, new RegExp(`<th align="${align}">`));
    assert.match(html, new RegExp(`<td align="${align}">`));
  }
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="md-code-inline">x<\/code>/);
  assert.match(html, /a\|b/);
  assert.match(html, /<td align="center"><\/td>/);
});

test('link and image metadata preserve entities without attribute injection', () => {
  const html = markdownToHtml('[中文](<https://example.test/a b?q=1&x=2> \'A "quote" &amp; B\')\n\n![A "quote" &amp; B](https://example.test/a.png \'图 "标题"\')');
  assert.match(html, /href="https:\/\/example.test\/a b\?q=1&amp;x=2"/);
  assert.match(html, /title="A &quot;quote&quot; &amp; B"/);
  assert.match(html, /alt="A &quot;quote&quot; &amp; B" title="图 &quot;标题&quot;"/);
  assert.doesNotMatch(html, /&amp;(?:amp|quot);/);
  const skill = markdownToHtml('![原图](http://127.0.0.1:9999/api/skill-images/fixture.png "说明")');
  assert.match(skill, /data-skill-file="fixture.png" alt="原图" title="说明"/);
  assert.doesNotMatch(skill, /src=|127\.0\.0\.1/);
});

test('code language metadata stays outside copyable code and unknown languages escape', () => {
  const html = markdownToHtml('```js title="demo"\nconst answer = 42;\n```');
  assert.match(html, /<span class="md-code-lang">js title=&quot;demo&quot;<\/span><code class="hljs">/);
  assert.match(html, /class="hljs-keyword">const/);
  const unknown = markdownToHtml('```unknown <span>info</span>\n<unsafe> & "text"\n```');
  assert.match(unknown, /unknown &lt;span&gt;info&lt;\/span&gt;/);
  assert.match(unknown, /<code class="hljs">&lt;unsafe&gt; &amp; &quot;text&quot;<\/code>/);
});

test('highlight failure degrades only that code block', () => {
  const hljs = require('highlight.js');
  const original = hljs.highlight;
  try {
    hljs.highlight = () => { throw new Error('synthetic highlighter failure'); };
    const html = markdownToHtml('# Before\n\n```js\nconst x = "<tag>";\n```\n\n**after**');
    assert.match(html, /<h1/);
    assert.match(html, /const x = &quot;&lt;tag&gt;&quot;;/);
    assert.match(html, /<strong>after<\/strong>/);
    assert.doesNotMatch(html, /md-render-warning/);
  } finally { hljs.highlight = original; }
});

test('standard syntax and streaming prefixes keep final structure', () => {
  const source = '# Heading\n\n3. third\n4. fourth\n   - nested\n\n- [x] done\n- [ ] pending\n\n> first\n>\n> second\n\n**bold** *italic* ~~old~~\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```text\n  indent\n```\n\n[line](https://example.test)\nnext';
  for (let i = 1; i < source.length; i += 7) assert.doesNotThrow(() => markdownToHtml(source.slice(0, i)));
  const html = markdownToHtml(source);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /fourth<ul>/);
  assert.match(html, /input checked="" disabled="" type="checkbox"/);
  assert.match(html, /<blockquote class="md-blockquote"><p>first<\/p>\n<p>second<\/p>/);
  assert.match(html, /<strong>bold<\/strong> <em>italic<\/em> <del>old<\/del>/);
  assert.match(html, /<hr class="md-hr">/);
  assert.match(html, /<br>next/);
  assert.equal(markdownToHtml(JSON.parse(JSON.stringify(source))), html);
});

test('parser exception retains a bounded escaped fallback', () => {
  const { marked } = require('marked');
  const original = marked.parse;
  const originalError = console.error;
  try {
    marked.parse = () => { throw new Error('synthetic parser failure'); };
    console.error = () => {};
    const html = markdownToHtml('<script>example</script>' + 'x'.repeat(210000));
    assert.match(html, /md-render-warning/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /内容过长/);
    assert.ok(html.length < 201000);
    assert.doesNotMatch(html, /<script>/);
  } finally { marked.parse = original; console.error = originalError; }
});

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

test('protected inline images retain optional titles and remain literal in code', () => {
  const source = '![A &amp; B](data:image/png;base64,AAAA "说明 (含括号) \\"引号\\"")';
  const html = markdownToHtml(source);
  assert.match(html, /src="data:image\/png;base64,AAAA" alt="A &amp; B" title="说明 \(含括号\) &quot;引号&quot;"/);
  const code = markdownToHtml('```text\n' + source + '\n```');
  assert.doesNotMatch(code, /<img/);
  assert.match(code, /!\[A &amp;amp; B\]/);
  assert.match(code, /data:image\/png;base64,AAAA/);
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
