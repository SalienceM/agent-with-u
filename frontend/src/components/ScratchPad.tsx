/**
 * ScratchPad — 全局临时记事本
 *
 * 模式：
 *   sidebar  - 嵌入主界面右侧（共屏）
 *   window   - 独立弹出窗口（?scratchpad=1）
 *
 * 功能：
 *   - 标题、搜索、置顶、颜色、归档与克隆
 *   - 可勾选待办清单与完成进度
 *   - 文本 + 图片（Ctrl+V）交替内联块
 *   - 图片出现在光标位置
 *   - 复制全部（text/html + 内联图片 base64）
 *   - 跨窗口 localStorage 同步
 *   - 弹出为独立窗口
 */
import React, {
  useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo,
} from 'react';
import {
  filterScratchEntries,
  normalizeScratchEntries,
  scratchEntryPreview,
  scratchTodoStats,
  sortScratchEntries,
  type ScratchBlock,
  type ScratchColor,
  type ScratchEntry,
  type ScratchTodo,
} from '../utils/scratchPad';

interface NotePalette {
  label: string;
  shell: string;
  side: string;
  editor: string;
  header: string;
  accent: string;
  active: string;
  border: string;
}

const NOTE_PALETTES: Record<ScratchColor, NotePalette> = {
  yellow: {
    label: '经典黄', shell: '#fff9c4', side: '#fef3c7', editor: '#fffde7',
    header: '#fbbf24', accent: '#d97706', active: 'rgba(215,119,6,0.18)',
    border: 'rgba(180,120,20,0.25)',
  },
  rose: {
    label: '珊瑚粉', shell: '#fff1f2', side: '#ffe4e6', editor: '#fff7f7',
    header: '#fda4af', accent: '#e11d48', active: 'rgba(225,29,72,0.13)',
    border: 'rgba(190,24,93,0.2)',
  },
  mint: {
    label: '薄荷绿', shell: '#ecfdf5', side: '#d1fae5', editor: '#f3fff9',
    header: '#86efac', accent: '#15803d', active: 'rgba(21,128,61,0.13)',
    border: 'rgba(22,101,52,0.2)',
  },
  sky: {
    label: '晴空蓝', shell: '#f0f9ff', side: '#e0f2fe', editor: '#f7fcff',
    header: '#7dd3fc', accent: '#0369a1', active: 'rgba(3,105,161,0.13)',
    border: 'rgba(3,105,161,0.2)',
  },
  lavender: {
    label: '薰衣紫', shell: '#faf5ff', side: '#f3e8ff', editor: '#fdfaff',
    header: '#c4b5fd', accent: '#7e22ce', active: 'rgba(126,34,206,0.12)',
    border: 'rgba(126,34,206,0.2)',
  },
  slate: {
    label: '雾灰', shell: '#f8fafc', side: '#e2e8f0', editor: '#ffffff',
    header: '#cbd5e1', accent: '#475569', active: 'rgba(71,85,105,0.13)',
    border: 'rgba(71,85,105,0.22)',
  },
};

// ── 注入编辑器全局样式（一次即可）──────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('scratch-editor-style')) {
  const s = document.createElement('style');
  s.id = 'scratch-editor-style';
  s.textContent = `
    .scratch-ta::placeholder { color: #c4a35a; }
    .scratch-ta:focus { outline: none; }
  `;
  document.head.appendChild(s);
}

