import type { LocalJournalStore, LocalSaveJournal } from './localDocuments';
import { DocumentProtocolError } from './workspaceDocuments';
import { uuid } from './uuid';

const DB = 'awu-local-document-safety-v1';
const RECEIPTS = 'receipts', HANDLES = 'handles';
const terminal = (job: LocalSaveJournal) => ['succeeded', 'failed'].includes(job.receipt.status);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const receipts = request.result.createObjectStore(RECEIPTS, { keyPath: 'key' });
      receipts.createIndex('documentKey', 'documentKey');
      request.result.createObjectStore(HANDLES, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new DocumentProtocolError('local_storage_unavailable'));
    request.onblocked = () => reject(new DocumentProtocolError('local_storage_blocked'));
  });
}

async function transaction<T>(store: string, mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let value: T;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new DocumentProtocolError('local_storage_unavailable')); };
    try { run(tx.objectStore(store), result => { value = result; }); }
    catch (error) { tx.abort(); db.close(); reject(error); }
  });
}

/** 保存串行化范围为本站所有本机副本，避免跨 Session/根目录别名绕过请求登记。 */
export async function withLocalDocumentLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) throw new DocumentProtocolError('local_lock_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try { return await navigator.locks.request('awu-local-document-writes-v1', { signal: controller.signal }, async () => {
    clearTimeout(timer);
    return operation();
  }); } finally { clearTimeout(timer); }
}

export class IndexedLocalJournal implements LocalJournalStore {
  claim(value: LocalSaveJournal): Promise<LocalSaveJournal> {
    return transaction(RECEIPTS, 'readwrite', (store, result) => {
      const previous = store.get(value.key);
      previous.onsuccess = () => {
        if (previous.result) { result(previous.result); return; }
        const pending = store.index('documentKey').getAll(value.documentKey);
        pending.onsuccess = () => {
          let claimed = value;
          if (!terminal(value) && pending.result.some((job: LocalSaveJournal) => !terminal(job))) {
            claimed = { ...value, commitId: '', receipt: { ...value.receipt, status: 'failed', reasonCode: 'save_needs_reconciliation' } };
          }
          const count = store.count(); count.onsuccess = () => {
            if (count.result >= 4096) { store.transaction.abort(); return; }
            store.add(claimed); result(claimed);
          };
        };
      };
    });
  }
  get(key: string): Promise<LocalSaveJournal | undefined> {
    return transaction(RECEIPTS, 'readonly', (store, result) => {
      const req = store.get(key); req.onsuccess = () => result(req.result);
    });
  }
  pending(documentKey: string): Promise<LocalSaveJournal | undefined> {
    return transaction(RECEIPTS, 'readonly', (store, result) => {
      const req = store.index('documentKey').getAll(documentKey);
      req.onsuccess = () => result(req.result.find((job: LocalSaveJournal) => !terminal(job)));
    });
  }
  put(value: LocalSaveJournal): Promise<void> {
    return transaction(RECEIPTS, 'readwrite', (store, result) => {
      const req = store.get(value.key);
      req.onsuccess = () => {
        if (req.result && (req.result.digest !== value.digest || terminal(req.result) && !terminal(value))) {
          store.transaction.abort(); return;
        }
        const all = store.getAll();
        all.onsuccess = () => {
          // 不自动删回执后重新接收旧 ID；容量耗尽先拒绝新写，不能失去幂等记录。
          const rows = all.result as LocalSaveJournal[];
          if (!req.result && rows.length >= 4096) { store.transaction.abort(); return; }
          store.put(value); result(undefined);
        };
      };
    });
  }
}

/** 目录/文件句柄凭 isSameEntry 登记；名称、路径字符串都不是浏览器文件身份。 */
export async function browserHandleBinding(handle: FileSystemHandle): Promise<string> {
  if (!globalThis.navigator?.locks) throw new DocumentProtocolError('local_lock_unavailable');
  return navigator.locks.request('awu-local-document-handles-v1', async () => {
    const rows = await transaction<{ id: string; handle: FileSystemHandle }[]>(HANDLES, 'readonly', (store, result) => {
      const request = store.getAll(); request.onsuccess = () => result(request.result);
    });
    for (const row of rows) if (row.handle.kind === handle.kind) {
      try { if (await handle.isSameEntry(row.handle)) return row.id; }
      catch { /* 不可用的旧句柄不可与新文件合并，也不删除其未确认回执。 */ }
    }
    if (rows.length >= 4096) throw new DocumentProtocolError('local_binding_limit');
    const id = `browser:${uuid()}`;
    await transaction<void>(HANDLES, 'readwrite', (store, result) => {
      store.add({ id, handle }); result(undefined);
    });
    return id;
  });
}
