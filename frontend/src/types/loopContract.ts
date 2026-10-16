export interface ContractDiagnostic {
  version?: number; valid?: boolean; reasonCode?: string; reason?: string; origin?: string;
  repairable?: boolean; scopeUnknown?: boolean; causeRef?: string; causeRevision?: number;
  attemptCount?: number; status?: string; fields?: string[]; affectedIds?: string[];
  evidenceRefs?: string[]; identityDimensions?: string[];
}
export interface RepairEligibility {
  canRequest: boolean; reasonCode: string; message: string; causeRef: string; causeRevision: number;
  round: number; seq: number; controlRevision: number;
}
export type RepairRequest = Pick<RepairEligibility, 'causeRef' | 'causeRevision' | 'round' | 'seq' | 'controlRevision'> & { requestId: string };
export interface RepairReceipt extends Partial<RepairRequest> {
  version?: number; status?: string; reason?: string; attemptCount?: number;
}
export interface RepairResponse { status: string; message?: string; operation?: RepairReceipt; eligibility?: RepairEligibility; }
export const repairActive = (receipt?: RepairReceipt): boolean => !!receipt?.status && ['accepted', 'running', 'unknown'].includes(receipt.status);
export const contractLabel = (detail?: ContractDiagnostic): string => detail?.status === 'repaired' ? '映射已修复，尚未运行'
  : detail?.status === 'retrying' ? `正在纠正任务映射（第 ${detail.attemptCount || 1}/3 次）`
  : detail?.origin === 'identity' ? '执行身份需要核对' : detail?.origin === 'source' ? '任务范围需要核对'
  : detail?.status === 'exhausted' ? '任务计划仍不合格' : '任务映射需要核对';
