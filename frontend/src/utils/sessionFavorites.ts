import { uuid } from './uuid';

export interface FavoriteTarget { scope: string; node: string; session: string }
/** 不接收凭据；只有调用方已验证的物理别名才可归一为 local。 */
export function favoriteIdentityTarget(identity: {
  mode: 'local' | 'relay'; origin: string; relayUrl?: string; userId?: string; deviceId?: string; verifiedLocalAlias?: boolean;
}, session: string): FavoriteTarget {
  const mode = identity.verifiedLocalAlias ? 'local' : identity.mode;
  const address = new URL(identity.relayUrl || identity.origin);
  const realm = `${address.protocol}//${address.host}${address.pathname.replace(/\/$/, '')}`;
  const user = identity.userId || (identity.mode === 'local' ? 'local' : 'legacy');
  const node = mode === 'local' ? 'local' : identity.deviceId;
  if (!node) throw new Error('收藏执行节点未知');
  return { scope: JSON.stringify([mode, realm, user]), node, session };
}
export type FavoritePhase = 'pending' | 'unknown' | 'conflict' | 'unsupported' | 'blocked';
export interface FavoriteRow extends FavoriteTarget {
  key: string; generation: number; requestId: string; pinned: boolean;
  baseRevision: number | null; phase: FavoritePhase; message?: string;
}
export interface FavoriteRemote { pinned: boolean; favoriteRevision: number; lastRequestId?: string }
export const favoriteKey = (target: FavoriteTarget): string => JSON.stringify([target.scope, target.node, target.session]);
export const favoriteRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function mergeFavoriteRemote(current: any, incoming: any): any {
  if (favoriteRevision(current?.favoriteRevision)
      && (!favoriteRevision(incoming?.favoriteRevision) || incoming.favoriteRevision < current.favoriteRevision)) {
    return { ...incoming, pinned: current.pinned, favoriteRevision: current.favoriteRevision };
  }
  return incoming;
}
export function validateFavoriteRow(row: FavoriteRow): void {
  if (!row || row.key !== favoriteKey(row) || !row.scope || !row.node || !row.session
      || typeof row.pinned !== 'boolean' || !Number.isSafeInteger(row.generation) || row.generation < 1
      || !row.requestId || !(row.baseRevision === null || favoriteRevision(row.baseRevision))
      || !['pending', 'unknown', 'conflict', 'unsupported', 'blocked'].includes(row.phase)) throw new Error('收藏记录无效');
  if (new TextEncoder().encode(JSON.stringify(row)).length > 2048) throw new Error('收藏记录超过 2 KiB 上限');
}
export interface FavoriteRepository {
  all(): Promise<FavoriteRow[]>;
  edit(key: string, change: (row: FavoriteRow | null) => FavoriteRow | null): Promise<FavoriteRow | null>;
  clear(scopes?: readonly string[]): Promise<void>;
}

/** 同 origin 多窗口事务串行化；不使用整表 localStorage 读改写。 */
export class IndexedFavoriteRepository implements FavoriteRepository {
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('本设备收藏存储不可用')); return; }
      const request = indexedDB.open('awu-session-favorites-v1', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('choices', { keyPath: 'key' });
        store.createIndex('scope', 'scope');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开收藏存储'));
      request.onblocked = () => reject(new Error('收藏存储被其它窗口阻塞'));
    }).catch(error => { this.database = undefined; throw error; });
    return this.database;
  }
  async all(): Promise<FavoriteRow[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('choices', 'readonly');
      const request = transaction.objectStore('choices').getAll();
      request.onsuccess = () => {
        try { request.result.forEach(validateFavoriteRow); resolve(request.result); }
        catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error);
    });
  }
  async edit(key: string, change: (row: FavoriteRow | null) => FavoriteRow | null): Promise<FavoriteRow | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('choices', 'readwrite'), store = transaction.objectStore('choices');
      let result: FavoriteRow | null = null, error: unknown;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(error || transaction.error || new Error('收藏未能保存'));
      const read = store.get(key);
      read.onsuccess = () => {
        try {
          result = change(read.result || null);
          if (!result) { store.delete(key); return; }
          validateFavoriteRow(result);
          if (result.key !== key) throw new Error('收藏身份不匹配');
          const count = store.index('scope').count(result.scope);
          count.onsuccess = () => {
            if (!read.result && count.result >= 2000) { error = new Error('待同步收藏已达 2000 条，请先处理已有记录'); transaction.abort(); }
            else store.put(result);
          };
        } catch (reason) { error = reason; transaction.abort(); }
      };
    });
  }
  async clear(scopes?: readonly string[]): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('choices', 'readwrite');
      const store = transaction.objectStore('choices');
      if (!scopes) store.clear();
      else for (const scope of scopes) {
        const request = store.index('scope').openCursor(IDBKeyRange.only(scope));
        request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  }
}

