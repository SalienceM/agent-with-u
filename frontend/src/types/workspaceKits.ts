export type KitRunStatus =
  | 'queued' | 'running' | 'evaluating'
  | 'succeeded' | 'failed' | 'error' | 'cancelled';

export interface KitInputSpec {
  key: string;
  label?: string;
  type?: 'text' | 'number' | 'boolean' | 'select';
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
}

export interface WorkspaceKit {
  id: string;
  title: string;
  description: string;
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
  createdAt: number;
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
  artifactIds: string[];
  error: string;
  startedAt?: number | null;
  endedAt?: number | null;
  createdAt: number;
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
