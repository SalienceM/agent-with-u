import { imageSnapshot, type ImageDraftContext, type ImageInput, type ImageScope, type ImageSnapshot } from './harnessImageSubmission';

export interface ComposerReceipt {
  version: 1; requestId: string; sessionId: string; userMessageId: string; messageId: string;
  draftRevision: number; revision: number; state: 'preparing' | 'accepted' | 'queued' | 'rejected' | 'unknown'; reason?: string; queue?: boolean;
}
export interface ComposerSendResult { kind: 'composer'; receipt: ComposerReceipt }
export interface ComposerAttempt { receipt: ComposerReceipt; snapshot: ImageSnapshot; cleared: boolean }
interface IO {
  current(scope: ImageScope): boolean;
  write(scope: ImageScope, payload: Record<string, unknown>, queue: boolean): Promise<unknown>;
  read(scope: ImageScope, id: string): Promise<unknown>;
  id(): string;
}
export class ComposerSubmissions {
  private slots = new Map<string, ComposerAttempt[]>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(private io: IO) {}
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = (): number => this.version;
  private changed(): void { this.version++; this.listeners.forEach(fn => fn()); }
  list(scope: ImageScope): ComposerAttempt[] { return this.slots.get(scope.key) || []; }
  clear(): void { this.slots.clear(); this.changed(); }
  observe(scope: ImageScope, value: unknown): void {
    if (!this.io.current(scope) || !value || typeof value !== 'object') return;
    const row = value as ComposerReceipt;
    const attempt = this.list(scope).find(item => item.receipt.requestId === row.requestId);
    if (!attempt || row.version !== 1 || row.sessionId !== scope.session || row.userMessageId !== attempt.receipt.userMessageId
      || row.messageId !== attempt.receipt.messageId || row.draftRevision !== attempt.receipt.draftRevision || !Number.isSafeInteger(row.revision)
      || row.revision <= attempt.receipt.revision || !['preparing', 'accepted', 'queued', 'rejected', 'unknown'].includes(row.state)) return;
    if (['accepted', 'queued', 'rejected'].includes(attempt.receipt.state)) return;
    attempt.receipt = { ...row }; this.changed();
  }
  shouldClear(attempt: ComposerAttempt, revision: number): boolean {
    return !attempt.cleared && attempt.snapshot.draftRevision === revision && ['accepted', 'queued'].includes(attempt.receipt.state);
  }
  async reconcile(scope: ImageScope, requestId: string): Promise<void> {
    this.observe(scope, await this.io.read(scope, requestId));
  }
  handoff(scope: ImageScope, revision: number): Array<Record<string, unknown>> {
    return this.list(scope).filter(item => !item.cleared).map(item => ({ ...item.receipt, snapshotCurrent: item.snapshot.draftRevision === revision }));
  }
  adopt(scope: ImageScope, rows: unknown, input: ImageInput, revision: number, validateOnly = false): void {
    if (rows === undefined) return;
    if (!Array.isArray(rows) || rows.length > 8 || rows.some(row => !row || typeof row !== 'object'
      || Object.keys(row).some(key => !['version', 'requestId', 'sessionId', 'userMessageId', 'messageId', 'draftRevision', 'revision', 'state', 'reason', 'queue', 'snapshotCurrent'].includes(key))
      || row.version !== 1 || row.sessionId !== scope.session || !['requestId', 'userMessageId', 'messageId'].every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 200)
      || !Number.isSafeInteger(row.revision) || row.revision < 0 || !Number.isSafeInteger(row.draftRevision)
      || !['preparing', 'unknown', 'accepted', 'queued', 'rejected'].includes(row.state)
      || row.reason !== undefined && (typeof row.reason !== 'string' || row.reason.length > 1000))) throw new Error('输入回执交接无效');
    if (validateOnly) return;
    this.slots.set(scope.key, rows.map(({ snapshotCurrent, ...receipt }) => ({ receipt: receipt as ComposerReceipt,
      snapshot: imageSnapshot(snapshotCurrent ? input : { content: '原输入位于来源窗口 / 原对话，请按请求核对。' }, snapshotCurrent ? revision : -1), cleared: false })));
    this.changed();
  }
  async submit(scope: ImageScope, input: ImageInput & Record<string, unknown>, draft: ImageDraftContext, queue: boolean): Promise<ComposerSendResult> {
    const rows = this.list(scope);
    const prior = rows.find(item => item.snapshot.draftRevision === draft.draftRevision && item.receipt.state !== 'rejected');
    if (prior) return { kind: 'composer', receipt: prior.receipt };
    const receipt: ComposerReceipt = { version: 1, requestId: this.io.id(), sessionId: scope.session,
      userMessageId: String(input.userMessageId || this.io.id()), messageId: String(input.messageId || this.io.id()),
      draftRevision: draft.draftRevision, revision: 0, state: 'preparing', queue };
    const attempt = { receipt, snapshot: imageSnapshot({ ...input, content: draft.originalContent ?? input.content }, draft.draftRevision), cleared: false };
    if (!this.io.current(scope) || draft.scopeKey !== scope.key) {
      receipt.state = 'rejected'; receipt.reason = '输入身份已变化，未发送'; return { kind: 'composer', receipt };
    }
    if (rows.filter(item => ['preparing', 'unknown'].includes(item.receipt.state)).length >= 8) {
      receipt.state = 'rejected'; receipt.reason = '请先核对待决提交'; return { kind: 'composer', receipt };
    }
    this.slots.set(scope.key, [...rows.filter(item => !item.cleared).slice(-7), attempt]); this.changed();
    try {
      const result = await this.io.write(scope, { ...input, ...receipt }, queue);
      this.observe(scope, result);
    } catch (error) {
      if (this.io.current(scope) && attempt.receipt.state === 'preparing') {
        attempt.receipt = { ...attempt.receipt, state: (error as any)?.notSubmitted ? 'rejected' : 'unknown', reason: error instanceof Error ? error.message : '接收未确认' };
        this.changed();
      }
    }
    // preparing 是请求接入，不是消息落盘。一次超时提示，不轮询/不重发。
    if (attempt.receipt.state === 'preparing') setTimeout(() => {
      if (this.io.current(scope) && attempt.receipt.state === 'preparing') {
        attempt.receipt = { ...attempt.receipt, state: 'unknown', reason: '尚未确认接收，请核对原请求；未重发。' }; this.changed();
      }
    }, 12000);
    return { kind: 'composer', receipt: attempt.receipt };
  }
}