interface FavoriteIO {
  available(target: FavoriteTarget): 'online' | 'offline' | 'removed' | 'unsupported' | 'inactive';
  call(target: FavoriteTarget, method: string, params: any[]): Promise<any>;
  remote(target: FavoriteTarget, value: FavoriteRemote): void;
  changed(): void;
  broadcast?(): void;
}

/** 仅协调用户明确选择的收藏，不承载删除、执行或其它 RPC 队列。 */
export class SessionFavorites {
  private rows = new Map<string, FavoriteRow>();
  private epoch = 0;
  private viewRevision = 0;
  private loading: Promise<void> = Promise.resolve();
  private reloadJob?: Promise<void>;
  private reloadAgain = false;
  private jobs = new Map<string, Promise<void>>();
  private active = new Map<string, number>();
  private waiting = new Map<string, FavoriteTarget>();
  constructor(private repository: FavoriteRepository, private io: FavoriteIO) {}
  reload(): Promise<void> {
    if (this.reloadJob) { this.reloadAgain = true; return this.reloadJob; }
    const epoch = this.epoch;
    this.reloadJob = (async () => {
      do {
        this.reloadAgain = false;
        const revision = this.viewRevision;
        await this.loading;
        const rows = await this.repository.all();
        if (epoch !== this.epoch) return;
        if (revision !== this.viewRevision) { this.reloadAgain = true; continue; }
        this.rows = new Map(rows.map(row => [row.key, row]));
        this.io.changed();
      } while (this.reloadAgain);
    })().finally(() => { this.reloadJob = undefined; });
    return this.reloadJob;
  }
  get(target: FavoriteTarget): FavoriteRow | undefined { return this.rows.get(favoriteKey(target)); }
  project(target: FavoriteTarget, remote: any): any {
    const row = this.get(target);
    return { ...remote, ...(row ? { pinned: row.pinned, favoriteStatus: row.phase, favoriteMessage: row.message || '' }
      : { favoriteStatus: undefined, favoriteMessage: undefined }) };
  }
  private async edit(target: FavoriteTarget, change: (row: FavoriteRow | null) => FavoriteRow | null): Promise<FavoriteRow | null> {
    const epoch = this.epoch, key = favoriteKey(target);
    await this.loading;
    if (epoch !== this.epoch) throw new Error('收藏身份已变化');
    let changed = false;
    const row = await this.repository.edit(key, current => {
      if (epoch !== this.epoch) throw new Error('收藏身份已变化');
      const next = change(current);
      changed = JSON.stringify(next) !== JSON.stringify(current);
      return next;
    });
    if (epoch !== this.epoch) return null;
    ++this.viewRevision;
    row ? this.rows.set(key, row) : this.rows.delete(key);
    this.io.changed(); if (changed) this.io.broadcast?.();
    return row;
  }
  async choose(target: FavoriteTarget, pinned: boolean, observedRevision: unknown): Promise<void> {
    if (typeof pinned !== 'boolean') throw new Error('收藏值无效');
    await this.edit(target, old => ({ ...target, key: favoriteKey(target), generation: (old?.generation || 0) + 1,
      requestId: uuid(), pinned, baseRevision: old?.baseRevision ?? (favoriteRevision(observedRevision) ? observedRevision : null), phase: 'pending' }));
    void this.sync(target);
  }
  async forget(target: FavoriteTarget): Promise<void> { await this.edit(target, () => null); }
  invalidate(scopes?: readonly string[]): void {
    ++this.epoch; ++this.viewRevision;
    if (!scopes) this.rows.clear();
    else for (const [key, row] of this.rows) if (scopes.includes(row.scope)) this.rows.delete(key);
    this.waiting.clear(); this.io.changed();
  }
  clear(scopes?: readonly string[]): Promise<void> {
    this.invalidate(scopes);
    // 身份清理先行，新身份写入等待此事务完成；旧回调有 epoch 栅栏。
    this.loading = this.loading.catch(() => {}).then(() => this.repository.clear(scopes));
    return this.loading;
  }
  reconnect(): void {
    for (const row of this.rows.values()) {
      if (['pending', 'unknown'].includes(row.phase) && this.io.available(row) === 'online') void this.sync(row);
      else if (this.io.available(row) === 'removed') void this.mark(row, 'blocked', '节点已移除，未同步').catch(() => {});
    }
  }
  private async mark(row: FavoriteRow, phase: FavoritePhase, message: string): Promise<void> {
    await this.edit(row, current => current?.requestId === row.requestId ? { ...current, phase, message: message.slice(0, 200) } : current);
  }
  async resolve(target: FavoriteTarget, choice: 'local' | 'remote'): Promise<void> {
    const epoch = this.epoch, row = this.get(target);
    if (!row) return;
    if (this.io.available(target) !== 'online') throw new Error('所属节点离线，暂不能核对冲突');
    const raw = await this.io.call(target, 'sessionFavoriteGet', [target.session]);
    if (epoch !== this.epoch) return;
    const remote = this.parse(raw);
    if (!remote || raw.status !== 'ok') throw new Error(raw?.message || '无法核对远端收藏');
    this.io.remote(target, remote);
    await this.edit(target, current => {
      if (current?.requestId !== row.requestId) return current;
      return choice === 'remote' ? null : { ...current, requestId: uuid(), generation: current.generation + 1,
        baseRevision: remote.favoriteRevision, phase: 'pending', message: undefined };
    });
    if (choice === 'local') await this.sync(target);
  }
  private parse(value: any): FavoriteRemote | null {
    return value?.protocolVersion === 1 && typeof value.pinned === 'boolean' && favoriteRevision(value.favoriteRevision)
      ? { pinned: value.pinned, favoriteRevision: value.favoriteRevision, lastRequestId: value.lastRequestId } : null;
  }
  sync(target: FavoriteTarget): Promise<void> {
    const key = favoriteKey(target), node = JSON.stringify([target.scope, target.node]);
    const job = this.jobs.get(key);
    if (job) { this.waiting.set(key, target); return job; }
    if ((this.active.get(node) || 0) >= 2) { this.waiting.set(key, target); return Promise.resolve(); }
    this.active.set(node, (this.active.get(node) || 0) + 1);
    const work = this.coordinate(target).catch(() => { /* 本设备保存失败不伪装远端成功。 */ }).finally(() => {
      this.jobs.delete(key); this.active.set(node, (this.active.get(node) || 1) - 1);
      for (const [nextKey, next] of [...this.waiting]) {
        if (this.jobs.has(nextKey)) continue;
        const nextNode = JSON.stringify([next.scope, next.node]);
        if ((this.active.get(nextNode) || 0) >= 2) continue;
        this.waiting.delete(nextKey); void this.sync(next);
      }
    });
    this.jobs.set(key, work); return work;
  }
  private async coordinate(target: FavoriteTarget): Promise<void> {
    const epoch = this.epoch;
    // 另一窗口可能已提交新代际而广播尚未到达，先从事务仓库核对。
    const row = await this.edit(target, current => current);
    if (epoch !== this.epoch) return;
    if (!row) return;
    const availability = this.io.available(target);
    if (availability === 'offline' || availability === 'inactive') return;
    if (availability !== 'online') { await this.mark(row, availability === 'unsupported' ? 'unsupported' : 'blocked',
      availability === 'unsupported' ? '本设备已保存；当前身份不支持自动同步' : '节点已移除，未同步'); return; }
    let submitting = false;
    try {
      const raw = await this.io.call(target, 'sessionFavoriteGet', [target.session]);
      if (epoch !== this.epoch) return;
      if (raw?.status === 'not_found') { await this.forget(target); return; }
      const remote = this.parse(raw);
      if (!remote || raw.status !== 'ok') {
        await this.mark(row, raw == null ? 'unsupported' : 'blocked', raw?.message || '本设备已保存；执行端尚不支持安全收藏同步'); return;
      }
      this.io.remote(target, remote);
      const latest = await this.edit(target, current => current);
      if (epoch !== this.epoch || latest?.requestId !== row.requestId) return;
      if (remote.pinned === row.pinned) { await this.edit(target, current => current?.requestId === row.requestId ? null : current); return; }
      if (remote.favoriteRevision !== row.baseRevision) { await this.mark(row, 'conflict', '远端收藏已变化，请选择采用哪一边'); return; }
      submitting = true;
      const result = await this.io.call(target, 'sessionFavoriteSet', [target.session, JSON.stringify({
        pinned: row.pinned, expectedRevision: row.baseRevision, requestId: row.requestId,
      })]);
      if (epoch !== this.epoch) return;
      const saved = this.parse(result);
      if (result?.status === 'ok' && saved && saved.pinned === row.pinned) {
        this.io.remote(target, saved);
        await this.edit(target, current => {
          if (!current || current.requestId === row.requestId) return null;
          // 只推进本窗口已知在途写的后继基线，不改变新选择。
          return current.baseRevision === row.baseRevision ? { ...current, baseRevision: saved.favoriteRevision } : current;
        });
      } else if (result?.status === 'conflict') await this.mark(row, 'conflict', '远端收藏已变化，请核对');
      else if (result?.status === 'not_found') await this.forget(target);
      else await this.mark(row, result?.status === 'error' ? 'blocked' : 'unknown', result?.message || '收藏同步结果未知，请只读核对');
    } catch (error) {
      if (epoch !== this.epoch) return;
      const failure = error as { serverRejected?: boolean; notSubmitted?: boolean };
      await this.mark(row, failure.serverRejected ? 'blocked' : submitting && !failure.notSubmitted ? 'unknown' : 'pending',
        error instanceof Error ? error.message : '收藏同步失败');
    }
  }
}
