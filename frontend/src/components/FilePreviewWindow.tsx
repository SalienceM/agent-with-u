import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewWindowSnapshot } from '../utils/previewWindow';
import { MarkdownPreview } from './MarkdownPreview';
import { StructuredFilePreview } from './StructuredFilePreview';
import { isDesktopWindow } from '../utils/detachedWindow';
import { DetachedTextDocument } from './DetachedTextDocument';
import type { DocumentClient } from '../utils/documentStore';
import { FilePreviewToolbar, previewToolbarButtonStyle as buttonStyle } from './FilePreviewToolbar';
import { WorkbenchPopover } from './WorkbenchChrome';
import { useIndependentPreview } from '../hooks/useIndependentPreview';
import { getPreviewIdentity, observePreviewIdentity } from '../api';
import { samePreviewIdentity } from '../utils/previewLifecycle';
import { documentStore } from '../utils/documentStore';
import { documentDrafts } from '../utils/documentDrafts';

const PdfPreview = lazy(() => import('./PdfPreview'));
const DocxPreview = lazy(() => import('./DocxPreview'));
const DrawioPreview = lazy(() => import('./DrawioPreview'));
const HtmlPreview = lazy(() => import('./HtmlPreview'));
const canNavigate = () => window.dispatchEvent(new Event('awu-preview-before-navigate', { cancelable: true }));

