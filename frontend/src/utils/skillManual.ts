import { detachedUrl, openDetachedWindow } from './detachedWindow';

export interface SkillManualSummary { name: string; hasManual: boolean; displayName?: string; kind?: 'parent'; repository?: string; children?: SkillManualSummary[] }
export interface SkillManual {
  status: 'ok'; name: string; content: string; hasManual: boolean; revision: string;
  updatedAt?: number; originalContent: string; originalPath: string; documents: string[];
  sourceHash: string; outdated: boolean; source: Record<string, string>;
  displayName?: string; kind?: 'parent'; children?: string[];
}
export function manualReferences(text: string): string[] {
  const names = Array.from(text.matchAll(/(?<![\w@])@SKILL:("(?:[^"\\]|\\.)*"|)([^\s，。；,;?!！？()（）\[\]]*)/gi), match => {
    try {
      if (match[1]) return JSON.parse(match[1]) as string;
      return /^(?:repo\.[a-f0-9]{16}|[A-Za-z0-9][A-Za-z0-9_-]{0,127}|[\p{L}\p{N}_-]{1,80})$/u.test(match[2]) ? match[2] : '';
    } catch { return ''; }
  });
  return [...new Set(names.filter(Boolean))];
}
export function skillReferenceText(entry: SkillManualSummary): string {
  return `@SKILL:${entry.name}${entry.displayName ? ` [${entry.displayName}]` : ''} `;
}
export function skillReferenceLabel(name: string, entries: SkillManualSummary[]): string {
  const entry = entries.find(item => item.name === name || item.displayName === name)
    || entries.flatMap(item => item.children || []).find(item => item.name === name);
  return entry?.displayName || entry?.name || (/^repo\.[a-f0-9]{16}$/.test(name) ? '仓库手册' : name);
}
export function removeManualReferences(text: string, names: string[]): string {
  return text.replace(/(?<![\w@])@SKILL:("(?:[^"\\]|\\.)*"|[^\s，。；,;?!！？()（）\[\]]+)(?:[ \t]+\[[^\]\r\n]*\])?/gi,
    (token) => manualReferences(token).some(name => names.includes(name)) ? '' : token).trim();
}
export function normalizeManualHistory<T extends { contextKey?: string; contextKind?: string; contextLabel?: string; contextDetail?: string }>(turn: T): T {
  // 兼容旧历史：引用资料不再独占线程；真正的 panel:library 注意力不变。
  return turn.contextKey?.startsWith('skills:')
    ? { ...turn, contextKey: 'session', contextKind: 'session', contextLabel: '', contextDetail: '' }
    : turn;
}
export function openSkillManual(name: string, execKey: string): Promise<void> {
  // 每份手册独立身份，重开同一份聚焦复用，不能显示上一个节点的同名文档。
  const identity = Array.from(new TextEncoder().encode(`${execKey}\0${name}`), b => b.toString(16).padStart(2, '0')).join('');
  return openDetachedWindow({ label: `skill-manual-${identity}`, title: `${name} · 使用手册 — AgentWithU`,
    url: detachedUrl('skillManual', { skillName: name, skillExecKey: execKey }),
    width: 1000, height: 800, minWidth: 520, minHeight: 420 });
}
export const isSkillManualWindow = typeof location !== 'undefined' && new URLSearchParams(location.search).has('skillManual');
