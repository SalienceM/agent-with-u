import type { DiskVersion, DocumentIdentity } from './sessionWorkbench';
import { uuid } from './uuid';
import { DocumentProtocolError, documentRelativePath, sameDiskVersion, validDiskVersion, sameWorkspace, type DocumentRead, type DocumentSaveReceipt,
  type DocumentSaveRequest, type WorkspaceDocuments } from './workspaceDocuments';

export type DocumentClient = Pick<WorkspaceDocuments, 'identity' | 'read' | 'save' | 'saveGet'> & { source?: 'executor' | 'local-copy'; readonly?: boolean };

/** 浏览远端只能读取；本机副本是另一身份。旧待确认保存仍可核对，不重试写入。 */
export function readonlyDocumentClient(client: DocumentClient): DocumentClient {
  return { identity: client.identity, source: client.source, readonly: true,
    read: async (...args) => ({ ...await client.read(...args), editable: false, canSave: false, reasonCode: 'remote_readonly', writeReasonCode: 'remote_readonly' }),
    save: async () => { throw new DocumentProtocolError('remote_readonly'); }, saveGet: request => client.saveGet(request) };
}

export interface DocumentBuffer {
  key: string; lifecycleId: string; identity: DocumentIdentity; text: string; baseText: string;
  revision: number; dirty: boolean; read?: DocumentRead; disk?: DocumentRead;
  loading: boolean; readRequest?: string; error?: string;
  save?: { request: DocumentSaveRequest; receipt?: DocumentSaveReceipt; unknown: boolean };
  editor?: unknown;
  persistence?: 'pending' | 'saved' | 'failed' | 'restored';
  persistenceError?: string;
}

export interface RecoverableDraft {
  format: 1; identity: DocumentIdentity; text: string; baseText: string; revision: number;
  baseVersion: DiskVersion; encoding: string; bom: string; eol: string;
  pendingSave?: DocumentSaveRequest; editor?: unknown;
}

export function documentKey(identity: DocumentIdentity): string {
  const w = identity.workspace;
  let path = documentRelativePath(identity.relativePath);
  if (/^[a-z]:[\\/]/i.test(w.workingDir) || /^\\\\/.test(w.workingDir)) path = path.toLowerCase();
  return JSON.stringify([w.ownerId, w.executorInstance, w.sessionId, w.workingDir, w.workspaceRevision, identity.source, path]);
}

function errorCode(error: unknown): string {
  return error instanceof DocumentProtocolError ? error.reasonCode : 'document_connection_failed';
}

/** 页面内共享真相；布局仅选中文档 key，不复制正文/dirty 到每个容器。 */
export class DocumentStore {
  private documents = new Map<string, Readonly<DocumentBuffer>>();
  private listeners = new Set<() => void>();
  constructor(private readonly nextId: () => string = uuid) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  get = (key: string): Readonly<DocumentBuffer> | undefined => this.documents.get(key);
  all = (): Readonly<DocumentBuffer>[] => [...this.documents.values()];
  private put(value: DocumentBuffer): Readonly<DocumentBuffer> {
    const snapshot = Object.freeze(value);
    this.documents.set(value.key, snapshot);
    for (const listener of this.listeners) listener();
    return snapshot;
  }

  async open(client: DocumentClient, relativePath: string, refresh = false): Promise<Readonly<DocumentBuffer>> {
    const identity: DocumentIdentity = { workspace: client.identity, relativePath: documentRelativePath(relativePath), source: client.source || 'executor' };
    const key = documentKey(identity);
    let existing = this.get(key);
    if (client.readonly && existing?.read) existing = this.put({ ...existing,
      read: { ...existing.read, editable: false, canSave: false, reasonCode: 'remote_readonly', writeReasonCode: 'remote_readonly' },
      disk: existing.disk ? { ...existing.disk, editable: false, canSave: false, reasonCode: 'remote_readonly', writeReasonCode: 'remote_readonly' } : undefined });
    if (existing && !refresh && !existing.error) return existing;
    if (!existing && this.documents.size >= 128) throw new DocumentProtocolError('open_document_limit');
    const requestId = this.nextId();
    this.put({ key, lifecycleId: requestId, identity, text: '', baseText: '', revision: 0, dirty: false,
      ...existing, loading: true, readRequest: requestId, error: undefined });
    try {
      const read = await client.read(relativePath, requestId);
      const current = this.get(key);
      if (!current) throw new DocumentProtocolError('read_cancelled');
      if (current.readRequest !== requestId) return current;
      if (current.dirty || current.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) {
        return this.put({ ...current, loading: false, readRequest: undefined, disk: read });
      }
      return this.put({ ...current, identity: read.document, text: read.text, baseText: read.text,
        read, disk: undefined, revision: current.revision + 1, dirty: false, loading: false,
        editor: read.text === current.text ? current.editor : undefined, readRequest: undefined });
    } catch (error) {
      const current = this.get(key);
      if (current?.readRequest === requestId) this.put({ ...current, loading: false,
        readRequest: undefined, error: errorCode(error) });
      throw error;
    }
  }

