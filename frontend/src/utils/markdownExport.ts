function sourceLeaf(sourceName: string): string {
  return sourceName.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'document.md';
}

function withoutMarkdownExtension(sourceName: string): string {
  return sourceLeaf(sourceName).replace(/\.(?:md|markdown|mdx)$/i, '') || 'document';
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
}

/** 将 Markdown 源文件名转换为适合客户端保存的 HTML 文件名。 */
export function markdownHtmlFilename(sourceName: string): string {
  const safeStem = withoutMarkdownExtension(sourceName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    || 'document';
  return `${safeStem}.html`;
}

/**
 * 把站内已经渲染好的 Markdown HTML 包装成可脱离 AgentWithU 独立打开、
 * 导入知识库或发送给他人的完整 HTML 文档。
 */
export function buildStandaloneMarkdownHtml(sourceName: string, renderedBody: string): string {
  const title = escapeHtmlText(withoutMarkdownExtension(sourceName));
  const source = escapeHtmlText(sourceLeaf(sourceName));
  return `<!doctype html>
<html lang="zh-CN" class="awu-export-root">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="AgentWithU Markdown Preview">
  <meta name="source-file" content="${source}">
  <title>${title}</title>
  <style>
    /*
     * 所有内容样式都限定在 awu-markdown-export 内。
     * Trilium 等“渲染笔记”会把文档样式合入宿主页；不能使用 :root、body、
     * --text 这类全局选择器/变量，否则会污染宿主 UI，也容易被宿主表格样式覆盖。
     */
    html.awu-export-root {
      color-scheme: light dark;
      background: #f6f8fa;
    }
    body.awu-export-body {
      margin: 0;
      background: #f6f8fa;
    }
    .awu-markdown-export {
      --awu-paper-bg: #ffffff;
      --awu-text: #1f2328;
      --awu-muted: #59636e;
      --awu-border: #d0d7de;
      --awu-soft-bg: #f6f8fa;
      --awu-code-bg: #f6f8fa;
      --awu-accent: #0969da;
      width: min(980px, calc(100% - 32px));
      min-height: calc(100vh - 40px);
      margin: 20px auto;
      padding: clamp(24px, 5vw, 56px);
      color: var(--awu-text) !important;
      background: var(--awu-paper-bg);
      border: 1px solid var(--awu-border);
      box-shadow: 0 12px 36px rgba(31, 35, 40, .08);
      font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
        "Microsoft YaHei", Arial, sans-serif;
      overflow-wrap: anywhere;
      isolation: isolate;
    }
    .awu-markdown-export, .awu-markdown-export * { box-sizing: border-box; }
    .awu-markdown-export .md-content { line-height: 1.7; color: var(--awu-text) !important; }
    .awu-markdown-export .md-content p,
    .awu-markdown-export .md-content li,
    .awu-markdown-export .md-content dt,
    .awu-markdown-export .md-content dd,
    .awu-markdown-export .md-content strong,
    .awu-markdown-export .md-content em,
    .awu-markdown-export .md-content table,
    .awu-markdown-export .md-content thead,
    .awu-markdown-export .md-content tbody,
    .awu-markdown-export .md-content tr,
    .awu-markdown-export .md-content th,
    .awu-markdown-export .md-content td {
      color: var(--awu-text) !important;
    }
    .awu-markdown-export .md-content h1,
    .awu-markdown-export .md-content h2,
    .awu-markdown-export .md-content h3,
    .awu-markdown-export .md-content h4,
    .awu-markdown-export .md-content h5,
    .awu-markdown-export .md-content h6 {
      margin: 1.35em 0 .55em;
      line-height: 1.28;
      color: var(--awu-text) !important;
    }
    .awu-markdown-export .md-content h1 { margin-top: 0; font-size: 2em; border-bottom: 1px solid var(--awu-border); padding-bottom: .35em; }
    .awu-markdown-export .md-content h2 { font-size: 1.5em; border-bottom: 1px solid var(--awu-border); padding-bottom: .28em; }
    .awu-markdown-export .md-content h3 { font-size: 1.22em; }
    .awu-markdown-export .md-content p { margin: .75em 0; }
    .awu-markdown-export .md-content ul,
    .awu-markdown-export .md-content ol { padding-left: 1.8em; }
    .awu-markdown-export .md-content li + li { margin-top: .28em; }
    .awu-markdown-export .md-content a { color: var(--awu-accent) !important; text-decoration: none; }
    .awu-markdown-export .md-content a:hover { text-decoration: underline; }
    .awu-markdown-export .md-content img { display: block; max-width: 100%; height: auto; margin: 1em auto; }
    .awu-markdown-export .md-content hr { height: 1px; margin: 2em 0; border: 0; background: var(--awu-border); }
    .awu-markdown-export .md-content blockquote {
      margin: 1em 0;
      padding: .3em 1em;
      color: var(--awu-muted) !important;
      border-left: 4px solid var(--awu-border);
      background: var(--awu-soft-bg);
    }
    .awu-markdown-export .md-content blockquote p { color: var(--awu-muted) !important; }
    .awu-markdown-export .md-content table { width: 100%; margin: 1em 0; border-collapse: collapse; display: block; overflow-x: auto; }
    .awu-markdown-export .md-content th,
    .awu-markdown-export .md-content td {
      padding: .55em .8em;
      color: var(--awu-text) !important;
      border: 1px solid var(--awu-border);
      text-align: left;
    }
    .awu-markdown-export .md-content th { background: var(--awu-soft-bg); font-weight: 650; }
    .awu-markdown-export .md-content tr:nth-child(even) td { background: color-mix(in srgb, var(--awu-soft-bg) 55%, transparent); }
    .awu-markdown-export .md-content code {
      padding: .14em .38em;
      color: var(--awu-text) !important;
      background: var(--awu-code-bg);
      border: 1px solid color-mix(in srgb, var(--awu-border) 70%, transparent);
      border-radius: 4px;
      font: .88em/1.55 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    .awu-markdown-export .md-content pre {
      margin: 1em 0;
      padding: 1em 1.15em;
      color: var(--awu-text) !important;
      overflow: auto;
      background: var(--awu-code-bg);
      border: 1px solid var(--awu-border);
      border-radius: 6px;
    }
    .awu-markdown-export .md-content pre code { display: block; padding: 0; border: 0; background: transparent; font-size: .9em; }
    .awu-markdown-export .md-content .md-code-lang { margin-bottom: .4em; color: var(--awu-muted) !important; font: 12px/1.4 sans-serif; }
    .awu-markdown-export .hljs-doctag, .awu-markdown-export .hljs-keyword,
    .awu-markdown-export .hljs-meta .hljs-keyword, .awu-markdown-export .hljs-template-tag,
    .awu-markdown-export .hljs-type, .awu-markdown-export .hljs-variable.language_ { color: #cf222e !important; font-weight: 600; }
    .awu-markdown-export .hljs-title, .awu-markdown-export .hljs-title.class_,
    .awu-markdown-export .hljs-title.function_ { color: #8250df !important; font-weight: 600; }
    .awu-markdown-export .hljs-attr, .awu-markdown-export .hljs-attribute,
    .awu-markdown-export .hljs-literal, .awu-markdown-export .hljs-number,
    .awu-markdown-export .hljs-operator, .awu-markdown-export .hljs-variable { color: #0550ae !important; }
    .awu-markdown-export .hljs-regexp, .awu-markdown-export .hljs-string { color: #0a3069 !important; }
    .awu-markdown-export .hljs-built_in, .awu-markdown-export .hljs-symbol { color: #953800 !important; }
    .awu-markdown-export .hljs-comment, .awu-markdown-export .hljs-code,
    .awu-markdown-export .hljs-formula { color: #6e7781 !important; }
    .awu-markdown-export .hljs-name, .awu-markdown-export .hljs-quote,
    .awu-markdown-export .hljs-selector-tag { color: #116329 !important; }
    @media (prefers-color-scheme: dark) {
      html.awu-export-root, body.awu-export-body { background: #0d1117; }
      .awu-markdown-export {
        --awu-paper-bg: #161b22;
        --awu-text: #e6edf3;
        --awu-muted: #9da7b3;
        --awu-border: #30363d;
        --awu-soft-bg: #1d232b;
        --awu-code-bg: #0d1117;
        --awu-accent: #58a6ff;
      }
      .awu-markdown-export .hljs-doctag, .awu-markdown-export .hljs-keyword,
      .awu-markdown-export .hljs-meta .hljs-keyword, .awu-markdown-export .hljs-template-tag,
      .awu-markdown-export .hljs-type, .awu-markdown-export .hljs-variable.language_ { color: #ff7b72 !important; }
      .awu-markdown-export .hljs-title, .awu-markdown-export .hljs-title.class_,
      .awu-markdown-export .hljs-title.function_ { color: #d2a8ff !important; }
      .awu-markdown-export .hljs-attr, .awu-markdown-export .hljs-attribute,
      .awu-markdown-export .hljs-literal, .awu-markdown-export .hljs-number,
      .awu-markdown-export .hljs-operator, .awu-markdown-export .hljs-variable { color: #79c0ff !important; }
      .awu-markdown-export .hljs-regexp, .awu-markdown-export .hljs-string { color: #a5d6ff !important; }
      .awu-markdown-export .hljs-built_in, .awu-markdown-export .hljs-symbol { color: #ffa657 !important; }
      .awu-markdown-export .hljs-comment, .awu-markdown-export .hljs-code,
      .awu-markdown-export .hljs-formula { color: #8b949e !important; }
      .awu-markdown-export .hljs-name, .awu-markdown-export .hljs-quote,
      .awu-markdown-export .hljs-selector-tag { color: #7ee787 !important; }
    }
    @media (max-width: 640px) {
      .awu-markdown-export { width: 100%; min-height: 100vh; margin: 0; padding: 22px 18px; border: 0; box-shadow: none; font-size: 15px; }
    }
    @media print {
      html.awu-export-root, body.awu-export-body { background: #fff; }
      .awu-markdown-export {
        --awu-paper-bg: #fff;
        --awu-text: #000;
        --awu-border: #bbb;
        width: 100%; min-height: 0; margin: 0; padding: 0; border: 0; box-shadow: none;
      }
    }
  </style>
</head>
<body class="awu-export-body">
  <main class="awu-markdown-export">
${renderedBody}
  </main>
</body>
</html>
`;
}
