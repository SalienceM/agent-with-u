import { api, getPreviewIdentity, getExecTarget, previewExecutorRealm, observePreviewIdentity } from '../api';
import { loadDocumentPreview } from './documentPreview';
import type { StructuredPreviewPayload } from '../components/StructuredFilePreview';
import { PreviewLifecycle, samePreviewIdentity, validatePreviewSource, type PreviewSource } from './previewLifecycle';
import { sameWorkspace, DocumentProtocolError, documentRelativePath } from './workspaceDocuments';
import { LocalDocuments } from './localDocuments';
import { IndexedLocalJournal } from './localDocumentStorage';
import { restorePreviewBinding } from './previewLocalBinding';
import type { LocalFs } from './dirSync';
import { readonlyDocumentClient, type DocumentClient } from './documentStore';
import { windowTransport, loadWindowNavigation } from './workbenchWindows';

const CHUNK = 512 * 1024;
const encode = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(text); };

/** 每个独立窗口自己的资源控制器；没有原组件或 UI 当前选择的引用。 */
export class PreviewAccess {
  readonly source: PreviewSource;
  readonly life = new PreviewLifecycle();
  private local?: LocalFs;
  private client?: DocumentClient;
  private inflight = 0;
  private cleanup: (() => void)[] = [];
  constructor(source: PreviewSource) {
    this.source = validatePreviewSource(source);
    this.cleanup.push(observePreviewIdentity(() => { try { this.assert(); } catch { /* 状态已推送 */ } }));
    this.cleanup.push(api.onExecutorConnectionStatus(source.executor, connected => {
      if (source.source === 'remote' && !connected
        && this.life.phase === 'ready') this.life.set('offline', '原执行节点离线，已加载内容与草稿保留；连接恢复后可核对原来源。');
    }));
    this.cleanup.push(api.onSessionUpdated(data => {
      if (data?.sessionId !== source.session || data.execKey && data.execKey !== source.executor) return;
      if (data.type === 'session_deleted') this.life.set('revoked', '原 Session 已删除或访问权已撤销。');
      else if (data.summary?.workingDir && data.summary.workingDir !== source.workingDir) this.life.set('invalidated', '原 Session 工作目录已变化，未重新绑定。');
    }));
  }
  private assert = () => {
    if (!samePreviewIdentity(this.source.identity, getPreviewIdentity())) {
      this.life.set('revoked', '账号或身份域已变化，原身份内容已隔离。请以原身份重新打开。');
    }
    this.life.assert();
    if (this.source.source === 'remote') {
      const target = getExecTarget(this.source.executor) || (this.source.executor === 'local' ? { mode: 'local' as const } : null);
      if (!target || previewExecutorRealm(target) !== this.source.executorRealm) {
        this.life.set('invalidated', '原执行节点已不可用或身份域发生变化；未回退其他节点。'); this.life.assert();
      }
    }
  };
  private current = () => { try { this.assert(); return true; } catch { return false; } };
  private failure(error: unknown) {
    const reason = (error as { reasonCode?: unknown })?.reasonCode;
    const code = typeof reason === 'string' ? reason : error instanceof Error ? error.message : String(error);
    if (['access_denied', 'session_access_denied', 'unauthorized', 'forbidden', 'session_not_found'].includes(code)) this.life.set('revoked', '原来源访问授权已失效。');
    else if (['stale_workspace', 'local_binding_changed', 'local_binding_unavailable'].includes(code)) this.life.set('invalidated', '原工作区或本机绑定已变化，未重新绑定。');
    else if (/offline|离线|未连接|无响应|connection|timeout|超时|local_permission_required/i.test(code)) this.life.set('offline', code === 'local_permission_required' ? '原目录需要重新授权；请点击重新连接，不会选择其他目录。' : '原文件来源暂时不可用；已加载内容与草稿保留。');
  }
  private async operation<T>(run: () => Promise<T>, reconnect = false): Promise<T> {
    this.assert();
    if (this.life.phase === 'offline' && !reconnect) throw new Error('来源离线，请先重新连接并核对原来源。');
    if (this.inflight >= 8) throw new Error('文件操作过多，请稍后重试');
    const generation = this.life.generation; this.inflight++;
    // 超时只结束等待，底层 I/O 未确认退出前仍占并发名额，不能堆积后台请求。
    const work = run().finally(() => { this.inflight--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('文件操作超时；保存结果须核对，不能重发')), 30000); })]);
      this.assert(); this.life.assert(generation); return result;
    } catch (error) { this.failure(error); throw error; }
    finally { clearTimeout(timer); }
  }
  private async verify() {
    this.assert();
    const generation = this.life.generation;
    const s = this.source;
    if (s.source === 'local') {
      const fs = await restorePreviewBinding(s.local!); this.assert();
      const client = new LocalDocuments(s.identity.owner, s.session, s.executor, await fs.documentAdapter!(), new IndexedLocalJournal(), this.current);
      if (!sameWorkspace(s.workspace, client.identity)) throw new DocumentProtocolError('stale_workspace');
      this.local = fs; this.client = client;
    } else {
      const client = await api.workspaceDocuments(s.session, s.executor, s.workingDir, this.current); this.assert();
      if (!sameWorkspace(s.workspace, client.identity)) throw new DocumentProtocolError('stale_workspace');
      this.client = s.readonly ? readonlyDocumentClient(client) : client;
    }
    this.life.assert(generation);
  }
  async connect(requestPermission = false) {
    await this.operation(async () => {
      if (requestPermission && this.source.local) await restorePreviewBinding(this.source.local, true);
      await this.verify();
      if (new URLSearchParams(location.search).has('filePreview')) {
        if (windowTransport.identity && windowTransport.identity.windowId !== `preview-${this.source.id}`) throw new Error('文件窗口不能继承其他工作台的控制身份');
        if (!windowTransport.identity) windowTransport.activate(loadWindowNavigation(this.source.identity.owner, localStorage, sessionStorage, `preview-${this.source.id}`));
      }
    }, true);
    this.life.set('ready');
  }
  private async bytes(relative: string, max: number): Promise<Uint8Array> {
    const rel = documentRelativePath(relative), s = this.source;
    const generation = this.life.generation;
    await this.verify();
    const stat = this.local ? { status: 'ok', size: await this.local.fileSize(rel) } : await api.syncFileStat(s.workingDir, rel, s.executor);
    if (stat.status !== 'ok') throw new Error(stat.message || '文件大小读取无响应');
    const size = stat.size;
    if (!Number.isSafeInteger(size) || size! < 0 || size! > max) throw new Error(`文件超出预览上限（${max} 字节）或大小无效`);
    const bytes = new Uint8Array(size!);
    for (let offset = 0; offset < bytes.length;) {
      this.assert(); this.life.assert(generation); const length = Math.min(CHUNK, bytes.length - offset);
      const result = this.local ? { status: 'ok', data: await this.local.readChunk(rel, offset, length) } : await api.syncReadChunk(s.workingDir, rel, offset, length, s.executor);
      this.assert(); this.life.assert(generation);
      if (result.status !== 'ok' || typeof result.data !== 'string') throw new Error(result.message || '文件分块读取无响应');
      if (result.data.length > Math.ceil(length / 3) * 4 + 4) throw new Error('预览分块超出上限');
      const chunk = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
      if (!chunk.length || chunk.length > length) throw new Error('预览分块长度无效');
      bytes.set(chunk, offset); offset += chunk.length;
    }
    await this.verify(); return bytes;
  }
  readFile = (rel: string) => this.operation(() => this.bytes(rel, 8 * 1024 * 1024));
  private async parsed(rel: string, bytes?: Uint8Array): Promise<StructuredPreviewPayload> {
    const generation = this.life.generation;
    await this.verify(); const s = this.source;
    const result = s.source === 'remote' ? await api.filePreview(s.workingDir, rel, s.executor)
      : await api.filePreviewData(rel.split('/').pop()!, encode(bytes || await this.bytes(rel, 32 * 1024 * 1024)), s.executor);
    this.life.assert(generation); await this.verify();
    if (!result || !['ok', 'unsupported', 'error'].includes(result.status)) throw new Error('文件解析无响应');
    return result;
  }
  structured = (rel: string) => this.operation(() => this.parsed(documentRelativePath(rel)));
  load = (relative = this.source.relative) => this.operation(async () => {
    const rel = documentRelativePath(relative);
    return loadDocumentPreview<StructuredPreviewPayload>({ rel, name: rel.split('/').pop()!, source: this.source.source, loading: true }, {
      bytes: max => this.bytes(rel, max), structured: bytes => this.parsed(rel, bytes),
      base64: () => this.bytes(rel, 32 * 1024 * 1024).then(encode),
    });
  });
  documentClient = async (): Promise<DocumentClient> => {
    await this.operation(() => this.verify()); const s = this.source;
    return { identity: s.workspace, source: s.source === 'local' ? 'local-copy' : 'executor', readonly: s.readonly,
      read: (rel, id) => this.operation(async () => { await this.verify(); return this.client!.read(rel, id); }),
      save: request => this.operation(async () => {
        await this.verify();
        if (!await api.previewDocumentWriteAllowed(s.session, s.executor, s.workingDir, this.current)) return {
          status: 'failed', requestId: request.requestId, relativePath: request.relativePath, bufferRevision: request.bufferRevision,
          workspace: s.workspace, reasonCode: 'window_lease_required',
        };
        this.assert(); return this.client!.save(request);
      }),
      saveGet: id => this.operation(async () => { await this.verify(); return this.client!.saveGet(id); }),
    };
  };
  dispose() { this.life.set('closed'); this.cleanup.splice(0).forEach(off => off()); }
}
