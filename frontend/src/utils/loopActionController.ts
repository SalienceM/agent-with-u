export type LoopActionPhase = 'idle' | 'sending' | 'accepted' | 'done' | 'error' | 'unknown';
export interface LoopActionFeedback { label: string; phase: LoopActionPhase; message: string; }
export interface ActionResult { status: string; message?: string; }

/** 只管理本工作台的回执；超时是未知，不自动重放写入。 */
export class LoopActionController {
  feedback: LoopActionFeedback = { label: '', phase: 'idle', message: '' };
  private disposed = false;
  private inFlight = false;
  private sequence = 0;
  private pendingCheck?: { label: string; accepted: boolean; read: () => Promise<boolean> };
  private unknown = new Map<string, { accepted: boolean; read?: () => Promise<boolean> }>();
  constructor(private publish: (feedback: LoopActionFeedback) => void, private timeout = 12000) {}
  dispose() { this.disposed = true; this.sequence++; }
  private update(feedback: LoopActionFeedback) { this.feedback = feedback; if (!this.disposed) this.publish(feedback); }
  async check(): Promise<void> {
    const pending = this.pendingCheck, sequence = this.sequence;
    if (!pending || this.disposed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const matched = await Promise.race([pending.read(), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), this.timeout);
      })]);
      if (matched && !this.disposed && sequence === this.sequence) {
        this.pendingCheck = undefined;
        this.unknown.delete(pending.label);
        this.update({ label: pending.label, phase: pending.accepted ? 'accepted' : 'done', message: `${pending.label}：已通过执行端状态确认` });
      }
    } catch { /* 读取失败不解除未知结果保护 */ }
    finally { if (timer) clearTimeout(timer); }
  }
  async run<T extends ActionResult>(label: string, request: () => Promise<T>, accepted = false,
    reconcile?: () => Promise<boolean>): Promise<T | ActionResult> {
    if (this.disposed || this.inFlight) {
      return { status: 'busy', message: '原操作仍在确认中，不会重复提交。' };
    }
    const unresolved = this.unknown.get(label);
    if (unresolved) {
      this.pendingCheck = unresolved.read ? { label, accepted: unresolved.accepted, read: unresolved.read } : undefined;
      this.update({ label, phase: 'unknown', message: `${label}：上次结果仍待确认，不会重复提交。` });
      return { status: 'unknown', message: '原操作仍在确认中，不会重复提交。' };
    }
    this.inFlight = true;
    this.pendingCheck = undefined;
    const sequence = ++this.sequence;
    this.update({ label, phase: 'sending', message: `${label}：正在提交…` });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([request(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待执行端回执超时')), this.timeout);
      })]);
      if (this.disposed || sequence !== this.sequence) return result;
      const ok = result?.status === 'ok';
      this.update({ label, phase: ok ? accepted ? 'accepted' : 'done' : 'error',
        // 接收回执不是实时状态；启动时的“正在准备”不能在结束/受阻后继续显示。
        message: ok ? `${label}：${accepted ? '请求已接收，当前进度以执行状态为准。' : result.message || '已完成'}` : `${label}失败：${result?.message || '执行端未返回有效回执'}` });
      return result || { status: 'error', message: '无效回执' };
    } catch (error) {
      if (!this.disposed && sequence === this.sequence) {
        this.update({ label, phase: 'unknown', message: `${label}：结果待确认（${String(error)}）。不会重复提交。` });
        this.unknown.set(label, { accepted, read: reconcile });
        // 一次有界只读核对，不轮询，不把任意状态当作成功证据。
        if (reconcile) {
          this.pendingCheck = { label, accepted, read: reconcile };
          await this.check();
        }
      }
      return { status: 'unknown', message: '未收到确定回执，请核对当前状态。' };
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight = false;
    }
  }
}
