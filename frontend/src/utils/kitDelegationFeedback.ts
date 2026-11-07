export interface KitDelegationReceipt {
  id: string; sessionId: string; messageId: string; revision: number;
  status: 'awaiting' | 'accepted' | 'bound' | 'used' | 'expired' | 'unavailable' | 'unknown';
  issuedAt?: number; expiresAt?: number; runId?: string; kitId?: string; stepId?: string; runStatus?: string; reason?: string;
}

class KitDelegationIndex {
  private entries = new Map<string, KitDelegationReceipt>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private waiting = new Map<string, KitDelegationReceipt[]>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): number => this.revision;
  private changed(): void { this.revision++; this.listeners.forEach(listener => listener()); }
  private key(executor: string, session: string, message: string): string { return JSON.stringify([executor, session, message]); }
  accept(executor: string, row: KitDelegationReceipt): void {
    const key = this.key(executor, row.sessionId, row.messageId), old = this.entries.get(key);
    if (old && old.revision > row.revision) return;
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    this.entries.set(key, row); this.changed();
  }
  awaiting(executor: string, sessionId: string, messageId: string): void {
    this.accept(executor, { id: '', sessionId, messageId, revision: 0, status: 'awaiting' });
    const key = this.key(executor, sessionId, messageId);
    this.timers.set(key, setTimeout(() => {
      const row = this.entries.get(key);
      if (row?.status === 'awaiting') this.accept(executor, { ...row, status: 'unknown', reason: '未收到执行器回执，请核对；没有自动重发。' });
    }, 12000));
  }
  get(executor: string, session: string, message: string): KitDelegationReceipt | undefined { return this.entries.get(this.key(executor, session, message)); }
  list(executor: string, session: string): KitDelegationReceipt[] { return [...this.entries.entries()].filter(([key, row]) => key === this.key(executor, session, row.messageId)).map(([, row]) => row); }
  updateRuns(executor: string, session: string, runs: Array<{ id: string; status: string; stepId?: string; currentStep?: number; steps?: Array<{ id: string }> }>): void {
    this.waiting.set(JSON.stringify([executor, session]), runs.filter(run => run.status === 'waiting_approval').map(run => ({
      id: run.id, runId: run.id, sessionId: session, messageId: '', revision: 0, status: 'unavailable', runStatus: run.status,
      stepId: run.stepId || run.steps?.[run.currentStep || 0]?.id,
    })));
    this.changed();
  }
  waitingRuns(executor: string, session: string): KitDelegationReceipt[] {
    const pending = new Map(this.list(executor, session).filter(row => row.runStatus === 'waiting_approval').map(row => [row.runId, row]));
    for (const row of this.waiting.get(JSON.stringify([executor, session])) || []) pending.set(row.runId, row);
    return [...pending.values()];
  }
  clear(): void { this.timers.forEach(clearTimeout); this.timers.clear(); this.entries.clear(); this.waiting.clear(); this.changed(); }
}
export const kitDelegations = new KitDelegationIndex();
export const OPEN_KIT_RECEIPT = 'awu-open-kit-receipt';
export function openKitReceipt(executor: string, row: KitDelegationReceipt): void {
  window.dispatchEvent(new CustomEvent(OPEN_KIT_RECEIPT, { detail: { executor, sessionId: row.sessionId, runId: row.runId, stepId: row.stepId } }));
}
export function delegationLabel(row: KitDelegationReceipt, now = Date.now() / 1000): string {
  if (['accepted', 'bound'].includes(row.status) && row.expiresAt && now >= row.expiresAt) return '已过期';
  return { awaiting: '等待接收回执', accepted: '已接收 · 待绑定', bound: '已绑定运行', used: '已用于本运行', expired: '已结束 / 过期', unavailable: '不可用', unknown: '结果未知' }[row.status];
}
