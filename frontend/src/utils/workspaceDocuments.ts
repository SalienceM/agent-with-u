import { readWorkbenchCapabilities, type DiskVersion, type DocumentIdentity, type WorkbenchCall,
  type WorkbenchCapabilities, type WorkbenchTarget, type WorkspaceIdentity } from './sessionWorkbench';

export class DocumentProtocolError extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}

export interface DocumentRead {
  status: 'ok'; document: DocumentIdentity; text: string;
  encoding: string; bom: string; eol: string; complete: boolean; editable: boolean;
  canSave: boolean; reasonCode: string; writeReasonCode: string;
  byteLength: number; readByteLength: number; version: DiskVersion | null; controlRevision: number;
}

export interface DocumentSaveRequest {
  requestId: string; relativePath: string; baseVersion: DiskVersion;
  bufferRevision: number; controlRevision: number; text: string;
}

export interface DocumentSaveReceipt {
  status: 'accepted' | 'succeeded' | 'failed' | 'unresolved' | 'unknown';
  requestId: string; workspace?: WorkspaceIdentity; relativePath?: string; bufferRevision?: number;
  reasonCode?: string; version?: DiskVersion; document?: DocumentIdentity;
  encoding?: string; bom?: string; eol?: string; reconciled?: boolean;
}

const identityFields = ['ownerId', 'executorInstance', 'sessionId', 'workingDir', 'workspaceRevision'] as const;
export function sameWorkspace(left: WorkspaceIdentity, right: unknown): right is WorkspaceIdentity {
  return !!right && typeof right === 'object'
    && identityFields.every(key => left[key] === (right as WorkspaceIdentity)[key]);
}
export function validDiskVersion(value: unknown): value is DiskVersion {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.exists === false) return Object.keys(row).length === 1;
  return row.exists === true && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256)
    && Number.isSafeInteger(row.byteLength) && (row.byteLength as number) >= 0
    && ['fileId', 'modifiedNs', 'changedNs'].every(key => typeof row[key] === 'string' && !!row[key]);
}

export function sameDiskVersion(left: DiskVersion | null, right: DiskVersion | null): boolean {
  if (!left || !right) return left === right;
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.sha256 === right.sha256 && left.byteLength === right.byteLength && left.fileId === right.fileId
    && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs;
}

export function documentRelativePath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || /^[\\/]/.test(path) || /[:\0]/.test(path)) {
    throw new DocumentProtocolError('invalid_path');
  }
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) throw new DocumentProtocolError('invalid_path');
  return parts.join('/');
}

