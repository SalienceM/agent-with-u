export interface AimeinReview {
  id: string; model: string; backendId: string; status: string;
  maturity?: number; summary?: string; error?: string;
  attemptCount?: number;
  profileName?: string; profileRevision?: string; profile?: AimeinDocument & { id: string; calibrations?: AimeinCalibration[] };
  attempts?: Array<{ number: number; status: string; error?: string; rawOutput?: string }>;
  criteria?: Array<{ id: string; status: string; reason: string; evidence: string[] }>;
  targets?: Array<{ id: string; status: string; reason: string; evidence: string[]; fingerprints?: Record<string, string> }>;
}
export interface AimeinSummary {
  reviewerCount?: number;
  revision: string; sprintId: string; sprintNumber: number; attempt: number; status: string;
  accepted: boolean; complete: boolean; message?: string; scopeChanged?: boolean; noProgress?: number;
  title: string; outcome: string; maturityTarget?: number; maturityMeaning: string;
  flowBuild: string; infra: string; targetCount: number; nextFocus?: string;
  criteria: Array<{ id: string; lane: string; acceptance: string }>;
  reviews: AimeinReview[]; issues: Array<{ id: string; model: string; reason: string }>;
  artifact?: { digest?: string; files?: number; coverage?: string };
}
export interface AimeinRun {
  reviewerCount?: number;
  goal?: string;
  reviews?: AimeinReview[];
  // 首次规划会发布 plan: {}；详情也可能尚未加载，不能假定目标与 Sprint 已生成。
  plan?: { targets?: Array<{ id: string; title: string; acceptance: string; dependsOn: string[] }>;
    sprint?: { deferred?: string[]; criteria?: Array<{ id: string; targetId: string; lane: string }> } };
}

/** 无字段的历史记录固定为三位；非法元数据不能变成单人通过。 */
export function expectedReviewers(value?: { reviewerCount?: number }): number {
  const count = value?.reviewerCount;
  return count === undefined ? 3 : Number.isInteger(count) && count >= 1 && count <= 3 ? count : 0;
}

export interface AimeinDocument {
  name: string; backendId: string; model: string; reasoningEffort: string;
  domain: string; flavor: string; focus: string; revision?: string;
}
export interface AimeinProfile { id: string; document: AimeinDocument; history: AimeinDocument[]; imported?: boolean; }
export interface AimeinCalibration {
  profileId: string; revision: string; model: string; seq: number; reviewId: string;
  kind: 'preference' | 'confirmed' | 'false_positive' | 'missed' | 'unsuitable'; note: string; createdAt: number;
}
export interface AimeinMemory { revision: number; profiles: AimeinProfile[]; calibrations: AimeinCalibration[]; }
export interface AimeinRecommendation { profileId: string; name: string; model: string; available: boolean; reasons: string[]; samples: number; caution: boolean; recommended: boolean; }
export interface AimeinLibraryResult { status: string; message?: string; memory?: AimeinMemory; recommendations?: AimeinRecommendation[]; }
export interface AimeinAnchor { kind: 'goal' | 'flow' | 'infra' | 'artifact' | 'review'; seq: number; reviewId?: string; }
export interface AimeinFeedback extends AimeinAnchor {
  status: string; reason?: string; criteriaIds?: string[]; resultSeq?: number;
  history?: Array<{ status: string; reason: string; criteriaIds: string[]; resultSeq: number }>;
}
