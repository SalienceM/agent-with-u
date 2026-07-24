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
import { GitPanel } from './GitPanel';
import type { GitFileStatus, GitFileStatusType, GitStashEntry } from '../types/git';
import { DiffViewer } from './DiffViewer';
import { StructuredFilePreview, type StructuredPreviewPayload } from './StructuredFilePreview';
import {
  pickLocalDir, restoreLocalDir, loadBaseline, saveBaseline,
  type LocalFs, type Manifest,
} from '../utils/dirSync';

const CodeEditor = lazy(() => import('./CodeEditor'));
const PdfPreview = lazy(() => import('./PdfPreview'));
const DocxPreview = lazy(() => import('./DocxPreview'));
const DrawioPreview = lazy(() => import('./DrawioPreview'));

interface Props {
  sessionId?: string;
  workingDir: string;
  execKey?: string;
  execLabel?: string;
  execMode?: 'local' | 'relay';   // 会话运行在哪：本机 / 远端中继节点
  backendId?: string;             // ★ 当前会话的 backendId —— 供 AI 生成 commit message 使用
}

interface TNode {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  /** 该条目实际存在于哪一端；合并树会把同路径的两端标记合在一个节点上。 */
  remote?: boolean;
  local?: boolean;
  typeConflict?: boolean;
}

// 文件同步状态(群晖式)。远端会话才有;本地会话恒为 null(不显示角标)。
type FStatus = 'cloud' | 'local' | 'localOnly' | 'synced' | 'differs' | 'conflict';
const STATUS_COLOR: Record<Exclude<FStatus, 'cloud'>, string> = {
  local: '#22c55e', localOnly: '#38bdf8', synced: '#22c55e', differs: '#f59e0b', conflict: '#ef4444',
};
const STATUS_LABEL: Record<FStatus, string> = {
  cloud: '仅远端 — 可下载到本机', local: '两端均有 · 尚未比对', localOnly: '仅本机 — 可上传到远端', synced: '本机 · 与远端一致',
  differs: '本地与远端不同', conflict: '冲突 · 两端都改过',
};

/** 把本机完整文件清单一次性索引成逐级目录树，避免每次展开都全表扫描。 */
function buildLocalManifestTree(manifest: Manifest | null): Record<string, TNode[]> {
  const levels = new Map<string, Map<string, TNode>>();
  if (!manifest) return {};
  for (const [path, meta] of Object.entries(manifest)) {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const childRel = parts.slice(0, i + 1).join('/');
      const isDir = i < parts.length - 1;
      let level = levels.get(parent);
      if (!level) { level = new Map(); levels.set(parent, level); }
      level.set(childRel, {
        name: parts[i], rel: childRel, isDir,
        size: isDir ? 0 : meta.size,
        local: true, remote: false,
      });
    }
  }
  const tree: Record<string, TNode[]> = {};
  for (const [parent, nodes] of levels) {
    tree[parent] = [...nodes.values()].sort((a, b) => (
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
    ));
  }
  return tree;
}

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
const STRUCTURED_PREVIEW_EXTS = new Set(['doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt']);
const PREVIEW_TEXT_CAP = 200_000;
const PREVIEW_ARCHIVE_CAP = 32 * 1024 * 1024;
const PREVIEW_PDF_CAP = 64 * 1024 * 1024;
const TRANSFER_CHUNK_SIZE = 512 * 1024;
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
  return new TextDecoder('utf-8', { fatal: false }).decode(base64ToBytes(b64));
}
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
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
  source: 'remote' | 'local';
  loading: boolean; text?: string; dataUrl?: string; isImage?: boolean; isMarkdown?: boolean;
  renderer?: 'pdf' | 'docx' | 'drawio'; bytes?: Uint8Array; drawioXml?: string;
  loadingText?: string; structured?: StructuredPreviewPayload; error?: string;
}

interface TransferProgress {
  direction: 'pull' | 'push';
  rel: string;
  fileIndex: number;
  fileCount: number;
  fileBytes: number;
  fileSize: number;
  doneBytes: number;
  totalBytes: number;
}

interface FileContextMenu {
  x: number;
  y: number;
  node: TNode;
}

