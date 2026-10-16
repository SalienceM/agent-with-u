export interface InspectionSource {
  operation?: string;
  path?: string;
  change?: string;
  revision?: string;
  readAt?: number;
  status?: string;
  complete?: boolean;
  offset?: number;
  end?: number;
  total?: number;
  checked?: number;
}

export interface ThoughtsInspection {
  requestId?: string;
  phase?: string;
  message?: string;
  errorCode?: string;
  sequence?: number;
  sampledAt?: number;
  updatedAt?: number;
  sources?: InspectionSource[];
}

const phases: Record<string, string> = {
  preparing: '准备查询', reading: '正在读取项目', answering: '正在回答',
  done: '回答完成', error: '查询失败', cancelled: '已停止旁路', unknown: '结果待确认',
};
const errors: Record<string, string> = {
  missing: '文件或目录不存在', denied: '访问被拒绝', limit: '达到查询上限',
  identity_changed: '查询身份已变化', model_error: '模型故障', timeout: '查询超时',
  unsupported: '当前能力不支持', unavailable: '文件读取失败', changed: '文件变化中',
  invalid_query: '查询协议无效', submission_failed: '提交失败',
  unconfigured: '尚未配置项目目录', ambiguous: '需要明确查询目标', cancelled: '已停止查询',
};
export function inspectionLabel(status: string, inspection?: ThoughtsInspection): string {
  const phase = inspection?.phase || status;
  return `${phases[phase] || '状态未记录'}${inspection?.errorCode ? ` · ${errors[inspection.errorCode] || inspection.errorCode}` : ''}`;
}

export function sourceStatus(source: InspectionSource): string {
  return errors[source.status || ''] || (source.status === 'ok' ? source.complete === false ? '部分覆盖' : '已读取' : source.status || '状态未记录');
}

/** 请求的终态不可被迟到阶段覆盖；列表仍尊重服务端的显式清空。 */
export function mergeAsideTurns<T extends { id: string; status: string; inspection?: ThoughtsInspection }>(previous: T[], incoming: T[]): T[] {
  const old = new Map(previous.map(turn => [turn.id, turn]));
  return incoming.map(turn => {
    const prior = old.get(turn.id);
    if (!prior) return turn;
    const terminal = ['done', 'error', 'cancelled'].includes(prior.status);
    if (terminal && turn.status === 'answering') return prior;
    if (!terminal && !turn.inspection && ['done', 'error', 'cancelled'].includes(turn.status)) return turn;
    if ((prior.inspection?.sequence ?? -1) > (turn.inspection?.sequence ?? -1)) return prior;
    return turn;
  });
}

export function matchesThoughtsScope(session: string, executor: string, data: { sessionId?: string }, source?: string): boolean {
  return !!executor && data.sessionId === session && source === executor;
}
