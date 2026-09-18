import { detachedUrl, openDetachedWindow } from './detachedWindow';

export interface SkillManualSummary { name: string; hasManual: boolean }
export interface SkillManual {
  status: 'ok'; name: string; content: string; hasManual: boolean; revision: string;
  updatedAt?: number; originalContent: string; originalPath: string; documents: string[];
  sourceHash: string; outdated: boolean; source: Record<string, string>;
}
export function manualReferences(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/(?<![\w@])@SKILL:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![\w/\\.-])/gi), match => match[1]))];
}
export function openSkillManual(name: string, execKey: string): Promise<void> {
  // 每份手册独立身份，重开同一份聚焦复用，不能显示上一个节点的同名文档。
  const identity = Array.from(new TextEncoder().encode(`${execKey}\0${name}`), b => b.toString(16).padStart(2, '0')).join('');
  return openDetachedWindow({ label: `skill-manual-${identity}`, title: `${name} · 使用手册 — AgentWithU`,
    url: detachedUrl('skillManual', { skillName: name, skillExecKey: execKey }),
    width: 1000, height: 800, minWidth: 520, minHeight: 420 });
}
export const isSkillManualWindow = typeof location !== 'undefined' && new URLSearchParams(location.search).has('skillManual');