function transferId(): string {
  try { return crypto.randomUUID().replace(/-/g, ''); }
  catch { return `${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const FileTreePanel: React.FC<Props> = ({ sessionId, workingDir, execKey, execLabel, execMode, backendId }) => {
  const isRemote = execMode === 'relay';
  const localBindingKey = useMemo(
    () => sessionId || `${execKey || 'home'}::${workingDir}`,
    [sessionId, execKey, workingDir],
  );

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
  // gitCommitExpanded removed — ✅ button now opens the modal dialog
  const [gitCommitMsg, setGitCommitMsg] = useState('');
  const [gitCommitting, setGitCommitting] = useState(false);
  const [gitCommitPendingPush, setGitCommitPendingPush] = useState(false);
  const [gitPushing, setGitPushing] = useState(false);
  const [gitPulling, setGitPulling] = useState(false);
  const [gitAiGenerating, setGitAiGenerating] = useState(false);

  // ── ★ Git 提交弹窗（TortoiseGit 风格宽弹窗）──
  const [gitModalOpen, setGitModalOpen] = useState(false);
  // ★ 多选（checkbox）
  const [gitSelected, setGitSelected] = useState<Set<string>>(new Set());
  const [gitBatchOperating, setGitBatchOperating] = useState(false);
  const [gitAddingPaths, setGitAddingPaths] = useState<Set<string>>(new Set());

  // ── ★ Git Diff 独立面板 ──
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const [diffPanelFile, setDiffPanelFile] = useState<string>(''); // 当前查看的文件名
  const [diffPanelDiff, setDiffPanelDiff] = useState('');
  const [diffPanelLoading, setDiffPanelLoading] = useState(false);
  const [diffPanelAllFiles, setDiffPanelAllFiles] = useState<string[]>([]); // 所有变更文件（用于上/下一个切换）

  // ── ★ Git Log 面板 ──
  const [gitLogOpen, setGitLogOpen] = useState(false);

  // ── Stash 管理 ──
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [stashExpanded, setStashExpanded] = useState(false);
  const [stashOperating, setStashOperating] = useState<number | null>(null); // 正在操作的 stash index

  // 预览 / 编辑
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewMaximized, setPreviewMaximized] = useState(false);
  const [mdRaw, setMdRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  const transferAbortRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // ── msg 自动消失（5 秒后清除）──
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);

  // ── 懒加载工作目录某层 ──
  const loadChildren = useCallback(async (rel: string): Promise<void> => {
    if (!workingDir) return;
    setLoading((p) => ({ ...p, [rel]: true }));
    try {
      const ents = await api.listDirectory(rel, workingDir, execKey);
      const nodes: TNode[] = ents.map((e) => ({
        name: e.name, rel: e.path, isDir: e.isDir, size: 0,
        remote: true, local: false,
      }));
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
    const keys = new Set(['', ...Object.keys(children), ...Object.keys(expanded).filter((k) => expanded[k])]);
    await Promise.all([...keys].map((k) => loadChildren(k)));
  }, [children, expanded, loadChildren]);

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

  /** AI 生成 commit message（只分析勾选的文件） */
  const handleAddToTracking = useCallback(async (paths: string[]) => {
    if (!workingDir || paths.length === 0) return;
    setGitAddingPaths((prev) => new Set([...prev, ...paths]));
    try {
      const res = await api.gitStage(workingDir, paths, execKey);
      if (res.status !== 'ok') {
        setMsg({ kind: 'err', text: `加入版本控制失败：${(res as any).message || '未知错误'}` });
        return;
      }
      setGitFiles((prev) => {
        const next = { ...prev };
        for (const path of paths) {
          const old = next[path];
          if (old) next[path] = { ...old, status: 'added', staged: true };
        }
        return next;
      });
      const newlyStaged = paths.filter((p) => !gitFiles[p]?.staged).length;
      setGitStagedCount((n) => n + newlyStaged);
      setGitUnstagedCount((n) => Math.max(0, n - newlyStaged));
      setMsg({ kind: 'ok', text: `✓ 已加入版本控制：${paths.length} 个文件` });
    } catch (err: any) {
      setMsg({ kind: 'err', text: `加入版本控制失败：${err?.message ?? err}` });
    } finally {
      setGitAddingPaths((prev) => {
        const next = new Set(prev);
        paths.forEach((p) => next.delete(p));
        return next;
      });
    }
  }, [workingDir, execKey, gitFiles]);

  const handleAiGenerateMsg = useCallback(async () => {
    if (!workingDir) return;
    setGitAiGenerating(true);
    try {
      // ★ 传递勾选的文件列表，后端只分析这些文件的 diff
      const selectedPaths = Array.from(gitSelected);
      const res = await api.gitGenerateCommitMessage(workingDir, false, execKey, backendId, selectedPaths);
      if (!res) {
        setMsg({ kind: 'err', text: 'AI 生成失败：与后端连接断开，请检查后端是否运行中' });
      } else if (res.status === 'ok' && res.message) {
        setGitCommitMsg(res.message);
      } else if (res.status === 'ok') {
        setMsg({ kind: 'err', text: '勾选的文件没有检测到变更，请先选择要提交的文件' });
      } else {
        setMsg({ kind: 'err', text: `AI 生成失败：${res.message || '未知错误，请检查后端日志'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `AI 生成失败：${e?.message ?? String(e)}` });
    } finally {
      setGitAiGenerating(false);
    }
  }, [workingDir, execKey, backendId, gitSelected]);

  /** ★ 打开 Diff 面板（独立弹窗） */
  const openDiffPanel = useCallback(async (path: string, allFiles: string[]) => {
    if (!workingDir) return;
    setDiffPanelOpen(true);
    setDiffPanelAllFiles(allFiles);
    setDiffPanelFile(path);
    setDiffPanelLoading(true);
    setDiffPanelDiff('');
    // 判断文件是 staged 还是 unstaged
    const gf = gitFiles[path];
    const staged = gf ? gf.staged : false;
    try {
      const res = await api.gitDiff(workingDir, path, staged, execKey);
      setDiffPanelDiff(res.diff || res.stat || '(binary file)');
    } catch (e: any) {
      setDiffPanelDiff(`加载失败：${e?.message ?? e}`);
    } finally {
      setDiffPanelLoading(false);
    }
  }, [workingDir, execKey, gitFiles]);

  /** ★ Diff 面板内切换上一个文件 */
  const diffPanelPrevFile = useCallback(() => {
    if (diffPanelAllFiles.length === 0) return;
    const idx = diffPanelAllFiles.indexOf(diffPanelFile);
    if (idx <= 0) return;
    const prevFile = diffPanelAllFiles[idx - 1];
    // 复用 openDiffPanel 但跳过 setDiffPanelOpen 和 setDiffPanelAllFiles
    if (!workingDir) return;
    setDiffPanelFile(prevFile);
    setDiffPanelLoading(true);
    setDiffPanelDiff('');
    const gf = gitFiles[prevFile];
    const staged = gf ? gf.staged : false;
    api.gitDiff(workingDir, prevFile, staged, execKey).then((res) => {
      setDiffPanelDiff(res.diff || res.stat || '(binary file)');
    }).catch((e: any) => {
      setDiffPanelDiff(`加载失败：${e?.message ?? e}`);
    }).finally(() => {
      setDiffPanelLoading(false);
    });
  }, [diffPanelFile, diffPanelAllFiles, workingDir, execKey, gitFiles]);

  /** ★ Diff 面板内切换下一个文件 */
  const diffPanelNextFile = useCallback(() => {
    if (diffPanelAllFiles.length === 0) return;
    const idx = diffPanelAllFiles.indexOf(diffPanelFile);
    if (idx < 0 || idx >= diffPanelAllFiles.length - 1) return;
    const nextFile = diffPanelAllFiles[idx + 1];
    if (!workingDir) return;
    setDiffPanelFile(nextFile);
    setDiffPanelLoading(true);
    setDiffPanelDiff('');
    const gf = gitFiles[nextFile];
    const staged = gf ? gf.staged : false;
    api.gitDiff(workingDir, nextFile, staged, execKey).then((res) => {
      setDiffPanelDiff(res.diff || res.stat || '(binary file)');
    }).catch((e: any) => {
      setDiffPanelDiff(`加载失败：${e?.message ?? e}`);
    }).finally(() => {
      setDiffPanelLoading(false);
    });
  }, [diffPanelFile, diffPanelAllFiles, workingDir, execKey, gitFiles]);

  /** Commit（只提交勾选的文件） */
  const handleCommit = useCallback(async () => {
    if (!workingDir || !gitCommitMsg.trim()) return;
    setGitCommitting(true);
    try {
      const selectedPaths = Array.from(gitSelected);
      if (selectedPaths.length === 0) {
        setMsg({ kind: 'err', text: '请至少选择一个文件' });
        setGitCommitting(false);
        return;
      }
      const res = await api.gitCommit(workingDir, gitCommitMsg.trim(), false, execKey, selectedPaths);
      if (res.status === 'ok') {
        // 提交面板内已有完整反馈，关闭后不在工作目录顶部重复提示。
        setMsg(null);
        setGitCommitMsg('');
        setGitSelected(new Set());
        setGitModalOpen(false);
      } else {
        setMsg({ kind: 'err', text: `提交失败：${(res as any).message || '未知错误'}` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `提交失败：${e?.message ?? e}` });
    } finally {
      setGitCommitting(false);
    }
  }, [workingDir, execKey, gitCommitMsg, gitSelected]);

  /** ★ 提交并推送（小乌龟风格一步到位） */
  const handleCommitAndPush = useCallback(async () => {
    if (!workingDir || (!gitCommitPendingPush && !gitCommitMsg.trim())) return;
    setGitCommitting(true);
    try {
      if (!gitCommitPendingPush) {
        const selectedPaths = Array.from(gitSelected);
        if (selectedPaths.length === 0) {
          setMsg({ kind: 'err', text: '请至少选择一个文件' });
          return;
        }
        const commitRes = await api.gitCommit(workingDir, gitCommitMsg.trim(), false, execKey, selectedPaths);
        if (commitRes.status !== 'ok') {
          setMsg({ kind: 'err', text: `提交失败：${(commitRes as any).message || '未知错误'}` });
          return;
        }
        setGitCommitPendingPush(true);
        setMsg({ kind: 'ok', text: `✓ 已提交，正在推送…` });
      }

      const pushRes = await api.gitPush(workingDir, 'origin', '', false, execKey);
      if (pushRes.status === 'ok') {
        // 推送完成即返回主界面，不再显示重复的顶部成功横幅。
        setMsg(null);
        setGitCommitMsg('');
        setGitSelected(new Set());
        setGitCommitPendingPush(false);
        setGitModalOpen(false);
      } else {
        setMsg({ kind: 'err', text: `已提交，但推送失败：${pushRes.message || pushRes.output || '未知错误'}；可直接重试推送` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `${gitCommitPendingPush ? '推送' : '提交或推送'}失败：${e?.message ?? e}` });
    } finally {
      setGitCommitting(false);
    }
  }, [workingDir, execKey, gitCommitMsg, gitSelected, gitCommitPendingPush]);

  // ── ★ 多选 + 批量操作 ──
  const toggleFileSelection = useCallback((path: string) => {
    setGitSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const selectAllFiles = useCallback(() => {
    const allPaths = Object.keys(gitFiles);
    setGitSelected(new Set(allPaths));
  }, [gitFiles]);

  const deselectAllFiles = useCallback(() => {
    setGitSelected(new Set());
  }, []);

  /** 批量忽略选中文件 */
  const handleBatchIgnore = useCallback(async () => {
    if (!workingDir || gitSelected.size === 0) return;
    const untrackedOnly = Array.from(gitSelected).filter(
      (path) => gitFiles[path]?.status === 'untracked'
    );
    const protectedCount = gitSelected.size - untrackedOnly.length;
    if (untrackedOnly.length === 0) {
      setMsg({ kind: 'err', text: '已跟踪文件不能从批量操作中忽略；请通过专门的版本控制操作处理。' });
      return;
    }
    setGitBatchOperating(true);
    try {
      const res = await api.gitIgnore(workingDir, untrackedOnly, execKey);
      if (res.status === 'ok') {
        setMsg({ kind: 'ok', text: `✓ 已忽略 ${untrackedOnly.length} 个未跟踪文件${protectedCount ? `；已保护 ${protectedCount} 个已跟踪文件` : ''}` });
        setGitSelected(new Set());
      } else {
        setMsg({ kind: 'err', text: `忽略失败` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `忽略失败：${e?.message ?? e}` });
    } finally {
      setGitBatchOperating(false);
    }
  }, [workingDir, execKey, gitSelected, gitFiles]);

  /** 批量丢弃选中文件 */
  const handleBatchDiscard = useCallback(async () => {
    if (!workingDir || gitSelected.size === 0) return;
    if (!confirm(`确定丢弃 ${gitSelected.size} 个文件的改动？此操作不可撤销。`)) return;
    setGitBatchOperating(true);
    try {
      const res = await api.gitDiscard(workingDir, Array.from(gitSelected), execKey);
      if (res.status === 'ok' || res.status === 'partial') {
        setMsg({ kind: 'ok', text: `✓ 已丢弃 ${res.discarded?.length ?? gitSelected.size} 个文件` });
        setGitSelected(new Set());
      } else {
        setMsg({ kind: 'err', text: `丢弃失败` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `丢弃失败：${e?.message ?? e}` });
    } finally {
      setGitBatchOperating(false);
    }
  }, [workingDir, execKey, gitSelected]);

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

  // 远端会话：按 session 恢复本机目录，避免不同远端 session 错用同一个本地目录。
  const scanLocal = useCallback(async (fs: LocalFs | null) => {
    if (!fs) { setLocalManifest(null); return; }
    try { setLocalManifest(await fs.scan([])); } catch { setLocalManifest({}); }
  }, []);
  const refreshAll = useCallback(async () => {
    await Promise.all([
      reloadAll(),
      localFs ? scanLocal(localFs) : Promise.resolve(),
    ]);
  }, [reloadAll, localFs, scanLocal]);
  useEffect(() => {
    if (!isRemote) {
      setLocalFs(null);
      setLocalManifest(null);
      return;
    }
    let cancelled = false;
    setLocalFs(null);
    setLocalManifest(null);
    setRemoteManifest(null);
    restoreLocalDir(localBindingKey).then(async (fs) => {
      if (!fs) return;
      let manifest: Manifest = {};
      try { manifest = await fs.scan([]); } catch { /* 保留空清单 */ }
      if (!cancelled) {
        setLocalFs(fs);
        setLocalManifest(manifest);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isRemote, localBindingKey]);
  useEffect(() => {
    if (localFs && workingDir) setBaseline(loadBaseline(localFs.id(), workingDir));
    else setBaseline({});
  }, [localFs, workingDir]);

  const localTree = useMemo(() => buildLocalManifestTree(localManifest), [localManifest]);
  const remoteManifestDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const rel of Object.keys(remoteManifest || {})) {
      const parts = rel.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return dirs;
  }, [remoteManifest]);

  const toggle = useCallback((node: TNode) => {
    if (!node.isDir) return;
    const willOpen = !expanded[node.rel];
    setExpanded((p) => ({ ...p, [node.rel]: willOpen }));
    // 本机独有目录没有对应远端路径，直接由本机清单展开，避免无意义的远端 404。
    if (willOpen && node.remote && children[node.rel] === undefined) loadChildren(node.rel);
  }, [expanded, children, loadChildren]);

  /** 统一目录 = 已加载远端子项 ∪ 本机清单子项。 */
  const mergedChildren = useCallback((rel: string): TNode[] => {
    const merged = new Map<string, TNode>();
    for (const node of children[rel] || []) {
      merged.set(node.rel, { ...node, remote: true });
    }
    if (isRemote) {
      for (const localNode of localTree[rel] || []) {
        const remoteNode = merged.get(localNode.rel);
        if (remoteNode) {
          merged.set(localNode.rel, {
            ...remoteNode,
            local: true,
            // 同一路径一端是文件、一端是目录时按冲突展示，保留远端类型避免误操作。
            typeConflict: remoteNode.isDir !== localNode.isDir,
          });
        } else {
          const typeConflict = localNode.isDir
            ? !!remoteManifest?.[localNode.rel]
            : remoteManifestDirs.has(localNode.rel);
          const existsRemotely = localNode.isDir
            ? remoteManifestDirs.has(localNode.rel)
            : !!remoteManifest?.[localNode.rel];
          merged.set(localNode.rel, { ...localNode, remote: existsRemotely || typeConflict, typeConflict });
        }
      }
    }
    return [...merged.values()].sort((a, b) => (
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
    ));
  }, [children, isRemote, localTree, remoteManifest, remoteManifestDirs]);

  // 比对后可能发现“原以为仅本机”的已展开目录其实远端也存在，立即补拉远端子项。
  useEffect(() => {
    if (!isRemote || !remoteManifest) return;
    for (const [rel, open] of Object.entries(expanded)) {
      if (open && remoteManifestDirs.has(rel) && children[rel] === undefined) loadChildren(rel);
    }
  }, [isRemote, remoteManifest, remoteManifestDirs, expanded, children, loadChildren]);

  // ── 文件状态(仅远端会话)──
  const statusOf = useCallback((node: TNode): FStatus | null => {
    if (!isRemote) return null;
    if (node.typeConflict) return 'conflict';
    if (node.local && !node.remote) return 'localOnly';
    if (node.remote && !node.local) return 'cloud';
    if (node.isDir) return node.local ? 'local' : 'cloud';
    const L = localManifest?.[node.rel];
    if (!L) return 'cloud';
    const R = remoteManifest?.[node.rel];
    if (R) {
      if (L.hash === R.hash) return 'synced';
      const B = baseline[node.rel]?.hash;
      return (B && L.hash !== B && R.hash !== B) ? 'conflict' : 'differs';
    }
    return 'local';
  }, [isRemote, localManifest, remoteManifest, baseline]);

  const summary = useMemo(() => {
    if (!isRemote || !localManifest || !remoteManifest) return null;
    let cloud = 0, local = 0, localOnly = 0, differs = 0, conflict = 0;
    const paths = new Set([...Object.keys(localManifest), ...Object.keys(remoteManifest)]);
    for (const rel of paths) {
      const L = localManifest[rel];
      const R = remoteManifest[rel];
      if (!L) { cloud++; continue; }
      if (!R) { localOnly++; continue; }
      if (L.hash === R.hash) { local++; continue; }
      const B = baseline[rel]?.hash;
      if (B && L.hash !== B && R.hash !== B) conflict++;
      else differs++;
    }
    return { cloud, local, localOnly, differs, conflict };
  }, [isRemote, localManifest, remoteManifest, baseline]);

  // ── 本地副本操作(远端会话)──
  const chooseLocal = useCallback(async () => {
    setMsg(null);
    try {
      const initialPath = localFs?.kind === 'tauri' ? localFs.label() : undefined;
      const fs = await pickLocalDir(initialPath, localBindingKey);
      if (fs) { setLocalFs(fs); await scanLocal(fs); }
    }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? String(e) }); }
  }, [localFs, localBindingKey, scanLocal]);

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
    if (transfer) return;
    setMsg(null); setBusy('准备下载…');
    transferAbortRef.current = false;
    try {
      const rels = await collectFiles(node);
      if (node.isDir && !window.confirm(`下载「${node.name || '根'}」下的 ${rels.length} 个文件到本地？`)) { setBusy(''); return; }
      const sizes: Record<string, number> = {};
      for (const rel of rels) {
        const known = remoteManifest?.[rel]?.size;
        if (typeof known === 'number') sizes[rel] = known;
        else {
          const stat = await api.syncFileStat(workingDir, rel, execKey);
          if (stat.status !== 'ok' || typeof stat.size !== 'number') throw new Error(stat.message || `无法读取文件大小：${rel}`);
          sizes[rel] = stat.size;
        }
      }
      const totalBytes = rels.reduce((sum, rel) => sum + sizes[rel], 0);
      const ok: string[] = [];
      let doneBytes = 0;
      for (let i = 0; i < rels.length; i++) {
        const rel = rels[i];
        const size = sizes[rel];
        const id = transferId();
        setBusy(`下载 ${i + 1}/${rels.length}：${rel}`);
        setTransfer({ direction: 'pull', rel, fileIndex: i + 1, fileCount: rels.length, fileBytes: 0, fileSize: size, doneBytes, totalBytes });
        await localFs.writeStart(rel, id);
        let offset = 0;
        try {
          while (offset < size) {
            if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
            const result = await api.syncReadChunk(workingDir, rel, offset, Math.min(TRANSFER_CHUNK_SIZE, size - offset), execKey);
            if (result.status !== 'ok' || result.data == null) throw new Error(result.message || `下载失败：${rel}`);
            const chunkBytes = result.size ?? 0;
            if (chunkBytes <= 0 && offset < size) throw new Error(`下载返回空分块：${rel}`);
            await localFs.writeChunk(rel, id, offset, result.data);
            offset += chunkBytes;
            setTransfer({ direction: 'pull', rel, fileIndex: i + 1, fileCount: rels.length, fileBytes: offset, fileSize: size, doneBytes: doneBytes + offset, totalBytes });
          }
          await localFs.writeFinish(rel, id, size);
          doneBytes += size;
          ok.push(rel);
        } catch (error) {
          await localFs.writeAbort(rel, id).catch(() => {});
          throw error;
        }
      }
      bumpBaseline(ok, remoteManifest);
      setMsg({ kind: 'ok', text: `✓ 已下载 ${ok.length}/${rels.length} 个文件到本地` });
      await scanLocal(localFs);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message === '__TRANSFER_CANCELLED__' ? '下载已取消，未完成文件不会覆盖本地原文件' : `下载失败：${e?.message ?? e}` });
    }
    finally { setBusy(''); setTransfer(null); transferAbortRef.current = false; }
  }, [localFs, workingDir, execKey, collectFiles, bumpBaseline, remoteManifest, scanLocal, transfer]);

  // ⬆ 上传本地改动(本地→云端)
  const push = useCallback(async (node: TNode) => {
    if (!localFs || !workingDir || !localManifest) return;
    if (transfer) return;
    setMsg(null); setBusy('准备上传…');
    transferAbortRef.current = false;
    try {
      const prefix = node.rel ? `${node.rel}/` : '';
      const rels = node.isDir ? Object.keys(localManifest).filter((r) => !node.rel || r === node.rel || r.startsWith(prefix)) : [node.rel];
      if (node.isDir && !window.confirm(`把本地「${node.name || '根'}」下的 ${rels.length} 个文件上传到远端？`)) { setBusy(''); return; }
      const sizes: Record<string, number> = {};
      for (const rel of rels) sizes[rel] = localManifest[rel]?.size ?? await localFs.fileSize(rel);
      const totalBytes = rels.reduce((sum, rel) => sum + sizes[rel], 0);
      const ok: string[] = [];
      let doneBytes = 0;
      for (let i = 0; i < rels.length; i++) {
        const rel = rels[i];
        const size = sizes[rel];
        const id = transferId();
        setBusy(`上传 ${i + 1}/${rels.length}：${rel}`);
        setTransfer({ direction: 'push', rel, fileIndex: i + 1, fileCount: rels.length, fileBytes: 0, fileSize: size, doneBytes, totalBytes });
        const start = await api.syncWriteStart(workingDir, rel, id, execKey);
        if (start.status !== 'ok') throw new Error(start.message || `无法开始上传：${rel}`);
        let offset = 0;
        try {
          while (offset < size) {
            if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
            const data = await localFs.readChunk(rel, offset, Math.min(TRANSFER_CHUNK_SIZE, size - offset));
            const result = await api.syncWriteChunk(workingDir, rel, id, offset, data, execKey);
            if (result.status !== 'ok') throw new Error(result.message || `上传失败：${rel}`);
            const chunkBytes = result.written ?? Math.min(TRANSFER_CHUNK_SIZE, size - offset);
            if (chunkBytes <= 0) throw new Error(`上传返回空分块：${rel}`);
            offset += chunkBytes;
            setTransfer({ direction: 'push', rel, fileIndex: i + 1, fileCount: rels.length, fileBytes: offset, fileSize: size, doneBytes: doneBytes + offset, totalBytes });
          }
          const finish = await api.syncWriteFinish(workingDir, rel, id, size, execKey);
          if (finish.status !== 'ok') throw new Error(finish.message || `上传完成校验失败：${rel}`);
          doneBytes += size;
          ok.push(rel);
        } catch (error) {
          await api.syncWriteAbort(workingDir, rel, id, execKey).catch(() => {});
          throw error;
        }
      }
      bumpBaseline(ok, localManifest);
      setRemoteManifest((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        for (const rel of ok) if (localManifest[rel]) next[rel] = localManifest[rel];
        return next;
      });
      setMsg({ kind: 'ok', text: `✓ 已上传 ${ok.length}/${rels.length} 个文件到远端` });
      await reloadAll();
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message === '__TRANSFER_CANCELLED__' ? '上传已取消，未完成文件不会覆盖远端原文件' : `上传失败：${e?.message ?? e}` });
    }
    finally { setBusy(''); setTransfer(null); transferAbortRef.current = false; }
  }, [localFs, workingDir, execKey, localManifest, bumpBaseline, reloadAll, transfer]);

  /** 为浏览器预览分块取回二进制，绕开旧的 32 MiB 整文件 WS 帧并实时反馈读取进度。 */
  const readPreviewBytes = useCallback(async (
    node: TNode,
    source: PreviewState['source'],
    maxBytes: number,
  ): Promise<Uint8Array> => {
    let size = 0;
    if (source === 'local') {
      if (!localFs) throw new Error('本机目录未连接');
      size = await localFs.fileSize(node.rel);
    } else {
      const stat = await api.syncFileStat(workingDir, node.rel, execKey);
      if (stat.status !== 'ok' || typeof stat.size !== 'number') throw new Error(stat.message || '无法读取文件大小');
      size = stat.size;
    }
    if (size > maxBytes) throw new Error(`文件过大（${formatBytes(size)}），当前预览上限为 ${formatBytes(maxBytes)}`);

    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const requestSize = Math.min(TRANSFER_CHUNK_SIZE, size - offset);
      let encoded = '';
      if (source === 'local') {
        encoded = await localFs!.readChunk(node.rel, offset, requestSize);
      } else {
        const result = await api.syncReadChunk(workingDir, node.rel, offset, requestSize, execKey);
        if (result.status !== 'ok' || result.data == null) throw new Error(result.message || '读取预览分块失败');
        encoded = result.data;
      }
      const chunk = base64ToBytes(encoded);
      if (chunk.length === 0) throw new Error('读取预览时收到空分块');
      output.set(chunk, offset);
      offset += chunk.length;
      const percent = size > 0 ? Math.min(100, Math.round(offset / size * 100)) : 100;
      setPreview((current) => current?.rel === node.rel && current.source === source
        ? { ...current, loadingText: `读取文件… ${percent}%（${formatBytes(offset)} / ${formatBytes(size)}）` }
        : current);
    }
    return output;
  }, [localFs, workingDir, execKey]);

  const structuredPreviewFor = useCallback(async (
    node: TNode,
    source: PreviewState['source'],
    bytes?: Uint8Array,
  ): Promise<StructuredPreviewPayload> => {
    if (source === 'remote') return api.filePreview(workingDir, node.rel, execKey) as Promise<StructuredPreviewPayload>;
    if (!localFs) throw new Error('本机目录未连接');
    const encoded = bytes ? bytesToBase64(bytes) : await localFs.readFile(node.rel);
    return api.filePreviewData(node.name, encoded, execKey) as Promise<StructuredPreviewPayload>;
  }, [workingDir, execKey, localFs]);

  // ── 预览 / 编辑：两端均有时查看远端；仅本机条目直接查看/编辑本机文件。──
  const openPreview = useCallback(async (node: TNode) => {
    const source: PreviewState['source'] = node.local && !node.remote ? 'local' : 'remote';
    const base: PreviewState = { rel: node.rel, name: node.name, source, loading: true, loadingText: '正在准备预览…' };
    setPreview(base); setPreviewMaximized(false); setEditing(false); setDirty(false); setMdRaw(false);
    try {
      if (!workingDir) throw new Error('未打开会话');
      const ext = extOf(node.name);

      if (ext === 'pdf') {
        const bytes = await readPreviewBytes(node, source, PREVIEW_PDF_CAP);
        setPreview({ ...base, loading: false, loadingText: undefined, renderer: 'pdf', bytes });
        return;
      }

      if (ext === 'docx') {
        const bytes = await readPreviewBytes(node, source, PREVIEW_ARCHIVE_CAP);
        setPreview({ ...base, loading: false, loadingText: undefined, renderer: 'docx', bytes });
        return;
      }

      if (ext === 'drawio' || ext === 'dio') {
        const bytes = await readPreviewBytes(node, source, PREVIEW_ARCHIVE_CAP);
        setPreview((current) => current?.rel === node.rel ? { ...current, loadingText: '正在准备 Draw.io 兼容预览…' } : current);
        const structured = await structuredPreviewFor(node, source, bytes);
        const xml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        setPreview({ ...base, loading: false, loadingText: undefined, renderer: 'drawio', drawioXml: xml, structured });
        return;
      }

      if (STRUCTURED_PREVIEW_EXTS.has(ext)) {
        const result = await structuredPreviewFor(node, source);
        setPreview({ ...base, loading: false, structured: result as StructuredPreviewPayload });
        return;
      }
      let b64 = '';
      if (source === 'local') {
        if (!localFs) throw new Error('本机目录未连接');
        b64 = await localFs.readFile(node.rel);
      } else {
        const r = await api.syncReadFile(workingDir, node.rel, execKey);
        if (r.status !== 'ok') throw new Error(r.message || '读取失败');
        if (r.tooLarge) { setPreview({ ...base, loading: false, error: '文件过大，不便预览' }); return; }
        b64 = r.data ?? '';
      }
      if (IMAGE_EXTS.has(ext)) setPreview({ ...base, loading: false, isImage: true, dataUrl: `data:${imageMime(ext)};base64,${b64}` });
      else {
        let text = base64ToText(b64);
        if (text.length > PREVIEW_TEXT_CAP) text = text.slice(0, PREVIEW_TEXT_CAP) + '\n\n…（已截断,仅预览前 200KB）';
        setPreview({ ...base, loading: false, isImage: false, isMarkdown: MARKDOWN_EXTS.has(ext), text });
      }
    } catch (e: any) { setPreview({ ...base, loading: false, error: e?.message ?? String(e) }); }
  }, [workingDir, execKey, localFs, readPreviewBytes, structuredPreviewFor]);

  const fallbackDocxPreview = useCallback((_renderError: string) => {
    const current = preview;
    if (!current || current.renderer !== 'docx' || !current.bytes) return;
    const node: TNode = { name: current.name, rel: current.rel, isDir: false, size: current.bytes.length };
    void structuredPreviewFor(node, current.source, current.bytes).then((structured) => {
      setPreview((latest) => latest?.rel === current.rel && latest.renderer === 'docx'
        ? { ...latest, renderer: undefined, bytes: undefined, structured }
        : latest);
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      setPreview((latest) => latest?.rel === current.rel ? { ...latest, error: `Word 兼容预览也失败：${message}` } : latest);
    });
  }, [preview, structuredPreviewFor]);

  const revealNode = useCallback(async (node: TNode, source: 'local' | 'remote') => {
    setContextMenu(null);
    try {
      if (source === 'local') {
        if (!localFs) throw new Error('尚未指定本机目录');
        await localFs.reveal(node.rel);
      } else {
        if (!workingDir) throw new Error('未打开工作目录');
        const result = await api.revealFile(workingDir, node.rel, execKey);
        if (result.status !== 'ok') throw new Error(result.message || '无法打开文件管理器');
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `定位失败：${e?.message ?? e}` });
    }
  }, [localFs, workingDir, execKey]);

  const revealPreview = useCallback(() => {
    if (!preview) return;
    void revealNode({ name: preview.name, rel: preview.rel, isDir: false, size: 0 }, preview.source);
  }, [preview, revealNode]);

  const startEdit = useCallback(() => { if (preview && !preview.isImage && !preview.structured && !preview.renderer) { setEditText(preview.text || ''); setDirty(false); setEditing(true); } }, [preview]);
  const saveEdit = useCallback(async () => {
    if (!preview || !workingDir) return;
    setSaving(true);
    try {
      if (preview.source === 'local') {
        if (!localFs) throw new Error('本机目录未连接');
        await localFs.writeFile(preview.rel, textToBase64(editText));
      } else {
        const r = await api.syncWriteFile(workingDir, preview.rel, textToBase64(editText), execKey);
        if (r.status !== 'ok') throw new Error(r.message || '保存失败');
      }
      setPreview((p) => (p ? { ...p, text: editText } : p));
      setDirty(false); setEditing(false);
      setMsg({ kind: 'ok', text: `✓ 已保存 ${preview.name}${preview.source === 'local' ? '（本机）' : ''}` });
      if (localFs) scanLocal(localFs);
    } catch (e: any) { setMsg({ kind: 'err', text: `保存失败：${e?.message ?? e}` }); }
    finally { setSaving(false); }
  }, [preview, workingDir, execKey, editText, localFs, scanLocal]);
  const closePreview = useCallback(() => {
    if (editing && dirty && !window.confirm('有未保存的修改，确定关闭？')) return;
    setPreview(null); setPreviewMaximized(false); setEditing(false); setDirty(false);
  }, [editing, dirty]);

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (previewMaximized) setPreviewMaximized(false);
      else closePreview();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview, previewMaximized, closePreview]);

  // ── 渲染 ──
  const fileIcon = (n: TNode, st: FStatus | null): string => {
    if (n.isDir) return expanded[n.rel] ? '📂' : '📁';
    if (st === 'cloud') return '☁️';
    if (st === 'localOnly') return '💻';
    return '📄';
  };

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const nodes = mergedChildren(rel);
    if (children[rel] === undefined && nodes.length === 0) {
      return loading[rel] ? <div style={{ ...emptyStyle, paddingLeft: 24 + depth * 8 }}>加载中…</div> : null;
    }
    if (nodes.length === 0 && depth === 0) return <Empty text="（空目录）" />;
    return nodes.map((n) => {
      const open = !!expanded[n.rel];
      const st = statusOf(n);
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
            onClick={() => {
              setSelected(n.rel);
              if (n.typeConflict) {
                setMsg({ kind: 'err', text: `${n.rel} 在一端是文件、另一端是目录，请先手动处理类型冲突` });
              } else {
                n.isDir ? toggle(n) : openPreview(n);
              }
            }}
            onDoubleClick={() => { if (!n.isDir && !n.typeConflict) openPreview(n); }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelected(n.rel);
              setContextMenu({
                x: Math.min(event.clientX, window.innerWidth - 230),
                y: Math.min(event.clientY, window.innerHeight - 260),
                node: n,
              });
            }}
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
            {!n.isDir && !n.typeConflict && (
              <button className="ftp-act" style={actBtnStyle} title="预览 / 编辑" onClick={(e) => { e.stopPropagation(); openPreview(n); }}>👁</button>
            )}
            {isRemote && localFs && !n.typeConflict && n.remote && (!n.local || n.isDir || st === 'differs' || st === 'conflict') && (
              <button className="ftp-act" style={actBtnStyle} disabled={!!transfer} title="下载到本地" onClick={(e) => { e.stopPropagation(); pull(n); }}>⬇</button>
            )}
            {isRemote && localFs && !n.typeConflict && n.local && (n.isDir || st !== 'synced') && (
              <button className="ftp-act" style={actBtnStyle} disabled={!!transfer} title="上传本地改动到远端" onClick={(e) => { e.stopPropagation(); push(n); }}>⬆</button>
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
        .ftp-act:disabled { opacity: .35 !important; cursor: not-allowed !important; }
        .ftp-hbtn { opacity: 0; transition: opacity 0.12s; }
        .ftp-hdr:hover .ftp-hbtn { opacity: 1; }
      `}</style>

      {/* ★ 消息提示条（面板级） */}
      {msg && !gitModalOpen && (
        <div style={{
          padding: '5px 12px', fontSize: 11, fontWeight: 500,
          background: msg.kind === 'err' ? 'rgba(248,81,73,0.12)' : 'rgba(63,185,80,0.12)',
          color: msg.kind === 'err' ? '#f85149' : '#3fb950',
          display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
        }}>
          <span>{msg.kind === 'err' ? '❌' : '✅'}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.text}</span>
          <button style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11, padding: 0 }}
            onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

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
          >{stashes.length > 0 && <span style={{ marginLeft: 2, fontSize: 10 }}>({stashes.length})</span>}</button>
        )}
        {gitAvailable && (
          <button
            className="ftp-hbtn"
            style={{ ...hdrIconStyle, fontSize: 11, width: 'auto', padding: '0 6px', gap: 3, display: 'inline-flex', alignItems: 'center' }}
            title="查看 Git 提交历史"
            onClick={() => setGitLogOpen(true)}
          > Log</button>
        )}
        <div style={{ flex: 1 }} />
        <button className="ftp-hbtn" style={hdrIconStyle} title="刷新本机与远端目录" onClick={refreshAll}>↻</button>
        <button className="ftp-hbtn" style={hdrIconStyle} title="全部折叠" onClick={() => setExpanded({})}>⊟</button>
      </div>

      {/* 远端目录在执行节点上；这里绑定当前 session 对应的本机目录，可随时更换。 */}
      {isRemote && (
        <div style={localDirBarStyle}>
          <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', flexShrink: 0 }}>💻 本机目录</span>
          <span
            title={localFs?.label() || '尚未指定本机目录'}
            style={{
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 10, fontFamily: 'monospace', color: localFs ? 'var(--theme-text)' : 'var(--theme-text-muted)',
            }}
          >
            {localFs?.label() || '未指定（远端文件仍可在线查看）'}
          </span>
          {localFs && remoteManifest && summary && (
            <span
              title={`仅本机 ${summary.localOnly} · 仅远端 ${summary.cloud} · 不同 ${summary.differs} · 冲突 ${summary.conflict}`}
              style={{ fontSize: 9, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              💻{summary.localOnly} ☁{summary.cloud} ±{summary.differs} ⚠{summary.conflict}
            </span>
          )}
          {localFs && (
            <button style={localDirButtonStyle} disabled={comparing || !!transfer} onClick={runCompare} title="扫描两端并比较文件状态">
              {comparing ? '比对中…' : '↔ 比对'}
            </button>
          )}
          <button style={localDirButtonStyle} disabled={!!transfer} onClick={chooseLocal} title={localFs ? '更换此 session 的本机目录' : '指定此 session 的本机目录'}>
            {localFs ? '更换' : '指定'}
          </button>
        </div>
      )}

      {transfer && (() => {
        const overall = transfer.totalBytes > 0 ? Math.min(100, transfer.doneBytes / transfer.totalBytes * 100) : 100;
        const current = transfer.fileSize > 0 ? Math.min(100, transfer.fileBytes / transfer.fileSize * 100) : 100;
        return (
          <div style={transferBoxStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span>{transfer.direction === 'pull' ? '⬇' : '⬆'}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={transfer.rel}>
                {transfer.direction === 'pull' ? '下载' : '上传'} {transfer.fileIndex}/{transfer.fileCount} · {transfer.rel}
              </span>
              <span style={{ color: 'var(--theme-text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {formatBytes(transfer.fileBytes)} / {formatBytes(transfer.fileSize)}
              </span>
              <button style={transferCancelStyle} onClick={() => { transferAbortRef.current = true; }}>取消</button>
            </div>
            <div style={transferTrackStyle} title={`当前文件 ${current.toFixed(1)}% · 总进度 ${overall.toFixed(1)}%`}>
              <div style={{ ...transferFillStyle, width: `${overall}%` }} />
            </div>
          </div>
        );
      })()}

      {/* ★ Git 快速操作工具条 */}
      {gitAvailable && (
        <div style={gitToolbarStyle}>
          {/* 状态摘要行 — TortoiseGit 风格醒目徽章 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {gitStagedCount > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: '#3fb950',
                background: 'rgba(63,185,80,0.15)', border: '1px solid rgba(63,185,80,0.3)',
                padding: '1px 8px', borderRadius: 10,
              }}
                title="已暂存变更">✓ {gitStagedCount} 已暂存</span>
            )}
            {gitUnstagedCount > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: '#e3b341',
                background: 'rgba(227,179,65,0.12)', border: '1px solid rgba(227,179,65,0.25)',
                padding: '1px 8px', borderRadius: 10,
              }}
                title="未暂存变更">○ {gitUnstagedCount} 未暂存</span>
            )}
            {gitStagedCount === 0 && gitUnstagedCount === 0 && (
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>✓ 工作区干净</span>
            )}
            <div style={{ flex: 1 }} />
            {gitAhead > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: '#58a6ff',
                background: 'rgba(88,166,255,0.12)', padding: '1px 6px', borderRadius: 8,
              }} title="领先远端">⬆ {gitAhead}</span>
            )}
            {gitBehind > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: '#d29922',
                background: 'rgba(210,153,34,0.12)', padding: '1px 6px', borderRadius: 8,
              }} title="落后远端">⬇ {gitBehind}</span>
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
              ...gitMiniBtn, fontWeight: 600,
              ...(gitStagedCount > 0 || gitUnstagedCount > 0) ? { borderColor: 'rgba(63,185,80,0.3)', color: '#3fb950' } : {},
            }}
              onClick={() => setGitModalOpen(true)}
              title="提交变更">
              ✅ 提交{(gitStagedCount + gitUnstagedCount) > 0 ? ` (${gitStagedCount + gitUnstagedCount})` : ''}
            </button>
          </div>
        </div>
      )}

      {/* ★ 文件树滚动区 */}
      <div style={treeScrollStyle}>
        {renderDir('', 0)}
      </div>

      {contextMenu && (() => {
        const n = contextMenu.node;
        const st = statusOf(n);
        return (
          <div
            style={{ ...contextMenuStyle, left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {!n.isDir && !n.typeConflict && (
              <button style={contextItemStyle} onClick={() => { setContextMenu(null); openPreview(n); }}>👁️ 预览 / 编辑</button>
            )}
            {n.remote && (
              <button style={contextItemStyle} onClick={() => revealNode(n, 'remote')}>
                📂 {isRemote ? '在执行端文件夹中显示' : '在文件夹中显示'}
              </button>
            )}
            {isRemote && n.local && localFs && (
              <button style={contextItemStyle} onClick={() => revealNode(n, 'local')}>💻 在本机文件夹中显示</button>
            )}
            {isRemote && localFs && n.remote && !n.typeConflict && (!n.local || n.isDir || st === 'differs' || st === 'conflict') && (
              <button style={{ ...contextItemStyle, ...(transfer ? contextDisabledStyle : {}) }} disabled={!!transfer}
                onClick={() => { setContextMenu(null); pull(n); }}>⬇️ 下载到本机</button>
            )}
            {isRemote && localFs && n.local && !n.typeConflict && (n.isDir || st !== 'synced') && (
              <button style={{ ...contextItemStyle, ...(transfer ? contextDisabledStyle : {}) }} disabled={!!transfer}
                onClick={() => { setContextMenu(null); push(n); }}>⬆️ 上传到执行端</button>
            )}
            <div style={contextSeparatorStyle} />
            <button style={contextItemStyle} onClick={async () => {
              setContextMenu(null);
              try {
                await navigator.clipboard.writeText(n.rel);
                setMsg({ kind: 'ok', text: `✓ 已复制相对路径：${n.rel}` });
              } catch { setMsg({ kind: 'err', text: '复制路径失败' }); }
            }}>📋 复制相对路径</button>
          </div>
        );
      })()}

      {/* ★ Stash 列表 */}
      {stashExpanded && stashes.length > 0 && (
        <div style={stashListStyle}>
          {stashes.map((s, i) => (
            <div key={s.hash || i} style={stashItemStyle}>
              <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.message || s.hash?.slice(0, 7) || `stash@{${i}}`}
              </span>
              <button style={stashBtnStyle} title="应用此 stash (pop)" onClick={() => handleStashPop(i)}>✅</button>
              <button style={stashBtnStyle} title="删除此 stash (drop)" onClick={() => handleStashDrop(i)}>🗑</button>
            </div>
          ))}
        </div>
      )}
      {stashExpanded && stashes.length === 0 && !stashesLoading && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--theme-text-muted)' }}>
          没有 stash
        </div>
      )}

      {/* ★ Git Log 面板 */}
      {gitAvailable && (
        <GitPanel
          workingDir={workingDir}
          execKey={execKey}
          execLabel={execLabel}
          execMode={execMode}
          backendId={backendId}
          open={gitLogOpen}
          onClose={() => setGitLogOpen(false)}
          onCommitComplete={() => { reloadAll(); }}
        />
      )}

      {/* ★ Git 提交弹窗 — 变更列表 + 提交 */}
      {gitModalOpen && gitAvailable && (() => {
        const allFiles = Object.entries(gitFiles).sort(([a], [b]) => a.localeCompare(b));
        // 分成已跟踪和未跟踪两组
        const trackedFiles = allFiles.filter(([_, gf]) => gf.status !== 'untracked');
        const untrackedFiles = allFiles.filter(([_, gf]) => gf.status === 'untracked');
        const totalFiles = allFiles.length;
        const selectedCount = gitSelected.size;
        const allSelected = totalFiles > 0 && selectedCount === totalFiles;
        const sortedPaths = allFiles.map(([p]) => p);
        const trackedPaths = trackedFiles.map(([p]) => p);
        const untrackedPaths = untrackedFiles.map(([p]) => p);
        const toggleGroupSelection = (paths: string[]) => {
          const groupAllSelected = paths.length > 0 && paths.every((p) => gitSelected.has(p));
          setGitSelected((prev) => {
            const next = new Set(prev);
            paths.forEach((p) => groupAllSelected ? next.delete(p) : next.add(p));
            return next;
          });
        };
        const groupCheckbox = (paths: string[], label: string) => {
          const selectedInGroup = paths.filter((p) => gitSelected.has(p)).length;
          const checked = paths.length > 0 && selectedInGroup === paths.length;
          return (
            <input type="checkbox" aria-label={label}
              title={checked ? `取消全选${label}` : `全选${label}`}
              checked={checked}
              ref={(el) => { if (el) el.indeterminate = selectedInGroup > 0 && !checked; }}
              onChange={() => toggleGroupSelection(paths)}
              style={{ ...gitCheckboxStyle, margin: 0 }} />
          );
        };
        return (
          <div style={gitModalOverlayStyle} onClick={() => {
            if (!gitCommitting) {
              setGitModalOpen(false);
              setGitCommitPendingPush(false);
            }
          }}>
            <div style={gitModalBoxStyle} onClick={(e) => e.stopPropagation()}>
              {/* 顶栏 */}
              <div style={gitModalHeaderStyle}>
                <span style={{ fontSize: 15 }}>📦</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#3fb950' }}>提交变更</span>
                <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginLeft: 8 }}>
                  {totalFiles} 个文件变更
                </span>
                {gitAhead > 0 && (
                  <span style={{ fontSize: 11, color: '#58a6ff', marginLeft: 10 }}> {gitAhead} 待推送</span>
                )}
                {gitBehind > 0 && (
                  <span style={{ fontSize: 11, color: '#d29922', marginLeft: 6 }}> {gitBehind} 待拉取</span>
                )}
                <div style={{ flex: 1 }} />
                {/* 全选/取消全选（有文件时才显示） */}
                {totalFiles > 0 && (
                  <button style={gitModalStageAllBtn} onClick={allSelected ? deselectAllFiles : selectAllFiles}
                    title={allSelected ? '取消全选' : '全选所有文件'}>
                    {allSelected ? '☑ 取消全选' : '☐ 全选'}
                  </button>
                )}
                <button style={gitModalCloseBtn} disabled={gitCommitting} onClick={() => { setGitModalOpen(false); deselectAllFiles(); setGitCommitPendingPush(false); }}>✕</button>
              </div>

              {/* ★ 消息提示条 */}
              {msg && (
                <div style={{
                  padding: '6px 16px', fontSize: 12, fontWeight: 500,
                  background: msg.kind === 'err' ? 'rgba(248,81,73,0.12)' : 'rgba(63,185,80,0.12)',
                  color: msg.kind === 'err' ? '#f85149' : '#3fb950',
                  borderBottom: '1px solid ' + (msg.kind === 'err' ? 'rgba(248,81,73,0.2)' : 'rgba(63,185,80,0.2)'),
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span>{msg.kind === 'err' ? '❌' : '✅'}</span>
                  <span style={{ flex: 1 }}>{msg.text}</span>
                  <button style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: 0 }}
                    onClick={() => setMsg(null)}>✕</button>
                </div>
              )}

              {/* ★ 批量操作栏（有选中项时显示） */}
              {selectedCount > 0 && (
                <div style={gitBatchBarStyle}>
                  <span style={{ fontSize: 11, color: 'var(--theme-accent)', fontWeight: 600 }}>
                    已选 {selectedCount} 项
                  </span>
                  <div style={{ flex: 1 }} />
                  <button style={gitBatchBtn('#8b949e')} disabled={gitBatchOperating}
                    onClick={handleBatchIgnore} title="将选中文件加入 .gitignore">🚫 忽略</button>
                  <button style={gitBatchBtn('#f85149')} disabled={gitBatchOperating}
                    onClick={handleBatchDiscard} title="丢弃选中文件的改动">🗑 丢弃</button>
                </div>
              )}

              {/* 主体：左文件列表 + 右提交区 */}
              <div style={gitModalBodyStyle}>
                {/* 左：文件列表（分已跟踪/未跟踪两组） */}
                <div style={gitModalLeftStyle}>
                  {/* 已跟踪文件 */}
                  {trackedFiles.length > 0 && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#c9d1d9', padding: '6px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        {groupCheckbox(trackedPaths, '已跟踪文件')}
                        已跟踪 ({trackedFiles.length})
                      </div>
                      <div style={{ overflowY: 'auto', flex: 'none', maxHeight: '40%' }}>
                        {trackedFiles.map(([path, gf]) => (
                          <div key={path}
                            style={{
                              ...gitModalFileItem,
                              ...(gitSelected.has(path) ? { background: 'rgba(63,185,80,0.06)' } : {}),
                            }}
                            title={`${path} — 点击查看 diff`}
                          >
                            <input type="checkbox" checked={gitSelected.has(path)}
                              onChange={() => toggleFileSelection(path)}
                              style={gitCheckboxStyle} />
                            <span style={gitModalStatusBadge(gf.status)}>{GIT_STATUS_LETTER[gf.status]}</span>
                            <span style={{...gitModalFileName, cursor: 'pointer'}}
                              onClick={() => openDiffPanel(path, sortedPaths)}
                              title="点击查看 diff">{path}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {/* 未跟踪文件 */}
                  {untrackedFiles.length > 0 && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#8b949e', padding: '6px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', marginTop: trackedFiles.length > 0 ? '8px' : 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        {groupCheckbox(untrackedPaths, '未跟踪文件')}
                        未跟踪 ({untrackedFiles.length})
                        <span style={{ fontSize: 10, color: 'var(--theme-text-muted)', marginLeft: 6, fontWeight: 400 }}>
                          点击 ✓ 加入版本控制
                        </span>
                        {untrackedPaths.some((p) => gitSelected.has(p)) && (
                          <button style={{ ...gitModalIgnoreBtn, color: '#3fb950', marginLeft: 'auto', width: 'auto', padding: '2px 8px' }}
                            disabled={untrackedPaths.some((p) => gitAddingPaths.has(p))}
                            onClick={() => handleAddToTracking(untrackedPaths.filter((p) => gitSelected.has(p)))}>
                            ＋ 加入已选
                          </button>
                        )}
                      </div>
                      <div style={{ overflowY: 'auto', flex: 1 }}>
                        {untrackedFiles.map(([path, gf]) => (
                          <div key={path}
                            style={{
                              ...gitModalFileItem,
                              ...(gitSelected.has(path) ? { background: 'rgba(63,185,80,0.06)' } : {}),
                            }}
                            title={`${path} — 点击查看 diff`}
                          >
                            <input type="checkbox" checked={gitSelected.has(path)}
                              onChange={() => toggleFileSelection(path)}
                              style={gitCheckboxStyle} />
                            <span style={gitModalStatusBadge(gf.status)}>{GIT_STATUS_LETTER[gf.status]}</span>
                            <span style={{...gitModalFileName, cursor: 'pointer'}}
                              onClick={() => openDiffPanel(path, sortedPaths)}
                              title="点击查看 diff">{path}</span>
                            {/* 加入版本控制按钮 */}
                            <button style={{...gitModalIgnoreBtn, color: '#3fb950'}} title="加入版本控制 (git add)"
                              disabled={gitAddingPaths.has(path)}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAddToTracking([path]);
                              }}>{gitAddingPaths.has(path) ? '…' : '✓'}</button>
                            <button style={gitModalIgnoreBtn} title="忽略此文件（加入 .gitignore）"
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!workingDir) return;
                                await api.gitIgnore(workingDir, [path], execKey);
                              }}>🚫</button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {totalFiles === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', padding: '16px 14px', textAlign: 'center' }}>
                      ✓ 工作区干净，没有变更
                    </div>
                  )}
                </div>

                {/* 右：提交区 — commit message 在顶部 */}
                <div style={gitModalRightStyle}>
                  {/* commit message 输入区（占满右侧上方空间） */}
                  <div style={{
                    flex: 1, padding: '12px 16px',
                    borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
                    display: 'flex', flexDirection: 'column', minHeight: 0,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#c9d1d9', marginBottom: 8 }}>
                      Commit Message
                    </div>
                    <textarea
                      style={{
                        ...gitModalTextareaStyle,
                        flex: 1, minHeight: 80, marginBottom: 8,
                        resize: 'none',
                      }}
                      placeholder="输入 commit message…（可留空由 AI 生成）"
                      value={gitCommitMsg}
                      onChange={(e) => setGitCommitMsg(e.target.value)}
                    />
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button style={gitModalAiBtn} disabled={gitAiGenerating} onClick={handleAiGenerateMsg}
                        title="AI 根据 diff 生成 commit message">
                        {gitAiGenerating ? '⏳ 生成中…' : '✨ AI 生成'}
                      </button>
                      <div style={{ flex: 1 }} />
                      {/* 提交（仅 commit） */}
                      <button type="button" style={{
                        ...gitModalCommitBtn,
                        ...((gitCommitMsg.trim() && selectedCount > 0) ? {} : { opacity: 0.5, cursor: 'not-allowed' }),
                      }}
                        disabled={(!gitCommitPendingPush && (!gitCommitMsg.trim() || selectedCount === 0)) || gitCommitting}
                        onClick={(e) => { e.stopPropagation(); handleCommit(); }}
                        title={selectedCount === 0 ? '请先选择要提交的文件' : '提交变更'}>
                        {gitCommitting ? '⏳ 提交中…' : '✅ 提交'}
                      </button>
                      {/* 提交并推送（小乌龟风格一步到位） */}
                      <button type="button" style={{
                        ...gitModalCommitBtn,
                        background: (gitCommitMsg.trim() && selectedCount > 0) ? 'linear-gradient(135deg, #2ea043, #238636)' : 'rgba(46,160,67,0.3)',
                        ...((gitCommitMsg.trim() && selectedCount > 0) ? {} : { opacity: 0.5, cursor: 'not-allowed' }),
                      }}
                        disabled={!gitCommitMsg.trim() || selectedCount === 0 || gitCommitting}
                        onClick={(e) => { e.stopPropagation(); handleCommitAndPush(); }}
                        title={selectedCount === 0 ? '请先选择要提交的文件' : '提交后立即推送到远端'}>
                        {gitCommitting ? '⏳ 处理中…' : gitCommitPendingPush ? '⬆ 重试推送' : '🚀 提交并推送'}
                      </button></div>
                    </div>

                  {/* 底部提示 */}
                  <div style={{
                    padding: '8px 16px',
                    color: 'var(--theme-text-muted)',
                    fontSize: 10.5, lineHeight: 1.6,
                  }}>
                    <div>💡 点击文件名可打开 diff 对比面板</div>
                    <div>💡 勾选要提交的文件 · 🚫 忽略</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {preview && (
        <div style={pvOverlay} onClick={closePreview}>
          <div style={{ ...pvBox, ...(previewMaximized ? pvBoxMaximized : {}) }} onClick={(e) => e.stopPropagation()}>
            <div style={pvHeader}>
              <span style={{ fontSize: 13 }}>{preview.isImage ? '🖼️' : preview.renderer === 'pdf' ? '📕' : preview.renderer === 'docx' ? '📘' : preview.renderer === 'drawio' ? '🧩' : preview.structured ? '📊' : editing ? '✏️' : '📄'}</span>
              <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={preview.rel}>
                {dirty && <span style={{ color: 'var(--theme-accent)' }}>● </span>}{preview.name}
              </span>
              <span style={{ ...tagStyle, marginLeft: 0 }}>
                {preview.source === 'local' ? '💻 本机' : '☁️ 远端'}
              </span>
              <div style={{ flex: 1 }} />
              {!preview.loading && (
                <button style={hdrBtnStyle} onClick={revealPreview} title="在系统文件管理器中定位">📂 定位</button>
              )}
              {!editing && preview.isMarkdown && !preview.loading && !preview.error && (
                <div style={{ display: 'flex', border: '1px solid var(--theme-border)', borderRadius: 6, overflow: 'hidden', marginRight: 4 }}>
                  <button style={{ ...segBtnStyle, ...(!mdRaw ? segActiveStyle : {}) }} onClick={() => setMdRaw(false)}>👁 预览</button>
                  <button style={{ ...segBtnStyle, ...(mdRaw ? segActiveStyle : {}) }} onClick={() => setMdRaw(true)}>{'</> 源码'}</button>
                </div>
              )}
              {!editing && !preview.isImage && !preview.structured && !preview.renderer && !preview.loading && !preview.error && (
                <button style={hdrBtnStyle} onClick={startEdit}>✏️ 编辑</button>
              )}
              {editing && (
                <>
                  <button style={{ ...hdrBtnStyle, ...(dirty && !saving ? { borderColor: 'var(--theme-accent)', color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)' } : { opacity: 0.5 }) }}
                    onClick={saveEdit} disabled={!dirty || saving}>{saving ? '保存中…' : '💾 保存'}</button>
                  <button style={hdrBtnStyle} onClick={() => {
                    if (!dirty || window.confirm('放弃未保存的修改？')) { setEditing(false); setDirty(false); }
                  }}>取消</button>
                </>
              )}
              <button style={hdrBtnStyle} onClick={() => setPreviewMaximized((value) => !value)} title={previewMaximized ? '退出最大化（Esc）' : '最大化预览'}>
                {previewMaximized ? '🗗 还原' : '⛶ 最大化'}
              </button>
              <button style={hdrBtnStyle} onClick={closePreview}>✕</button>
            </div>
            <div style={pvBody}>
              {preview.loading ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>{preview.loadingText || '加载中…'}</div>
              ) : preview.error ? (
                <div style={{ padding: 24, color: '#f87171', fontSize: 13 }}>⚠ {preview.error}</div>
              ) : editing ? (
                <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>编辑器加载中…</div>}>
                  <CodeEditor key={preview.rel} value={editText} ext={extOf(preview.name)} dark={isDarkTheme()}
                    onChange={(v) => { setEditText(v); setDirty(true); }} onSave={saveEdit} />
                </Suspense>
              ) : preview.isImage ? (
                <div style={{ padding: 12, textAlign: 'center', overflow: 'auto' }}>
                  <img src={preview.dataUrl} alt={preview.name} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
                </div>
              ) : preview.renderer === 'pdf' && preview.bytes ? (
                <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>PDF.js 加载中…</div>}>
                  <PdfPreview data={preview.bytes} />
                </Suspense>
              ) : preview.renderer === 'docx' && preview.bytes ? (
                <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>Word 渲染器加载中…</div>}>
                  <DocxPreview data={preview.bytes} onFallback={fallbackDocxPreview} />
                </Suspense>
              ) : preview.renderer === 'drawio' && preview.drawioXml ? (
                <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>Draw.io Viewer 加载中…</div>}>
                  <DrawioPreview xml={preview.drawioXml} fallback={preview.structured} onReveal={revealPreview} />
                </Suspense>
              ) : preview.structured ? (
                <StructuredFilePreview preview={preview.structured} onReveal={revealPreview} />
              ) : preview.isMarkdown && !mdRaw ? (
                <div style={{ padding: '8px 18px', fontSize: 14, overflow: 'auto' }}
                  dangerouslySetInnerHTML={{ __html: markdownToHtml(preview.text || '') }} />
              ) : (
                <pre className="md-pre" style={pvPre}>
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(preview.text || '', extOf(preview.name)) }} />
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* \u2605 Git Diff \u72ec\u7acb\u9762\u677f */}
      {diffPanelOpen && (
        <div style={diffOverlayStyle} onClick={() => setDiffPanelOpen(false)}>
          <div style={diffBoxStyle} onClick={(e) => e.stopPropagation()}>
            {/* \u9876\u680f\uff1a\u6587\u4ef6\u540d + \u4e0a/\u4e0b\u4e00\u4e2a */}
            <div style={diffTopBarStyle}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#c9d1d9' }}>
                \ud83d\udcc4 {diffPanelFile || '(no file)'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginLeft: 12 }}>
                {diffPanelAllFiles.length > 0
                  ? `${diffPanelAllFiles.indexOf(diffPanelFile) + 1} / ${diffPanelAllFiles.length}`
                  : ''}
              </span>
              <div style={{ flex: 1 }} />
              <button style={diffNavBtn} disabled={diffPanelAllFiles.indexOf(diffPanelFile) <= 0}
                onClick={diffPanelPrevFile} title={"\u4e0a\u4e00\u4e2a\u6587\u4ef6"}>{"\u25c0 \u4e0a\u4e00\u4e2a"}</button>
              <button style={diffNavBtn} disabled={diffPanelAllFiles.indexOf(diffPanelFile) >= diffPanelAllFiles.length - 1}
                onClick={diffPanelNextFile} title={"\u4e0b\u4e00\u4e2a\u6587\u4ef6"}>{"\u4e0b\u4e00\u4e2a \u25b6"}</button>
              <button style={diffCloseBtn} onClick={() => setDiffPanelOpen(false)}>{"\u2715"}</button>
            </div>
            {/* Diff \u5185\u5bb9 */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {diffPanelLoading ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text-muted)' }}>
                  {"\u52a0\u8f7d\u4e2d\u2026"}
                </div>
              ) : (
                <DiffViewer diff={diffPanelDiff} filename={diffPanelFile} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const pvOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10020,
  background: 'rgba(0,0,0,0.58)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const pvBox: React.CSSProperties = {
  width: '82vw', maxWidth: 1100, height: '82vh',
  background: 'var(--theme-bg-secondary, #161b22)', color: 'var(--theme-text, #c9d1d9)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', borderRadius: 10,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 18px 56px rgba(0,0,0,0.55)',
};
const pvBoxMaximized: React.CSSProperties = {
  width: '100vw', maxWidth: 'none', height: '100vh',
  border: 'none', borderRadius: 0, boxShadow: 'none',
};
const pvHeader: React.CSSProperties = {
  height: 42, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8,
  flexShrink: 0, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
};
const pvBody: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' };
const pvPre: React.CSSProperties = {
  margin: 0, padding: '14px 18px', minHeight: '100%', boxSizing: 'border-box',
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.55,
  background: 'var(--theme-code-bg, #0d1117)', color: 'var(--theme-text, #c9d1d9)',
};
const hdrBtnStyle: React.CSSProperties = {
  padding: '4px 9px', fontSize: 11, borderRadius: 5,
  border: '1px solid var(--theme-border, rgba(255,255,255,0.14))',
  background: 'var(--theme-bg-tertiary, rgba(255,255,255,0.05))',
  color: 'var(--theme-text, #c9d1d9)', cursor: 'pointer', flexShrink: 0,
};
const segBtnStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 10.5, border: 'none', background: 'transparent',
  color: 'var(--theme-text-muted, #8b949e)', cursor: 'pointer',
};
const segActiveStyle: React.CSSProperties = {
  color: 'var(--theme-accent, #58a6ff)', background: 'var(--theme-accent-bg, rgba(88,166,255,0.12))',
};

// \u2500\u2500 Git \u5f39\u7a97\u6837\u5f0f \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const gitModalOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9998,
  background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const gitModalBoxStyle: React.CSSProperties = {
  width: '82vw', maxWidth: 1200, height: '82vh',
  background: '#161b22', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
};
const gitModalHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)', flexShrink: 0,
};
const gitModalBodyStyle: React.CSSProperties = {
  flex: 1, display: 'flex', overflow: 'hidden',
};
const gitModalLeftStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', borderRight: '1px solid rgba(255,255,255,0.06)',
  minWidth: 0,
};
const gitModalRightStyle: React.CSSProperties = {
  width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column',
  background: 'rgba(255,255,255,0.02)',
};
const gitModalFileItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '5px 14px', fontSize: 12, borderBottom: '1px solid rgba(255,255,255,0.04)',
  cursor: 'default',
};
const gitModalFileName: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: '#c9d1d9', fontSize: 12,
};
const gitModalStatusBadge = (status: string): React.CSSProperties => {
  const colors: Record<string, string> = {
    modified: '#d29922', added: '#3fb950', deleted: '#f85149',
    renamed: '#58a6ff', untracked: '#8b949e', conflicted: '#f85149',
    copied: '#58a6ff',
  };
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 18, height: 18, borderRadius: 4, fontSize: 10, fontWeight: 700,
    background: (colors[status] || '#8b949e') + '22',
    color: colors[status] || '#8b949e', flexShrink: 0,
  };
};
const gitCheckboxStyle: React.CSSProperties = {
  width: 14, height: 14, accentColor: '#3fb950', cursor: 'pointer', flexShrink: 0,
};
const gitModalStageBtn: React.CSSProperties = {
  padding: '1px 6px', fontSize: 11, borderRadius: 4, border: '1px solid rgba(63,185,80,0.3)',
  background: 'rgba(63,185,80,0.1)', color: '#3fb950', cursor: 'pointer', flexShrink: 0,
};
const gitModalUnstageBtn: React.CSSProperties = {
  padding: '1px 6px', fontSize: 11, borderRadius: 4, border: '1px solid rgba(248,81,73,0.3)',
  background: 'rgba(248,81,73,0.1)', color: '#f85149', cursor: 'pointer', flexShrink: 0,
};
const gitModalIgnoreBtn: React.CSSProperties = {
  padding: '1px 6px', fontSize: 11, borderRadius: 4, border: '1px solid rgba(139,148,158,0.3)',
  background: 'rgba(139,148,158,0.1)', color: '#8b949e', cursor: 'pointer', flexShrink: 0,
};
const gitModalStageAllBtn: React.CSSProperties = {
  padding: '3px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)',
  color: '#c9d1d9', cursor: 'pointer',
};
const gitModalCloseBtn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 13, borderRadius: 4,
  border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer',
};
const gitModalTextareaStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
  background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#c9d1d9', fontFamily: 'inherit',
};
const gitModalCommitBtn: React.CSSProperties = {
  padding: '6px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
  border: '1px solid rgba(9,105,218,0.5)', background: 'linear-gradient(135deg, #2188ff, #0969da)',
  color: '#fff', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
};
const gitModalAiBtn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(88,166,255,0.3)', background: 'rgba(88,166,255,0.1)',
  color: '#58a6ff', cursor: 'pointer',
};
const gitBatchBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 16px', background: 'rgba(88,166,255,0.06)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};
const gitBatchBtn = (color: string): React.CSSProperties => ({
  padding: '3px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid ' + color + '44', background: color + '18',
  color, cursor: 'pointer',
});

// \u2500\u2500 Diff \u9762\u677f\u6837\u5f0f \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const diffOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10000,
  background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const diffBoxStyle: React.CSSProperties = {
  width: '90vw', height: '85vh',
  background: '#1e1e1e', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
};
const diffTopBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: '#252526', flexShrink: 0,
};
const diffNavBtn: React.CSSProperties = {
  padding: '3px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)',
  color: '#c9d1d9', cursor: 'pointer',
};
const diffCloseBtn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 13, borderRadius: 4,
  border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer',
};


// ── Empty 组件 ──────────────────────────────────────────────────
const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
    {text}
  </div>
);

// ── 文件树样式 ──────────────────────────────────────────────────

const wrapStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%',
  background: 'var(--theme-bg-secondary, #1e1e1e)',
  color: 'var(--theme-text, #c9d1d9)',
  fontSize: 12, overflow: 'hidden',
};

const topBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '6px 10px', flexShrink: 0,
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const localDirBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', flexShrink: 0,
  background: 'var(--theme-bg-tertiary, rgba(255,255,255,0.025))',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const transferBoxStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 5, padding: '6px 10px', flexShrink: 0,
  background: 'var(--theme-accent-bg, rgba(88,166,255,0.08))',
  borderBottom: '1px solid var(--theme-accent-border, rgba(88,166,255,0.22))',
  color: 'var(--theme-text)', fontSize: 10.5,
};
const transferTrackStyle: React.CSSProperties = {
  height: 5, overflow: 'hidden', borderRadius: 6, background: 'rgba(127,127,127,.22)',
};
const transferFillStyle: React.CSSProperties = {
  height: '100%', borderRadius: 6, background: 'linear-gradient(90deg, #0969da, #58a6ff)',
  transition: 'width .12s linear',
};
const transferCancelStyle: React.CSSProperties = {
  border: '1px solid rgba(248,81,73,.35)', borderRadius: 5, background: 'rgba(248,81,73,.1)',
  color: '#f85149', fontSize: 10, padding: '2px 7px', cursor: 'pointer',
};

const contextMenuStyle: React.CSSProperties = {
  position: 'fixed', zIndex: 10100, width: 215, padding: 5,
  background: 'var(--theme-bg-secondary, #1b2028)', color: 'var(--theme-text, #c9d1d9)',
  border: '1px solid var(--theme-border, rgba(255,255,255,.14))', borderRadius: 8,
  boxShadow: '0 10px 30px rgba(0,0,0,.45)',
};
const contextItemStyle: React.CSSProperties = {
  display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 9px',
  border: 'none', borderRadius: 5, background: 'transparent', color: 'inherit',
  fontSize: 11.5, textAlign: 'left', cursor: 'pointer',
};
const contextDisabledStyle: React.CSSProperties = { opacity: .4, cursor: 'not-allowed' };
const contextSeparatorStyle: React.CSSProperties = { height: 1, margin: '4px 5px', background: 'var(--theme-border, rgba(255,255,255,.1))' };

const localDirButtonStyle: React.CSSProperties = {
  padding: '2px 7px', borderRadius: 5, flexShrink: 0, cursor: 'pointer', fontSize: 10,
  background: 'var(--theme-accent-bg, rgba(88,166,255,0.1))',
  color: 'var(--theme-accent, #58a6ff)',
  border: '1px solid var(--theme-accent-border, rgba(88,166,255,0.25))',
};

const tagStyle: React.CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(88,166,255,0.15)', color: '#58a6ff',
  border: '1px solid rgba(88,166,255,0.25)', marginLeft: 4,
  maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const gitBranchBadgeStyle: React.CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(63,185,80,0.12)', color: '#3fb950',
  border: '1px solid rgba(63,185,80,0.25)', marginLeft: 4,
};

const hdrIconStyle: React.CSSProperties = {
  width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', color: 'var(--theme-text-muted, #8b949e)',
  cursor: 'pointer', borderRadius: 4, fontSize: 13, flexShrink: 0,
};

const gitToolbarStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  padding: '6px 10px',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const gitMiniBtn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 10.5, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)',
  color: 'var(--theme-text, #c9d1d9)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 3,
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 2,
  padding: '2px 4px', cursor: 'pointer', userSelect: 'none',
  borderRadius: 3, minHeight: 22,
};

const emptyStyle: React.CSSProperties = {
  padding: '12px 16px', color: 'var(--theme-text-muted, #8b949e)',
  fontSize: 11, textAlign: 'center',
};

const guideStyle: React.CSSProperties = {
  display: 'inline-block', width: 8, height: 1,
  background: 'var(--theme-border, rgba(255,255,255,0.1))',
  marginRight: 2, flexShrink: 0,
};

const chevronStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 14, height: 14, fontSize: 10, color: 'var(--theme-text-muted, #8b949e)',
  flexShrink: 0,
};

const iconStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 18, height: 18, fontSize: 13, flexShrink: 0,
};

const nameStyle: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontSize: 12, color: 'var(--theme-text, #c9d1d9)',
};

const actBtnStyle: React.CSSProperties = {
  width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', color: 'var(--theme-text-muted, #8b949e)',
  cursor: 'pointer', borderRadius: 3, fontSize: 11, flexShrink: 0, padding: 0,
};

// ── 文件树容器 & stash 样式 ───────────────────────────────────

const treeScrollStyle: React.CSSProperties = {
  flex: 1, overflow: 'auto', minHeight: 0,
  padding: '2px 0',
};

const stashListStyle: React.CSSProperties = {
  borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  maxHeight: 160, overflow: 'auto',
};

const stashItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.04)',
  fontSize: 11,
};

const stashBtnStyle: React.CSSProperties = {
  width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', cursor: 'pointer',
  fontSize: 11, borderRadius: 3, flexShrink: 0,
};
