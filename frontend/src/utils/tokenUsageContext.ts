export interface ContextMeasurement {
  contextTokens?: number;
  contextWindow?: number;
  contextWindowSource?: string;
  contextApprox?: boolean;
  source?: 'chat' | 'loop' | 'followup' | 'review';
}

export function tokenContext(value?: ContextMeasurement | null) {
  const tokens = value?.contextApprox !== true && typeof value?.contextTokens === 'number' && Number.isFinite(value.contextTokens)
    && value.contextTokens >= 0 ? Math.floor(value.contextTokens) : null;
  const window = typeof value?.contextWindow === 'number' && Number.isFinite(value.contextWindow)
    && value.contextWindow > 0 ? Math.floor(value.contextWindow) : null;
  return {
    tokens, window,
    percent: tokens !== null && window !== null ? Math.round(tokens / window * 100) : null,
    label: value?.source === 'loop' ? '最近 LOOP 请求上下文' : '最近请求上下文',
    windowSource: value?.contextWindowSource === 'configured' ? 'Backend 配置上限' : 'Backend 实报上限',
  };
}
