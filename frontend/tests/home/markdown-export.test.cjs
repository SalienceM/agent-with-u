const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStandaloneMarkdownHtml,
  markdownHtmlFilename,
} = require('../../.home-test-dist/utils/markdownExport.js');

test('markdown filenames become portable html filenames', () => {
  assert.equal(markdownHtmlFilename('WEB_156_INSTALL.md'), 'WEB_156_INSTALL.html');
  assert.equal(markdownHtmlFilename('docs/部署说明.markdown'), '部署说明.html');
  assert.equal(markdownHtmlFilename('unsafe:name.mdx'), 'unsafe_name.html');
});

test('standalone markdown html preserves rendered content and escapes metadata', () => {
  const html = buildStandaloneMarkdownHtml(
    'guide<script>.md',
    '<div class="md-content"><h1>部署指南</h1><table><tr><td>44380</td></tr></table></div>',
  );

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title>guide&lt;script&gt;<\/title>/);
  assert.doesNotMatch(html, /<title>guide<script>/);
  assert.match(html, /<h1 id="awu-md-heading-1" tabindex="-1">部署指南<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /\.md-content pre/);
  assert.match(html, /@media print/);
  assert.match(html, /<main class="awu-markdown-export">/);
  assert.match(html, /class="awu-reader-toc"/);
  assert.match(html, /id="awu-toc-toggle"/);
  assert.match(html, /id="awu-theme-toggle"/);
  assert.match(html, /data-target="awu-md-heading-1"/);
  assert.match(html, /id="awu-md-heading-1" tabindex="-1"/);
  assert.match(html, /agentwithu\.markdownExport\.theme/);
  assert.match(html, /\.awu-markdown-export \.md-content th,/);
  assert.doesNotMatch(html, /\n\s*:root\s*\{/);
  assert.doesNotMatch(html, /\n\s*body\s*\{/);

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 2);
  scripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));
});
