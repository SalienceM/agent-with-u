/**
 * Markdown → HTML using marked + highlight.js
 * CSS 类替代 inline style，配合 App.tsx 注入的 .md-content 样式表自动适配主题
 */
import { marked } from 'marked';
import hljs from 'highlight.js';

// ── 自定义渲染器 ──────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderer: Record<string, any> = {
  code({ text, lang }: { text: string; lang?: string }) {
    const validLang = lang && hljs.getLanguage(lang) ? lang : null;
    const highlighted = validLang
      ? hljs.highlight(text, { language: validLang }).value
      : hljs.highlightAuto(text).value;
    const langLabel = lang
      ? `<div class="md-code-lang">${lang}</div>`
      : '';
    return `<pre class="md-pre"><code class="hljs">${langLabel}${highlighted}</code></pre>\n`;
  },

  codespan({ text }: { text: string }) {
    return `<code class="md-code-inline">${text}</code>`;
  },

  link({ href, text }: { href: string; text: string }) {
    return `<a href="${href}" target="_blank" rel="noopener" class="md-link">${text}</a>`;
  },

  heading({ text, depth }: { text: string; depth: number }) {
    return `<h${depth} class="md-h${depth}">${text}</h${depth}>\n`;
  },

  hr() {
    return '<hr class="md-hr">\n';
  },

  blockquote({ text }: { text: string }) {
    return `<blockquote class="md-blockquote">${text}</blockquote>\n`;
  },

  table({ header, rows }: { header: string; rows: string[] }) {
    return (
      `<div class="md-table-wrap"><table class="md-table">` +
      `<thead>${header}</thead><tbody>${rows.join('')}</tbody>` +
      `</table></div>\n`
    );
  },
};

marked.use({
  renderer,
  gfm: true,       // GitHub Flavored Markdown（表格、task list 等）
  breaks: true,    // 单换行 → <br>
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
