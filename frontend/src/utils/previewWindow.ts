import { openDetachedWindow, releaseDetachedWindow } from './detachedWindow';
import { uuid } from './uuid';
import type { DocumentPreview } from './documentPreview';
import type { StructuredPreviewPayload } from '../components/StructuredFilePreview';
import { normalizeRelativeFilePath } from './fileFocus';
import type { DocumentClient } from './documentStore';
import type { DocumentSaveRequest } from './workspaceDocuments';
import type { PreviewSource } from './previewLifecycle';
import { samePreviewIdentity } from './previewLifecycle';
import { registerPreview, removePreviewRegistration } from './previewRegistration';
import { getPreviewIdentity } from '../api';

export const isPreviewWindow = typeof location !== 'undefined' && new URLSearchParams(location.search).has('filePreview');
export interface PreviewWindowSnapshot {
  preview: DocumentPreview<StructuredPreviewPayload>;
  root: string;
  nodeLabel: string;
  theme: Record<string, string>;
  dark: boolean;
  initialView?: 'preview' | 'source' | 'split';
}

export interface PreviewWindowServices {
  load: (rel: string) => Promise<PreviewWindowSnapshot['preview']>;
  documentClient: () => Promise<DocumentClient>;
  reveal: (rel: string) => Promise<void>;
  review: (rel: string) => Promise<void>;
  structured?: (rel: string) => Promise<StructuredPreviewPayload>;
}

