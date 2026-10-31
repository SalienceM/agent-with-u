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
  limitReason?: string;
  entryCount?: number;
  nextOffset?: number;
  visited?: number;
  matchCount?: number;
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
const limits: Record<string, string> = {
  file_bytes: '单文件超过 256 KiB', total_bytes: '累计读取额度已用尽',
  search_bytes: '搜索读取额度已用尽，可定向读取文件', context_chars: '项目证据上下文已满',
  operations: '查询操作次数已用尽', rounds: '查询轮数已用尽',
  answer_reserve: '已进入回答预留时间', directory_page: '目录分页范围受限',
  search_scope: '搜索数量范围受限', unreadable_files: '部分搜索目标不可读或不支持',
};
export function inspectionLabel(status: string, inspection?: ThoughtsInspection): string {
  const phase = inspection?.phase || status;
  return `${phases[phase] || '状态未记录'}${inspection?.errorCode ? ` · ${errors[inspection.errorCode] || inspection.errorCode}` : ''}`;
}

export function sourceStatus(source: InspectionSource): string {
  const reason = source.limitReason && Object.prototype.hasOwnProperty.call(limits, source.limitReason)
    ? limits[source.limitReason] : '';
  if (reason && (source.status === 'limit' || source.status === 'ok')) {
    return `${source.status === 'ok' ? '部分覆盖' : '读取受限'} · ${reason}`;
  }
  return errors[source.status || ''] || (source.status === 'ok' ? source.complete === false ? '部分覆盖' : '已读取' : source.status || '状态未记录');
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function sourceRange(source: InspectionSource): string {
  if (source.operation === 'list_directory') {
    const page = count(source.entryCount) ? `目录项：本页 ${source.entryCount} 项` : '目录分页';
    const offset = count(source.offset) ? `（偏移 ${source.offset}）` : '';
    const next = count(source.nextOffset) ? `；下一页偏移 ${source.nextOffset}` : '';
    return page + offset + next;
  }
  if (source.operation === 'search_text') {
    const coverage = [count(source.visited) ? `检查 ${source.visited} 个文件目标` : '',
      count(source.matchCount) ? `命中 ${source.matchCount} 处` : ''].filter(Boolean);
    return coverage.length ? `搜索覆盖：${coverage.join('，')}` : '';
  }
  if (source.operation === 'read_text' && count(source.offset) && count(source.end) && source.end >= source.offset) {
    return `字符范围：${source.offset}–${source.end}${source.complete === false ? '（非全文）' : ''}`;
  }
  return '';
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
