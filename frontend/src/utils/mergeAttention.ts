import type { MergeLink } from '../types/taskWorkspaces';

interface LinkedSession { id: string; execKey?: string; mergeLink?: MergeLink }
const labels: Record<string, string> = {
  preparing: '准备中', applying: '应用中', unknown: '结果待核对',
  preview: '待确认', candidate: '待审阅', conflict: '待解冲突', blocked: '合并受阻',
};

/** 侧栏提示当前操作，历史状态不等于当前待办；运行中和未知结果始终保留。 */
export function mergeAttention(rows: LinkedSession[], session: string, executor: string, streaming: Set<string>) {
  const related = rows.filter(row => row.mergeLink && (row.execKey || 'local') === executor
    && [row.mergeLink.sourceSessionId, row.mergeLink.targetSessionId].includes(session));
  const current = related.filter(row => {
    const link = row.mergeLink!;
    if (streaming.has(row.id) || ['preparing', 'applying', 'unknown'].includes(link.status)) return true;
    if (!link.createdAt) return true; // 旧端无时间时不猜测记录先后。
    const pair = [link.sourceSessionId, link.targetSessionId].sort().join(':');
    return !related.some(other => other.mergeLink!.originSessionId === link.originSessionId
      && [other.mergeLink!.sourceSessionId, other.mergeLink!.targetSessionId].sort().join(':') === pair
      && (other.mergeLink!.createdAt || 0) > link.createdAt!);
  }).filter(row => streaming.has(row.id) || labels[row.mergeLink!.status]);
  const rank = (row: LinkedSession) => streaming.has(row.id) ? 0 : ['preparing', 'applying', 'unknown'].includes(row.mergeLink!.status) ? 1 : 2;
  current.sort((a, b) => rank(a) - rank(b) || (b.mergeLink!.createdAt || 0) - (a.mergeLink!.createdAt || 0));
  const first = current[0];
  return first ? { link: first.mergeLink!, label: streaming.has(first.id) ? '处理中' : labels[first.mergeLink!.status], count: current.length } : undefined;
}