export const FilePreviewWindow: React.FC = () => {
  const independent = new URLSearchParams(location.search).get('previewVersion') === '2';
  const own = useIndependentPreview(independent);
  const [legacySnapshot, setLegacySnapshot] = useState<PreviewWindowSnapshot | null>(null);
  const [legacyError, setLegacyError] = useState('');
  const [legacyConnected, setConnected] = useState(false);
  const snapshot = independent ? own.snapshot : legacySnapshot;
  const setSnapshot = independent ? own.setSnapshot : setLegacySnapshot;
  const error = independent ? own.error : legacyError;
  const setError = independent ? own.setError : setLegacyError;
  const connected = independent ? own.phase === 'ready' : legacyConnected;
  const [pinned, setPinned] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [closeReady, setCloseReady] = useState(!isDesktopWindow());
  const [textToolbar, setTextToolbar] = useState<HTMLDivElement | null>(null);
  const [textState, setTextState] = useState({ dirty: false, editing: false });
  const [legacyFullDocument, setFullDocument] = useState(false);
  const fullDocument = independent || legacyFullDocument;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [navigationRevision, setNavigationRevision] = useState(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const requests = useRef(new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>());
  const seq = useRef(0);
  // 授权撤销会卸载正文，但不能一并移除未保存/未知回执的退出守卫。
  useEffect(() => {
    if (!independent || own.phase !== 'revoked') return;
    const pending = () => documentStore.all().filter(doc => doc.dirty || doc.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || ''));
    for (const doc of pending()) void documentDrafts.flush(doc.key).catch(() => {});
    const guard = (event: Event) => {
      const docs = pending(); if (!docs.length) return;
      if (event.type === 'beforeunload') { event.preventDefault(); (event as BeforeUnloadEvent).returnValue = ''; return; }
      const persisted = docs.every(doc => ['saved', 'restored'].includes(doc.persistence || ''));
      if (!persisted || !window.confirm('原身份的未保存草稿/待核对保存已隔离保留。关闭此窗口不会保存或重试写入；以后须以原身份恢复。仍要关闭？')) event.preventDefault();
    };
    window.addEventListener('awu-preview-before-navigate', guard); window.addEventListener('beforeunload', guard);
    return () => { window.removeEventListener('awu-preview-before-navigate', guard); window.removeEventListener('beforeunload', guard); };
  }, [independent, own.phase]);
  useEffect(() => {
    if (independent) return;
    const identity = getPreviewIdentity(); let valid = true;
    const id = new URLSearchParams(location.search).get('filePreview');
    if (!id || !/^[\w-]{1,128}$/.test(id)) { setError('预览窗口标识无效'); return; }
    const bc = new BroadcastChannel(`awu-file-preview-${id}`);
    channel.current = bc;
    const timeout = window.setTimeout(() => setError('未连接到原文件窗口，请回到原窗口重新打开。'), 12000);
    const rejectPending = () => {
      requests.current.forEach(request => { window.clearTimeout(request.timer); request.reject(new Error('原文件窗口已断开')); });
      requests.current.clear();
    };
    const off = observePreviewIdentity(() => {
      if (samePreviewIdentity(identity, getPreviewIdentity())) return;
      valid = false; setSnapshot(null); setConnected(false); rejectPending();
      setError('账号或身份域已变化，旧版预览内容已隔离。'); document.title = '文件预览 · 身份已变化';
    });
    bc.onmessage = ({ data }) => {
      if (!valid || !samePreviewIdentity(identity, getPreviewIdentity())) return;
      if (data?.kind === 'snapshot') {
        window.clearTimeout(timeout); setSnapshot(data.snapshot); setConnected(true); setError(''); setFullDocument(data.fullDocument === true);
        document.title = `${data.snapshot.preview.name} · 预览 — AgentWithU`;
      } else if (data?.kind === 'disconnected') {
        valid = false; setConnected(false); setSnapshot(null); setError('此为旧版代理预览，连接已结束且无法核验完整来源。请重新打开文件使用独立预览。'); rejectPending();
      } else if (data?.kind === 'resource' || data?.kind === 'result') {
        const pending = requests.current.get(data.id);
        if (!pending) return;
        requests.current.delete(data.id); window.clearTimeout(pending.timer);
        data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.kind === 'resource' ? data.bytes : data.result);
      }
    };
    bc.postMessage({ kind: 'ready' });
    const closed = () => bc.postMessage({ kind: 'closed' });
    window.addEventListener('pagehide', closed);
    return () => { off(); window.clearTimeout(timeout); window.removeEventListener('pagehide', closed); closed(); bc.close(); channel.current = null; rejectPending(); };
  }, []);
  const call = useCallback((kind: string, args: object): Promise<any> => new Promise((resolve, reject) => {
    if (!channel.current || !connected) { reject(new Error('原文件窗口已断开')); return; }
    const id = ++seq.current;
    const timer = window.setTimeout(() => { requests.current.delete(id); reject(new Error('文件操作超时；保存结果须核对，不能重复写入')); }, 30000);
    requests.current.set(id, { resolve, reject, timer }); channel.current.postMessage({ kind, id, ...args });
  }), [connected]);
  // 连接状态更新不能改变 HTML 资源读取器的身份，否则会重建 iframe、丢失阅读状态。
  const legacyCall = useRef(call); legacyCall.current = call;
  const request = useCallback((method: string, args: { rel?: string } = {}): Promise<any> => {
    if (!independent) return call('request', { method, ...args });
    const access = own.access.current;
    if (!access) return Promise.reject(new Error('文件来源尚未初始化'));
    if (method === 'load') return access.load(args.rel);
    if (method === 'structured') return access.structured(args.rel!);
    if (method === 'reveal' || method === 'review') return own.navigateUi(method, args.rel!);
    return Promise.reject(new Error('不支持的文件窗口操作'));
  }, [call, independent, own.phase]);
  const readFile = useCallback((rel: string): Promise<Uint8Array> => independent
    ? own.access.current ? own.access.current.readFile(rel) : Promise.reject(new Error('文件来源尚未初始化')) : legacyCall.current('read', { rel }), [independent]);
  const documentClient = useCallback(async (): Promise<DocumentClient> => {
    if (independent) {
      if (!own.access.current) throw new Error('文件来源尚未初始化');
      return own.access.current.documentClient();
    }
    const metadata = await call('request', { method: 'document' });
    return { ...metadata, read: rel => call('request', { method: 'read', rel }), save: input => call('request', { method: 'save', request: input }), saveGet: requestId => call('request', { method: 'saveGet', requestId }) };
  }, [request]);
  const navigate = async (rel: string, fragment = '') => {
    if (busy || !canNavigate()) return;
    setBusy(true); setError('');
    try {
      const loaded = await request('load', { rel });
      setSnapshot(current => current ? { ...current, preview: { ...loaded, htmlFragment: fragment } } : current);
      setNavigationRevision(value => value + 1);
      document.title = `${loaded.name} · 预览 — AgentWithU`;
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!isDesktopWindow()) return;
    let active = true, closing = false;
    const listeners: (() => void)[] = [];
    const keep = (off: () => void) => { if (active) listeners.push(off); else off(); };
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      keep(await current.onCloseRequested(async event => {
        // 标题栏 X 与页面关闭共用守卫。显式接管销毁以便权限/原生错误能显示，
        // 而不是让 SDK 的隐式 destroy 失败后留下一个没有反馈的窗口。
        event.preventDefault();
        if (!active || closing || !canNavigate()) return;
        closing = true;
        try { if (independent) await own.closed(); await current.destroy(); }
        catch (reason) { if (active) setError(`关闭窗口失败：${String(reason)}`); }
        finally { closing = false; }
      }));
      if (active) setCloseReady(true);
      const updateMaximized = async () => { const value = await current.isMaximized(); if (active) setMaximized(value); };
      keep(await current.onResized(() => { void updateMaximized().catch(reason => { if (active) setError(String(reason)); }); }));
      await updateMaximized();
    }).catch(reason => setError(String(reason)));
    return () => { active = false; listeners.forEach(off => off()); };
  }, []);
  const close = () => {
    if (isDesktopWindow()) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close()).catch(reason => setError(String(reason)));
    else if (canNavigate()) { if (independent) void own.closed().then(() => window.close()); else window.close(); }
  };
  const preview = snapshot?.preview;
  useEffect(() => {
    const title = independent && own.phase === 'revoked' ? '文件预览 · 身份已变化'
      : preview ? `${preview.name} · 预览 — AgentWithU` : '文件预览 — AgentWithU';
    document.title = title;
    let active = true;
    if (isDesktopWindow()) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (active) return getCurrentWindow().setTitle(title);
    }).catch(() => {});
    return () => { active = false; };
  }, [preview?.name, independent, own.phase]);
  const reveal = () => { if (preview) void request('reveal', { rel: preview.rel }).then(() => setNotice('已在原文件窗口定位。')).catch(reason => setError(String(reason))); };
  const renderText = (text: string) => snapshot && preview && (preview.isHtml
    ? <HtmlPreview source={text} rel={preview.rel} root={snapshot.root} nodeLabel={snapshot.nodeLabel} fragment={preview.htmlFragment}
      readFile={readFile} onReveal={reveal} onNavigate={(rel, fragment) => void navigate(rel, fragment)} />
    : preview.isMarkdown ? <MarkdownPreview source={text} title={preview.name} initialDark={snapshot.dark} />
      : <pre style={{ margin: 0, padding: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</pre>);
  return <div className="app-root" data-preview-connected={connected} style={{ ...snapshot?.theme, height: '100dvh', display: 'flex', flexDirection: 'column',
    background: 'var(--theme-bg-secondary, #161b22)', color: 'var(--theme-text, #c9d1d9)', fontFamily: 'system-ui', overflow: 'hidden' } as React.CSSProperties}>
    <FilePreviewToolbar name={preview?.name || '文件预览'} relativePath={preview?.rel || ''} source={preview?.source || 'remote'}
      nodeLabel={snapshot?.nodeLabel} dirty={textState.dirty}
      icon={preview?.isImage ? '🖼️' : preview?.renderer === 'pdf' ? '📕' : preview?.renderer === 'docx' ? '📘' : preview?.renderer === 'drawio' ? '🧩' : preview?.structured ? '📊' : textState.editing ? '✏️' : '📄'}
      trailing={<>
        {isDesktopWindow() && <button style={buttonStyle} title={maximized ? '退出最大化' : '最大化预览'} onClick={() => {
          void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
            const current = getCurrentWindow(); await current.toggleMaximize(); setMaximized(await current.isMaximized());
          }).catch(reason => setError(String(reason)));
        }}>{maximized ? '🗗 还原' : '⛶ 最大化'}</button>}
        <button style={buttonStyle} disabled={!closeReady} onClick={close} title="关闭预览" aria-label="关闭预览">✕</button>
      </>}>
      {preview && fullDocument && <>
        <button style={buttonStyle} onClick={reveal} title="在原文件窗口定位">📂 定位</button>
        {!textState.editing && ['md', 'markdown', 'mdx', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(preview.name.split('.').pop()?.toLowerCase() || '') && preview.source !== 'local'
          && <button style={{ ...buttonStyle, borderColor: 'color-mix(in srgb, var(--theme-accent) 45%, var(--theme-border))', color: 'var(--theme-accent)' }}
            onClick={() => void request('review', { rel: preview.rel }).then(() => setNotice('已在原文件窗口打开审阅工作台。')).catch(reason => setError(String(reason)))}>✦ 审阅</button>}
      </>}
      <div ref={setTextToolbar} style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }} />
      <WorkbenchPopover label="预览窗口操作" triggerStyle={buttonStyle}>
        {dismiss => <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {snapshot && preview && <div style={{ fontSize: 11, overflowWrap: 'anywhere', color: 'var(--theme-text-muted)' }}>
            {snapshot.nodeLabel} · {snapshot.root}/{preview.rel} · {fullDocument ? '原文件预览 / 编辑' : '只读预览'}
          </div>}
          {preview && fullDocument && <button style={buttonStyle} disabled={busy || !connected} onClick={() => { dismiss(); void navigate(preview.rel, preview.htmlFragment); }}>↻ 重新加载</button>}
          {isDesktopWindow() && <button style={buttonStyle} onClick={() => void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
            await getCurrentWindow().setAlwaysOnTop(!pinned); setPinned(!pinned); dismiss();
          }).catch(reason => setError(String(reason)))}>{pinned ? '取消置顶' : '置顶'}</button>}
        </div>}
      </WorkbenchPopover>
    </FilePreviewToolbar>
    {error && <div role="alert" style={{ padding: 12, color: '#f87171', maxHeight: '25%', overflow: 'auto', overflowWrap: 'anywhere', flexShrink: 0 }}>{error}
      {independent && !snapshot && own.source && own.phase !== 'revoked' && <div style={{ fontSize: 11 }}>
        固定来源：{own.source.executor} · {own.source.source === 'local' ? own.source.local!.root : own.source.workingDir}/{own.source.relative}
      </div>}
      {independent && !['revoked', 'invalidated', 'closed'].includes(own.phase) && <button style={buttonStyle} onClick={() => void own.retry()}>重新连接 / 核对来源</button>}
    </div>}
    {notice && <div role="status" style={{ padding: '6px 12px', fontSize: 12 }}>{notice}</div>}
    {!snapshot && !error && <p role="status" style={{ padding: 16 }}>{independent ? '正在核验并读取文件来源…' : '正在连接旧版文件窗口…'}</p>}
    {snapshot && preview && <>
      <div data-preview-reading style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto', overscrollBehavior: 'contain' }}>
        <Suspense fallback={<div role="status" style={{ padding: 16 }}>加载预览…</div>}>
          {fullDocument && !preview.isImage && !preview.renderer && !preview.structured
            ? <DetachedTextDocument key={`${preview.rel}:${preview.source}:${navigationRevision}`} preview={preview} dark={snapshot.dark} client={documentClient}
              ioAvailable={connected}
              initialView={snapshot.initialView}
              toolbarHost={textToolbar} onDocumentState={setTextState}
              renderPreview={renderText} onSaved={() => setNotice('已保存；重新加载可核对磁盘内容。')} />
            : preview.isImage ? <img src={preview.dataUrl} alt={preview.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            : preview.renderer === 'pdf' && preview.bytes ? <PdfPreview data={preview.bytes} />
            : preview.renderer === 'docx' && preview.bytes ? <DocxPreview data={preview.bytes} onFallback={() => {
              if (!fullDocument) { setError('此 Word 文件无法完整渲染，请在原窗口查看备用预览。'); return; }
              void request('structured', { rel: preview.rel }).then(structured => setSnapshot(current => current ? {
                ...current, preview: { ...current.preview, renderer: undefined, structured },
              } : current)).catch(reason => setError(String(reason)));
            }} />
            : preview.renderer === 'drawio' && preview.drawioXml ? <DrawioPreview xml={preview.drawioXml} fallback={preview.structured} onReveal={reveal} />
            : preview.structured ? <StructuredFilePreview preview={preview.structured} onReveal={reveal} /> : renderText(preview.text || '')}
        </Suspense>
      </div>
    </>}
  </div>;
};
