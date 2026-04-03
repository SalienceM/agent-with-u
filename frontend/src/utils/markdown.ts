/**
 * Markdown → HTML using marked v9 + highlight.js
 * CSS 类替代 inline style，配合 App.tsx 注入的 .md-content 样式表自动适配主题
 *
 * marked v9 renderer 使用位置参数（非 token 对象），适配该版本 API
 */
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

// ── 自定义渲染器（marked v9 positional-arg API）───────────────
const renderer = new Renderer();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).code = function (code: string, lang: string | undefined): string {
  const safeCode = code ?? '';
  const validLang = lang && hljs.getLanguage(lang) ? lang : null;
  const highlighted = validLang
    ? hljs.highlight(safeCode, { language: validLang }).value
    : safeCode.length > 0 ? hljs.highlightAuto(safeCode).value : safeCode;
  const langLabel = lang ? `<div class="md-code-lang">${lang}</div>` : '';
  return `<pre class="md-pre"><code class="hljs">${langLabel}${highlighted}</code></pre>\n`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).codespan = function (code: string): string {
  return `<code class="md-code-inline">${code}</code>`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).link = function (href: string, _title: string | null, text: string): string {
  return `<a href="${href}" target="_blank" rel="noopener" class="md-link">${text}</a>`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).heading = function (text: string, depth: number): string {
  return `<h${depth} class="md-h${depth}">${text}</h${depth}>\n`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).hr = function (): string {
  return '<hr class="md-hr">\n';
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).blockquote = function (quote: string): string {
  return `<blockquote class="md-blockquote">${quote}</blockquote>\n`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).image = function (href: string, _title: string | null, text: string): string {
  return `<img src="${href}" alt="${text || ''}" loading="lazy" class="md-img" />\n`;
};

marked.use({
  renderer,
  gfm: true,    // GitHub Flavored Markdown（表格、task list 等）
  breaks: true, // 单换行 → <br>
});

export function markdownToHtml(src: string): string {
  return `<div class="md-content">${marked.parse(src) as string}</div>`;
}

// ── 导出工具函数（不变）───────────────────────────────────────
export function messagesToMarkdown(
  messages: Array<{ role: string; content: string; timestamp?: number }>,
): string {
  return messages
    .map((msg) => {
      const role = msg.role === 'user' ? '## 🧑 User' : '## 🤖 Assistant';
      const time = msg.timestamp ? `\n*${new Date(msg.timestamp).toLocaleString()}*\n` : '';
      return `${role}${time}\n\n${msg.content}`;
    })
    .join('\n\n---\n\n');
}

export function messagesToJson(
  messages: Array<{ role: string; content: string; timestamp?: number }>,
): string {
  return JSON.stringify(messages, null, 2);
}
