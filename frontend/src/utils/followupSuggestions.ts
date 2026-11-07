export interface FollowupConfig { backendId: string; model: string; reasoningEffort: string; timeoutSeconds: number }
export interface FollowupSettings { version: 1 | 2; enabled: boolean; config?: FollowupConfig }
export const defaultFollowupConfig = (): FollowupConfig => ({ backendId: '', model: '', reasoningEffort: '', timeoutSeconds: 30 });

export interface FollowupSuggestion {
  version: 1; sessionId: string; requestId: string; messageId: string;
  state: 'generating' | 'ready' | 'dismissed' | 'unavailable'; text: string; notice: string; usageReported?: boolean;
}

/** 只接受本窗口实际观察到的完成事件；草稿一旦变化，清空后也不复活。 */
export class FollowupDraftGuard {
  current?: FollowupSuggestion;
  private revision = -1;
  private seen = new Set<string>();
  receive(row: FollowupSuggestion, revision: number, eligible: boolean): boolean {
    if (row.state === 'generating') {
      if (!row.requestId || this.seen.has(row.requestId)) return false;
      this.seen.add(row.requestId);
      if (this.seen.size > 100) this.seen.delete(this.seen.values().next().value!);
      this.current = eligible ? { ...row } : undefined;
      this.revision = revision;
    } else if (this.current?.requestId === row.requestId && this.revision === revision && eligible) {
      this.current = row.state === 'dismissed' ? undefined : { ...row, text: row.text.slice(0, 300) };
    } else return false;
    return true;
  }
  invalidate(): string | undefined { const id = this.current?.requestId; this.current = undefined; return id; }
  check(revision: number, eligible: boolean): string | undefined {
    return this.current && (revision !== this.revision || !eligible) ? this.invalidate() : undefined;
  }
}
