import type { WorkspaceIdentity } from './sessionWorkbench';
export type ControlAction = 'takeover' | 'release';
export interface EngineeringActivity {
  activityId: string; kind: 'document-save' | 'terminal' | 'language-write'; workspace: WorkspaceIdentity;
  status: string; resourceId: string; generation: string; relativePath: string;
}
export interface ControlTarget { user: string; executor: string; session: string }
export interface ControlEligibility { allowed: boolean; reasonCode: string; message: string; nextStep: string }
export interface ControlOperation {
  requestId: string; action: ControlAction; status: string; phase: string; revision: number;
  startedAt: number; updatedAt: number; committed: boolean; checkpointAvailable: boolean | null;
  controlRevision: number; reasonCode: string; message: string;
}
export interface ControlSummary {
  protocolVersion: number; sessionId: string; controlMode: 'manual' | 'loop'; controlRevision: number;
  auto: boolean; stage: string; round: number;
  eligibility: Record<ControlAction, ControlEligibility>; operation?: ControlOperation;
  currentOperation?: ControlOperation;
  status?: string; message?: string;
  engineeringActivities?: EngineeringActivity[];
}
export type ControlPhase = 'idle' | 'sending' | 'running' | 'reconciling' | 'view-loading'
  | 'succeeded' | 'blocked' | 'failed' | 'view-error';
export interface ControlView {
  phase: ControlPhase; summary?: ControlSummary; requestId?: string; action?: ControlAction;
  error: string; checking: boolean; since: number;
}
interface ControlIO {
  get(target: ControlTarget, requestId: string): Promise<ControlSummary>;
  request(target: ControlTarget, input: Record<string, unknown>, legacy: boolean): Promise<ControlSummary>;
  apply(target: ControlTarget, summary: ControlSummary): void;
  requestId(): string;
  restore?(target: ControlTarget): Partial<ControlView> | null;
  remember?(target: ControlTarget, view: ControlView): void;
}
const EMPTY: ControlView = Object.freeze({ phase: 'idle', error: '', checking: false, since: 0 });
export const controlKey = (target: ControlTarget): string => JSON.stringify([target.user, target.executor, target.session]);
export const controlBusy = (view: ControlView): boolean =>
  ['sending', 'running', 'reconciling', 'view-loading', 'view-error'].includes(view.phase);

