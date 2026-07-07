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
import React, { useCallback, useEffect, useMemo, useState, useRef, lazy, Suspense } from 'react';
import hljs from 'highlight.js';
import { api } from '../api';
import { markdownToHtml } from '../utils/markdown';
import type { GitFileStatus, GitFileStatusType, GitStashEntry } from '../types/git';
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

// ── Git 状态角标（TortoiseGit 风格）──
const GIT_STATUS_COLOR: Record<GitFileStatusType, string> = {
  modified: '#e3b341', added: '#3fb950', deleted: '#f85149',
  renamed: '#a371f7', copied: '#a371f7', untracked: '#8b949e', conflicted: '#f85149',
};
const GIT_STATUS_LETTER: Record<GitFileStatusType, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!',
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

  // ── Git 集成（检测 .git → 轮询状态 → overlay 角标）──
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitBranch, setGitBranch] = useState('');
  const [gitFiles, setGitFiles] = useState<Record<string, GitFileStatus>>({});
  const [gitStagedCount, setGitStagedCount] = useState(0);
  const [gitUnstagedCount, setGitUnstagedCount] = useState(0);
  const [gitAhead, setGitAhead] = useState(0);
  const [gitBehind, setGitBehind] = useState(0);
  const gitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── ★ Git 快速操作状态 ──
  const [gitCommitExpanded, setGitCommitExpanded] = useState(false);
  const [gitCommitMsg, setGitCommitMsg] = useState('');
  const [gitCommitting, setGitCommitting] = useState(false);
  const [gitPushing, setGitPushing] = useState(false);
  const [gitPulling, setGitPulling] = useState(false);
  const [gitAiGenerating, setGitAiGenerating] = useState(false);

  // ── Stash 管理 ──
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [stashExpanded, setStashExpanded] = useState(false);
  const [stashOperating, setStashOperating] = useState<number | null>(null); // 正在操作的 stash index

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

  // ── Git 检测 + 轮询 ──
  useEffect(() => {
    if (!workingDir) { setGitAvailable(false); setGitBranch(''); setGitFiles({}); return; }
    let cancelled = false;
    // 初次检测
    api.gitDetect(workingDir, execKey).then((res) => {
      if (cancelled) return;
      setGitAvailable(res.isRepo);
      setGitBranch(res.branch || '');
    }).catch(() => { if (!cancelled) setGitAvailable(false); });
    // 轮询 git status（5s 间隔）
    const pollStatus = () => {
      api.gitStatus(workingDir, execKey).then((res) => {
        if (cancelled) return;
        const map: Record<string, GitFileStatus> = {};
        let staged = 0, unstaged = 0;
        for (const f of (res.files || [])) {
          map[f.path] = f;
          if (f.staged) staged++;
          else unstaged++;
        }
        setGitFiles(map);
        setGitBranch(res.branch || '');
        setGitStagedCount(staged);
        setGitUnstagedCount(unstaged);
        setGitAhead(res.ahead || 0);
        setGitBehind(res.behind || 0);
      }).catch(() => {});
    };
    pollStatus();
    gitPollRef.current = setInterval(pollStatus, 5000);
    return () => { cancelled = true; if (gitPollRef.current) clearInterval(gitPollRef.current); };
  }, [workingDir, execKey]);

  // ── Stash 操作 ──
  const loadStashes = useCallback(async () => {
    if (!workingDir || !gitAvailable) return;
    setStashesLoading(true);
    try {
      const res = await api.gitStashList(workingDir, execKey);
      setStashes(res.stashes || []);
    } catch {
      setStashes([]);
    } finally {
      setStashesLoading(false);
    }
  }, [workingDir, execKey, gitAvailable]);

  // 当 stash 面板展开且 git 可用时加载列表
  useEffect(() => {
    if (stashExpanded && gitAvailable && workingDir) {
      loadStashes();
    }
  }, [stashExpanded, gitAvailable, workingDir, loadStashes]);

  const handleStashPush = useCallback(async () => {
    if (!workingDir) return;
    setMsg(null);
    const message = window.prompt('输入 stash 备注（可留空）：') ?? '';
    try {
      const res = await api.gitStashPush(workingDir, message, execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: '✓ 已暂存当前改动' });
        loadStashes();
        reloadAll(); // 刷新文件状态
      } else {
        setMsg({ kind: 'err', text: `Stash 失败：${(res as any).message || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `Stash 失败：${e?.message ?? e}` });
    }
  }, [workingDir, execKey, loadStashes, reloadAll]);

  const handleStashPop = useCallback(async (index: number) => {
    if (!workingDir) return;
    setMsg(null);
    setStashOperating(index);
    try {
      const res = await api.gitStashPop(workingDir, index, execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: `✓ 已恢复 stash@{${index}}` });
        loadStashes();
        reloadAll();
      } else {
        setMsg({ kind: 'err', text: `恢复失败：${(res as any).message || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `恢复失败：${e?.message ?? e}` });
    } finally {
      setStashOperating(null);
    }
  }, [workingDir, execKey, loadStashes, reloadAll]);

  const handleStashDrop = useCallback(async (index: number) => {
    if (!workingDir) return;
    if (!window.confirm(`确定要删除 stash@{${index}} 吗？此操作不可恢复！`)) return;
    setMsg(null);
    setStashOperating(index);
    try {
      const res = await api.gitStashDrop(workingDir, index, execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: `✓ 已删除 stash@{${index}}` });
        loadStashes();
      } else {
        setMsg({ kind: 'err', text: `删除失败：${(res as any).message || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `删除失败：${e?.message ?? e}` });
    } finally {
      setStashOperating(null);
    }
  }, [workingDir, execKey, loadStashes]);

  // ── ★ Git 快速操作 handlers ──

  /** Stage all 变更 */
  const handleStageAll = useCallback(async () => {
    if (!workingDir) return;
    try {
      const res = await api.gitStage(workingDir, ['.'], execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: '✓ 已暂存所有变更' });
      } else {
        setMsg({ kind: 'err', text: `暂存失败：${(res as any).message || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `暂存失败：${e?.message ?? e}` });
    }
  }, [workingDir, execKey]);

  /** AI 生成 commit message */
  const handleAiGenerateMsg = useCallback(async () => {
    if (!workingDir) return;
    setGitAiGenerating(true);
    try {
      const res = await api.gitGenerateCommitMessage(workingDir, true, execKey);
      if (res.status === 'ok' && res.message) {
        setGitCommitMsg(res.message);
      } else {
        setMsg({ kind: 'err', text: 'AI 生成失败，请手动输入' });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `AI 生成失败：${e?.message ?? e}` });
    } finally {
      setGitAiGenerating(false);
    }
  }, [workingDir, execKey]);

  /** Commit（如果未暂存则先 stage all） */
  const handleCommit = useCallback(async () => {
    if (!workingDir || !gitCommitMsg.trim()) return;
    setGitCommitting(true);
    try {
      // 如果有未暂存的变更，先 stage all
      if (gitUnstagedCount > 0) {
        await api.gitStage(workingDir, ['.'], execKey);
      }
      const res = await api.gitCommit(workingDir, gitCommitMsg.trim(), false, execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: `✓ 已提交: ${gitCommitMsg.trim().split('\n')[0]}` });
        setGitCommitMsg('');
        setGitCommitExpanded(false);
      } else {
        setMsg({ kind: 'err', text: `提交失败：${(res as any).message || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `提交失败：${e?.message ?? e}` });
    } finally {
      setGitCommitting(false);
    }
  }, [workingDir, execKey, gitCommitMsg, gitUnstagedCount]);

  /** Push */
  const handlePush = useCallback(async () => {
    if (!workingDir) return;
    setGitPushing(true);
    try {
      const res = await api.gitPush(workingDir, 'origin', '', false, execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: '✓ 已推送' });
      } else {
        setMsg({ kind: 'err', text: `推送失败：${res.message || res.output || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `推送失败：${e?.message ?? e}` });
    } finally {
      setGitPushing(false);
    }
  }, [workingDir, execKey]);

  /** Pull */
  const handlePull = useCallback(async () => {
    if (!workingDir) return;
    setGitPulling(true);
    try {
      const res = await api.gitPull(workingDir, 'origin', '', false, execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: '✓ 已拉取' });
      } else {
        setMsg({ kind: 'err', text: `拉取失败：${res.message || res.output || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `拉取失败：${e?.message ?? e}` });
    } finally {
      setGitPulling(false);
    }
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

      // Git 状态角标：文件直接查表；目录取其子项中最严重的状态
      let gitBadge: { letter: string; color: string; title: string } | null = null;
      if (gitAvailable) {
        if (!n.isDir) {
          const gf = gitFiles[n.rel];
          if (gf) gitBadge = { letter: GIT_STATUS_LETTER[gf.status], color: GIT_STATUS_COLOR[gf.status], title: `${gf.status}${gf.staged ? ' (staged)' : ''}` };
        } else {
          // 目录：聚合子项中最严重的 Git 状态
          const prefix = n.rel ? `${n.rel}/` : '';
          let worst: GitFileStatus | null = null;
          const priority: GitFileStatusType[] = ['conflicted', 'deleted', 'added', 'renamed', 'modified', 'untracked', 'copied'];
          for (const p of priority) {
            for (const [path, gf] of Object.entries(gitFiles)) {
              if (path === n.rel || path.startsWith(prefix)) {
                if (gf.status === p) { worst = gf; break; }
              }
            }
            if (worst) break;
          }
          if (worst) gitBadge = { letter: GIT_STATUS_LETTER[worst.status], color: GIT_STATUS_COLOR[worst.status], title: worst.status };
        }
      }

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
            {/* Git 状态角标（TortoiseGit 风格） */}
            {gitBadge && (
              <span title={`Git: ${gitBadge.title}`} style={{
                width: 16, height: 16, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700, color: '#fff', flexShrink: 0, marginLeft: 3,
                background: gitBadge.color,
              }}>{gitBadge.letter}</span>
            )}
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
        {gitAvailable && gitBranch && (
          <span style={gitBranchBadgeStyle} title={`Git branch: ${gitBranch}`}>🔀 {gitBranch}</span>
        )}
        {gitAvailable && (
          <button
            className="ftp-hbtn"
            style={{ ...hdrIconStyle, fontSize: 11, width: 'auto', padding: '0 6px', gap: 3, display: 'inline-flex', alignItems: 'center' }}
            title="Stash 当前改动"
            onClick={handleStashPush}
          >📦 Stash</button>
        )}
        {gitAvailable && (
          <button
            className="ftp-hbtn"
            style={{
              ...hdrIconStyle, fontSize: 11, width: 'auto', padding: '0 6px',
              ...(stashExpanded ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}),
            }}
            title="查看 Stash 列表"
            onClick={() => setStashExpanded((v) => !v)}
          >📋{stashes.length > 0 && <span style={{ marginLeft: 2, fontSize: 10 }}>({stashes.length})</span>}</button>
        )}
        <div style={{ flex: 1 }} />
        <button className="ftp-hbtn" style={hdrIconStyle} title="刷新" onClick={reloadAll}>↻</button>
        <button className="ftp-hbtn" style={hdrIconStyle} title="全部折叠" onClick={() => setExpanded({})}>⊟</button>
      </div>

      {/* ★ Git 快速操作工具条 */}
      {gitAvailable && (
        <div style={gitToolbarStyle}>
          {/* 状态摘要行 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {gitUnstagedCount > 0 && (
              <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}
                title="未暂存变更">{gitUnstagedCount} 未暂存</span>
            )}
            {gitStagedCount > 0 && (
              <span style={{ fontSize: 10, color: '#3fb950' }}
                title="已暂存变更">{gitStagedCount} 已暂存</span>
            )}
            {gitStagedCount === 0 && gitUnstagedCount === 0 && (
              <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>工作区干净</span>
            )}
            <div style={{ flex: 1 }} />
            {gitAhead > 0 && (
              <span style={{ fontSize: 10, color: '#58a6ff' }} title="领先远端">⬆{gitAhead}</span>
            )}
            {gitBehind > 0 && (
              <span style={{ fontSize: 10, color: '#d29922' }} title="落后远端">⬇{gitBehind}</span>
            )}
            {/* 快速按钮 */}
            {(gitUnstagedCount > 0 || gitStagedCount > 0) && (
              <button style={gitMiniBtn} title="暂存所有变更" onClick={handleStageAll}>📥 暂存</button>
            )}
            {gitBehind > 0 && (
              <button style={gitMiniBtn} disabled={gitPulling} onClick={handlePull}
                title="拉取远端变更">{gitPulling ? '⏳' : '⬇'} 拉取</button>
            )}
            {gitAhead > 0 && (
              <button style={gitMiniBtn} disabled={gitPushing} onClick={handlePush}
                title="推送到远端">{gitPushing ? '⏳' : '⬆'} 推送</button>
            )}
            <button style={{
              ...gitMiniBtn,
              ...(gitCommitExpanded ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}),
            }}
              onClick={() => setGitCommitExpanded((v) => !v)}
              title="提交变更">
              ✅ 提交
            </button>
          </div>
          {/* 提交面板（展开时） */}
          {gitCommitExpanded && (
            <div style={gitCommitPanelStyle}>
              <textarea
                style={gitCommitInputStyle}
                placeholder="输入 commit message…（可留空由 AI 生成）"
                value={gitCommitMsg}
                onChange={(e) => setGitCommitMsg(e.target.value)}
                rows={2}
              />
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <button style={gitCommitActionBtn} disabled={gitAiGenerating} onClick={handleAiGenerateMsg}
                  title="AI 根据 diff 生成 commit message">
                  {gitAiGenerating ? '⏳ 生成中…' : '✨ AI 生成'}
                </button>
                <div style={{ flex: 1 }} />
                <button style={{
                  ...gitCommitActionBtn,
                  background: gitCommitMsg.trim() ? 'var(--theme-success, #22c55e)' : 'var(--theme-bg-tertiary)',
                  color: gitCommitMsg.trim() ? '#fff' : 'var(--theme-text-muted)',
                  cursor: gitCommitMsg.trim() ? 'pointer' : 'not-allowed',
                }}
                  disabled={!gitCommitMsg.trim() || gitCommitting}
                  onClick={handleCommit}
                  title={gitUnstagedCount > 0 ? '先暂存所有再提交' : '提交已暂存的变更'}>
                  {gitCommitting ? '⏳' : '✅'} {gitUnstagedCount > 0 ? '暂存并提交' : '提交'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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

      {/* Stash 列表面板 */}
      {stashExpanded && gitAvailable && (
        <div style={stashPanelStyle}>
          <div style={stashHeaderStyle}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>📋 Stash 列表</span>
            <button style={stashRefreshBtnStyle} onClick={loadStashes} disabled={stashesLoading} title="刷新列表">
              {stashesLoading ? '⏳' : '↻'}
            </button>
          </div>
          {stashes.length === 0 ? (
            <div style={stashEmptyStyle}>暂无 stash 记录</div>
          ) : (
            <div style={stashListStyle}>
              {stashes.map((s) => (
                <div key={s.index} style={stashItemStyle}>
                  <div style={stashItemHeaderStyle}>
                    <span style={stashIndexStyle}>stash@{'{' + s.index + '}'}</span>
                    <span style={stashDateStyle}>{s.date ? new Date(s.date).toLocaleString() : ''}</span>
                  </div>
                  <div style={stashMsgStyle}>{s.message || '(无备注)'}</div>
                  <div style={stashActionsStyle}>
                    <button
                      style={stashActionBtnStyle}
                      onClick={() => handleStashPop(s.index)}
                      disabled={stashOperating === s.index}
                      title="恢复此 stash 到工作区"
                    >
                      {stashOperating === s.index ? '⏳' : '♻'} 恢复 (Pop)
                    </button>
                    <button
                      style={{ ...stashActionBtnStyle, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}
                      onClick={() => handleStashDrop(s.index)}
                      disabled={stashOperating === s.index}
                      title="删除此 stash（不可恢复）"
                    >
                      🗑 删除 (Drop)
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
const gitBranchBadgeStyle: React.CSSProperties = {
  fontSize: 10, color: '#58a6ff', background: 'rgba(88,166,255,0.1)',
  border: '1px solid rgba(88,166,255,0.3)', borderRadius: 10, padding: '0 6px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100,
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

// ── Stash 面板样式 ──
const stashPanelStyle: React.CSSProperties = {
  borderTop: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-secondary, rgba(0,0,0,0.15))',
  padding: '8px 10px',
  maxHeight: 240,
  overflowY: 'auto',
};
const stashHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 6, color: 'var(--theme-text)',
};
const stashRefreshBtnStyle: React.CSSProperties = {
  width: 22, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, borderRadius: 4, cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--theme-text-muted)',
};
const stashEmptyStyle: React.CSSProperties = { padding: '8px 0', fontSize: 11, color: 'var(--theme-text-muted)', textAlign: 'center' };
const stashListStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const stashItemStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6,
  background: 'var(--theme-bg, rgba(0,0,0,0.2))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
};
const stashItemHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3,
};
const stashIndexStyle: React.CSSProperties = {
  fontSize: 11, fontFamily: 'monospace', color: '#58a6ff',
  background: 'rgba(88,166,255,0.1)', padding: '1px 5px', borderRadius: 3,
};
const stashDateStyle: React.CSSProperties = { fontSize: 10, color: 'var(--theme-text-muted)' };
const stashMsgStyle: React.CSSProperties = { fontSize: 12, color: 'var(--theme-text)', marginBottom: 4, wordBreak: 'break-word' };
const stashActionsStyle: React.CSSProperties = { display: 'flex', gap: 6, marginTop: 4 };
const stashActionBtnStyle: React.CSSProperties = {
  fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
  border: '1px solid rgba(88,166,255,0.3)', background: 'rgba(88,166,255,0.08)',
  color: '#58a6ff', display: 'inline-flex', alignItems: 'center', gap: 3,
};

// ── Git 快速操作工具条样式 ──
const gitToolbarStyle: React.CSSProperties = {
  padding: '4px 8px 6px',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
  background: 'var(--theme-bg-secondary, rgba(0,0,0,0.15))',
};
const gitMiniBtn: React.CSSProperties = {
  fontSize: 10, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  background: 'var(--theme-bg, rgba(0,0,0,0.2))',
  color: 'var(--theme-text-muted, #8b949e)',
  display: 'inline-flex', alignItems: 'center', gap: 2,
  whiteSpace: 'nowrap',
};
const gitCommitPanelStyle: React.CSSProperties = {
  marginTop: 6, padding: 6,
  background: 'var(--theme-bg, rgba(0,0,0,0.2))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  borderRadius: 6,
};
const gitCommitInputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '4px 6px', fontSize: 11, lineHeight: 1.4,
  background: 'var(--theme-bg-secondary, rgba(0,0,0,0.15))',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  borderRadius: 4, color: 'var(--theme-text, #c9d1d9)',
  resize: 'vertical', fontFamily: 'inherit',
  outline: 'none',
};
const gitCommitActionBtn: React.CSSProperties = {
  fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  background: 'var(--theme-bg-tertiary, rgba(255,255,255,0.05))',
  color: 'var(--theme-text-muted, #8b949e)',
  display: 'inline-flex', alignItems: 'center', gap: 3,
};
