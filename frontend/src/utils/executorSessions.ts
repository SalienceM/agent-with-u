export interface ExecutorSessionBatch {
  execKey: string;
  execLabel: string;
  execMode: 'local' | 'relay';
  execIsHome: boolean;
  sessions: any[];
}

/**
 * 合并多执行节点的 Session 列表。
 *
 * 同一物理 sidecar 可能同时通过 local 与 Relay 接入；两条连接会返回相同
 * Session ID。ID 相同时只保留一份，并优先保留 local，避免侧栏、收藏重复。
 */
export function mergeExecutorSessionBatches(
  batches: ExecutorSessionBatch[],
): any[] {
  const merged = new Map<string, any>();
  for (const batch of batches) {
    for (const session of batch.sessions || []) {
      if (!session?.id) continue;
      const candidate = {
        ...session,
        execKey: batch.execKey,
        execLabel: batch.execLabel,
        execMode: batch.execMode,
        execIsHome: batch.execIsHome,
      };
      const previous = merged.get(session.id);
      if (!previous || (batch.execMode === 'local' && previous.execMode !== 'local')) {
        merged.set(session.id, candidate);
      }
    }
  }
  return Array.from(merged.values());
}
