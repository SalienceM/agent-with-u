import { api } from '../api';
import { uuid } from './uuid';
import type { ProjectTransferRecord } from '../types/projectTransfers';

export interface TransferScope { session: string; executor: string; mode: 'project' | 'return' }
export interface TransferState {
  phase: 'idle' | 'preparing' | 'preview' | 'sending' | 'succeeded' | 'unknown' | 'error';
  notice: string; target: string; targetLabel: string; backendLabel: string; plan?: ProjectTransferRecord; progress: number;
}
interface Entry { identity: string; state: TransferState; listeners: Set<() => void>; checking?: Promise<void> }
const entries = new Map<string, Entry>();
const idle = (): TransferState => ({ phase: 'idle', notice: '', target: '', targetLabel: '', backendLabel: '', progress: 0 });
const key = (scope: TransferScope) => JSON.stringify([api.projectTransferIdentity(), scope.executor, scope.session, scope.mode]);
function entry(scope: TransferScope): Entry {
  const id = key(scope);
  let value = entries.get(id);
  if (!value) { value = { identity: api.projectTransferIdentity(), state: idle(), listeners: new Set() }; entries.set(id, value); }
  return value;
}
function current(value: Entry): void {
  if (value.identity !== api.projectTransferIdentity()) throw new Error('用户身份已变化，交接已停止；请核对原操作');
}
function update(value: Entry, patch: Partial<TransferState>): void {
  value.state = { ...value.state, ...patch };
  value.listeners.forEach(listener => listener());
}
function applyResult(value: Entry, result: ProjectTransferRecord): void {
  current(value);
  const verified = result.status === 'succeeded' && result.receipt?.status === 'succeeded'
    && result.actual?.verifiedFiles === result.descriptor.files && result.actual?.verifiedBytes === result.descriptor.bytes;
  update(value, { plan: result, phase: verified ? 'succeeded' : result.status === 'preview' ? 'preview' : 'unknown',
    progress: result.offset, notice: verified ? '项目已接收并完成文件校验' : result.notice || '操作尚未确认完成；只核对原请求，不会重发写入' });
}
export function transferState(scope: TransferScope): TransferState { return entry(scope).state; }
export function subscribeTransfer(scope: TransferScope, listener: () => void): () => void {
  const value = entry(scope); value.listeners.add(listener); return () => { value.listeners.delete(listener); };
}
export function resetTransfer(scope: TransferScope): void {
  const value = entry(scope);
  if (['preparing', 'sending', 'unknown'].includes(value.state.phase)) return;
  update(value, idle());
}
export async function prepareTransfer(scope: TransferScope, target: string, targetLabel: string, title: string, backend: string, backendLabel: string): Promise<void> {
  const value = entry(scope);
  if (['preparing', 'sending', 'unknown'].includes(value.state.phase)) return;
  update(value, { ...idle(), phase: 'preparing', target, targetLabel, backendLabel });
  try {
    const [source, destination] = await Promise.all([api.projectTransferCapabilities(scope.executor, scope.session), api.projectTransferCapabilities(target)]);
    current(value);
    if (!source.git || !destination.git) throw new Error('两端都需要安装本地 Git');
    if (source.executorId === destination.executorId) throw new Error('请选择另一个实际节点');
    if (scope.mode === 'return' && source.origin?.executorId !== destination.executorId) throw new Error('请选择原项目所在节点');
    const exported = await api.projectTransferExport(scope.session, scope.executor, uuid(), destination.executorId, scope.mode);
    current(value);
    if (exported.status !== 'exported') throw new Error(exported.notice || '项目快照尚未就绪');
    const plan = await api.projectTransferPlan(target, uuid(), exported.descriptor, title, backend);
    current(value);
    if (!plan || plan.status !== 'preview') throw new Error('未取得有效的冻结计划');
    update(value, { phase: 'preview', plan });
  } catch (error) { update(value, { phase: 'error', notice: String(error) }); }
}
export async function checkTransfer(scope: TransferScope): Promise<void> {
  const value = entry(scope), { plan, target } = value.state;
  if (!plan || value.state.phase === 'sending') return;
  if (value.checking) return value.checking;
  const pending = (async () => {
    try {
      const result = await api.projectTransferStatus(target, plan.id);
      if (value.state.plan?.id === plan.id) applyResult(value, result);
    } catch (error) {
      if (value.state.plan?.id === plan.id) update(value, { phase: 'unknown', notice: `无法核对原节点：${String(error)}` });
    }
  })();
  value.checking = pending;
  try { await pending; } finally { if (value.checking === pending) value.checking = undefined; }
}
export async function confirmTransfer(scope: TransferScope): Promise<void> {
  const value = entry(scope), { plan, target } = value.state;
  if (!plan || value.state.phase !== 'preview') return;
  const request = uuid();
  update(value, { phase: 'sending', notice: '正在传输项目…', plan: { ...plan, requestId: request } });
  try {
    current(value);
    const caps = await api.projectTransferCapabilities(target); current(value);
    if (caps.executorId !== plan.descriptor.targetExecutor) throw new Error('目标节点身份已变化');
    const accepted = await api.projectTransferAccept(target, plan.id, request, plan.planFingerprint); current(value);
    if (accepted.status !== 'receiving' || accepted.offset !== 0) throw new Error('原接收状态已变化，请核对');
    let offset = 0;
    while (offset < plan.descriptor.size) {
      const chunk = await api.projectTransferRead(scope.executor, plan.descriptor.id, offset); current(value);
      if (chunk.offset !== offset || chunk.nextOffset <= offset || chunk.nextOffset > plan.descriptor.size) throw new Error('源分块范围无效');
      const received = await api.projectTransferChunk(target, plan.id, request, offset, chunk.data); current(value);
      if (received.offset !== chunk.nextOffset) throw new Error('目标分块回执不一致');
      offset = received.offset; update(value, { progress: offset });
    }
    update(value, { notice: '正在校验文件并创建 Session…' });
    applyResult(value, await api.projectTransferFinish(target, plan.id, request));
  } catch (error) {
    update(value, { phase: 'unknown', notice: `结果尚未确认：${String(error)}` });
    // 一次只读核对；关闭 UI 不取消任务，身份变化则不再访问旧用户。
    if (value.identity === api.projectTransferIdentity()) await checkTransfer(scope);
  }
}
export async function recoverTransfer(scope: TransferScope, target: string, targetLabel: string): Promise<void> {
  const value = entry(scope);
  if (['preparing', 'sending'].includes(value.state.phase)) return;
  update(value, { phase: 'preparing', target, targetLabel, notice: '' });
  try {
    const capability = await api.projectTransferCapabilities(target); current(value);
    const list = await api.projectTransferList(scope.executor, scope.session); current(value);
    for (const item of list.items.slice(0, 30)) {
      const exported = await api.projectTransferStatus(scope.executor, item.id); current(value);
      if (exported.direction !== 'export' || exported.descriptor?.mode !== scope.mode || exported.descriptor.targetExecutor !== capability.executorId) continue;
      const result = await api.projectTransferFind(target, exported.id); current(value);
      if (result) { applyResult(value, result); return; }
    }
    update(value, { phase: 'idle', notice: '所选节点没有本 Session 的接收记录' });
  } catch (error) { update(value, { phase: 'error', notice: String(error) }); }
}
