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

/**
 * 后端把 Skill 生成的图片 URL 写成 .../api/skill-images/<文件名>。
 * C–C/S 架构下没有共享的 /api/ 反代（执行节点可能在中继另一端），所以
 * skill 图片不再用 <img src> 直连，而是渲染成带 data-skill-file 的占位
 * <img>，由 MessageBubble 通过 getSkillImage RPC 走数据通道按需加载。
 * 这样本地直连 / 经中继 / QWebChannel 三种模式行为统一。
 */
function skillImageFilename(href: string): string | null {
  const m = (href || '').match(/\/api\/skill-images\/([^/?#"'\s]+)/);
  return m ? m[1] : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(renderer as any).image = function (href: string, _title: string | null, text: string): string {
  const file = skillImageFilename(href);
  if (file) {
    return `<img data-skill-file="${file}" alt="${text || ''}" class="md-img skill-img" />\n`;
  }
  return `<img src="${href}" alt="${text || ''}" loading="lazy" class="md-img" />\n`;
};

marked.use({
  renderer,
  gfm: true,    // GitHub Flavored Markdown（表格、task list 等）
  breaks: true, // 单换行 → <br>
});

interface ProtectedInlineImage {
  placeholder: string;
  dataUri: string;
  alt: string;
}

const INLINE_IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
  'image/gif', 'image/bmp', 'image/tiff',
]);
const MAX_INLINE_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;
const MAX_INLINE_IMAGES_TO_RENDER = 12;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isBase64Payload(value: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47
      || code === 45 || code === 95 || code === 61;
    if (!valid) return false;
  }
  return true;
}

/**
 * marked v9 在解析约 8MB 的 inline data image 时会在 blockTokens 正则中栈溢出。
 * 这里用线性扫描先把图片替换成短占位，Markdown 完成后再恢复成 <img>。
 * 新消息已经由 backend 落盘；这条路径主要用于修复旧 Session 中遗留的 Base64。
 */
function protectInlineDataImages(src: string): {
  markdown: string;
  images: ProtectedInlineImage[];
} {
  let placeholderPrefix = 'AWUINLINEIMAGEPLACEHOLDER';
  while (src.includes(placeholderPrefix)) placeholderPrefix += 'X';

  const images: ProtectedInlineImage[] = [];
  const chunks: string[] = [];
  let cursor = 0;
  let searchFrom = 0;
  let processed = 0;

  while (searchFrom < src.length) {
    const dataMarker = src.indexOf('](data:image/', searchFrom);
    if (dataMarker < 0) break;
    const imageStart = src.lastIndexOf('![', dataMarker);
    if (imageStart < cursor) {
      searchFrom = dataMarker + 2;
      continue;
    }
    const alt = src.slice(imageStart + 2, dataMarker);
    if (alt.includes('\n') || alt.includes(']')) {
      searchFrom = dataMarker + 2;
      continue;
    }
    const uriStart = dataMarker + 2;
    const base64Marker = src.indexOf(';base64,', uriStart);
    if (base64Marker < 0 || base64Marker - uriStart > 96) {
      searchFrom = dataMarker + 2;
      continue;
    }
    const close = src.indexOf(')', base64Marker + 8);
    if (close < 0) {
      // 未闭合的巨型 data URI 同样不能交给 marked；截掉剩余损坏载荷。
      chunks.push(src.slice(cursor, imageStart), '[内联图片数据不完整，无法显示]');
      cursor = src.length;
      searchFrom = src.length;
      break;
    }

    chunks.push(src.slice(cursor, imageStart));
    const mime = src.slice(uriStart + 5, base64Marker).toLowerCase();
    const payloadStart = base64Marker + 8;
    const payloadLength = close - payloadStart;
    const canRender = INLINE_IMAGE_MIME_TYPES.has(mime)
      && payloadLength > 0
      && payloadLength <= MAX_INLINE_IMAGE_BASE64_CHARS
      && images.length < MAX_INLINE_IMAGES_TO_RENDER
      && isBase64Payload(src, payloadStart, close);

    if (canRender) {
      const placeholder = `${placeholderPrefix}${processed}END`;
      images.push({
        placeholder,
        dataUri: src.slice(uriStart, close),
        alt,
      });
      chunks.push(placeholder);
    } else {
      chunks.push(payloadLength > MAX_INLINE_IMAGE_BASE64_CHARS
        ? '[内联图片超过 64MB，已阻止渲染]'
        : '[内联图片格式无效，已阻止渲染]');
    }
    processed += 1;
    cursor = close + 1;
    searchFrom = cursor;
  }

  chunks.push(src.slice(cursor));
  return { markdown: chunks.join(''), images };
}

function restoreInlineDataImages(html: string, images: ProtectedInlineImage[]): string {
  let restored = html;
  for (const image of images) {
    const tag = `<img src="${image.dataUri}" alt="${escapeHtml(image.alt)}" loading="lazy" class="md-img" />`;
    restored = restored.split(image.placeholder).join(tag);
  }
  return restored;
}

export function markdownToHtml(src: string): string {
  const protectedSource = protectInlineDataImages(src || '');
  let html: string;
  try {
    html = marked.parse(protectedSource.markdown) as string;
  } catch (error) {
    // 单条异常消息不能再击穿整个 React 应用。回退内容严格转义并限长。
    console.error('[markdown] render failed, using safe fallback:', error);
    const limit = 200_000;
    const body = protectedSource.markdown.length > limit
      ? `${protectedSource.markdown.slice(0, limit)}\n\n[内容过长，已截断]`
      : protectedSource.markdown;
    html = `<div class="md-render-warning">Markdown 渲染失败，已使用安全文本模式。</div>`
      + `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>`;
  }
  return `<div class="md-content">${restoreInlineDataImages(html, protectedSource.images)}</div>`;
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
