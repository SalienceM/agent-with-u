export type KitRunStatus =
  | 'queued' | 'running' | 'waiting_client' | 'evaluating'
  | 'succeeded' | 'failed' | 'error' | 'cancelled';

export type KitExecutionTarget = 'executor' | 'client';
export type KitStepType = 'command' | 'file_push' | 'kit_call';

export interface KitStepSpec {
  id: string;
  type: KitStepType;
  target: KitExecutionTarget;
  title: string;
  shell?: 'powershell' | 'cmd' | 'bash';
  command?: string;
  cwd?: string;
  timeoutSeconds?: number;
  assertions?: KitAssertionSpec[];
  config?: {
    source?: string;
    destination?: string;
    overwrite?: boolean;
    sha256?: string;
    [key: string]: unknown;
  };
  kitId?: string;
  inputs?: Record<string, unknown>;
}

export interface KitInputSpec {
  key: string;
  label?: string;
  type?: 'text' | 'number' | 'boolean' | 'select' | 'file';
  required?: boolean;
  default?: unknown;
  options?: string[];
  sourceKey?: string;
  placeholder?: string;
}

export interface KitAssertionSpec {
  type: 'exit_code' | 'stdout_contains' | 'stderr_contains'
    | 'stdout_regex' | 'stderr_regex' | 'json_valid' | 'file_exists';
  label?: string;
  expected?: unknown;
  path?: string;
}

export interface KitOutputSpec {
  key: string;
  label?: string;
  type?: 'text' | 'json' | 'file';
  source?: 'stdout' | 'stderr' | 'json' | 'file';
  path?: string;
  mediaType?: string;
  /** 成功运行后只登记到发布中心候选区；绝不会自动执行正式发布。 */
  releaseCandidate?: boolean;
  platform?: string;
  arch?: string;
  target?: string;
  kind?: string;
  install?: Record<string, unknown>;
}

export interface KitVersion {
  id: string;
  version: string;
  source: 'create' | 'legacy' | 'manual' | 'ai_compile' | 'ai_optimize' | string;
  note: string;
  createdAt: number;
  isActive?: boolean;
  snapshot?: Record<string, unknown>;
}

export interface KitOptimizationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  backendId: string;
  status: 'answering' | 'done' | 'error';
  proposal?: Record<string, unknown> | null;
  warnings: string[];
  blockingIssues?: string[];
  questions: string[];
  ready: boolean;
  readinessVersion?: number;
  baseVersionId: string;
  finalizedVersionId: string;
  createdAt: number;
}

export interface WorkspaceKit {
  id: string;
  title: string;
  description: string;
  objective: string;
  successCriteria: string;
  safetyConstraints: string;
  references: string[];
  implementationSummary: string;
  generationWarnings: string[];
  generatedByAi: boolean;
  executionTarget: KitExecutionTarget;
  steps: KitStepSpec[];
  command: string;
  shell: 'powershell' | 'cmd' | 'bash';
  cwd: string;
  timeoutSeconds: number;
  inputs: KitInputSpec[];
  assertions: KitAssertionSpec[];
  outputs: KitOutputSpec[];
  dependencies: string[];
  schedule: {
    mode: 'manual' | 'interval';
    intervalSeconds: number;
    nextRunAt?: number | null;
  };
  view: {
    default: string;
    showLogs: boolean;
    showData: boolean;
    showTerminal: boolean;
  };
  enabled: boolean;
  controlMode: 'ai' | 'human' | 'shared';
  lastRunId: string;
  versions?: KitVersion[];
  activeVersionId?: string;
  optimizationMessages?: KitOptimizationMessage[];
  optimizationMessageCount?: number;
  optimizationBackendId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KitGenerationRequest {
  objective: string;
  successCriteria?: string;
  safetyConstraints?: string;
  references?: string[];
  clientSources?: string[];
  existingKit?: Partial<WorkspaceKit>;
  backendId?: string;
}

export interface KitGenerationResult {
  status: 'ok' | 'needs_input' | 'error';
  ready?: boolean;
  kit?: WorkspaceKit;
  implementationSummary?: string;
  safetySummary?: string;
  verificationSummary?: string;
  warnings?: string[];
  questions?: string[];
  message?: string;
}

export type KitGenerationJobStatus =
  | 'queued' | 'running' | 'succeeded' | 'needs_input' | 'error' | 'cancelled';

export interface KitGenerationJob {
  id: string;
  sessionId: string;
  status: KitGenerationJobStatus;
  request: KitGenerationRequest;
  result?: KitGenerationResult | null;
  message: string;
  error: string;
  createdAt: number;
  startedAt?: number | null;
  endedAt?: number | null;
  updatedAt: number;
}

export interface KitAssertionResult {
  type: string;
  label: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

export interface KitRun {
  id: string;
  kitId: string;
  sessionId: string;
  trigger: string;
  owner: string;
  status: KitRunStatus;
  verdict: string;
  inputs: Record<string, unknown>;
  command: string;
  cwd: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  assertions: KitAssertionResult[];
  steps: KitStepRun[];
  currentStep: number;
  artifactIds: string[];
  error: string;
  startedAt?: number | null;
  endedAt?: number | null;
  createdAt: number;
}

export interface KitStepRun {
  id: string;
  type: KitStepType;
  target: KitExecutionTarget;
  title: string;
  sourceKitId: string;
  status: 'pending' | 'running' | 'waiting_client' | 'succeeded' | 'failed'
    | 'error' | 'cancelled' | 'skipped';
  shell: 'powershell' | 'cmd' | 'bash';
  command: string;
  cwd: string;
  timeoutSeconds: number;
  config: Record<string, any>;
  inputs: Record<string, unknown>;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  assertions: KitAssertionResult[];
  error: string;
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface KitArtifact {
  id: string;
  sessionId: string;
  kitId: string;
  runId: string;
  key: string;
  label: string;
  type: string;
  value: unknown;
  path: string;
  mediaType: string;
  createdAt: number;
}

export interface WorkspaceKitState {
  sessionId: string;
  kits: WorkspaceKit[];
  runs: KitRun[];
  artifacts: KitArtifact[];
  dataMarket: KitArtifact[];
  terminalConnectedKitIds?: string[];
  createdAt?: number;
  updatedAt?: number;
}
