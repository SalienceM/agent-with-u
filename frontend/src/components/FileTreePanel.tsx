/**
 * FileTreePanel — 本地 / 远端 双根目录树（替代原弹窗式目录同步）。
 *
 * 像 VSCode 左侧资源管理器那样直接看到目录树,作为侧栏的一个可切换视图：
 *   🖥️ 本地（本机副本目录,File System Access / Tauri）
 *   ☁️ 远端（会话所在执行节点上的工作目录）
 *
 * 浏览是**懒加载**的：每个目录在展开时才拉它的直接子项（远端 `listDirectory`、
 * 本地 `LocalFs.listDir`,都不算哈希）,所以超大目录也能秒开、逐层下钻。
 *
 * 「🔍 比对」是显式动作：才会全量拉两端清单(含哈希)做三向比对,给每个文件标
 * 已同步 / 不同 / 冲突 / 仅本地 / 仅远端,并在树上高亮。不点比对就不做这件重活。
 *
 * 每个文件 / 整个目录都能就地同步：本地节点 ⬆ 推送到远端,远端节点 ⬇ 拉取到本地。
 */
import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import hljs from 'highlight.js';
import { api } from '../api';
import { markdownToHtml } from '../utils/markdown';

// CodeMirror 编辑器懒加载：只有点「编辑」时才拉它的独立 chunk,不进主包。
const CodeEditor = lazy(() => import('./CodeEditor'));
import {
  pickLocalDir, restoreLocalDir, loadBaseline, saveBaseline,
  type LocalFs, type Manifest,
} from '../utils/dirSync';

interface Props {
  workingDir: string;    // 远端工作目录（当前会话）
  execKey?: string;      // 远端执行节点；缺省回落 home
  execLabel?: string;    // 远端节点显示名
}

interface TNode {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
}

type Side = 'local' | 'remote';
const ck = (side: Side, rel: string) => `${side}:${rel}`;

function relsUnder(manifest: Manifest, rel: string, isDir: boolean): string[] {
  if (!isDir) return [rel];
  const prefix = rel ? `${rel}/` : '';
  return Object.keys(manifest).filter((r) => !rel || r === rel || r.startsWith(prefix));
}

// ── 比对状态（仅在「比对」模式下计算）────────────────────────────────
type FileStatus = 'synced' | 'differs' | 'conflict' | 'local-only' | 'remote-only';
type NodeStatus = FileStatus | 'changed';

const STATUS_COLOR: Record<NodeStatus, string> = {
  synced: '#9ca3af', differs: '#f59e0b', conflict: '#ef4444',
  'local-only': '#22c55e', 'remote-only': '#3b82f6', changed: '#f59e0b',
};
const STATUS_LABEL: Record<NodeStatus, string> = {
  synced: '已同步', differs: '两端内容不同', conflict: '冲突：两端都改过',
  'local-only': '仅本地有', 'remote-only': '仅远端有', changed: '内有变更',
};

function computeStatus(local: Manifest | null, remote: Manifest | null, baseline: Manifest): Record<string, FileStatus> {
  const out: Record<string, FileStatus> = {};
  const rels = new Set<string>([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const rel of rels) {
    const L = local?.[rel]?.hash;
    const R = remote?.[rel]?.hash;
    const B = baseline[rel]?.hash;
    if (L && R) out[rel] = L === R ? 'synced' : (L !== B && R !== B ? 'conflict' : 'differs');
    else if (L) out[rel] = 'local-only';
    else if (R) out[rel] = 'remote-only';
  }
  return out;
}

function aggregateStatus(rels: string[], statusMap: Record<string, FileStatus>): NodeStatus {
  let changed = false;
  for (const r of rels) {
    const s = statusMap[r];
    if (s === 'conflict') return 'conflict';
    if (s && s !== 'synced') changed = true;
  }
  return changed ? 'changed' : 'synced';
}

// ── 预览（复用项目已有的 highlight.js 代码高亮 + marked 渲染，零新增体量）──
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const PREVIEW_TEXT_CAP = 200_000;   // 文本预览上限,避免超大文件卡 UI

// 文件扩展名 → highlight.js 语言名（hljs 也认不少别名,这里只补常见的）
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cxx: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
  zsh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', json: 'json',
  jsonc: 'json', xml: 'xml', html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', toml: 'ini', ini: 'ini',
  cfg: 'ini', conf: 'ini', md: 'markdown', markdown: 'markdown', swift: 'swift',
  dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', pl: 'perl', dockerfile: 'dockerfile',
};

function extOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return lower;
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

// 编辑器主题跟随 app：读 .app-root 的 --theme-bg 亮度判定明暗(默认暗)。
function isDarkTheme(): boolean {
  try {
    const el = document.querySelector('.app-root') as HTMLElement | null;
    const raw = (el ? getComputedStyle(el).getPropertyValue('--theme-bg') : '').trim()
      || getComputedStyle(document.body).backgroundColor;
    let r = 20, g = 20, b = 30;
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else {
      const m = raw.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
    }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  } catch { return true; }
}

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
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

interface PreviewState {
  side: Side; rel: string; name: string;
  loading: boolean; text?: string; dataUrl?: string; isImage?: boolean; isMarkdown?: boolean; error?: string;
}

export const FileTreePanel: React.FC<Props> = ({ workingDir, execKey, execLabel }) => {
  const [localFs, setLocalFs] = useState<LocalFs | null>(null);
  // 懒加载层级缓存：key=`${side}:${rel}` → 直接子项
  const [children, setChildren] = useState<Record<string, TNode[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 两个根区块的展开状态(独立存,避免和名为 "root" 的顶层目录键冲突)
  const [secOpen, setSecOpen] = useState<Record<Side, boolean>>({ remote: true, local: true });
  const [selected, setSelected] = useState<string | null>(null);  // 选中行 `${side}:${rel}`
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [mdRaw, setMdRaw] = useState(false);   // markdown 预览：渲染视图 / 源码
  // 编辑态
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 比对（显式、全量）
  const [compareOn, setCompareOn] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [localManifest, setLocalManifest] = useState<Manifest | null>(null);
  const [remoteManifest, setRemoteManifest] = useState<Manifest | null>(null);
  const [baseline, setBaseline] = useState<Manifest>({});

  // ── 懒加载某目录的直接子项 ───────────────────────────────────────
  const loadChildren = useCallback(async (side: Side, rel: string): Promise<void> => {
    const key = ck(side, rel);
    setLoading((p) => ({ ...p, [key]: true }));
    try {
      let nodes: TNode[];
      if (side === 'remote') {
        if (!workingDir) { nodes = []; }
        else {
          const ents = await api.listDirectory(rel, workingDir, execKey);
          nodes = ents.map((e) => ({ name: e.name, rel: e.path, isDir: e.isDir, size: 0 }));
        }
      } else {
        if (!localFs) { nodes = []; }
        else {
          const ents = await localFs.listDir(rel);
          nodes = ents.map((e) => ({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, isDir: e.isDir, size: e.size }));
        }
      }
      nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
      setChildren((p) => ({ ...p, [key]: nodes }));
    } catch (e: any) {
      setMsg({ kind: 'err', text: `${side === 'remote' ? '远端' : '本地'}目录读取失败：${e?.message ?? e}` });
      setChildren((p) => ({ ...p, [key]: [] }));
    } finally {
      setLoading((p) => ({ ...p, [key]: false }));
    }
  }, [workingDir, execKey, localFs]);

  // 重新加载某一侧所有已展开层级（同步后刷新结构）
  const reloadSide = useCallback(async (side: Side) => {
    const keys = Object.keys(children).filter((k) => k.startsWith(`${side}:`));
    await Promise.all(keys.map((k) => loadChildren(side, k.slice(side.length + 1))));
  }, [children, loadChildren]);

  // 远端根：随会话切换重载
  useEffect(() => {
    setChildren((p) => { const n = { ...p }; for (const k of Object.keys(n)) if (k.startsWith('remote:')) delete n[k]; return n; });
    if (workingDir) loadChildren('remote', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, execKey]);

  // 本地：恢复上次目录并加载根
  useEffect(() => {
    let cancelled = false;
    restoreLocalDir().then((fs) => {
      if (cancelled || !fs) return;
      setLocalFs(fs);
    }).catch(() => { /* 需重新授权 */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (localFs) loadChildren('local', ''); /* eslint-disable-next-line */ }, [localFs]);

  const handlePickLocal = useCallback(async () => {
    setMsg(null);
    try {
      const fs = await pickLocalDir();
      if (fs) { setLocalFs(fs); setChildren((p) => { const n = { ...p }; for (const k of Object.keys(n)) if (k.startsWith('local:')) delete n[k]; return n; }); }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? String(e) });
    }
  }, []);

  const toggle = useCallback((side: Side, node: TNode) => {
    if (!node.isDir) return;
    const key = ck(side, node.rel);
    const willOpen = !expanded[key];
    setExpanded((p) => ({ ...p, [key]: willOpen }));
    if (willOpen && children[key] === undefined) loadChildren(side, node.rel);
  }, [expanded, children, loadChildren]);

  // 折叠该侧所有展开的目录(保留已加载的子项缓存,再展开是瞬时的)。
  const collapseAll = useCallback((side: Side) => {
    setExpanded((p) => {
      const n = { ...p };
      for (const k of Object.keys(n)) if (k.startsWith(`${side}:`)) n[k] = false;
      return n;
    });
  }, []);

  // ── 比对（显式全量）─────────────────────────────────────────────
  const runCompare = useCallback(async () => {
    if (!workingDir) { setMsg({ kind: 'err', text: '请先打开一个会话' }); return; }
    if (!localFs) { setMsg({ kind: 'err', text: '请先在「本地」选择一个目录' }); return; }
    setComparing(true);
    setMsg(null);
    try {
      const [lm, rm] = await Promise.all([
        localFs.scan([]),
        api.syncManifest(workingDir, execKey).then((r) => (r.status === 'ok' && r.files) ? r.files : {}),
      ]);
      setLocalManifest(lm);
      setRemoteManifest(rm);
      setBaseline(loadBaseline(localFs.id(), workingDir));
      setCompareOn(true);
    } catch (e: any) {
      setMsg({ kind: 'err', text: `比对失败：${e?.message ?? e}` });
    } finally {
      setComparing(false);
    }
  }, [workingDir, execKey, localFs]);

  const exitCompare = useCallback(() => {
    setCompareOn(false);
    setLocalManifest(null);
    setRemoteManifest(null);
  }, []);

  const statusMap = useMemo(
    () => (compareOn ? computeStatus(localManifest, remoteManifest, baseline) : {}),
    [compareOn, localManifest, remoteManifest, baseline],
  );
  const summary = useMemo(() => {
    const c = { conflict: 0, differs: 0, 'local-only': 0, 'remote-only': 0, synced: 0 } as Record<FileStatus, number>;
    for (const s of Object.values(statusMap)) c[s]++;
    return c;
  }, [statusMap]);

  const nodeStatus = useCallback((side: Side, n: TNode): NodeStatus | null => {
    if (!compareOn) return null;
    if (!n.isDir) return statusMap[n.rel] ?? null;
    const m = side === 'local' ? localManifest : remoteManifest;
    if (!m) return null;
    return aggregateStatus(relsUnder(m, n.rel, true), statusMap);
  }, [compareOn, statusMap, localManifest, remoteManifest]);

  const bumpBaseline = useCallback((rels: string[], src: Manifest | null) => {
    if (!localFs || !workingDir || !src) return;
    setBaseline((prev) => {
      const next = { ...prev };
      for (const rel of rels) if (src[rel]) next[rel] = src[rel];
      saveBaseline(localFs.id(), workingDir, next);
      return next;
    });
  }, [localFs, workingDir]);

  // 收集某节点下所有文件 rel：比对模式用清单,否则递归逐层列。
  const collectFiles = useCallback(async (side: Side, node: TNode): Promise<string[]> => {
    if (!node.isDir) return [node.rel];
    if (compareOn) {
      const m = side === 'local' ? localManifest : remoteManifest;
      if (m) return relsUnder(m, node.rel, true);
    }
    const out: string[] = [];
    const walk = async (rel: string) => {
      let kids = children[ck(side, rel)];
      if (kids === undefined) {
        // 未加载过：临时列一层
        if (side === 'remote') {
          const ents = workingDir ? await api.listDirectory(rel, workingDir, execKey) : [];
          kids = ents.map((e) => ({ name: e.name, rel: e.path, isDir: e.isDir, size: 0 }));
        } else {
          const ents = localFs ? await localFs.listDir(rel) : [];
          kids = ents.map((e) => ({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, isDir: e.isDir, size: e.size }));
        }
      }
      for (const k of kids) { if (k.isDir) await walk(k.rel); else out.push(k.rel); }
    };
    await walk(node.rel);
    return out;
  }, [compareOn, localManifest, remoteManifest, children, workingDir, execKey, localFs]);

  const pushNode = useCallback(async (node: TNode) => {
    if (!localFs || !workingDir) { setMsg({ kind: 'err', text: '需要本地目录与已打开的会话' }); return; }
    setMsg(null); setBusy('准备推送…');
    try {
      const rels = await collectFiles('local', node);
      if (node.isDir && !window.confirm(`把「${node.name || '根'}」下的 ${rels.length} 个文件推送到远端？`)) { setBusy(''); return; }
      const okRels: string[] = [];
      for (let i = 0; i < rels.length; i++) {
        setBusy(`推送 ${i + 1}/${rels.length}：${rels[i]}`);
        const b64 = await localFs.readFile(rels[i]);
        const r = await api.syncWriteFile(workingDir, rels[i], b64, execKey);
        if (r.status === 'ok') okRels.push(rels[i]);
      }
      bumpBaseline(okRels, localManifest);
      setMsg({ kind: 'ok', text: `✓ 已推送 ${okRels.length}/${rels.length} 个文件到远端` });
      reloadSide('remote');
      if (compareOn) runCompare();
    } catch (e: any) {
      setMsg({ kind: 'err', text: `推送失败：${e?.message ?? e}` });
    } finally { setBusy(''); }
  }, [localFs, workingDir, execKey, collectFiles, bumpBaseline, localManifest, reloadSide, compareOn, runCompare]);

  const pullNode = useCallback(async (node: TNode) => {
    if (!localFs) { setMsg({ kind: 'err', text: '请先在「本地」选择一个目录作为落地处' }); return; }
    if (!workingDir) return;
    setMsg(null); setBusy('准备拉取…');
    try {
      const rels = await collectFiles('remote', node);
      if (node.isDir && !window.confirm(`把远端「${node.name || '根'}」下的 ${rels.length} 个文件拉取到本地？`)) { setBusy(''); return; }
      const okRels: string[] = [];
      for (let i = 0; i < rels.length; i++) {
        setBusy(`拉取 ${i + 1}/${rels.length}：${rels[i]}`);
        const r = await api.syncReadFile(workingDir, rels[i], execKey);
        if (r.status === 'ok' && r.data != null) { await localFs.writeFile(rels[i], r.data); okRels.push(rels[i]); }
      }
      bumpBaseline(okRels, remoteManifest);
      setMsg({ kind: 'ok', text: `✓ 已拉取 ${okRels.length}/${rels.length} 个文件到本地` });
      reloadSide('local');
      if (compareOn) runCompare();
    } catch (e: any) {
      setMsg({ kind: 'err', text: `拉取失败：${e?.message ?? e}` });
    } finally { setBusy(''); }
  }, [localFs, workingDir, execKey, collectFiles, bumpBaseline, remoteManifest, reloadSide, compareOn, runCompare]);

  // ── 预览文件内容（文本 / 图片）─────────────────────────────────────
  const openPreview = useCallback(async (side: Side, node: TNode) => {
    const base: PreviewState = { side, rel: node.rel, name: node.name, loading: true };
    setPreview(base);
    setEditing(false); setDirty(false); setMdRaw(false);
    try {
      let b64: string | null = null;
      if (side === 'remote') {
        if (!workingDir) throw new Error('未打开会话');
        const r = await api.syncReadFile(workingDir, node.rel, execKey);
        if (r.status !== 'ok') throw new Error(r.message || '读取失败');
        if (r.tooLarge) { setPreview({ ...base, loading: false, error: '文件过大，不便预览（请直接拉取到本地查看）' }); return; }
        b64 = r.data ?? '';
      } else {
        if (!localFs) throw new Error('未选择本地目录');
        b64 = await localFs.readFile(node.rel);
      }
      const ext = extOf(node.name);
      if (IMAGE_EXTS.has(ext)) {
        setPreview({ ...base, loading: false, isImage: true, dataUrl: `data:${imageMime(ext)};base64,${b64}` });
      } else {
        let text = base64ToText(b64 || '');
        if (text.length > PREVIEW_TEXT_CAP) text = text.slice(0, PREVIEW_TEXT_CAP) + '\n\n…（已截断,仅预览前 200KB）';
        setPreview({ ...base, loading: false, isImage: false, isMarkdown: MARKDOWN_EXTS.has(ext), text });
      }
    } catch (e: any) {
      setPreview({ ...base, loading: false, error: e?.message ?? String(e) });
    }
  }, [workingDir, execKey, localFs]);

  const startEdit = useCallback(() => {
    if (!preview || preview.isImage) return;
    setEditText(preview.text || '');
    setDirty(false);
    setEditing(true);
  }, [preview]);

  const saveEdit = useCallback(async () => {
    if (!preview) return;
    setSaving(true);
    try {
      const b64 = textToBase64(editText);
      if (preview.side === 'remote') {
        if (!workingDir) throw new Error('未打开会话');
        const r = await api.syncWriteFile(workingDir, preview.rel, b64, execKey);
        if (r.status !== 'ok') throw new Error(r.message || '保存失败');
      } else {
        if (!localFs) throw new Error('未选择本地目录');
        await localFs.writeFile(preview.rel, b64);
      }
      setPreview((p) => (p ? { ...p, text: editText } : p));
      setDirty(false);
      setEditing(false);
      setMsg({ kind: 'ok', text: `✓ 已保存 ${preview.name}` });
      reloadSide(preview.side);
      if (compareOn) runCompare();
    } catch (e: any) {
      setMsg({ kind: 'err', text: `保存失败：${e?.message ?? e}` });
    } finally {
      setSaving(false);
    }
  }, [preview, editText, workingDir, execKey, localFs, reloadSide, compareOn, runCompare]);

  const closePreview = useCallback(() => {
    if (editing && dirty && !window.confirm('有未保存的修改，确定关闭？')) return;
    setPreview(null); setEditing(false); setDirty(false);
  }, [editing, dirty]);

  // ── 渲染 ─────────────────────────────────────────────────────────
  const renderDir = (side: Side, rel: string, depth: number): React.ReactNode => {
    const key = ck(side, rel);
    const nodes = children[key];
    if (nodes === undefined) {
      return loading[key] ? <div style={{ ...emptyStyle, paddingLeft: 24 + depth * 8 }}>加载中…</div> : null;
    }
    if (nodes.length === 0 && depth === 0) return <Empty text="（空）" />;
    return nodes.map((n) => {
      const nk = ck(side, n.rel);
      const open = !!expanded[nk];
      const st = nodeStatus(side, n);
      const hot = st && st !== 'synced' ? st : null;
      return (
        <div key={nk}>
          <div
            className={`ftp-row${selected === nk ? ' ftp-sel' : ''}`}
            style={rowStyle}
            onClick={() => { setSelected(nk); n.isDir ? toggle(side, n) : openPreview(side, n); }}
            onDoubleClick={() => { if (!n.isDir) openPreview(side, n); }}
            title={n.name}
          >
            {Array.from({ length: depth }).map((_, i) => <span key={i} style={guideStyle} />)}
            <span style={chevronStyle}>{n.isDir ? (open ? '▾' : '▸') : ''}</span>
            <span style={iconStyle}>{n.isDir ? (open ? '📂' : '📁') : '📄'}</span>
            <span style={{ ...nameStyle, ...(hot ? { color: STATUS_COLOR[hot] } : {}) }}>{n.name}</span>
            {hot && <span title={STATUS_LABEL[hot]} style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[hot], flexShrink: 0, marginLeft: 4 }} />}
            {!n.isDir && (
              <button className="ftp-act" style={actBtnStyle} title="预览"
                onClick={(e) => { e.stopPropagation(); openPreview(side, n); }}>👁</button>
            )}
            <button
              className="ftp-act" style={actBtnStyle}
              title={side === 'local' ? '推送到远端' : '拉取到本地'}
              onClick={(e) => { e.stopPropagation(); side === 'local' ? pushNode(n) : pullNode(n); }}
            >
              {side === 'local' ? '⬆' : '⬇'}
            </button>
          </div>
          {n.isDir && open && renderDir(side, n.rel, depth + 1)}
        </div>
      );
    });
  };

  const noneDiff = summary.conflict + summary.differs + summary['local-only'] + summary['remote-only'] === 0;

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

      {/* 比对工具条 */}
      <div style={summaryStyle}>
        {!compareOn ? (
          <button style={cmpBtnStyle} onClick={runCompare} disabled={comparing || !workingDir || !localFs}
            title={!localFs ? '先在「本地」选择目录' : !workingDir ? '先打开会话' : '全量比对两端内容（含哈希），标出差异/冲突'}>
            {comparing ? '比对中…' : '🔍 比对两端'}
          </button>
        ) : (
          <>
            {noneDiff ? <span style={{ color: 'var(--theme-success, #2da44e)' }}>✓ 两端一致</span> : (
              <>
                {summary.conflict > 0 && <Chip color={STATUS_COLOR.conflict} text={`冲突 ${summary.conflict}`} />}
                {summary.differs > 0 && <Chip color={STATUS_COLOR.differs} text={`不同 ${summary.differs}`} />}
                {summary['local-only'] > 0 && <Chip color={STATUS_COLOR['local-only']} text={`仅本地 ${summary['local-only']}`} />}
                {summary['remote-only'] > 0 && <Chip color={STATUS_COLOR['remote-only']} text={`仅远端 ${summary['remote-only']}`} />}
              </>
            )}
            <div style={{ flex: 1 }} />
            <button style={cmpBtnStyle} onClick={runCompare} disabled={comparing} title="重新比对">↻</button>
            <button style={cmpBtnStyle} onClick={exitCompare} title="退出比对">✕</button>
          </>
        )}
      </div>

      {/* ☁️ 远端 */}
      <SectionHeader icon="☁️" title="远端"
        sub={`${execLabel ? execLabel + ' · ' : ''}${workingDir || '（未打开会话）'}`}
        open={secOpen.remote} loading={loading[ck('remote', '')]}
        onToggle={() => setSecOpen((p) => ({ ...p, remote: !p.remote }))}
        onRefresh={() => reloadSide('remote')}
        onCollapseAll={() => collapseAll('remote')} />
      {secOpen.remote && (
        <div style={treeBoxStyle}>
          {!workingDir ? <Empty text="打开一个会话后显示其远端工作目录" /> : renderDir('remote', '', 0)}
        </div>
      )}

      {/* 🖥️ 本地 */}
      <SectionHeader icon="🖥️" title="本地"
        sub={localFs ? localFs.label() : '未选择本机目录'}
        open={secOpen.local} loading={loading[ck('local', '')]}
        onToggle={() => setSecOpen((p) => ({ ...p, local: !p.local }))}
        onRefresh={localFs ? () => reloadSide('local') : undefined}
        onCollapseAll={localFs ? () => collapseAll('local') : undefined}
        onPick={handlePickLocal} pickLabel={localFs ? '更换' : '选择目录'} pickAlways={!localFs} />
      {secOpen.local && (
        <div style={treeBoxStyle}>
          {!localFs ? <Empty text="选择一个本机目录作为副本（推送/拉取的落地处）" /> : renderDir('local', '', 0)}
        </div>
      )}

      {(busy || msg) && (
        <div style={{
          padding: '6px 10px', fontSize: 11, lineHeight: 1.5, borderTop: '1px solid var(--theme-border)',
          color: busy ? 'var(--theme-text-muted)' : msg?.kind === 'ok' ? 'var(--theme-success, #2da44e)' : '#f87171',
          background: 'var(--theme-bg-secondary)',
        }}>
          {busy || msg?.text}
        </div>
      )}

      {preview && (
        <div style={pvOverlay} onClick={closePreview}>
          <div style={pvBox} onClick={(e) => e.stopPropagation()}>
            <div style={pvHeader}>
              <span style={{ fontSize: 13 }}>{preview.isImage ? '🖼️' : editing ? '✏️' : '📄'}</span>
              <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={preview.rel}>
                {dirty && <span style={{ color: 'var(--theme-accent)' }}>● </span>}{preview.name}
              </span>
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', flexShrink: 0 }}>
                {preview.side === 'remote' ? '☁️ 远端' : '🖥️ 本地'}
              </span>
              <div style={{ flex: 1 }} />
              {/* 视图态:markdown 预览/源码切换 + 编辑入口 */}
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
              {preview.loading ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>加载中…</div>
              ) : preview.error ? (
                <div style={{ padding: 24, color: '#f87171', fontSize: 13 }}>⚠ {preview.error}</div>
              ) : editing ? (
                <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>编辑器加载中…</div>}>
                  <CodeEditor
                    key={preview.rel}
                    value={editText}
                    ext={extOf(preview.name)}
                    dark={isDarkTheme()}
                    onChange={(v) => { setEditText(v); setDirty(true); }}
                    onSave={saveEdit}
                  />
                </Suspense>
              ) : preview.isImage ? (
                <div style={{ padding: 12, textAlign: 'center', overflow: 'auto' }}>
                  <img src={preview.dataUrl} alt={preview.name} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
                </div>
              ) : preview.isMarkdown && !mdRaw ? (
                <div
                  style={{ padding: '8px 18px', fontSize: 14 }}
                  dangerouslySetInnerHTML={{ __html: markdownToHtml(preview.text || '') }}
                />
              ) : (
                <pre className="md-pre" style={pvPre}>
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(preview.text || '', extOf(preview.name)) }} />
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const SectionHeader: React.FC<{
  icon: string; title: string; sub: string; open: boolean; loading?: boolean;
  onToggle: () => void; onRefresh?: () => void; onCollapseAll?: () => void;
  onPick?: () => void; pickLabel?: string; pickAlways?: boolean;
}> = ({ icon, title, sub, open, loading, onToggle, onRefresh, onCollapseAll, onPick, pickLabel, pickAlways }) => (
  <div className="ftp-hdr" style={sectionHeaderStyle} onClick={onToggle} title={sub}>
    <span style={{ width: 16, textAlign: 'center', fontSize: 10, color: 'var(--theme-text-muted)' }}>{open ? '▾' : '▸'}</span>
    <span style={{ fontSize: 13 }}>{icon}</span>
    <span style={{ fontWeight: 700, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--theme-text)', flexShrink: 0 }}>{title}</span>
    {/* 路径/节点只作 header 的 tooltip(title 属性),不挤在标题行 —— 窄侧栏更清爽 */}
    {loading && <span style={{ fontSize: 10, color: 'var(--theme-text-muted)', flexShrink: 0 }}>…</span>}
    <div style={{ flex: 1, minWidth: 4 }} />
    {/* 动作图标：平时隐藏,hover 区块标题才出现(VSCode 风);「选择目录」空态例外,常显 */}
    {onPick && (
      <button className={pickAlways ? undefined : 'ftp-hbtn'} style={hdrBtnStyle} title="选择/更换本机目录"
        onClick={(e) => { e.stopPropagation(); onPick(); }}>{pickLabel || '选择'}</button>
    )}
    {onRefresh && (
      <button className="ftp-hbtn" style={hdrIconStyle} title="刷新"
        onClick={(e) => { e.stopPropagation(); onRefresh(); }}>↻</button>
    )}
    {onCollapseAll && (
      <button className="ftp-hbtn" style={hdrIconStyle} title="全部折叠"
        onClick={(e) => { e.stopPropagation(); onCollapseAll(); }}>⊟</button>
    )}
  </div>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div style={emptyStyle}>{text}</div>
);

const Chip: React.FC<{ color: string; text: string }> = ({ color, text }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
    <span>{text}</span>
  </span>
);

const wrapStyle: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0,
};
const summaryStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  padding: '6px 10px', fontSize: 11, color: 'var(--theme-text-muted)',
  borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
};
const cmpBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
};
const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 6px', cursor: 'pointer', userSelect: 'none',
  position: 'sticky', top: 0, background: 'var(--theme-sidebar-bg, #f6f8fa)', zIndex: 1,
};
const hdrBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: 'pointer',
  border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)',
};
const hdrIconStyle: React.CSSProperties = {
  width: 20, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, borderRadius: 4, cursor: 'pointer',
  border: 'none', background: 'transparent', color: 'var(--theme-text-muted)',
};
const treeBoxStyle: React.CSSProperties = {
  padding: '1px 0 4px',
};
// VSCode 资源管理器风格：22px 紧凑行 + 缩进引导线 + 对齐的 ▸ 折叠箭头
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', height: 22, fontSize: 13,
  color: 'var(--theme-text)', cursor: 'pointer', paddingRight: 6,
};
const guideStyle: React.CSSProperties = {
  width: 8, flexShrink: 0, alignSelf: 'stretch',
  borderLeft: '1px solid var(--theme-border)', opacity: 0.5,
};
const chevronStyle: React.CSSProperties = {
  width: 16, flexShrink: 0, textAlign: 'center', fontSize: 10, color: 'var(--theme-text-muted)',
};
const iconStyle: React.CSSProperties = {
  width: 18, flexShrink: 0, textAlign: 'center', fontSize: 13, marginRight: 2,
};
const nameStyle: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const actBtnStyle: React.CSSProperties = {
  flexShrink: 0, width: 20, height: 20, borderRadius: 4, cursor: 'pointer',
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)',
  color: 'var(--theme-accent)', fontSize: 11, lineHeight: 1,
};
const emptyStyle: React.CSSProperties = {
  padding: '10px 12px', fontSize: 11, color: 'var(--theme-text-muted)',
};
const pvOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const pvBox: React.CSSProperties = {
  width: 'min(820px, 92vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: 'var(--theme-bg-secondary, #1f2030)', border: '1px solid var(--theme-border)',
  borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', overflow: 'hidden',
};
const pvHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
  borderBottom: '1px solid var(--theme-border)', flexShrink: 0,
};
const pvBody: React.CSSProperties = {
  overflow: 'auto', minHeight: 0, background: 'var(--theme-bg, rgba(0,0,0,0.2))',
};
const pvPre: React.CSSProperties = {
  margin: 0, padding: '12px 16px', fontSize: 12.5, lineHeight: 1.6, fontFamily: 'monospace',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--theme-text)',
};
const segBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '3px 9px', border: 'none', cursor: 'pointer',
  background: 'transparent', color: 'var(--theme-text-muted)',
};
const segActiveStyle: React.CSSProperties = {
  background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
};
