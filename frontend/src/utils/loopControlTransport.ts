import type { ControlSummary, ControlTarget, ControlView } from './loopControl';

interface Connection {
  ready: Promise<unknown>; isOpen: boolean;
  request(method: string, params: any[], timeout?: number): Promise<any>;
}

/** 一个预算覆盖连接 readiness 与 RPC；预算到期后绝不再发送写请求。 */
export async function requestWithReadiness(connection: Connection, method: string, params: any[], timeoutMs?: number): Promise<any> {
  const deadline = Date.now() + (timeoutMs ?? 15000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([connection.ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('执行端连接超时，请重试')), Math.max(0, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
  if (!connection.isOpen) throw new Error('执行端离线，请恢复连接后重试');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('执行节点响应超时，结果待确认');
  return connection.request(method, params, timeoutMs === undefined ? undefined : remaining);
}

interface TransportIO {
  target(session: string): ControlTarget;
  call(executor: string, method: string, params: any[], timeout: number): Promise<any>;
  current(target: ControlTarget): ControlView;
}

export class LoopControlTransport {
  constructor(private io: TransportIO) {}
  private async call(target: ControlTarget, method: string, params: any[], deadline: number): Promise<any> {
    const current = this.io.target(target.session);
    if (!target.executor || current.executor !== target.executor || current.user !== target.user)
      throw new Error('会话身份或执行节点已变化，请重新检查');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('执行节点响应超时，结果待确认');
    const raw = await this.io.call(target.executor, method, params, remaining);
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { throw new Error('执行节点响应格式异常，结果待确认'); }
  }
  async read(target: ControlTarget, requestId: string, deadline = Date.now() + 12000): Promise<ControlSummary> {
    const result = await this.call(target, 'loopControlGet', [target.session, requestId], deadline);
    if (result?.protocolVersion === 1 && result.sessionId === target.session
      && ['manual', 'loop'].includes(result.controlMode) && Number.isSafeInteger(result.controlRevision)
      && result.eligibility?.takeover && result.eligibility?.release) return result;
    if (result !== null && result !== undefined) throw new Error(result?.message || '控制权响应不完整，结果待确认');
    // 只有成功读取明确旧版 metadata 才允许旧写接口；异常/超时绝不触发回退写。
    const meta = await this.call(target, 'loadSessionMeta', [target.session], deadline);
    if (meta?.id !== target.session || meta.sessionType !== 'loop' || meta.loopControlProtocolVersion !== undefined)
      throw new Error('无法确认执行端的转交协议，请检查连接');
    const state = await this.call(target, 'loopGetState', [target.session, true], deadline);
    if (state?.sessionId !== target.session || !['manual', 'loop'].includes(state.controlMode))
      throw new Error('旧执行端未返回有效控制权状态');
    const allowed = !state.running && (state.controlMode === 'manual' || state.stage === 'loopout' || state.canTakeover === true);
    const condition = { allowed, reasonCode: allowed ? 'ready' : 'legacy_blocked', nextStep: 'check',
      message: allowed ? '旧接口将在提交时核对条件；阶段详情不可用' : '请先等待运行结束或处理未完成断点' };
    const current = this.io.current(target);
    const atTarget = current.action && state.controlMode === (current.action === 'takeover' ? 'manual' : 'loop');
    return { protocolVersion: 0, sessionId: target.session, controlMode: state.controlMode,
      controlRevision: 0, auto: state.auto === true, stage: state.stage, round: state.round,
      eligibility: { takeover: condition, release: condition },
      ...(current.requestId && atTarget ? { operation: { requestId: current.requestId, action: current.action!,
        status: 'succeeded', phase: '', revision: 0, controlRevision: 0, startedAt: current.since / 1000,
        updatedAt: 0, committed: true, checkpointAvailable: null, reasonCode: 'ready', message: '已核对当前控制权（旧接口无详细回执）' } } : {}),
    };
  }
  async request(target: ControlTarget, input: Record<string, unknown>, legacy: boolean): Promise<ControlSummary> {
    const deadline = Date.now() + 12000;
    const result = await this.call(target, legacy ? (input.action === 'takeover' ? 'loopTakeover' : 'loopRelease') : 'loopControlRequest',
      legacy ? [target.session, ...(input.action === 'takeover' ? [input.goal || ''] : [])] : [target.session, JSON.stringify(input)], deadline);
    if (!result || typeof result !== 'object') throw new Error('未收到有效转交回执，结果待确认');
    if (result.status === 'error') return { ...this.io.current(target).summary!, ...result };
    if (legacy) return this.read(target, String(input.requestId), deadline);
    if (result.protocolVersion !== 1 || result.sessionId !== target.session || !result.operation?.requestId)
      throw new Error('转交回执不完整，结果待确认');
    return result;
  }
}
