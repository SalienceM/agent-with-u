import { documentKey, documentStore, type DocumentBuffer, type DocumentClient, type DocumentStore, type RecoverableDraft } from './documentStore';
import { uuid } from './uuid';
import type { EditorDocumentState, SerializedEditorDocument } from './editorDocumentState';
import { DocumentProtocolError } from './workspaceDocuments';

export interface StoredDocumentDraft {
  id: string; documentKey: string; ownerId: string; branch: string; updatedAt: number; payload: string;
}
export interface DraftRepository {
  list(documentKey: string, ownerId: string): Promise<StoredDocumentDraft[]>;
  listOwner(ownerId: string): Promise<StoredDocumentDraft[]>;
  put(record: StoredDocumentDraft): Promise<void>;
  remove(id: string, ownerId: string): Promise<void>;
  removeRecord(record: StoredDocumentDraft): Promise<void>;
}
const MAX_PAYLOAD = 32 * 1024 * 1024, OWNER_BUDGET = 64 * 1024 * 1024;

async function transaction<T>(mode: IDBTransactionMode,
  action: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('awu-document-drafts-v1', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('drafts', { keyPath: 'id' });
      store.createIndex('documentKey', 'documentKey'); store.createIndex('ownerId', 'ownerId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new DocumentProtocolError('draft_storage_unavailable'));
  });
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('drafts', mode); let value: T;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = () => { db.close(); reject(new DocumentProtocolError('draft_storage_unavailable_or_full')); };
    try { action(tx.objectStore('drafts'), result => { value = result; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

export class IndexedDraftRepository implements DraftRepository {
  listOwner(owner: string): Promise<StoredDocumentDraft[]> {
    return transaction('readonly', (store, result) => {
      const rows: StoredDocumentDraft[] = []; let size = 0;
      const request = store.index('ownerId').openCursor(IDBKeyRange.only(owner));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { result(rows); return; }
        const row = cursor.value as StoredDocumentDraft;
        size += typeof row.payload === 'string' ? row.payload.length : MAX_PAYLOAD + 1;
        if (rows.length >= 64 || size > OWNER_BUDGET || typeof row.payload !== 'string' || row.payload.length > MAX_PAYLOAD
          || ![row.id, row.documentKey, row.branch].every(value => typeof value === 'string' && value.length <= 32768)) {
          store.transaction.abort(); return;
        }
        rows.push(row); cursor.continue();
      };
    });
  }
  list(key: string, owner: string): Promise<StoredDocumentDraft[]> {
    return transaction('readonly', (store, result) => {
      const request = store.index('documentKey').getAll(key);
      request.onsuccess = () => result(request.result.filter((record: StoredDocumentDraft) => record.ownerId === owner));
    });
  }
  put(record: StoredDocumentDraft): Promise<void> {
    if (record.payload.length > MAX_PAYLOAD) return Promise.reject(new DocumentProtocolError('draft_too_large'));
    return transaction('readwrite', (store, result) => {
      const request = store.index('ownerId').getAll(record.ownerId);
      request.onsuccess = () => {
        const others = (request.result as StoredDocumentDraft[]).filter(row => row.id !== record.id);
        if (others.length >= 64 || others.reduce((n, row) => n + row.payload.length, record.payload.length) > OWNER_BUDGET) {
          store.transaction.abort(); return;
        }
        // 按窗口分支保存，不能用另一窗口的草稿覆盖同一个记录。
        store.put(record); result(undefined);
      };
    });
  }
  remove(id: string, owner: string): Promise<void> {
    return transaction('readwrite', (store, result) => {
      const request = store.get(id); request.onsuccess = () => {
        if (request.result?.ownerId === owner) store.delete(id); result(undefined);
      };
    });
  }
  removeRecord(record: StoredDocumentDraft): Promise<void> {
    return transaction('readwrite', (store, result) => {
      const request = store.get(record.id); request.onsuccess = () => {
        const current = request.result as StoredDocumentDraft | undefined;
        // 列出后若另一窗口更新过，只能重新检查，不能删除新版本。
        if (current && (current.ownerId !== record.ownerId || current.documentKey !== record.documentKey
          || current.payload !== record.payload || current.updatedAt !== record.updatedAt)) {
          store.transaction.abort(); return;
        }
        if (current) store.delete(record.id);
        result(undefined);
      };
    });
  }
}

/** 离线查看/导出不将旧执行端实例重新绑定到当前写目标。损坏记录仍可原样导出。 */
export function inspectStoredDraft(record: StoredDocumentDraft, owner: string): { text: string; filename: string; pending: boolean; valid: boolean } {
  if (record.ownerId !== owner || typeof record.payload !== 'string' || record.payload.length > MAX_PAYLOAD) {
    throw new DocumentProtocolError('invalid_draft');
  }
  try {
    const draft = JSON.parse(record.payload) as RecoverableDraft;
    if (draft.format !== 1 || draft.identity.workspace.ownerId !== owner || documentKey(draft.identity) !== record.documentKey
      || typeof draft.text !== 'string' || draft.text.length > 8 * 1024 * 1024) throw new Error('invalid');
    return { text: draft.text, filename: `${draft.identity.relativePath.split('/').pop()}.draft.txt`, pending: !!draft.pendingSave, valid: true };
  } catch { return { text: record.payload, filename: 'unreadable-draft.json', pending: false, valid: false }; }
}

function branchId(): string {
  try {
    const key = 'awu-document-draft-branch-v1', old = sessionStorage.getItem(key);
    // window.open 会复制 sessionStorage；新导航必须新建分支，刷新才复用。
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.type === 'reload' && old && /^[\w-]{1,128}$/.test(old)) return old;
    const value = uuid(); sessionStorage.setItem(key, value); return value;
  } catch { return uuid(); }
}
const pendingSave = (doc: Readonly<DocumentBuffer>) => doc.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || '');
const sameContent = (a: Readonly<DocumentBuffer> | undefined, b: Readonly<DocumentBuffer>) => a
  && a.lifecycleId === b.lifecycleId && a.revision === b.revision && a.text === b.text && a.baseText === b.baseText
  && a.read === b.read && a.save === b.save && a.editor === b.editor;

/** 有界、按身份/窗口分支隔离的草稿。所有恢复只改缓冲区，不调用磁盘保存。 */
export class DocumentDrafts {
  private observed = new Map<string, Readonly<DocumentBuffer>>();
  private suspended = new Set<string>();
  private invalid = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queues = new Map<string, Promise<void>>();
  private openings = new Map<string, Promise<{ document: Readonly<DocumentBuffer>; choices: StoredDocumentDraft[] }>>();
  constructor(private store: DocumentStore, private repository: DraftRepository = new IndexedDraftRepository(),
    readonly branch = branchId(), private delay = 300) { store.subscribe(() => this.changed()); }
  private id(key: string): string { return JSON.stringify([key, this.branch]); }
  private changed(): void {
    for (const key of this.observed.keys()) {
      if (this.store.get(key)) continue;
      clearTimeout(this.timers.get(key)); this.timers.delete(key); this.observed.delete(key); this.invalid.delete(key);
    }
    for (const doc of this.store.all()) {
      if (this.suspended.has(doc.key) || this.invalid.has(doc.key) || !doc.read || sameContent(this.observed.get(doc.key), doc)) continue;
      this.observed.set(doc.key, doc);
      clearTimeout(this.timers.get(doc.key));
      if (doc.dirty || pendingSave(doc)) this.store.persistence(doc.key, 'pending');
      this.timers.set(doc.key, setTimeout(() => { this.timers.delete(doc.key); void this.persist(doc); }, this.delay));
    }
  }
  private persist(doc: Readonly<DocumentBuffer>): Promise<void> {
    const previous = this.queues.get(doc.key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.store.get(doc.key)?.lifecycleId !== doc.lifecycleId) return;
      try {
        if (!doc.dirty && !pendingSave(doc)) await this.repository.remove(this.id(doc.key), doc.identity.workspace.ownerId);
        else {
          const editor = doc.editor as EditorDocumentState | undefined;
          const draft: RecoverableDraft = { format: 1, identity: doc.identity, text: doc.text, baseText: doc.baseText,
            revision: doc.revision, baseVersion: doc.read!.version!, encoding: doc.read!.encoding, bom: doc.read!.bom,
            eol: doc.read!.eol, pendingSave: pendingSave(doc) ? doc.save!.request : undefined };
          if (editor && editor.state.doc.toString() === doc.text) {
            const { serializeEditorDocument } = await import('./editorDocumentState');
            draft.editor = serializeEditorDocument(editor);
          }
          const payload = JSON.stringify(draft);
          if (payload.length > MAX_PAYLOAD) throw new DocumentProtocolError('draft_too_large');
          await this.repository.put({ id: this.id(doc.key), documentKey: doc.key, branch: this.branch,
            ownerId: doc.identity.workspace.ownerId, updatedAt: Date.now(), payload });
        }
        if (sameContent(this.store.get(doc.key), doc)) this.store.persistence(doc.key, 'saved');
      } catch (error) {
        if (sameContent(this.store.get(doc.key), doc)) this.store.persistence(doc.key, 'failed',
          error instanceof DocumentProtocolError ? error.reasonCode : 'draft_storage_unavailable');
      }
    });
    this.queues.set(doc.key, next);
    void next.finally(() => { if (this.queues.get(doc.key) === next) this.queues.delete(doc.key); });
    return next;
  }
  async flush(key: string): Promise<void> {
    if (this.invalid.has(key)) throw new DocumentProtocolError('draft_invalid');
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    const doc = this.store.get(key); if (doc?.read) await this.persist(doc);
  }
  async open(client: DocumentClient, relative: string): Promise<{ document: Readonly<DocumentBuffer>; choices: StoredDocumentDraft[] }> {
    const key = documentKey({ workspace: client.identity, relativePath: relative, source: client.source || 'executor' });
    const opening = this.openings.get(key); if (opening) return opening;
    const operation = this.openDocument(client, relative, key);
    this.openings.set(key, operation);
    try { return await operation; } finally { if (this.openings.get(key) === operation) this.openings.delete(key); }
  }
  private async openDocument(client: DocumentClient, relative: string, key: string): Promise<{ document: Readonly<DocumentBuffer>; choices: StoredDocumentDraft[] }> {
    if (this.store.get(key)) return { document: await this.store.open(client, relative), choices: [] };
    this.suspended.add(key);
    try {
      let records: StoredDocumentDraft[] = [], unavailable = false;
      try { records = await this.repository.list(key, client.identity.ownerId); } catch { unavailable = true; }
      await this.store.open(client, relative);
      if (unavailable) this.store.persistence(key, 'failed', 'draft_storage_unavailable');
      const own = records.find(row => row.branch === this.branch);
      const choice = own || (records.length === 1 ? records[0] : undefined);
      if (choice) {
        try { await this.restore(key, choice); }
        catch { this.invalid.add(key); this.store.persistence(key, 'failed', 'draft_invalid'); }
      }
      return { document: this.store.get(key)!, choices: choice && !this.invalid.has(key) ? [] : records };
    } finally { this.suspended.delete(key); this.changed(); }
  }
  async restore(key: string, record: StoredDocumentDraft, isCurrent: () => boolean = () => true): Promise<void> {
    const doc = this.store.get(key);
    if (!doc || doc.identity.workspace.ownerId !== record.ownerId || record.documentKey !== key || record.payload.length > MAX_PAYLOAD) {
      throw new DocumentProtocolError('invalid_draft');
    }
    const draft = JSON.parse(record.payload) as RecoverableDraft;
    let editor: EditorDocumentState | undefined, historyFailed = false;
    if (draft.editor) {
      try {
        const { restoreEditorDocument } = await import('./editorDocumentState');
        const { history } = await import('@codemirror/commands');
        editor = restoreEditorDocument(draft.editor as SerializedEditorDocument, [history()]);
        if (editor.state.doc.toString() !== draft.text) throw new Error('history_mismatch');
      } catch { editor = undefined; historyFailed = true; }
    }
    if (!isCurrent() || !sameContent(this.store.get(key), doc)) throw new DocumentProtocolError('draft_changed');
    this.store.restore(key, draft);
    this.invalid.delete(key);
    if (editor) this.store.editorState(key, editor);
    if (historyFailed) this.store.persistence(key, 'failed', 'draft_history_unavailable');
  }
  listOwner(owner: string): Promise<StoredDocumentDraft[]> { return this.repository.listOwner(owner); }
  async removeStored(record: StoredDocumentDraft, owner: string, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent() || record.ownerId !== owner) throw new DocumentProtocolError('stale_workspace');
    if (inspectStoredDraft(record, owner).pending) throw new DocumentProtocolError('save_needs_reconciliation');
    const doc = this.store.get(record.documentKey);
    if (record.branch === this.branch && doc && (doc.dirty || pendingSave(doc))) throw new DocumentProtocolError('draft_open_in_editor');
    await this.repository.removeRecord(record);
    if (record.branch === this.branch) this.invalid.delete(record.documentKey);
  }
  async discard(key: string): Promise<void> {
    const doc = this.store.get(key); if (!doc) return;
    if (pendingSave(doc)) throw new DocumentProtocolError('save_needs_reconciliation');
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    await this.queues.get(key);
    if (!sameContent(this.store.get(key), doc)) throw new DocumentProtocolError('draft_changed');
    await this.repository.remove(this.id(key), doc.identity.workspace.ownerId);
    if (!sameContent(this.store.get(key), doc)) { await this.flush(key); throw new DocumentProtocolError('draft_changed'); }
    this.invalid.delete(key); this.observed.delete(key); this.store.close(key, true);
  }
}

export const documentDrafts = new DocumentDrafts(documentStore);