export class LoopControlStore {
  private values = new Map<string, ControlView>();
  private listeners = new Map<string, Set<() => void>>();
  private reads = new Map<string, Promise<void>>();
  private goals = new Map<string, string>();
  constructor(private io: ControlIO) {}
  get(target: ControlTarget): ControlView {
    const key = controlKey(target);
    if (!this.values.has(key)) {
      const restored = this.io.restore?.(target);
      if (restored?.requestId) this.values.set(key, { ...EMPTY, ...restored, phase: 'reconciling' });
    }
    return this.values.get(key) || EMPTY;
  }
  subscribe(target: ControlTarget, listener: () => void): () => void {
    const key = controlKey(target), listeners = this.listeners.get(key) || new Set();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  private set(target: ControlTarget, value: ControlView): void {
    const key = controlKey(target);
    this.values.set(key, value);
    this.io.remember?.(target, value);
    this.listeners.get(key)?.forEach(fn => fn());
  }
  receive(target: ControlTarget, summary: ControlSummary): void {
    if (summary.sessionId !== target.session) return;
    // requestId 查询可同时返回历史回执；控制权 UI 始终跟随当前操作。
    if (summary.currentOperation) summary = { ...summary, operation: summary.currentOperation };
    const previous = this.get(target), old = previous.summary, op = summary.operation;
    if (old && (summary.controlRevision < old.controlRevision ||
      (op?.controlRevision || 0) < (old.operation?.controlRevision || 0) ||
      summary.controlRevision === old.controlRevision && op?.requestId === old.operation?.requestId
      && (op?.revision || 0) < (old.operation?.revision || 0))) return;
    if (['sending', 'reconciling'].includes(previous.phase) && previous.requestId
      && op?.requestId !== previous.requestId && summary.controlRevision <= (old?.controlRevision ?? -1)) return;
    if (['blocked', 'failed'].includes(previous.phase) && previous.requestId
      && op?.requestId !== previous.requestId && summary.controlRevision <= (old?.controlRevision ?? -1)) {
      this.set(target, { ...previous, summary, checking: false });
      this.io.apply(target, summary);
      return;
    }
    const sameOperation = !!op?.requestId && op.requestId === previous.requestId;
    let phase: ControlPhase = previous.phase;
    if (op?.requestId) {
      if (op.committed && op.status === 'succeeded') {
        phase = sameOperation && ['succeeded', 'view-error'].includes(previous.phase) ? previous.phase : 'view-loading';
      } else if (['failed', 'blocked', 'interrupted'].includes(op.status)) {
        phase = op.status === 'blocked' ? 'blocked' : 'failed';
      } else phase = op.status === 'unresolved' ? 'reconciling' : 'running';
    } else if (!['sending', 'reconciling'].includes(previous.phase)) phase = 'idle';
    this.set(target, { ...previous, summary, phase, checking: false,
      requestId: op?.requestId || previous.requestId, action: op?.action || previous.action,
      error: ['failed', 'blocked', 'reconciling'].includes(phase) ? op?.message || previous.error : '',
      since: sameOperation ? previous.since : op?.startedAt ? op.startedAt * 1000 : previous.since });
    this.io.apply(target, summary);
  }
  check(target: ControlTarget): Promise<void> {
    const key = controlKey(target), existing = this.reads.get(key);
    if (existing) return existing;
    const start = this.get(target);
    this.set(target, { ...start, checking: true });
    const read = Promise.resolve().then(() => this.io.get(target, start.requestId || '')).then(result => {
      this.receive(target, result);
    }).catch(error => {
      const current = this.get(target);
      // 只读核对可能晚于 committed 推送/视图水合；旧查询失败不能降级较新的请求或阶段。
      if (current.requestId !== start.requestId || current.phase !== start.phase || current.summary !== start.summary) return;
      const message = error instanceof Error ? error.message : '执行节点不可达，结果待确认';
      const unavailable = { allowed: false, reasonCode: 'offline', message, nextStep: 'check' };
      this.set(target, { ...current, checking: false,
        summary: current.summary ? { ...current.summary, eligibility: { takeover: unavailable, release: unavailable } } : undefined,
        phase: current.requestId && !['view-loading', 'succeeded', 'view-error'].includes(current.phase) ? 'reconciling' : current.phase,
        error: message });
    }).finally(() => {
      this.reads.delete(key);
      const current = this.get(target);
      if (current.checking) this.set(target, { ...current, checking: false });
    });
    this.reads.set(key, read);
    return read;
  }
  async request(target: ControlTarget, action: ControlAction, goal = ''): Promise<void> {
    const current = this.get(target);
    if (controlBusy(current)) return;
    if (!current.summary?.eligibility[action]?.allowed) {
      this.set(target, { ...current, phase: 'blocked', action,
        error: current.summary?.eligibility[action]?.message || '请先检查执行节点上的控制权状态' });
      return;
    }
    const requestId = this.io.requestId();
    this.goals.set(controlKey(target), goal);
    this.set(target, { ...current, phase: 'sending', requestId, action, since: Date.now(), error: '' });
    try {
      const result = await this.io.request(target, { requestId, action, goal,
        expectedControlRevision: current.summary.controlRevision }, current.summary.protocolVersion === 0);
      if (result.status === 'error') {
        if (this.get(target).summary?.operation?.requestId === requestId && this.get(target).summary?.operation?.committed) return;
        if (result.operation?.requestId && !['succeeded', 'failed', 'blocked', 'interrupted'].includes(result.operation.status))
          this.receive(target, result);
        else if (this.get(target).requestId === requestId) {
          if (result.sessionId === target.session) this.receive(target, result);
          this.set(target, { ...this.get(target), phase: 'blocked', requestId, action,
            error: result.message || '条件已变化，请检查状态' });
        }
      } else this.receive(target, result);
    } catch (error) {
      const latest = this.get(target);
      if (latest.requestId !== requestId) return;
      // 完成推送可能先于超时/断线返回，不能把已确认成功退回未知。
      if (latest.summary?.operation?.requestId === requestId && latest.summary.operation.committed) return;
      this.set(target, { ...latest, phase: 'reconciling', checking: false,
        error: error instanceof Error ? error.message : '未收到确定结果，请检查状态' });
      await this.check(target); // 单次核对；失败不递归，不自动重发写请求。
    }
  }
  retry(target: ControlTarget): Promise<void> {
    return this.request(target, this.get(target).action || 'takeover', this.goals.get(controlKey(target)) || '');
  }
  view(target: ControlTarget, revision: number, error = ''): void {
    const current = this.get(target);
    if (current.summary?.controlRevision !== revision || !current.summary.operation?.committed
      || current.summary.operation.requestId !== current.requestId
      || !['view-loading', 'view-error', 'succeeded'].includes(current.phase)) return;
    const phase = error ? 'view-error' : 'succeeded';
    if (current.phase !== phase || current.error !== error) this.set(target, { ...current, phase, error });
  }
}
