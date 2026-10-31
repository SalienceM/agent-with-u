import { byteHash, MAX_EDIT_BYTES, PREVIEW_BYTES } from './documentCodec';
import type { LocalByteDocument, LocalDocumentAdapter } from './localDocuments';
import { uuid } from './uuid';
import { DocumentProtocolError, documentRelativePath, sameDiskVersion } from './workspaceDocuments';
import type { DiskVersion } from './sessionWorkbench';

export interface ManagedDocumentRecord {
  data: Blob; documentRevision: string; updatedAt: number;
}
export interface ManagedDocumentStorage {
  read(relative: string): Promise<ManagedDocumentRecord>;
  /** 同一 IDB readwrite 事务比较 revision 并替换，不能先读后无条件 put。 */
  replace(relative: string, revision: string, value: ManagedDocumentRecord, assertCurrent: () => void): Promise<void>;
}

export interface ManagedReviewStorage {
  read(path: string): Promise<ManagedDocumentRecord | null>;
  replace(path: string, revision: string | null, value: ManagedDocumentRecord, current: () => void): Promise<void>;
}
/** 审阅专用：missing 为真实查询结果，创建/替换均由 storage 在同一事务 CAS。 */
export class ManagedReviewByteAdapter implements LocalDocumentAdapter {
  constructor(readonly bindingId: string, private storage: ManagedReviewStorage) {}
  lock<T>(_path: string, operation: () => Promise<T>): Promise<T> { return operation(); }
  confirmsCommit(version: DiskVersion, commitId: string): boolean { return version.exists && version.changedNs === commitId; }
  async resourceKey(path: string): Promise<string> { return JSON.stringify([this.bindingId, documentRelativePath(path)]); }
  private async snapshot(path: string, record: ManagedDocumentRecord): Promise<LocalByteDocument> {
    const size = record.data.size, complete = size <= 2 * 1024 * 1024;
    const bytes = new Uint8Array(await record.data.slice(0, complete ? size : 0).arrayBuffer());
    return { bytes, size, complete, version: complete ? { exists: true, sha256: byteHash(bytes), byteLength: size,
      fileId: await this.resourceKey(path), modifiedNs: String(record.updatedAt), changedNs: record.documentRevision } : null };
  }
  async read(path: string): Promise<LocalByteDocument> {
    const record = await this.storage.read(documentRelativePath(path));
    if (!record) throw new DocumentProtocolError('file_not_found');
    return this.snapshot(path, record);
  }
  async replace(path: string, baseline: DiskVersion, bytes: Uint8Array, current: () => void, commitId = uuid()): Promise<LocalByteDocument> {
    const original = await this.storage.read(documentRelativePath(path));
    const version = original ? (await this.snapshot(path, original)).version : { exists: false as const };
    if (!sameDiskVersion(version, baseline)) throw new DocumentProtocolError('disk_conflict');
    const record = { data: new Blob([bytes.slice().buffer]), updatedAt: Date.now(), documentRevision: commitId };
    await this.storage.replace(path, original?.documentRevision || null, record, current);
    return this.snapshot(path, record);
  }
}

export class ManagedDocumentAdapter implements LocalDocumentAdapter {
  constructor(readonly bindingId: string, private storage: ManagedDocumentStorage) {}
  // LAN HTTP 没有 Web Locks：同源 IDB 原子 claim + 文件事务 CAS 保证唯一写者。
  lock<T>(_relative: string, operation: () => Promise<T>): Promise<T> { return operation(); }
  confirmsCommit(version: DiskVersion, commitId: string): boolean { return version.exists && version.changedNs === commitId; }
  async resourceKey(relative: string): Promise<string> { return JSON.stringify([this.bindingId, documentRelativePath(relative)]); }
  private async snapshot(relative: string, record: ManagedDocumentRecord): Promise<LocalByteDocument> {
    const size = record.data.size, complete = size <= MAX_EDIT_BYTES;
    const bytes = new Uint8Array(await record.data.slice(0, complete ? size : PREVIEW_BYTES).arrayBuffer());
    return { bytes, complete, size, version: complete ? { exists: true, sha256: byteHash(bytes), byteLength: size,
      fileId: await this.resourceKey(relative), modifiedNs: `${record.updatedAt}`, changedNs: record.documentRevision } : null };
  }
  async read(relative: string): Promise<LocalByteDocument> {
    relative = documentRelativePath(relative);
    return this.snapshot(relative, await this.storage.read(relative));
  }
  async replace(relative: string, baseline: DiskVersion, bytes: Uint8Array, assertCurrent: () => void, commitId = uuid()): Promise<LocalByteDocument> {
    relative = documentRelativePath(relative);
    let original: ManagedDocumentRecord;
    try {
      original = await this.storage.read(relative);
      if (!sameDiskVersion((await this.snapshot(relative, original)).version, baseline)) throw new DocumentProtocolError('disk_conflict');
      assertCurrent();
    } catch (error) { throw error instanceof DocumentProtocolError ? error : new DocumentProtocolError('write_not_started'); }
    const saved = { data: new Blob([bytes.slice().buffer]), documentRevision: commitId, updatedAt: Date.now() };
    await this.storage.replace(relative, original.documentRevision, saved, assertCurrent);
    return this.snapshot(relative, saved);
  }
}
