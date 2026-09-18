export interface CallDiagnostic {
  id: string; stage: string; status: string; phase: string;
  startedAt: number; dispatchedAt?: number; endedAt?: number; observedAt?: number;
  firstEventAt?: number; firstTextAt?: number; lastActivityAt?: number;
  localPrepareMs?: number; durationMs?: number;
  backendId?: string; backendType?: string; model?: string; reasoningEffort?: string;
  promptChars: number; estimatedPromptTokens: number; imageCount: number; resumedContext?: boolean;
  requestBytes?: number; inactivityTimeoutSeconds?: number;
  activeLoopCallsAtDispatch?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number };
  textChars: number; thinkingChars: number; eventCounts: Record<string, number>;
  transportAttempts: number; retryCount: number; retryWaitSeconds: number;
  httpStatus?: number; attempt?: number; maxAttempts?: number; delaySeconds?: number;
  lastError?: { category: string; httpStatus?: number };
  timeline?: Array<{ phase: string; at: number; elapsedMs: number; httpStatus?: number; attempt?: number; delaySeconds?: number; category?: string }>;
}

export const CALL_PHASE: Record<string, string> = {
  local_prepare: '本地准备：同步 Skill／展开引用', backend_dispatch: '已进入 Backend，等待可见事件',
  running: '进行中',
  runner_start: '启动 Agent 进程／连接', runner_ready: 'Agent 就绪，初始化线程',
  turn_accepted: 'Agent 已接受任务，等待模型事件', request: '已发起 HTTP 请求，等待响应头',
  response_headers: '已收到 HTTP 响应头', retry_wait: '后端自动重试等待',
  thinking: '收到思考事件，尚不等于计划完成', text: '收到正文', tools: '工具／子任务活动',
  done: '调用结束（不代表计划校验通过）', error: '调用报错', stalled: '无事件超时', cancelled: '调用已中断',
  backend_error: 'Agent／SDK 报错',
  sdk_request: '已交给 API SDK，内部排队／重试不可见', sdk_response: 'API SDK 已建立响应流',
};
export const CALL_ERROR: Record<string, string> = {
  concurrency: '后端明确报告并发限制', rate_limit: '限流（不一定是并发，也可能是 RPM／TPM）',
  timeout: '超时', network: '网络／连接错误', auth: '认证／权限错误',
  context_limit: '上下文长度限制', unknown: '未分类错误；不能据此推断并发不足',
};

export function mergeCallDiagnostics(...groups: Array<CallDiagnostic[] | undefined>): CallDiagnostic[] {
  const calls = new Map<string, CallDiagnostic>();
  for (const group of groups) for (const call of group || []) {
    const previous = calls.get(call.id);
    if (!previous || (call.endedAt || call.observedAt || call.startedAt) >= (previous.endedAt || previous.observedAt || previous.startedAt)) {
      calls.set(call.id, call);
    }
  }
  return [...calls.values()].slice(-64);
}

// 只有本轮最后一条未终止记录才可能在跑。旧轮次残留 running 不能抢占动画。
export function activeLoopSeq(state: { running: boolean; round: number; loops: Array<{
  seq: number; round: number; completed: boolean; error: string; kind?: string;
}> }): number | null {
  const last = state.loops[state.loops.length - 1];
  return state.running && last && last.round === state.round && last.kind !== 'manual'
    && !last.completed && !last.error ? last.seq : null;
}
