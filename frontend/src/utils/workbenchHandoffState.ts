import { byteHash } from './documentCodec';
import type { WorkspaceIdentity } from './sessionWorkbench';
import { sameWorkspace } from './workspaceDocuments';

export type HandoffPart = 'input' | 'chatScroll' | 'filesEngine' | 'filesChat' | 'layout' | 'documents' | 'resources' | 'stream';
const parts: HandoffPart[] = ['layout', 'documents', 'filesEngine', 'filesChat', 'input', 'resources', 'stream', 'chatScroll'];
export const MAX_HANDOFF_CHARACTERS = 16 * 1024 * 1024;
export interface HandoffState {
  format: 1; workspace: WorkspaceIdentity; clientId: string; sourceWindow: string; targetWindow: string;
  requestId: string; version: number; parts: Partial<Record<HandoffPart, unknown>>;
}
export interface HandoffEnvelope { state: HandoffState; digest: string; payload: string }
export const handoffScope = (user: string, executor: string, session: string, workingDir: string) => JSON.stringify([user, executor, session, workingDir]);

export function handoffEnvelope(input: HandoffState): HandoffEnvelope {
  if (!input || input.format !== 1 || Object.keys(input).some(k => !['format', 'workspace', 'clientId', 'sourceWindow', 'targetWindow', 'requestId', 'version', 'parts'].includes(k))
    || ![input.clientId, input.sourceWindow, input.targetWindow, input.requestId].every(v => typeof v === 'string' && /^[\w-]{1,128}$/.test(v))
    || !Number.isSafeInteger(input.version) || input.version < 0 || !input.parts || typeof input.parts !== 'object'
    || Object.keys(input.parts).some(k => !parts.includes(k as HandoffPart))
    || !input.workspace || Object.keys(input.workspace).sort().join(',') !== 'executorInstance,ownerId,sessionId,workingDir,workspaceRevision'
    || !Object.values(input.workspace).every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096)) throw new Error('交接包格式或身份无效');
  const payload = JSON.stringify(input);
  if (payload.length > MAX_HANDOFF_CHARACTERS) throw new Error('交接状态超过有界容量，请先导出或关闭部分文件；原窗口已保留。');
  return { state: JSON.parse(payload), digest: byteHash(new TextEncoder().encode(payload)), payload };
}
export function readHandoffEnvelope(payload: string, workspace: WorkspaceIdentity, client: string, target: string, digest: string): HandoffEnvelope {
  if (typeof payload !== 'string' || payload.length > MAX_HANDOFF_CHARACTERS) throw new Error('交接包过大');
  const parsed = JSON.parse(payload), envelope = handoffEnvelope(parsed);
  if (!sameWorkspace(workspace, parsed.workspace) || client !== parsed.clientId || target !== parsed.targetWindow || envelope.digest !== digest) throw new Error('交接内容或目标核验失败');
  return envelope;
}

interface Participant { export: () => unknown | Promise<unknown>; import: (value: unknown) => void | Promise<void> }
/** 组件自行白名单导出状态。注册表不会读取 React 内部、DOM 全文或工具授权。 */
export class HandoffParticipants {
  private registrations = new Map<string, Map<HandoffPart, Participant>>();
  private listeners = new Set<() => void>();
  has(scope: string, part: HandoffPart): boolean { return this.registrations.get(scope)?.has(part) === true; }
  register(scope: string, part: HandoffPart, participant: Participant): () => void {
    let registry = this.registrations.get(scope);
    if (!registry) { registry = new Map(); this.registrations.set(scope, registry); }
    if (registry.has(part)) throw new Error(`同一工作台出现重复 ${part} 状态拥有者`);
    registry.set(part, participant); this.listeners.forEach(listener => listener());
    return () => { if (registry!.get(part) === participant) registry!.delete(part); if (!registry!.size) this.registrations.delete(scope); };
  }
  async capture(scope: string): Promise<Partial<Record<HandoffPart, unknown>>> {
    const result: Partial<Record<HandoffPart, unknown>> = {};
    for (const part of parts) {
      const participant = this.registrations.get(scope)?.get(part);
      if (participant) result[part] = await participant.export();
    }
    return result;
  }
  async restore(scope: string, values: Partial<Record<HandoffPart, unknown>>, current: () => boolean): Promise<void> {
    const required = parts.filter(part => Object.prototype.hasOwnProperty.call(values, part));
    for (const part of required) {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => { clearTimeout(timer); this.listeners.delete(check); error ? reject(error) : resolve(); };
      const check = () => {
        if (!current()) finish(new Error('交接目标身份已变化'));
        else if (this.registrations.get(scope)?.has(part)) finish();
      };
      timer = setTimeout(() => finish(new Error('目标组件未就绪，未确认交接；请核对或取消原操作。')), 12000);
      this.listeners.add(check); check();
    });
      if (!current()) throw new Error('交接目标身份已变化');
      const participant = this.registrations.get(scope)?.get(part);
      if (!participant) throw new Error('交接目标组件已卸载');
      await participant.import(values[part]);
    }
    if (!current()) throw new Error('交接目标身份已变化');
  }
}
export const handoffParticipants = new HandoffParticipants();

