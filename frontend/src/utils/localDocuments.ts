import type { DiskVersion, WorkspaceIdentity } from './sessionWorkbench';
import { byteHash, decodeDocumentBytes, encodeDocumentText, MAX_EDIT_BYTES, specializedDocument } from './documentCodec';
import { uuid } from './uuid';
import { windowTransport } from './workbenchWindows';
import { DocumentProtocolError, documentRelativePath, sameDiskVersion, validDiskVersion, type DocumentRead, type DocumentSaveReceipt, type DocumentSaveRequest } from './workspaceDocuments';

export interface LocalByteDocument {
  bytes: Uint8Array; version: DiskVersion | null; size: number; complete: boolean;
  readonly?: boolean; canonicalPath?: string;
}
export interface LocalDocumentAdapter {
  /** 真实目录绑定，不得使用目录显示名称。 */
  bindingId: string;
  resourceKey(relative: string): Promise<string>;
  read(relative: string): Promise<LocalByteDocument>;
  /** 必须再次比较 baseline，在平台原子提交前执行 assertCurrent。 */
  replace(relative: string, baseline: DiskVersion, bytes: Uint8Array, assertCurrent: () => void, commitId?: string): Promise<LocalByteDocument>;
  confirmsCommit?(version: DiskVersion, commitId: string): boolean;
  lock<T>(relative: string, operation: () => Promise<T>): Promise<T>;
}
export interface LocalSaveJournal {
  key: string; documentKey: string; digest: string; savedHash: string; commitId: string;
  baseVersion?: DiskVersion;
  receipt: DocumentSaveReceipt;
}
export interface LocalJournalStore {
  get(key: string): Promise<LocalSaveJournal | undefined>;
  pending(documentKey: string): Promise<LocalSaveJournal | undefined>;
  /** 原子接收：同一 requestId 只返回旧记录，不产生第二个写者。 */
  claim(value: LocalSaveJournal): Promise<LocalSaveJournal>;
  put(value: LocalSaveJournal): Promise<void>;
}

