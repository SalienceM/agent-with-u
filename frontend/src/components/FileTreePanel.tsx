/**
 * FileTreePanel — 会话工作目录的**单一**文件树(替代原「远端 / 本地」两棵树)。
 *
 * 参照群晖(Synology Drive)的"在线/离线"逻辑:一棵树,每个文件带一个状态角标：
 *   ☁️ 云端(仅远端有,未下载) · ✓ 本地(已下载/一致) · ± 差异 · ⚠ 冲突
 *
 * 会话类型不同,呈现不同(做好兼容)：
 *   · 远端会话，或 Web/平板访问任意会话：文件默认都是 ☁️ 执行端文件。
 *     预览按需拉取，编辑使用完整读取/版本保存接口。可选配一个"本地目录"作副本,
 *     下载后变 ✓ 本地,可离线/比对(🔍)/双向同步(⬆⬇)。
 *   · 本地会话(execMode='local')：工作目录本来就在本机,没有"远端"这一说,不显示云朵,
 *     直接就是普通文件树,点开即看/即改。
 *
 * 执行端文档按 execKey 精确路由；显式打开本机副本则使用独立来源与安全适配器。
 * 保存副本不上传，编辑绝不回退 syncWriteFile；原明确传输入口保持既有语义。
 */
import React, { useCallback, useEffect, useMemo, useState, useRef, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import hljs from 'highlight.js';
import { api, isTauri, getCurrentUserProfile, getSessionExecKey, onCurrentUserChanged } from '../api';
import { markdownToHtml } from '../utils/markdown';
import { buildStandaloneMarkdownHtml, markdownHtmlFilename } from '../utils/markdownExport';
import { GitPanel } from './GitPanel';
import { WorkbenchFileCommands } from './WorkbenchFileCommands';
import { WorkbenchButton, WorkbenchIcon, WorkbenchOverflow } from './WorkbenchChrome';
import type { GitFileStatus, GitFileStatusType, GitStashEntry } from '../types/git';
import { DiffViewer } from './DiffViewer';
import { StructuredFilePreview, type StructuredPreviewPayload } from './StructuredFilePreview';
import { MarkdownPreview } from './MarkdownPreview';
import { AppModalPortal, WorkbenchInteractionContext } from './AppModalPortal';
import { useWindowWriteBlocked } from '../hooks/useWindowWriteBlocked';
import type { ProvOpenResult } from '../types/prov';
import {
  pickLocalDir, restoreLocalDir, loadBaseline, saveBaseline,
  browserDirectoryPickerSupported, exportLocalFile, importLocalFile,
  isGitMetadataPath, offlineAppShellSupported, useManagedLocalDir,
  type LocalFs, type Manifest, type FileMeta,
} from '../utils/dirSync';
import {
  describeSyncFreshness, type SyncFreshness, type SyncFreshnessKind,
} from '../utils/dirSyncFreshness';
import {
  normalizeRelativeFilePath,
  sameWorkspacePath,
  type FileFocusRequest,
} from '../utils/fileFocus';
import { rankFileSearchPaths } from '../utils/fileSearch';
import { buildFileAttentionContext, type AttentionContext } from '../utils/attentionContext';
import { fileTransfers, type TransferProgress } from '../utils/fileTransfers';
import { buildLocalManifestTree } from '../utils/localFileTree';
import { buildGitDirectoryStatuses } from '../utils/fileTreeGit';
import { loadDocumentPreview, defaultDocumentView, extOf, type DocumentPreview } from '../utils/documentPreview';
import { documentStore, readonlyDocumentClient, type DocumentClient } from '../utils/documentStore';
import { documentDrafts, type StoredDocumentDraft } from '../utils/documentDrafts';
import { LocalDocuments } from '../utils/localDocuments';
import { IndexedLocalJournal } from '../utils/localDocumentStorage';
import { DocumentProtocolError, sameWorkspace } from '../utils/workspaceDocuments';
import type { DiskVersion } from '../utils/sessionWorkbench';
import type { EditorDocumentState } from '../utils/editorDocumentState';
import { handoffParticipants, handoffScope } from '../utils/workbenchHandoffState';
import type { RecoverableDraft } from '../utils/documentStore';
import { useLanguageEditor } from '../hooks/useLanguageEditor';

const CodeEditor = lazy(() => import('./CodeEditor'));
const PdfPreview = lazy(() => import('./PdfPreview'));
const DocxPreview = lazy(() => import('./DocxPreview'));
const DrawioPreview = lazy(() => import('./DrawioPreview'));
const HtmlPreview = lazy(() => import('./HtmlPreview'));
const ReviewWorkbench = lazy(() => import('./review/ReviewWorkbench'));
const DocumentDraftRecovery = lazy(() => import('./DocumentDraftRecovery').then(module => ({ default: module.DocumentDraftRecovery })));

interface Props {
  sessionId?: string;
  workingDir: string;
  execKey?: string;
  execLabel?: string;
  execMode?: 'local' | 'relay';   // 会话运行在哪：本机 / 远端中继节点
  backendId?: string;             // ★ 当前会话的 backendId —— 供 AI 生成 commit message 使用
  focusRequest?: FileFocusRequest | null;
  onAttentionChange?: (context: AttentionContext | null) => void;
  documentHost?: HTMLDivElement;
  isVisible?: boolean;
  onDocumentOpen?: () => void;
  onBrowseFiles?: () => void;
}

/** 同一预览/编辑实现：Chat 仍是模态，Engine 只改变 DOM 挂载位置。 */
const DocumentSurface: React.FC<React.PropsWithChildren<{ host?: HTMLDivElement }>> = ({ host, children }) =>
  host ? createPortal(children, host) : <AppModalPortal>{children}</AppModalPortal>;

type DocumentSelection = { key: string; client: DocumentClient; scope: string };
type DocumentView = 'preview' | 'source' | 'split';
interface FileTab { id: string; rel: string; name: string; source: 'local' | 'remote'; view: DocumentView; document?: DocumentSelection }
const fileTabId = (file: { rel: string; source: string }) => JSON.stringify([file.source, file.rel]);

interface TNode {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  /** 懒加载目录直接返回的远端文件修改时间（Unix 毫秒）。 */
  remoteMtime?: number;
  /** 该条目实际存在于哪一端；合并树会把同路径的两端标记合在一个节点上。 */
  remote?: boolean;
  local?: boolean;
  typeConflict?: boolean;
}

const FILE_SEARCH_LIMIT = 200;
const FILE_SEARCH_DEBOUNCE_MS = 180;

// 文件同步状态(群晖式)。远端会话才有;本地会话恒为 null(不显示角标)。
type FStatus = 'cloud' | 'local' | 'localOnly' | 'synced' | 'differs' | 'conflict';
const STATUS_COLOR: Record<Exclude<FStatus, 'cloud'>, string> = {
  local: '#22c55e', localOnly: '#38bdf8', synced: '#22c55e', differs: '#f59e0b', conflict: '#ef4444',
};
const STATUS_LABEL: Record<FStatus, string> = {
  cloud: '仅远端 — 可下载到本机', local: '两端均有 · 尚未比对', localOnly: '仅本机 — 可上传到远端', synced: '本机 · 与远端一致',
  differs: '本地与远端不同', conflict: '冲突 · 两端都改过',
};

const FRESHNESS_LABEL: Record<SyncFreshnessKind, string> = {
  same: '与远端一致',
  'local-only': '仅本机',
  'remote-only': '远端 · 未下载',
  'local-updated': '本地更新',
  'remote-updated': '远端更新',
  'both-updated': '两端均更新',
  'different-unknown': '内容不同',
};

function formatSyncTime(value: number | undefined, full = false): string {
  if (!value || !Number.isFinite(value)) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', full
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  const short = `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  return full ? `${get('year')}-${short}:${get('second')}` : short;
}

function freshnessTime(freshness: SyncFreshness): number | undefined {
  if (freshness.kind === 'local-updated' || freshness.kind === 'local-only') return freshness.localMtime;
  if (freshness.kind === 'remote-updated' || freshness.kind === 'remote-only') return freshness.remoteMtime;
  return undefined;
}

function freshnessDetail(freshness: SyncFreshness): string {
  if (freshness.kind === 'both-updated') {
    const local = formatSyncTime(freshness.localMtime);
    const remote = formatSyncTime(freshness.remoteMtime);
    const times = [local ? `本 ${local}` : '', remote ? `远 ${remote}` : ''].filter(Boolean).join(' / ');
    return `两端均更新${times ? ` · ${times}` : ''}`;
  }
  const time = formatSyncTime(freshnessTime(freshness));
  if (freshness.kind === 'different-unknown') return '内容不同 · 无法可靠判定较新一端';
  return `${FRESHNESS_LABEL[freshness.kind]}${time ? ` · ${time}` : ''}`;
}

function freshnessTooltip(freshness: SyncFreshness): string {
  const local = formatSyncTime(freshness.localMtime, true);
  const remote = formatSyncTime(freshness.remoteMtime, true);
  const lines = [freshnessDetail(freshness)];
  if (local) lines.push(`本地修改：${local}`);
  if (remote) lines.push(`远端修改：${remote}`);
  if (freshness.basis === 'baseline') lines.push('判定依据：上次同步基线');
  else if (freshness.basis === 'mtime') lines.push('判定依据：文件修改时间（首次比对，无同步基线）');
  return lines.join('\n');
}

/** 把本机完整文件清单一次性索引成逐级目录树，避免每次展开都全表扫描。 */

// ── Git 状态角标（TortoiseGit 风格）──
const GIT_STATUS_COLOR: Record<GitFileStatusType, string> = {
  modified: '#e3b341', added: '#3fb950', deleted: '#f85149',
  renamed: '#a371f7', copied: '#a371f7', untracked: '#8b949e', conflicted: '#f85149',
};
const GIT_STATUS_LETTER: Record<GitFileStatusType, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!',
};

// ── 预览/高亮/编辑 复用(highlight.js + marked + CodeMirror 懒加载)──
const PROV_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const PROV_TEXT_EXTS = new Set(['md', 'markdown', 'mdx', 'txt']);
// 后端与 Tauri 原语均允许 1 MiB；用满单块可把高延迟中继下的往返次数减半。
const TRANSFER_CHUNK_SIZE = 1024 * 1024;
// 不同文件拥有独立临时文件/transferId，可安全并行；限制为 4，兼顾吞吐与内存。
const TRANSFER_FILE_CONCURRENCY = 4;
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', json: 'json',
  jsonc: 'json', xml: 'xml', html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml', css: 'css', scss: 'scss',
  less: 'less', sql: 'sql', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', md: 'markdown',
  markdown: 'markdown', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', pl: 'perl',
};
function escapeHtml(s: string): string { return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')); }
function highlightCode(text: string, ext: string): string {
  const lang = LANG_ALIAS[ext] || ext;
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    return text.length > 0 ? hljs.highlightAuto(text).value : '';
  } catch { return escapeHtml(text); }
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
type GeneratedTextExportResult =
  | { mode: 'saved'; destination: string }
  | { mode: 'shared' }
  | { mode: 'downloaded' }
  | { mode: 'cancelled' };

async function exportGeneratedText(text: string, filename: string, mime: string): Promise<GeneratedTextExportResult> {
  const blob = new Blob([text], { type: mime });
  const html = mime.startsWith('text/html');

  // 桌面应用必须使用原生“另存为”，不能把文件静默丢进默认下载目录。
  if (isTauri()) {
    const [{ save }, { downloadDir, join }, { invoke }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/api/path'),
      import('@tauri-apps/api/core'),
    ]);
    const defaultPath = await join(await downloadDir(), filename);
    const destination = await save({
      defaultPath,
      filters: [
        { name: html ? 'HTML 文档' : '文本草稿', extensions: html ? ['html', 'htm'] : ['txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (!destination) return { mode: 'cancelled' };
    await invoke('write_export_text_file', { path: destination, data: text });
    return { mode: 'saved', destination };
  }

  // Chromium/Edge 网页端支持原生文件选择器；用户可以明确选择目录和文件名。
  const picker = (window as any).showSaveFilePicker as undefined | ((options: any) => Promise<any>);
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{
          description: html ? 'HTML 文档' : '文本草稿',
          accept: html ? { 'text/html': ['.html', '.htm'] } : { 'text/plain': ['.txt'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { mode: 'saved', destination: String(handle.name || filename) };
    } catch (error: any) {
      if (error?.name === 'AbortError') return { mode: 'cancelled' };
      throw error;
    }
  }

  // iOS/Safari 等没有文件选择器的平台优先交给系统分享/“存储到文件”。
  const file = new File([blob], filename, { type: mime });
  const nav = navigator as any;
  if (typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [file] }))) {
    try {
      await nav.share({ files: [file], title: filename });
      return { mode: 'shared' };
    } catch (error: any) {
      if (error?.name === 'AbortError') return { mode: 'cancelled' };
      // 系统分享不可用时继续回落到浏览器下载。
    }
  }
  const href = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { mode: 'downloaded' };
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  }
}
function isDarkTheme(): boolean {
  try {
    const el = document.querySelector('.app-root') as HTMLElement | null;
    const raw = (el ? getComputedStyle(el).getPropertyValue('--theme-panel-solid') || getComputedStyle(el).getPropertyValue('--theme-bg') : '').trim() || getComputedStyle(document.body).backgroundColor;
    let r = 20, g = 20, b = 30;
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else { const m = raw.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); if (m) { r = +m[1]; g = +m[2]; b = +m[3]; } }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  } catch { return true; }
}

type PreviewState = DocumentPreview<StructuredPreviewPayload>;


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

const SearchHighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const needle = query.replace(/\\/g, '/').toLocaleLowerCase().replace(/\s+/g, '');
  if (!needle) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const exact = lower.indexOf(needle);
  const matched = new Set<number>();
  if (exact >= 0) {
    for (let index = exact; index < exact + needle.length; index++) matched.add(index);
  } else {
    let cursor = -1;
    for (const char of needle) {
      cursor = lower.indexOf(char, cursor + 1);
      if (cursor < 0) return <>{text}</>;
      matched.add(cursor);
    }
  }
  return <>{Array.from(text).map((char, index) => (
    matched.has(index)
      ? <mark key={index} style={searchHighlightStyle}>{char}</mark>
      : <React.Fragment key={index}>{char}</React.Fragment>
  ))}</>;
};

export const FileTreePanel: React.FC<Props> = React.memo(({ sessionId, workingDir, execKey, execLabel, execMode, backendId, focusRequest: externalFocusRequest, onAttentionChange, documentHost, isVisible = true, onDocumentOpen, onBrowseFiles }: Props) => {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [treeFocus, setTreeFocus] = useState<{ external: Props['focusRequest']; request: FileFocusRequest } | null>(null);
  const focusRequest = treeFocus && treeFocus.external === externalFocusRequest
    ? treeFocus.request : externalFocusRequest;
  const treeFocusId = useRef(0);
  const navigateRef = useRef<(request: Pick<FileFocusRequest, 'relativePath' | 'line' | 'column'>) => void>(() => {});
  const [editorCommand, setEditorCommand] = useState<{ id: number; relativePath: string; source: string; type: 'position' | 'search' | 'line'; line?: number; column?: number } | null>(null);
  const editorCommandId = useRef(0);
  // execMode='local' 表示“在 Backend 所在机器执行”，不代表浏览器拥有那台
  // 机器的文件系统。只有 Tauri 本机执行时可直接视为同一端。
  const isRemote = execMode === 'relay' || !isTauri();
  const localBindingKey = useMemo(
    () => sessionId || `${execKey || 'home'}::${workingDir}`,
    [sessionId, execKey, workingDir],
  );

  // 单树的懒加载层级缓存：key=rel → 直接子项
  const [children, setChildren] = useState<Record<string, TNode[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({});
  const directoryRequestRef = useRef<Record<string, number>>({});
  const directoryLoadsRef = useRef(new Map<string, { rel: string; promise: Promise<TNode[]> }>());
  const refreshPendingRef = useRef<Promise<void> | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [focusFlash, setFocusFlash] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const searchRequestRef = useRef(0);
  const processedFocusRequestRef = useRef(0);
  const focusFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TNode[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchMatched, setSearchMatched] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);

  // 远端会话的本地副本(离线/比对/同步用)。本地会话不涉及。
  const [localFs, setLocalFs] = useState<LocalFs | null>(null);
  const [localRestoring, setLocalRestoring] = useState(isRemote);
  const [localManifest, setLocalManifest] = useState<Manifest | null>(null);
  const localScanRef = useRef<AbortController | null>(null);
  const [localTree, setLocalTree] = useState<Record<string, TNode[]>>({});
  const [directoryLimits, setDirectoryLimits] = useState<Record<string, number>>({});
  const [remoteManifest, setRemoteManifest] = useState<Manifest | null>(null);  // 比对后才有(带哈希)
  const [baseline, setBaseline] = useState<Manifest>({});
  const [comparing, setComparing] = useState(false);
  const [onlyDifferent, setOnlyDifferent] = useState(false);
  const [sessionOnline, setSessionOnline] = useState(true);
  // `.git` 保持可见，但默认不进入比对或目录传输。高风险授权只在本次
  // 面板生命周期内有效；重新进入即恢复安全默认，不能由远端配置静默打开。
  const [includeGitMetadata, setIncludeGitMetadata] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  // ── Git 集成（首次检测 + 手动/操作后刷新，不做定时轮询）──
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitLoading, setGitLoading] = useState(!!workingDir);
  const [gitStatusReady, setGitStatusReady] = useState(false);
  const [gitError, setGitError] = useState('');
  const gitRefreshRef = useRef<(() => Promise<void>) | null>(null);
  const [gitBranch, setGitBranch] = useState('');
  const [gitFiles, setGitFiles] = useState<Record<string, GitFileStatus>>({});
  const gitDirectories = useMemo(() => buildGitDirectoryStatuses(gitFiles), [gitFiles]);
  const [gitStagedCount, setGitStagedCount] = useState(0);
  const [gitUnstagedCount, setGitUnstagedCount] = useState(0);
  const [gitAhead, setGitAhead] = useState(0);
  const [gitBehind, setGitBehind] = useState(0);

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
  const [documentOwner, setDocumentOwner] = useState(() => getCurrentUserProfile().userId);
  const [draftRecoveryOpen, setDraftRecoveryOpen] = useState(false);
  useEffect(() => onCurrentUserChanged((profile, changed) => {
    if (changed) { setDocumentOwner(profile.userId); setPreview(null); setDraftRecoveryOpen(false); }
  }), []);
  const previewRequestRef = useRef(0);
  const previewScope = JSON.stringify([documentOwner, execKey, sessionId, workingDir]);
  const windowFrozen = useWindowWriteBlocked(execKey || '', sessionId);
  const previewScopeRef = useRef(previewScope);
  previewScopeRef.current = previewScope;
  useEffect(() => { previewRequestRef.current++; setPreview(null); }, [previewScope]);
  const [previewMaximized, setPreviewMaximized] = useState(false);
  const [mdRaw, setMdRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingDocument, setEditingDocument] = useState<DocumentSelection | null>(null);
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const tabsRef = useRef(fileTabs); tabsRef.current = fileTabs;
  const [documentView, setDocumentView] = useState<DocumentView>('source');
  const [editNotice, setEditNotice] = useState('');
  const [closingTab, setClosingTab] = useState<FileTab | null>(null);
  const [tabClosing, setTabClosing] = useState(false);
  const autoEditRequest = useRef(-1);
  const [, refreshTabIndicators] = useState(0);
  useEffect(() => documentHost ? documentStore.subscribe(() => refreshTabIndicators(value => value + 1)) : undefined, [documentHost]);
  useEffect(() => { setFileTabs([]); setClosingTab(null); setEditNotice(''); }, [previewScope]);
  useEffect(() => { setFileTabs(tabs => tabs.filter(tab => tab.source !== 'local')); }, [localFs]);
  useEffect(() => {
    if (!documentHost || !preview || !editingDocument || editingDocument.scope !== previewScope) return;
    setFileTabs(tabs => tabs.map(tab => tab.id === fileTabId(preview) && tab.document !== editingDocument ? { ...tab, document: editingDocument } : tab));
  }, [documentHost, preview?.rel, preview?.source, editingDocument, previewScope]);
  const [editOpening, setEditOpening] = useState(false);
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchResults, setBatchResults] = useState<{ scope: string; rows: { name: string; status: string }[] } | null>(null);
  const [comparison, setComparison] = useState<{ key: string; diskVersion: DiskVersion; revision: number; text: string } | null>(null);
  const [draftChoices, setDraftChoices] = useState<{ key: string; rows: StoredDocumentDraft[] } | null>(null);
  const editOpenRequest = useRef(0);
  const localFsRef = useRef(localFs); localFsRef.current = localFs;
  const getEditSnapshot = useCallback(() => editingDocument?.scope === previewScope && getCurrentUserProfile().userId === documentOwner
    ? documentStore.get(editingDocument.key) : undefined, [editingDocument, previewScope, documentOwner]);
  const activeDocument = React.useSyncExternalStore(documentStore.subscribe, getEditSnapshot);
  const languageEditor = useLanguageEditor(activeDocument, editingDocument?.client, (relativePath, line, column) => {
    navigateRef.current({ relativePath, line, column });
  });
  const editText = activeDocument?.text || '';
  const dirty = !!activeDocument?.dirty;
  const saving = !!activeDocument?.save && !activeDocument.save.receipt && !activeDocument.save.unknown;
  const needsSaveCheck = !!activeDocument?.save && (activeDocument.save.unknown || activeDocument.save.receipt?.status === 'accepted');
  useEffect(() => {
    if (preview?.source !== 'local') return;
    previewRequestRef.current++; editOpenRequest.current++;
    setPreview(null); setEditing(false); setEditingDocument(null); setEditOpening(false);
    // 换副本绑定不将旧缓冲区附到新目录；原草稿仍按旧身份保留。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localFs]);
  useEffect(() => {
    if (!activeDocument || editingDocument?.scope !== previewScope) return;
    setPreview(current => current && current.rel === activeDocument.identity.relativePath
      && (current.source === 'local') === (activeDocument.identity.source === 'local-copy')
      && (current.text !== activeDocument.text || current.truncated && activeDocument.read?.complete)
      ? { ...current, text: activeDocument.text, truncated: activeDocument.read?.complete ? false : current.truncated } : current);
  }, [activeDocument?.text, activeDocument?.key, editingDocument?.scope, previewScope]);
  const [htmlExporting, setHtmlExporting] = useState(false);
  const [htmlExported, setHtmlExported] = useState(false);
  const [review, setReview] = useState<ProvOpenResult | null>(null);
  const [reviewAttention, setReviewAttention] = useState<AttentionContext | null>(null);
  const [reviewOpening, setReviewOpening] = useState(false);
  const transferKey = JSON.stringify([execKey || 'home', workingDir.replace(/\\/g, '/').replace(/\/$/, '')]);
  // 只订阅当前目录的进度引用，其他工作区传输不应带动整棵文件树重绘。
  const getTransferSnapshot = useCallback(() => fileTransfers.active(transferKey)?.progress || null, [transferKey]);
  const transfer = React.useSyncExternalStore(fileTransfers.subscribe, getTransferSnapshot);
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);

  // 把“用户此刻正在看的文件”提升到 App 的全局注意力层。二进制/Base64 会在
  // buildFileAttentionContext 中剔除，正文只留在浏览器内直到用户真正提问。
  useEffect(() => {
    if (!onAttentionChange) return;
    if (review && reviewAttention) {
      onAttentionChange(reviewAttention);
      return;
    }
    if (!preview) {
      onAttentionChange(null);
      return;
    }
    onAttentionChange(buildFileAttentionContext(preview, {
      sessionId,
      workingDir,
      execKey,
      editedText: editing ? editText : undefined,
    }));
  }, [preview, editing, editText, sessionId, workingDir, execKey, onAttentionChange, review, reviewAttention]);

  useEffect(() => () => onAttentionChange?.(null), [onAttentionChange]);

  useEffect(() => {
    if (!sessionId) {
      setSessionOnline(api.isConnected());
      return api.onConnectionStatus(setSessionOnline);
    }
    return api.onSessionConnectionStatus(sessionId, setSessionOnline);
  }, [sessionId]);

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

  useEffect(() => {
    if (!htmlExported) return;
    const timer = setTimeout(() => setHtmlExported(false), 2500);
    return () => clearTimeout(timer);
  }, [htmlExported]);

  // ── 懒加载工作目录某层 ──
  const loadChildren = useCallback(async (rel: string): Promise<TNode[]> => {
    if (!workingDir || !mountedRef.current) return [];
    const offline = isRemote && !sessionOnline;
    const key = JSON.stringify([execKey, workingDir, rel, offline, offline ? localFs?.id() : null]);
    const pending = directoryLoadsRef.current.get(key);
    if (pending) return pending.promise;
    const read = async (): Promise<TNode[]> => {
      const request = (directoryRequestRef.current[rel] || 0) + 1;
      directoryRequestRef.current[rel] = request;
      const isCurrent = () => mountedRef.current && directoryRequestRef.current[rel] === request;
      setLoading((p) => ({ ...p, [rel]: true }));
      setDirectoryErrors((p) => ({ ...p, [rel]: '' }));
      try {
        if (isRemote && !sessionOnline) {
          if (!localFs) throw new Error('执行端离线，且尚未建立平板离线副本');
          const ents = await localFs.listDir(rel);
          const nodes: TNode[] = ents.map((entry) => ({
            name: entry.name,
            rel: rel ? `${rel}/${entry.name}` : entry.name,
            isDir: entry.isDir,
            size: entry.size,
            remote: false,
            local: true,
          }));
          if (isCurrent()) setChildren((previous) => ({ ...previous, [rel]: nodes }));
          return nodes;
        }
        // 文件传输面板必须忠实展示工作空间，包括 .git 等点号目录。
        const ents = await api.listDirectory(rel, workingDir, execKey, true);
        const nodes: TNode[] = ents.map((e) => ({
          name: e.name, rel: e.path, isDir: e.isDir, size: 0,
          remote: true, local: false, remoteMtime: e.mtime,
        }));
        nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
        if (isCurrent()) setChildren((p) => ({ ...p, [rel]: nodes }));
        return nodes;
      } catch (e: any) {
        if (isCurrent()) {
          const error = `目录读取失败：${e?.message ?? e}`;
          setDirectoryErrors((p) => ({ ...p, [rel]: error }));
          // 刷新失败保留已有目录；初次失败也不能伪装成“空目录”。
        }
        return [];
      } finally {
        if (isCurrent()) setLoading((p) => ({ ...p, [rel]: false }));
      }
    };
    const task = read();
    directoryLoadsRef.current.set(key, { rel, promise: task });
    try { return await task; }
    finally { if (directoryLoadsRef.current.get(key)?.promise === task) directoryLoadsRef.current.delete(key); }
  }, [workingDir, execKey, isRemote, sessionOnline, localFs]);

  const reloadAll = useCallback(async () => {
    if (!mountedRef.current) return;
    // 手动刷新仅读取根与可见的展开层，不重扫已经折叠的缓存目录。
    const keys = new Set(['', ...Object.keys(expanded).filter(rel => {
      const parts = rel.split('/');
      return parts.every((_, index) => expanded[parts.slice(0, index + 1).join('/')]);
    })]);
    for (const [key, entry] of directoryLoadsRef.current) {
      if (keys.has(entry.rel)) continue;
      directoryRequestRef.current[entry.rel] = (directoryRequestRef.current[entry.rel] || 0) + 1;
      directoryLoadsRef.current.delete(key);
    }
    setChildren(previous => Object.fromEntries(Object.entries(previous).filter(([rel]) => keys.has(rel))));
    setExpanded(previous => Object.fromEntries(Object.entries(previous).filter(([rel]) => keys.has(rel))));
    setLoading(previous => Object.fromEntries(Object.entries(previous).filter(([rel]) => keys.has(rel))));
    setDirectoryErrors(previous => Object.fromEntries(Object.entries(previous).filter(([rel]) => keys.has(rel))));
    await Promise.all([...keys].map((k) => loadChildren(k)));
  }, [expanded, loadChildren]);

  // 会话切换 → 重载根
  useEffect(() => {
    searchRequestRef.current += 1;
    setChildren({}); setExpanded({}); setSelected(null);
    setDirectoryErrors({});
    setSearchQuery(''); setSearchResults([]); setSearchError(''); setSearchLoading(false);
    if (workingDir) loadChildren('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, execKey]);

  // 连接变化只更新在线状态，不清空/重读目录；用户展开或手动刷新时按当前连接读取。

  // ── Git 首次检测 + 显式刷新 ──
  useEffect(() => {
    if (!workingDir) { setGitAvailable(false); setGitLoading(false); setGitBranch(''); setGitFiles({}); return; }
    let cancelled = false;
    let detected = false;
    let isRepo = false;
    let pending: Promise<void> | null = null;
    setGitLoading(true); setGitStatusReady(false); setGitError('');
    // 初次检测与 status 都完成后才展示“干净/变更数”；慢节点只保留一个请求。
    const refreshGit = (redetect = false): Promise<void> => {
      if (cancelled || !mountedRef.current) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        try {
          if (!detected || redetect) {
            const res = await api.gitDetect(workingDir, execKey, true);
            if (cancelled) return;
            if (typeof res.isRepo !== 'boolean') throw new Error('Git 检测响应无效');
            detected = true; isRepo = res.isRepo;
            setGitAvailable(isRepo);
            if (!isRepo) setGitBranch('');
          }
          if (isRepo) {
            const res = await api.gitStatus(workingDir, execKey, false);
            if (cancelled) return;
            if (res.error || !Array.isArray(res.files)) throw new Error(res.error || 'Git 状态响应无效');
            const map: Record<string, GitFileStatus> = {};
            let staged = 0, unstaged = 0;
            for (const f of res.files) {
              map[f.path] = f;
              if (f.staged) staged++; else unstaged++;
            }
            setGitFiles(map); setGitBranch(res.branch || '');
            setGitStagedCount(staged); setGitUnstagedCount(unstaged);
            setGitAhead(res.ahead || 0); setGitBehind(res.behind || 0);
            setGitStatusReady(true);
          } else {
            setGitStatusReady(false); setGitFiles({});
            setGitStagedCount(0); setGitUnstagedCount(0); setGitAhead(0); setGitBehind(0);
          }
          setGitError('');
        } catch {
          if (!cancelled) setGitError('Git 状态同步失败，请刷新重试');
        } finally {
          pending = null;
          if (!cancelled) setGitLoading(false);
        }
      })();
      return pending;
    };
    gitRefreshRef.current = () => refreshGit(true);
    void refreshGit();
    return () => { cancelled = true; gitRefreshRef.current = null; };
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
        void gitRefreshRef.current?.();
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
        void gitRefreshRef.current?.();
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
        void gitRefreshRef.current?.();
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
      void gitRefreshRef.current?.();
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
        void gitRefreshRef.current?.();
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
      void gitRefreshRef.current?.();
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
        void gitRefreshRef.current?.();
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
        void reloadAll();
        void gitRefreshRef.current?.();
      } else {
        setMsg({ kind: 'err', text: `丢弃失败` });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: `丢弃失败：${e?.message ?? e}` });
    } finally {
      setGitBatchOperating(false);
    }
  }, [workingDir, execKey, gitSelected, reloadAll]);

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
      void gitRefreshRef.current?.();
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
      void reloadAll();
      void gitRefreshRef.current?.();
    }
  }, [workingDir, execKey, reloadAll]);

  // 远端会话：按 session 恢复本机目录，避免不同远端 session 错用同一个本地目录。
  const scanLocal = useCallback(async (fs: LocalFs | null) => {
    if (!mountedRef.current) return;
    localScanRef.current?.abort();
    if (!fs) { setLocalManifest(null); return; }
    const controller = new AbortController();
    localScanRef.current = controller;
    setRemoteManifest(null);
    try {
      const manifest = await fs.scan([], includeGitMetadata, { hash: false, signal: controller.signal });
      if (!controller.signal.aborted) setLocalManifest(manifest);
    } catch {
      if (!controller.signal.aborted) setMsg({ kind: 'err', text: '本地目录读取失败，保留上次文件列表，请刷新重试' });
    }
  }, [includeGitMetadata]);
  useEffect(() => () => { localScanRef.current?.abort(); }, []);
  const refreshAll = useCallback(async () => {
    if (!mountedRef.current) return;
    if (refreshPendingRef.current) return refreshPendingRef.current;
    // Git 有独立合并/错误状态，不能让慢 Git 挡住下一次目录刷新。
    void gitRefreshRef.current?.();
    const task = Promise.all([
      reloadAll(),
      localFs ? scanLocal(localFs) : Promise.resolve(),
    ]).then(() => {});
    refreshPendingRef.current = task;
    try { await task; }
    finally { if (refreshPendingRef.current === task) refreshPendingRef.current = null; }
  }, [reloadAll, localFs, scanLocal]);
  // 上传/下载/删除处理器已有增量更新；传输结束不再额外全量扫描。
  useEffect(() => {
    if (!isRemote) {
      setLocalRestoring(false);
      setLocalFs(null);
      setLocalManifest(null);
      return;
    }
    let cancelled = false;
    setLocalRestoring(true);
    setLocalFs(null);
    setLocalManifest(null);
    setRemoteManifest(null);
    restoreLocalDir(localBindingKey).then(async (fs) => {
      if (!fs || cancelled) return;
      setLocalFs(fs);
      setLocalRestoring(false);
      await scanLocal(fs);
    }).catch(() => {
      if (!cancelled) setMsg({ kind: 'err', text: '本机目录恢复失败，请重新指定目录' });
    }).finally(() => { if (!cancelled) setLocalRestoring(false); });
    return () => { cancelled = true; localScanRef.current?.abort(); };
  }, [isRemote, localBindingKey, includeGitMetadata, scanLocal]);
  const baselineLocalId = useMemo(() => {
    if (!localFs) return '';
    return includeGitMetadata ? `${localFs.id()}::with-git` : localFs.id();
  }, [localFs, includeGitMetadata]);
  useEffect(() => {
    if (baselineLocalId && workingDir) setBaseline(loadBaseline(baselineLocalId, workingDir));
    else setBaseline({});
  }, [baselineLocalId, workingDir]);

  useEffect(() => {
    const controller = new AbortController();
    void buildLocalManifestTree(localManifest, controller.signal).then(tree => {
      if (!controller.signal.aborted) setLocalTree(tree);
    }).catch(() => {});
    return () => controller.abort();
  }, [localManifest]);
  const remoteManifestDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const rel of Object.keys(remoteManifest || {})) {
      const parts = rel.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return dirs;
  }, [remoteManifest]);

  // 文件搜索不能依赖已展开的懒加载目录。每次都精确尝试 Session 执行节点，不能
  // 受可能滞后的在线状态快照影响；RPC 自己核验真实连接，失败后仍保留本机副本
  // 结果。180ms 防抖 + request id 保证连续输入不会显示旧结果。
  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    const query = searchQuery.trim();
    if (!query || !workingDir) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError('');
      setSearchMatched(0);
      setSearchTruncated(false);
      setSearchSelectedIndex(0);
      return;
    }

    // 查询一变化就清掉旧列表，避免防抖窗口内按 Enter 打开上一条查询的文件。
    setSearchResults([]);
    setSearchLoading(true);
    setSearchError('');
    setSearchSelectedIndex(0);

    const timer = window.setTimeout(() => {
      void (async () => {
        const localRanked = rankFileSearchPaths(
          Object.keys(localManifest || {}), query, FILE_SEARCH_LIMIT,
        );
        const merged = new Map<string, TNode>();
        for (const item of localRanked.results) {
          const meta = localManifest?.[item.path];
          merged.set(item.path, {
            name: item.path.split('/').pop() || item.path,
            rel: item.path,
            isDir: false,
            size: meta?.size || 0,
            remote: false,
            local: true,
          });
        }

        let remoteMatched = 0;
        let remoteTruncated = false;
        let remoteError = '';
        try {
          const response = await api.searchFiles(
            workingDir, query, execKey, FILE_SEARCH_LIMIT, includeGitMetadata,
          );
          if (response.status !== 'ok') throw new Error(response.message || '执行端搜索失败');
          remoteMatched = Number(response.matched || 0);
          remoteTruncated = Boolean(response.truncated);
          for (const item of response.results || []) {
            const rel = item.path.replace(/\\/g, '/');
            const previous = merged.get(rel);
            merged.set(rel, {
              name: item.name || rel.split('/').pop() || rel,
              rel,
              isDir: false,
              size: Number(item.size || previous?.size || 0),
              remoteMtime: item.mtime,
              remote: true,
              local: Boolean(previous?.local || localManifest?.[rel]),
            });
          }
        } catch (error) {
          remoteError = error instanceof Error ? error.message : String(error);
        }

        if (requestId !== searchRequestRef.current) return;
        const combined = rankFileSearchPaths(merged.keys(), query, FILE_SEARCH_LIMIT);
        setSearchResults(combined.results.map((item) => merged.get(item.path)!).filter(Boolean));
        setSearchMatched(Math.max(combined.matched, localRanked.matched, remoteMatched));
        setSearchTruncated(combined.truncated || localRanked.truncated || remoteTruncated);
        setSearchSelectedIndex(0);
        setSearchError(remoteError);
        setSearchLoading(false);
      })();
    }, FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (searchRequestRef.current === requestId) searchRequestRef.current += 1;
    };
  }, [searchQuery, workingDir, execKey, isRemote, sessionOnline, localManifest, includeGitMetadata]);

  useEffect(() => {
    if (!searchQuery.trim()) return;
    searchResultRefs.current.get(searchSelectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [searchQuery, searchSelectedIndex, searchResults]);

  // 聊天气泡中的文件链接 → 自动逐层加载、展开、选中并滚动到目标。
  // 请求同时绑定 Session 和 workingDir，避免分屏/切换节点时定位到同名目录。
  const focusDataRef = useRef({ loadChildren, localTree });
  focusDataRef.current = { loadChildren, localTree };
  useEffect(() => {
    if (!focusRequest
      || focusRequest.requestId === processedFocusRequestRef.current
      || focusRequest.sessionId !== sessionId
      || !sameWorkspacePath(focusRequest.workingDir, workingDir)) return;
    if (isRemote && !sessionOnline && !localFs) return;

    const relativePath = normalizeRelativeFilePath(focusRequest.relativePath);
    if (!relativePath) return;
    processedFocusRequestRef.current = focusRequest.requestId;
    if (documentHost) { setSelected(relativePath); navigateRef.current({ ...focusRequest, relativePath }); return; }
    let cancelled = false;
    let revealFrame = 0;

    void (async () => {
      setOnlyDifferent(false);
      setSearchQuery('');
      const parts = relativePath.split('/').filter(Boolean);
      const ancestors: Record<string, boolean> = {};
      for (let i = 1; i < parts.length; i++) {
        ancestors[parts.slice(0, i).join('/')] = true;
      }
      setExpanded((previous) => ({ ...previous, ...ancestors }));

      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        const expected = parts.slice(0, i + 1).join('/');
        const loaded = await focusDataRef.current.loadChildren(parent);
        if (cancelled) return;
        const candidates = [...loaded, ...(focusDataRef.current.localTree[parent] || [])];
        const node = candidates.find((item) => item.rel.replace(/\\/g, '/') === expected);
        if (!node || (i < parts.length - 1 && !node.isDir)) {
          setMsg({ kind: 'err', text: `无法在当前工作目录中定位：${relativePath}` });
          return;
        }
      }

      if (cancelled) return;
      setSelected(relativePath);
      setFocusFlash(relativePath);
      if (focusFlashTimerRef.current) clearTimeout(focusFlashTimerRef.current);
      focusFlashTimerRef.current = setTimeout(() => setFocusFlash(null), 1800);

      let attempts = 0;
      const reveal = () => {
        if (cancelled) return;
        const row = rowRefs.current.get(relativePath);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          row.focus({ preventScroll: true });
          return;
        }
        attempts += 1;
        if (attempts < 16) revealFrame = requestAnimationFrame(reveal);
        else setMsg({ kind: 'err', text: `文件已加载，但暂时无法显示：${relativePath}` });
      };
      revealFrame = requestAnimationFrame(reveal);
    })();

    return () => {
      cancelled = true;
      if (revealFrame) cancelAnimationFrame(revealFrame);
    };
  }, [focusRequest, sessionId, workingDir, isRemote, sessionOnline, localFs, documentHost]);

  useEffect(() => () => {
    if (focusFlashTimerRef.current) clearTimeout(focusFlashTimerRef.current);
  }, []);

  /** 两端都存在、但内容哈希不同的文件；冲突也是内容不同的一种。 */
  const differentPaths = useMemo(() => {
    const paths = new Set<string>();
    if (!localManifest || !remoteManifest) return paths;
    for (const [rel, local] of Object.entries(localManifest)) {
      const remote = remoteManifest[rel];
      if (remote && local.hash !== remote.hash) paths.add(rel);
    }
    return paths;
  }, [localManifest, remoteManifest]);

  const toggleOnlyDifferent = useCallback(() => {
    setOnlyDifferent((current) => {
      const next = !current;
      if (next) {
        // 自动展开命中文件的祖先目录，切换后直接看到结果，不必逐层翻找。
        setExpanded((previous) => {
          const expandedNext = { ...previous };
          for (const rel of differentPaths) {
            const parts = rel.split('/').filter(Boolean);
            for (let i = 1; i < parts.length; i++) {
              expandedNext[parts.slice(0, i).join('/')] = true;
            }
          }
          return expandedNext;
        });
      }
      return next;
    });
  }, [differentPaths]);

  useEffect(() => {
    if (!localManifest || !remoteManifest) setOnlyDifferent(false);
  }, [localManifest, remoteManifest]);

  const toggle = useCallback((node: TNode) => {
    if (!node.isDir) return;
    const willOpen = !expanded[node.rel];
    setExpanded((p) => ({ ...p, [node.rel]: willOpen }));
    // 本机独有目录没有对应远端路径，直接由本机清单展开，避免无意义的远端 404。
    if (willOpen && node.remote && children[node.rel] === undefined) loadChildren(node.rel);
  }, [expanded, children, loadChildren]);

  /** 统一目录 = 已加载远端子项 ∪ 本机清单子项。 */
  const mergedChildren = useCallback((rel: string): TNode[] => {
    if (!isRemote || !(localTree[rel]?.length)) return children[rel] || [];
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
      if (!L.hash || !R.hash) return 'local';
      if (L.hash === R.hash) return 'synced';
      const B = baseline[node.rel]?.hash;
      return (B && L.hash !== B && R.hash !== B) ? 'conflict' : 'differs';
    }
    return 'local';
  }, [isRemote, localManifest, remoteManifest, baseline]);

  const freshnessOf = useCallback((node: TNode): SyncFreshness | null => {
    if (!isRemote || node.isDir || node.typeConflict) return null;
    const local: FileMeta | undefined = localManifest?.[node.rel];
    const remote: FileMeta | undefined = remoteManifest?.[node.rel];
    // 尚未完整比对时，目录列表仍足以确认当前层的远端独有文件，并可直接展示
    // 执行端提供的最后修改时间；两端都有的文件仍等待 hash 比对后再下结论。
    if (!remoteManifest || (local && !local.hash) || (remote && !remote.hash)) {
      if (node.remote && !node.local) {
        return { kind: 'remote-only', basis: 'presence', remoteMtime: node.remoteMtime };
      }
      return null;
    }
    return describeSyncFreshness(local, remote, baseline[node.rel]);
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

  const chooseManagedLocal = useCallback(async () => {
    setMsg(null);
    try {
      const fs = await useManagedLocalDir(localBindingKey);
      setLocalFs(fs);
      await scanLocal(fs);
      setMsg({ kind: 'ok', text: '✓ 已启用平板离线空间，文件会保存在当前浏览器中' });
    } catch (error: any) {
      setMsg({ kind: 'err', text: `无法启用离线空间：${error?.message ?? error}` });
    }
  }, [localBindingKey, scanLocal]);

  const importDeviceFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length || !localFs) return;
    try {
      for (const file of Array.from(files)) await importLocalFile(localFs, file, file.name);
      await scanLocal(localFs);
      setMsg({ kind: 'ok', text: `✓ 已导入 ${files.length} 个设备文件，可联网后上传到执行端` });
    } catch (error: any) {
      setMsg({ kind: 'err', text: `导入失败：${error?.message ?? error}` });
    } finally {
      if (importFileInputRef.current) importFileInputRef.current.value = '';
    }
  }, [localFs, scanLocal]);

  const changeIncludeGitMetadata = useCallback((checked: boolean) => {
    if (checked && !window.confirm(
      '仅建议在完整迁移或备份仓库时包含 .git。\n\n' +
      '它会传输 HEAD、index、refs、config 和对象库；覆盖错误方向可能改变或损坏目标端仓库状态。' +
      '请先停止该仓库上的 Agent、Git 提交、拉取与 GC。\n\n确定启用吗？',
    )) return;
    setIncludeGitMetadata(checked);
    setRemoteManifest(null);
    setOnlyDifferent(false);
    setBaseline({});
    setMsg({
      kind: 'ok',
      text: checked
        ? '已启用 Git 元数据同步；目录传输可能改变目标仓库状态'
        : '已恢复安全模式：.git 可见，但不会参与比对或目录传输',
    });
  }, []);

  const runCompare = useCallback(async () => {
    localScanRef.current?.abort();
    if (!workingDir || !localFs) return;
    if (!sessionOnline) {
      setMsg({ kind: 'err', text: '当前离线；本地修改已保留，恢复连接后再比对或上传' });
      return;
    }
    setComparing(true); setMsg(null);
    try {
      const [lm, rm] = await Promise.all([
        localFs.scan([], includeGitMetadata),
        api.syncManifest(workingDir, execKey, includeGitMetadata).then((r) => {
          if (r.status !== 'ok' || !r.files) throw new Error(r.message || '无法读取执行端文件清单');
          return r.files;
        }),
      ]);
      setLocalManifest(lm); setRemoteManifest(rm);
      setBaseline(loadBaseline(baselineLocalId, workingDir));
    } catch (e: any) { setMsg({ kind: 'err', text: `比对失败：${e?.message ?? e}` }); }
    finally { setComparing(false); }
  }, [workingDir, execKey, localFs, sessionOnline, includeGitMetadata, baselineLocalId]);

  const bumpBaseline = useCallback((rels: string[], src: Manifest | null) => {
    if (!localFs || !workingDir || !src || !baselineLocalId) return;
    const next = { ...loadBaseline(baselineLocalId, workingDir) };
    for (const rel of rels) if (src[rel]) next[rel] = src[rel];
    saveBaseline(baselineLocalId, workingDir, next);
    setBaseline(next);
  }, [localFs, workingDir, baselineLocalId]);

  const deleteRemoteEntry = useCallback(async (node: TNode) => {
    setContextMenu(null);
    if (!node.remote || !node.rel || !workingDir || !sessionOnline || fileTransfers.active(transferKey)) return;
    const kind = node.isDir ? '目录及其全部内容（含隐藏文件）' : '文件';
    if (!window.confirm([
      '永久删除执行端' + kind + '？',
      '执行节点：' + (execLabel || execKey || '当前执行端'),
      '工作目录：' + workingDir,
      '目标：' + node.rel,
      '',
      '不可恢复，不经过回收站。本地副本不会删除；之后重新上传可能把它传回来。',
    ].join('\n'))) return;
    const job = fileTransfers.start(transferKey, (execLabel || execKey || '执行端') + ' · ' + (sessionId || workingDir), 'delete', node.rel);
    if (!job) return;
    try {
      const result = await api.syncDeleteEntry(workingDir, node.rel, node.isDir, execKey);
      if (result.status !== 'ok') throw new Error(result.message || '删除失败');
      const contains = (path: string) => path === node.rel || path.startsWith(node.rel + '/');
      setRemoteManifest(current => current ? Object.fromEntries(Object.entries(current).filter(([path]) => !contains(path))) : null);
      setChildren(current => Object.fromEntries(Object.entries(current)
        .filter(([path]) => !contains(path))
        .map(([path, entries]) => [path, entries.filter(entry => !contains(entry.rel))])));
      setSelected(current => current && contains(current) ? null : current);
      setPreview(current => current && current.source === 'remote' && contains(current.rel) ? null : current);
      setSearchResults(current => current.filter(entry => !contains(entry.rel)));
      const message = '已删除执行端：' + node.rel + '；本地副本保留，请重新比对后决定是否同步。';
      setMsg({ kind: 'ok', text: message });
      fileTransfers.finish(job, message);
      void gitRefreshRef.current?.();
    } catch (error: any) {
      const message = '删除失败或结果未确认：' + (error?.message || String(error)) + '。请刷新目录核实。';
      setMsg({ kind: 'err', text: message });
      fileTransfers.finish(job, message, true);
    }
  }, [workingDir, execKey, execLabel, sessionId, sessionOnline, transferKey]);

  // 收集某节点下所有文件 rel(比对模式用远端清单;否则递归 listDirectory)
  const collectFiles = useCallback(async (node: TNode): Promise<string[]> => {
    if (!node.isDir) return [node.rel];
    if (remoteManifest) {
      const prefix = node.rel ? `${node.rel}/` : '';
      return Object.keys(remoteManifest).filter((r) => (
        (!node.rel || r.startsWith(prefix))
        && (!onlyDifferent || differentPaths.has(r))
      ));
    }
    const out: string[] = [];
    const walk = async (rel: string) => {
      let kids = children[rel];
      if (kids === undefined) {
        const ents = workingDir ? await api.listDirectory(rel, workingDir, execKey, true) : [];
        kids = ents.map((e) => ({
          name: e.name, rel: e.path, isDir: e.isDir, size: 0,
          remote: true, remoteMtime: e.mtime,
        }));
      }
      for (const k of kids) { if (k.isDir) await walk(k.rel); else out.push(k.rel); }
    };
    await walk(node.rel);
    return out;
  }, [remoteManifest, children, workingDir, execKey, onlyDifferent, differentPaths]);

  // ⬇ 下载到本地副本(云端→本地)
  const pull = useCallback(async (node: TNode) => {
    if (!localFs || !workingDir) { setMsg({ kind: 'err', text: '请先选择「本地副本目录」' }); return; }
    if (!sessionOnline) { setMsg({ kind: 'err', text: '执行端当前离线，无法下载新文件；已下载副本仍可使用' }); return; }
    const job = fileTransfers.start(transferKey, (execLabel || execKey || '执行端') + ' · ' + (sessionId || workingDir), 'pull', node.rel);
    if (!job) return;
    const transferAbortRef = job.abort;
    let outcome = '';
    let failed = false;
    const report = (message: { kind: 'ok' | 'err'; text: string }) => {
      outcome = message.text;
      failed = message.kind === 'err';
      setMsg(message);
    };
    const setTransfer = (progress: TransferProgress) => fileTransfers.progress(job, progress);
    setMsg(null);
    try {
      let rels: string[];
      const sizes: Record<string, number> = {};
      // 未做过哈希比对时，旧逻辑会递归逐层 listDirectory，再为每个文件单独
      // syncFileStat；经中继时 N 个文件就是大量串行 RTT。改为一次无哈希子树清单。
      if (node.isDir && !remoteManifest) {
        const listing = await api.syncFileList(
          workingDir, node.rel, execKey, includeGitMetadata,
        );
        if (listing.status !== 'ok' || !listing.files) {
          throw new Error(listing.message || `无法规划下载目录：${node.rel}`);
        }
        rels = Object.keys(listing.files).sort((a, b) => a.localeCompare(b));
        Object.assign(sizes, listing.files);
      } else {
        rels = await collectFiles(node);
      }
      if (node.isDir && !window.confirm(`下载「${node.name || '根'}」下的 ${rels.length} 个文件到本地？`)) return;
      await Promise.all(rels.map(async (rel) => {
        if (typeof sizes[rel] === 'number') return;
        const known = remoteManifest?.[rel]?.size;
        if (typeof known === 'number') {
          sizes[rel] = known;
        } else {
          const stat = await api.syncFileStat(workingDir, rel, execKey);
          if (stat.status !== 'ok' || typeof stat.size !== 'number') throw new Error(stat.message || `无法读取文件大小：${rel}`);
          sizes[rel] = stat.size;
        }
      }));
      const totalBytes = rels.reduce((sum, rel) => sum + sizes[rel], 0);
      const ok: string[] = [];
      const fileProgress = new Map<string, number>();
      const startedAt = Date.now();
      let doneBytes = 0;
      let lastProgressPaint = 0;
      let latestProgress: { rel: string; index: number; fileBytes: number; activeCount: number } | null = null;
      const applyCompleted = () => {
        if (ok.length === 0) return;
        bumpBaseline(ok, remoteManifest);
        // 文件已按大小验收并原子落盘；直接增量更新清单，避免完成后再次哈希
        // 整棵目录（包含 .git 时这段尾部等待尤其明显）。下次“比对”仍会完整复核。
        setLocalManifest((previous) => {
          const next = { ...(previous || {}) };
          for (const rel of ok) {
            next[rel] = remoteManifest?.[rel] || {
              size: sizes[rel], hash: `pending-transfer:${startedAt}:${sizes[rel]}`,
            };
          }
          return next;
        });
      };
      const paintProgress = (force = false) => {
        if (!latestProgress) return;
        const now = Date.now();
        if (!force && now - lastProgressPaint < 80) return;
        lastProgressPaint = now;
        const { rel, index, fileBytes, activeCount } = latestProgress;
        setTransfer({
          direction: 'pull', rel, fileIndex: index + 1, fileCount: rels.length,
          fileBytes, fileSize: sizes[rel], doneBytes, totalBytes, activeCount, startedAt,
        });
      };
      const publish = (rel: string, index: number, fileBytes: number, activeCount: number) => {
        const previous = fileProgress.get(rel) || 0;
        fileProgress.set(rel, fileBytes);
        doneBytes += Math.max(0, fileBytes - previous);
        latestProgress = { rel, index, fileBytes, activeCount };
        paintProgress();
      };

      for (let batchStart = 0; batchStart < rels.length; batchStart += TRANSFER_FILE_CONCURRENCY) {
        const batch = rels.slice(batchStart, batchStart + TRANSFER_FILE_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(async (rel, batchIndex) => {
          const index = batchStart + batchIndex;
          const size = sizes[rel];
          const id = transferId();
          if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
          publish(rel, index, 0, batch.length);
          await localFs.writeStart(rel, id);
          let offset = 0;
          try {
            while (offset < size) {
              if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
              const result = await api.syncReadChunk(
                workingDir, rel, offset,
                Math.min(TRANSFER_CHUNK_SIZE, size - offset), execKey,
              );
              if (result.status !== 'ok' || result.data == null) throw new Error(result.message || `下载失败：${rel}`);
              const chunkBytes = result.size ?? 0;
              if (chunkBytes <= 0 && offset < size) throw new Error(`下载返回空分块：${rel}`);
              await localFs.writeChunk(rel, id, offset, result.data);
              offset += chunkBytes;
              publish(rel, index, offset, batch.length);
            }
            if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
            await localFs.writeFinish(rel, id, size);
            publish(rel, index, size, batch.length);
            ok.push(rel);
          } catch (error) {
            await localFs.writeAbort(rel, id).catch(() => {});
            throw error;
          }
        }));
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) {
          applyCompleted();
          throw failed.reason;
        }
        if (transferAbortRef.current) {
          applyCompleted();
          throw new Error('__TRANSFER_CANCELLED__');
        }
      }

      paintProgress(true);
      applyCompleted();
      report({ kind: 'ok', text: `✓ 已下载 ${ok.length}/${rels.length} 个文件到本地` });
      return !node.isDir && ok.includes(node.rel);
    } catch (e: any) {
      report({ kind: 'err', text: e?.message === '__TRANSFER_CANCELLED__' ? '下载已取消，未完成文件不会覆盖本地原文件' : `下载失败：${e?.message ?? e}` });
    }
    finally { fileTransfers.finish(job, outcome, failed); }
  }, [localFs, workingDir, execKey, collectFiles, bumpBaseline, remoteManifest, sessionOnline, includeGitMetadata, transferKey, execLabel, sessionId]);

  // ⬆ 上传本地改动(本地→云端)
  const push = useCallback(async (node: TNode) => {
    if (!localFs || !workingDir || !localManifest) return;
    if (!sessionOnline) { setMsg({ kind: 'err', text: '当前离线；修改已保留在平板，恢复连接后再上传' }); return; }
    const job = fileTransfers.start(transferKey, (execLabel || execKey || '执行端') + ' · ' + (sessionId || workingDir), 'push', node.rel);
    if (!job) return;
    const transferAbortRef = job.abort;
    let outcome = '';
    let failed = false;
    const report = (message: { kind: 'ok' | 'err'; text: string }) => {
      outcome = message.text;
      failed = message.kind === 'err';
      setMsg(message);
    };
    const setTransfer = (progress: TransferProgress) => fileTransfers.progress(job, progress);
    setMsg(null);
    try {
      const prefix = node.rel ? `${node.rel}/` : '';
      const rels = node.isDir ? Object.keys(localManifest).filter((r) => !node.rel || r === node.rel || r.startsWith(prefix)) : [node.rel];
      if (node.isDir && !window.confirm(`把本地「${node.name || '根'}」下的 ${rels.length} 个文件上传到远端？`)) return;
      const sizes: Record<string, number> = {};
      for (const rel of rels) sizes[rel] = localManifest[rel]?.size ?? await localFs.fileSize(rel);
      const totalBytes = rels.reduce((sum, rel) => sum + sizes[rel], 0);
      const ok: string[] = [];
      const fileProgress = new Map<string, number>();
      const startedAt = Date.now();
      let doneBytes = 0;
      let lastProgressPaint = 0;
      let latestProgress: { rel: string; index: number; fileBytes: number; activeCount: number } | null = null;
      const applyUploaded = async () => {
        if (ok.length === 0) return;
        bumpBaseline(ok, localManifest);
        setRemoteManifest((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          for (const rel of ok) if (localManifest[rel]) next[rel] = localManifest[rel];
          return next;
        });

        // 不重扫所有已展开目录；只刷新本次节点的直接可见层，
        // 让新上传的文件/目录立即显示，更深层仍由懒加载按需读取。
        const parts = node.rel.split('/').filter(Boolean);
        const parent = parts.slice(0, -1).join('/');
        const visibleLevels = new Set<string>([parent]);
        if (node.isDir && expanded[node.rel]) visibleLevels.add(node.rel);
        await Promise.all([...visibleLevels].map((rel) => loadChildren(rel)));
        void gitRefreshRef.current?.();
      };
      const paintProgress = (force = false) => {
        if (!latestProgress) return;
        const now = Date.now();
        if (!force && now - lastProgressPaint < 80) return;
        lastProgressPaint = now;
        const { rel, index, fileBytes, activeCount } = latestProgress;
        setTransfer({
          direction: 'push', rel, fileIndex: index + 1, fileCount: rels.length,
          fileBytes, fileSize: sizes[rel], doneBytes, totalBytes, activeCount, startedAt,
        });
      };
      const publish = (rel: string, index: number, fileBytes: number, activeCount: number) => {
        const previous = fileProgress.get(rel) || 0;
        fileProgress.set(rel, fileBytes);
        doneBytes += Math.max(0, fileBytes - previous);
        latestProgress = { rel, index, fileBytes, activeCount };
        paintProgress();
      };

      for (let batchStart = 0; batchStart < rels.length; batchStart += TRANSFER_FILE_CONCURRENCY) {
        const batch = rels.slice(batchStart, batchStart + TRANSFER_FILE_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(async (rel, batchIndex) => {
          const index = batchStart + batchIndex;
          const size = sizes[rel];
          const id = transferId();
          if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
          publish(rel, index, 0, batch.length);
          const start = await api.syncWriteStart(workingDir, rel, id, execKey);
          if (start.status !== 'ok') throw new Error(start.message || `无法开始上传：${rel}`);
          let offset = 0;
          try {
            while (offset < size) {
              if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
              const requestSize = Math.min(TRANSFER_CHUNK_SIZE, size - offset);
              const data = await localFs.readChunk(rel, offset, requestSize);
              const result = await api.syncWriteChunk(workingDir, rel, id, offset, data, execKey);
              if (result.status !== 'ok') throw new Error(result.message || `上传失败：${rel}`);
              const chunkBytes = result.written ?? requestSize;
              if (chunkBytes <= 0) throw new Error(`上传返回空分块：${rel}`);
              offset += chunkBytes;
              publish(rel, index, offset, batch.length);
            }
            if (transferAbortRef.current) throw new Error('__TRANSFER_CANCELLED__');
            const finish = await api.syncWriteFinish(workingDir, rel, id, size, execKey);
            if (finish.status !== 'ok') throw new Error(finish.message || `上传完成校验失败：${rel}`);
            publish(rel, index, size, batch.length);
            ok.push(rel);
          } catch (error) {
            await api.syncWriteAbort(workingDir, rel, id, execKey).catch(() => {});
            throw error;
          }
        }));
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) {
          await applyUploaded();
          throw failed.reason;
        }
        if (transferAbortRef.current) {
          await applyUploaded();
          throw new Error('__TRANSFER_CANCELLED__');
        }
      }

      paintProgress(true);
      await applyUploaded();
      // 合并树会依据上面的 remoteManifest 增量立刻更新，无需在传输完成后
      // 再对所有已展开目录发一轮 listDirectory RPC。
      report({ kind: 'ok', text: `✓ 已上传 ${ok.length}/${rels.length} 个文件到远端` });
    } catch (e: any) {
      report({ kind: 'err', text: e?.message === '__TRANSFER_CANCELLED__' ? '上传已取消，未完成文件不会覆盖远端原文件' : `上传失败：${e?.message ?? e}` });
    }
    finally { fileTransfers.finish(job, outcome, failed); }
  }, [localFs, workingDir, execKey, localManifest, bumpBaseline, expanded, loadChildren, sessionOnline, transferKey, execLabel, sessionId]);

  /** 为浏览器预览分块取回二进制，绕开旧的 32 MiB 整文件 WS 帧并实时反馈读取进度。 */
  const readPreviewBytes = useCallback(async (
    node: TNode,
    source: PreviewState['source'],
    maxBytes: number,
  ): Promise<Uint8Array> => {
    const request = previewRequestRef.current;
    const scope = previewScopeRef.current;
    let size = 0;
    const selectedFs = localFsRef.current;
    if (source === 'local') {
      if (!selectedFs) throw new Error('本机目录未连接');
      size = await selectedFs.fileSize(node.rel);
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
        encoded = await selectedFs!.readChunk(node.rel, offset, requestSize);
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
      setPreview((current) => previewRequestRef.current === request && previewScopeRef.current === scope
        && current?.rel === node.rel && current.source === source
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
    const selectedFs = localFsRef.current;
    if (!selectedFs) throw new Error('本机目录未连接');
    const encoded = bytes ? bytesToBase64(bytes) : await selectedFs.readFile(node.rel);
    return api.filePreviewData(node.name, encoded, execKey) as Promise<StructuredPreviewPayload>;
  }, [workingDir, execKey, localFs]);

  const openReview = useCallback(async (rel: string, source: PreviewState['source']) => {
    if (source === 'local') {
      setMsg({
        kind: 'err',
        text: '审阅稿必须保存在 Session 执行端，才能交给 Agent。请先将本机文件上传到执行端。',
      });
      return;
    }
    if (!workingDir || reviewOpening) return;
    setReviewOpening(true);
    try {
      const result = await api.provOpen(workingDir, rel, execKey);
      if (result.status !== 'ok' || !result.document) throw new Error(result.message || '无法打开审阅工作台');
      setReview(result);
    } catch (error: any) {
      setMsg({ kind: 'err', text: `打开审阅失败：${error?.message ?? error}` });
    } finally { setReviewOpening(false); }
  }, [execKey, reviewOpening, workingDir]);

  // ── 已下载优先本机副本；远端保持只读，两种来源从不共享缓冲区或隐式上传。──
  const openPreview = useCallback(async (node: TNode, htmlFragment = '', requireReady = false) => {
    onDocumentOpen?.();
    const source: PreviewState['source'] = node.local ? 'local' : 'remote';
    if (documentHost && extOf(node.name) === 'prov') { await openReview(node.rel, source); return; }
    const tabId = fileTabId({ rel: node.rel, source });
    const previous = tabsRef.current.find(tab => tab.id === tabId);
    if (documentHost && preview && fileTabId(preview) === tabId && !htmlFragment) {
      if (requireReady && (preview.loading || preview.error)) throw new Error(preview.error || '活动文件仍在加载');
      return;
    }
    if (documentHost && !previous && tabsRef.current.length >= 32) {
      setMsg({ kind: 'err', text: '最多同时打开 32 个文件；请先关闭一些标签，未保存内容不会被淘汰。' }); return;
    }
    const nextView = previous?.view || defaultDocumentView(node.name);
    setDocumentView(nextView); setEditNotice(''); setComparison(null); setDraftChoices(null);
    if (documentHost && extOf(node.name) !== 'prov') setFileTabs(tabs => tabs.some(tab => tab.id === tabId) ? tabs
      : [...tabs, { id: tabId, rel: node.rel, name: node.name, source, view: nextView }]);
    const request = ++previewRequestRef.current;
    const scope = previewScopeRef.current;
    const user = getCurrentUserProfile().userId;
    const publish = (value: PreviewState) => {
      if (mountedRef.current && request === previewRequestRef.current && scope === previewScopeRef.current
          && user === getCurrentUserProfile().userId) setPreview(value);
    };
    const base: PreviewState = { rel: node.rel, name: node.name, source, htmlFragment, loading: true, loadingText: '正在准备预览…' };
    editOpenRequest.current++; setEditingDocument(null); setEditOpening(false);
    setPreview(base); setPreviewMaximized(false); setEditing(false); setMdRaw(false); setHtmlExported(false);
    try {
      if (!workingDir) throw new Error('未打开会话');
      const ext = extOf(node.name);

      if (ext === 'prov') {
        setPreview(null);
        await openReview(node.rel, source);
        return;
      }

      publish(await loadDocumentPreview(base, {
        bytes: max => readPreviewBytes(node, source, max),
        structured: bytes => structuredPreviewFor(node, source, bytes),
        base64: async () => {
          if (source === 'local') {
            const selectedFs = localFsRef.current;
            if (!selectedFs) throw new Error('本机目录未连接');
            return selectedFs.readFile(node.rel);
          }
          const result = await api.syncReadFile(workingDir, node.rel, execKey);
          if (result.status !== 'ok') throw new Error(result.message || '读取失败');
          if (result.tooLarge) throw new Error('文件过大，不便预览');
          return result.data ?? '';
        },
      }));
    } catch (e: any) { publish({ ...base, loading: false, error: e?.message ?? String(e) }); if (requireReady) throw e; }
  }, [workingDir, execKey, localFs, openReview, readPreviewBytes, structuredPreviewFor, sessionOnline, onDocumentOpen, documentHost, preview]);

  const htmlSource = preview?.source;
  const readHtmlResource = useCallback((rel: string) => {
    if (!htmlSource) return Promise.reject(new Error('预览已关闭'));
    return readPreviewBytes({ name: rel.split('/').pop() || rel, rel, isDir: false, size: 0 }, htmlSource, 8 * 1024 * 1024);
  }, [htmlSource, readPreviewBytes]);
  const navigateHtmlResource = useCallback((rel: string, fragment: string) => {
    void openPreview({ name: rel.split('/').pop() || rel, rel, isDir: false, size: 0,
      local: htmlSource === 'local', remote: htmlSource === 'remote' }, fragment);
  }, [htmlSource, openPreview]);

  const fallbackDocxPreview = useCallback((_renderError: string) => {
    const current = preview;
    if (!current || current.renderer !== 'docx' || !current.bytes) return;
    const scope = previewScopeRef.current, request = previewRequestRef.current;
    const matches = (latest: PreviewState | null): latest is PreviewState => mountedRef.current && previewScopeRef.current === scope
      && previewRequestRef.current === request && latest?.rel === current.rel && latest.source === current.source
      && latest.bytes === current.bytes && latest.renderer === 'docx';
    const node: TNode = { name: current.name, rel: current.rel, isDir: false, size: current.bytes.length };
    void structuredPreviewFor(node, current.source, current.bytes).then((structured) => {
      setPreview((latest) => matches(latest)
        ? { ...latest, renderer: undefined, bytes: undefined, structured }
        : latest);
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      setPreview((latest) => matches(latest) ? { ...latest, error: `Word 兼容预览也失败：${message}` } : latest);
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

  const exportPreview = useCallback(async () => {
    if (!preview || !localFs) return;
    try {
      if (preview.source !== 'local') throw new Error('请先下载到平板离线空间');
      await exportLocalFile(localFs, preview.rel, preview.name);
    } catch (error: any) {
      setMsg({ kind: 'err', text: `导出失败：${error?.message ?? error}` });
    }
  }, [preview, localFs]);

  const exportPreviewAsHtml = useCallback(async () => {
    if (!preview?.isMarkdown || preview.loading || preview.error || htmlExporting) return;
    if (preview.truncated) {
      setMsg({ kind: 'err', text: '当前 Markdown 预览已截断，已阻止导出不完整的 HTML' });
      return;
    }
    setHtmlExporting(true);
    setHtmlExported(false);
    try {
      const html = buildStandaloneMarkdownHtml(
        preview.name,
        markdownToHtml(preview.text || ''),
      );
      const filename = markdownHtmlFilename(preview.name);
      const result = await exportGeneratedText(html, filename, 'text/html;charset=utf-8');
      if (result.mode !== 'cancelled') {
        setHtmlExported(true);
        const detail = result.mode === 'saved'
          ? `已保存：${result.destination}`
          : result.mode === 'shared'
            ? `已交给系统分享：${filename}`
            : `已下载：${filename}（位置由浏览器下载设置决定）`;
        setMsg({ kind: 'ok', text: `✓ ${detail}` });
      }
    } catch (error: any) {
      setMsg({ kind: 'err', text: `HTML 导出失败：${error?.message ?? error}` });
    } finally {
      setHtmlExporting(false);
    }
  }, [htmlExporting, preview]);

  const startEdit = useCallback(async (desiredView: DocumentView = 'source') => {
    if (!preview || preview.isImage || preview.structured || preview.renderer || editOpening) return;
    const request = ++editOpenRequest.current, scope = previewScopeRef.current;
    const user = getCurrentUserProfile().userId, selectedFs = localFs;
    const target = execKey || getSessionExecKey(sessionId);
    const current = () => mountedRef.current && previewScopeRef.current === scope
      && getCurrentUserProfile().userId === user && (preview.source !== 'local' || selectedFs === localFsRef.current);
    setEditOpening(true); setEditNotice('');
    try {
      if (!sessionId || !target) throw new DocumentProtocolError('workspace_identity_required');
      let client: DocumentClient;
      if (preview.source === 'local') {
        if (!selectedFs?.documentAdapter) throw new DocumentProtocolError('safe_local_documents_unsupported');
        const adapter = await selectedFs.documentAdapter();
        client = new LocalDocuments(user, sessionId, target, adapter, new IndexedLocalJournal(), current);
      } else {
        const executorClient = await api.workspaceDocuments(sessionId, target, workingDir, current);
        client = isRemote ? readonlyDocumentClient(executorClient) : executorClient;
      }
      if (!current()) throw new DocumentProtocolError('stale_workspace');
      const loaded = await documentDrafts.open(client, preview.rel), doc = loaded.document;
      if (!current() || request !== editOpenRequest.current) return;
      setEditingDocument({ key: doc.key, client, scope }); setEditing(desiredView !== 'preview');
      if (documentHost) setDocumentView(desiredView);
      setDraftChoices({ key: doc.key, rows: loaded.choices });
      if (doc.persistence === 'restored') setMsg({ kind: 'ok', text: '已恢复本设备草稿；未自动保存，磁盘版本变化时需先比较。' });
      if (!doc.read?.editable && doc.read?.reasonCode !== 'remote_readonly') setMsg({ kind: 'err', text: `此文件仅可查看：${doc.read?.reasonCode || '完整性未确认'}，不会覆盖原文件。` });
    } catch (error: any) {
      if (current() && request === editOpenRequest.current) {
        const text = `只读：无法安全编辑（${error?.message || error}）。未使用预览内容覆盖文件。`;
        setEditNotice(text); setMsg({ kind: 'err', text });
      }
    } finally { if (request === editOpenRequest.current) setEditOpening(false); }
  }, [preview, localFs, execKey, sessionId, workingDir, editOpening, documentHost, isRemote]);
  useEffect(() => {
    if (!documentHost || !preview || preview.loading || preview.error || preview.isImage || preview.structured
      || preview.renderer || autoEditRequest.current === previewRequestRef.current) return;
    autoEditRequest.current = previewRequestRef.current;
    void startEdit(documentView);
  }, [documentHost, preview, startEdit, documentView]);
  const changeDocumentView = (view: DocumentView) => {
    if (!preview) return;
    setDocumentView(view); setEditing(view !== 'preview');
    setFileTabs(tabs => tabs.map(tab => tab.id === fileTabId(preview) ? { ...tab, view } : tab));
  };
  navigateRef.current = request => {
    const rel = normalizeRelativeFilePath(request.relativePath); if (!rel) return;
    const local = isRemote && !!localManifest?.[rel];
    if (request.line) setEditorCommand({ id: ++editorCommandId.current, relativePath: rel, source: local ? 'local' : 'remote', type: 'position', line: request.line, column: request.column });
    else setEditorCommand(null);
    void openPreview({ rel, name: rel.split('/').pop()!, isDir: false, size: 0, remote: true, local });
  };
  useEffect(() => {
    if (editorCommand?.type === 'position' && preview?.rel === editorCommand.relativePath && preview.source === editorCommand.source
      && activeDocument && documentView === 'preview') changeDocumentView('source');
  }, [editorCommand, activeDocument?.key, preview?.rel]);
  const connectSearch = async () => {
    const target = execKey || getSessionExecKey(sessionId), scope = previewScopeRef.current, user = getCurrentUserProfile().userId;
    if (!sessionId || !target) throw new Error('会话执行端身份未就绪');
    return api.workspaceDocuments(sessionId, target, workingDir, () => mountedRef.current && previewScopeRef.current === scope && getCurrentUserProfile().userId === user);
  };
  const selectFileTab = (tab: FileTab) => void openPreview({ rel: tab.rel, name: tab.name, size: 0, isDir: false,
    local: tab.source === 'local', remote: tab.source === 'remote' });
  const transferRef = useRef<{ export: () => Promise<unknown>; import: (value: unknown) => Promise<void> } | null>(null);
  transferRef.current = {
    export: async () => {
      if (preview?.loading || editOpening) throw new Error('文件正在打开，请等待读取完成再移动');
      if (fileTransfers.active(transferKey)) throw new Error('本窗口文件传输仍在进行；请先等待完成或核对取消，再移动工作台');
      const clients: DocumentClient[] = [];
      const remote = await connectSearch(); if (remote.supported) clients.push(isRemote ? readonlyDocumentClient(remote) : remote);
      if (localFs?.documentAdapter && sessionId && execKey) clients.push(new LocalDocuments(documentOwner, sessionId, execKey,
        await localFs.documentAdapter(), new IndexedLocalJournal(), () => previewScopeRef.current === previewScope && getCurrentUserProfile().userId === documentOwner));
      const docs = documentStore.all().filter(doc => clients.some(client => sameWorkspace(client.identity, doc.identity.workspace)));
      if (docs.length > 64) throw new Error('打开文档超过交接上限，请先导出或关闭部分文件');
      const { exportDocumentHandoff } = await import('../utils/documentHandoff');
      const documents = docs.filter(doc => doc.dirty || doc.read?.editable).map(exportDocumentHandoff);
      const tabs = documentHost ? fileTabs.map(tab => ({ rel: tab.rel, name: tab.name, source: tab.source, view: tab.view }))
        : preview ? [{ rel: preview.rel, name: preview.name, source: preview.source, view: editing ? 'source' : 'preview' }] : [];
      return { tabs, active: preview ? { rel: preview.rel, source: preview.source } : null, documents };
    },
    import: async value => {
      const row = value as any, scope = previewScope;
      const current = () => mountedRef.current && previewScopeRef.current === scope && getCurrentUserProfile().userId === documentOwner;
      if (!row || !Array.isArray(row.tabs) || row.tabs.length > 32 || !Array.isArray(row.documents) || row.documents.length > 64
        || row.tabs.some((tab: any) => !tab || normalizeRelativeFilePath(tab.rel) !== tab.rel || typeof tab.name !== 'string'
          || !['local', 'remote'].includes(tab.source) || !['preview', 'source', 'split'].includes(tab.view))) throw new Error('文件标签交接数据无效');
      const clients: Partial<Record<'local' | 'remote', DocumentClient>> = {};
      const clientFor = async (source: 'local' | 'remote') => {
        if (clients[source]) return clients[source]!;
        if (source === 'remote') { const remote = await connectSearch(); clients.remote = isRemote ? readonlyDocumentClient(remote) : remote; }
        else {
          const fs = localFsRef.current || await restoreLocalDir(localBindingKey);
          if (!fs?.documentAdapter || !sessionId || !execKey) throw new Error('目标窗口无法恢复本机目录绑定');
          if (!current()) throw new Error('交接目标身份已变化');
          setLocalFs(fs); localFsRef.current = fs;
          clients.local = new LocalDocuments(documentOwner, sessionId, execKey, await fs.documentAdapter(), new IndexedLocalJournal(), current);
        }
        return clients[source]!;
      };
      const restored = new Map<string, DocumentSelection>();
      const { importDocumentHandoff } = await import('../utils/documentHandoff');
      for (const draft of row.documents as RecoverableDraft[]) {
        const source = draft?.identity?.source === 'local-copy' ? 'local' : 'remote', client = await clientFor(source);
        const key = await importDocumentHandoff(client, draft, current);
        restored.set(fileTabId({ rel: draft.identity.relativePath, source }), { key, client, scope });
      }
      if (!current()) throw new Error('交接目标身份已变化');
      const tabs: FileTab[] = row.tabs.map((tab: FileTab) => ({ rel: tab.rel, name: tab.name, source: tab.source, view: tab.view,
        id: fileTabId(tab), document: restored.get(fileTabId(tab)) }));
      setFileTabs(tabs); tabsRef.current = tabs;
      const active = row.active && tabs.find(tab => tab.rel === row.active.rel && tab.source === row.active.source);
      if (row.active && !active) throw new Error('活动文件不在交接标签内');
      if (active) {
        if (active.source === 'local') await clientFor('local');
        await openPreview({ rel: active.rel, name: active.name, isDir: false, size: 0, local: active.source === 'local', remote: active.source === 'remote' }, '', true);
        if (!current()) throw new Error('交接目标身份已变化');
        setDocumentView(active.view); setEditing(active.view !== 'preview');
        if (active.document) setEditingDocument(active.document);
      }
    },
  };
  useEffect(() => {
    if (!sessionId || !execKey || !workingDir) return;
    return handoffParticipants.register(handoffScope(documentOwner, execKey, sessionId, workingDir), documentHost ? 'filesEngine' : 'filesChat', {
      export: () => transferRef.current!.export(), import: value => transferRef.current!.import(value),
    });
  }, [previewScope, documentHost]);
  const removeFileTab = (tab: FileTab) => {
    const remaining = tabsRef.current.filter(item => item.id !== tab.id);
    setFileTabs(remaining); tabsRef.current = remaining; setClosingTab(null);
    if (preview && fileTabId(preview) === tab.id) {
      previewRequestRef.current++; editOpenRequest.current++; setPreview(null); setEditingDocument(null); setEditOpening(false);
      if (remaining.length) selectFileTab(remaining[Math.max(0, remaining.length - 1)]);
    }
  };
  const requestCloseTab = (tab: FileTab) => {
    const doc = tab.document && documentStore.get(tab.document.key);
    if (doc?.dirty || doc?.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || '')) setClosingTab(tab);
    else removeFileTab(tab);
  };
  const finishCloseTab = async (action: 'save' | 'discard') => {
    const tab = closingTab, scope = previewScope;
    if (!tab?.document || tabClosing) return;
    setTabClosing(true);
    try {
      if (action === 'discard') await documentDrafts.discard(tab.document.key);
      else {
        const doc = documentStore.get(tab.document.key);
        const unknown = doc?.save?.unknown || doc?.save?.receipt?.status === 'accepted';
        const receipt = unknown ? await documentStore.reconcile(tab.document.client, tab.document.key)
          : await documentStore.save(tab.document.client, tab.document.key);
        if (receipt.status !== 'succeeded' || documentStore.get(tab.document.key)?.dirty) throw new Error('保存未完成或产生了新编辑，标签仍保留');
      }
      if (previewScopeRef.current === scope) removeFileTab(tab);
    } catch (error: any) { if (previewScopeRef.current === scope) setEditNotice(`未关闭文件：${error?.message || error}`); }
    finally { if (previewScopeRef.current === scope) setTabClosing(false); }
  };
  const saveEdit = useCallback(async () => {
    if (!preview || !editingDocument || !activeDocument) return;
    const selected = editingDocument;
    try {
      const receipt = needsSaveCheck ? await documentStore.reconcile(selected.client, selected.key)
        : await documentStore.save(selected.client, selected.key);
      if (!mountedRef.current || previewScopeRef.current !== selected.scope) return;
      if (receipt.status !== 'succeeded') {
        setMsg({ kind: 'err', text: receipt.status === 'failed' ? `未保存：${receipt.reasonCode}；草稿已保留。`
          : '保存结果尚未确认，草稿已保留。请使用“核对保存”，不会重复写入。' });
        return;
      }
      setMsg({ kind: 'ok', text: `✓ 已保存 ${preview.name}${preview.source === 'local' ? '（本机副本，未上传）' : ''}` });
      if (preview.source === 'local') {
        void scanLocal(localFs);
      } else {
        setRemoteManifest(null);
        void loadChildren(preview.rel.split('/').slice(0, -1).join('/'));
        void gitRefreshRef.current?.();
      }
    } catch (e: any) {
      if (mountedRef.current && previewScopeRef.current === selected.scope) setMsg({ kind: 'err', text: `保存失败：${e?.message ?? e}` });
    }
  }, [preview, editingDocument, activeDocument, needsSaveCheck, localFs, scanLocal, loadChildren]);
  const saveAllEdits = useCallback(async () => {
    if (!editingDocument || batchSaving) return;
    const { client, scope } = editingDocument;
    const keys = documentStore.all().filter(doc => sameWorkspace(client.identity, doc.identity.workspace)
      && doc.identity.source === (client.source || 'executor') && doc.dirty).map(doc => doc.key);
    setBatchSaving(true);
    try {
      const results = await documentStore.saveAll(client, keys);
      if (mountedRef.current && previewScopeRef.current === scope) setBatchResults({ scope, rows: results.map(row => ({
        name: documentStore.get(row.key)?.identity.relativePath || '文件',
        status: row.receipt?.status === 'succeeded' ? '已保存' : row.receipt?.reasonCode || row.error || '结果待核对',
      })) });
    } finally { if (mountedRef.current) setBatchSaving(false); }
  }, [editingDocument, batchSaving]);
  const compareDocument = useCallback(async () => {
    if (!editingDocument || !activeDocument) return;
    const selected = editingDocument;
    try {
      const doc = await documentStore.open(selected.client, activeDocument.identity.relativePath, true);
      if (previewScopeRef.current !== selected.scope || !doc.disk?.version) return;
      setComparison({ key: doc.key, diskVersion: doc.disk.version, revision: doc.revision, text: doc.text });
    } catch (error: any) {
      if (previewScopeRef.current === selected.scope) setMsg({ kind: 'err', text: `无法读取磁盘比较版本：${error?.message || error}；未修改草稿。` });
    }
  }, [editingDocument, activeDocument]);
  const closePreview = useCallback(() => {
    if (dirty && !window.confirm(activeDocument?.persistence === 'saved'
      ? '修改尚未保存到文件。关闭预览会保留本设备草稿；仍要关闭？'
      : '修改尚未保存，草稿尚未可靠持久化，刷新或退出可能丢失；仍要关闭？')) return;
    previewRequestRef.current++;
    editOpenRequest.current++; setEditingDocument(null); setEditOpening(false);
    setPreview(null); setPreviewMaximized(false); setEditing(false); setHtmlExported(false);
  }, [dirty, activeDocument?.persistence]);

  useEffect(() => {
    if (!preview || !isVisible || documentHost) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (previewMaximized) setPreviewMaximized(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview, previewMaximized, documentHost, isVisible]);

  // ── 渲染 ──
  const fileIcon = (n: TNode, st: FStatus | null): string => {
    if (n.isDir) return expanded[n.rel] ? '📂' : '📁';
    if (st === 'cloud') return '☁️';
    if (st === 'localOnly') return '💻';
    return '📄';
  };

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const nodes = mergedChildren(rel).filter((node) => {
      if (!onlyDifferent) return true;
      if (!node.isDir) return differentPaths.has(node.rel);
      const prefix = node.rel ? `${node.rel}/` : '';
      for (const path of differentPaths) {
        if (!node.rel || path.startsWith(prefix)) return true;
      }
      return false;
    });
    if (children[rel] === undefined && nodes.length === 0) {
      if (directoryErrors[rel] && !loading[rel]) return <Empty text="目录同步失败，请点击刷新重试" />;
      return <div className="ftp-tree-placeholder" role="status" aria-label="目录同步中">
        <div style={{ ...rowStyle, paddingLeft: 12 + depth * 8, color: 'var(--theme-text-muted)' }}>同步中…</div>
        {Array.from({ length: depth === 0 ? 6 : 2 }, (_, index) => <div key={index} aria-hidden="true" style={{ ...rowStyle, paddingLeft: 16 + depth * 8, gap: 6 }}>
          <span style={{ ...skeletonStyle, width: 14, height: 14 }} />
          <span style={{ ...skeletonStyle, width: `${42 + index % 3 * 14}%`, height: 8 }} />
        </div>)}
      </div>;
    }
    if (nodes.length === 0 && depth === 0) {
      return <Empty text={onlyDifferent ? '没有内容不同的文件' : '（空目录）'} />;
    }
    const limit = directoryLimits[rel] || 200;
    const visibleNodes = nodes.slice(0, limit);
    const focusPath = focusRequest && focusRequest.sessionId === sessionId
      ? normalizeRelativeFilePath(focusRequest.relativePath) : '';
    const focusedNode = focusPath ? nodes.find(node => node.rel === focusPath
      || (node.isDir && focusPath.startsWith(node.rel + '/'))) : undefined;
    if (focusedNode && !visibleNodes.includes(focusedNode)) visibleNodes.push(focusedNode);
    return <>{visibleNodes.map((n) => {
      const open = !!expanded[n.rel];
      const gitTransferBlocked = isGitMetadataPath(n.rel) && !includeGitMetadata;
      const st = gitTransferBlocked ? null : statusOf(n);
      const freshness = gitTransferBlocked ? null : freshnessOf(n);
      const dotColor = st && st !== 'cloud' && st !== 'local' && st !== 'synced' ? STATUS_COLOR[st] : null;

      // Git 状态角标：文件直接查表；目录取其子项中最严重的状态
      let gitBadge: { letter: string; color: string; title: string } | null = null;
      if (gitAvailable) {
        if (!n.isDir) {
          const gf = gitFiles[n.rel];
          if (gf) gitBadge = { letter: GIT_STATUS_LETTER[gf.status], color: GIT_STATUS_COLOR[gf.status], title: `${gf.status}${gf.staged ? ' (staged)' : ''}` };
        } else {
          const worst = gitDirectories.get(n.rel) || gitFiles[n.rel];
          if (worst) gitBadge = { letter: GIT_STATUS_LETTER[worst.status], color: GIT_STATUS_COLOR[worst.status], title: worst.status };
        }
      }

      return (
        <div key={n.rel}>
          <div
            ref={(element) => {
              if (element) rowRefs.current.set(n.rel, element);
              else rowRefs.current.delete(n.rel);
            }}
            tabIndex={-1}
            className={`ftp-row${selected === n.rel ? ' ftp-sel' : ''}${focusFlash === n.rel ? ' ftp-focus-reveal' : ''}`}
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
            title={gitTransferBlocked
              ? `${n.name} · Git 元数据默认不参与同步`
              : freshness
                ? `${n.name}\n${freshnessTooltip(freshness)}`
                : st ? `${n.name} · ${STATUS_LABEL[st]}` : n.name}
          >
            {Array.from({ length: depth }).map((_, i) => <span key={i} style={guideStyle} />)}
            <span style={chevronStyle}>{n.isDir ? (open ? '▾' : '▸') : ''}</span>
            <span style={{ ...iconStyle, ...(st === 'cloud' ? { opacity: 0.85 } : {}) }}>{fileIcon(n, st)}</span>
            <span style={{ ...nameStyle, ...(st === 'cloud' ? { color: 'var(--theme-text-muted)' } : dotColor ? { color: dotColor } : {}) }}>{n.name}</span>
            {freshness && freshness.kind !== 'same' && (
              <span
                className="ftp-freshness"
                title={freshnessTooltip(freshness)}
                style={{
                  ...syncFreshnessBadgeStyle,
                  color: freshness.kind === 'both-updated' ? '#ef4444'
                    : freshness.kind === 'remote-updated' || freshness.kind === 'remote-only' ? '#60a5fa'
                      : freshness.kind === 'local-updated' || freshness.kind === 'local-only' ? '#22c55e'
                        : '#f59e0b',
                }}
              >
                {freshnessDetail(freshness)}
              </span>
            )}
            {dotColor && <span title={STATUS_LABEL[st!]} style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0, marginLeft: 4 }} />}
            {st === 'synced' && <span title={STATUS_LABEL.synced} style={{ fontSize: 10, color: STATUS_COLOR.synced, flexShrink: 0, marginLeft: 4 }}>✓</span>}
            {gitTransferBlocked && (
              <span title="在同步高级设置中显式启用后才可传输" style={gitExcludedBadgeStyle}>不同步</span>
            )}
            {/* Git 状态角标（TortoiseGit 风格） */}
            {gitBadge && (
              <span title={`Git: ${gitBadge.title}`} style={{
                width: 16, height: 16, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700, color: '#fff', flexShrink: 0, marginLeft: 3,
                background: gitBadge.color,
              }}>{gitBadge.letter}</span>
            )}
            {/* 操作(hover) */}
            {n.remote && !isGitMetadataPath(n.rel) && (
              <button className="ftp-act" style={{ ...actBtnStyle, color: '#ef4444' }} disabled={!sessionOnline || !!transfer}
                title={n.isDir ? '删除执行端目录及全部内容（保留本地副本）' : '删除执行端文件（保留本地副本）'}
                onClick={event => { event.stopPropagation(); void deleteRemoteEntry(n); }}>🗑</button>
            )}
            {!n.isDir && !n.typeConflict && (
              <button className="ftp-act" style={actBtnStyle} title="预览 / 编辑" onClick={(e) => { e.stopPropagation(); openPreview(n); }}>👁</button>
            )}
            {isRemote && localFs && !gitTransferBlocked && !n.typeConflict && n.remote && (!n.local || n.isDir || st === 'differs' || st === 'conflict') && (
              <button className="ftp-act" style={actBtnStyle} disabled={!sessionOnline || !!transfer} title={sessionOnline ? '下载到本地' : '执行端离线'} onClick={(e) => { e.stopPropagation(); pull(n); }}>⬇</button>
            )}
            {isRemote && localFs && !gitTransferBlocked && !n.typeConflict && n.local && (n.isDir || st !== 'synced') && (
              <button className="ftp-act" style={actBtnStyle} disabled={!sessionOnline || !!transfer} title={sessionOnline ? '上传本地改动到远端' : '离线修改已保留，联网后上传'} onClick={(e) => { e.stopPropagation(); push(n); }}>⬆</button>
            )}
          </div>
          {n.isDir && open && renderDir(n.rel, depth + 1)}
        </div>
      );
    })}{nodes.length > limit && <button style={{ ...actBtnStyle, width: 'auto', padding: '6px 12px', height: 'auto' }}
      onClick={() => setDirectoryLimits(current => ({ ...current, [rel]: limit + 200 }))}
      title="分批展开，避免大量文件阻塞界面">显示更多（剩余 {nodes.length - limit} 项）</button>}</>;
  };

  const directoryError = Object.values(directoryErrors).find(Boolean) || '';
  // 常驻提示不订阅扫描/读取/Git 轮询状态；仅显式操作结果和错误覆盖提示。
  const panelStatus = directoryError || gitError || (summary && remoteManifest
    ? `比对结果 · 仅本机 ${summary.localOnly} · 仅远端 ${summary.cloud} · 不同 ${summary.differs} · 冲突 ${summary.conflict}`
    : workingDir ? '目录按需读取，可手动刷新' : '请选择有工作目录的会话');
  const panelStatusDetail = [panelStatus, '文件内容按需读取，不会自动上传或下载',
    !isTauri() && localFs?.kind === 'managed' && !offlineAppShellSupported()
      ? '局域网 HTTP：副本与当前页面可离线使用，关闭浏览器后离线重开需 HTTPS' : '',
  ].filter(Boolean).join('\n');
  const gitActionDisabled = !gitAvailable || !gitStatusReady || !!gitError;
  const editorElement = preview && <Suspense fallback={<div style={{ padding: 24 }}>编辑器加载中…</div>}>
    <CodeEditor key={activeDocument?.lifecycleId || fileTabId(preview)} documentKey={activeDocument?.key}
      language={languageEditor.binding}
      value={activeDocument ? editText : preview.text || ''} ext={extOf(preview.name)} dark={isDarkTheme()}
      height={documentHost ? '100%' : undefined}
      command={activeDocument && editorCommand?.relativePath === preview.rel && editorCommand.source === preview.source ? editorCommand : undefined}
      readOnly={!activeDocument?.read?.editable}
      editorState={activeDocument?.editor as EditorDocumentState | undefined}
      onEditorState={state => { if (activeDocument) documentStore.editorState(activeDocument.key, state, activeDocument.lifecycleId); }}
      onChange={value => { if (activeDocument) documentStore.edit(activeDocument.key, value); }} onSave={saveEdit} onSaveAll={saveAllEdits} />
  </Suspense>;
  const engineRichPreview = preview?.isHtml ? <Suspense fallback={<p>HTML 预览加载中…</p>}>
    <HtmlPreview key={fileTabId(preview)} source={activeDocument ? editText : preview.text || ''} rel={preview.rel} fragment={preview.htmlFragment}
      root={preview.source === 'local' ? localFs?.label() || '本机副本' : workingDir}
      nodeLabel={preview.source === 'local' ? '本机副本' : execLabel || '会话执行节点'}
      readFile={readHtmlResource} onNavigate={navigateHtmlResource} onReveal={revealPreview} />
  </Suspense> : preview?.isMarkdown ? <MarkdownPreview key={fileTabId(preview)}
    source={activeDocument ? editText : preview.text || ''} title={preview.name} initialDark={isDarkTheme()} /> : null;

  return (
    <WorkbenchInteractionContext.Provider value={windowFrozen}>
    <div className="ftp-panel" {...(windowFrozen ? { inert: '' } as any : {})} style={wrapStyle}>
      <style>{`
        @keyframes ftp-focus-pulse {
          0%, 100% { box-shadow: inset 2px 0 0 var(--theme-accent, #0969da); }
          35% { box-shadow: inset 3px 0 0 var(--theme-accent, #0969da), 0 0 0 2px var(--theme-accent-bg, rgba(9,105,218,.18)); }
        }
        .ftp-row:hover { background: var(--theme-bg-tertiary, rgba(255,255,255,0.05)); }
        .ftp-row.ftp-sel { background: var(--theme-accent-bg, rgba(9,105,218,0.12)); box-shadow: inset 2px 0 0 var(--theme-accent, #0969da); }
        .ftp-row.ftp-focus-reveal { animation: ftp-focus-pulse .55s ease-in-out 2; }
        .ftp-row:focus { outline: 1px solid color-mix(in srgb, var(--theme-accent, #0969da) 42%, transparent); outline-offset: -1px; }
        .ftp-freshness {
          opacity: 0;
          visibility: hidden;
          max-width: 0 !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
          transform: translateX(3px);
          transition: opacity .12s ease, max-width .12s ease, padding .12s ease, transform .12s ease;
          pointer-events: none;
        }
        .ftp-row:hover .ftp-freshness,
        .ftp-row:focus .ftp-freshness,
        .ftp-row:focus-within .ftp-freshness {
          opacity: 1;
          visibility: visible;
          max-width: 230px !important;
          padding-left: 4px !important;
          padding-right: 4px !important;
          transform: translateX(0);
        }
        .ftp-act { opacity: 0; }
        .ftp-row:hover .ftp-act { opacity: 1; }
        .ftp-act:disabled { opacity: .35 !important; cursor: not-allowed !important; }
        .ftp-hactions { opacity: 0; pointer-events: none; transition: opacity 0.12s ease; }
        .ftp-hdr:hover .ftp-hactions, .ftp-hactions:focus-within { opacity: 1; pointer-events: auto; }
        .ftp-panel button:disabled { opacity: .4; cursor: not-allowed; }
        .ftp-action-row > * { flex-shrink: 0; white-space: nowrap; }
      `}</style>

      {/* 顶部工具条 */}
      <div className="ftp-hdr" style={topBarStyle}>
        <div style={headerIdentityStyle}>
          <span style={{ fontSize: 14, flexShrink: 0 }}>{isRemote ? '☁️' : '🗂'}</span>
          <span
            title={isRemote ? '远端工作目录' : '工作目录'}
            style={headerTitleStyle}
          >
            {isRemote ? '远端工作目录' : '工作目录'}
          </span>
          {isRemote && <span style={{ ...tagStyle, width: 70 }} title={workingDir}>{execLabel || '执行节点'}</span>}
          <span className="ftp-branch" style={{ ...gitBranchBadgeStyle, width: 92 }} title={gitBranch ? `Git branch: ${gitBranch}` : gitError || 'Git 状态'}>
            {gitBranch ? `🔀 ${gitBranch}` : gitLoading ? 'Git 同步中…' : gitError ? 'Git 不可用' : '无 Git'}
          </span>
        </div>
        <div className="ftp-hactions" style={headerActionsStyle}>
          <button style={hdrIconStyle} aria-label="本设备草稿" title="离线草稿恢复、导出与清理" onClick={() => setDraftRecoveryOpen(true)}>▤</button>
            <button
              disabled={gitActionDisabled}
              style={{ ...hdrIconStyle, fontSize: 11, width: 'auto', padding: '0 6px', gap: 3 }}
              title="Stash 当前改动"
              onClick={handleStashPush}
            >📦 Stash</button>
            <button
              disabled={gitActionDisabled}
              style={{
                ...hdrIconStyle, fontSize: 11, width: 40, padding: '0 6px',
                ...(stashExpanded ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}),
              }}
              title="查看 Stash 列表"
              onClick={() => setStashExpanded((v) => !v)}
            >▾<span style={{ marginLeft: 2, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis' }}>({stashes.length})</span></button>
            <button
              disabled={gitActionDisabled}
              style={{ ...hdrIconStyle, fontSize: 11, width: 'auto', padding: '0 6px', gap: 3 }}
              title="查看 Git 提交历史"
              onClick={() => setGitLogOpen(true)}
            >Log</button>
          <button style={hdrIconStyle} title="刷新本机与远端目录" onClick={refreshAll}>↻</button>
          <button style={hdrIconStyle} title="全部折叠" onClick={() => setExpanded({})}>⊟</button>
        </div>
      </div>

      {draftRecoveryOpen && <Suspense fallback={null}><DocumentDraftRecovery owner={documentOwner}
        onClose={() => setDraftRecoveryOpen(false)} onExport={exportGeneratedText} /></Suspense>}

      {/* VS Code Quick Open 风格的工作区文件查询。 */}
      <div className="ftp-search" style={fileSearchBarStyle}>
        <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--theme-text-muted)', flexShrink: 0 }}>⌕</span>
        <input
          ref={searchInputRef}
          type="text"
          role="searchbox"
          aria-label="搜索工作区文件"
          value={searchQuery}
          placeholder="搜索文件名或路径"
          spellCheck={false}
          title="递归模糊搜索 · ↑↓ 选择 · Enter 打开 · Esc 清空"
          onChange={(event) => {
            const value = event.target.value;
            setSearchQuery(value);
            if (value.trim()) setOnlyDifferent(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSearchSelectedIndex((index) => Math.min(Math.max(0, searchResults.length - 1), index + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSearchSelectedIndex((index) => Math.max(0, index - 1));
            } else if (event.key === 'Enter') {
              const result = searchResults[searchSelectedIndex];
              if (result) {
                event.preventDefault();
                setSelected(result.rel);
                void openPreview(result);
              }
            } else if (event.key === 'Escape' && searchQuery) {
              event.preventDefault();
              setSearchQuery('');
            }
          }}
          style={fileSearchInputStyle}
        />
        {searchLoading ? (
          <span title="搜索中" style={fileSearchMetaStyle}>…</span>
        ) : searchQuery.trim() ? (
          <span
            title={searchTruncated ? `命中 ${searchMatched} 项，仅显示前 ${searchResults.length} 项` : `命中 ${searchMatched} 项`}
            style={fileSearchMetaStyle}
          >
            {searchTruncated ? `${searchResults.length}/${searchMatched}` : searchMatched}
          </span>
        ) : null}
        {searchQuery && (
          <button
            type="button"
            aria-label="清空文件搜索"
            title="清空（Esc）"
            onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }}
            style={fileSearchClearStyle}
          >×</button>
        )}
      </div>

      {/* 远端目录在执行节点上；这里绑定当前 session 对应的本机目录，可随时更换。 */}
      {isRemote && (
        <>
        <div className="ftp-local-identity" style={localDirBarStyle}>
          <span style={{ fontSize: 11, width: 78, color: 'var(--theme-text-muted)', flexShrink: 0 }}>
            {localFs?.kind === 'managed' ? '📱 离线空间' : '💻 本机目录'}
          </span>
          <span
            title={localRestoring ? '本机目录同步中' : localFs?.label() || '尚未指定本机目录'}
            style={{
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 10, fontFamily: 'monospace', color: localFs ? 'var(--theme-text)' : 'var(--theme-text-muted)',
            }}
          >
            {localFs?.label() || (localRestoring ? '同步中…' : '未指定（远端文件仍可在线查看）')}
          </span>
          <span
            title={sessionOnline ? '执行端在线' : '执行端离线：已下载文件仍可查看和编辑'}
            style={{ fontSize: 9, whiteSpace: 'nowrap', color: sessionOnline ? '#22c55e' : '#f59e0b' }}
          >
            {sessionOnline ? '● 在线' : '● 离线'}
          </span>
        </div>
        <div className="ftp-local-actions ftp-action-row" style={localActionsStyle} aria-busy={localRestoring}>
            <button
              disabled={!localFs || !remoteManifest || localRestoring}
              style={{
                ...localDirButtonStyle,
                ...(onlyDifferent ? {
                  background: 'var(--theme-accent, #58a6ff)',
                  color: '#fff',
                  borderColor: 'var(--theme-accent, #58a6ff)',
                } : {}),
              }}
              onClick={toggleOnlyDifferent}
              title="只显示两端都存在但内容不同的文件（包含冲突），不包含仅本机或仅远端"
              aria-pressed={onlyDifferent}
            >
              {onlyDifferent ? '✓ ' : ''}仅不同 {differentPaths.size}
            </button>
            <button style={localDirButtonStyle} disabled={!localFs || localRestoring || !sessionOnline || comparing || !!transfer} onClick={runCompare} title={sessionOnline ? '扫描两端并比较文件状态' : '恢复连接后可比对'}>
              {comparing ? '比对中…' : '↔ 比对'}
            </button>
          {!isTauri() && (
            <>
              <input
                ref={importFileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(event) => void importDeviceFiles(event.target.files)}
              />
              <button style={localDirButtonStyle} disabled={!localFs || localRestoring || !!transfer} onClick={() => importFileInputRef.current?.click()} title="从平板文件 App 导入到离线空间">
                ＋ 导入
              </button>
            </>
          )}
          {!isTauri() && browserDirectoryPickerSupported() && (
            <button style={localDirButtonStyle} disabled={localRestoring || !!transfer || localFs?.kind === 'managed'} onClick={chooseManagedLocal} title="改用不依赖目录权限的浏览器离线空间">
              离线空间
            </button>
          )}
          <button style={{ ...localDirButtonStyle, minWidth: 60 }} disabled={localRestoring || !!transfer} onClick={chooseLocal} title={
            isTauri()
              ? (localFs ? '更换此 session 的本机目录' : '指定此 session 的本机目录')
              : browserDirectoryPickerSupported()
                ? '选择设备目录；也可使用浏览器托管离线空间'
                : '启用当前浏览器的平板离线空间'
          }>
            {localFs ? (localFs.kind === 'managed' ? '重开' : '更换') : (!isTauri() && !browserDirectoryPickerSupported() ? '启用离线' : '指定')}
          </button>
        </div>
        <details style={syncAdvancedStyle}>
          <summary style={syncAdvancedSummaryStyle}>
            高级同步 · Git 元数据{includeGitMetadata ? '已包含' : '默认排除'}
          </summary>
          <label style={syncAdvancedOptionStyle}>
            <input
              type="checkbox"
              checked={includeGitMetadata}
              disabled={!!transfer || comparing}
              onChange={(event) => changeIncludeGitMetadata(event.target.checked)}
            />
            <span>
              <strong style={{ fontWeight: 600 }}>包含 .git 仓库元数据</strong>
              <small style={{ display: 'block', marginTop: 2, color: 'var(--theme-text-muted)', lineHeight: 1.45 }}>
                仅用于完整迁移或备份；日常同步保持关闭。文件树仍会显示 .git。
              </small>
            </span>
          </label>
        </details>
        </>
      )}

      {/* 固定提示/传输槽从首帧占位；后台扫描保持静默，消息、错误和进度原位展示。 */}
      <div className="ftp-status-slot" style={statusSlotStyle}>
      {transfer ? (() => {
        const overall = transfer.totalBytes > 0 ? Math.min(100, transfer.doneBytes / transfer.totalBytes * 100) : 100;
        const current = transfer.fileSize > 0 ? Math.min(100, transfer.fileBytes / transfer.fileSize * 100) : 100;
        const elapsedSeconds = Math.max(0.25, (Date.now() - transfer.startedAt) / 1000);
        const bytesPerSecond = transfer.doneBytes / elapsedSeconds;
        return (
          <div style={transferBoxStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span>{transfer.direction === 'delete' ? '🗑' : transfer.direction === 'pull' ? '⬇' : '⬆'}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={transfer.rel}>
                {transfer.direction === 'delete' ? '删除执行端' : transfer.direction === 'pull' ? '下载' : '上传'} {transfer.direction !== 'delete' && transfer.fileIndex + '/' + transfer.fileCount} · {transfer.rel}
              </span>
              <span style={{ color: 'var(--theme-text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {formatBytes(transfer.fileBytes)} / {formatBytes(transfer.fileSize)}
                {transfer.doneBytes > 0 ? ` · ${formatBytes(bytesPerSecond)}/s` : ''}
                {transfer.activeCount > 1 ? ` · ×${transfer.activeCount}` : ''}
              </span>
              <button style={transferCancelStyle} disabled={transfer.direction === 'delete'} onClick={() => {
                const job = fileTransfers.active(transferKey);
                if (job) fileTransfers.cancel(job);
              }}>取消</button>
            </div>
            <div style={transferTrackStyle} title={`当前文件 ${current.toFixed(1)}% · 总进度 ${overall.toFixed(1)}%`}>
              <div style={{ ...transferFillStyle, width: `${overall}%` }} />
            </div>
          </div>
        );
      })() : <div role="status" aria-live="polite" style={{ ...panelNoticeStyle,
        color: msg && !gitModalOpen ? (msg.kind === 'err' ? '#f85149' : '#3fb950') : (directoryError || gitError) ? '#f59e0b' : 'var(--theme-text-muted)',
      }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={msg && !gitModalOpen ? msg.text : panelStatusDetail}>{msg && !gitModalOpen ? msg.text : panelStatus}</span>
        {msg && !gitModalOpen && <button style={hdrIconStyle} aria-label="关闭文件面板提示" onClick={() => setMsg(null)}>✕</button>}
      </div>}
      </div>

      {/* 固定两行 Git 槽：检测/状态未就绪时占位，非仓库/失败也不收缩。 */}
      <div className="ftp-git-toolbar" style={gitToolbarStyle} role="region" aria-label="Git 工作区状态" aria-busy={gitLoading}>
        <div style={gitSummaryStyle}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={gitError || (gitStatusReady ? `已暂存 ${gitStagedCount} · 未暂存 ${gitUnstagedCount} · 领先 ${gitAhead} · 落后 ${gitBehind}` : 'Git 工作区状态')}>
            {gitError || (!gitStatusReady ? (gitLoading ? 'Git 同步中…' : (gitAvailable ? 'Git 状态待同步' : '此目录未启用 Git'))
              : gitStagedCount + gitUnstagedCount === 0 ? '✓ 工作区干净'
                : `✓ ${gitStagedCount} 已暂存 · ○ ${gitUnstagedCount} 未暂存`)}
          </span>
          {gitStatusReady && <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }} title={`领先 ${gitAhead} · 落后 ${gitBehind}`}>↑{gitAhead} ↓{gitBehind}</span>}
        </div>
        <div className="ftp-action-row" style={gitActionRowStyle}>
          <button style={gitMiniBtn} disabled={gitActionDisabled || gitStagedCount + gitUnstagedCount === 0} title="暂存所有变更" onClick={handleStageAll}>📥 暂存</button>
          <button style={gitMiniBtn} disabled={gitActionDisabled || gitPulling || gitBehind === 0} onClick={handlePull}
            title="拉取远端变更">{gitPulling ? '⏳' : '⬇'} 拉取</button>
          <button style={gitMiniBtn} disabled={gitActionDisabled || gitPushing || gitAhead === 0} onClick={handlePush}
            title="推送到远端">{gitPushing ? '⏳' : '⬆'} 推送</button>
          <button style={{ ...gitMiniBtn, fontWeight: 600 }} disabled={gitActionDisabled}
            onClick={() => setGitModalOpen(true)} title="提交变更">✅ 提交</button>
        </div>
      </div>

      {/* ★ 文件树滚动区 */}
      <div className="ftp-tree-scroll" style={treeScrollStyle}>
        {searchQuery.trim() ? (
          <div role="listbox" aria-label="文件搜索结果">
            {searchError && (
              <div style={fileSearchErrorStyle} title={searchError}>⚠ {searchError}</div>
            )}
            {searchLoading && searchResults.length === 0 ? (
              <Empty text="正在搜索工作区…" />
            ) : searchResults.length === 0 ? (
              <Empty text={searchError ? '没有可用的搜索结果' : `没有匹配“${searchQuery.trim()}”的文件`} />
            ) : searchResults.map((result, index) => {
              const st = statusOf(result);
              const parent = result.rel.includes('/') ? result.rel.slice(0, result.rel.lastIndexOf('/')) : '根目录';
              return (
                <div
                  key={result.rel}
                  ref={(element) => {
                    if (element) searchResultRefs.current.set(index, element);
                    else searchResultRefs.current.delete(index);
                  }}
                  role="option"
                  aria-selected={index === searchSelectedIndex}
                  className={`ftp-row${index === searchSelectedIndex ? ' ftp-sel' : ''}`}
                  style={fileSearchResultStyle}
                  title={`${result.rel}\nEnter / 点击打开`}
                  onMouseEnter={() => setSearchSelectedIndex(index)}
                  onClick={() => {
                    setSearchSelectedIndex(index);
                    setSelected(result.rel);
                    void openPreview(result);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelected(result.rel);
                    setContextMenu({
                      x: Math.min(event.clientX, window.innerWidth - 230),
                      y: Math.min(event.clientY, window.innerHeight - 260),
                      node: result,
                    });
                  }}
                >
                  <span style={iconStyle}>{fileIcon(result, st)}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={fileSearchNameStyle}>
                      <SearchHighlightedText text={result.name} query={searchQuery} />
                    </span>
                    <span style={fileSearchPathStyle}>
                      <SearchHighlightedText text={parent} query={searchQuery} />
                    </span>
                  </span>
                  {isRemote && (
                    <span
                      style={fileSearchSourceStyle}
                      title={result.remote && result.local
                        ? '该文件在远端执行节点和本机副本中都存在'
                        : result.remote ? '来自远端执行节点' : '来自本机副本'}
                    >
                      {result.remote && result.local ? '两端' : result.remote ? '远端' : '本机'}
                    </span>
                  )}
                  {result.size > 0 && <span style={fileSearchSizeStyle}>{formatBytes(result.size)}</span>}
                </div>
              );
            })}
          </div>
        ) : renderDir('', 0)}
      </div>

      {contextMenu && (() => {
        const n = contextMenu.node;
        const gitTransferBlocked = isGitMetadataPath(n.rel) && !includeGitMetadata;
        const st = gitTransferBlocked ? null : statusOf(n);
        return (
          <div
            style={{ ...contextMenuStyle, left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {!n.isDir && !n.typeConflict && (
              <button style={contextItemStyle} onClick={() => { setContextMenu(null); openPreview(n); }}>👁️ 预览 / 编辑</button>
            )}
            {isRemote && n.remote && n.local && !n.isDir && !n.typeConflict && (
              <button style={contextItemStyle} disabled={!sessionOnline} onClick={() => {
                setContextMenu(null); void openPreview({ ...n, local: false });
              }}>查看远端（只读）</button>
            )}
            <button style={contextItemStyle} disabled={!sessionId} onClick={() => {
              if (!sessionId) return;
              setContextMenu(null);
              setTreeFocus({ external: externalFocusRequest, request: {
                requestId: --treeFocusId.current, sessionId, workingDir, relativePath: n.rel,
              } });
            }}>🎯 在文件树中定位</button>
            {n.remote && !isGitMetadataPath(n.rel) && (
              <button style={{ ...contextItemStyle, color: '#ef4444', ...((!sessionOnline || transfer) ? contextDisabledStyle : {}) }}
                disabled={!sessionOnline || !!transfer} onClick={() => void deleteRemoteEntry(n)}>
                🗑 {n.isDir ? '删除执行端目录及全部内容' : '删除执行端文件'}（保留本地副本）
              </button>
            )}
            {n.remote && (
              <button style={contextItemStyle} onClick={() => revealNode(n, 'remote')}>
                📂 {isRemote ? '在执行端文件夹中显示' : '在文件夹中显示'}
              </button>
            )}
            {isRemote && n.local && localFs && (
              <button style={contextItemStyle} onClick={() => revealNode(n, 'local')}>💻 在本机文件夹中显示</button>
            )}
            {isRemote && localFs && !gitTransferBlocked && n.remote && !n.typeConflict && (!n.local || n.isDir || st === 'differs' || st === 'conflict') && (
              <button style={{ ...contextItemStyle, ...((!sessionOnline || transfer) ? contextDisabledStyle : {}) }} disabled={!sessionOnline || !!transfer}
                onClick={() => { setContextMenu(null); pull(n); }}>⬇️ 下载到本机</button>
            )}
            {isRemote && localFs && !gitTransferBlocked && n.local && !n.typeConflict && (n.isDir || st !== 'synced') && (
              <button style={{ ...contextItemStyle, ...((!sessionOnline || transfer) ? contextDisabledStyle : {}) }} disabled={!sessionOnline || !!transfer}
                onClick={() => { setContextMenu(null); push(n); }}>⬆️ 上传到执行端</button>
            )}
            {!isTauri() && localFs && n.local && !n.isDir && (
              <button style={contextItemStyle} onClick={() => {
                setContextMenu(null);
                void exportLocalFile(localFs, n.rel, n.name).catch((error: any) => {
                  setMsg({ kind: 'err', text: `导出失败：${error?.message ?? error}` });
                });
              }}>📤 导出到设备</button>
            )}
            {gitTransferBlocked && (
              <div style={{ padding: '6px 9px', fontSize: 10, lineHeight: 1.45, color: '#f59e0b' }}>
                .git 默认不同步；可在“高级同步”中显式启用。
              </div>
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
      {stashExpanded && (
        <div className="ftp-stash-list" style={stashListStyle} aria-busy={stashesLoading}>
          {stashesLoading ? <Empty text="Stash 同步中…" /> : stashes.length === 0 ? <Empty text="没有 stash" /> : stashes.map((s, i) => (
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
          onCommitComplete={() => { void reloadAll(); void gitRefreshRef.current?.(); }}
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
        const selectedUntrackedPaths = untrackedPaths.filter((p) => gitSelected.has(p));
        const selectedAdding = selectedUntrackedPaths.some((p) => gitAddingPaths.has(p));
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
          <AppModalPortal>
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
                  {selectedUntrackedPaths.length > 0 && (
                    <button
                      style={gitBatchBtn('#3fb950')}
                      disabled={gitBatchOperating || selectedAdding}
                      onClick={() => handleAddToTracking(selectedUntrackedPaths)}
                      title={`将选中的 ${selectedUntrackedPaths.length} 个未跟踪文件一起加入版本控制`}
                    >
                      {selectedAdding ? '⏳ 加入中…' : `✓ 批量加入 (${selectedUntrackedPaths.length})`}
                    </button>
                  )}
                  <button style={gitBatchBtn('#8b949e')} disabled={gitBatchOperating || gitAddingPaths.size > 0}
                    onClick={handleBatchIgnore} title="将选中文件加入 .gitignore">🚫 忽略</button>
                  <button style={gitBatchBtn('#f85149')} disabled={gitBatchOperating || gitAddingPaths.size > 0}
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
                          勾选后可在上方批量加入版本控制
                        </span>
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
                    <div>💡 左侧多选 · ✓ 批量加入未跟踪文件 · 🚫 忽略</div>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </AppModalPortal>
        );
      })()}

      {documentHost && createPortal(<WorkbenchFileCommands key={previewScope} host={documentHost} visible={isVisible} scope={previewScope}
        connect={connectSearch} onOpen={(relativePath, line, column) => navigateRef.current({ relativePath, line, column })}
        onActivate={() => onDocumentOpen?.()} editable={!!activeDocument?.read?.editable}
        relativePath={preview?.source === 'remote' ? preview.rel : undefined} draft={activeDocument?.text}
        onEditorCommand={type => { if (!preview) return; changeDocumentView('source');
          setEditorCommand({ id: ++editorCommandId.current, relativePath: preview.rel, source: preview.source, type }); }} />, documentHost)}
      {documentHost && !preview && createPortal(<div style={{ display: 'flex', flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 24, overflow: 'auto' }}>
        <div style={{ maxWidth: 330, width: '100%', fontSize: 12, color: 'var(--theme-text-muted)' }}>
          <div style={{ display: 'inline-flex', padding: 12, borderRadius: 10, background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' }}><WorkbenchIcon name="code" size={28} /></div>
          <h3 style={{ fontSize: 16, fontWeight: 500, color: 'var(--theme-text)', margin: '18px 0 8px' }}>打开文件，开始工作</h3>
          <p style={{ lineHeight: 1.8, margin: '0 0 20px' }}>代码直接编辑，文档默认预览。文件会保留在这里，随时与右侧对话协作。</p>
          <WorkbenchButton icon="files" onClick={onBrowseFiles}>打开文件目录</WorkbenchButton>
          <div style={{ marginTop: 24, paddingTop: 14, borderTop: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>快速打开文件</span><kbd>Ctrl / ⌘ P</kbd></div>
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>搜索项目内容</span><kbd>Ctrl / ⌘ ⇧ F</kbd></div>
        </div>
      </div>, documentHost)}
      {preview && (
        <DocumentSurface host={documentHost}>
          <div style={documentHost ? { display: 'flex', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' } : pvOverlay}>
            <div style={documentHost ? { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--theme-panel-solid, var(--theme-bg))' }
              : { ...pvBox, ...(previewMaximized ? pvBoxMaximized : {}) }} onClick={(e) => e.stopPropagation()}>
            {documentHost && <div role="tablist" aria-label="打开的文件" style={{ display: 'flex', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-sidebar-solid)' }}>
              {fileTabs.map((tab, index) => <div key={tab.id} style={{ display: 'flex', flexShrink: 0, borderRight: '1px solid var(--theme-border)', borderTop: `2px solid ${tab.id === fileTabId(preview) ? 'var(--theme-accent)' : 'transparent'}` }}>
                <button role="tab" aria-selected={tab.id === fileTabId(preview)} tabIndex={tab.id === fileTabId(preview) ? 0 : -1}
                  title={`${execLabel || execKey} · ${workingDir}/${tab.rel} · ${tab.source === 'local' ? '本机副本' : '执行端'}`}
                  className="awu-wb-control" style={{ ...hdrBtnStyle, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', border: 0, borderRadius: 0, background: tab.id === fileTabId(preview) ? 'var(--theme-panel-solid)' : 'transparent' }}
                  onClick={() => selectFileTab(tab)} onKeyDown={event => {
                    const next = event.key === 'ArrowRight' ? (index + 1) % fileTabs.length : event.key === 'ArrowLeft' ? (index - 1 + fileTabs.length) % fileTabs.length : -1;
                    if (next < 0) return;
                    event.preventDefault(); selectFileTab(fileTabs[next]);
                    (event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
                  }}>
                  <WorkbenchIcon name="code" size={13} />{tab.document && documentStore.get(tab.document.key)?.dirty ? '● ' : ''}{tab.name}{tab.source === 'local' ? ' · 本机' : ''}
                </button>
                <button className="awu-wb-control" aria-label={`关闭文件 ${tab.rel}${tab.source === 'local' ? '（本机）' : ''}`} style={{ ...hdrBtnStyle, border: 0, background: 'transparent' }}
                  onClick={() => requestCloseTab(tab)}>×</button>
              </div>)}
            </div>}
            {documentHost && closingTab && <div role="alertdialog" aria-label="关闭未保存文件" style={{ padding: 12, borderBottom: '1px solid var(--theme-border)', fontSize: 12 }}>
              <p>{closingTab.rel} 尚未保存或结果待核对。保存成功才能关闭；放弃只丢弃此窗口草稿，不修改磁盘。</p>
              <button style={hdrBtnStyle} disabled={tabClosing} onClick={() => void finishCloseTab('save')}>保存并关闭</button>
              <button style={hdrBtnStyle} disabled={tabClosing} onClick={() => void finishCloseTab('discard')}>放弃草稿并关闭</button>
              <button style={hdrBtnStyle} disabled={tabClosing} onClick={() => setClosingTab(null)}>取消关闭</button>
            </div>}
            <div style={{ ...pvHeader, ...(documentHost ? { height: 38, minHeight: 38, padding: '0 8px', gap: 6, overflowX: 'auto' } : {}) }}>
              {!documentHost && <span style={{ fontSize: 13 }}>{preview.isImage ? '🖼️' : preview.renderer === 'pdf' ? '📕' : preview.renderer === 'docx' ? '📘' : preview.renderer === 'drawio' ? '🧩' : preview.structured ? '📊' : editing ? '✏️' : '📄'}</span>}
              <span style={{ fontWeight: documentHost ? 400 : 600, fontSize: documentHost ? 11 : 13, minWidth: 35, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: documentHost ? 'var(--theme-text-muted)' : undefined }} title={`${preview.rel} · ${execLabel || execKey}`}>
                {dirty && <span style={{ color: 'var(--theme-accent)' }}>● </span>}{documentHost ? preview.rel : preview.name}
              </span>
              <span style={{ ...tagStyle, marginLeft: 0 }}>
                {documentHost ? preview.source === 'local' ? '本机副本' : '执行端' : preview.source === 'local' ? '💻 本机' : '☁️ 远端'}
              </span>
              <div style={{ flex: 1 }} />
              {!preview.loading && !(preview.source === 'local' && !isTauri()) && (
                <button style={hdrBtnStyle} onClick={revealPreview} title="在系统文件管理器中定位">📂 定位</button>
              )}
              {!preview.loading && preview.source === 'local' && !isTauri() && (
                <button style={hdrBtnStyle} onClick={exportPreview} title="保存到平板文件 App 或调用系统分享">📤 导出</button>
              )}
              {!editing && !preview.loading && !preview.error && (
                PROV_IMAGE_EXTS.has(extOf(preview.name)) || PROV_TEXT_EXTS.has(extOf(preview.name))
              ) && (
                <button
                  style={{ ...hdrBtnStyle, borderColor: 'color-mix(in srgb, var(--theme-accent) 45%, var(--theme-border))', color: 'var(--theme-accent)' }}
                  disabled={reviewOpening}
                  onClick={() => void openReview(preview.rel, preview.source)}
                  title="创建或继续编辑与源文件强关联的 .prov 审阅稿"
                >{reviewOpening ? '打开中…' : '✦ 审阅'}</button>
              )}
              {!editing && preview.isMarkdown && !preview.loading && !preview.error && (
                <button
                  style={{
                    ...hdrBtnStyle,
                    borderColor: 'rgba(63,185,80,.38)',
                    color: htmlExported ? '#3fb950' : 'var(--theme-text)',
                  }}
                  disabled={htmlExporting || preview.truncated}
                  onClick={() => void exportPreviewAsHtml()}
                  title={preview.truncated
                    ? '当前预览已截断，不能导出不完整的 HTML'
                    : '将当前 Markdown 转换为带样式的独立 HTML，并选择保存位置'}
                >
                  {htmlExporting ? '⏳ 转换中…' : htmlExported ? '✓ 已保存' : '⇩ HTML 另存为'}
                </button>
              )}
              {documentHost && (preview.isMarkdown || preview.isHtml) && <div role="group" aria-label="文档显示方式" style={{ display: 'flex' }}>
                {(['preview', 'source', 'split'] as const).map(view => <button key={view} style={{ ...hdrBtnStyle, color: documentView === view ? 'var(--theme-accent)' : undefined }}
                  aria-pressed={documentView === view} onClick={() => changeDocumentView(view)}>{view === 'preview' ? '预览' : view === 'source' ? '源码' : '并排'}</button>)}
              </div>}
              {!documentHost && !editing && (preview.isMarkdown || preview.isHtml) && !preview.loading && !preview.error && (
                <div style={{ display: 'flex', flexShrink: 0, border: '1px solid var(--theme-border)', borderRadius: 6, overflow: 'hidden', marginRight: 4 }}>
                  <button style={{ ...segBtnStyle, ...(!mdRaw ? segActiveStyle : {}) }} onClick={() => setMdRaw(false)}>{preview.isHtml ? '🌐 页面' : '👁 预览'}</button>
                  <button style={{ ...segBtnStyle, ...(mdRaw ? segActiveStyle : {}) }} onClick={() => setMdRaw(true)}>{'</> 源码'}</button>
                </div>
              )}
              {isRemote && preview.source === 'remote' && !preview.loading && !preview.error && <>
                {localManifest?.[preview.rel] ? <button style={hdrBtnStyle} onClick={() => void openPreview({ rel: preview.rel, name: preview.name, isDir: false, size: 0, local: true })}>打开本机副本</button>
                  : <button style={hdrBtnStyle} disabled={!sessionOnline || !!transfer || localRestoring} onClick={async () => {
                    if (!localFs) { await chooseLocal(); return; }
                    const source = preview, scope = previewScopeRef.current, request = previewRequestRef.current;
                    const downloaded = await pull({ rel: source.rel, name: source.name, isDir: false, size: 0, remote: true });
                    if (downloaded && mountedRef.current && previewScopeRef.current === scope && previewRequestRef.current === request)
                      await openPreview({ rel: source.rel, name: source.name, isDir: false, size: 0, local: true });
                  }}>{localFs ? '下载到本机并打开' : '选择本机副本目录'}</button>}
              </>}
              {!documentHost && !editing && !(isRemote && preview.source === 'remote') && !preview.isImage && !preview.structured && !preview.renderer && !preview.loading && !preview.error && (
                <button style={hdrBtnStyle} onClick={() => void startEdit()} disabled={editOpening}>{editOpening ? '完整读取中…' : '✏️ 编辑'}</button>
              )}
              {(documentHost ? !!activeDocument?.read?.editable : editing) && (
                <>
                  <WorkbenchOverflow enabled={!!documentHost} label="文件与草稿操作">
                  <button style={hdrBtnStyle} onClick={() => void exportGeneratedText(editText, `${preview.name}.draft.txt`, 'text/plain;charset=utf-8').catch(error =>
                    setMsg({ kind: 'err', text: `导出失败：${error?.message || error}` }))}>导出草稿</button>
                  <button style={hdrBtnStyle} disabled={saving || needsSaveCheck} onClick={async () => {
                    if (!editingDocument || !activeDocument || !window.confirm('放弃本窗口此文件草稿及编辑历史？不会修改磁盘文件。')) return;
                    try {
                      await documentDrafts.discard(activeDocument.key);
                      await documentStore.open(editingDocument.client, activeDocument.identity.relativePath);
                    } catch (error: any) { setMsg({ kind: 'err', text: `未放弃草稿：${error?.message || error}` }); }
                  }}>放弃草稿</button>
                  <button style={hdrBtnStyle} onClick={() => void compareDocument()} disabled={saving}>比较 / 合并</button>
                  <button style={hdrBtnStyle} onClick={() => void saveAllEdits()} disabled={batchSaving || saving}
                    title="只保存当前执行端或本机副本中已打开的脏文档；逐文件报告结果（Ctrl+Shift+S）">{batchSaving ? '逐文件保存中…' : '保存此来源全部'}</button>
                  </WorkbenchOverflow>
                  <button style={{ ...hdrBtnStyle, ...(dirty && !saving ? { borderColor: 'var(--theme-accent)', color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)' } : { opacity: 0.5 }) }}
                    onClick={saveEdit} disabled={saving || (!dirty && !needsSaveCheck) || !activeDocument?.read?.canSave}>{saving ? '保存中…' : needsSaveCheck ? '核对保存' : documentHost ? '保存' : '💾 保存'}</button>
                  {!documentHost && <button style={hdrBtnStyle} onClick={() => {
                    setEditing(false);
                  }}>预览（保留草稿）</button>}
                </>
              )}
              {!documentHost && <button style={hdrBtnStyle} onClick={() => setPreviewMaximized((value) => !value)} title={previewMaximized ? '退出最大化（Esc）' : '最大化预览'}>
                {previewMaximized ? '🗗 还原' : '⛶ 最大化'}
              </button>}
              {!documentHost && <button style={hdrBtnStyle} onClick={closePreview} title="关闭预览" aria-label="关闭预览">✕</button>}
            </div>
            <div style={{ ...pvBody, ...(documentHost ? { display: 'flex', flexDirection: 'column' as const } : {}) }}>
              {isRemote && preview.source === 'remote' && <div role="status" style={{ padding: '6px 10px', fontSize: 11, color: 'var(--theme-text-muted)', borderBottom: '1px solid var(--theme-border)' }}>
                远端文件 · 只读。下载到本机副本后编辑，保存不会自动上传。
                {activeDocument?.dirty && <button style={hdrBtnStyle} onClick={() => void exportGeneratedText(editText, `${preview.name}.draft.txt`, 'text/plain;charset=utf-8').catch(error => setMsg({ kind: 'err', text: `导出失败：${error}` }))}>导出历史远端草稿</button>}
              </div>}
              {languageEditor.panel}
              {documentHost && editOpening && <div role="status" style={{ padding: 8, fontSize: 12 }}>正在核对完整内容与编辑能力…</div>}
              {documentHost && editNotice && <div role="status" style={{ padding: 8, fontSize: 12, color: '#fbbf24' }}>{editNotice}</div>}
              {(editing || documentHost) && activeDocument && draftChoices?.key === activeDocument.key && draftChoices.rows.length > 0 && (
                <div role="status" style={{ padding: 12, fontSize: 12 }}>发现保留的窗口草稿，请选择恢复（不会保存文件）：
                  {draftChoices.rows.map(row => <button key={row.id} style={hdrBtnStyle} onClick={async () => {
                    try { await documentDrafts.restore(activeDocument.key, row, () => mountedRef.current
                      && previewScopeRef.current === previewScope && getCurrentUserProfile().userId === documentOwner); setDraftChoices(null); }
                    catch (error: any) { setMsg({ kind: 'err', text: `无法恢复：${error?.message || error}` }); }
                  }}>{new Date(row.updatedAt).toLocaleString()} · {row.branch.slice(0, 8)}</button>)}
                </div>
              )}
              {(editing || documentHost) && batchResults?.scope === previewScope && (
                <details open style={{ padding: '6px 12px', fontSize: 12 }}><summary>逐文件保存结果（非整体事务）</summary>
                  {batchResults.rows.map(row => <div key={row.name}>{row.name}：{row.status}</div>)}
                </details>
              )}
              {(editing || documentHost) && activeDocument && comparison?.key === activeDocument.key && activeDocument.disk && (
                <section aria-label="基线磁盘草稿比较" style={{ padding: 12, borderBottom: '1px solid var(--theme-border)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                    {[['原基线', activeDocument.baseText], ['磁盘版本', activeDocument.disk.text], ['当前草稿', activeDocument.text]].map(([label, value]) => (
                      <label key={label} style={{ minWidth: 0, fontSize: 12 }}>{label}<textarea aria-label={label} readOnly value={value} rows={6}
                        style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }} /></label>
                    ))}
                  </div>
                  <label style={{ display: 'block', fontSize: 12 }}>合并结果（仅修改草稿，不自动保存）
                    <textarea aria-label="合并结果（仅修改草稿，不自动保存）" value={comparison.text} rows={6} onChange={event => setComparison({ ...comparison, text: event.target.value })}
                      style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
                  </label>
                  <button style={hdrBtnStyle} disabled={saving || needsSaveCheck || !activeDocument.disk.editable} onClick={() => {
                    try { documentStore.merge(activeDocument.key, comparison.diskVersion, comparison.revision, comparison.text); setComparison(null); }
                    catch (error: any) { setMsg({ kind: 'err', text: `合并未应用：${error?.message || error}，请重新比较。` }); }
                  }}>采用合并并更新基线</button>
                  <button style={hdrBtnStyle} onClick={() => setComparison(null)}>取消合并</button>
                </section>
              )}
              {(editing || documentHost) && activeDocument && (
                <div role="status" style={{ padding: '5px 10px', fontSize: 11, flexShrink: 0, order: documentHost ? 1 : undefined,
                  color: activeDocument.error || !activeDocument.read?.editable ? 'var(--theme-error)' : 'var(--theme-text-muted)',
                  borderTop: documentHost ? '1px solid var(--theme-border)' : undefined, borderBottom: documentHost ? undefined : '1px solid var(--theme-border)' }}>
                  {activeDocument.identity.source === 'local-copy' ? '本机副本 · 保存不上传' : '执行端文件'}
                  {' · '}{activeDocument.read?.encoding || '未知编码'}{' · '}{activeDocument.read?.eol || '未知换行'}
                  {!activeDocument.read?.editable && ` · ${activeDocument.read?.reasonCode === 'remote_readonly' ? '远端只读，请下载到本机编辑' : `只读：${activeDocument.read?.reasonCode || '完整性未确认'}`}`}
                  {activeDocument.identity.source === 'local-copy' && activeDocument.read?.eol === 'mixed' && ' · 混合换行，按行保留（新增行沿用邻近格式）'}
                  {activeDocument.error && ` · ${activeDocument.error}（草稿已保留）`}
                  {needsSaveCheck && ' · 结果未知，请核对保存；不会自动重试写入'}
                  {!dirty && activeDocument.persistence === 'failed' && ` · 草稿存储/恢复不可用：${activeDocument.persistenceError || '未知原因'}`}
                  {dirty && ` · ${activeDocument.persistence === 'saved' ? '草稿已存本设备（未加密）'
                    : activeDocument.persistence === 'pending' ? '草稿持久化中，退出前请等待'
                    : activeDocument.persistence === 'restored' ? '已恢复草稿，未保存文件'
                    : '草稿持久化不可用，请保存或导出；刷新可能丢失'}`}
                </div>
              )}
              {preview.loading ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>{preview.loadingText || '加载中…'}</div>
              ) : preview.error ? (
                <div style={{ padding: 24, color: '#f87171', fontSize: 13 }}>⚠ {preview.error}</div>
              ) : documentHost && !preview.isImage && !preview.structured && !preview.renderer ? (
                activeDocument?.read?.reasonCode === 'binary' ? <p style={{ padding: 16 }}>二进制文件只读；不提供通用文本编辑或保存。</p> :
                <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
                  <div hidden={documentView === 'preview'} aria-label="文档源码" style={{ display: documentView === 'preview' ? 'none' : 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>{editorElement}</div>
                  {!!engineRichPreview && <div hidden={documentView === 'source'} aria-label="文档预览" style={{ display: documentView === 'source' ? 'none' : 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', borderLeft: documentView === 'split' ? '1px solid var(--theme-border)' : undefined }}>{engineRichPreview}</div>}
                </div>
              ) : editing ? (
                <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)' }}>编辑器加载中…</div>}>
                  <CodeEditor key={activeDocument?.lifecycleId} documentKey={activeDocument?.key} value={editText}
                    language={languageEditor.binding}
                    ext={extOf(preview.name)} dark={isDarkTheme()} readOnly={!activeDocument?.read?.editable}
                    editorState={activeDocument?.editor as EditorDocumentState | undefined}
                    onEditorState={state => { if (activeDocument) documentStore.editorState(activeDocument.key, state, activeDocument.lifecycleId); }}
                    onChange={value => { if (activeDocument) documentStore.edit(activeDocument.key, value); }} onSave={saveEdit} onSaveAll={saveAllEdits} />
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
              ) : preview.isHtml ? (
                <>
                  <Suspense fallback={<div style={{ padding: 24 }}>HTML 浏览器预览加载中…</div>}>
                    <HtmlPreview source={preview.text || ''} rel={preview.rel} fragment={preview.htmlFragment}
                      root={preview.source === 'local' ? localFs?.label() || '本机副本' : workingDir}
                      nodeLabel={preview.source === 'local' ? '本机副本' : execLabel || (isTauri() && execMode !== 'relay' ? '本机执行节点' : '会话执行节点')}
                      hidden={mdRaw} readFile={readHtmlResource} onNavigate={navigateHtmlResource} onReveal={revealPreview} />
                  </Suspense>
                  {mdRaw && <pre className="md-pre" style={pvPre}><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(preview.text || '', 'html') }} /></pre>}
                </>
              ) : preview.isMarkdown && !mdRaw ? (
                <MarkdownPreview
                  key={`${preview.rel}:${preview.source}`}
                  source={preview.text || ''}
                  title={preview.name}
                  initialDark={isDarkTheme()}
                />
              ) : (
                <pre className="md-pre" style={pvPre}>
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(preview.text || '', extOf(preview.name)) }} />
                </pre>
              )}
            </div>
            </div>
          </div>
        </DocumentSurface>
      )}

      {review && (
        <Suspense fallback={(
          <AppModalPortal>
            <div style={{ ...pvOverlay, zIndex: 10120, color: 'var(--theme-text)' }}>审阅工作台加载中…</div>
          </AppModalPortal>
        )}>
          <ReviewWorkbench
            key={`${review.provPath}:${review.document.review.revision}`}
            initial={review}
            workingDir={workingDir}
            execKey={execKey}
            sessionId={sessionId}
            onAttentionChange={setReviewAttention}
            onClose={() => { setReview(null); setReviewAttention(null); }}
            onSaved={() => { void reloadAll(); }}
          />
        </Suspense>
      )}

      {/* \u2605 Git Diff \u72ec\u7acb\u9762\u677f */}
      {diffPanelOpen && (
        <AppModalPortal>
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
        </AppModalPortal>
      )}
    </div>
    </WorkbenchInteractionContext.Provider>
  );
});

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
  overflowX: 'auto',
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
  minHeight: 0, minWidth: 0,
  background: 'var(--theme-bg-secondary, #1e1e1e)',
  color: 'var(--theme-text, #c9d1d9)',
  fontSize: 12, overflow: 'hidden',
};

const skeletonStyle: React.CSSProperties = {
  display: 'inline-block', flexShrink: 0, borderRadius: 3,
  background: 'var(--theme-border, rgba(127,127,127,.18))', opacity: .55,
};
const statusSlotStyle: React.CSSProperties = {
  height: 38, flexShrink: 0, minWidth: 0, overflow: 'hidden',
  display: 'flex', flexDirection: 'column', justifyContent: 'center',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,.08))',
  boxSizing: 'border-box',
};
const panelNoticeStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, minWidth: 0,
  padding: '0 10px', fontSize: 10.5,
};

const topBarStyle: React.CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center',
  height: 34, boxSizing: 'border-box', padding: '5px 10px', flexShrink: 0, overflow: 'hidden',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const fileSearchBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
  minHeight: 31, padding: '4px 8px',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  background: 'var(--theme-bg-secondary, #1e1e1e)',
};

const fileSearchInputStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 23, padding: '2px 5px',
  border: '1px solid var(--theme-border, rgba(255,255,255,.14))', borderRadius: 3,
  outline: 'none', background: 'var(--theme-input-bg, rgba(255,255,255,.04))',
  color: 'var(--theme-text, #c9d1d9)', font: '11px/1.4 inherit',
};

const fileSearchMetaStyle: React.CSSProperties = {
  flexShrink: 0, maxWidth: 58, overflow: 'hidden', textOverflow: 'ellipsis',
  color: 'var(--theme-text-muted)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums',
};

const fileSearchClearStyle: React.CSSProperties = {
  width: 19, height: 19, padding: 0, flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 0, borderRadius: 3, background: 'transparent',
  color: 'var(--theme-text-muted)', fontSize: 15, cursor: 'pointer',
};

const fileSearchResultStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', minHeight: 34, padding: '3px 8px', gap: 5,
  cursor: 'pointer', userSelect: 'none', borderRadius: 3,
};

const fileSearchNameStyle: React.CSSProperties = {
  display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: 'var(--theme-text)', fontSize: 11.5, lineHeight: 1.25,
};

const fileSearchPathStyle: React.CSSProperties = {
  display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: 'var(--theme-text-muted)', fontSize: 9.5, lineHeight: 1.2,
};

const fileSearchSizeStyle: React.CSSProperties = {
  flexShrink: 0, color: 'var(--theme-text-muted)', fontSize: 9,
  fontVariantNumeric: 'tabular-nums', opacity: .8,
};

const fileSearchSourceStyle: React.CSSProperties = {
  flexShrink: 0, padding: '1px 4px', borderRadius: 3,
  color: 'var(--theme-text-muted)', background: 'var(--theme-hover, rgba(255,255,255,.06))',
  fontSize: 9, lineHeight: 1.3,
};

const fileSearchErrorStyle: React.CSSProperties = {
  padding: '5px 9px', color: '#f59e0b', background: 'rgba(245,158,11,.07)',
  borderBottom: '1px solid rgba(245,158,11,.16)', fontSize: 10,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const searchHighlightStyle: React.CSSProperties = {
  padding: 0, background: 'transparent', color: 'var(--theme-accent, #58a6ff)',
  fontWeight: 700,
};

const headerIdentityStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  flex: 1, minWidth: 0, maxWidth: '100%', overflow: 'hidden',
};

const headerTitleStyle: React.CSSProperties = {
  fontWeight: 700, fontSize: 11, letterSpacing: 0.35,
  textTransform: 'uppercase', color: 'var(--theme-text)',
  whiteSpace: 'nowrap', flexShrink: 0,
};

const headerActionsStyle: React.CSSProperties = {
  position: 'absolute', zIndex: 2, top: 5, right: 6,
  height: 24, display: 'flex', alignItems: 'center', gap: 1,
  paddingLeft: 12,
  background: 'linear-gradient(90deg, transparent 0, var(--theme-bg-secondary, #1e1e1e) 12px)',
};

const localDirBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', flexShrink: 0,
  height: 28, boxSizing: 'border-box', overflow: 'hidden', minWidth: 0,
  background: 'var(--theme-bg-tertiary, rgba(255,255,255,0.025))',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const localActionsStyle: React.CSSProperties = {
  ...localDirBarStyle, height: 32, gap: 5, padding: '3px 8px',
  overflowX: 'auto', overflowY: 'hidden',
};

const syncAdvancedStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '4px 10px',
  background: 'var(--theme-bg-tertiary, rgba(255,255,255,0.02))',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  fontSize: 10,
};
const syncAdvancedSummaryStyle: React.CSSProperties = {
  cursor: 'pointer', color: 'var(--theme-text-muted)', userSelect: 'none',
};
const syncAdvancedOptionStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 7, marginTop: 7, padding: '7px 8px',
  border: '1px solid rgba(245,158,11,.28)', background: 'rgba(245,158,11,.06)',
  color: 'var(--theme-text)', cursor: 'pointer',
};
const gitExcludedBadgeStyle: React.CSSProperties = {
  flexShrink: 0, marginLeft: 4, padding: '1px 5px', fontSize: 8.5,
  border: '1px solid rgba(148,163,184,.28)', color: 'var(--theme-text-muted)',
  background: 'rgba(148,163,184,.07)',
};

const transferBoxStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, padding: '3px 10px', flexShrink: 0, minWidth: 0,
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
  minWidth: 0, maxWidth: 100, flexShrink: 1,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const gitBranchBadgeStyle: React.CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(63,185,80,0.12)', color: '#3fb950',
  border: '1px solid rgba(63,185,80,0.25)', marginLeft: 4,
  minWidth: 0, maxWidth: 110, flexShrink: 1,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const hdrIconStyle: React.CSSProperties = {
  width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', color: 'var(--theme-text-muted, #8b949e)',
  cursor: 'pointer', borderRadius: 4, fontSize: 13, flexShrink: 0,
};

const gitToolbarStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: 56, flexShrink: 0,
  minWidth: 0, overflow: 'hidden', boxSizing: 'border-box', padding: '3px 8px',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const gitSummaryStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, height: 22,
  flexShrink: 0, minWidth: 0, color: 'var(--theme-text-muted)', fontSize: 10.5,
};
const gitActionRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, height: 27, minWidth: 0,
  overflowX: 'auto', overflowY: 'hidden', flexShrink: 0,
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

const syncFreshnessBadgeStyle: React.CSSProperties = {
  flexShrink: 0,
  maxWidth: 230,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 9.5,
  fontVariantNumeric: 'tabular-nums',
  padding: '1px 4px',
  borderRadius: 3,
  background: 'var(--theme-bg-tertiary, rgba(255,255,255,.045))',
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
  height: 112, flexShrink: 0, overflow: 'auto',
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
