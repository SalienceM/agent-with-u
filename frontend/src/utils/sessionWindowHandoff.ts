import { uuid } from './uuid';
import { byteHash } from './documentCodec';
import { handoffEnvelope, readHandoffEnvelope, type HandoffEnvelope, type HandoffState, type HandoffJournalRecord } from './workbenchHandoffState';
import type { HandoffReceipt, WindowOwnershipClient } from './workbenchWindows';

export interface HandoffIO {
  capture: () => Promise<HandoffState['parts']>;
  restore: (parts: HandoffState['parts'], current: () => boolean) => Promise<void>;
  persist: (envelope: HandoffEnvelope, state?: HandoffJournalRecord['state']) => Promise<void>;
  read: (request: string) => Promise<HandoffJournalRecord | undefined>;
  /** 通知只用于唤醒，收到后仍须向执行端读回原计划。 */
  offer: (plan: HandoffReceipt) => Promise<void>;
  release: () => void;
}
export interface HandoffProgress { phase: 'idle' | 'preparing' | 'waiting' | 'committing' | 'moved' | 'unknown'; message: string; requestId?: string; settled?: boolean }

function mutableDigest(parts: HandoffState['parts']): string {
  const input = parts.input as any;
  const files = (row: any) => row ? { tabs: row.tabs, active: row.active, documents: row.documents?.map((doc: any) => ({
    identity: doc.identity, text: doc.text, baseText: doc.baseText, baseVersion: doc.baseVersion, revision: doc.revision })) } : undefined;
  // 自动流滚动、光标测量不是新的用户输入，不让后台输出妨碍窗口移动。
  return byteHash(new TextEncoder().encode(JSON.stringify({ input: input ? { text: input.text, images: input.images, textAttachments: input.textAttachments } : undefined,
    filesEngine: files(parts.filesEngine), filesChat: files(parts.filesChat), layout: parts.layout, documents: parts.documents })));
}

