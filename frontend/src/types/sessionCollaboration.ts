export interface RoleProfile {
  id: string; revision: number; name: string; instructions: string; backendId: string;
  runtime: { model?: string; reasoningEffort?: string }; enabled: boolean; archived: boolean;
}
export interface CollaborationSummary {
  id: string; revision: number; updatedAt: number; name?: string; title?: string; status?: string;
  sessionId?: string; sourceSessionId?: string; roleId?: string; batchId?: string; backendId?: string;
  archived?: boolean; enabled?: boolean; counts?: Record<string, number>;
  kind?: string; progress?: ReviewProgress;
}
export interface ReviewProgress { sequence: number; startedAt: number; updatedAt: number; lastOutputAt?: number | null;
  lastActivityAt?: number; phase: string; message: string; round: number; outputCharacters: number; evidenceCount: number;
  output: string; events: Array<{ at: number; message: string }>; roundOutputs?: Array<{ round: number; output: string }> }
export interface ReviewSelection { roles: Array<{ id: string; revision: number; name: string }>; targetIds: string[]; newContext: boolean;
  receipt?: { request: string; draftRevision: number; fingerprint: string } }
export interface ReviewSnapshot { id: string; fingerprint: string; mode: string; characters: number; targetMessageIds: string[]; messages: Array<{ id: string; role: string; text: string }>; omittedCharacters?: number; limits?: string[] }
export interface ReviewClaim { id: string; sourceMessageId: string; quote?: string; quoteMatch?: string; stance: 'agree' | 'partial' | 'disagree' | 'unknown'; reason: string; suggestion?: string; evidenceRefs: string[] }
export interface OpinionReference { reportId: string; reportRevision: number; roleId: string; roleName: string; sourceSessionId: string; snapshotId: string; summary: string; claims: ReviewClaim[]; fingerprint: string }
export interface ReviewReport extends CollaborationSummary { roleName: string; roleVersion: number; raw?: string; summary?: string; claims?: ReviewClaim[]; confidence?: number | null; limits?: string[]; mode: string; notice?: string; outputPath?: string; evidence?: unknown[] }
export interface ReviewBatch extends CollaborationSummary { reports: string[]; reportSummaries: ReviewReport[]; snapshotId: string; question: string; notice?: string; targets?: Array<{ id: string; text: string }> }
