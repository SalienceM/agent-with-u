export type AttentionKind =
  | 'session'
  | 'file'
  | 'settings'
  | 'backend'
  | 'release'
  | 'skills'
  | 'assets'
  | 'notes'
  | 'connection'
  | 'logs'
  | 'manual'
  | 'home';

export interface AttentionContext {
  key: string;
  kind: AttentionKind;
  label: string;
  detail?: string;
  content?: string;
  sessionId?: string;
  workingDir?: string;
  execKey?: string;
}

export const ATTENTION_CONTENT_LIMIT = 50_000;
export const OPEN_THOUGHTS_EVENT = 'awu:thoughts-open';

const BINARY_KEYS = new Set([
  'base64', 'dataUrl', 'bytes', 'image', 'images', 'thumbnail', 'blob', 'arrayBuffer',
]);

function compactStructured(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value)) return '[已省略二进制内容]';
    return value.length > 8_000 ? `${value.slice(0, 8_000)}…` : value;
  }
  if (depth >= 7) return '[层级已省略]';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[已省略二进制内容]';
  if (Array.isArray(value)) return value.slice(0, 120).map((item) => compactStructured(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 160)) {
      if (BINARY_KEYS.has(key) || /(?:base64|dataurl|bytes)$/i.test(key)) continue;
      output[key] = compactStructured(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function limitAttentionContent(value: string, limit = ATTENTION_CONTENT_LIMIT): string {
  const clean = String(value || '').replace(/\0/g, '').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}\n\n[界面快照已截断]` : clean;
}

export function serializeAttentionContent(value: unknown): string {
  try {
    return limitAttentionContent(JSON.stringify(compactStructured(value), null, 2));
  } catch {
    return '';
  }
}

export interface PreviewAttentionSource {
  rel: string;
  name: string;
  source: 'remote' | 'local';
  loading?: boolean;
  error?: string;
  text?: string;
  isImage?: boolean;
  isMarkdown?: boolean;
  renderer?: 'pdf' | 'docx' | 'drawio';
  structured?: unknown;
  drawioXml?: string;
  truncated?: boolean;
}

export function buildFileAttentionContext(
  preview: PreviewAttentionSource,
  options: { sessionId?: string; workingDir?: string; execKey?: string; editedText?: string } = {},
): AttentionContext {
  let content = '';
  if (typeof options.editedText === 'string') content = options.editedText;
  else if (typeof preview.text === 'string') content = preview.text;
  else if (preview.structured) content = serializeAttentionContent(preview.structured);
  else if (preview.renderer === 'drawio' && preview.drawioXml) {
    const labels: string[] = [];
    for (const match of preview.drawioXml.matchAll(/value="([^"]+)"/g)) {
      labels.push(match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      if (labels.length >= 400) break;
    }
    content = labels.join('\n');
  }
  if (!content) {
    if (preview.loading) content = '文件正在加载，正文尚未可用。';
    else if (preview.error) content = `预览错误：${preview.error}`;
    else if (preview.isImage) content = '当前关注的是图片；图片像素不会作为文本快照重复上传，可通过提问时附图补充。';
    else if (preview.renderer === 'pdf' || preview.renderer === 'docx') content = '当前预览器未提供可安全提取的正文，仅带入文件身份。';
  }
  return {
    key: `file:${preview.source}:${preview.rel.replace(/\\/g, '/')}`,
    kind: 'file',
    label: preview.name,
    detail: `${preview.source === 'local' ? '本机' : '执行端'} · ${preview.rel}${preview.truncated ? ' · 预览已截断' : ''}`,
    content: limitAttentionContent(content),
    sessionId: options.sessionId,
    workingDir: options.workingDir,
    execKey: options.execKey,
  };
}

export function attentionIcon(kind: AttentionKind): string {
  return ({
    session: '💬', file: '📄', settings: '⚙️', backend: '🧠', release: '🚀',
    skills: '📦', assets: '🗂️', notes: '📝', connection: '🔗', logs: '📋',
    manual: '📖', home: '⌂',
  } as Record<AttentionKind, string>)[kind];
}
