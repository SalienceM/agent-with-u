import { readWorkbenchCapabilities, type WorkbenchCall, type WorkbenchTarget, type WorkspaceIdentity } from './sessionWorkbench';
import { sameWorkspace } from './workspaceDocuments';
import { uuid } from './uuid';

export interface TerminalRecord {
  workspace: WorkspaceIdentity; resourceId: string; generation: string; requestId: string;
  shell: { id: string; executable: string; args: string[] }; cols: number; rows: number;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'unknown'; reasonCode: string;
  revision: number; lastSequence: number; inputSequence: number; activityId: string; exitConfirmed: boolean;
}
export interface TerminalPage extends Omit<TerminalRecord, 'status'> {
  status: 'ok'; terminalStatus: TerminalRecord['status']; gap: boolean; earliestSequence: number;
  chunks: { sequence: number; text: string }[]; through: number;
}
const id = (v: unknown) => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);

export class WorkspaceTerminals {
  private constructor(readonly target: WorkbenchTarget, readonly workspace: WorkspaceIdentity,
    private call: WorkbenchCall, private current: () => boolean) {}
  static async connect(target: WorkbenchTarget, call: WorkbenchCall, current: () => boolean) {
    const capability = await readWorkbenchCapabilities(target, call, current);
    if (!current()) throw new Error('终端工作区已变化');
    if (capability.capabilities.terminal !== 1 || !capability.identity) throw new Error('节点不支持受管理终端，或缺少 PTY 依赖；不会回退普通命令进程。');
    return new WorkspaceTerminals(Object.freeze({ ...target }), capability.identity, call, current);
  }
  private async request(method: string, payload?: object): Promise<any> {
    if (!this.current()) throw new Error('终端工作区已变化');
    const raw = await this.call(this.target.executor, method, [this.target.session, JSON.stringify(this.workspace),
      ...(payload ? [JSON.stringify(payload)] : [])], 12000);
    if (!this.current()) throw new Error('终端工作区已变化');
    const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!row || row.status === 'error') throw new Error(row?.reasonCode || '终端结果未知');
    return row;
  }
  record(row: any): TerminalRecord {
    if (!row || !sameWorkspace(this.workspace, row.workspace) || !id(row.resourceId) || !id(row.generation)
      || !id(row.requestId) || !id(row.activityId) || !['starting', 'running', 'stopping', 'stopped', 'unknown'].includes(row.status)
      || !['revision', 'lastSequence', 'inputSequence'].every(k => Number.isSafeInteger(row[k]) && row[k] >= 0)
      || !row.shell || typeof row.shell.executable !== 'string' || !Array.isArray(row.shell.args)
      || typeof row.exitConfirmed !== 'boolean' || (row.status === 'stopped') !== row.exitConfirmed) throw new Error('终端实例响应不匹配');
    return row;
  }
  async list(): Promise<{ terminals: TerminalRecord[]; shells: TerminalRecord['shell'][]; controlRevision: number }> {
    const row = await this.request('terminalList');
    if (row.status !== 'ok' || !sameWorkspace(this.workspace, row.workspace) || !Array.isArray(row.terminals)
      || row.terminals.length > 64 || !Array.isArray(row.shells) || row.shells.length > 8
      || !Number.isSafeInteger(row.controlRevision) || row.controlRevision < 0) throw new Error('终端列表身份不匹配');
    return { ...row, terminals: row.terminals.map((r: unknown) => this.record(r)) };
  }
  async create(shell: string, controlRevision: number, requestId = uuid()): Promise<TerminalRecord> {
    try { return this.record(await this.request('terminalCreate', { requestId, shell, controlRevision, cols: 80, rows: 24 })); }
    catch (error) {
      const result = await this.list().catch(() => null);
      const original = result?.terminals.find(t => t.requestId === requestId);
      if (original) return original;
      throw error; // 不重发创建，不把列表暂时没有行当成没有进程。
    }
  }
  async read(record: TerminalRecord, after: number): Promise<TerminalPage> {
    const row = await this.request('terminalRead', { resourceId: record.resourceId, generation: record.generation, after });
    this.record({ ...row, status: row.terminalStatus });
    if (row.status !== 'ok' || row.resourceId !== record.resourceId || row.generation !== record.generation
      || typeof row.gap !== 'boolean' || !Array.isArray(row.chunks) || JSON.stringify(row.chunks).length > 512 * 1024
      || !Number.isSafeInteger(row.through) || row.through > row.lastSequence
      || row.chunks.some((c: any, i: number) => typeof c.text !== 'string' || !Number.isSafeInteger(c.sequence)
        || c.sequence !== (i ? row.chunks[i - 1].sequence + 1 : row.gap ? row.earliestSequence : after + 1))
      || row.chunks.length && row.through !== row.chunks.at(-1).sequence) throw new Error('终端输出位置不匹配');
    return row;
  }
  async input(record: TerminalRecord, text: string, sequence: number): Promise<TerminalRecord> {
    const row = await this.request('terminalInput', { resourceId: record.resourceId, generation: record.generation,
      requestId: uuid(), sequence, text });
    const terminal = this.record(row.terminal);
    if (!['accepted', 'duplicate'].includes(row.status) || row.sequence !== sequence || terminal.resourceId !== record.resourceId
      || terminal.generation !== record.generation || terminal.inputSequence !== sequence) throw new Error('输入结果未知，请核对或停止原终端；不会重放输入。');
    return terminal;
  }
  async resize(record: TerminalRecord, cols: number, rows: number): Promise<TerminalRecord> {
    return this.record(await this.request('terminalResize', { resourceId: record.resourceId, generation: record.generation, cols, rows }));
  }
  async stop(record: TerminalRecord): Promise<TerminalRecord> {
    try { return this.record(await this.request('terminalStop', { resourceId: record.resourceId, generation: record.generation, requestId: uuid() })); }
    catch (error) {
      const checked = await this.list().catch(() => null);
      const result = checked?.terminals.find(t => t.resourceId === record.resourceId && t.generation === record.generation);
      if (result?.exitConfirmed) return result;
      throw error;
    }
  }
}

/** 丢弃 OSC/DCS/APC/PM/SOS（含分片）；不让输出创建链接、写剪贴板或触发应用操作。 */
export class TerminalOutputFilter {
  private state: 'text' | 'escape' | 'string' | 'stringEscape' = 'text';
  reset() { this.state = 'text'; }
  feed(text: string): string {
    let out = '';
    for (const c of text) {
      if (this.state === 'string' || this.state === 'stringEscape') {
        if (c === '\x07' || c === '\x9c' || this.state === 'stringEscape' && c === '\\') this.state = 'text';
        else this.state = c === '\x1b' ? 'stringEscape' : 'string';
      } else if (this.state === 'escape') {
        if (']P_^X'.includes(c)) this.state = 'string';
        else { out += '\x1b' + c; this.state = 'text'; }
      } else if (c === '\x1b') this.state = 'escape';
      else if ('\x90\x98\x9d\x9e\x9f'.includes(c)) this.state = 'string';
      else if (c !== '\x9c') out += c;
    }
    return out;
  }
}

const resources = new Map<string, TerminalRecord[]>(), listeners = new Set<() => void>();
export const terminalResources = {
  set(key: string, rows: TerminalRecord[]) { resources.set(key, rows); listeners.forEach(fn => fn()); },
  clear() { resources.clear(); listeners.forEach(fn => fn()); },
  liveCount() { return [...resources.values()].reduce((count, rows) => count + rows.filter(row => !row.exitConfirmed).length, 0); },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
