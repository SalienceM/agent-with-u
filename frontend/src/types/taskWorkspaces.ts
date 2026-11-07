export interface TaskRepository {
  root: string; commonDir: string; repositoryId: string; head: string; branch: string; fingerprint: string;
  dirty: Array<{ path: string; status: string; sha256: string; bytes: number; blocked: string }>;
}
export interface TaskWorkspace {
  id: string; revision: number; sessionId: string; sourceSessionId: string; parentSessionId: string; title: string;
  root: string; branch: string; status: string; notice?: string; planFingerprint: string; repository: TaskRepository;
  config: { title: string; goal: string; backendId: string; runtime: { model?: string; reasoningEffort?: string };
    constraints: string; skills: string[]; skipPermissions: boolean; includePaths: string[] };
  actual?: TaskRepository & { baseline: string }; receipt?: { status: string; result?: { notice?: string } };
  startRequestId?: string; startReceipt?: { status: string; result?: { notice?: string } };
  cleanupPlan?: { fingerprint: string; notice: string; workspace: TaskRepository; parent: TaskRepository };
}
export interface ProjectMerge {
  id: string; revision: number; sourceSessionId: string; title: string; status: string; notice?: string; planFingerprint: string;
  source: TaskRepository & { sessionId: string; title: string }; target: TaskRepository & { sessionId: string; title: string };
  files: string[]; blockers: string[]; policy: string; candidate?: string; finalHead?: string; startRequestId?: string;
  integrationConfig: { backendId: string; model?: string; reasoningEffort?: string; skipPermissions: boolean };
  integration?: { sessionId: string; root: string; conflicts: string[]; actual?: TaskRepository };
  verification: { status: string; head?: string; notice: string };
}
