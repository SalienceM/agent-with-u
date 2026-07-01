/**
 * FileTreePanel — 会话工作目录的**单一**文件树(替代原「远端 / 本地」两棵树)。
 *
 * 参照群晖(Synology Drive)的"在线/离线"逻辑:一棵树,每个文件带一个状态角标：
 *   ☁️ 云端(仅远端有,未下载) · ✓ 本地(已下载/一致) · ± 差异 · ⚠ 冲突
 *
 * 会话类型不同,呈现不同(做好兼容)：
 *   · 远端会话(execMode='relay')：文件默认都是 ☁️ 云端(内容在执行节点磁盘上)。
 *     查看/编辑走按需拉取(syncReadFile/Write,经中继)。可选配一个"本地目录"作副本,
 *     下载后变 ✓ 本地,可离线/比对(🔍)/双向同步(⬆⬇)。
 *   · 本地会话(execMode='local')：工作目录本来就在本机,没有"远端"这一说,不显示云朵,
 *     直接就是普通文件树,点开即看/即改。
 *
 * 无论哪种,查看/编辑都作用在**会话所在节点**的工作目录上(syncReadFile/syncWriteFile,
 * 按 execKey 路由);本地副本目录只服务于远端会话的"离线下载 + 差异同步"。
 */
import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import hljs from 'highlight.js';
import { api } from '../api';
import { markdownToHtml } from '../utils/markdown';
import {
  pickLocalDir, restoreLocalDir, loadBaseline, saveBaseline,
  type LocalFs, type Manifest,
} from '../utils/dirSync';

const CodeEditor = lazy(() => import('./CodeEditor'));

interface Props {
  workingDir: string;
  execKey?: string;
  execLabel?: string;
  execMode?: 'local' | 'relay';   // 会话运行在哪：本机 / 远端中继节点
}

interface TNode { name: string; rel: string; isDir: boolean; size: number; }

// 文件同步状态(群晖式)。远端会话才有;本地会话恒为 null(不显示角标)。
type FStatus = 'cloud' | 'local' | 'synced' | 'differs' | 'conflict';
const STATUS_COLOR: Record<Exclude<FStatus, 'cloud'>, string> = {
  local: '#22c55e', synced: '#22c55e', differs: '#f59e0b', conflict: '#ef4444',
};
const STATUS_LABEL: Record<FStatus, string> = {
  cloud: '云端 — 未下载到本地', local: '本地已下载', synced: '本地 · 与远端一致',
  differs: '本地与远端不同', conflict: '冲突 · 两端都改过',
};

// ── 预览/高亮/编辑 复用(highlight.js + marked + CodeMirror 懒加载)──
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const PREVIEW_TEXT_CAP = 200_000;
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', json: 'json',
  jsonc: 'json', xml: 'xml', html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml', css: 'css', scss: 'scss',
  less: 'less', sql: 'sql', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', md: 'markdown',
  markdown: 'markdown', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', pl: 'perl',
};
function extOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return lower;
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
function escapeHtml(s: string): string { return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')); }
function highlightCode(text: string, ext: string): string {
  const lang = LANG_ALIAS[ext] || ext;
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    return text.length > 0 ? hljs.highlightAuto(text).value : '';
  } catch { return escapeHtml(text); }
}
function imageMime(ext: string): string {
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'ico') return 'image/x-icon';
  return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
}
function base64ToText(b64: string): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function isDarkTheme(): boolean {
  try {
    const el = document.querySelector('.app-root') as HTMLElement | null;
    const raw = (el ? getComputedStyle(el).getPropertyValue('--theme-bg') : '').trim() || getComputedStyle(document.body).backgroundColor;
    let r = 20, g = 20, b = 30;
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else { const m = raw.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); if (m) { r = +m[1]; g = +m[2]; b = +m[3]; } }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  } catch { return true; }
}

interface PreviewState {
  rel: string; name: string;
  loading: boolean; text?: string; dataUrl?: string; isImage?: boolean; isMarkdown?: boolean; error?: string;
}

