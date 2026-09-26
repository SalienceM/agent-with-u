export type PromptReferenceKind = 'file' | 'session' | 'skill';

export interface PromptReferenceTrigger {
  kind: PromptReferenceKind;
  /** 当前 @ token 在整段文本中的起点。 */
  start: number;
  /** 光标位置，也是当前 token 的右边界。 */
  cursor: number;
  query: string;
  /** 输入 @SE 时自动补成 @SESSION:，让入口容易被发现。 */
  expandSessionPrefix: boolean;
}

/** 文件夹保留尾斜杠；空格使用原生 @ 路径的转义，不拆成多个引用。 */
export function formatFileReference(path: string, isDirectory = false): string {
  let normalized = path.replace(/\\/g, '/');
  if (isDirectory) normalized = `${normalized.replace(/\/+$/, '') || '.'}/`;
  return `@${normalized.replace(/([ \t])/g, '\\$1')}`;
}

/** @src/components/foo 按层浏览，仅加载 src/components 的直接子项。 */
export function fileReferenceLocation(query: string): { directory: string; query: string } {
  const normalized = query.replace(/\\([ \t])/g, '$1').replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  return separator < 0
    ? { directory: '.', query: normalized }
    : { directory: normalized.slice(0, separator) || '.', query: normalized.slice(separator + 1) };
}

/** 解析光标前正在输入的 @ 文件 / @SESSION 引用。 */
export function detectPromptReference(
  value: string,
  cursor: number = value.length,
  allowSkills = false,
): PromptReferenceTrigger | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, safeCursor);
  const start = before.lastIndexOf('@');
  if (start < 0) return null;
  const token = before.slice(start + 1);
  if (/[\r\n]/.test(token) || /(^|[^\\])\s/.test(token)) return null;
  if (allowSkills && /^SKILL(?::.*)?$/i.test(token)) {
    return { kind: 'skill', start, cursor: safeCursor, query: token.includes(':') ? token.slice(token.indexOf(':') + 1) : '', expandSessionPrefix: false };
  }
  if (/^SE$/i.test(token)) {
    return { kind: 'session', start, cursor: safeCursor, query: '', expandSessionPrefix: true };
  }
  if (/^SESSION:/i.test(token)) {
    return {
      kind: 'session', start, cursor: safeCursor,
      query: token.slice(token.indexOf(':') + 1),
      expandSessionPrefix: false,
    };
  }
  return { kind: 'file', start, cursor: safeCursor, query: token, expandSessionPrefix: false };
}

/** 替换当前 @ token，并返回替换后的光标位置。 */
export function replacePromptReference(
  value: string,
  trigger: Pick<PromptReferenceTrigger, 'start' | 'cursor'>,
  replacement: string,
): { value: string; cursor: number } {
  const next = value.slice(0, trigger.start) + replacement + value.slice(trigger.cursor);
  return { value: next, cursor: trigger.start + replacement.length };
}
