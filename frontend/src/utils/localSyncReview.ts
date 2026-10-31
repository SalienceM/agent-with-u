import type { DiskVersion } from './sessionWorkbench';
import type { LocalByteDocument, LocalDocumentAdapter } from './localDocuments';
import { byteHash } from './documentCodec';
import { DocumentProtocolError, documentRelativePath, sameDiskVersion, validDiskVersion } from './workspaceDocuments';
import { REVIEW_MAX_BYTES, type ReviewSide } from './directorySyncReview';
import { bytesBase64, ReviewNotSubmitted, type ReviewAdapter, type ReviewApply, type ReviewReceipt } from './syncReviewProtocol';
import { uuid } from './uuid';

interface Job { key: string; resource: string; digest: string; commitId: string; receipt: ReviewReceipt }
interface Journal { claim(job: Job): Promise<Job>; put(job: Job): Promise<void>; get(key: string): Promise<Job | undefined> }
const terminal = (j: Job) => j.receipt.status === 'succeeded' || j.receipt.status === 'failed';
export class ReviewJournal implements Journal {
  private async transaction<T>(write: boolean, fn: (store: IDBObjectStore, result: (v: T) => void) => void): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('awu-sync-review-receipts-v1', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('receipts', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => reject(new DocumentProtocolError('journal_unavailable'));
    });
    return new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', write ? 'readwrite' : 'readonly'); let value: T;
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new DocumentProtocolError('journal_unavailable')); };
      try { fn(tx.objectStore('receipts'), v => { value = v; }); } catch (e) { tx.abort(); reject(e); }
    });
  }
  get(key: string): Promise<Job | undefined> { return this.transaction(false, (s, done) => { const r = s.get(key); r.onsuccess = () => done(r.result); }); }
  claim(job: Job): Promise<Job> {
    return this.transaction(true, (store, done) => {
      const read = store.getAll(); read.onsuccess = () => {
        const jobs = read.result as Job[], previous = jobs.find(j => j.key === job.key);
        if (previous) { done(previous); return; }
        const pending = jobs.filter(j => !terminal(j));
        if (pending.length >= 32 || pending.some(j => j.resource === job.resource)) { store.transaction.abort(); return; }
        const completed = jobs.filter(terminal);
        for (const expired of completed.slice(0, Math.max(0, completed.length - 255))) store.delete(expired.key);
        store.add(job); done(job);
      };
    });
  }
  put(job: Job): Promise<void> {
    return this.transaction(true, (store, done) => {
      const read = store.get(job.key); read.onsuccess = () => {
        if (!read.result || read.result.digest !== job.digest) { store.transaction.abort(); return; }
        if (terminal(read.result)) { done(undefined); return; }
        store.put(job);
        const all = store.getAll(); all.onsuccess = () => {
          const completed = (all.result as Job[]).filter(terminal);
          for (const expired of completed.slice(0, Math.max(0, completed.length - 256))) store.delete(expired.key);
          done(undefined);
        };
      };
    });
  }
}
export function reviewBytes(raw: LocalByteDocument): ReviewSide {
  if (!raw.complete || raw.size > REVIEW_MAX_BYTES) return { kind: 'unavailable', version: null, reasonCode: 'too_large' };
  if (!validDiskVersion(raw.version) || !raw.version.exists || raw.size !== raw.bytes.length
    || raw.version.byteLength !== raw.size || raw.version.sha256 !== byteHash(raw.bytes)) throw new DocumentProtocolError('invalid_review_response');
  return { kind: 'file', bytes: raw.bytes, version: raw.version, readonly: raw.readonly };
}
/** Browser/managed 共用日志与版本前提，原字节 adapter 不经过文本编码 API。 */
export class LocalSyncReview implements ReviewAdapter {
  readonly bindingId: string;
  constructor(private adapter: LocalDocumentAdapter, readonly canCreate: boolean,
    private readSide: (path: string) => Promise<ReviewSide>, private scopeKey: string,
    private journal: Journal = new ReviewJournal()) { this.bindingId = adapter.bindingId; }
  read(path: string): Promise<ReviewSide> { return this.readSide(documentRelativePath(path)); }
  async check(path: string): Promise<ReviewSide> { const side = await this.read(path); return { ...side, bytes: undefined }; }
  private key(rid: string): string { return JSON.stringify([this.bindingId, this.scopeKey, rid]); }
  async apply(input: ReviewApply, current: () => void): Promise<ReviewReceipt> {
    let admitted = false;
    try {
    const request = { ...input, bytes: input.bytes.slice(), baseVersion: { ...input.baseVersion } };
    const path = documentRelativePath(request.relativePath);
    if (request.scopeKey !== this.scopeKey || !/^[\w-]{1,128}$/.test(request.requestId) || request.bytes.length > REVIEW_MAX_BYTES
      || !validDiskVersion(request.baseVersion)) throw new DocumentProtocolError('invalid_request');
    if (!request.baseVersion.exists && !this.canCreate) throw new DocumentProtocolError('safe_create_unsupported');
    const sourceHash = byteHash(request.bytes);
    const digest = byteHash(new TextEncoder().encode(JSON.stringify([path, request.baseVersion, sourceHash, request.scopeKey])));
    return await this.adapter.lock(path, async () => {
      current();
      const key = this.key(request.requestId), old = await this.journal.get(key);
      if (old) { if (old.digest !== digest) throw new DocumentProtocolError('request_conflict'); return old.receipt; }
      const receipt: ReviewReceipt = { status: 'accepted', requestId: request.requestId, relativePath: path,
        scopeKey: request.scopeKey, direction: 'pull', sourceHash };
      const proposed: Job = { key, resource: JSON.stringify([this.bindingId, path]), digest, commitId: uuid(), receipt };
      const job = await this.journal.claim(proposed);
      if (job.digest !== digest) throw new DocumentProtocolError('request_conflict');
      if (job.commitId !== proposed.commitId) return job.receipt;
      admitted = true;
      let entered = false;
      try {
        const before = await this.read(path); current();
        if (!sameDiskVersion(before.version, request.baseVersion)) throw new DocumentProtocolError('disk_conflict');
        if (before.readonly || before.reasonCode) throw new DocumentProtocolError(before.reasonCode || 'document_readonly');
        entered = true;
        const saved = await this.adapter.replace(path, request.baseVersion, request.bytes, current, job.commitId);
        const side = reviewBytes(saved);
        if (!side.version?.exists || side.version.sha256 !== sourceHash) throw new DocumentProtocolError('save_result_unverified');
        job.receipt = { ...receipt, status: 'succeeded', version: side.version };
      } catch (e) {
        const reason = e instanceof DocumentProtocolError ? e.reasonCode : 'save_result_unverified';
        job.receipt = { ...receipt, status: !entered || ['disk_conflict', 'document_readonly', 'stale_workspace', 'dirty_document', 'write_not_started', 'write_aborted'].includes(reason)
          ? 'failed' : 'unresolved', reasonCode: reason };
      }
      await this.journal.put(job);
      return job.receipt;
    });
    } catch (error) {
      if (!admitted) throw new ReviewNotSubmitted(error instanceof DocumentProtocolError ? error.reasonCode : 'review_not_submitted');
      throw error;
    }
  }
  async get(requestId: string): Promise<ReviewReceipt> {
    const job = await this.journal.get(this.key(requestId));
    if (!job) return { status: 'unknown', requestId, reasonCode: 'receipt_unavailable' };
    if (!terminal(job) && this.adapter.confirmsCommit) {
      const observed = await this.check(job.receipt.relativePath!);
      if (observed.version?.exists && observed.version.sha256 === job.receipt.sourceHash
        && this.adapter.confirmsCommit(observed.version, job.commitId)) {
        job.receipt = { ...job.receipt, status: 'succeeded', version: observed.version };
        await this.journal.put(job);
      }
    }
    return job.receipt;
  }
}
type NativeCall = <T>(name: string, args: Record<string, unknown>) => Promise<T>;
export class TauriSyncReview implements ReviewAdapter {
  readonly canCreate = true;
  constructor(readonly bindingId: string, private dir: string, private call: NativeCall, private scopeKey: string) {}
  async read(path: string): Promise<ReviewSide> {
    const row = await this.call<any>('local_sync_review_read', { dir: this.dir, bindingId: this.bindingId, rel: documentRelativePath(path) });
    if (row.kind === 'missing') return { kind: 'missing', version: { exists: false } };
    if (row.kind === 'directory') return { kind: 'directory', version: null, reasonCode: 'type_conflict' };
    const d = row.document;
    if (row.kind !== 'file' || !d || typeof d.data !== 'string' || d.data.length > Math.ceil(REVIEW_MAX_BYTES / 3) * 4) throw new DocumentProtocolError('invalid_review_response');
    return reviewBytes({ ...d, bytes: Uint8Array.from(atob(d.data), c => c.charCodeAt(0)) });
  }
  async check(path: string): Promise<ReviewSide> { const side = await this.read(path); return { ...side, bytes: undefined }; }
  private receipt(row: ReviewReceipt, requestId: string): ReviewReceipt {
    if (row.requestId !== requestId || row.scopeKey !== this.scopeKey || !row.relativePath || !['accepted','succeeded','failed','unresolved'].includes(row.status)) throw new DocumentProtocolError('invalid_review_receipt');
    if (row.status === 'succeeded' && (!validDiskVersion(row.version) || !row.version.exists || row.version.sha256 !== row.sourceHash)) throw new DocumentProtocolError('invalid_review_receipt');
    return { ...row, direction: 'pull' };
  }
  async apply(request: ReviewApply, current: () => void): Promise<ReviewReceipt> {
    if (request.scopeKey !== this.scopeKey || request.bytes.length > REVIEW_MAX_BYTES) throw new ReviewNotSubmitted('invalid_request');
    try { current(); } catch (error) { throw new ReviewNotSubmitted(error instanceof Error ? error.message : 'stale_workspace'); }
    return this.receipt(await this.call('local_sync_review_apply', { dir: this.dir, bindingId: this.bindingId,
      rel: documentRelativePath(request.relativePath), baseline: request.baseVersion.exists ? request.baseVersion : null,
      data: bytesBase64(request.bytes), scopeKey: this.scopeKey, requestId: request.requestId }), request.requestId);
  }
  async get(requestId: string): Promise<ReviewReceipt> {
    try { return this.receipt(await this.call('local_sync_review_get', { bindingId: this.bindingId, scopeKey: this.scopeKey, requestId }), requestId); }
    catch { return { status: 'unknown', requestId, reasonCode: 'receipt_unavailable' }; }
  }
}
