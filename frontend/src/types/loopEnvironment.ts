export interface WorkflowReference {
  command: string;
  skillId: string;
  profileId: string;
  digest: string;
  source?: string;
  scope?: string;
  revision?: number;
}

export interface EnvironmentCheck {
  revision?: number;
  id?: string;
  identity?: string;
  status: 'unknown' | 'checking' | 'passed' | 'blocked' | 'unsupported' | 'stale';
  coverage?: 'host_discovery' | 'native_policy' | 'actual_tool';
  checkedAt?: number;
  backendId?: string;
  role?: string;
  access?: string;
  transport?: string;
  runnerVersion?: string;
  reasonCode?: string;
  reason?: string;
  resumeCondition?: string;
  dependencyId?: string;
  quiesced?: boolean;
  incomplete?: boolean;
  entry?: string;
}

export interface ExecutionEnvironment {
  checking?: boolean;
  revision: number;
  status: EnvironmentCheck['status'];
  workflowRef?: Partial<WorkflowReference>;
  latest?: Partial<EnvironmentCheck>;
  blockers?: EnvironmentCheck[];
  incomplete?: boolean;
}

export interface EnvironmentResponse {
  status: string;
  sessionId?: string;
  message?: string;
  environment?: ExecutionEnvironment;
  choices?: WorkflowReference[];
}
