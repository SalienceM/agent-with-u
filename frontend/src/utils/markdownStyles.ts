import { hljsDarkCss, hljsLightCss } from './hljsThemes';

// 只处理静态、无嵌套的 highlight.js 主题；不接受 Markdown 提供的 CSS。
function scopedHighlight(css: string, scope: string): string {
  // 只复用配色，布局由共享 Markdown 样式负责，避免 code/pre 双重滚动。
  const colors = css.replace(/(?:pre code\.hljs|code\.hljs|\.hljs)\s*\{[^}]*\}/g, '');
  return colors.replace(/([^{}]+)\{/g, (_match, selectors: string) =>
    `${selectors.trim().split(',').map(selector => `${scope} ${selector.trim()}`).join(',')} {`);
}

export const markdownHighlightStyles = ['light', 'dark'].map(theme => {
  const css = theme === 'light' ? hljsLightCss : hljsDarkCss;
  return scopedHighlight(css, `[data-markdown-theme="${theme}"] .md-content`)
    + scopedHighlight(css, `.awu-md-reader[data-reader-theme="${theme}"] .md-content`);
}).join('\n');

/** 所有窗口共用内容契约；阅读器只覆盖局部令牌和文档间距。 */
export const markdownStyles = `
  .md-content {
    min-width: 0; max-width: 100%; line-height: 1.65;
    overflow-wrap: anywhere; word-break: normal;
    color: var(--md-text, var(--theme-text, #c9d1d9));
  }
  .md-content p { margin: .55em 0; }
  .md-content > :first-child { margin-top: 0; }
  .md-content > :last-child { margin-bottom: 0; }
  .md-content h1, .md-content h2, .md-content h3,
  .md-content h4, .md-content h5, .md-content h6 {
    color: var(--md-text, var(--theme-text, #c9d1d9));
    font-weight: 650; line-height: 1.4; margin: 1.15em 0 .4em;
  }
  .md-content h1 { font-size: 1.35em; font-weight: 700; }
  .md-content h2 { font-size: 1.22em; }
  .md-content h3 { font-size: 1.1em; }
  .md-content h4 { font-size: 1em; }
  .md-content h5 { font-size: .95em; }
  .md-content h6 { font-size: .9em; }
  .md-content ul, .md-content ol { margin: .5em 0; padding-left: 1.8em; }
  .md-content li { margin: .2em 0; }
  .md-content li > ul, .md-content li > ol { margin: .2em 0; }
  .md-content li > p { margin: .4em 0; }
  .md-content li input[type="checkbox"] {
    margin: 0 .5em 0 0; vertical-align: middle;
    accent-color: var(--md-accent, var(--theme-accent, #58a6ff));
  }
  .md-content strong { font-weight: 700; }
  .md-content del { text-decoration: line-through; }
  .md-content a.md-link {
    color: var(--md-accent, var(--theme-accent, #58a6ff));
    text-decoration: underline; text-underline-offset: .15em;
  }
  .md-content a:focus-visible, .md-content .md-table-wrap:focus-visible {
    outline: 2px solid var(--md-accent, var(--theme-accent, #58a6ff)); outline-offset: 2px;
  }
  .md-content hr.md-hr {
    border: 0; border-top: 1px solid var(--md-border, var(--theme-border, #454c56)); margin: 1.2em 0;
  }
  .md-content blockquote.md-blockquote {
    border-left: 3px solid var(--md-accent, var(--theme-accent, #58a6ff));
    margin: .8em 0; padding: .2em 1em;
    color: var(--md-muted, var(--theme-text-muted, #9da7b3));
  }
  .md-content blockquote > :first-child { margin-top: 0; }
  .md-content blockquote > :last-child { margin-bottom: 0; }
  .md-content code.md-code-inline {
    background: var(--md-code, var(--theme-code-bg, #22272e)); color: inherit;
    padding: .1em .35em; border-radius: 4px; font: .9em Consolas, monospace;
    white-space: break-spaces; overflow-wrap: anywhere;
  }
  .md-content pre.md-pre {
    position: relative; box-sizing: border-box; min-width: 0; max-width: 100%;
    margin: .8em 0; padding: .85em 1em; overflow: auto;
    background: var(--md-code, var(--theme-code-bg, #22272e));
    border: 1px solid var(--md-border, var(--theme-border, #454c56)); border-radius: 8px;
    font: .93em/1.6 Consolas, monospace;
    white-space: pre; word-break: normal; overflow-wrap: normal;
  }
  .md-content pre.md-pre > code.hljs {
    display: block; padding: 0; background: transparent; overflow: visible;
    font: inherit; color: inherit; white-space: inherit;
  }
  .md-content pre.md-pre.md-pre-copyable { padding-bottom: 2.5em; }
  .md-content .md-code-lang {
    display: block; margin: 0 4em .5em 0; white-space: pre-wrap; overflow-wrap: anywhere;
    font: .85em/1.4 system-ui, sans-serif; color: var(--md-muted, var(--theme-text-muted, #9da7b3));
  }
  .md-content .md-table-wrap {
    box-sizing: border-box; max-width: 100%; min-width: 0; overflow-x: auto;
    margin: .9em 0; border-radius: 4px;
  }
  .md-content .md-table {
    border-collapse: collapse; width: 100%; font-size: .95em;
    background: var(--md-panel, var(--theme-bg-secondary, #161b22));
  }
  .md-content .md-table th, .md-content .md-table td {
    border: 1px solid var(--md-border, var(--theme-border, #454c56));
    min-width: 5em; padding: .5em .8em; text-align: left; vertical-align: top;
    overflow-wrap: normal; word-break: normal;
  }
  .md-content .md-table th { background: var(--md-soft, var(--theme-bg-tertiary, #22272e)); font-weight: 650; }
  .md-content .md-table tr:nth-child(even) td { background: var(--md-soft, var(--theme-bg-tertiary, #22272e)); }
  .md-content .md-table [align="center"] { text-align: center; }
  .md-content .md-table [align="right"] { text-align: right; }
  .md-content .md-table [align="left"] { text-align: left; }
  .md-content img { max-width: 100%; height: auto; }
  .md-content .md-render-warning { color: var(--md-muted, var(--theme-text-muted, #9da7b3)); margin-bottom: .5em; }
  @media (max-width: 768px) {
    .md-content pre.md-pre { padding: .7em .8em; }
    .md-content .md-table th, .md-content .md-table td { padding: .4em .6em; }
  }
`;