  edit(key: string, text: string, editor?: unknown): void {
    const current = this.get(key);
    if (!current?.read?.editable) throw new DocumentProtocolError('document_readonly');
    if (text.length > 8 * 1024 * 1024) throw new DocumentProtocolError('too_large');
    this.put({ ...current, text, revision: current.revision + Number(current.text !== text),
      dirty: text !== current.baseText, editor: editor ?? current.editor });
  }

  editorState(key: string, editor: unknown, lifecycleId?: string): void {
    const current = this.get(key);
    if (current && (!lifecycleId || current.lifecycleId === lifecycleId)) this.put({ ...current, editor });
  }

  applyBatch(changes: { key: string; lifecycleId: string; revision: number; text: string; editor?: unknown }[]): void {
    if (new Set(changes.map(change => change.key)).size !== changes.length) throw new DocumentProtocolError('duplicate_document');
    const snapshots = changes.map(change => {
      const current = this.get(change.key);
      if (!current?.read?.editable || current.lifecycleId !== change.lifecycleId || current.revision !== change.revision
        || change.text.length > 8 * 1024 * 1024 || current.disk || current.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) throw new DocumentProtocolError('edit_plan_stale');
      return Object.freeze({ ...current, text: change.text, dirty: change.text !== current.baseText,
        revision: current.revision + Number(change.text !== current.text), editor: change.editor ?? current.editor });
    });
    for (const snapshot of snapshots) this.documents.set(snapshot.key, snapshot);
    for (const listener of this.listeners) listener();
  }

  persistence(key: string, persistence: DocumentBuffer['persistence'], persistenceError?: string): void {
    const current = this.get(key);
    if (current && (current.persistence !== persistence || current.persistenceError !== persistenceError)) {
      this.put({ ...current, persistence, persistenceError });
    }
  }

  restore(key: string, draft: RecoverableDraft): void {
    const current = this.get(key);
    if (!current?.read || current.dirty || current.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) {
      throw new DocumentProtocolError('draft_restore_conflict');
    }
    if (draft.format !== 1 || documentKey(draft.identity) !== key || !sameWorkspace(current.identity.workspace, draft.identity.workspace)
      || ![draft.text, draft.baseText].every(text => typeof text === 'string' && text.length <= 8 * 1024 * 1024)
      || !Number.isSafeInteger(draft.revision) || draft.revision < 0 || !validDiskVersion(draft.baseVersion)
      || !['utf-8', 'utf-16-le', 'utf-16-be'].includes(draft.encoding)
      || !['', 'utf8', 'utf16le', 'utf16be'].includes(draft.bom) || !['none', 'lf', 'cr', 'crlf', 'mixed'].includes(draft.eol)) {
      throw new DocumentProtocolError('invalid_draft');
    }
    const pending = draft.pendingSave;
    if (pending && (pending.relativePath !== current.identity.relativePath || !/^[\w-]{1,128}$/.test(pending.requestId)
      || !Number.isSafeInteger(pending.bufferRevision) || pending.bufferRevision < 0
      || !Number.isSafeInteger(pending.controlRevision) || pending.controlRevision < 0 || !validDiskVersion(pending.baseVersion)
      || typeof pending.text !== 'string' || pending.text.length > 8 * 1024 * 1024)) throw new DocumentProtocolError('invalid_draft');
    this.put({ ...current, lifecycleId: this.nextId(), text: draft.text, baseText: draft.baseText, revision: Math.max(current.revision, draft.revision),
      dirty: draft.text !== draft.baseText, persistence: 'restored', persistenceError: undefined, editor: undefined,
      read: { ...current.read, text: draft.baseText, version: draft.baseVersion,
        encoding: draft.encoding, bom: draft.bom, eol: draft.eol },
      disk: sameDiskVersion(current.read.version, draft.baseVersion) ? undefined : current.read,
      save: pending ? { request: pending, unknown: true } : undefined });
  }

