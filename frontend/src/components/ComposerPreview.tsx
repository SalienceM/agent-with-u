import React, { memo, useDeferredValue, useMemo } from 'react';
import { Marked } from 'marked';
import { MarkdownStyles } from './MarkdownStyles';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 草稿预览只展示排版；不执行粘贴的 HTML，也不因输入中的链接/图片发出请求。
const renderer = new Marked({ gfm: true, breaks: true, renderer: {
  html: text => escapeHtml(text),
  link: (_href, _title, text) => `<span class="md-link">${text}</span>`,
  image: (_href, _title, text) => `<span class="md-code-inline">图片：${escapeHtml(text || '未命名')}</span>`,
  code: (text, info) => `<pre class="md-pre">${info ? `<span class="md-code-lang">${escapeHtml(info)}</span>` : ''}<code class="hljs">${escapeHtml(text)}</code></pre>`,
  codespan: text => `<code class="md-code-inline">${text}</code>`,
  blockquote: text => `<blockquote class="md-blockquote">${text}</blockquote>`,
  hr: () => '<hr class="md-hr">',
  table: (head, body) => `<div class="md-table-wrap"><table class="md-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`,
} });

export const ComposerPreview = memo(function ComposerPreview({ content, padding }: { content: string; padding: number }) {
  const deferred = useDeferredValue(content);
  const html = useMemo(() => {
    try { return renderer.parse(deferred) as string; }
    catch { return `<pre style="white-space:pre-wrap">${escapeHtml(deferred)}</pre>`; }
  }, [deferred]);
  return <div role="region" aria-label="消息排版预览" tabIndex={0} style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
    <MarkdownStyles />
    <div style={{ maxWidth: 800, margin: '0 auto', padding, boxSizing: 'border-box', lineHeight: 1.85 }}>
      {content.trim() ? <div className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
        : <p style={{ color: 'var(--theme-text-muted, #687487)' }}>开始写下你的想法，排版会显示在这里。</p>}
    </div>
  </div>;
});
