export type PromptReferenceKind = 'file' | 'session';

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

/** 解析光标前正在输入的 @ 文件 / @SESSION 引用。 */
export function detectPromptReference(
  value: string,
  cursor: number = value.length,
): PromptReferenceTrigger | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, safeCursor);
  const start = before.lastIndexOf('@');
  if (start < 0) return null;
  const token = before.slice(start + 1);
  if (/\s/.test(token)) return null;
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
