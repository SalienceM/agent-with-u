import React, { useEffect, useRef, useState } from 'react';
import { buildHtmlPreview, HTML_PREVIEW_ORIGIN, previewRelativePath, resolvePreviewUrl, previewFileUrl } from '../utils/htmlPreview';
import { htmlPreviewRuntime } from '../utils/htmlPreviewRuntime';

interface Props {
  source: string; rel: string; root: string; nodeLabel: string; hidden?: boolean; fragment?: string;
  readFile: (rel: string) => Promise<Uint8Array>;
  onNavigate: (rel: string, fragment: string) => void;
  onReveal: () => void;
}

const HtmlPreview: React.FC<Props> = ({ source, rel, root, nodeLabel, hidden, fragment, readFile, onNavigate, onReveal }) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const navigate = useRef(onNavigate); navigate.current = onNavigate;
  const [srcDoc, setSrcDoc] = useState('');
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [external, setExternal] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [interactive, setInteractive] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const channel = `html-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setLoading(true); setError(''); setWarnings([]); setExternal('');
    let bundle: Awaited<ReturnType<typeof buildHtmlPreview>> | null = null;
    let requests = 0;
    const notify = (message: string) => setWarnings(previous => previous.includes(message) ? previous : [...previous, message].slice(-20));
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'awu-html-preview' || event.data.channel !== channel || controller.signal.aborted) return;
      const data = event.data;
      if (data.kind === 'notice' && typeof data.message === 'string') { notify(data.message.slice(0, 500)); return; }
      if (typeof data.url !== 'string' || data.url.length > 4096) return;
      if (data.kind === 'navigate') {
        try {
          const url = resolvePreviewUrl(data.url, previewFileUrl(rel), root);
          if (new URL(url).origin === HTML_PREVIEW_ORIGIN) navigate.current(previewRelativePath(url), new URL(url).hash);
          else if (/^https?:/i.test(url)) setExternal(url);
          else notify('该链接协议不支持在静态预览中打开');
        } catch (reason) { notify(String(reason)); }
      } else if (data.kind === 'read' && Number.isSafeInteger(data.id) && bundle) {
        // 即使 iframe 内容伪造消息，也只能触达这一份只读、限量的资源读取器。
        const target = event.source as Window;
        const reply = (value: object) => {
          if (!controller.signal.aborted) target.postMessage({ type: 'awu-html-preview-result', channel, id: data.id, ...value }, '*');
        };
        if (requests >= 8) { reply({ error: '预览并发读取过多' }); return; }
        requests++;
        try { reply(await bundle.read(data.url)); }
        catch (reason) { reply({ error: String(reason) }); }
        finally { requests--; }
      }
    };
    window.addEventListener('message', onMessage);
    void buildHtmlPreview({ source, rel, root, channel, interactive, fragment, runtime: htmlPreviewRuntime.toString(), readFile, signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        bundle = result; setSrcDoc(result.srcDoc); setWarnings(result.warnings); setLoading(false);
      }).catch(reason => { if (!controller.signal.aborted) { setError(String(reason)); setLoading(false); } });
    return () => { controller.abort(); window.removeEventListener('message', onMessage); };
  }, [source, rel, root, readFile, revision, interactive, fragment]);

  const actual = `${root.replace(/[\\/]$/, '')}/${rel}`;
  return <div style={{ display: hidden ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', minHeight: 32, borderBottom: '1px solid var(--theme-border)', fontSize: 11 }}>
      <button onClick={onReveal} title={`在原文件所在节点定位：${actual}`} style={{ ...buttonStyle, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>实际位置 · {nodeLabel} · {actual}</button>
      <button style={{ ...buttonStyle, whiteSpace: 'nowrap' }} aria-pressed={interactive} title="仅对可信页面启用：脚本可读取本工作目录内的静态资源；不会获得 AgentWithU 的登录态或写文件接口。" onClick={() => setInteractive(value => !value)}>{interactive ? '脚本交互已启用' : '启用页面脚本'}</button>
      <button style={buttonStyle} onClick={() => setRevision(value => value + 1)}>重载资源</button>
    </div>
    <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--theme-text-muted)' }}>浏览器渲染 · 同目录资源按原节点读取 · 脚本隔离运行；外部 CDN、写入 API、登录和服务端路由需实际运行服务。</div>
    {warnings.length > 0 && <details style={{ padding: '4px 10px', fontSize: 11, maxHeight: 100, overflow: 'auto', color: '#d29922' }}>
      <summary>页面加载提示（{warnings.length}）</summary>{warnings.map((message, index) => <div key={index}>{message}</div>)}
    </details>}
    {external && <div style={{ padding: 8, fontSize: 12 }}>这是外部链接，确认后可在浏览器打开： <a href={external} target="_blank" rel="noopener noreferrer">{external}</a> <button onClick={() => setExternal('')}>取消</button></div>}
    {loading ? <div role="status" style={{ padding: 20 }}>正在从原节点读取页面资源…</div>
      : error ? <div role="alert" style={{ padding: 20, color: '#f87171' }}>{error} <button onClick={() => setRevision(value => value + 1)}>重试</button></div>
        : <iframe ref={frame} title="HTML 页面预览" srcDoc={srcDoc} sandbox="allow-scripts" referrerPolicy="no-referrer"
          style={{ width: '100%', flex: 1, minHeight: 240, border: 0, background: '#fff' }} />}
  </div>;
};
const buttonStyle: React.CSSProperties = { cursor: 'pointer', background: 'transparent', border: '1px solid var(--theme-border)', borderRadius: 4, color: 'var(--theme-text)', padding: '3px 6px', fontSize: 11 };
export default HtmlPreview;