/** 本机来源明确独立；从不调用执行端 RPC/旧覆盖写/上传。 */
export class LocalDocuments {
  readonly source = 'local-copy' as const;
  readonly supported = true;
  readonly identity: WorkspaceIdentity;
  constructor(owner: string, session: string, private executor: string, private adapter: LocalDocumentAdapter,
    private journal: LocalJournalStore, private isCurrent: () => boolean) {
    const revision = byteHash(new TextEncoder().encode(JSON.stringify([owner, session, executor, adapter.bindingId])));
    this.identity = Object.freeze({ ownerId: owner, sessionId: session, executorInstance: `local-copy:${adapter.bindingId}`,
      workingDir: adapter.bindingId, workspaceRevision: revision });
  }
  private current = (): void => { if (!this.isCurrent()) throw new DocumentProtocolError('stale_workspace'); };
  private writeCurrent = (): void => {
    this.current();
    try { windowTransport.metadata(this.executor, 'workspaceDocumentSave', [this.identity.sessionId]); }
    catch { throw new DocumentProtocolError('stale_workspace'); }
  };
  private wrap(relative: string, raw: LocalByteDocument): DocumentRead {
    const { lineEndings: _lineEndings, ...format } = decodeDocumentBytes(raw.bytes, raw.complete);
    const reasonCode = specializedDocument(relative) ? 'specialized_preview' : !raw.complete ? 'too_large'
      : raw.readonly ? 'document_readonly' : format.reasonCode;
    if (raw.complete && (raw.size !== raw.bytes.length || !validDiskVersion(raw.version)
      || !raw.version.exists || raw.version.byteLength !== raw.size || raw.version.sha256 !== byteHash(raw.bytes))) {
      throw new DocumentProtocolError('invalid_document_response');
    }
    const editable = !reasonCode && !!raw.version?.exists && raw.size <= MAX_EDIT_BYTES;
    return { status: 'ok', document: { workspace: this.identity, source: 'local-copy', relativePath: relative,
        canonicalPath: raw.canonicalPath || `${this.adapter.bindingId}/${relative}` },
      ...format, reasonCode, complete: raw.complete, editable, canSave: editable, writeReasonCode: reasonCode,
      byteLength: raw.size, readByteLength: raw.bytes.length, version: raw.version, controlRevision: 0 };
  }
  async read(relative: string, _requestId = ''): Promise<DocumentRead> {
    this.current(); relative = documentRelativePath(relative);
    const raw = await this.adapter.read(relative); this.current();
    return this.wrap(relative, raw);
  }
  async save(input: DocumentSaveRequest): Promise<DocumentSaveReceipt> {
    this.writeCurrent();
    const request: DocumentSaveRequest = JSON.parse(JSON.stringify(input));
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId) || !Number.isSafeInteger(request.bufferRevision)
      || request.bufferRevision < 0 || request.controlRevision !== 0 || typeof request.text !== 'string'
      || !validDiskVersion(request.baseVersion)) throw new DocumentProtocolError('invalid_request');
    const relative = documentRelativePath(request.relativePath);
    const key = `${this.identity.workspaceRevision}:request:${request.requestId}`;
    const base = request.baseVersion;
    const digest = byteHash(new TextEncoder().encode(JSON.stringify([relative, request.requestId, request.bufferRevision,
      request.controlRevision, request.text, base.exists ? [base.sha256, base.byteLength, base.fileId, base.modifiedNs, base.changedNs] : false])));
    const receipt: DocumentSaveReceipt = { status: 'failed', requestId: request.requestId, workspace: this.identity,
      relativePath: relative, bufferRevision: request.bufferRevision };
    let entered = false;
    try { return await this.adapter.lock(relative, async () => {
      entered = true;
      this.current();
      const previous = await this.journal.get(key);
      if (previous) {
        if (previous.digest !== digest) throw new DocumentProtocolError('request_conflict');
        return previous.receipt;
      }
      let bytes: Uint8Array, documentKey = `${this.adapter.bindingId}/${relative}`;
      try {
        documentKey = await this.adapter.resourceKey(relative);
        if (await this.journal.pending(documentKey)) throw new DocumentProtocolError('save_needs_reconciliation');
        const raw = await this.adapter.read(relative); this.current();
        const original = this.wrap(relative, raw);
        if (!sameDiskVersion(original.version, request.baseVersion)) throw new DocumentProtocolError('disk_conflict');
        if (!original.editable) throw new DocumentProtocolError('document_readonly');
        bytes = encodeDocumentText(request.text, decodeDocumentBytes(raw.bytes, raw.complete));
      } catch (error) {
        // 此处尚未进入平台写入，向缓冲区返回确定失败，不能把磁盘冲突误判为未知提交。
        const failed = { ...receipt, reasonCode: error instanceof DocumentProtocolError ? error.reasonCode : 'write_not_started' };
        const claimed = await this.journal.claim({ key, documentKey, digest, savedHash: '', commitId: '', receipt: failed });
        if (claimed.digest !== digest) throw new DocumentProtocolError('request_conflict');
        return claimed.receipt;
      }
      const job: LocalSaveJournal = { key, documentKey, digest, savedHash: byteHash(bytes), commitId: uuid(), baseVersion: request.baseVersion,
        receipt: { ...receipt, status: 'accepted' } };
      // 先持久化非终态；没有可靠核对记录时，不开始覆盖。
      let claimed: LocalSaveJournal;
      try { claimed = await this.journal.claim(job); }
      catch (error) { return { ...receipt, reasonCode: error instanceof DocumentProtocolError ? error.reasonCode : 'journal_unavailable' }; }
      if (claimed.digest !== digest) throw new DocumentProtocolError('request_conflict');
      if (claimed.commitId !== job.commitId) return claimed.receipt;
      try {
        this.writeCurrent();
        const saved = await this.adapter.replace(relative, request.baseVersion, bytes, this.writeCurrent, job.commitId);
        if (!saved.version?.exists || saved.version.sha256 !== job.savedHash) throw new DocumentProtocolError('save_result_unverified');
        const read = this.wrap(relative, saved);
        job.receipt = { ...job.receipt, status: 'succeeded', version: saved.version,
          document: read.document, encoding: read.encoding, bom: read.bom, eol: read.eol };
      } catch (error) {
        const reason = error instanceof DocumentProtocolError ? error.reasonCode : 'save_result_unverified';
        // 平台适配器仅在能证明提交未发生时返回这些终态失败；其他异常保守未知。
        const failed = ['disk_conflict', 'document_readonly', 'stale_workspace', 'write_not_started', 'write_aborted'].includes(reason);
        job.receipt = { ...job.receipt, status: failed ? 'failed' : 'unresolved', reasonCode: reason };
      }
      await this.journal.put(job);
      this.current(); return job.receipt;
    }); } catch (error) {
      if (!entered) return { ...receipt, reasonCode: error instanceof DocumentProtocolError ? error.reasonCode : 'local_lock_unavailable' };
      throw error;
    }
  }
  async saveGet(requestId: string): Promise<DocumentSaveReceipt> {
    this.current();
    const key = `${this.identity.workspaceRevision}:request:${requestId}`;
    const job = await this.journal.get(key); this.current();
    if (!job) return { status: 'unknown', requestId, reasonCode: 'receipt_unavailable' };
    if (['accepted', 'unresolved'].includes(job.receipt.status)) {
      return this.adapter.lock(job.receipt.relativePath!, async () => {
        this.current();
        const latest = await this.journal.get(key);
        if (!latest) return { status: 'unknown', requestId };
        if (!['accepted', 'unresolved'].includes(latest.receipt.status)) return latest.receipt;
        const read = await this.read(latest.receipt.relativePath!);
        if (read.version?.exists && read.version.sha256 === latest.savedHash
          && (this.adapter.confirmsCommit ? this.adapter.confirmsCommit(read.version, latest.commitId)
            : !!latest.baseVersion && !sameDiskVersion(read.version, latest.baseVersion))) {
          latest.receipt = { ...latest.receipt, status: 'succeeded', version: read.version,
            document: read.document, reconciled: true };
          await this.journal.put(latest);
        } else latest.receipt = { ...latest.receipt, status: 'unresolved', reasonCode: 'save_result_unverified' };
        return latest.receipt;
      });
    }
    return job.receipt;
  }
}
