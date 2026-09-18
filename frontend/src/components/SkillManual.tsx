import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Marked, Renderer } from 'marked';
import { api, getCurrentUserProfile, getExecutors, onCurrentUserChanged } from '../api';
import { useConfig, themes } from '../hooks/useConfig';
import { openSkillManual, type SkillManual as ManualData } from '../utils/skillManual';
import { AppModalPortal } from './AppModalPortal';
import { isDesktopWindow } from '../utils/detachedWindow';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 不复用聊天的宽松 HTML renderer；第三方手册不得取得应用 DOM、脚本或网络权限。
const renderer = new Renderer();
renderer.html = text => escape(text);
renderer.image = (_href, _title, text) => `<span>[图片：${escape(text)}]</span>`;
renderer.link = (_href, _title, text) => `<span>${text}</span>`;
renderer.code = text => `<pre><code>${escape(text)}</code></pre>`;
const markdown = new Marked({ renderer, gfm: true, breaks: true });

export const SkillManual: React.FC<{ name: string; execKey: string; onClose?: () => void; standalone?: boolean }> = ({ name, execKey, onClose, standalone }) => {
  const [data, setData] = useState<ManualData | null>(null);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'manual' | 'original' | 'edit'>('manual');
  const [sourceView, setSourceView] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [identity, setIdentity] = useState(0);
  const [pinned, setPinned] = useState(false);
  const generation = useRef(0);
  const dirty = !!data && draft !== data.content;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const reload = useCallback(async (document = '') => {
    const id = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = await api.getSkillManual(name, execKey, document);
      if (generation.current !== id) return;
      setData(result); setDraft(result.content);
    } catch (reason) { if (generation.current === id) setError(String(reason)); }
    finally { if (generation.current === id) setLoading(false); }
  }, [name, execKey]);
  useEffect(() => { setData(null); setDraft(''); void reload(); return () => { ++generation.current; }; }, [reload, identity]);
  useEffect(() => onCurrentUserChanged(() => { ++generation.current; setData(null); setDraft(''); setIdentity(v => v + 1); }), []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  const save = async () => {
    if (!data || saving) return;
    const id = generation.current;
    setSaving(true); setError('');
    try {
      const result = await api.saveSkillManual(name, draft, data.revision, execKey, data.originalPath);
      if (id !== generation.current) return;
      setData(result); setDraft(result.content); setView('manual'); setNotice('手册已保存；不会修改 SKILL.md 或启用 Skill。');
    } catch (reason) { if (id === generation.current) setError(String(reason)); }
    finally { if (id === generation.current) setSaving(false); }
  };
  const safeReload = (path?: string) => {
    if (dirty && !window.confirm('放弃未保存的手册草稿并重新读取？')) return;
    void reload(path);
  };
  const close = () => {
    if (saving || (dirty && !window.confirm('手册草稿尚未保存，仍要关闭？'))) return;
    if (onClose) onClose();
    else if (standalone && isDesktopWindow()) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close()).catch(reason => setError(String(reason)));
    else if (standalone) window.close();
  };
  const togglePin = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setAlwaysOnTop(!pinned); setPinned(!pinned);
    } catch (reason) { setError(String(reason)); }
  };
  const content = view === 'original' ? data?.originalContent || '' : data?.content || '';
  const srcDoc = useMemo(() => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{background:#151c27;color:#e2e8f0;font:15px/1.75 system-ui;padding:20px;overflow-wrap:anywhere}pre{overflow:auto;background:#0c111b;padding:12px;border-radius:8px}code{font-family:Consolas,monospace}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #526070;padding:6px}blockquote{border-left:3px solid #739cff;padding-left:12px}a{color:#739cff}</style>${markdown.parse(content)}`, [content]);
  const panel = <section role="dialog" aria-label="Skill 使用手册" style={{ ...shell, ...(standalone ? { position: 'absolute', inset: 0, width: '100%', height: '100%', borderRadius: 0 } : {}) }}>
    <header style={row}><strong style={{ flex: 1, overflowWrap: 'anywhere' }}>📖 {name} · 使用手册{dirty ? ' ●' : ''}</strong>
      {!standalone && <button style={button} onClick={() => void openSkillManual(name, execKey).catch(reason => setError(String(reason)))}>独立窗口</button>}
      {standalone && isDesktopWindow() && <button style={button} aria-pressed={pinned} onClick={() => void togglePin()}>{pinned ? '取消置顶' : '窗口置顶'}</button>}
      {(onClose || standalone) && <button style={button} disabled={saving} onClick={close}>关闭</button>}
    </header>
    <div style={{ padding: '8px 12px', fontSize: 12, overflowWrap: 'anywhere', color: 'var(--theme-text-muted, #a8b1c0)' }}>
      执行节点：{getExecutors().find(item => item.key === execKey)?.label || execKey} · @SKILL:{name}
      <div>阅读与引用不会安装、绑定或运行 Skill。原始资料与维护手册独立保存。</div>
      <div>安全预览不执行脚本、不加载外部图片，文档链接仅显示文字。</div>
      {data && <div>{data.hasManual ? '维护手册' : `尚未维护，使用 ${data.originalPath} 原文`} · {data.source.repository || '本节点资料'} {data.updatedAt ? `· ${new Date(data.updatedAt * 1000).toLocaleString()}` : ''}</div>}
      {data && <div>资料版本：{(data.revision || data.sourceHash).slice(0, 12)} {data.source.ref || ''} · {data.originalPath}</div>}
      {data?.outdated && <div role="status" style={{ color: '#efbd64' }}>原始资料已更新，请复核维护手册。</div>}
    </div>
    <nav style={row}>
      <button style={button} onClick={() => setView('manual')} aria-pressed={view === 'manual'}>使用手册</button>
      <button style={button} onClick={() => setView('original')} aria-pressed={view === 'original'}>原始文档</button>
      <button style={button} disabled={!data} onClick={() => setView('edit')}>维护手册</button>
      <button style={button} disabled={loading || saving} onClick={() => safeReload()}>刷新</button>
      {view !== 'edit' && <button style={button} onClick={() => setSourceView(v => !v)}>{sourceView ? '渲染预览' : '源码'}</button>}
      {view === 'original' && data && <select aria-label="原始文档文件" value={data.originalPath} disabled={loading || saving} onChange={event => safeReload(event.target.value)} style={button}>{data.documents.map(path => <option key={path}>{path}</option>)}</select>}
    </nav>
    {error && <div role="alert" style={{ padding: 12, color: '#ff9797', overflowWrap: 'anywhere' }}>{error}</div>}
    {notice && <div role="status" style={{ padding: '4px 12px', fontSize: 12 }}>{notice}</div>}
    {loading ? <div style={{ padding: 20 }}>正在读取手册…</div> : data ? view === 'edit' ? <>
      <textarea aria-label="使用手册 Markdown" value={draft} onChange={event => setDraft(event.target.value)} disabled={saving} maxLength={128000}
        style={{ flex: 1, minHeight: 100, margin: 12, padding: 12, resize: 'none', color: 'inherit', background: 'var(--theme-input-bg, #101720)', border: '1px solid #526070', font: '13px/1.6 Consolas,monospace' }} />
      <div style={row}><span style={{ flex: 1, fontSize: 12 }}>建议包含：用途、前置条件、流程、命令示例、常见错误。{draft.length}/128000</span><button style={button} disabled={saving || !dirty || !draft.trim()} onClick={() => void save()}>{saving ? '保存中…' : '保存手册'}</button></div>
    </> : sourceView ? <pre style={{ flex: 1, margin: 0, padding: 20, whiteSpace: 'pre-wrap', overflow: 'auto', overflowWrap: 'anywhere' }}>{content}</pre>
      : <iframe title="手册渲染预览" sandbox="" srcDoc={srcDoc} style={{ flex: 1, width: '100%', minHeight: 100, border: 0 }} /> : null}
  </section>;
  return standalone ? panel : <AppModalPortal>{panel}</AppModalPortal>;
};

export const SkillManualWindow: React.FC = () => {
  const query = new URLSearchParams(location.search);
  const name = query.get('skillName') || '', execKey = query.get('skillExecKey') || '';
  const { config } = useConfig(getCurrentUserProfile());
  const palette = themes[config.theme] || themes.dark;
  useEffect(() => { document.title = `${name} · 使用手册 — AgentWithU`; }, [name]);
  return <div style={{ height: '100vh', color: palette.text, '--theme-bg': palette.bg,
    '--theme-text': palette.text, '--theme-text-muted': palette.textMuted, '--theme-border': palette.border,
    '--theme-input-bg': palette.inputBg, '--theme-bg-secondary': palette.bgSecondary } as React.CSSProperties}>
    {name && execKey ? <SkillManual name={name} execKey={execKey} standalone /> : <div role="alert">缺少手册名称或执行节点，不能猜测读取位置。</div>}
  </div>;
};
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--theme-border, #364152)' };
const button: React.CSSProperties = { padding: '5px 9px', borderRadius: 6, cursor: 'pointer', color: 'inherit', background: 'var(--theme-bg-secondary, #202c3d)', border: '1px solid var(--theme-border, #526070)', fontSize: 12 };
const shell: React.CSSProperties = { position: 'fixed', zIndex: 35000, top: '7vh', left: 'max(8px, calc((100vw - 1000px) / 2))', width: 'min(1000px, calc(100vw - 16px))', height: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--theme-bg, #151c27)', color: 'var(--theme-text, #e2e8f0)', border: '1px solid var(--theme-border, #364152)', borderRadius: 12, boxShadow: '0 20px 80px #0008', fontFamily: 'system-ui' };