export interface HandoffJournalRecord {
  key: string; owner: string; client: string; requestId: string; updatedAt: number;
  digest: string; payload: string; state: 'prepared' | 'committed' | 'cancelled';
}
export const handoffJournalKey = (workspace: WorkspaceIdentity, client: string, requestId: string) => JSON.stringify([workspace.ownerId, workspace.workspaceRevision, client, requestId]);

export class HandoffJournal {
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('awu-workbench-handoffs-v1', 1);
      request.onupgradeneeded = () => { const store = request.result.createObjectStore('handoffs', { keyPath: 'key' }); store.createIndex('owner', 'owner'); };
      request.onerror = () => reject(new Error('交接恢复存储不可用；未移动原窗口'));
      request.onblocked = () => reject(new Error('交接恢复存储被其他窗口阻塞'));
      request.onsuccess = () => resolve(request.result);
    });
  }
  async put(envelope: HandoffEnvelope, state: HandoffJournalRecord['state'] = 'prepared'): Promise<void> {
    // 同源 IndexedDB 事务保证并发窗口不会挤掉旧恢复包。配额不足要显式清理，不自动淘汰。
    const db = await this.database();
    try { await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('handoffs', 'readwrite'), store = transaction.objectStore('handoffs');
      const row: HandoffJournalRecord = { key: handoffJournalKey(envelope.state.workspace, envelope.state.clientId, envelope.state.requestId),
        owner: envelope.state.workspace.ownerId, client: envelope.state.clientId, requestId: envelope.state.requestId, digest: envelope.digest,
        payload: envelope.payload, state, updatedAt: Date.now() };
      const existing = store.index('owner').getAll(row.owner);
      existing.onsuccess = () => {
        const others = (existing.result as HandoffJournalRecord[]).filter(item => item.key !== row.key);
        const old = (existing.result as HandoffJournalRecord[]).find(item => item.key === row.key);
        if (others.length >= 8 || others.reduce((n, item) => n + item.payload.length, row.payload.length) > 32 * 1024 * 1024
          || old && old.digest !== row.digest) { transaction.abort(); return; }
        store.put(row);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('交接恢复存储写入失败或配额已满；原状态已保留，请导出并显式清理旧记录。'));
    }); } finally { db.close(); }
  }
  async get(workspace: WorkspaceIdentity, client: string, requestId: string): Promise<HandoffJournalRecord | undefined> {
    const db = await this.database();
    try { return await new Promise((resolve, reject) => {
      const request = db.transaction('handoffs').objectStore('handoffs').get(handoffJournalKey(workspace, client, requestId));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  }
  async list(owner: string): Promise<HandoffJournalRecord[]> {
    const db = await this.database();
    try { return await new Promise((resolve, reject) => {
      const request = db.transaction('handoffs').objectStore('handoffs').index('owner').getAll(owner);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  }
  async remove(record: HandoffJournalRecord, owner: string): Promise<void> {
    if (record.owner !== owner) throw new Error('不能清理其他用户的恢复记录');
    const db = await this.database();
    try { await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('handoffs', 'readwrite'), store = transaction.objectStore('handoffs'), request = store.get(record.key);
      request.onsuccess = () => {
        if (request.result && (request.result.owner !== owner || request.result.digest !== record.digest || request.result.updatedAt !== record.updatedAt)) transaction.abort();
        else store.delete(record.key);
      };
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('恢复记录已变化，请重新核对后清理'));
    }); } finally { db.close(); }
  }
}
export const handoffJournal = new HandoffJournal();
