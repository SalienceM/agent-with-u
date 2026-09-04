import { markdownHtmlWithOutline } from './markdown';

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
  const outlined = markdownHtmlWithOutline(renderedBody);
  const minimumOutlineLevel = outlined.outline.reduce(
    (minimum, item) => Math.min(minimum, item.level),
    6,
  );
  const outlineMarkup = outlined.outline.length > 0
    ? outlined.outline.map((item) => (
      `<button class="awu-toc-item" data-target="${item.id}" style="--awu-depth:${Math.min(4, Math.max(0, item.level - minimumOutlineLevel))}">`
      + `<span class="awu-toc-dot"></span><span>${escapeHtmlText(item.title)}</span></button>`
    )).join('')
    : '<p class="awu-toc-empty">这份文档没有可导航的标题</p>';
  return `<!doctype html>
<html lang="zh-CN" class="awu-export-root" data-awu-theme="light" data-awu-toc="open">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="AgentWithU Markdown Preview">
  <meta name="source-file" content="${source}">
  <title>${title}</title>
  <script>
    try {
      var awuTheme = localStorage.getItem('agentwithu.markdownExport.theme');
      if (awuTheme !== 'light' && awuTheme !== 'dark') {
        awuTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.dataset.awuTheme = awuTheme;
      document.documentElement.dataset.awuToc = localStorage.getItem('agentwithu.markdownExport.tocOpen') === '0' ? 'closed' : 'open';
    } catch (_) {}
  </script>
  <style>
    /*
     * 所有内容样式都限定在 awu-markdown-export 内。
     * Trilium 等“渲染笔记”会把文档样式合入宿主页；不能使用 :root、body、
     * --text 这类全局选择器/变量，否则会污染宿主 UI，也容易被宿主表格样式覆盖。
     */
    html.awu-export-root {
      color-scheme: light dark;
      --awu-page-bg: #f3f6fa;
      --awu-paper-bg: #ffffff;
      --awu-text: #1f2328;
      --awu-muted: #59636e;
      --awu-border: #d0d7de;
      --awu-soft-bg: #f6f8fa;
      --awu-code-bg: #f6f8fa;
      --awu-accent: #0969da;
      background: var(--awu-page-bg);
      scroll-behavior: smooth;
    }
    body.awu-export-body {
      margin: 0;
      color: var(--awu-text);
      background: var(--awu-page-bg);
    }
    .awu-markdown-export {
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
    .awu-reader-toolbar {
      position: sticky; top: 0; z-index: 20; height: 54px; padding: 0 16px;
      display: flex; align-items: center; gap: 12px;
      color: var(--awu-text); background: color-mix(in srgb, var(--awu-paper-bg) 92%, transparent);
      border-bottom: 1px solid var(--awu-border); backdrop-filter: blur(14px);
      font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    }
    .awu-reader-title {
      min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      text-align: center; font-weight: 700;
    }
    .awu-reader-action {
      min-height: 32px; padding: 5px 11px; display: inline-flex; align-items: center; gap: 6px;
      color: var(--awu-text); background: var(--awu-paper-bg); border: 1px solid var(--awu-border);
      border-radius: 8px; cursor: pointer; font: inherit;
    }
    .awu-reader-action:hover { color: var(--awu-accent); border-color: var(--awu-accent); }
    .awu-reader-shell {
      width: min(1440px, 100%); min-height: calc(100vh - 54px); margin: 0 auto;
      display: grid; grid-template-columns: 270px minmax(0, 1fr); align-items: start;
      transition: grid-template-columns .2s ease;
    }
    .awu-reader-toc {
      position: sticky; top: 70px; z-index: 10; height: calc(100vh - 86px); min-width: 0;
      margin: 16px 0 16px 16px; overflow: hidden;
      color: var(--awu-text); background: var(--awu-paper-bg); border: 1px solid var(--awu-border);
      border-radius: 10px; transition: opacity .18s ease, transform .2s ease;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    }
    .awu-toc-heading {
      height: 45px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between;
      color: var(--awu-muted); border-bottom: 1px solid var(--awu-border);
      font-size: 11px; font-weight: 750; letter-spacing: .12em;
    }
    .awu-toc-list { height: calc(100% - 45px); padding: 8px 7px 24px; box-sizing: border-box; overflow: auto; }
    .awu-toc-item {
      width: 100%; min-height: 32px; padding: 6px 9px 6px calc(14px + var(--awu-depth) * 13px);
      display: flex; align-items: flex-start; gap: 8px; border: 0; border-radius: 7px;
      color: var(--awu-muted); background: transparent; cursor: pointer; text-align: left;
      font: 500 12px/1.45 inherit;
    }
    .awu-toc-item:hover { color: var(--awu-text); background: var(--awu-soft-bg); }
    .awu-toc-item.is-active { color: var(--awu-accent); background: color-mix(in srgb, var(--awu-accent) 10%, transparent); font-weight: 700; }
    .awu-toc-dot { width: 4px; height: 4px; margin-top: 7px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
    .awu-toc-item.is-active .awu-toc-dot { height: 14px; margin-top: 2px; border-radius: 3px; }
    .awu-toc-empty { padding: 10px; color: var(--awu-muted); }
    .awu-toc-backdrop { display: none; }
    html.awu-export-root[data-awu-toc="closed"] .awu-reader-shell { grid-template-columns: 0 minmax(0, 1fr); }
    html.awu-export-root[data-awu-toc="closed"] .awu-reader-toc { opacity: 0; pointer-events: none; transform: translateX(-18px); }
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
    html.awu-export-root[data-awu-theme="dark"] {
        --awu-page-bg: #0d1117;
        --awu-paper-bg: #161b22;
        --awu-text: #e6edf3;
        --awu-muted: #9da7b3;
        --awu-border: #30363d;
        --awu-soft-bg: #1d232b;
        --awu-code-bg: #0d1117;
        --awu-accent: #58a6ff;
    }
    html.awu-export-root[data-awu-theme="dark"],
    html.awu-export-root[data-awu-theme="dark"] body.awu-export-body { background: var(--awu-page-bg); }
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-doctag,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-keyword,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-meta .hljs-keyword,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-template-tag,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-type,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-variable.language_ { color: #ff7b72 !important; }
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-title,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-title.class_,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-title.function_ { color: #d2a8ff !important; }
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-attr,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-attribute,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-literal,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-number,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-operator,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-variable { color: #79c0ff !important; }
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-regexp,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-string { color: #a5d6ff !important; }
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-built_in,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-symbol { color: #ffa657 !important; }
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-comment,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-code,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-formula { color: #8b949e !important; }
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-name,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-quote,
    html.awu-export-root[data-awu-theme="dark"] .awu-markdown-export .hljs-selector-tag { color: #7ee787 !important; }
    @media (max-width: 860px) {
      .awu-reader-shell, html.awu-export-root[data-awu-toc="closed"] .awu-reader-shell { display: block; }
      .awu-reader-toc {
        position: fixed; top: 62px; bottom: 8px; left: 8px; width: min(82vw, 310px); height: auto;
        margin: 0; box-shadow: 18px 0 46px rgba(0,0,0,.3); transform: translateX(0);
      }
      html.awu-export-root[data-awu-toc="closed"] .awu-reader-toc { transform: translateX(calc(-100% - 18px)); }
      html.awu-export-root[data-awu-toc="open"] .awu-toc-backdrop {
        display: block; position: fixed; inset: 54px 0 0; z-index: 9;
        border: 0; background: rgba(0,0,0,.42); cursor: default;
      }
      .awu-reader-toolbar { padding: 0 8px; gap: 7px; }
      .awu-reader-action { padding: 5px 8px; }
    }
    @media (max-width: 640px) {
      .awu-markdown-export { width: 100%; min-height: 100vh; margin: 0; padding: 22px 18px; border: 0; box-shadow: none; font-size: 15px; }
    }
    @media print {
      html.awu-export-root[data-awu-theme], body.awu-export-body {
        --awu-page-bg: #fff; --awu-paper-bg: #fff; --awu-text: #000; --awu-border: #bbb;
        background: #fff;
      }
      .awu-reader-toolbar, .awu-reader-toc, .awu-toc-backdrop { display: none !important; }
      .awu-reader-shell { display: block; }
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
  <header class="awu-reader-toolbar">
    <button id="awu-toc-toggle" class="awu-reader-action" type="button" aria-expanded="true">☰ <span>目录</span></button>
    <div class="awu-reader-title" title="${title}">▤ ${title}</div>
    <button id="awu-theme-toggle" class="awu-reader-action" type="button">☾ <span>夜间</span></button>
  </header>
  <button id="awu-toc-backdrop" class="awu-toc-backdrop" type="button" aria-label="关闭目录"></button>
  <div class="awu-reader-shell">
    <aside class="awu-reader-toc" aria-label="文档目录">
      <div class="awu-toc-heading"><span>目录</span><span>${outlined.outline.length || '—'}</span></div>
      <nav class="awu-toc-list">${outlineMarkup}</nav>
    </aside>
    <main class="awu-markdown-export">
${outlined.html}
    </main>
  </div>
  <script>
    (function () {
      var root = document.documentElement;
      var tocButton = document.getElementById('awu-toc-toggle');
      var themeButton = document.getElementById('awu-theme-toggle');
      var backdrop = document.getElementById('awu-toc-backdrop');
      function renderControls() {
        var open = root.dataset.awuToc !== 'closed';
        var dark = root.dataset.awuTheme === 'dark';
        tocButton.setAttribute('aria-expanded', String(open));
        tocButton.innerHTML = (open ? '◀' : '☰') + ' <span>' + (open ? '收起目录' : '展开目录') + '</span>';
        themeButton.innerHTML = (dark ? '☀' : '☾') + ' <span>' + (dark ? '白天' : '夜间') + '</span>';
      }
      function setToc(open) {
        root.dataset.awuToc = open ? 'open' : 'closed';
        try { localStorage.setItem('agentwithu.markdownExport.tocOpen', open ? '1' : '0'); } catch (_) {}
        renderControls();
      }
      tocButton.addEventListener('click', function () { setToc(root.dataset.awuToc === 'closed'); });
      backdrop.addEventListener('click', function () { setToc(false); });
      themeButton.addEventListener('click', function () {
        root.dataset.awuTheme = root.dataset.awuTheme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('agentwithu.markdownExport.theme', root.dataset.awuTheme); } catch (_) {}
        renderControls();
      });
      var links = Array.prototype.slice.call(document.querySelectorAll('.awu-toc-item[data-target]'));
      var headings = Array.prototype.slice.call(document.querySelectorAll('.awu-markdown-export .md-content h1, .awu-markdown-export .md-content h2, .awu-markdown-export .md-content h3, .awu-markdown-export .md-content h4, .awu-markdown-export .md-content h5, .awu-markdown-export .md-content h6'));
      function selectActive() {
        var active = headings.length ? headings[0].id : '';
        headings.some(function (heading) {
          if (heading.getBoundingClientRect().top <= 92) { active = heading.id; return false; }
          return true;
        });
        links.forEach(function (link) { link.classList.toggle('is-active', link.dataset.target === active); });
      }
      links.forEach(function (link) {
        link.addEventListener('click', function () {
          var heading = document.getElementById(link.dataset.target || '');
          if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
          if (matchMedia('(max-width: 860px)').matches) setToc(false);
        });
      });
      var pending = 0;
      addEventListener('scroll', function () {
        if (pending) return;
        pending = requestAnimationFrame(function () { pending = 0; selectActive(); });
      }, { passive: true });
      renderControls();
      selectActive();
    }());
  </script>
</body>
</html>
`;
}