const STORAGE_KEY = 'agent-with-u:scratchpad';
const WINDOW_PIN_KEY = 'agent-with-u:scratchpad:window-always-on-top';
let _bc = 0;
const bid = () => `b${Date.now()}-${++_bc}`;
const eid = () => `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const emptyEntry = (): ScratchEntry => ({
  id: eid(), createdAt: Date.now(), updatedAt: Date.now(),
  title: '', color: 'yellow', pinned: false, archived: false, todos: [],
  blocks: [{ type: 'text', id: bid(), content: '' }],
});
const load = (): ScratchEntry[] => {
  try {
    return normalizeScratchEntries(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch { return []; }
};
const persist = (entries: ScratchEntry[]) => {
  // Strip image data (stored in IndexedDB) to keep localStorage small
  const stripped = entries.map(e => ({
    ...e,
    blocks: e.blocks.map(b =>
      b.type === 'image' ? { ...b, src: '' } : b
    ),
  }));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped)); } catch {}
};
const loadWindowPinned = (): boolean => {
  try { return localStorage.getItem(WINDOW_PIN_KEY) === '1'; } catch { return false; }
};
const persistWindowPinned = (pinned: boolean): void => {
  try { localStorage.setItem(WINDOW_PIN_KEY, pinned ? '1' : '0'); } catch {}
};

// ── IndexedDB 图片存储（突破 localStorage 5MB 限制）──────────────────
const IDB_NAME = 'agent-with-u-scratch-images';
const IDB_STORE = 'images';

function openImageDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(id: string, src: string): Promise<void> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(src, id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(id: string): Promise<string | undefined> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbDelete(id: string): Promise<void> {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function hydrateImages(entries: ScratchEntry[]): Promise<ScratchEntry[]> {
  const result: ScratchEntry[] = [];
  for (const e of entries) {
    const blocks: ScratchBlock[] = [];
    for (const b of e.blocks) {
      if (b.type === 'image') {
        if (b.src) {
          // Legacy: full data URL in localStorage — migrate to IndexedDB
          await idbPut(b.id, b.src).catch(() => {});
          blocks.push(b);
        } else {
          const src = await idbGet(b.id).catch(() => undefined);
          if (src) blocks.push({ ...b, src });
        }
      } else {
        blocks.push(b);
      }
    }
    const merged: ScratchBlock[] = [];
    for (const b of blocks) {
      const last = merged[merged.length - 1];
      if (last?.type === 'text' && b.type === 'text') {
        merged[merged.length - 1] = { ...last, content: last.content + b.content };
      } else {
        merged.push(b);
      }
    }
    if (merged.length === 0) merged.push({ type: 'text', id: bid(), content: '' });
    result.push({ ...e, blocks: merged });
  }
  return result;
}

// ── 时间格式 ─────────────────────────────────────────────────────────
const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts: number) => {
  const d = new Date(ts), t = new Date(), y = new Date(t);
  y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return '今天';
  if (d.toDateString() === y.toDateString()) return '昨天';
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
};
const fmtFull = (ts: number) =>
  new Date(ts).toLocaleString([], {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
const groupEntries = (entries: ScratchEntry[]) => {
  const sorted = sortScratchEntries(entries);
  const map = new Map<string, ScratchEntry[]>();
  const pinned = sorted.filter((entry) => entry.pinned);
  for (const e of sorted.filter((entry) => !entry.pinned)) {
    const k = fmtDate(e.updatedAt);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(e);
  }
  return [
    ...(pinned.length ? [{ label: '置顶', items: pinned }] : []),
    ...Array.from(map.entries()).map(([label, items]) => ({ label, items })),
  ];
};

// ── 编辑器常量 ────────────────────────────────────────────────────────
const EDITOR_LINE_H  = 22;   // px — textarea line-height（与行号栏对齐）
const EDITOR_FONT    = "'JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace";
const EDITOR_FONT_SZ = 13;
const GUTTER_W       = 44;   // px — 行号栏宽度

// ── 自动伸缩 textarea ─────────────────────────────────────────────────
const autoResize = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
};

// ── 行号 + Textarea（编辑器外观）────────────────────────────────────────
// 不换行模式下，用隐藏 <pre> 镜像测量内容宽度，再把宽度赋给 textarea，
// 让 textarea 自身不产生滚动条——滚动条统一由外层容器在底部呈现（VSCode 风格）。
interface LineNumTAProps {
  value: string;
  startLine: number;
  wrapLines: boolean;
  palette: NotePalette;
  placeholder?: string;
  taRef: (el: HTMLTextAreaElement | null) => void;
  onChange: (v: string, el: HTMLTextAreaElement) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}
const LineNumTextarea: React.FC<LineNumTAProps> = ({
  value, startLine, wrapLines, palette, placeholder, taRef, onChange, onPaste,
}) => {
  const lines = value.split('\n');
  const selfRef  = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLPreElement>(null);

  // 不换行时：同步镜像宽度 → textarea 宽度（layout 阶段，避免闪烁）
  useLayoutEffect(() => {
    const ta = selfRef.current;
    if (!ta) return;
    if (wrapLines) {
      ta.style.width = '';   // 归还给 flex:1
      return;
    }
    const w = mirrorRef.current?.scrollWidth ?? 0;
    ta.style.width = Math.max(w, 40) + 'px';
  });

  const combinedRef = useCallback((el: HTMLTextAreaElement | null) => {
    (selfRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    taRef(el);
  }, [taRef]);

  return (
    <div style={{ display: 'flex', position: 'relative', width: wrapLines ? '100%' : undefined }}>
      {/* 行号栏（sticky，横向滚动时固定在左侧） */}
      <div aria-hidden="true" style={{
        width: GUTTER_W, flexShrink: 0,
        position: 'sticky', left: 0,
        paddingRight: 8, textAlign: 'right',
        lineHeight: `${EDITOR_LINE_H}px`,
        fontSize: EDITOR_FONT_SZ - 1,
        fontFamily: EDITOR_FONT,
        color: palette.accent,
        background: palette.editor,
        zIndex: 1,
        userSelect: 'none', pointerEvents: 'none',
      }}>
        {lines.map((_, i) => (
          <div key={i} style={{ height: EDITOR_LINE_H }}>{startLine + i}</div>
        ))}
      </div>
      {/* 分割线（sticky） */}
      <div style={{
        width: 1, flexShrink: 0,
        position: 'sticky', left: GUTTER_W,
        background: palette.border, marginRight: 10,
        zIndex: 1,
      }} />
      {/* 文本区：overflow 永远 hidden，宽度由镜像决定（不换行）或 flex:1（换行） */}
      <textarea
        ref={combinedRef}
        className="scratch-ta"
        value={value}
        onChange={e => onChange(e.target.value, e.currentTarget)}
        onPaste={onPaste}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          flex: wrapLines ? 1 : undefined,
          minWidth: wrapLines ? 0 : 40,
          resize: 'none', border: 'none', outline: 'none',
          background: 'transparent', color: '#1c1917',
          fontSize: EDITOR_FONT_SZ, lineHeight: `${EDITOR_LINE_H}px`,
          fontFamily: EDITOR_FONT, padding: 0,
          minHeight: EDITOR_LINE_H, overflow: 'hidden',
          whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
          boxSizing: 'border-box', caretColor: palette.accent,
        }}
      />
      {/* 隐藏镜像：用于测量最长行的像素宽度 */}
      {!wrapLines && (
        <pre ref={mirrorRef} aria-hidden="true" style={{
          position: 'absolute', top: 0, left: GUTTER_W + 11,
          visibility: 'hidden', pointerEvents: 'none',
          whiteSpace: 'pre', fontFamily: EDITOR_FONT, fontSize: EDITOR_FONT_SZ,
          lineHeight: `${EDITOR_LINE_H}px`, margin: 0, padding: 0,
        }}>
          {/* 末尾加空格确保空内容也有宽度 */}
          {value || ' '}
        </pre>
      )}
    </div>
  );
};

// ── 复制全部：用 contentEditable + execCommand，Qt WebEngine 和浏览器均兼容 ──
function copyEntryAsHtml(entry: ScratchEntry): boolean {
  const container = document.createElement('div');
  container.setAttribute('contenteditable', 'true');
  Object.assign(container.style, {
    position: 'fixed', left: '-9999px', top: '0',
    whiteSpace: 'pre-wrap', userSelect: 'all', opacity: '0',
  });

  if (entry.title.trim()) {
    const title = document.createElement('h3');
    title.textContent = entry.title.trim();
    container.appendChild(title);
  }

  if (entry.todos.length > 0) {
    const list = document.createElement('ul');
    Object.assign(list.style, { listStyle: 'none', paddingLeft: '0' });
    for (const todo of entry.todos) {
      const item = document.createElement('li');
      item.textContent = `${todo.done ? '☑' : '☐'} ${todo.text || '未命名待办'}`;
      if (todo.done) item.style.textDecoration = 'line-through';
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  for (const b of entry.blocks) {
    if (b.type === 'text') {
      for (const line of b.content.split('\n')) {
        const p = document.createElement('p');
        if (line) p.textContent = line;
        else p.innerHTML = '<br>';
        container.appendChild(p);
      }
    } else {
      const img = document.createElement('img');
      img.src = b.src;
      Object.assign(img.style, { maxWidth: '100%', display: 'block', margin: '8px 0' });
      container.appendChild(img);
    }
  }

  document.body.appendChild(container);
  try {
    container.focus();
    const range = document.createRange();
    range.selectNodeContents(container);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const ok = document.execCommand('copy');
    sel?.removeAllRanges();
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(container);
  }
}

// ── 弹出为独立窗口（弹出后关闭侧栏，窗口由自己决定关闭）────────────────
async function popout(onClose?: () => void) {
  const url = `${location.pathname}${location.search ? location.search + '&' : '?'}scratchpad=1`;

  // Tauri 环境：使用原生 WebviewWindow（window.open 在 Tauri webview 中被拦截）
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    // 若已有便签窗口，聚焦复用
    const existing = await WebviewWindow.getByLabel('scratchpad').catch(() => null);
    if (existing) {
      await existing.setFocus().catch(() => {});
      onClose?.();
      return;
    }
    new WebviewWindow('scratchpad', {
      url,
      title: '便签本 — AgentWithU',
      width: 560,
      height: 800,
      resizable: true,
      alwaysOnTop: loadWindowPinned(),
    });
    onClose?.();
    return;
  } catch {
    // 非 Tauri 环境，降级到 window.open
  }

  const win = window.open(url, 'agent-scratchpad',
    'width=560,height=800,resizable=yes,scrollbars=yes');
  if (!win) {
    alert('浏览器阻止了弹出窗口，请允许本站弹出窗口后重试');
    return;
  }
  onClose?.();
}

/** 检测是否当前页面就是独立便签窗口 */
export const isScratchPadWindow =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('scratchpad');

// ════════════════════════════════════════════════════════════════════
//  内部：编辑区（sidebar 和 window 模式共用）
// ════════════════════════════════════════════════════════════════════
interface EditorProps {
  mode: 'sidebar' | 'window';
  onClose?: () => void;
}

const ScratchPadEditor: React.FC<EditorProps> = ({ mode, onClose }) => {
  const [entries, setEntries] = useState<ScratchEntry[]>(load);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);
  const [wrapLines, setWrapLines] = useState(false); // 默认不换行，与 Monaco 一致
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [archiveView, setArchiveView] = useState(false);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const [windowPinned, setWindowPinned] = useState(loadWindowPinned);
  const [windowPinSupported, setWindowPinSupported] = useState(false);
  const [windowPinBusy, setWindowPinBusy] = useState(false);
  const [windowPinError, setWindowPinError] = useState('');
  const taRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const todoRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const focusTarget = useRef<{ blockId: string; pos: number } | null>(null);
  const todoFocusTarget = useRef<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const colorPickerRef = useRef<HTMLDivElement>(null);

  const active = entries.find(e => e.id === activeId) ?? null;
  const palette = NOTE_PALETTES[active?.color || 'yellow'];
  const visibleEntries = useMemo(
    () => filterScratchEntries(entries, searchQuery, archiveView),
    [entries, searchQuery, archiveView],
  );
  const groups = useMemo(() => groupEntries(visibleEntries), [visibleEntries]);
  const archiveCount = entries.reduce((count, entry) => count + (entry.archived ? 1 : 0), 0);

  // 持久化
  useEffect(() => { persist(entries); }, [entries]);

  // 跨窗口同步（storage 事件只在 *其他* 窗口写入时触发）
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const fresh = load();
      setEntries(fresh);
      hydrateImages(fresh).then(hydrated => setEntries(hydrated));
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // 初始化：选中最近一条，没有则新建；异步从 IndexedDB 恢复图片
  useEffect(() => {
    const fresh = load();
    if (fresh.length > 0) {
      setEntries(fresh);
      const initial = sortScratchEntries(fresh.filter((entry) => !entry.archived))[0]
        || sortScratchEntries(fresh)[0];
      setArchiveView(Boolean(initial?.archived));
      setActiveId(initial?.id || null);
      hydrateImages(fresh).then(hydrated => setEntries(hydrated));
    } else {
      const e = emptyEntry();
      setEntries([e]);
      setActiveId(e.id);
    }
  }, []); // eslint-disable-line

  // 搜索或归档视图变化后，确保当前记录始终属于可见集合。
  useEffect(() => {
    if (activeId && visibleEntries.some((entry) => entry.id === activeId)) return;
    setActiveId(sortScratchEntries(visibleEntries)[0]?.id ?? null);
  }, [activeId, visibleEntries]);

  // focus 指定文本块
  useEffect(() => {
    if (!focusTarget.current) return;
    const { blockId, pos } = focusTarget.current;
    focusTarget.current = null;
    const ta = taRefs.current.get(blockId);
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    autoResize(ta);
  });

  useEffect(() => {
    const target = todoFocusTarget.current;
    if (!target) return;
    todoFocusTarget.current = null;
    const input = todoRefs.current.get(target);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });

  useEffect(() => {
    if (!showColors) return;
    const handler = (event: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(event.target as Node)) {
        setShowColors(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColors]);

  const handleNew = useCallback(() => {
    const e = emptyEntry();
    setEntries(prev => [e, ...prev]);
    setArchiveView(false);
    setSearchQuery('');
    setActiveId(e.id);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setEntries(prev => {
      const entry = prev.find(e => e.id === id);
      if (entry) {
        for (const b of entry.blocks) {
          if (b.type === 'image') idbDelete(b.id).catch(() => {});
        }
      }
      return prev.filter(e => e.id !== id);
    });
  }, []);

  const patchEntry = useCallback((id: string, patch: Partial<ScratchEntry>) => {
    setEntries((previous) => previous.map((entry) => (
      entry.id === id ? { ...entry, ...patch, updatedAt: Date.now() } : entry
    )));
  }, []);

  const addTodo = useCallback((entryId: string, afterTodoId?: string) => {
    const todo: ScratchTodo = { id: bid(), text: '', done: false, createdAt: Date.now() };
    todoFocusTarget.current = todo.id;
    setEntries((previous) => previous.map((entry) => {
      if (entry.id !== entryId) return entry;
      const insertAt = afterTodoId
        ? Math.max(0, entry.todos.findIndex((item) => item.id === afterTodoId) + 1)
        : entry.todos.length;
      const todos = [...entry.todos];
      todos.splice(insertAt, 0, todo);
      return { ...entry, todos, updatedAt: Date.now() };
    }));
    setHideCompleted(false);
  }, []);

  const updateTodo = useCallback((entryId: string, todoId: string, patch: Partial<ScratchTodo>) => {
    setEntries((previous) => previous.map((entry) => (
      entry.id !== entryId ? entry : {
        ...entry,
        todos: entry.todos.map((todo) => todo.id === todoId ? { ...todo, ...patch } : todo),
        updatedAt: Date.now(),
      }
    )));
  }, []);

  const removeTodo = useCallback((entryId: string, todoId: string) => {
    setEntries((previous) => previous.map((entry) => (
      entry.id !== entryId ? entry : {
        ...entry,
        todos: entry.todos.filter((todo) => todo.id !== todoId),
        updatedAt: Date.now(),
      }
    )));
  }, []);

  const clearCompletedTodos = useCallback((entryId: string) => {
    if (!window.confirm('清除这条便签中所有已完成待办？')) return;
    setEntries((previous) => previous.map((entry) => (
      entry.id !== entryId ? entry : {
        ...entry,
        todos: entry.todos.filter((todo) => !todo.done),
        updatedAt: Date.now(),
      }
    )));
  }, []);

  const handleArchive = useCallback((entry: ScratchEntry) => {
    patchEntry(entry.id, { archived: !entry.archived, pinned: false });
  }, [patchEntry]);

  const handleDuplicate = useCallback(async (source: ScratchEntry) => {
    const blocks: ScratchBlock[] = [];
    for (const block of source.blocks) {
      if (block.type === 'text') {
        blocks.push({ ...block, id: bid() });
        continue;
      }
      const imageId = bid();
      const src = block.src || await idbGet(block.id).catch(() => undefined) || '';
      if (src) await idbPut(imageId, src).catch(() => {});
      blocks.push({ type: 'image', id: imageId, src });
    }
    const now = Date.now();
    const duplicate: ScratchEntry = {
      ...source,
      id: eid(),
      title: source.title.trim() ? `${source.title.trim()}（副本）` : '',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      todos: source.todos.map((todo) => ({ ...todo, id: bid(), createdAt: now })),
      blocks,
    };
    setEntries((previous) => [duplicate, ...previous]);
    setArchiveView(false);
    setSearchQuery('');
    setActiveId(duplicate.id);
  }, []);

  const handleTextChange = useCallback((
    entryId: string, blockId: string, text: string, el: HTMLTextAreaElement,
  ) => {
    autoResize(el);
    setEntries(prev => prev.map(e =>
      e.id !== entryId ? e : {
        ...e, updatedAt: Date.now(),
        blocks: e.blocks.map(b =>
          b.type === 'text' && b.id === blockId ? { ...b, content: text } : b,
        ),
      },
    ));
  }, []);

  const insertImageAt = useCallback((
    entryId: string, blockId: string, cursorPos: number, src: string,
  ) => {
    const imgId = bid();
    const afterId = bid();
    idbPut(imgId, src).catch(() => {});
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e;
      const idx = e.blocks.findIndex(b => b.id === blockId);
      if (idx < 0) return e;
      const block = e.blocks[idx];
      if (block.type !== 'text') return e;
      const before = block.content.slice(0, cursorPos);
      const after  = block.content.slice(cursorPos);
      const imgBlock: ScratchBlock = { type: 'image', id: imgId, src };
      const afterBlock: ScratchBlock = { type: 'text', id: afterId, content: after };
      focusTarget.current = { blockId: afterBlock.id, pos: 0 };
      return {
        ...e, updatedAt: Date.now(),
        blocks: [
          ...e.blocks.slice(0, idx),
          { ...block, content: before },
          imgBlock,
          afterBlock,
          ...e.blocks.slice(idx + 1),
        ],
      };
    }));
  }, []);

  const removeImageBlock = useCallback((entryId: string, blockId: string) => {
    idbDelete(blockId).catch(() => {});
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e;
      const idx = e.blocks.findIndex(b => b.id === blockId);
      if (idx < 0) return e;
      const without = e.blocks.filter(b => b.id !== blockId);
      // 合并相邻文本块
      const merged: ScratchBlock[] = [];
      for (const b of without) {
        const last = merged[merged.length - 1];
        if (last?.type === 'text' && b.type === 'text') {
          merged[merged.length - 1] = { ...last, content: last.content + b.content };
        } else { merged.push(b); }
      }
      if (merged.length === 0) merged.push({ type: 'text', id: bid(), content: '' });
      return { ...e, blocks: merged, updatedAt: Date.now() };
    }));
  }, []);

  const handlePaste = useCallback((
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    entryId: string, blockId: string,
  ) => {
    const imgItem = Array.from(e.clipboardData.items).find(it => it.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    const cursorPos = e.currentTarget.selectionStart ?? e.currentTarget.value.length;
    const file = imgItem.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const src = ev.target?.result as string;
      if (src) insertImageAt(entryId, blockId, cursorPos, src);
    };
    reader.readAsDataURL(file);
  }, [insertImageAt]);

  const handleCopyAll = useCallback(() => {
    if (!active) return;
    const ok = copyEntryAsHtml(active);
    if (ok) {
      setCopyOk(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyOk(false), 2000);
    }
  }, [active]);

  const isWindow = mode === 'window';

  // 独立 Tauri 便签使用系统级 always-on-top；浏览器弹窗没有跨应用置顶能力。
  useEffect(() => {
    if (!isWindow || typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      const preferred = loadWindowPinned();
      await current.setAlwaysOnTop(preferred);
      const actual = await current.isAlwaysOnTop().catch(() => preferred);
      if (!cancelled) {
        setWindowPinned(actual);
        setWindowPinSupported(true);
        setWindowPinError('');
      }
    }).catch((error) => {
      if (!cancelled) setWindowPinError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [isWindow]);

  const toggleWindowPin = useCallback(async () => {
    if (!isWindow || windowPinBusy) return;
    const next = !windowPinned;
    setWindowPinBusy(true);
    setWindowPinError('');
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setAlwaysOnTop(next);
      setWindowPinned(next);
      setWindowPinSupported(true);
      persistWindowPinned(next);
    } catch (error) {
      setWindowPinError(error instanceof Error ? error.message : String(error));
    } finally {
      setWindowPinBusy(false);
    }
  }, [isWindow, windowPinBusy, windowPinned]);

  // 记录选择器下拉
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  // 当前记录标签
  const activeLabel = active
    ? `${active.pinned ? '📍 ' : ''}${scratchEntryPreview(active)} · ${fmtDate(active.updatedAt)} ${fmtTime(active.updatedAt)}`
    : '无记录';
  const activeTodoStats = active ? scratchTodoStats(active) : { total: 0, done: 0, pending: 0 };
  const activeTodos = active
    ? active.todos.filter((todo) => !hideCompleted || !todo.done)
    : [];

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: isWindow ? '100vh' : '100%',
      background: palette.shell,
      color: '#1c1917',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* 删除确认 */}
      {deleteConfirmId && (
        <div onClick={() => setDeleteConfirmId(null)} style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fffde7',
            border: '1px solid rgba(180,120,20,0.3)',
            borderRadius: 10, padding: '20px 24px', minWidth: 260,
            boxShadow: '0 8px 32px rgba(100,60,0,0.2)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1c1917', marginBottom: 8 }}>确认删除</div>
            <div style={{ fontSize: 12, color: '#78716c', marginBottom: 20, lineHeight: 1.5 }}>
              确定要删除这条便签吗？此操作不可撤销。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setDeleteConfirmId(null)}
                style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(180,120,20,0.3)', background: 'transparent', color: '#78716c', fontSize: 12, cursor: 'pointer' }}
              >取消</button>
              <button
                onClick={() => { handleDelete(deleteConfirmId); setDeleteConfirmId(null); }}
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#f85149', color: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
              >删除</button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.88)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'zoom-out',
        }}>
          <img src={lightbox} alt="preview" onClick={e => e.stopPropagation()} style={{
            maxWidth: '92vw', maxHeight: '92vh',
            borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.6)', cursor: 'default',
          }} />
          <button onClick={() => setLightbox(null)} style={{
            position: 'fixed', top: 16, right: 20,
            background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
            fontSize: 22, width: 36, height: 36, borderRadius: '50%',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>×</button>
        </div>
      )}

      {/* 标题栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px',
        borderBottom: `1px solid ${palette.border}`,
        background: palette.header,
        flexShrink: 0, minWidth: 0,
      }}>
        <span style={{ fontSize: 13, flexShrink: 0 }}>📌</span>

        {/* 侧边栏模式：紧凑下拉选择器；独立窗口模式：标题文字（左栏负责导航） */}
        {isWindow ? (
          <span style={{ fontWeight: 600, fontSize: 13, color: '#1c1917', flex: 1 }}>便签本</span>
        ) : (
          <div ref={pickerRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <button
              onClick={() => setShowPicker(v => !v)}
              title="切换记录"
              style={{
                display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                padding: '3px 7px', borderRadius: 5,
                border: `1px solid ${palette.border}`,
                background: showPicker ? palette.active : 'rgba(255,255,255,0.45)',
                color: '#78716c', fontSize: 11, cursor: 'pointer',
                textAlign: 'left', minWidth: 0,
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeLabel}
              </span>
              <span style={{ fontSize: 9, flexShrink: 0, opacity: 0.6 }}>{showPicker ? '▲' : '▼'}</span>
            </button>

            {/* 下拉列表 */}
            {showPicker && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 3,
                background: palette.shell, border: `1px solid ${palette.border}`,
                borderRadius: 7, boxShadow: '0 6px 24px rgba(100,60,0,0.18)',
                zIndex: 200, maxHeight: 280, overflowY: 'auto',
              }}>
                {visibleEntries.length === 0 ? (
                  <div style={{ padding: '14px 10px', textAlign: 'center', fontSize: 11, color: '#78716c' }}>
                    {searchQuery ? '没有匹配的便签' : archiveView ? '归档中没有便签' : '还没有记录'}
                  </div>
                ) : groups.map(({ label, items }) => (
                  <div key={label}>
                    <div style={{ padding: '5px 10px 2px', fontSize: 10, fontWeight: 700, color: '#a08050', letterSpacing: 0.4 }}>
                      {label}
                    </div>
                    {items.map(entry => {
                      const isAct = entry.id === activeId;
                      const imgCount = entry.blocks.filter(b => b.type === 'image').length;
                      const todoStats = scratchTodoStats(entry);
                      const preview = scratchEntryPreview(entry);
                      const entryPalette = NOTE_PALETTES[entry.color];
                      return (
                        <div
                          key={entry.id}
                          onClick={() => { setActiveId(entry.id); setShowPicker(false); }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '6px 10px', cursor: 'pointer',
                            background: isAct ? entryPalette.active : 'transparent',
                            borderLeft: `2px solid ${isAct ? entryPalette.accent : 'transparent'}`,
                          }}
                        >
                          <span style={{ fontSize: 10, color: isAct ? entryPalette.accent : '#78716c', flexShrink: 0 }}>
                            {entry.pinned ? '📍' : fmtTime(entry.updatedAt)}
                          </span>
                          <span style={{ fontSize: 11, color: '#1c1917', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {imgCount > 0 && <span style={{ marginRight: 3, opacity: 0.7 }}>🖼</span>}
                            {todoStats.total > 0 && <span style={{ marginRight: 3, opacity: 0.75 }}>☑{todoStats.done}/{todoStats.total}</span>}
                            {preview}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <button onClick={handleNew} title="新建便签" aria-label="新建便签" style={{ ...iconBtnStyle, color: palette.accent }}>＋</button>
        {isWindow && windowPinSupported && (
          <button
            type="button" onClick={() => void toggleWindowPin()}
            title={windowPinned ? '取消窗口始终置顶' : '让便签窗口始终位于其他窗口上方'}
            aria-label={windowPinned ? '取消窗口置顶' : '窗口置顶'}
            aria-pressed={windowPinned} disabled={windowPinBusy}
            style={{
              ...windowPinButtonStyle,
              color: windowPinned ? '#7c2d12' : '#78716c',
              borderColor: windowPinned ? palette.accent : palette.border,
              background: windowPinned ? 'rgba(255,255,255,.78)' : 'rgba(255,255,255,.36)',
              boxShadow: windowPinned ? `inset 0 -2px 0 ${palette.accent}` : 'none',
              opacity: windowPinBusy ? .65 : 1,
            }}
          >
            <span aria-hidden="true">{windowPinned ? '📌' : '📍'}</span>
            {windowPinBusy ? '设置中…' : windowPinned ? '窗口已置顶' : '窗口置顶'}
          </button>
        )}
        {!isWindow && (
          <button onClick={() => void popout(onClose)} title="弹出独立窗口" aria-label="弹出独立窗口" style={{ ...iconBtnStyle, color: palette.accent }}>⤢</button>
        )}
        {onClose && (
          <button onClick={onClose} title="关闭" aria-label="关闭便签本" style={{ ...iconBtnStyle, color: palette.accent }}>✕</button>
        )}
      </div>

      {isWindow && windowPinError && (
        <div role="alert" style={{
          padding: '5px 9px', color: '#b42318', background: '#fff1f0',
          borderBottom: `1px solid ${palette.border}`, fontSize: 10, flexShrink: 0,
        }}>
          窗口置顶设置失败：{windowPinError}
        </div>
      )}

      {/* 搜索与归档入口在侧栏和独立窗口保持一致。 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
        background: palette.side, borderBottom: `1px solid ${palette.border}`, flexShrink: 0,
      }}>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 0,
          background: 'rgba(255,255,255,0.72)', border: `1px solid ${palette.border}`,
          borderRadius: 6, padding: '4px 7px',
        }}>
          <span aria-hidden="true" style={{ fontSize: 11 }}>⌕</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            aria-label="搜索便签"
            placeholder="搜索标题、正文或待办"
            style={{
              flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent',
              color: '#1c1917', fontSize: 11,
            }}
          />
          {searchQuery && (
            <button
              type="button" onClick={() => setSearchQuery('')} title="清除搜索"
              aria-label="清除搜索" style={{ ...tinyIconButton, color: '#78716c' }}
            >×</button>
          )}
        </label>
        <button
          type="button"
          onClick={() => { setArchiveView((value) => !value); setShowPicker(false); }}
          title={archiveView ? '返回普通便签' : '查看归档'}
          aria-pressed={archiveView}
          style={{
            ...metaBtnBase, whiteSpace: 'nowrap', padding: '4px 7px',
            color: archiveView ? palette.accent : '#78716c',
            borderColor: archiveView ? palette.accent : palette.border,
            background: archiveView ? palette.active : 'rgba(255,255,255,0.45)',
          }}
        >{archiveView ? '📝 便签' : `📦 ${archiveCount}`}</button>
      </div>

      {/* 主体 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* 独立窗口模式：左侧可点选记录列（稍窄） */}
        {isWindow && (
          <div style={{
            width: 180, flexShrink: 0,
            borderRight: `1px solid ${palette.border}`,
            overflowY: 'auto', padding: '4px 0',
            background: palette.side,
          }}>
            {visibleEntries.length === 0 && (
              <div style={{ padding: '20px 8px', textAlign: 'center', fontSize: 11, color: '#78716c', lineHeight: 1.8 }}>
                {searchQuery ? '没有匹配的便签' : archiveView ? '归档中没有便签' : <>还没有记录<br />点击「＋」开始</>}
              </div>
            )}
            {groups.map(({ label, items }) => (
              <div key={label}>
                <div style={{ padding: '5px 8px 2px', fontSize: 10, fontWeight: 700, color: '#a08050', letterSpacing: 0.4 }}>
                  {label}
                </div>
                {items.map(entry => {
                  const isAct = entry.id === activeId;
                  const imgCount = entry.blocks.filter(b => b.type === 'image').length;
                  const todoStats = scratchTodoStats(entry);
                  const preview = scratchEntryPreview(entry);
                  const entryPalette = NOTE_PALETTES[entry.color];
                  return (
                    <div key={entry.id} onClick={() => setActiveId(entry.id)} style={{
                      padding: '6px 8px', cursor: 'pointer',
                      background: isAct ? entryPalette.active : 'transparent',
                      borderLeft: `2px solid ${isAct ? entryPalette.accent : 'transparent'}`,
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: isAct ? entryPalette.accent : '#78716c', marginBottom: 1 }}>
                        {entry.pinned ? '📍 置顶' : fmtTime(entry.updatedAt)}
                      </div>
                      <div style={{ fontSize: 11, color: '#1c1917', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {imgCount > 0 && <span style={{ marginRight: 3, opacity: 0.6 }}>🖼</span>}
                        {todoStats.total > 0 && <span style={{ marginRight: 3, opacity: 0.75 }}>☑{todoStats.done}/{todoStats.total}</span>}
                        {preview}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* 编辑区 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: palette.editor }}>
          {active ? (
            <>
              {/* 标题与常用动作 */}
              <div style={{
                padding: '8px 12px 5px', borderBottom: `1px solid ${palette.border}`,
                background: palette.editor, flexShrink: 0,
              }}>
                <input
                  value={active.title}
                  onChange={(event) => patchEntry(active.id, { title: event.target.value })}
                  aria-label="便签标题"
                  placeholder="标题（可选）"
                  style={{
                    display: 'block', width: '100%', boxSizing: 'border-box', border: 0,
                    outline: 0, background: 'transparent', color: '#1c1917',
                    fontSize: 16, lineHeight: '24px', fontWeight: 650, padding: '0 0 5px',
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 10, color: '#78716c', flex: '1 1 145px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    🕐 {fmtFull(active.createdAt)}
                    {active.updatedAt !== active.createdAt && <> · 改 {fmtFull(active.updatedAt)}</>}
                  </span>
                  <button
                    type="button" onClick={() => addTodo(active.id)}
                    title="添加可勾选待办" style={{
                      ...metaBtnBase, color: palette.accent, borderColor: palette.border,
                      background: palette.active,
                    }}
                  >☑ 待办</button>
                  <button
                    type="button" onClick={() => patchEntry(active.id, { pinned: !active.pinned })}
                    title={active.pinned ? '取消置顶' : '置顶便签'}
                    aria-label={active.pinned ? '取消置顶' : '置顶便签'} aria-pressed={active.pinned}
                    style={{
                      ...squareMetaButton, color: active.pinned ? palette.accent : '#78716c',
                      borderColor: active.pinned ? palette.accent : palette.border,
                      background: active.pinned ? palette.active : 'transparent',
                    }}
                  >📍</button>
                  <div ref={colorPickerRef} style={{ position: 'relative' }}>
                    <button
                      type="button" onClick={() => setShowColors((value) => !value)}
                      title="更换便签颜色" aria-label="更换便签颜色" aria-expanded={showColors}
                      style={{ ...squareMetaButton, color: palette.accent, borderColor: palette.border }}
                    >🎨</button>
                    {showColors && (
                      <div style={{
                        position: 'absolute', zIndex: 250, right: 0, top: 'calc(100% + 5px)',
                        display: 'flex', gap: 6, padding: 8, borderRadius: 8,
                        background: '#ffffff', border: `1px solid ${palette.border}`,
                        boxShadow: '0 8px 28px rgba(30,41,59,0.2)',
                      }}>
                        {(Object.keys(NOTE_PALETTES) as ScratchColor[]).map((color) => {
                          const option = NOTE_PALETTES[color];
                          return (
                            <button
                              key={color} type="button" title={option.label}
                              aria-label={`颜色：${option.label}`}
                              aria-pressed={active.color === color}
                              onClick={() => { patchEntry(active.id, { color }); setShowColors(false); }}
                              style={{
                                width: 24, height: 24, padding: 0, borderRadius: '50%', cursor: 'pointer',
                                background: option.header,
                                border: active.color === color ? `3px solid ${option.accent}` : '2px solid #fff',
                                boxShadow: `0 0 0 1px ${option.border}`,
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <button
                    type="button" onClick={() => handleArchive(active)}
                    title={active.archived ? '恢复到普通便签' : '归档便签'}
                    aria-label={active.archived ? '恢复到普通便签' : '归档便签'}
                    style={{ ...squareMetaButton, color: '#78716c', borderColor: palette.border }}
                  >{active.archived ? '↩' : '📦'}</button>
                  <button
                    type="button" onClick={() => void handleDuplicate(active)}
                    title="克隆便签" aria-label="克隆便签"
                    style={{ ...squareMetaButton, color: '#78716c', borderColor: palette.border }}
                  >⧉</button>
                  <button
                    type="button" onClick={() => setWrapLines(v => !v)}
                    title={wrapLines ? '关闭自动换行（横向可滚动）' : '开启自动换行'}
                    aria-label={wrapLines ? '关闭自动换行' : '开启自动换行'}
                    aria-pressed={wrapLines}
                    style={{
                      ...squareMetaButton,
                      color: wrapLines ? palette.accent : '#78716c',
                      borderColor: wrapLines ? palette.accent : palette.border,
                      background: wrapLines ? palette.active : 'transparent',
                      fontFamily: EDITOR_FONT, fontSize: 10,
                    }}
                  >{wrapLines ? '↵' : '→'}</button>
                  <button
                    type="button" onClick={handleCopyAll}
                    title="复制全部内容（含标题、待办和图片）"
                    aria-label="复制全部内容"
                    style={{
                      ...squareMetaButton,
                      color: copyOk ? '#15803d' : '#78716c',
                      borderColor: copyOk ? '#15803d' : palette.border,
                      background: copyOk ? 'rgba(22,163,74,0.1)' : 'transparent',
                    }}
                  >{copyOk ? '✓' : '📋'}</button>
                  <button
                    type="button" onClick={() => setDeleteConfirmId(active.id)}
                    title="删除便签" aria-label="删除便签" style={{
                      ...squareMetaButton, color: '#dc2626',
                      borderColor: 'rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.05)',
                    }}
                  >🗑</button>
                </div>
              </div>

              {/* 结构化待办清单 */}
              {active.todos.length > 0 && (
                <section aria-label="便签待办" style={{
                  maxHeight: 'min(42vh, 320px)', overflowY: 'auto', flexShrink: 0,
                  padding: '8px 12px', borderBottom: `1px solid ${palette.border}`,
                  background: palette.side,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <strong style={{ color: '#1c1917', fontSize: 12 }}>待办</strong>
                    <span style={{ color: '#78716c', fontSize: 10 }}>
                      {activeTodoStats.done}/{activeTodoStats.total} 已完成
                    </span>
                    <div style={{
                      flex: 1, minWidth: 28, height: 4, borderRadius: 4,
                      background: 'rgba(100,116,139,0.16)', overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${activeTodoStats.total ? (activeTodoStats.done / activeTodoStats.total) * 100 : 0}%`,
                        height: '100%', background: palette.accent, transition: 'width 0.18s ease',
                      }} />
                    </div>
                    {activeTodoStats.done > 0 && (
                      <button
                        type="button" onClick={() => setHideCompleted((value) => !value)}
                        style={{ ...textMetaButton, color: palette.accent }}
                      >{hideCompleted ? '显示已完成' : '隐藏已完成'}</button>
                    )}
                    {activeTodoStats.done > 0 && (
                      <button
                        type="button" onClick={() => clearCompletedTodos(active.id)}
                        style={{ ...textMetaButton, color: '#dc2626' }}
                      >清除</button>
                    )}
                  </div>
                  {activeTodos.map((todo) => (
                    <div key={todo.id} style={{
                      display: 'flex', alignItems: 'center', gap: 7, minHeight: 30,
                      borderBottom: `1px solid ${palette.border}`,
                    }}>
                      <input
                        type="checkbox" checked={todo.done}
                        onChange={(event) => updateTodo(active.id, todo.id, { done: event.target.checked })}
                        aria-label={todo.text ? `完成：${todo.text}` : '切换待办完成状态'}
                        style={{ width: 16, height: 16, margin: 0, accentColor: palette.accent, cursor: 'pointer' }}
                      />
                      <input
                        ref={(element) => {
                          if (element) todoRefs.current.set(todo.id, element);
                          else todoRefs.current.delete(todo.id);
                        }}
                        value={todo.text}
                        onChange={(event) => updateTodo(active.id, todo.id, { text: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addTodo(active.id, todo.id);
                          } else if (event.key === 'Backspace' && !todo.text) {
                            event.preventDefault();
                            removeTodo(active.id, todo.id);
                          }
                        }}
                        aria-label="待办内容"
                        placeholder="输入待办，按 Enter 新增下一项"
                        style={{
                          flex: 1, minWidth: 0, border: 0, outline: 0, padding: '5px 0',
                          background: 'transparent', color: todo.done ? '#78716c' : '#1c1917',
                          textDecoration: todo.done ? 'line-through' : 'none', fontSize: 12,
                        }}
                      />
                      <button
                        type="button" onClick={() => removeTodo(active.id, todo.id)}
                        title="删除这项待办" aria-label="删除这项待办"
                        style={{ ...tinyIconButton, color: '#b91c1c' }}
                      >×</button>
                    </div>
                  ))}
                  {activeTodos.length === 0 && hideCompleted && (
                    <div style={{ padding: '5px 0', color: '#78716c', fontSize: 11 }}>已完成项目已隐藏</div>
                  )}
                  <button
                    type="button" onClick={() => addTodo(active.id)}
                    style={{
                      marginTop: 6, padding: '4px 0', border: 0, background: 'transparent',
                      color: palette.accent, fontSize: 11, cursor: 'pointer',
                    }}
                  >＋ 添加待办</button>
                </section>
              )}

              {/* 内容块（editor 风格） */}
              <div style={{
                flex: 1, overflowY: 'auto',
                // 不换行时允许横向滚动；行号栏通过 sticky 固定在左侧
                overflowX: wrapLines ? 'hidden' : 'auto',
                padding: '12px 14px 12px 0',
                background: palette.editor,
                fontFamily: EDITOR_FONT,
              }}>
                {(() => {
                  // 计算每个 text block 的起始行号（跨 image block 连续）
                  let lineAccum = 1;
                  return active.blocks.map((block) => {
                    if (block.type === 'text') {
                      const startLine = lineAccum;
                      lineAccum += block.content.split('\n').length;
                      return (
                        <LineNumTextarea
                          key={block.id}
                           value={block.content}
                           startLine={startLine}
                           wrapLines={wrapLines}
                           palette={palette}
                          placeholder={active.blocks.length === 1
                            ? '在这里写点什么…\nCtrl+V 粘贴图片，图片将出现在光标位置'
                            : ''}
                          taRef={el => {
                            if (el) { taRefs.current.set(block.id, el); autoResize(el); }
                            else taRefs.current.delete(block.id);
                          }}
                          onChange={(v, el) => handleTextChange(active.id, block.id, v, el)}
                          onPaste={e => handlePaste(e, active.id, block.id)}
                        />
                      );
                    }
                    // image block（行号栏留空，内容区显示图片）
                    return (
                      <div key={block.id} style={{ display: 'flex' }}>
                        <div style={{ width: GUTTER_W + 1 + 10, flexShrink: 0 }} />
                        <div style={{ position: 'relative', margin: '6px 0', display: 'inline-block', maxWidth: 'calc(100% - 55px)' }}>
                          <img
                            src={block.src} alt=""
                            onClick={() => setLightbox(block.src)}
                            style={{
                              maxWidth: '100%', maxHeight: 400, display: 'block',
                              borderRadius: 6, border: `1px solid ${palette.border}`,
                              cursor: 'zoom-in',
                            }}
                          />
                          <button onClick={() => removeImageBlock(active.id, block.id)} style={{
                            position: 'absolute', top: 4, right: 4,
                            width: 20, height: 20, borderRadius: '50%',
                            border: 'none', background: 'rgba(248,81,73,0.85)', color: '#fff',
                            fontSize: 11, cursor: 'pointer', display: 'flex',
                            alignItems: 'center', justifyContent: 'center',
                          }}>✕</button>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#78716c', fontSize: 13 }}>
              <span style={{ fontSize: 32 }}>{archiveView ? '📦' : '📌'}</span>
              <span>{searchQuery ? '没有匹配的便签' : archiveView ? '归档中没有便签' : '选择一条记录或新建'}</span>
              {!archiveView && !searchQuery && (
                <button type="button" onClick={handleNew} style={{ ...metaBtnBase, color: palette.accent, borderColor: palette.border }}>
                  ＋ 新建便签
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// 标题栏图标按钮（＋ ⤢ ✕）
const iconBtnStyle: React.CSSProperties = {
  width: 24, height: 24, flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 0, border: 'none', borderRadius: 4,
  background: 'transparent', color: '#92400e',
  fontSize: 14, cursor: 'pointer', lineHeight: 1,
};

const windowPinButtonStyle: React.CSSProperties = {
  minHeight: 24,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  gap: 4, padding: '2px 8px',
  border: '1px solid', borderRadius: 5,
  fontSize: 10, fontWeight: 650,
  cursor: 'pointer', whiteSpace: 'nowrap',
};

const metaBtnBase: React.CSSProperties = {
  minHeight: 26, padding: '2px 7px', borderRadius: 5, border: '1px solid',
  fontSize: 11, cursor: 'pointer', background: 'transparent',
};

const squareMetaButton: React.CSSProperties = {
  ...metaBtnBase,
  width: 28, minWidth: 28, padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

const tinyIconButton: React.CSSProperties = {
  width: 20, height: 20, padding: 0, border: 0, borderRadius: 4,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1,
};

const textMetaButton: React.CSSProperties = {
  padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
  fontSize: 10, whiteSpace: 'nowrap',
};

// ════════════════════════════════════════════════════════════════════
//  公开：ScratchPad（侧边栏嵌入版）
// ════════════════════════════════════════════════════════════════════
interface Props {
  visible: boolean;
  onClose: () => void;
}

export const ScratchPad: React.FC<Props> = ({ visible, onClose }) => {
  if (!visible) return null;
  return <ScratchPadEditor mode="sidebar" onClose={onClose} />;
};

// ════════════════════════════════════════════════════════════════════
//  公开：ScratchPadWindow（独立窗口全屏版）
// ════════════════════════════════════════════════════════════════════
export const ScratchPadWindow: React.FC = () => {
  // 独立窗口：注入 CSS 变量（无父级 App 提供主题）
  useEffect(() => {
    document.title = '便签本 — AgentWithU';
    document.body.style.margin = '0';
    document.body.style.background = '#fff9c4';
    // 注入便签黄色主题 CSS 变量
    document.documentElement.style.setProperty('--theme-bg', '#fff9c4');
    document.documentElement.style.setProperty('--theme-bg-secondary', '#fef3c7');
    document.documentElement.style.setProperty('--theme-bg-tertiary', '#fde68a');
    document.documentElement.style.setProperty('--theme-border', 'rgba(180,120,20,0.2)');
    document.documentElement.style.setProperty('--theme-text', '#1c1917');
    document.documentElement.style.setProperty('--theme-text-muted', '#78716c');
    document.documentElement.style.setProperty('--theme-accent', '#d97706');
    document.documentElement.style.setProperty('--theme-accent-bg', 'rgba(215,119,6,0.15)');
    document.documentElement.style.setProperty('--theme-code-bg', '#fef9e7');
  }, []);
  return <ScratchPadEditor mode="window" />;
};
