import type { LoopPolicy } from '../components/LoopPolicyEditor';
import type { DeliveryReport, ProgressGuard } from '../components/LoopDeliveryStatus';
import type { TaskBlockerDetails } from '../utils/loopTaskBlockers';
import type { EnvironmentCheck, ExecutionEnvironment } from './loopEnvironment';
import type { LoopDecision, LoopSourceSummary } from './loopContinuation';
import type { ModelRuntime } from '../components/CodexRuntimeFields';
import type { CallDiagnostic } from '../utils/loopDiagnostics';
import type { WorkbenchRecord } from '../utils/loopWorkbenchView';

export interface LoopStep {
  callResult?: string; taskResult?: string;
  index: number; mode: string; access?: 'read' | 'write'; desc: string; status: string; output: string;
  startedAt?: number; endedAt?: number; attempts?: number; recoveryNotes?: string[];
}
export interface LoopAnalysis {
  score: number; scoreObserved?: boolean; notes: string; trend: string;
  optimizationPotential: number; challenges: string;
  verified: string; gaps: string; nextFocus: string;
  deliverable: boolean; outputtable: boolean;
}
export interface LoopRecord extends TaskBlockerDetails {
  environmentChecks?: EnvironmentCheck[];
  outcomeVersion?: number; terminalKind?: string; decision?: LoopDecision; callResults?: Record<string, string>; taskResult?: string;
  sourceSummary?: unknown; deliverySummary?: WorkbenchRecord['deliverySummary'];
  resultPreview?: string; analysisPreview?: WorkbenchRecord['analysisPreview'];
  seq: number; subStage: string; round: number; goal: string; orchestration: LoopStep[];
  kind?: 'agent' | 'manual';
  iterationMode?: 'baseline' | 'evolution';
  evolutionBasis?: string;
  delivery?: DeliveryReport;
  hasEvolutionBasis?: boolean;
  completed: boolean; result: string; analysis: LoopAnalysis | null; error: string;
  subStarted?: Record<string, number>; createdAt?: number; updatedAt?: number;
  hasGitCheckpoint?: boolean;
  backends?: Record<string, string>;          // {prepare, execute, analysis} → backend id
  runtimes?: Record<string, ModelRuntime>;    // {prepare, execute, analysis} → 实际模型/档位
  backendLabels?: Record<string, string>;     // {prepare, execute, analysis} → 可读 label
  manualMessages?: Array<{
    id: string; role: string; content: string; timestamp?: number; streaming?: boolean;
    toolCalls?: Array<{ name: string; status?: string; input?: string; output?: string; error?: string }>;
    thinkingBlocks?: Array<{ content: string }>;
  }>;
  manualContext?: string;
  detailLoaded?: boolean;
  manualMessageCount?: number;
  stageDetails?: Record<string, StageDetail>;
  callDiagnostics?: CallDiagnostic[];
  diagnosticLive?: boolean;
}
export interface StageAttempt { kind: string; rawOutput?: string; parsed?: unknown; valid: boolean; validation: string[]; }
export interface StageDetail {
  status?: string; message?: string; attemptCount?: number; attempts?: StageAttempt[];
  rawOutput?: string; partialOutput?: string; parsed?: unknown; validation?: string[];
}
export type DetailTarget = 'all' | 'prepare' | 'execute' | 'analysis' | `step${number}`;
export interface IdeaEntry { id: string; prompt: string; status: string; result: string; error: string; images?: AddonImage[]; }
export interface GoalRevision { goal: string; hint: string; source: string; createdAt: number; }
export interface AsideTurn { id: string; question: string; answer: string; status: string; stage: string; seq: number; imageCount?: number; }
export interface AddonImage { id?: string; base64: string; mime_type?: string; }
export interface Addon { id: string; text: string; status: string; appliedSeq: number; images?: AddonImage[]; }
export interface LoopStateT {
  executionEnvironment?: ExecutionEnvironment;
  unresolvedBlockers?: { available?: boolean; count?: number };
  taskSource?: LoopSourceSummary;
  sessionId: string; stage: string; goal: string;
  goalHistory: GoalRevision[];
  policy?: LoopPolicy;
  ideas: IdeaEntry[]; loops: LoopRecord[];
  riskCoefficient: number; maxLoops: number; effectiveMaxLoops: number;
  round: number; roundLoopCount: number;
  status: string; stopReason: string; bestScore: number; latestScore: number;
  bestSeq?: number;
  riskFactors?: Record<string, number>;
  progressGuard?: ProgressGuard;
  handoff?: { available?: boolean; source?: string };
  asides: AsideTurn[];
  addons: Addon[];
  intentAlert?: { round?: number; seq?: number; aligned?: boolean; severity?: string; divergence?: string; suggestion?: string; dismissed?: boolean };
  auto: boolean; running: boolean; resumable: boolean;
  controlMode?: 'loop' | 'manual';
  controlRevision?: number;
  canTakeover?: boolean;
  controlReason?: string;
}
