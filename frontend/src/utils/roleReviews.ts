import type { OpinionReference } from '../types/sessionCollaboration';

export function roleQueryAt(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor), lines = before.split('\n'), line = lines[lines.length - 1];
  if (lines.filter(value => /^\s*(```|~~~)/.test(value)).length % 2 || /^\s{4}/.test(line) || /^\s*#+\s/.test(line)) return null;
  if ((line.match(/`/g)?.length || 0) % 2) return null;
  const match = /(?:^|\s)#([^\s#@`]{0,80})$/.exec(line);
  return match ? { start: before.length - match[1].length - 1, query: match[1] } : null;
}
export function opinionText(reference: OpinionReference): string {
  const stance = { agree: '同意', partial: '部分同意', disagree: '不同意', unknown: '证据不足' };
  return `\n【角色意见：${reference.roleName}｜报告 ${reference.reportId} v${reference.reportRevision}｜来源 ${reference.sourceSessionId}】\n${reference.summary}\n`
    + reference.claims.map(item => `- ${stance[item.stance]}（回答 ${item.sourceMessageId} / ${item.id}）：${item.quote || ''}\n  ${item.reason}${item.suggestion ? '\n  建议：' + item.suggestion : ''}`).join('\n') + '\n';
}
