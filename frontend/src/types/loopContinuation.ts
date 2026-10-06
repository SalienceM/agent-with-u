export interface LoopDecision {
  version?: number; decisionId?: string; action?: string; reasonCode?: string; reasonText?: string;
  nextStep?: string; resumeCondition?: string; affectedIds?: string[]; basisRefs?: string[];
  completionScope?: 'automatic' | 'full' | ''; revision?: number; round?: number; seq?: number;
}
export interface LoopSourceSummary {
  status?: string; revision?: number; scopeRevision?: number; change?: string; executor?: string;
  backendId?: string; workspace?: string; checkedAt?: number; total?: number; checked?: number;
  reason?: string; code?: string;
  diff?: { added?: string[]; removed?: string[]; changed?: string[]; artifactsChanged?: boolean };
}
export interface LoopSourceResponse {
  status: string; message?: string; code?: string; sessionId?: string; revision?: number;
  source?: LoopSourceSummary; discoveryId?: string;
  candidates?: Array<{ name: string }>;
  binding?: { executor: string; workspace: string; backendId: string; cliVersion?: string };
}
export interface MilestoneSummary {
  counts?: Record<string, number>; credited?: string[]; restored?: string[]; invalid?: string[]; basis?: string;
}
