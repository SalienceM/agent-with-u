export type SessionViewMode = 'chat' | 'engine';

export interface SessionViewMetadata {
  /** Missing on old executors; this is presentation, not Session/LOOP type. */
  viewMode?: SessionViewMode;
}

export interface SessionWorkbenchPatch {
  viewMode?: SessionViewMode;
}

export function isSessionViewMode(value: unknown): value is SessionViewMode {
  return value === 'chat' || value === 'engine';
}

export function normalizeSessionViewMode(value: unknown): SessionViewMode {
  return value === 'engine' ? 'engine' : 'chat';
}

export interface WorkspaceIdentity {
  ownerId: string;
  executorInstance: string;
  sessionId: string;
  workingDir: string;
  workspaceRevision: string;
}

export interface WorkbenchTarget {
  user: string;
  executor: string;
  session: string;
  workingDir: string;
}

export interface DocumentIdentity {
  workspace: WorkspaceIdentity;
  relativePath: string;
  canonicalPath?: string;
  source: 'executor' | 'local-copy';
}

/** 磁盘字节版本独立于编辑缓冲区修订；不存在只用于显式新建基线。 */
export type DiskVersion = { exists: false } | {
  exists: true; sha256: string; byteLength: number; fileId: string; modifiedNs: string; changedNs: string;
};

export interface DocumentVersion {
  sha256: string;
  byteLength: number;
  bufferRevision: number;
}

export interface ResourceIdentity {
  workspace: WorkspaceIdentity;
  resourceId: string;
  generation: string;
}

export interface WorkbenchCapabilities {
  status: 'ok' | 'unsupported';
  identity?: WorkspaceIdentity;
  capabilities: { viewMode: number; windowHandoff: number; documents: number; languageServices: number; terminal: number };
}

const capabilityNames = ['viewMode', 'windowHandoff', 'documents', 'languageServices', 'terminal'] as const;
export type WorkbenchCall = (executor: string, method: string, params: unknown[], timeout: number) => Promise<unknown>;

export async function readWorkbenchCapabilities(
  target: WorkbenchTarget, call: WorkbenchCall, isCurrent: () => boolean,
): Promise<WorkbenchCapabilities> {
  if (![target.user, target.executor, target.session, target.workingDir].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('工作台目标身份不完整');
  }
  if (!isCurrent()) throw new Error('工作台身份已变化');
  const raw = await call(target.executor, 'sessionWorkbenchCapabilities', [target.session, target.workingDir], 12000);
  if (!isCurrent()) throw new Error('工作台身份已变化');
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (result == null) {
    return { status: 'unsupported', capabilities: { viewMode: 0, windowHandoff: 0, documents: 0, languageServices: 0, terminal: 0 } };
  }
  if (typeof result !== 'object') throw new Error('无效的工作台能力响应');
  const row = result as Record<string, any>;
  if (row.status !== 'ok' || row.protocolVersion !== 1) throw new Error('无法确认执行端工作台能力');
  const identity = row.identity as WorkspaceIdentity | undefined;
  if (!identity || identity.ownerId !== target.user || identity.sessionId !== target.session
      || typeof identity.executorInstance !== 'string' || !identity.executorInstance
      || typeof identity.workingDir !== 'string' || !identity.workingDir
      || typeof identity.workspaceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(identity.workspaceRevision)) {
    throw new Error('执行端工作台身份不匹配');
  }
  const versions = row.capabilities;
  if (!versions || !capabilityNames.every(name => Number.isSafeInteger(versions[name]) && versions[name] >= 0)) {
    throw new Error('无效的工作台能力版本');
  }
  // 未知的未来版本不能当作当前版本支持，读到的协议不等于任何运行授权。
  const capabilities = Object.fromEntries(capabilityNames.map(name => [name, versions[name] === 1 ? 1 : 0])) as WorkbenchCapabilities['capabilities'];
  return { status: 'ok', identity, capabilities };
}
