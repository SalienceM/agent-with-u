import type { DiskVersion, WorkspaceIdentity } from './sessionWorkbench';

/** 审阅不继承旧 localId::workingDir 基线；身份必须来自能力响应/实际副本。 */
export interface ReviewScope {
  workspace: WorkspaceIdentity;
  execKey: string;
  bindingId: string;
  includeGitMetadata: boolean;
}
export interface ReviewMeta { hash: string; size: number; mtime?: number; kind?: 'file' | 'directory' }
export type ReviewManifest = Readonly<Record<string, Readonly<ReviewMeta>>>;
export interface CompareSnapshot {
  readonly scope: Readonly<ReviewScope>;
  readonly revision: number;
  readonly comparedAt: number;
  readonly local: ReviewManifest;
  readonly remote: ReviewManifest;
  readonly baseline: ReviewManifest;
}
export type ReviewStatus = 'pending' | 'skipped' | 'stale' | 'transferring' | 'pushed' | 'pulled' | 'failed' | 'unresolved';
export interface ReviewEntry { path: string; conflict: boolean; typeConflict: boolean; status: ReviewStatus; reason?: string }
export interface ReviewQueue { readonly entries: readonly ReviewEntry[]; readonly selected: string | null }
export interface ReviewSide {
  kind: 'file' | 'missing' | 'directory' | 'unavailable';
  version: DiskVersion | null;
  bytes?: Uint8Array;
  reasonCode?: string;
  readonly?: boolean;
}
export interface ReviewPair {
  readonly scopeKey: string;
  readonly compareRevision: number;
  readonly readRevision: number;
  readonly path: string;
  readonly local: ReviewSide;
  readonly remote: ReviewSide;
}
export const REVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const REVIEW_MAX_LINES = 20_000;
export const REVIEW_MAX_LINE_LENGTH = 64 * 1024;
export const REVIEW_PAGE_SIZE = 100;
export function reviewScopeKey(scope: ReviewScope): string {
  const w = scope.workspace;
  return JSON.stringify([w.ownerId, scope.execKey, w.sessionId, w.executorInstance,
    w.workspaceRevision, w.workingDir, scope.bindingId, scope.includeGitMetadata]);
}
export function reviewBaselineKey(scope: ReviewScope): string {
  const w = scope.workspace;
  return `awu-sync-review-v1:${JSON.stringify([w.ownerId, scope.execKey, w.sessionId,
    w.workingDir, scope.bindingId, scope.includeGitMetadata])}`;
}
interface BaselineStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function loadReviewBaseline(scope: ReviewScope, storage: Pick<BaselineStorage, 'getItem'>): ReviewManifest {
  try {
    const value = JSON.parse(storage.getItem(reviewBaselineKey(scope)) || 'null');
    if (value?.protocol !== 1 || value.scopeKey !== reviewScopeKey(scope) || !value.files || typeof value.files !== 'object') return {};
    const files: Record<string, ReviewMeta> = Object.create(null);
    for (const [path, item] of Object.entries(value.files)) {
      const meta = item as ReviewMeta;
      if (validReviewPath(path) && /^[a-f0-9]{64}$/.test(meta?.hash) && Number.isSafeInteger(meta.size) && meta.size >= 0) {
        files[path] = Object.freeze({ hash: meta.hash, size: meta.size });
      }
    }
    return Object.freeze(files);
  } catch { return {}; }
}
/** 调用方必须先取得成功回执并复核两端一致；只增量写该路径，不搬运旧清单。 */
export function saveReviewBaseline(scope: ReviewScope, path: string, local: DiskVersion, remote: DiskVersion,
  storage: BaselineStorage): boolean {
  if (!validReviewPath(path) || !local.exists || !remote.exists || local.sha256 !== remote.sha256
    || local.byteLength !== remote.byteLength) return false;
  try {
    const files = { ...loadReviewBaseline(scope, storage), [path]: { hash: local.sha256, size: local.byteLength } };
    storage.setItem(reviewBaselineKey(scope), JSON.stringify({ protocol: 1, scopeKey: reviewScopeKey(scope), files }));
    return true;
  } catch { return false; }
}
export function validReviewPath(path: string): boolean {
  return !!path && !/[\\:\0]/.test(path) && !path.startsWith('/')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function freezeManifest(input: ReviewManifest): ReviewManifest {
  const output: Record<string, Readonly<ReviewMeta>> = Object.create(null);
  for (const [path, meta] of Object.entries(input)) {
    if (validReviewPath(path)) output[path] = Object.freeze({ ...meta });
  }
  return Object.freeze(output);
}
export function compareSnapshot(scope: ReviewScope, revision: number, local: ReviewManifest,
  remote: ReviewManifest, baseline: ReviewManifest = {}): CompareSnapshot {
  return Object.freeze({ scope: Object.freeze({ ...scope, workspace: Object.freeze({ ...scope.workspace }) }),
    revision, comparedAt: Date.now(), local: freezeManifest(local), remote: freezeManifest(remote), baseline: freezeManifest(baseline) });
}
/** 在异步能力查询之前建立 ticket；身份变化/后续比对使旧结果无效。 */
let compareRevision = 0;
export class ReviewGeneration {
  private generation = 0;
  private identity = '';
  begin(identity: string): Readonly<{ identity: string; generation: number }> {
    this.identity = identity;
    this.generation = ++compareRevision;
    return Object.freeze({ identity, generation: this.generation });
  }
  invalidate(): void { this.generation = ++compareRevision; }
  accepts(ticket: { identity: string; generation: number }, currentIdentity: string): boolean {
    return ticket.generation === this.generation && ticket.identity === this.identity && ticket.identity === currentIdentity;
  }
}
export function withinReviewPath(path: string, directory: string): boolean {
  const root = directory.replace(/\/+$/, '');
  return !root || path === root || path.startsWith(`${root}/`);
}
function directories(manifest: ReviewManifest): Set<string> {
  const dirs = new Set<string>();
  for (const [path, meta] of Object.entries(manifest)) {
    if (meta.kind === 'directory') dirs.add(path);
    let end = path.lastIndexOf('/');
    while (end > 0) { dirs.add(path.slice(0, end)); end = path.lastIndexOf('/', end - 1); }
  }
  return dirs;
}
export function createReviewQueue(snapshot: CompareSnapshot, subtree = '', selected?: string, onlyDifferent = false): ReviewQueue {
  const localDirs = directories(snapshot.local), remoteDirs = directories(snapshot.remote);
  const entries: ReviewEntry[] = [];
  for (const path of new Set([...Object.keys(snapshot.local), ...Object.keys(snapshot.remote)])) {
    if (!withinReviewPath(path, subtree)) continue;
    const l = snapshot.local[path], r = snapshot.remote[path], b = snapshot.baseline[path];
    // 与文件树“仅不同”同口径：两端都存在且哈希不同，不混入单端新增。
    if (onlyDifferent && (!l || !r || l.hash === r.hash)) continue;
    if ((!l || l.kind === 'directory') && (!r || r.kind === 'directory')) continue;
    const typeConflict = (!!l && l.kind !== 'directory' && remoteDirs.has(path))
      || (!!r && r.kind !== 'directory' && localDirs.has(path))
      || path.split('/').slice(0, -1).some((_, i, parts) => {
        const parent = parts.slice(0, i + 1).join('/');
        return (!!snapshot.local[parent] && snapshot.local[parent].kind !== 'directory')
          || (!!snapshot.remote[parent] && snapshot.remote[parent].kind !== 'directory');
      });
    if (!typeConflict && l && r && l.hash && l.hash === r.hash && l.size === r.size) continue;
    entries.push({ path, typeConflict, conflict: typeConflict || !!(b?.hash && l?.hash && r?.hash
      && l.hash !== b.hash && r.hash !== b.hash && l.hash !== r.hash), status: 'pending' });
  }
  entries.sort((a, b) => Number(b.conflict) - Number(a.conflict) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, selected: entries.find(e => e.path === selected)?.path || entries[0]?.path || null };
}
export function reviewPage(queue: ReviewQueue, search = '', pendingOnly = false, page = 0, matchedPaths?: ReadonlySet<string>): {
  entries: readonly ReviewEntry[]; count: number; page: number; pages: number;
} {
  const filtered = queue.entries.filter(e => (matchedPaths ? matchedPaths.has(e.path) : e.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    && (!pendingOnly || !['skipped', 'pushed', 'pulled'].includes(e.status)));
  const pages = Math.max(1, Math.ceil(filtered.length / REVIEW_PAGE_SIZE));
  const index = Math.max(0, Math.min(pages - 1, Math.floor(page) || 0));
  return { entries: filtered.slice(index * REVIEW_PAGE_SIZE, (index + 1) * REVIEW_PAGE_SIZE), count: filtered.length, page: index, pages };
}
export type ReviewPathMatch = { status: 'ok'; paths: string[] } | { status: 'error'; reason: 'invalid_regex' | 'pattern_too_long' };
/** 正则执行仅供 worker 使用；单个表达式的回溯由宿主 terminate 截止保护。 */
export function matchReviewPaths(paths: readonly string[], expression: string): ReviewPathMatch {
  if (expression.length > 512) return { status: 'error', reason: 'pattern_too_long' };
  try {
    const pattern = new RegExp(expression, 'i');
    return { status: 'ok', paths: paths.filter(path => pattern.test(path)) };
  } catch { return { status: 'error', reason: 'invalid_regex' }; }
}
export type ReviewQueueAction = { type: 'select'; path: string } | { type: 'navigate'; direction: -1 | 1 }
  | { type: 'result'; path: string; status: ReviewStatus; reason?: string };
export function reduceReviewQueue(queue: ReviewQueue, action: ReviewQueueAction): ReviewQueue {
  if (action.type === 'select') return queue.entries.some(e => e.path === action.path) ? { ...queue, selected: action.path } : queue;
  const index = queue.entries.findIndex(e => e.path === queue.selected);
  if (action.type === 'navigate') return { ...queue, selected: queue.entries[Math.max(0, Math.min(queue.entries.length - 1, index + action.direction))]?.path || null };
  const entries = queue.entries.map(e => e.path === action.path ? { ...e, status: action.status, reason: action.reason } : e);
  let selected = queue.selected;
  if (selected === action.path && ['skipped', 'pushed', 'pulled'].includes(action.status)) {
    const remaining = [...entries.slice(index + 1), ...entries.slice(0, index)];
    selected = remaining.find(e => e.status === 'pending')?.path || selected;
  }
  return { entries, selected };
}
