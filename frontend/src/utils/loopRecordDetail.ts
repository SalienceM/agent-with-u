interface DetailRevisionSource {
  seq: number; subStage: string; completed: boolean; error: string; updatedAt?: number;
  manualMessageCount?: number; manualMessages?: unknown[];
  stageDetails?: Record<string, { status?: string; attemptCount?: number; message?: string }>;
  orchestration: Array<{ index: number; desc: string; status: string; attempts?: number; endedAt?: number }>;
  callDiagnostics?: Array<{ id: string; status: string; endedAt?: number }>;
}

// 正文不参与版本计算：摘要刻意移除了它。步骤结束时间也参与，不能只依赖
// record.updatedAt（旧服务端在步骤完成时未必会更新它）。流式 delta 不触发重读。
export function loopRecordRevision(record: DetailRevisionSource): string {
  return JSON.stringify([
    record.seq, record.subStage, record.completed, record.error, record.updatedAt,
    record.manualMessageCount ?? record.manualMessages?.length ?? 0,
    Object.entries(record.stageDetails || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([stage, detail]) => [stage, detail.status, detail.attemptCount, detail.message]),
    record.orchestration.map(step => [step.index, step.desc, step.status, step.attempts, step.endedAt]),
    record.callDiagnostics?.slice(-1).map(call => [call.id, call.status, call.endedAt]),
  ]);
}
