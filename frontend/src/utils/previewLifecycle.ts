import { documentRelativePath, sameWorkspace } from './workspaceDocuments';
import type { WorkspaceIdentity } from './sessionWorkbench';

export interface PreviewIdentity { mode: 'local' | 'relay'; realm: string; owner: string; epoch: string }
export interface PreviewLocalBinding { kind: 'tauri' | 'browser' | 'managed'; id: string; root: string }
export interface PreviewSource {
  version: 2; id: string; identity: PreviewIdentity; executor: string; executorRealm: string;
  session: string; workingDir: string; workspace: WorkspaceIdentity;
  relative: string; source: 'remote' | 'local'; readonly: boolean; local?: PreviewLocalBinding;
}
const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
export function samePreviewIdentity(a: PreviewIdentity, b: PreviewIdentity): boolean {
  return a.mode === b.mode && a.realm === b.realm && a.owner === b.owner && a.epoch === b.epoch;
}
/** 白名单复制：窗口描述不是授权，未知字段（包括 token）也不能被持久化/转发。 */
export function validatePreviewSource(value: unknown): PreviewSource {
  const v = value as PreviewSource;
  if (!exact(v, ['version', 'id', 'identity', 'executor', 'executorRealm', 'session', 'workingDir', 'workspace', 'relative', 'source', 'readonly', 'local'])
    || v.version !== 2 || typeof v.id !== 'string' || !/^[\w-]{1,128}$/.test(v.id) || !string(v.executor) || !string(v.executorRealm)
    || !string(v.session) || !string(v.workingDir) || typeof v.readonly !== 'boolean'
    || !['remote', 'local'].includes(v.source)
    || !exact(v.identity, ['mode', 'realm', 'owner', 'epoch']) || !['local', 'relay'].includes(v.identity.mode)
    || ![v.identity.realm, v.identity.owner, v.identity.epoch].every(string)
    || !exact(v.workspace, ['ownerId', 'executorInstance', 'sessionId', 'workingDir', 'workspaceRevision'])
    || ![v.workspace.ownerId, v.workspace.executorInstance, v.workspace.sessionId, v.workspace.workingDir, v.workspace.workspaceRevision].every(string)
    || v.workspace.ownerId !== v.identity.owner || v.workspace.sessionId !== v.session
    || !string(v.relative) || documentRelativePath(v.relative) !== v.relative) throw new Error('预览来源描述无效或版本不兼容');
  if (v.source === 'local') {
    if (!exact(v.local, ['kind', 'id', 'root']) || !['tauri', 'browser', 'managed'].includes(v.local.kind)
      || !string(v.local.id) || !string(v.local.root) || v.workspace.workingDir !== v.local.id) throw new Error('本机预览绑定无效');
  } else if (v.local || v.workspace.workingDir !== v.workingDir) throw new Error('执行端预览绑定无效');
  return Object.freeze({ ...v, identity: Object.freeze({ ...v.identity }), workspace: Object.freeze({ ...v.workspace }),
    ...(v.local ? { local: Object.freeze({ ...v.local }) } : {}) });
}
export function samePreviewSource(a: PreviewSource, b: PreviewSource): boolean {
  return samePreviewIdentity(a.identity, b.identity) && a.executor === b.executor && a.executorRealm === b.executorRealm
    && a.session === b.session && a.workingDir === b.workingDir && a.relative === b.relative && a.source === b.source
    && a.readonly === b.readonly && sameWorkspace(a.workspace, b.workspace) && JSON.stringify(a.local) === JSON.stringify(b.local);
}
export type PreviewPhase = 'initializing' | 'ready' | 'offline' | 'invalidated' | 'revoked' | 'closed';
export class PreviewLifecycle {
  phase: PreviewPhase = 'initializing'; generation = 0; reason = '';
  private listeners = new Set<() => void>();
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  set(phase: PreviewPhase, reason = '') {
    if (this.phase === 'closed' || this.phase === 'revoked' && phase !== 'closed') return;
    if (this.phase === 'invalidated' && !['revoked', 'closed'].includes(phase)) return;
    if (this.phase === phase && this.reason === reason) return;
    if (phase !== 'ready') this.generation++;
    this.phase = phase; this.reason = reason; this.listeners.forEach(cb => cb());
  }
  assert(generation = this.generation) {
    if (generation !== this.generation || ['invalidated', 'revoked', 'closed'].includes(this.phase)) throw new Error(this.reason || '预览来源已失效');
  }
}

export interface PreviewRegistration { source: PreviewSource; dark: boolean; initialView?: 'preview' | 'source' | 'split'; expires: number }
export const PREVIEW_REGISTRY_KEY = 'awu.file-previews.v2';
export const PREVIEW_REGISTRY_LIMIT = 64;
export const PREVIEW_REGISTRY_TTL = 24 * 60 * 60 * 1000;
type RegistryStorage = Pick<Storage, 'getItem' | 'setItem'>;
export class PreviewRegistry {
  constructor(private storage: RegistryStorage, private now = () => Date.now()) {}
  private rows(): PreviewRegistration[] {
    const raw = this.storage.getItem(PREVIEW_REGISTRY_KEY);
    if (!raw) return [];
    if (raw.length > 2 * 1024 * 1024) throw new Error('预览登记超出容量');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > PREVIEW_REGISTRY_LIMIT) throw new Error('预览登记无效');
    return rows.filter(row => Number.isSafeInteger(row?.expires) && row.expires > this.now()).map(row => {
      if (!exact(row, ['source', 'dark', 'initialView', 'expires']) || typeof row.dark !== 'boolean'
        || row.initialView !== undefined && !['preview', 'source', 'split'].includes(row.initialView as string)) throw new Error('预览登记无效');
      return { ...row, source: validatePreviewSource(row.source) } as PreviewRegistration;
    });
  }
  get(id: string, identity: PreviewIdentity): PreviewRegistration | null {
    const row = this.rows().find(row => row.source.id === id);
    if (row && !samePreviewIdentity(row.source.identity, identity)) throw new Error('此预览属于其他身份或已退出的登录');
    return row || null;
  }
  put(input: Omit<PreviewRegistration, 'expires'>) {
    const source = validatePreviewSource(input.source), rows = this.rows();
    const existing = rows.find(row => row.source.id === source.id);
    if (existing && !samePreviewSource(existing.source, source)) throw new Error('不能替换已有预览来源');
    const next = rows.filter(row => row.source.id !== source.id);
    if (next.length >= PREVIEW_REGISTRY_LIMIT) throw new Error('独立预览过多，请关闭不用的窗口');
    next.push({ source, dark: input.dark, initialView: input.initialView, expires: this.now() + PREVIEW_REGISTRY_TTL });
    this.storage.setItem(PREVIEW_REGISTRY_KEY, JSON.stringify(next));
  }
  remove(id: string, identity: PreviewIdentity) {
    this.storage.setItem(PREVIEW_REGISTRY_KEY, JSON.stringify(this.rows().filter(row => row.source.id !== id || !samePreviewIdentity(row.source.identity, identity))));
  }
}
