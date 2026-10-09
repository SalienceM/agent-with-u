export interface BlockerReview {
  status?: string; valid?: boolean; readyIds?: string[]; affectedIds?: string[];
  reason?: string; evidenceLevel?: string; evidenceRefs?: string[];
}
export interface TaskBlocker {
  id: string; affectedTaskIds: string[]; reasonCode: string; reason: string;
  resolution: string; evidenceRefs: string[]; evidenceLevel?: string;
}
export interface TaskBlockerDetails {
  blockerSummary?: BlockerReview;
  blockerReview?: BlockerReview;
  taskBlockers?: { valid?: boolean; reason?: string; items?: TaskBlocker[] };
  taskPlan?: { valid?: boolean; sourceKind?: string; tasks?: Array<{ id: string; dependsOn: string[] }>;
    preconditions?: Array<{ id: string; affectedTaskIds: string[]; isolatedRoot: string; verificationMethod: string; baselineBasis?: string }> };
  isolationEvidence?: { valid?: boolean; items?: Record<string, { evidenceLevel?: string; configRevision?: string; actualRoot?: string }> };
}

export function blockerLabel(review?: BlockerReview): string {
  if (!review?.status) return '';
  if (review.status === 'pending') return '部分任务受阻 · 待只读复核';
  if (review.status === 'running') return '部分任务受阻 · 正在只读复核';
  if (review.status === 'done' && review.valid && review.affectedIds?.length === 0) return '阻塞已解除 · 验收仍待核实';
  if (review.status === 'done' && review.valid) return review.readyIds?.length
    ? '部分任务受阻 · 有独立就绪工作' : '任务受阻 · 无独立就绪工作';
  return '阻塞范围未确认 · 未放行后续工作';
}

// 空 compact 不能覆盖正文；摘要状态始终来自最新推送。Session 隔离由详情请求代次负责。
export function mergeBlockerDetails(summary: TaskBlockerDetails, detail: TaskBlockerDetails): TaskBlockerDetails {
  const has = (value: object | undefined) => value && Object.keys(value).length > 0;
  return {
    blockerSummary: summary.blockerSummary ?? detail.blockerSummary,
    blockerReview: has(summary.blockerReview) ? summary.blockerReview : detail.blockerReview,
    taskBlockers: has(summary.taskBlockers) ? summary.taskBlockers : detail.taskBlockers,
    taskPlan: has(summary.taskPlan) ? summary.taskPlan : detail.taskPlan,
    isolationEvidence: has(summary.isolationEvidence) ? summary.isolationEvidence : detail.isolationEvidence,
  };
}
