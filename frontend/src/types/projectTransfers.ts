export interface ProjectTransferCapability {
  version: number; executorId: string; git: boolean;
  origin?: { executorId: string; sessionId: string; transferId: string } | null;
}

export interface ProjectTransferDescriptor {
  version: number; id: string; mode: 'project' | 'return'; sourceExecutor: string;
  sourceSessionId: string; sourceTitle: string; targetExecutor: string;
  origin: ProjectTransferCapability['origin']; size: number; bytes: number; files: number; sha256: string;
}

export interface ProjectTransferRecord {
  id: string; direction: 'export' | 'receive'; status: string; title: string;
  descriptor: ProjectTransferDescriptor; sessionId: string; parentSessionId?: string;
  backendId: string; planFingerprint: string; root: string; offset: number; requestId?: string; notice?: string;
  actual?: { verifiedFiles: number; verifiedBytes: number; head: string };
  receipt?: { status: string; result?: { sessionId?: string; verifiedFiles?: number } };
}