/** V2：点击栈内先开窗口，来源独立登记；原面板只提供可选 UI 导航。 */
export function openIndependentPreview(snapshot: PreviewWindowSnapshot, prepare: (id: string) => Promise<PreviewSource>,
  navigation: Pick<PreviewWindowServices, 'reveal' | 'review'>): { opened: Promise<void>; disposed: Promise<void>; dispose: () => void } {
  const id = uuid(), channel = new BroadcastChannel(`awu-file-preview-${id}`);
  let suspended: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, creationFailed = false, source: PreviewSource | undefined;
  let settle: (() => void) | undefined, fail: ((reason: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
  let release: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  // 即使窗口创建先失败，也观察交接 Promise 的拒绝，避免无主拒绝。
  void ready.catch(() => {});
  const timer = setTimeout(() => { fail?.(new Error('独立预览尚未完成初始化，请查看新窗口中的来源状态。')); }, 30000);
  const dispose = () => { if (disposed) return; disposed = true; fail?.(new Error('原界面已结束初始化协作；文件窗口使用自己的来源继续加载。')); channel.close(); clearTimeout(timer); clearTimeout(suspended); window.removeEventListener('pagehide', dispose); releaseDetachedWindow(`file-preview-${id}`); release(); };
  channel.onmessage = async ({ data }) => {
    if (data?.kind === 'resuming') clearTimeout(suspended);
    else if (data?.kind === 'suspended') { clearTimeout(suspended); suspended = setTimeout(dispose, 30000); }
    else if (data?.kind === 'initialized') { clearTimeout(timer); clearTimeout(suspended); settle?.(); }
    else if (data?.kind === 'initializationFailed') { clearTimeout(timer); fail?.(new Error(`独立预览初始化失败：${String(data.message || '来源不可用')}`)); }
    else if (data?.kind === 'closed') dispose();
    else if (data?.kind === 'navigate-ui' && source && samePreviewIdentity(source.identity, getPreviewIdentity())
      && Number.isSafeInteger(data.id) && ['reveal', 'review'].includes(data.method)) {
      try {
        const rel = normalizeRelativeFilePath(data.rel); if (!rel) throw new Error('文件路径无效');
        await navigation[data.method as 'reveal' | 'review'](rel);
        if (!disposed) channel.postMessage({ kind: 'ui-result', id: data.id });
      } catch (error) { if (!disposed) channel.postMessage({ kind: 'ui-result', id: data.id, error: String(error) }); }
    }
  };
  window.addEventListener('pagehide', dispose);
  const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('filePreview', id); url.searchParams.set('previewVersion', '2');
  const created = openDetachedWindow({ label: `file-preview-${id}`, title: `${snapshot.preview.name} · 预览 — AgentWithU`,
    url: `${url.pathname}${url.search}`, width: 1100, height: 800, minWidth: 400, minHeight: 320 }).catch(async error => {
      creationFailed = true; if (source) await removePreviewRegistration(id, source.identity).catch(() => {}); throw error;
    });
  const prepared = prepare(id).then(async value => {
    source = value;
    if (creationFailed) throw new Error('窗口未创建，未登记文件来源');
    await registerPreview({ source, dark: snapshot.dark, initialView: snapshot.initialView });
    if (creationFailed) { await removePreviewRegistration(id, source.identity); return; }
    if (!disposed) channel.postMessage({ kind: 'registered' });
  }).catch(error => { if (!disposed) channel.postMessage({ kind: 'registrationFailed', message: String(error) }); throw error; });
  const opened = Promise.all([created, prepared, ready]).then(() => {}).catch(error => { dispose(); throw error; });
  return { opened, disposed: released, dispose };
}

/** 窗口传递显示状态；文件操作由原工作区连接执行，保持来源与有版本保存语义。 */
export function openPreviewWindow(snapshot: PreviewWindowSnapshot, readFile: (rel: string) => Promise<Uint8Array>, services?: PreviewWindowServices): {
  opened: Promise<void>; dispose: () => void;
} {
  const id = uuid();
  const channel = new BroadcastChannel(`awu-file-preview-${id}`);
  let disposed = false;
  let inflight = 0;
  const relative = (value: unknown) => {
    const path = typeof value === 'string' ? normalizeRelativeFilePath(value) : null;
    if (!path) throw new Error('文件路径无效');
    return path;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    channel.postMessage({ kind: 'disconnected' });
    channel.close();
    window.removeEventListener('pagehide', dispose);
  };
  channel.onmessage = async ({ data }) => {
    if (disposed) return;
    if (data?.kind === 'ready') channel.postMessage({ kind: 'snapshot', snapshot, fullDocument: !!services });
    else if (data?.kind === 'closed') dispose();
    else if (data?.kind === 'request' && Number.isSafeInteger(data.id) && services) {
      if (inflight >= 8) { channel.postMessage({ kind: 'result', id: data.id, error: '操作过多，请稍后重试' }); return; }
      inflight++;
      try {
        let result: unknown;
        switch (data.method) {
          case 'load': result = await services.load(relative(data.rel)); break;
          case 'reveal': await services.reveal(relative(data.rel)); break;
          case 'review': await services.review(relative(data.rel)); break;
          case 'structured':
            if (!services.structured) throw new Error('此文件没有备用预览');
            result = await services.structured(relative(data.rel)); break;
          case 'document': {
            const client = await services.documentClient();
            result = { identity: client.identity, source: client.source, readonly: client.readonly };
            break;
          }
          case 'read': result = await (await services.documentClient()).read(relative(data.rel), uuid()); break;
          case 'save': {
            const input = data.request as DocumentSaveRequest;
            if (!input || relative(input.relativePath) !== input.relativePath || typeof input.requestId !== 'string'
              || !/^[\w-]{1,128}$/.test(input.requestId)) throw new Error('保存请求无效');
            result = await (await services.documentClient()).save(input);
            break;
          }
          case 'saveGet':
            if (typeof data.requestId !== 'string' || !/^[\w-]{1,128}$/.test(data.requestId)) throw new Error('保存查询标识无效');
            result = await (await services.documentClient()).saveGet(data.requestId); break;
          default: throw new Error('不支持的文件窗口操作');
        }
        if (!disposed) channel.postMessage({ kind: 'result', id: data.id, result });
      } catch (error) {
        if (!disposed) channel.postMessage({ kind: 'result', id: data.id, error: String(error) });
      } finally { inflight--; }
    }
    else if (data?.kind === 'read' && (services || snapshot.preview.isHtml) && Number.isSafeInteger(data.id)) {
      if (inflight >= 8) { channel.postMessage({ kind: 'resource', id: data.id, error: '资源读取过多，请稍后重试' }); return; }
      inflight++;
      try {
        const rel = typeof data.rel === 'string' ? normalizeRelativeFilePath(data.rel) : null;
        if (!rel) throw new Error('预览资源路径无效');
        const bytes = await readFile(rel);
        if (!disposed) channel.postMessage({ kind: 'resource', id: data.id, bytes });
      } catch (error) {
        if (!disposed) channel.postMessage({ kind: 'resource', id: data.id, error: String(error) });
      } finally { inflight--; }
    }
  };
  window.addEventListener('pagehide', dispose);
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('filePreview', id);
  const opened = openDetachedWindow({ label: `file-preview-${id}`, title: `${snapshot.preview.name} · 预览 — AgentWithU`,
    url: `${url.pathname}${url.search}`, width: 1100, height: 800, minWidth: 400, minHeight: 320 })
    .catch(error => { dispose(); throw error; });
  return { opened, dispose };
}