/** 状态传递与窗口归属分离。窗口创建成功、收到 BC 消息都不能单独触发源撤下。 */
export class SessionWindowHandoff {
  private plan: HandoffReceipt | null = null;
  private envelope: HandoffEnvelope | null = null;
  private requestId: string | null = null;
  private disposed = false;
  private busy = false;
  constructor(readonly client: WindowOwnershipClient, private io: HandoffIO,
    private progress: (value: HandoffProgress) => void, private current: () => boolean) {}
  dispose() { this.disposed = true; }
  private check() { if (this.disposed || !this.current()) throw new Error('窗口交接身份已变化'); }
  private report(phase: HandoffProgress['phase'], message: string, settled = false) {
    if (!this.disposed && this.current()) this.progress({ phase, message, requestId: this.requestId || undefined, settled });
  }
  async move(targetWindow: string, targetReady: Promise<void>): Promise<void> {
    this.check(); if (this.busy || this.plan) throw new Error('已有窗口交接，请核对原操作');
    this.busy = true; this.requestId = uuid(); this.report('preparing', '正在准备目标窗口；原工作台仍保留。');
    try {
      await targetReady; this.check();
      const identity = this.client.transport.identity!;
      const state: HandoffState = { format: 1, workspace: this.client.workspace, clientId: identity.clientId,
        sourceWindow: identity.windowId, targetWindow, requestId: this.requestId, version: 1, parts: await this.io.capture() };
      this.check(); this.envelope = handoffEnvelope(state);
      await this.io.persist(this.envelope); this.check();
      this.plan = await this.client.prepare(targetWindow, this.envelope.digest, state.version, this.requestId);
      this.report('waiting', '等待目标恢复草稿和文件并确认；新的发送、保存和输入已冻结。');
      await this.io.offer(this.plan); this.check();
      const observed = await this.client.get(this.plan.requestId); this.check();
      if (!observed.receipt || observed.receipt.status !== 'acknowledged') throw new Error('目标尚未确认原交接，未撤下源工作台');
      if (mutableDigest(await this.io.capture()) !== mutableDigest(this.envelope.state.parts)) throw new Error('冻结期间草稿发生变化，请取消本次交接后重试；没有覆盖目标');
      this.check(); this.report('committing', '目标状态已就绪，正在核对归属提交…');
      const committed = await this.client.finish(this.plan, true); this.check();
      if (committed.status !== 'committed') throw new Error('交接未提交');
      // journal 已在 prepare 前持久保存。这里的元数据写失败不推翻权威提交。
      await this.io.persist(this.envelope, 'committed').catch(() => {});
      this.check(); this.io.release(); this.report('moved', '工作台已移动；后台任务没有被停止。');
    } catch (error) {
      if (this.envelope || this.plan) this.report('unknown', `${error instanceof Error ? error.message : error}。请核对原操作或明确取消；不会自动重试写入。`);
      else { this.requestId = null; this.report('idle', error instanceof Error ? error.message : String(error)); }
      throw error;
    } finally { this.busy = false; }
  }
  async receive(requestId: string): Promise<void> {
    this.check(); if (this.busy) return;
    this.busy = true; this.requestId = requestId;
    try {
      this.report('waiting', '正在从原交接恢复状态，尚未取得发送或保存权。');
      const { state, receipt } = await this.client.get(requestId); this.check();
      if (!receipt || state.pending?.requestId !== requestId || receipt.targetWindow !== this.client.transport.identity?.windowId
        || !['prepared', 'acknowledged'].includes(receipt.status)) throw new Error('没有匹配的待接收交接');
      const record = await this.io.read(requestId); this.check();
      if (!record) throw new Error('未找到可靠交接恢复记录，原窗口必须保留');
      const envelope = readHandoffEnvelope(record.payload, this.client.workspace, this.client.transport.identity!.clientId,
        this.client.transport.identity!.windowId, receipt.stateDigest);
      if (envelope.state.requestId !== requestId || envelope.state.version !== receipt.stateVersion || envelope.state.sourceWindow !== receipt.sourceWindow) throw new Error('交接计划与恢复内容不匹配');
      await this.io.restore(envelope.state.parts, () => !this.disposed && this.current()); this.check();
      await this.client.ack(receipt); this.check();
      this.plan = receipt; this.envelope = envelope;
      this.report('waiting', '已确认目标状态，等待源提交归属；不会自动同意工具确认。');
    } catch (error) { this.report('unknown', error instanceof Error ? error.message : String(error)); throw error; }
    finally { this.busy = false; }
  }
  async reconcile(): Promise<void> {
    this.check();
    const { state, receipt } = await this.client.get(this.requestId || undefined); this.check();
    if (state.pending) { this.requestId = state.pending.requestId; this.plan = state.pending; }
    if (receipt) this.plan = receipt;
    if (receipt?.status === 'committed' || !state.frozen) {
      const ours = state.windowId === this.client.transport.identity?.windowId;
      if (!ours && receipt?.status === 'committed') this.io.release();
      this.plan = null; this.requestId = null;
      this.report(ours ? 'idle' : 'moved', ours ? '已核对：此窗口拥有工作台。' : '已核对：工作台属于其他窗口。', ours);
    } else this.report('unknown', `交接仍为 ${receipt?.status || '待核对'}，请保留恢复记录；不重发写请求。`);
  }
  async restoreCheckpoint(requestId: string): Promise<void> {
    this.check(); if (this.busy) throw new Error('正在处理原交接');
    this.busy = true; this.requestId = requestId;
    this.report('waiting', '核对最后可靠恢复包；不会自动保存文件或处理工具授权。');
    try {
      const { state, receipt } = await this.client.get(requestId); this.check();
      const windowId = this.client.transport.identity!.windowId;
      if (state.frozen || state.windowId !== windowId || !receipt || !['committed', 'cancelled'].includes(receipt.status)
        || receipt.ownerWindow !== windowId || receipt.committedGeneration !== state.generation) throw new Error('此恢复包不属于当前归属代次');
      this.client.transport.markUnknown(this.client.target.executor, this.client.target.session);
      const record = await this.io.read(requestId); this.check();
      if (!record) throw new Error('可靠恢复包不可用');
      const envelope = readHandoffEnvelope(record.payload, this.client.workspace, state.clientId, receipt.targetWindow, receipt.stateDigest);
      if (envelope.state.requestId !== requestId || envelope.state.sourceWindow !== receipt.sourceWindow || envelope.state.version !== receipt.stateVersion) throw new Error('恢复包与原回执不一致');
      await this.io.restore(envelope.state.parts, () => !this.disposed && this.current()); this.check();
      const checked = await this.client.get(requestId); this.check();
      if (checked.state.generation !== state.generation || checked.state.windowId !== windowId || checked.state.frozen) throw new Error('恢复期间归属已变化');
      this.requestId = null; this.plan = null; this.envelope = null;
      this.report('idle', '已恢复最后可靠交接状态；后台任务没有重启，文件没有自动保存。', true);
    } catch (error) {
      this.report('unknown', error instanceof Error ? error.message : String(error)); throw error;
    } finally { this.busy = false; }
  }
  async resume(): Promise<void> {
    this.check(); if (this.busy) throw new Error('原交接仍在处理中');
    const checked = await this.client.get(this.requestId || undefined); this.check();
    const plan = checked.state.pending || checked.receipt;
    if (!plan || ['committed', 'cancelled'].includes(plan.status)) { await this.reconcile(); return; }
    this.requestId = plan.requestId;
    if (plan.targetWindow === this.client.transport.identity?.windowId) { await this.receive(plan.requestId); return; }
    if (plan.sourceWindow !== this.client.transport.identity?.windowId) throw new Error('此窗口不属于原交接');
    this.busy = true; this.plan = plan;
    try {
      const record = await this.io.read(plan.requestId); this.check();
      if (!record) throw new Error('原交接恢复包不可用');
      const envelope = readHandoffEnvelope(record.payload, this.client.workspace, this.client.transport.identity!.clientId, plan.targetWindow, plan.stateDigest);
      if (envelope.state.requestId !== plan.requestId || envelope.state.sourceWindow !== plan.sourceWindow || envelope.state.version !== plan.stateVersion) throw new Error('原计划不匹配');
      if (mutableDigest(await this.io.capture()) !== mutableDigest(envelope.state.parts)) throw new Error('当前草稿与原交接不同，请取消后重新移动或从恢复包恢复；没有覆盖任何一方');
      this.envelope = envelope;
      if (plan.status !== 'acknowledged') {
        this.report('waiting', '再次唤醒原目标；不创建新窗口，不重发聊天或保存。');
        await this.io.offer(plan); this.check();
      }
      const ready = await this.client.get(plan.requestId); this.check();
      if (ready.receipt?.status !== 'acknowledged') throw new Error('原目标仍未确认');
      if (mutableDigest(await this.io.capture()) !== mutableDigest(envelope.state.parts)) throw new Error('草稿已变化，请取消原交接后重试');
      const result = await this.client.finish(plan, true); this.check();
      if (result.status !== 'committed') throw new Error('原交接未提交');
      await this.io.persist(envelope, 'committed').catch(() => {});
      this.io.release(); this.report('moved', '原交接已核对提交；未重跑后台任务。');
    } catch (error) { this.report('unknown', String(error)); throw error; }
    finally { this.busy = false; }
  }
  async cancel(): Promise<void> {
    this.check(); if (this.busy || !this.requestId) return;
    this.busy = true;
    try {
      const checked = await this.client.get(this.requestId); this.check();
      if (!checked.receipt) { this.plan = null; this.envelope = null; this.requestId = null; this.report('idle', '执行端没有该交接；恢复包仍保留。'); return; }
      if (checked.receipt.sourceWindow !== this.client.transport.identity?.windowId) throw new Error('只能由源窗口取消交接');
      const receipt = await this.client.finish(checked.receipt, false); this.check();
      if (receipt.status === 'committed') { this.io.release(); this.report('moved', '原交接已提交，迟到取消没有撤销归属。'); return; }
      if (this.envelope) await this.io.persist(this.envelope, 'cancelled').catch(() => {});
      this.plan = null; this.envelope = null; this.requestId = null;
      this.report('idle', '交接已取消，源工作台继续可用；没有停止后台任务。', true);
    } finally { this.busy = false; }
  }
}
