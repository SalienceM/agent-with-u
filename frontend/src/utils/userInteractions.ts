import type { UserInteraction } from '../types/userInteractions';

/** 只缓存当前身份的紧凑待答索引；正文由当前 Session 按需加载。 */
export class InteractionIndex {
  private entries = new Map<string, Map<string, Pick<UserInteraction, 'id' | 'sessionId' | 'revision' | 'status'>>>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): number => this.version;
  private changed(): void { this.version++; this.listeners.forEach(listener => listener()); }
  accept(executor: string, row: Pick<UserInteraction, 'id' | 'sessionId' | 'revision' | 'status'>): void {
    const entries = this.entries.get(executor) || new Map();
    const old = entries.get(row.id);
    if (old && old.revision > row.revision) return;
    entries.set(row.id, { id: row.id, sessionId: row.sessionId, revision: row.revision, status: row.status });
    this.entries.set(executor, entries);
    this.changed();
  }
  count(executor: string, session: string): number {
    return [...(this.entries.get(executor)?.values() || [])].filter(row => row.sessionId === session && row.status === 'pending').length;
  }
  replaceSessions(executor: string, rows: Array<{ id: string; pendingInteractions?: UserInteraction[] }>, started: number): void {
    if (started !== this.version) return; // 读期间有推送，以较新的运行事件为准。
    const entries = this.entries.get(executor) || new Map();
    for (const row of rows) {
      if (!Array.isArray(row.pendingInteractions)) continue;
      for (const [id, entry] of entries) if (entry.sessionId === row.id) entries.delete(id);
      for (const entry of row.pendingInteractions) entries.set(entry.id, entry);
    }
    this.entries.set(executor, entries); this.changed();
  }
  clear(): void { this.entries.clear(); this.changed(); }
}
export const interactionIndex = new InteractionIndex();

export function mergeInteractions(rows: UserInteraction[], incoming: UserInteraction[]): UserInteraction[] {
  const next = new Map(rows.map(row => [row.id, row]));
  for (const row of incoming) {
    if (!next.has(row.id) || next.get(row.id)!.revision <= row.revision) next.set(row.id, row);
  }
  return [...next.values()].sort((a, b) => a.deadline - b.deadline).slice(-30);
}
