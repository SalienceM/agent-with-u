import { uuid } from './uuid';
import { readWorkbenchCapabilities, type WorkbenchCall, type WorkbenchTarget, type WorkspaceIdentity } from './sessionWorkbench';
import { sameWorkspace } from './workspaceDocuments';

export interface WindowNavigation { clientId: string; windowId: string }
export interface WindowOwnership {
  status: 'ok'; workspace: WorkspaceIdentity; clientId: string; windowId: string;
  generation: number; revision: number; frozen: boolean; pending: HandoffReceipt | null;
}
export interface HandoffReceipt {
  requestId: string; sourceWindow: string; targetWindow: string; generation: number;
  stateDigest: string; stateVersion: number; fingerprint: string;
  status: 'prepared' | 'acknowledged' | 'committed' | 'cancelled';
  ownerWindow?: string; committedGeneration?: number; revision?: number;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
const key = (executor: string, session: string) => JSON.stringify([executor, session]);
export const windowMutations = new Set(['sendMessage', 'executeCommand', 'workspaceDocumentSave',
  'terminalCreate', 'terminalInput', 'terminalResize', 'terminalStop', 'languageServiceStart', 'languageServiceRequest', 'languageServiceStop',
  'steerMessage', 'redirectMessage', 'steerSeqTask', 'seqtaskAdd', 'seqtaskEdit', 'seqtaskRemove', 'seqtaskReorder',
  'seqtaskSetAuto', 'seqtaskTakeNext', 'seqtaskClear', 'abortMessage', 'grantPermission', 'loopControlRequest', 'loopTakeover', 'loopRelease']);

/** 只存无授权效力的客户端/窗口标识。认证仍由原 WebSocket/Relay 路径完成。 */
export function loadWindowNavigation(user: string, local: Pick<Storage, 'getItem' | 'setItem'>,
  session: Pick<Storage, 'getItem' | 'setItem'>, routedWindow?: string): WindowNavigation {
  const clientKey = `awu-window-client-v1:${user}`, windowKey = `awu-window-id-v1:${user}`;
  let clientId = local.getItem(clientKey), windowId = routedWindow || session.getItem(windowKey);
  if (!id(clientId)) { clientId = uuid(); local.setItem(clientKey, clientId); }
  if (!id(windowId)) windowId = uuid();
  session.setItem(windowKey, windowId);
  return { clientId, windowId };
}

export class WindowTransport {
  private documentId = uuid();
  private navigation: WindowNavigation | null = null;
  private states = new Map<string, { state: WindowOwnership; unknown: boolean }>();
  private localHolds = new Set<string>();
  private listeners = new Set<() => void>();
  get identity(): WindowNavigation | null { return this.navigation; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { this.listeners.forEach(listener => listener()); }
  activate(navigation: WindowNavigation) {
    if (!id(navigation.clientId) || !id(navigation.windowId)) throw new Error('窗口身份无效');
    if (this.navigation && JSON.stringify(this.navigation) !== JSON.stringify(navigation)) throw new Error('连接内不能替换窗口身份');
    this.navigation = Object.freeze({ ...navigation });
  }
  clear() { this.navigation = null; this.documentId = uuid(); this.states.clear(); this.localHolds.clear(); this.changed(); }
  hold(executor: string, session: string, held: boolean) { const id = key(executor, session); held ? this.localHolds.add(id) : this.localHolds.delete(id); this.changed(); }
  held(executor: string, session: string) { return this.localHolds.has(key(executor, session)); }
  observe(executor: string, state: WindowOwnership): void {
    const previous = this.states.get(key(executor, state.workspace.sessionId));
    if (previous && sameWorkspace(previous.state.workspace, state.workspace) && previous.state.revision > state.revision) return;
    this.states.set(key(executor, state.workspace.sessionId), { state, unknown: false }); this.changed();
  }
  markUnknown(executor: string, session: string) {
    const row = this.states.get(key(executor, session)); if (row) { row.unknown = true; this.changed(); }
  }
  get(executor: string, session: string) { return this.states.get(key(executor, session)); }
  metadata(executor: string, method: string, params: unknown[]): object | undefined {
    if (!this.navigation) return undefined;
    const navigation = { ...this.navigation, documentId: this.documentId };
    if (!windowMutations.has(method)) return navigation;
    let session = typeof params[0] === 'string' ? params[0] : '';
    if (method === 'sendMessage' || method === 'executeCommand') {
      const payload = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0]; session = (payload as any)?.sessionId || '';
    }
    const row = this.get(executor, session);
    if (!row) return navigation; // 服务端若已有归属，会拒绝缺少租约的写。
    if (this.held(executor, session) || row.unknown || row.state.frozen || row.state.windowId !== this.navigation.windowId) throw new Error('工作台归属正在交接或不属于此窗口，请先核对原操作。');
    return { ...navigation, lease: { sessionId: session, generation: row.state.generation, workspaceRevision: row.state.workspace.workspaceRevision } };
  }
}
export const windowTransport = new WindowTransport();

/** 每个客户端实例的权威归属协议。未知提交只读核对，不重发写，不依赖 BroadcastChannel 排他。 */
export class WindowOwnershipClient {
  private constructor(readonly target: Readonly<WorkbenchTarget>, readonly workspace: WorkspaceIdentity,
    private call: WorkbenchCall, private current: () => boolean, readonly transport: WindowTransport) {}
  static async connect(target: WorkbenchTarget, call: WorkbenchCall, current: () => boolean,
    transport: WindowTransport, activate: () => WindowNavigation): Promise<WindowOwnershipClient> {
    const capability = await readWorkbenchCapabilities(target, call, current);
    if (!current()) throw new Error('工作台身份已变化');
    if (capability.capabilities.windowHandoff !== 1 || !capability.identity) throw new Error('执行端尚不支持安全窗口交接');
    transport.activate(activate());
    return new WindowOwnershipClient(Object.freeze({ ...target }), capability.identity, call, current, transport);
  }
  private async request(payload: object): Promise<any> {
    if (!this.current()) throw new Error('工作台身份已变化');
    const raw = await this.call(this.target.executor, 'workbenchWindow', [this.target.session, JSON.stringify(this.workspace), JSON.stringify(payload)], 12000);
    if (!this.current()) throw new Error('工作台身份已变化');
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || !value.status) throw new Error('窗口操作结果未知');
    if (value.status === 'error') throw new Error(value.reasonCode || '窗口操作失败');
    return value;
  }
  private snapshot(value: any): WindowOwnership {
    if (value.status !== 'ok' || !sameWorkspace(this.workspace, value.workspace) || value.clientId !== this.transport.identity?.clientId
      || !id(value.windowId) || !natural(value.generation) || !natural(value.revision) || typeof value.frozen !== 'boolean'
      || value.frozen !== !!value.pending) throw new Error('窗口归属响应不匹配');
    if (value.pending) this.receipt(value.pending);
    this.transport.observe(this.target.executor, value);
    return value;
  }
  private receipt(value: any, expected?: HandoffReceipt): HandoffReceipt {
    if (!id(value.requestId) || !id(value.sourceWindow) || !id(value.targetWindow) || !natural(value.generation)
      || !/^[a-f0-9]{64}$/.test(value.stateDigest) || !/^[a-f0-9]{64}$/.test(value.fingerprint)
      || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0
      || !['prepared', 'acknowledged', 'committed', 'cancelled'].includes(value.status)
      || expected && ['requestId', 'sourceWindow', 'targetWindow', 'generation', 'stateDigest', 'stateVersion', 'fingerprint']
        .some(field => value[field] !== (expected as any)[field])
      || ['committed', 'cancelled'].includes(value.status) && (!natural(value.committedGeneration) || !natural(value.revision)
        || value.ownerWindow !== (value.status === 'committed' ? value.targetWindow : value.sourceWindow))) throw new Error('窗口交接回执不匹配');
    return value;
  }
  async register(): Promise<WindowOwnership> { return this.snapshot(await this.request({ action: 'register' })); }
  async reclaim(requestId = uuid()): Promise<WindowOwnership> {
    const old = this.transport.get(this.target.executor, this.target.session)?.state;
    if (!old) throw new Error('请先读取窗口归属');
    this.transport.markUnknown(this.target.executor, this.target.session);
    const matches = (row: any) => row?.status === 'reclaimed' && row.requestId === requestId
      && row.windowId === this.transport.identity?.windowId && row.generation === old.generation + 1 && row.revision === old.revision + 1;
    try {
      const row = await this.request({ action: 'reclaim', requestId, expectedWindow: old.windowId,
        generation: old.generation, revision: old.revision });
      if (!matches(row)) throw new Error('恢复归属回执不匹配');
      return (await this.get()).state;
    } catch (error) {
      // 核对原 requestId 的收回回执，既不重新收回，也不把其他窗口的新归属当作本次成功。
      const checked = await this.request({ action: 'get', requestId }).catch(() => null);
      if (checked) {
        const state = this.snapshot(checked);
        if (matches(checked.receipt) && state.windowId === checked.receipt.windowId
          && state.generation === checked.receipt.generation && !state.frozen) return state;
      }
      throw error;
    }
  }
  async get(requestId?: string): Promise<{ state: WindowOwnership; receipt?: HandoffReceipt }> {
    const row = await this.request({ action: 'get', ...(requestId ? { requestId } : {}) });
    const receipt = row.receipt?.status === 'unknown' ? undefined : row.receipt ? this.receipt(row.receipt) : undefined;
    return { state: this.snapshot(row), receipt };
  }
  async prepare(targetWindow: string, stateDigest: string, stateVersion: number, requestId = uuid()): Promise<HandoffReceipt> {
    const current = this.transport.get(this.target.executor, this.target.session), state = current?.state;
    if (!state || current?.unknown || state.windowId !== this.transport.identity?.windowId || state.frozen) throw new Error('当前窗口没有可移动的归属');
    this.transport.markUnknown(this.target.executor, this.target.session);
    try {
      const row = this.receipt(await this.request({ action: 'prepare', generation: state.generation, requestId, targetWindow, stateDigest, stateVersion }));
      if (row.requestId !== requestId || row.targetWindow !== targetWindow || row.sourceWindow !== state.windowId || row.generation !== state.generation
        || row.stateDigest !== stateDigest || row.stateVersion !== stateVersion) throw new Error('准备回执与请求不匹配');
      await this.get(requestId); return row;
    } catch (error) { await this.get(requestId).catch(() => {}); throw error; }
  }
  async ack(plan: HandoffReceipt): Promise<HandoffReceipt> {
    this.receipt(plan);
    if (plan.targetWindow !== this.transport.identity?.windowId) throw new Error('不是此交接的目标窗口');
    return this.receipt(await this.request({ action: 'ack', requestId: plan.requestId, stateDigest: plan.stateDigest, stateVersion: plan.stateVersion }), plan);
  }
  async finish(plan: HandoffReceipt, commit: boolean): Promise<HandoffReceipt> {
    this.transport.markUnknown(this.target.executor, this.target.session);
    try {
      const row = this.receipt(await this.request({ action: commit ? 'commit' : 'cancel', requestId: plan.requestId,
        generation: plan.generation, fingerprint: plan.fingerprint }), plan);
      await this.get(plan.requestId); return row;
    } catch (error) {
      const checked = await this.get(plan.requestId).catch(() => null);
      if (checked?.receipt && ['committed', 'cancelled'].includes(checked.receipt.status)) return this.receipt(checked.receipt, plan);
      throw error;
    }
  }
}
