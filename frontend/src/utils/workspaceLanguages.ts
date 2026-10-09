import { readWorkbenchCapabilities, type WorkbenchCall, type WorkbenchTarget, type WorkspaceIdentity } from './sessionWorkbench';
import { sameWorkspace } from './workspaceDocuments';
import { uuid } from './uuid';

export type LanguageProvider = 'java' | 'python' | 'react' | 'vue';
export interface LanguageConfig { provider: LanguageProvider; [field: string]: string | boolean }
export interface LanguagePlan {
  status: 'planned'; workspace: WorkspaceIdentity; provider: LanguageProvider; planFingerprint: string;
  config: LanguageConfig; dependencies: Record<string, string>;
  effects: { projectCode: boolean; workspaceWrite: boolean; automaticDownloads: boolean; buildImport: boolean }; notice: string;
}
export interface LanguageRecord {
  workspace: WorkspaceIdentity; resourceId: string; generation: string; requestId: string; revision: number;
  provider: LanguageProvider; status: 'initializing' | 'ready' | 'failed' | 'stopping' | 'stopped' | 'unknown';
  reasonCode: string; config: LanguageConfig; dependencies: Record<string, string>; activityId: string;
  planFingerprint: string; exitConfirmed: boolean; capabilities: Record<string, boolean>;
  documents: { relativePath: string; revision: number; protocolVersion: number }[];
}
export interface LanguagePosition { line: number; character: number }
export interface LanguageRange { start: LanguagePosition; end: LanguagePosition }
export interface LanguageDiagnostic { range: LanguageRange; severity: number; message: string; source: string }
export interface LanguageDiagnostics { relativePath: string; revision: number | null; freshness: 'current' | 'unversioned'; items: LanguageDiagnostic[]; truncated: boolean }
export interface LanguageBuffer { relativePath: string; revision: number; text: string }
const id = (v: unknown) => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);
export const providerForPath = (path: string): LanguageProvider | null => /\.java$/i.test(path) ? 'java'
  : /\.(py|pyi)$/i.test(path) ? 'python' : /\.vue$/i.test(path) ? 'vue' : /\.[cm]?[jt]sx?$/i.test(path) ? 'react' : null;