export const FileTreePanel: React.FC<Props> = ({ workingDir, execKey, execLabel, execMode }) => {
  const isRemote = execMode === 'relay';

  // 单树的懒加载层级缓存：key=rel → 直接子项
  const [children, setChildren] = useState<Record<string, TNode[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 远端会话的本地副本(离线/比对/同步用)。本地会话不涉及。
  const [localFs, setLocalFs] = useState<LocalFs | null>(null);
  const [localManifest, setLocalManifest] = useState<Manifest | null>(null);
  const [remoteManifest, setRemoteManifest] = useState<Manifest | null>(null);  // 比对后才有(带哈希)
  const [baseline, setBaseline] = useState<Manifest>({});
  const [comparing, setComparing] = useState(false);

  // 预览 / 编辑
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [mdRaw, setMdRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── 懒加载工作目录某层 ──
  const loadChildren = useCallback(async (rel: string): Promise<void> => {
    if (!workingDir) return;
    setLoading((p) => ({ ...p, [rel]: true }));
    try {
      const ents = await api.listDirectory(rel, workingDir, execKey);
      const nodes: TNode[] = ents.map((e) => ({ name: e.name, rel: e.path, isDir: e.isDir, size: 0 }));
      nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
      setChildren((p) => ({ ...p, [rel]: nodes }));
    } catch (e: any) {
      setMsg({ kind: 'err', text: `目录读取失败：${e?.message ?? e}` });
      setChildren((p) => ({ ...p, [rel]: [] }));
    } finally {
      setLoading((p) => ({ ...p, [rel]: false }));
    }
  }, [workingDir, execKey]);

  const reloadAll = useCallback(async () => {
    const keys = Object.keys(children);
    await Promise.all((keys.length ? keys : ['']).map((k) => loadChildren(k)));
  }, [children, loadChildren]);

  // 会话切换 → 重载根
  useEffect(() => {
    setChildren({}); setExpanded({}); setSelected(null);
    if (workingDir) loadChildren('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, execKey]);

  // 远端会话:恢复上次的本地副本目录并扫描(得到"已下载"presence + 哈希)
  const scanLocal = useCallback(async (fs: LocalFs | null) => {
    if (!fs) { setLocalManifest(null); return; }
    try { setLocalManifest(await fs.scan([])); } catch { setLocalManifest({}); }
  }, []);
  useEffect(() => {
    if (!isRemote) return;
    let cancelled = false;
    restoreLocalDir().then((fs) => { if (!cancelled && fs) { setLocalFs(fs); scanLocal(fs); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [isRemote, scanLocal]);
  useEffect(() => {
    if (localFs && workingDir) setBaseline(loadBaseline(localFs.id(), workingDir));
    else setBaseline({});
  }, [localFs, workingDir]);

  const toggle = useCallback((node: TNode) => {
    if (!node.isDir) return;
    const willOpen = !expanded[node.rel];
    setExpanded((p) => ({ ...p, [node.rel]: willOpen }));
    if (willOpen && children[node.rel] === undefined) loadChildren(node.rel);
  }, [expanded, children, loadChildren]);

  // ── 文件状态(仅远端会话)──
  const statusOf = useCallback((rel: string): FStatus | null => {
    if (!isRemote) return null;
    const L = localManifest?.[rel];
    if (!L) return 'cloud';
    const R = remoteManifest?.[rel];
    if (R) {
      if (L.hash === R.hash) return 'synced';
      const B = baseline[rel]?.hash;
      return (L.hash !== B && R.hash !== B) ? 'conflict' : 'differs';
    }
    return 'local';
  }, [isRemote, localManifest, remoteManifest, baseline]);

  const summary = useMemo(() => {
    if (!isRemote || !localManifest) return null;
    let cloud = 0, local = 0, differs = 0, conflict = 0;
    // 只对已加载出来的节点统计(懒加载,统计可见部分)
    for (const list of Object.values(children)) for (const n of list) {
      if (n.isDir) continue;
      const s = statusOf(n.rel);
      if (s === 'cloud') cloud++; else if (s === 'differs') differs++; else if (s === 'conflict') conflict++; else local++;
    }
    return { cloud, local, differs, conflict };
  }, [isRemote, localManifest, children, statusOf]);

  // ── 本地副本操作(远端会话)──
  const chooseLocal = useCallback(async () => {
    setMsg(null);
    try { const fs = await pickLocalDir(); if (fs) { setLocalFs(fs); scanLocal(fs); } }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? String(e) }); }
  }, [scanLocal]);

  const runCompare = useCallback(async () => {
    if (!workingDir || !localFs) return;
    setComparing(true); setMsg(null);
    try {
      const [lm, rm] = await Promise.all([
        localFs.scan([]),
        api.syncManifest(workingDir, execKey).then((r) => (r.status === 'ok' && r.files) ? r.files : {}),
      ]);
      setLocalManifest(lm); setRemoteManifest(rm);
      setBaseline(loadBaseline(localFs.id(), workingDir));
    } catch (e: any) { setMsg({ kind: 'err', text: `比对失败：${e?.message ?? e}` }); }
    finally { setComparing(false); }
  }, [workingDir, execKey, localFs]);

  const bumpBaseline = useCallback((rels: string[], src: Manifest | null) => {
    if (!localFs || !workingDir || !src) return;
    setBaseline((prev) => {
      const next = { ...prev };
      for (const rel of rels) if (src[rel]) next[rel] = src[rel];
      saveBaseline(localFs.id(), workingDir, next);
      return next;
    });
  }, [localFs, workingDir]);

  // 收集某节点下所有文件 rel(比对模式用远端清单;否则递归 listDirectory)
  const collectFiles = useCallback(async (node: TNode): Promise<string[]> => {
    if (!node.isDir) return [node.rel];
    if (remoteManifest) {
      const prefix = node.rel ? `${node.rel}/` : '';
      return Object.keys(remoteManifest).filter((r) => !node.rel || r.startsWith(prefix));
    }
    const out: string[] = [];
    const walk = async (rel: string) => {
      let kids = children[rel];
      if (kids === undefined) {
        const ents = workingDir ? await api.listDirectory(rel, workingDir, execKey) : [];
        kids = ents.map((e) => ({ name: e.name, rel: e.path, isDir: e.isDir, size: 0 }));
      }
      for (const k of kids) { if (k.isDir) await walk(k.rel); else out.push(k.rel); }
    };
    await walk(node.rel);
    return out;
  }, [remoteManifest, children, workingDir, execKey]);

  // ⬇ 下载到本地副本(云端→本地)
  const pull = useCallback(async (node: TNode) => {
    if (!localFs || !workingDir) { setMsg({ kind: 'err', text: '请先选择「本地副本目录」' }); return; }
    setMsg(null); setBusy('准备下载…');
    try {
      const rels = await collectFiles(node);
      if (node.isDir && !window.confirm(`下载「${node.name || '根'}」下的 ${rels.length} 个文件到本地？`)) { setBusy(''); return; }
      const ok: string[] = [];
      for (let i = 0; i < rels.length; i++) {
        setBusy(`下载 ${i + 1}/${rels.length}：${rels[i]}`);
        const r = await api.syncReadFile(workingDir, rels[i], execKey);
        if (r.status === 'ok' && r.data != null) { await localFs.writeFile(rels[i], r.data); ok.push(rels[i]); }
      }
      bumpBaseline(ok, remoteManifest);
      setMsg({ kind: 'ok', text: `✓ 已下载 ${ok.length}/${rels.length} 个文件到本地` });
      await scanLocal(localFs);
    } catch (e: any) { setMsg({ kind: 'err', text: `下载失败：${e?.message ?? e}` }); }
    finally { setBusy(''); }
  }, [localFs, workingDir, execKey, collectFiles, bumpBaseline, remoteManifest, scanLocal]);

  // ⬆ 上传本地改动(本地→云端)
  const push = useCallback(async (node: TNode) => {
    if (!localFs || !workingDir || !localManifest) return;
    setMsg(null); setBusy('准备上传…');
    try {
      const prefix = node.rel ? `${node.rel}/` : '';
      const rels = node.isDir ? Object.keys(localManifest).filter((r) => !node.rel || r === node.rel || r.startsWith(prefix)) : [node.rel];
      if (node.isDir && !window.confirm(`把本地「${node.name || '根'}」下的 ${rels.length} 个文件上传到远端？`)) { setBusy(''); return; }
      const ok: string[] = [];
      for (let i = 0; i < rels.length; i++) {
        setBusy(`上传 ${i + 1}/${rels.length}：${rels[i]}`);
        const b64 = await localFs.readFile(rels[i]);
        const r = await api.syncWriteFile(workingDir, rels[i], b64, execKey);
        if (r.status === 'ok') ok.push(rels[i]);
      }
      bumpBaseline(ok, localManifest);
      setMsg({ kind: 'ok', text: `✓ 已上传 ${ok.length}/${rels.length} 个文件到远端` });
      reloadAll();
    } catch (e: any) { setMsg({ kind: 'err', text: `上传失败：${e?.message ?? e}` }); }
    finally { setBusy(''); }
  }, [localFs, workingDir, execKey, localManifest, bumpBaseline, reloadAll]);

  // ── 预览 / 编辑(始终作用在会话节点的工作目录上)──
  const openPreview = useCallback(async (node: TNode) => {
    const base: PreviewState = { rel: node.rel, name: node.name, loading: true };
    setPreview(base); setEditing(false); setDirty(false); setMdRaw(false);
    try {
      if (!workingDir) throw new Error('未打开会话');
      const r = await api.syncReadFile(workingDir, node.rel, execKey);
      if (r.status !== 'ok') throw new Error(r.message || '读取失败');
      if (r.tooLarge) { setPreview({ ...base, loading: false, error: '文件过大，不便预览' }); return; }
      const b64 = r.data ?? '';
      const ext = extOf(node.name);
      if (IMAGE_EXTS.has(ext)) setPreview({ ...base, loading: false, isImage: true, dataUrl: `data:${imageMime(ext)};base64,${b64}` });
      else {
        let text = base64ToText(b64);
        if (text.length > PREVIEW_TEXT_CAP) text = text.slice(0, PREVIEW_TEXT_CAP) + '\n\n…（已截断,仅预览前 200KB）';
        setPreview({ ...base, loading: false, isImage: false, isMarkdown: MARKDOWN_EXTS.has(ext), text });
      }
    } catch (e: any) { setPreview({ ...base, loading: false, error: e?.message ?? String(e) }); }
  }, [workingDir, execKey]);

  const startEdit = useCallback(() => { if (preview && !preview.isImage) { setEditText(preview.text || ''); setDirty(false); setEditing(true); } }, [preview]);
  const saveEdit = useCallback(async () => {
    if (!preview || !workingDir) return;
    setSaving(true);
    try {
      const r = await api.syncWriteFile(workingDir, preview.rel, textToBase64(editText), execKey);
      if (r.status !== 'ok') throw new Error(r.message || '保存失败');
      setPreview((p) => (p ? { ...p, text: editText } : p));
      setDirty(false); setEditing(false);
      setMsg({ kind: 'ok', text: `✓ 已保存 ${preview.name}` });
      if (localFs) scanLocal(localFs);
    } catch (e: any) { setMsg({ kind: 'err', text: `保存失败：${e?.message ?? e}` }); }
    finally { setSaving(false); }
  }, [preview, workingDir, execKey, editText, localFs, scanLocal]);
  const closePreview = useCallback(() => {
    if (editing && dirty && !window.confirm('有未保存的修改，确定关闭？')) return;
    setPreview(null); setEditing(false); setDirty(false);
  }, [editing, dirty]);

  // ── 渲染 ──
  const fileIcon = (n: TNode, st: FStatus | null): string => {
    if (n.isDir) return expanded[n.rel] ? '📂' : '📁';
    if (st === 'cloud') return '☁️';
    return '📄';
  };

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const nodes = children[rel];
    if (nodes === undefined) return loading[rel] ? <div style={{ ...emptyStyle, paddingLeft: 24 + depth * 8 }}>加载中…</div> : null;
    if (nodes.length === 0 && depth === 0) return <Empty text="（空目录）" />;
    return nodes.map((n) => {
      const open = !!expanded[n.rel];
      const st = statusOf(n.rel);
      const dotColor = st && st !== 'cloud' && st !== 'local' && st !== 'synced' ? STATUS_COLOR[st] : null;
      return (
        <div key={n.rel}>
          <div
            className={`ftp-row${selected === n.rel ? ' ftp-sel' : ''}`}
            style={rowStyle}
            onClick={() => { setSelected(n.rel); n.isDir ? toggle(n) : openPreview(n); }}
            onDoubleClick={() => { if (!n.isDir) openPreview(n); }}
            title={st ? `${n.name} · ${STATUS_LABEL[st]}` : n.name}
          >
            {Array.from({ length: depth }).map((_, i) => <span key={i} style={guideStyle} />)}
            <span style={chevronStyle}>{n.isDir ? (open ? '▾' : '▸') : ''}</span>
            <span style={{ ...iconStyle, ...(st === 'cloud' ? { opacity: 0.85 } : {}) }}>{fileIcon(n, st)}</span>
            <span style={{ ...nameStyle, ...(st === 'cloud' ? { color: 'var(--theme-text-muted)' } : dotColor ? { color: dotColor } : {}) }}>{n.name}</span>
            {dotColor && <span title={STATUS_LABEL[st!]} style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0, marginLeft: 4 }} />}
            {st === 'synced' && <span title={STATUS_LABEL.synced} style={{ fontSize: 10, color: STATUS_COLOR.synced, flexShrink: 0, marginLeft: 4 }}>✓</span>}
            {/* 操作(hover) */}
            {!n.isDir && (
              <button className="ftp-act" style={actBtnStyle} title="预览 / 编辑" onClick={(e) => { e.stopPropagation(); openPreview(n); }}>👁</button>
            )}
            {isRemote && localFs && (st === 'cloud' || n.isDir || st === 'differs' || st === 'conflict') && (
              <button className="ftp-act" style={actBtnStyle} title="下载到本地" onClick={(e) => { e.stopPropagation(); pull(n); }}>⬇</button>
            )}
            {isRemote && localFs && (n.isDir || (st && st !== 'cloud')) && (
              <button className="ftp-act" style={actBtnStyle} title="上传本地改动到远端" onClick={(e) => { e.stopPropagation(); push(n); }}>⬆</button>
            )}
          </div>
          {n.isDir && open && renderDir(n.rel, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div style={wrapStyle}>
      <style>{`
        .ftp-row:hover { background: var(--theme-bg-tertiary, rgba(255,255,255,0.05)); }
        .ftp-row.ftp-sel { background: var(--theme-accent-bg, rgba(9,105,218,0.12)); box-shadow: inset 2px 0 0 var(--theme-accent, #0969da); }
        .ftp-act { opacity: 0; }
        .ftp-row:hover .ftp-act { opacity: 1; }
        .ftp-hbtn { opacity: 0; transition: opacity 0.12s; }
        .ftp-hdr:hover .ftp-hbtn { opacity: 1; }
      `}</style>

      {/* 顶部工具条 */}
      <div className="ftp-hdr" style={topBarStyle}>
        <span style={{ fontSize: 14 }}>{isRemote ? '☁️' : '🗂'}</span>
        <span style={{ fontWeight: 700, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--theme-text)' }}>
          {isRemote ? '远端工作目录' : '工作目录'}
        </span>
        {isRemote && execLabel && <span style={tagStyle} title={workingDir}>{execLabel}</span>}
        <div style={{ flex: 1 }} />
        <button className="ftp-hbtn" style={hdrIconStyle} title="刷新" onClick={reloadAll}>↻</button>
        <button className="ftp-hbtn" style={hdrIconStyle} title="全部折叠" onClick={() => setExpanded({})}>⊟</button>
      </div>

      {/* 远端会话:本地副本 + 比对 提示条 */}
      {isRemote && (
        <div style={localBarStyle}>
          {!localFs ? (
            <>
              <span style={{ color: 'var(--theme-text-muted)' }}>云端文件 —</span>
              <button style={miniBtnStyle} onClick={chooseLocal}>选择本地副本目录</button>
              <span style={{ color: 'var(--theme-text-muted)', fontSize: 10 }}>下载后可离线/编辑/比对</span>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--theme-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={localFs.label()}>
                🖥️ {localFs.label()}
              </span>
              <div style={{ flex: 1 }} />
              {summary && (summary.differs > 0 || summary.conflict > 0) && (
                <span style={{ color: summary.conflict ? STATUS_COLOR.conflict : STATUS_COLOR.differs }}>
                  {summary.conflict ? `冲突 ${summary.conflict}` : `差异 ${summary.differs}`}
                </span>
              )}
              <button style={miniBtnStyle} onClick={runCompare} disabled={comparing} title="比对两端(取哈希),标出差异/冲突">
                {comparing ? '比对中…' : '🔍 比对'}
              </button>
              <button style={miniBtnStyle} onClick={chooseLocal} title="更换本地副本目录">更换</button>
            </>
          )}
        </div>
      )}

      <div style={{ padding: '2px 0 6px' }}>
        {!workingDir ? <Empty text="打开一个会话后显示其工作目录" /> : renderDir('', 0)}
      </div>

      {(busy || msg) && (
        <div style={{
          padding: '6px 10px', fontSize: 11, lineHeight: 1.5, borderTop: '1px solid var(--theme-border)',
          color: busy ? 'var(--theme-text-muted)' : msg?.kind === 'ok' ? 'var(--theme-success, #2da44e)' : '#f87171',
          background: 'var(--theme-bg-secondary)',
        }}>{busy || msg?.text}</div>
      )}

      {preview && (
        <div style={pvOverlay} onClick={closePreview}>
          <div style={pvBox} onClick={(e) => e.stopPropagation()}>
            <div style={pvHeader}>
              <span style={{ fontSize: 13 }}>{preview.isImage ? '🖼️' : editing ? '✏️' : '📄'}</span>
              <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={preview.rel}>
                {dirty && <span style={{ color: 'var(--theme-accent)' }}>● </span>}{preview.name}
              </span>
              <div style={{ flex: 1 }} />
              {!editing && preview.isMarkdown && !preview.loading && !preview.error && (
                <div style={{ display: 'flex', border: '1px solid var(--theme-border)', borderRadius: 6, overflow: 'hidden', marginRight: 4 }}>
                  <button style={{ ...segBtnStyle, ...(!mdRaw ? segActiveStyle : {}) }} onClick={() => setMdRaw(false)}>👁 预览</button>
                  <button style={{ ...segBtnStyle, ...(mdRaw ? segActiveStyle : {}) }} onClick={() => setMdRaw(true)}>{'</> 源码'}</button>
                </div>
              )}
              {!editing && !preview.isImage && !preview.loading && !preview.error && (
                <button style={hdrBtnStyle} onClick={startEdit}>✏️ 编辑</button>
              )}
              {editing && (
                <>
                  <button style={{ ...hdrBtnStyle, ...(dirty && !saving ? { borderColor: 'var(--theme-accent)', color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)' } : { opacity: 0.5 }) }}
                    onClick={saveEdit} disabled={!dirty || saving}>{saving ? '保存中…' : '💾 保存'}</button>
                  <button style={hdrBtnStyle} onClick={() => { if (!dirty || window.confirm('放弃未保存的修改？')) { setEditing(false); setDirty(false); } }}>取消</button>
                </>
              )}
              <button style={hdrBtnStyle} onClick={closePreview}>✕</button>
            </div>
            <div style={pvBody}>
              {preview.loading ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>加载中…</div>
                : preview.error ? <div style={{ padding: 24, color: '#f87171', fontSize: 13 }}>⚠ {preview.error}</div>
                : editing ? (
                  <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>编辑器加载中…</div>}>
                    <CodeEditor key={preview.rel} value={editText} ext={extOf(preview.name)} dark={isDarkTheme()}
                      onChange={(v) => { setEditText(v); setDirty(true); }} onSave={saveEdit} />
                  </Suspense>
                ) : preview.isImage ? (
                  <div style={{ padding: 12, textAlign: 'center', overflow: 'auto' }}>
                    <img src={preview.dataUrl} alt={preview.name} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
                  </div>
                ) : preview.isMarkdown && !mdRaw ? (
                  <div style={{ padding: '8px 18px', fontSize: 14 }} dangerouslySetInnerHTML={{ __html: markdownToHtml(preview.text || '') }} />
                ) : (
                  <pre className="md-pre" style={pvPre}><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(preview.text || '', extOf(preview.name)) }} /></pre>
                )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Empty: React.FC<{ text: string }> = ({ text }) => <div style={emptyStyle}>{text}</div>;

const wrapStyle: React.CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0 };
const topBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 6px',
  position: 'sticky', top: 0, background: 'var(--theme-sidebar-bg, #f6f8fa)', zIndex: 1,
  borderBottom: '1px solid var(--theme-border)',
};
const tagStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)',
  border: '1px solid var(--theme-accent)', borderRadius: 4, padding: '0 6px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90,
};
const localBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
  padding: '5px 8px', fontSize: 11, borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
};
const miniBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
};
const hdrIconStyle: React.CSSProperties = {
  width: 20, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, borderRadius: 4, cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--theme-text-muted)',
};
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', height: 22, fontSize: 13, color: 'var(--theme-text)', cursor: 'pointer', paddingRight: 6 };
const guideStyle: React.CSSProperties = { width: 8, flexShrink: 0, alignSelf: 'stretch', borderLeft: '1px solid var(--theme-border)', opacity: 0.5 };
const chevronStyle: React.CSSProperties = { width: 16, flexShrink: 0, textAlign: 'center', fontSize: 10, color: 'var(--theme-text-muted)' };
const iconStyle: React.CSSProperties = { width: 18, flexShrink: 0, textAlign: 'center', fontSize: 13, marginRight: 2 };
const nameStyle: React.CSSProperties = { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const actBtnStyle: React.CSSProperties = {
  flexShrink: 0, width: 20, height: 20, borderRadius: 4, cursor: 'pointer', marginLeft: 2,
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', fontSize: 11, lineHeight: 1,
};
const emptyStyle: React.CSSProperties = { padding: '10px 12px', fontSize: 11, color: 'var(--theme-text-muted)' };
const pvOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const pvBox: React.CSSProperties = { width: 'min(820px, 92vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--theme-bg-secondary, #1f2030)', border: '1px solid var(--theme-border)', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', overflow: 'hidden' };
const pvHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--theme-border)', flexShrink: 0 };
const pvBody: React.CSSProperties = { overflow: 'auto', minHeight: 0, background: 'var(--theme-bg, rgba(0,0,0,0.2))' };
const pvPre: React.CSSProperties = { margin: 0, padding: '12px 16px', fontSize: 12.5, lineHeight: 1.6, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--theme-text)' };
const segBtnStyle: React.CSSProperties = { fontSize: 11, padding: '3px 9px', border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--theme-text-muted)' };
const segActiveStyle: React.CSSProperties = { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' };
const hdrBtnStyle: React.CSSProperties = { fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: 'pointer', border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)' };
