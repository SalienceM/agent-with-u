import { byteHash } from './documentCodec';
import { DocumentProtocolError, documentRelativePath, sameWorkspace, validDiskVersion } from './workspaceDocuments';
import type { DiskVersion, WorkbenchCall, WorkbenchTarget, WorkspaceIdentity } from './sessionWorkbench';
import { REVIEW_MAX_BYTES, type ReviewSide } from './directorySyncReview';

export interface ReviewCapabilities {
  workspace: WorkspaceIdentity; read: boolean; apply: boolean; controlRevision: number; writeReasonCode?: string;
}
export interface ReviewApply {
  requestId: string; relativePath: string; baseVersion: DiskVersion; bytes: Uint8Array; scopeKey: string;
}
export interface ReviewReceipt {
  status: 'accepted' | 'succeeded' | 'failed' | 'unresolved' | 'unknown'; requestId: string;
  workspace?: WorkspaceIdentity; relativePath?: string; scopeKey?: string; direction?: 'push' | 'pull';
  sourceHash?: string; version?: DiskVersion; reasonCode?: string;
}
export interface ReviewAdapter {
  bindingId: string;
  canCreate: boolean;
  read(path: string): Promise<ReviewSide>;
  check(path: string): Promise<ReviewSide>;
  apply(request: ReviewApply, assertCurrent: () => void): Promise<ReviewReceipt>;
  get(requestId: string): Promise<ReviewReceipt>;
}
/** 仅用于提交前的本机校验或服务端明确拒绝；网络/回执解析错误不能使用。 */
export class ReviewNotSubmitted extends DocumentProtocolError {}
export function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function parsed(value: unknown): any { return typeof value === 'string' ? JSON.parse(value) : value; }
function requireOk(row: any): void {
  if (row?.status !== 'ok') throw new DocumentProtocolError(row?.reasonCode || 'review_unsupported');
}
export class RemoteSyncReview {
  private constructor(readonly target: WorkbenchTarget, readonly capability: ReviewCapabilities,
    private call: WorkbenchCall, private current: () => boolean) {}
  static async connect(target: WorkbenchTarget, call: WorkbenchCall, current: () => boolean): Promise<RemoteSyncReview> {
    if (!target.executor || !target.user || !target.session || !target.workingDir || !current()) throw new DocumentProtocolError('stale_workspace');
    const row = parsed(await call(target.executor, 'syncReviewCapabilities', [target.session, target.workingDir], 12000));
    if (!current()) throw new DocumentProtocolError('stale_workspace');
    requireOk(row);
    const w = row.workspace;
    if (row.protocolVersion !== 1 || !row.read || row.maxBytes !== REVIEW_MAX_BYTES) throw new DocumentProtocolError('review_unsupported');
    if (!w || w.ownerId !== target.user || w.sessionId !== target.session || !w.executorInstance || !w.workingDir
      || !/^[a-f0-9]{64}$/.test(w.workspaceRevision) || !Number.isSafeInteger(row.controlRevision)) throw new DocumentProtocolError('stale_workspace');
    return new RemoteSyncReview(Object.freeze({ ...target }), Object.freeze({ ...row, workspace: Object.freeze({ ...w }) }), call, current);
  }
  private async request(method: string, args: unknown[], timeout = 12000): Promise<any> {
    if (!this.current()) throw new DocumentProtocolError('stale_workspace');
    const row = parsed(await this.call(this.target.executor, method, [this.target.session, JSON.stringify(this.capability.workspace), ...args], timeout));
    if (!this.current()) throw new DocumentProtocolError('stale_workspace');
    return row;
  }
  private async readSide(path: string, content: boolean): Promise<ReviewSide> {
    path = documentRelativePath(path);
    const row = await this.request(content ? 'syncReviewRead' : 'syncReviewCheck', [path]);
    requireOk(row);
    if (!sameWorkspace(this.capability.workspace, row.workspace) || row.relativePath !== path) throw new DocumentProtocolError('invalid_review_response');
    if (row.kind === 'missing' && validDiskVersion(row.version) && !row.version.exists) return { kind: 'missing', version: row.version };
    if (row.kind === 'directory' || row.kind === 'unavailable') return { kind: row.kind, version: null, reasonCode: row.reasonCode || 'review_unavailable' };
    if (row.kind !== 'file' || !validDiskVersion(row.version) || !row.version.exists || row.version.byteLength > REVIEW_MAX_BYTES) throw new DocumentProtocolError('invalid_review_response');
    let bytes: Uint8Array | undefined;
    if (content && !row.reasonCode) {
      if (typeof row.data !== 'string' || row.data.length > Math.ceil(REVIEW_MAX_BYTES / 3) * 4) throw new DocumentProtocolError('invalid_review_response');
      bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
      if (bytes.length !== row.version.byteLength || byteHash(bytes) !== row.version.sha256) throw new DocumentProtocolError('invalid_review_response');
    }
    return { kind: 'file', version: row.version, bytes, reasonCode: row.reasonCode || '', readonly: row.readonly };
  }
  read(path: string): Promise<ReviewSide> { return this.readSide(path, true); }
  check(path: string): Promise<ReviewSide> { return this.readSide(path, false); }
  private receipt(row: any, requestId: string, request?: ReviewApply): ReviewReceipt {
    if (row?.status === 'error') throw new DocumentProtocolError(row.reasonCode || 'review_failed');
    if (!row || row.requestId !== requestId || !['accepted', 'succeeded', 'failed', 'unresolved', 'unknown'].includes(row.status)) throw new DocumentProtocolError('invalid_review_receipt');
    if (row.status !== 'unknown' && (!sameWorkspace(this.capability.workspace, row.workspace) || !row.relativePath || !row.scopeKey
      || row.direction !== 'push' || !/^[a-f0-9]{64}$/.test(row.sourceHash))) throw new DocumentProtocolError('invalid_review_receipt');
    if (request && row.status !== 'unknown' && (row.relativePath !== request.relativePath || row.scopeKey !== request.scopeKey
      || row.sourceHash !== byteHash(request.bytes))) throw new DocumentProtocolError('invalid_review_receipt');
    if (row.status === 'succeeded' && (!validDiskVersion(row.version) || !row.version.exists || row.version.sha256 !== row.sourceHash)) throw new DocumentProtocolError('invalid_review_receipt');
    return row;
  }
  async apply(request: ReviewApply): Promise<ReviewReceipt> {
    if (!this.current()) throw new ReviewNotSubmitted('stale_workspace');
    if (!this.capability.apply) throw new ReviewNotSubmitted(this.capability.writeReasonCode || 'review_write_unsupported');
    if (request.bytes.length > REVIEW_MAX_BYTES || !validDiskVersion(request.baseVersion)) throw new ReviewNotSubmitted('invalid_request');
    const { bytes, ...metadata } = request;
    const payload = { ...metadata, relativePath: documentRelativePath(request.relativePath), sourceHash: byteHash(bytes),
      data: bytesBase64(bytes), controlRevision: this.capability.controlRevision };
    const row = await this.request('syncReviewApply', [JSON.stringify(payload)]);
    if (row?.status === 'error') throw new ReviewNotSubmitted(row.reasonCode || 'review_rejected');
    return this.receipt(row, request.requestId, request);
  }
  async get(requestId: string, waitSeconds = 0): Promise<ReviewReceipt> {
    return this.receipt(await this.request('syncReviewGet', [requestId, waitSeconds]), requestId);
  }
}