function matchingPath(workspace: WorkspaceIdentity, requested: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = documentRelativePath(requested), b = documentRelativePath(received);
  return /^[a-z]:[\\/]/i.test(workspace.workingDir) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 不持有旧覆盖写接口，不自动重发写请求；断线后调用 saveGet 核对原 requestId。 */
export class WorkspaceDocuments {
  readonly source = 'executor' as const;
  private constructor(
    readonly target: Readonly<WorkbenchTarget>, readonly capability: Readonly<WorkbenchCapabilities>,
    private readonly call: WorkbenchCall, private readonly isCurrent: () => boolean,
  ) {}

  static async connect(target: WorkbenchTarget, call: WorkbenchCall, isCurrent: () => boolean): Promise<WorkspaceDocuments> {
    const captured = Object.freeze({ ...target });
    const capability = await readWorkbenchCapabilities(captured, call, isCurrent);
    if (capability.identity) Object.freeze(capability.identity);
    Object.freeze(capability.capabilities);
    return new WorkspaceDocuments(captured, Object.freeze(capability), call, isCurrent);
  }

  get supported(): boolean { return this.capability.capabilities.documents === 1 && !!this.capability.identity; }
  get identity(): WorkspaceIdentity {
    if (!this.supported) throw new DocumentProtocolError('safe_documents_unsupported');
    return this.capability.identity!;
  }

  private async request(method: string, parameters: unknown[], timeout = 12000): Promise<any> {
    const identity = this.identity;
    if (!this.isCurrent()) throw new DocumentProtocolError('stale_workspace');
    const raw = await this.call(this.target.executor, method,
      [this.target.session, JSON.stringify(identity), ...parameters], timeout);
    if (!this.isCurrent()) throw new DocumentProtocolError('stale_workspace');
    if (raw == null) throw new DocumentProtocolError('safe_documents_unsupported');
    let result;
    try { result = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { throw new DocumentProtocolError('invalid_response'); }
    if (!result || typeof result !== 'object') throw new DocumentProtocolError('invalid_response');
    if (result.status === 'error') throw new DocumentProtocolError(
      typeof result.reasonCode === 'string' ? result.reasonCode : 'document_request_failed');
    if (result.workspace && !sameWorkspace(identity, result.workspace)) throw new DocumentProtocolError('stale_workspace');
    return result;
  }

  async read(relativePath: string, requestId: string, preview = false): Promise<DocumentRead> {
    const relative = documentRelativePath(relativePath);
    const row = await this.request('workspaceDocumentRead', [relative, preview, requestId]);
    if (row.status !== 'ok' || !sameWorkspace(this.identity, row.document?.workspace)
        || row.document?.source !== 'executor' || !matchingPath(this.identity, relative, row.document?.relativePath)
        || typeof row.document?.canonicalPath !== 'string' || typeof row.text !== 'string'
        || row.text.length > 8 * 1024 * 1024 || typeof row.complete !== 'boolean'
        || typeof row.editable !== 'boolean' || typeof row.canSave !== 'boolean'
        || !Number.isSafeInteger(row.controlRevision) || row.controlRevision < 0
        || !['encoding', 'bom', 'eol', 'reasonCode', 'writeReasonCode'].every(key => typeof row[key] === 'string')
        || !['byteLength', 'readByteLength'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
        || row.version !== null && !validDiskVersion(row.version)) {
      throw new DocumentProtocolError('invalid_document_response');
    }
    if ((row.editable || row.canSave) && (!row.complete || !row.version?.exists
        || row.readByteLength !== row.byteLength || row.version.byteLength !== row.byteLength
        || row.reasonCode || preview || !['utf-8', 'utf-16-le', 'utf-16-be'].includes(row.encoding)
        || !['', 'utf8', 'utf16le', 'utf16be'].includes(row.bom) || !['lf', 'crlf', 'cr', 'none'].includes(row.eol))
        || row.canSave && !row.editable) {
      throw new DocumentProtocolError('unsafe_document_response');
    }
    return row;
  }

  async cancelRead(requestId: string): Promise<void> {
    await this.request('workspaceDocumentReadCancel', [requestId]);
  }

  private receipt(row: any, requestId: string, request?: DocumentSaveRequest): DocumentSaveReceipt {
    if (!['accepted', 'succeeded', 'failed', 'unresolved', 'unknown'].includes(row.status) || row.requestId !== requestId
        || row.status !== 'unknown' && (!sameWorkspace(this.identity, row.workspace)
          || typeof row.relativePath !== 'string' || !Number.isSafeInteger(row.bufferRevision) || row.bufferRevision < 0)
        || request && row.status !== 'unknown' && (row.bufferRevision !== request.bufferRevision
          || !matchingPath(this.identity, request.relativePath, row.relativePath))
        || row.status === 'succeeded' && (!validDiskVersion(row.version) || !row.version.exists
          || !sameWorkspace(this.identity, row.document?.workspace)
          || !matchingPath(this.identity, row.relativePath, row.document?.relativePath))) {
      throw new DocumentProtocolError('invalid_save_receipt');
    }
    return row;
  }

  async save(request: DocumentSaveRequest): Promise<DocumentSaveReceipt> {
    const captured = JSON.parse(JSON.stringify(request)) as DocumentSaveRequest;
    documentRelativePath(captured.relativePath);
    if (!validDiskVersion(captured.baseVersion) || !Number.isSafeInteger(captured.bufferRevision)
        || captured.bufferRevision < 0 || !Number.isSafeInteger(captured.controlRevision)
        || typeof captured.text !== 'string' || captured.text.length > 8 * 1024 * 1024) {
      throw new DocumentProtocolError('invalid_save_request');
    }
    return this.receipt(await this.request('workspaceDocumentSave', [JSON.stringify(captured)]), captured.requestId, captured);
  }

  async saveGet(requestId: string, waitSeconds = 0): Promise<DocumentSaveReceipt> {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 10) throw new DocumentProtocolError('invalid_request');
    return this.receipt(await this.request('workspaceDocumentSaveGet', [requestId, waitSeconds], 12000), requestId);
  }

  async refresh(documents: { relativePath: string; version: DiskVersion | null }[]): Promise<any> {
    if (documents.length > 16) throw new DocumentProtocolError('refresh_limit');
    const captured = documents.map(row => ({ relativePath: documentRelativePath(row.relativePath), version: row.version }));
    const result = await this.request('workspaceDocumentRefresh', [JSON.stringify(captured)]);
    if (result.status !== 'ok' || !sameWorkspace(this.identity, result.workspace) || !Array.isArray(result.documents)
        || result.documents.length !== captured.length || !result.documents.every((row: any, index: number) =>
          matchingPath(this.identity, captured[index].relativePath, row.relativePath)
          && ['unchanged', 'changed', 'error'].includes(row.status)
          && (row.version == null || validDiskVersion(row.version)))) throw new DocumentProtocolError('invalid_refresh_response');
    return result;
  }

  async search(mode: 'files' | 'content', query: string, requestId: string, limit = 200): Promise<any> {
    const result = await this.request('workspaceSearch', [requestId, mode, query, limit]);
    if (result.status !== 'ok' || result.requestId !== requestId || !sameWorkspace(this.identity, result.workspace)
        || !Array.isArray(result.results) || result.results.length > 500) throw new DocumentProtocolError('invalid_search_response');
    result.results.forEach((row: any) => {
      documentRelativePath(row.relativePath);
      if (row.line !== undefined && (!Number.isSafeInteger(row.line) || row.line < 1)
          || row.column !== undefined && (!Number.isSafeInteger(row.column) || row.column < 1)
          || row.preview !== undefined && (typeof row.preview !== 'string' || row.preview.length > 1024)) {
        throw new DocumentProtocolError('invalid_search_response');
      }
    });
    return result;
  }

  async cancelSearch(requestId: string): Promise<void> {
    await this.request('workspaceSearchCancel', [requestId]);
  }

  async gitComparison(relativePath: string, requestId: string): Promise<any> {
    const relative = documentRelativePath(relativePath);
    const result = await this.request('workspaceGitComparison', [requestId, relative]);
    if (result.status !== 'ok' || result.requestId !== requestId || !sameWorkspace(this.identity, result.workspace)
        || !matchingPath(this.identity, relative, result.relativePath) || result.baseline?.source !== 'git-head'
        || result.disk?.source !== 'disk' || typeof result.baseline.text !== 'string'
        || typeof result.disk.text !== 'string' || !validDiskVersion(result.disk.version)) throw new DocumentProtocolError('invalid_git_response');
    return result;
  }
}
