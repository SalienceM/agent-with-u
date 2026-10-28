import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewWindowSnapshot } from '../utils/previewWindow';
import { MarkdownPreview } from './MarkdownPreview';
import { StructuredFilePreview } from './StructuredFilePreview';
import { isDesktopWindow } from '../utils/detachedWindow';
import { DetachedTextDocument } from './DetachedTextDocument';
import type { DocumentClient } from '../utils/documentStore';

const PdfPreview = lazy(() => import('./PdfPreview'));
const DocxPreview = lazy(() => import('./DocxPreview'));
const DrawioPreview = lazy(() => import('./DrawioPreview'));
const HtmlPreview = lazy(() => import('./HtmlPreview'));
const canNavigate = () => window.dispatchEvent(new Event('awu-preview-before-navigate', { cancelable: true }));

export const FilePreviewWindow: React.FC = () => {
  const [snapshot, setSnapshot] = useState<PreviewWindowSnapshot | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [fullDocument, setFullDocument] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [navigationRevision, setNavigationRevision] = useState(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const requests = useRef(new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>());
  const seq = useRef(0);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('filePreview');
    if (!id || !/^[\w-]{1,128}$/.test(id)) { setError('预览窗口标识无效'); return; }
    const bc = new BroadcastChannel(`awu-file-preview-${id}`);
    channel.current = bc;
    const timeout = window.setTimeout(() => setError('未连接到原文件窗口，请回到原窗口重新打开。'), 12000);
    const rejectPending = () => {
      requests.current.forEach(request => { window.clearTimeout(request.timer); request.reject(new Error('原文件窗口已断开')); });
      requests.current.clear();
    };
    bc.onmessage = ({ data }) => {
      if (data?.kind === 'snapshot') {
        window.clearTimeout(timeout); setSnapshot(data.snapshot); setConnected(true); setError(''); setFullDocument(data.fullDocument === true);
        document.title = `${data.snapshot.preview.name} · 预览 — AgentWithU`;
      } else if (data?.kind === 'disconnected') {
        setConnected(false); setSnapshot(null); setError('原预览窗口已关闭或切换身份，请重新打开预览。'); rejectPending();
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
    return () => { window.clearTimeout(timeout); window.removeEventListener('pagehide', closed); closed(); bc.close(); channel.current = null; rejectPending(); };
  }, []);
  const call = useCallback((kind: string, args: object): Promise<any> => new Promise((resolve, reject) => {
    if (!channel.current || !connected) { reject(new Error('原文件窗口已断开')); return; }
    const id = ++seq.current;
    const timer = window.setTimeout(() => { requests.current.delete(id); reject(new Error('文件操作超时；保存结果须核对，不能重复写入')); }, 30000);
    requests.current.set(id, { resolve, reject, timer }); channel.current.postMessage({ kind, id, ...args });
  }), [connected]);
  const request = useCallback((method: string, args: object = {}) => call('request', { method, ...args }), [call]);
  const readFile = useCallback((rel: string): Promise<Uint8Array> => call('read', { rel }), [call]);
  const documentClient = useCallback(async (): Promise<DocumentClient> => {
    const metadata = await request('document');
    return { ...metadata, read: rel => request('read', { rel }), save: input => request('save', { request: input }), saveGet: requestId => request('saveGet', { requestId }) };
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
    let active = true, unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onCloseRequested(event => { if (!canNavigate()) event.preventDefault(); });
      if (active) unlisten = off; else off();
    }).catch(reason => setError(String(reason)));
    return () => { active = false; unlisten?.(); };
  }, []);
  const close = () => {
    if (!canNavigate()) return;
    if (isDesktopWindow()) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close()).catch(reason => setError(String(reason)));
    else window.close();
  };
  const preview = snapshot?.preview;
  const reveal = () => { if (preview) void request('reveal', { rel: preview.rel }).then(() => setNotice('已在原文件窗口定位。')).catch(reason => setError(String(reason))); };
  const renderText = (text: string) => snapshot && preview && (preview.isHtml
    ? <HtmlPreview source={text} rel={preview.rel} root={snapshot.root} nodeLabel={snapshot.nodeLabel} fragment={preview.htmlFragment}
      readFile={readFile} onReveal={reveal} onNavigate={(rel, fragment) => void navigate(rel, fragment)} />
    : preview.isMarkdown ? <MarkdownPreview source={text} title={preview.name} initialDark={snapshot.dark} />
      : <pre style={{ margin: 0, padding: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</pre>);
  return <div className="app-root" style={{ ...snapshot?.theme, height: '100dvh', display: 'flex', flexDirection: 'column',
    background: 'var(--theme-bg, #151c27)', color: 'var(--theme-text, #e2e8f0)', fontFamily: 'system-ui', overflow: 'hidden' } as React.CSSProperties}>
    <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--theme-border)', flexShrink: 0 }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 13 }}>{preview?.name || '文件预览'}</span>
      {preview && fullDocument && <>
        <button style={buttonStyle} onClick={reveal}>定位</button>
        <button style={buttonStyle} disabled={busy} onClick={() => void navigate(preview.rel, preview.htmlFragment)}>重新加载</button>
        {['md', 'markdown', 'mdx', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(preview.name.split('.').pop()?.toLowerCase() || '') && preview.source !== 'local'
          && <button style={buttonStyle} onClick={() => void request('review', { rel: preview.rel }).then(() => setNotice('已在原文件窗口打开审阅工作台。')).catch(reason => setError(String(reason)))}>审阅</button>}
      </>}
      {isDesktopWindow() && <button style={buttonStyle} onClick={() => void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        await getCurrentWindow().setAlwaysOnTop(!pinned); setPinned(!pinned);
      }).catch(reason => setError(String(reason)))}>{pinned ? '取消置顶' : '置顶'}</button>}
      <button style={buttonStyle} onClick={close}>关闭窗口</button>
    </header>
    {error && <div role="alert" style={{ padding: 12, color: '#f87171' }}>{error}</div>}
    {notice && <div role="status" style={{ padding: '6px 12px', fontSize: 12 }}>{notice}</div>}
    {!snapshot && !error && <p role="status" style={{ padding: 16 }}>正在连接原文件窗口…</p>}
    {snapshot && preview && <>
      <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--theme-text-muted)', overflowWrap: 'anywhere' }}>{snapshot.nodeLabel} · {preview.rel} · {fullDocument ? '原文件预览 / 编辑' : '只读预览'}</div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <Suspense fallback={<div role="status" style={{ padding: 16 }}>加载预览…</div>}>
          {fullDocument && !preview.isImage && !preview.renderer && !preview.structured
            ? <DetachedTextDocument key={`${preview.rel}:${preview.source}:${navigationRevision}`} preview={preview} dark={snapshot.dark} client={documentClient}
              initialView={snapshot.initialView}
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
const buttonStyle: React.CSSProperties = { padding: '5px 9px', color: 'inherit', background: 'var(--theme-bg-secondary)',
  border: '1px solid var(--theme-border)', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap' };