export class WorkspaceLanguages {
  private constructor(readonly target: WorkbenchTarget, readonly workspace: WorkspaceIdentity,
    private call: WorkbenchCall, private current: () => boolean) {}
  static async connect(target: WorkbenchTarget, call: WorkbenchCall, current: () => boolean) {
    const capability = await readWorkbenchCapabilities(target, call, current);
    if (!current()) throw new Error('语言服务工作区已变化');
    if (capability.capabilities.languageServices !== 1 || !capability.identity) throw new Error('此执行节点不支持工程语义服务；仍可使用基础编辑。');
    return new WorkspaceLanguages(Object.freeze({ ...target }), capability.identity, call, current);
  }
  private async rpc(method: string, payload?: object, timeout = 12000): Promise<any> {
    if (!this.current()) throw new Error('语言服务工作区已变化');
    const raw = await this.call(this.target.executor, method, [this.target.session, JSON.stringify(this.workspace),
      ...(payload ? [JSON.stringify(payload)] : [])], timeout);
    if (!this.current()) throw new Error('语言服务工作区已变化');
    const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!row || row.status === 'error') throw new Error(row?.reasonCode || '语言服务结果未知');
    return row;
  }
  record(row: any): LanguageRecord {
    if (!row || !sameWorkspace(this.workspace, row.workspace) || ![row.resourceId, row.generation, row.requestId, row.activityId].every(id)
      || !Number.isSafeInteger(row.revision) || row.revision < 0 || !['java', 'python', 'vue', 'react'].includes(row.provider)
      || !['initializing', 'ready', 'failed', 'stopping', 'stopped', 'unknown'].includes(row.status)
      || typeof row.exitConfirmed !== 'boolean' || (row.status === 'stopped') !== row.exitConfirmed
      || !row.capabilities || !Array.isArray(row.documents) || row.documents.length > 32) throw new Error('语言服务实例响应不匹配');
    return row;
  }
  async list(): Promise<{ services: LanguageRecord[]; controlRevision: number }> {
    const row = await this.rpc('languageServiceList');
    if (row.status !== 'ok' || !sameWorkspace(this.workspace, row.workspace) || !Array.isArray(row.services) || row.services.length > 64
      || !Number.isSafeInteger(row.controlRevision) || row.controlRevision < 0) throw new Error('语言服务列表身份不匹配');
    return { ...row, services: row.services.map((r: unknown) => this.record(r)) };
  }
  async plan(config: LanguageConfig): Promise<LanguagePlan> {
    const row = await this.rpc('languageServicePlan', { config });
    if (row.status !== 'planned' || !sameWorkspace(this.workspace, row.workspace) || row.provider !== config.provider
      || !/^[a-f0-9]{64}$/.test(row.planFingerprint) || !row.effects || typeof row.notice !== 'string') throw new Error('语言启用计划不匹配');
    return row;
  }
  async start(plan: LanguagePlan, controlRevision: number, trust: { allowProjectCode: boolean; allowWorkspaceWrite: boolean; allowBuildImport: boolean }, requestId = uuid()) {
    if (!sameWorkspace(this.workspace, plan.workspace)) throw new Error('启用计划工作区已变化');
    try {
      const row = this.record(await this.rpc('languageServiceStart', { planFingerprint: plan.planFingerprint, requestId, controlRevision, ...trust }));
      if (row.requestId !== requestId || row.planFingerprint !== plan.planFingerprint) throw new Error('启用结果不匹配');
      return row;
    } catch (error) {
      const checked = await this.list().catch(() => null);
      const original = checked?.services.find(row => row.requestId === requestId && row.planFingerprint === plan.planFingerprint);
      if (original) return original;
      throw error; // 未知启动结果只读核对，不重启替代实例。
    }
  }
  async request(service: LanguageRecord, action: string, payload: object = {}, signal?: AbortSignal): Promise<any> {
    const requestId = uuid();
    const cancel = () => { void this.rpc('languageServiceRequest', { resourceId: service.resourceId, generation: service.generation,
      action: 'cancel', requestId: uuid(), originalRequestId: requestId }).catch(() => {}); };
    if (signal?.aborted) throw new Error('语义请求已取消');
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const row = await this.rpc('languageServiceRequest', { ...payload, resourceId: service.resourceId, generation: service.generation, action, requestId }, 30000);
      const received = this.record(row.service);
      if (signal?.aborted || row.status !== 'ok' || received.resourceId !== service.resourceId || received.generation !== service.generation) throw new Error('语义请求已失效');
      const buffer = payload as Partial<LanguageBuffer>;
      if (buffer.revision !== undefined && row.revision !== buffer.revision) throw new Error('语义文档版本已变化');
      return row;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  async stop(service: LanguageRecord) {
    try { return this.record(await this.rpc('languageServiceStop', { resourceId: service.resourceId, generation: service.generation })); }
    catch (error) {
      const checked = await this.list().catch(() => null);
      const row = checked?.services.find(row => row.resourceId === service.resourceId && row.generation === service.generation);
      if (row?.exitConfirmed) return row;
      throw error;
    }
  }
  async diagnostics(service: LanguageRecord): Promise<LanguageDiagnostics[]> {
    const row = await this.rpc('languageServiceDiagnostics', { resourceId: service.resourceId, generation: service.generation });
    const received = this.record(row.service);
    if (received.resourceId !== service.resourceId || received.generation !== service.generation || !Array.isArray(row.diagnostics)
      || row.diagnostics.length > 32 || JSON.stringify(row.diagnostics).length > 3 * 1024 * 1024
      || row.diagnostics.some((d: any) => typeof d.relativePath !== 'string' || !Array.isArray(d.items) || d.items.length > 500)) throw new Error('诊断结果身份或容量不匹配');
    const position = (p: any) => p && ['line', 'character'].every(key => Number.isSafeInteger(p[key]) && p[key] >= 0 && p[key] <= 2 * 1024 * 1024);
    return row.diagnostics.map((d: LanguageDiagnostics) => ({ ...d, items: d.items.filter(item => item && typeof item.message === 'string'
      && item.message.length <= 4096 && position(item.range?.start) && position(item.range?.end)) }));
  }
}

const resources = new Map<string, LanguageRecord[]>(), listeners = new Set<() => void>();
export const languageResources = {
  set(key: string, rows: LanguageRecord[]) { resources.set(key, rows); listeners.forEach(fn => fn()); },
  clear() { resources.clear(); listeners.forEach(fn => fn()); },
  liveCount() { return [...resources.values()].reduce((n, rows) => n + rows.filter(row => !row.exitConfirmed).length, 0); },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
