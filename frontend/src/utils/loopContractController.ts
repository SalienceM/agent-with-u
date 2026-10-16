import { repairActive, type RepairEligibility, type RepairReceipt, type RepairRequest, type RepairResponse } from '../types/loopContract';

export interface RepairFeedback { receipt?: RepairReceipt; sending: boolean; checking: boolean; error: string; }
interface Transport {
  request: (payload: RepairRequest) => Promise<RepairResponse>;
  get: (requestId: string) => Promise<RepairResponse>;
  cancel: (requestId: string) => Promise<RepairResponse>;
}
// 生命周期由已有工作台控制器拥有。无定时器、无写重试、无执行端回退。
export class LoopContractController {
  feedback: RepairFeedback = { sending: false, checking: false, error: '' };
  private alive = true;
  private revision = 0;
  private query?: Promise<void>;
  private locked = false;
  private context = '';
  constructor(private transport: Transport, private notify: (value: RepairFeedback) => void,
    private id: () => string = () => crypto.randomUUID()) {}
  private publish(patch: Partial<RepairFeedback>) { if (this.alive) { this.feedback = { ...this.feedback, ...patch }; this.notify(this.feedback); } }
  dispose() { this.alive = false; }
  receive(eligibility?: RepairEligibility, receipt?: RepairReceipt) {
    this.context = eligibility ? JSON.stringify([eligibility.causeRef, eligibility.causeRevision, eligibility.round, eligibility.seq, eligibility.controlRevision]) : '';
    if (repairActive(this.feedback.receipt) && this.feedback.receipt?.requestId !== receipt?.requestId) return;
    if (receipt?.requestId === this.feedback.receipt?.requestId && !repairActive(this.feedback.receipt) && repairActive(receipt)) return;
    if (receipt?.requestId && JSON.stringify(receipt) !== JSON.stringify(this.feedback.receipt)) {
      this.revision++; this.publish({ receipt, error: '' });
    }
  }
  async request(eligibility?: RepairEligibility, available = true) {
    if (!this.alive || !available || !eligibility?.canRequest || this.locked || repairActive(this.feedback.receipt)) return;
    const context = this.context;
    const payload: RepairRequest = { requestId: this.id(), causeRef: eligibility.causeRef, causeRevision: eligibility.causeRevision,
      round: eligibility.round, seq: eligibility.seq, controlRevision: eligibility.controlRevision };
    this.locked = true;
    const revision = this.revision;
    this.publish({ sending: true, error: '', receipt: { ...payload, status: 'accepted', reason: '正在提交修复请求；接收不等于完成。' } });
    try {
      const result = await this.transport.request(payload);
      if (!this.alive || this.context !== context || revision !== this.revision) return;
      const confirmed = result.operation?.requestId === payload.requestId && !!result.operation.status;
      this.publish(result.status === 'error' ? { receipt: { ...payload, status: 'failed' }, error: result.message || '修复请求未被接受' }
        : { receipt: confirmed ? result.operation : { ...payload, status: 'unknown' } });
      if (result.status !== 'error' && (!confirmed || result.operation?.status === 'unknown')) await this.check();
    } catch {
      if (!this.alive || this.context !== context || revision !== this.revision) return;
      this.publish({ receipt: { ...payload, status: 'unknown', reason: '结果待确认，不重复提交。' } });
      await this.check(); // 仅一次合并只读查询，不轮询。
    } finally { this.locked = false; this.publish({ sending: false }); }
  }
  check(): Promise<void> {
    if (this.query) return this.query;
    if (!this.alive || !this.feedback.receipt?.requestId) return Promise.resolve();
    const rid = this.feedback.receipt.requestId;
    const revision = this.revision, context = this.context;
    this.publish({ checking: true });
    this.query = (async () => {
      try {
        const result = await this.transport.get(rid);
        if (!this.alive || revision !== this.revision || context !== this.context || rid !== this.feedback.receipt?.requestId) return;
        if (result.status === 'ok' && result.operation?.requestId === rid) this.publish({ receipt: result.operation, error: '' });
        else this.publish({ error: result.message || '未取得原请求回执，保护仍保留。' });
      } catch { if (this.alive && revision === this.revision && context === this.context) this.publish({ error: '回执读取失败；可手动重查，不会切换节点或重新提交。' }); }
      finally { this.query = undefined; this.publish({ checking: false }); }
    })();
    return this.query;
  }
  async cancel() {
    if (!this.alive || this.locked || !repairActive(this.feedback.receipt) || !this.feedback.receipt?.requestId) return;
    this.locked = true; this.publish({ sending: true });
    const revision = this.revision;
    try {
      const result = await this.transport.cancel(this.feedback.receipt!.requestId!);
      if (this.alive && revision === this.revision) this.publish({ error: result.message || '已请求停止，等待退出确认；已开始的提交不会被截断。' });
    } catch { if (this.alive && revision === this.revision) this.publish({ error: '停止结果未确认，请查原回执。' }); }
    finally { this.locked = false; this.publish({ sending: false }); }
    await this.check();
  }
}

export function contractSnapshotStale(previous?: { causeRef?: string; causeRevision?: number }, incoming?: { causeRef?: string; causeRevision?: number }): boolean {
  return !!previous?.causeRef && !!incoming?.causeRef && (previous.causeRevision || 0) > (incoming.causeRevision || 0);
}