  merge(key: string, diskVersion: DiskVersion, bufferRevision: number, text: string): void {
    const current = this.get(key), disk = current?.disk;
    if (!current || !disk?.editable || !disk.complete || !disk.version) throw new DocumentProtocolError('document_readonly');
    if (!sameDiskVersion(diskVersion, disk.version) || current.revision !== bufferRevision) throw new DocumentProtocolError('merge_stale');
    if (current.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) throw new DocumentProtocolError('save_needs_reconciliation');
    if (text.length > 8 * 1024 * 1024) throw new DocumentProtocolError('too_large');
    // 仅显式采用新磁盘基线；不保存、不清除尚未核对的写请求，不制造全项目事务。
    this.put({ ...current, read: disk, baseText: disk.text, disk: undefined, text,
      revision: current.revision + Number(text !== current.text), dirty: text !== disk.text, error: undefined });
  }

  async save(client: DocumentClient, key: string): Promise<DocumentSaveReceipt> {
    const current = this.get(key);
    if (client.readonly || !current?.read?.editable || !current.read.canSave || !current.read.version || !current.read.complete) {
      throw new DocumentProtocolError(current?.read?.writeReasonCode || 'document_readonly');
    }
    if (documentKey({ ...current.identity, workspace: client.identity }) !== key) throw new DocumentProtocolError('stale_workspace');
    if (current.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) {
      throw new DocumentProtocolError('save_needs_reconciliation');
    }
    if (current.disk && !sameDiskVersion(current.disk.version, current.read.version)) {
      throw new DocumentProtocolError('disk_conflict');
    }
    const request: DocumentSaveRequest = { requestId: this.nextId(), relativePath: current.identity.relativePath,
      baseVersion: current.read.version, bufferRevision: current.revision,
      controlRevision: current.read.controlRevision, text: current.text };
    this.put({ ...current, save: { request, unknown: false }, error: undefined });
    try {
      const receipt = await client.save(request);
      this.acceptReceipt(key, receipt);
      return receipt;
    } catch (error) {
      const latest = this.get(key);
      if (latest?.save?.request.requestId === request.requestId) {
        // 包括错误回执/超时均保留原请求；只有服务器可核对终态能允许新写。
        this.put({ ...latest, save: { ...latest.save, unknown: true }, error: errorCode(error) });
      }
      throw error;
    }
  }

  async reconcile(client: DocumentClient, key: string): Promise<DocumentSaveReceipt> {
    const current = this.get(key);
    if (!current?.save || documentKey({ ...current.identity, workspace: client.identity }) !== key) {
      throw new DocumentProtocolError('stale_workspace');
    }
    const receipt = await client.saveGet(current.save.request.requestId);
    this.acceptReceipt(key, receipt);
    return receipt;
  }

  private acceptReceipt(key: string, receipt: DocumentSaveReceipt): void {
    const current = this.get(key);
    const pending = current?.save;
    if (!current || !pending || pending.request.requestId !== receipt.requestId) return;
    if (receipt.status !== 'unknown' && (receipt.relativePath !== pending.request.relativePath
        || receipt.bufferRevision !== pending.request.bufferRevision)) throw new DocumentProtocolError('invalid_save_receipt');
    let next = { ...current, save: { ...pending, receipt, unknown: ['unknown', 'unresolved'].includes(receipt.status) } };
    if (receipt.status === 'succeeded' && receipt.version && current.read) {
      next = { ...next, baseText: pending.request.text, dirty: current.text !== pending.request.text,
        read: { ...current.read, text: pending.request.text, version: receipt.version,
          encoding: receipt.encoding || current.read.encoding, bom: receipt.bom ?? current.read.bom, eol: receipt.eol || current.read.eol,
          byteLength: receipt.version.exists ? receipt.version.byteLength : 0,
          readByteLength: receipt.version.exists ? receipt.version.byteLength : 0 }, disk: undefined, error: undefined };
    } else if (receipt.status === 'failed') next.error = receipt.reasonCode || 'save_failed';
    this.put(next);
  }

  async saveAll(client: DocumentClient, keys: string[]): Promise<{ key: string; receipt?: DocumentSaveReceipt; error?: string }[]> {
    const results = [];
    for (const key of [...new Set(keys)]) {
      if (!this.get(key)?.dirty) continue;
      try { results.push({ key, receipt: await this.save(client, key) }); }
      catch (error) { results.push({ key, error: errorCode(error) }); }
    }
    return results;
  }

  close(key: string, discard = false): void {
    const current = this.get(key);
    if (!current) return;
    if (current.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) throw new DocumentProtocolError('save_needs_reconciliation');
    if (current.dirty && !discard) throw new DocumentProtocolError('unsaved_document');
    this.documents.delete(key);
    for (const listener of this.listeners) listener();
  }
}

export const documentStore = new DocumentStore();

// 即使预览组件卸载，内存草稿/未知提交仍需阻止无提示刷新。
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (documentStore.all().some(doc => doc.dirty || doc.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || ''))) {
    event.preventDefault(); event.returnValue = '';
  }
});
