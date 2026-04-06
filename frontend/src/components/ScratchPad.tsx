/**
 * ScratchPad — 全局临时记事本
 *
 * 模式：
 *   sidebar  - 嵌入主界面右侧（共屏）
 *   window   - 独立弹出窗口（?scratchpad=1）
 *
 * 功能：
 *   - 文本 + 图片（Ctrl+V）交替内联块
 *   - 图片出现在光标位置
 *   - 复制全部（text/html + 内联图片 base64）
 *   - 跨窗口 localStorage 同步
 *   - 弹出为独立窗口
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── 注入编辑器全局样式（一次即可）──────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('scratch-editor-style')) {
  const s = document.createElement('style');
  s.id = 'scratch-editor-style';
  s.textContent = `
    .scratch-ta::placeholder { color: #3d4455; }
    .scratch-ta:focus { outline: none; }
  `;
  document.head.appendChild(s);
}

// ── 数据类型 ──────────────────────────────────────────────────────────
type Block =
  | { type: 'text';  id: string; content: string }
  | { type: 'image'; id: string; src: string };

export interface ScratchEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  blocks: Block[];
}

const STORAGE_KEY = 'agent-with-u:scratchpad';
let _bc = 0;
const bid = () => `b${Date.now()}-${++_bc}`;
const eid = () => `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const emptyEntry = (): ScratchEntry => ({
  id: eid(), createdAt: Date.now(), updatedAt: Date.now(),
  blocks: [{ type: 'text', id: bid(), content: '' }],
});
const load = (): ScratchEntry[] => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
};
const persist = (entries: ScratchEntry[]) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
};

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
const groupByDate = (entries: ScratchEntry[]) => {
  const map = new Map<string, ScratchEntry[]>();
  for (const e of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const k = fmtDate(e.updatedAt);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(e);
  }
  return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
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
interface LineNumTAProps {
  value: string;
  startLine: number;
  wrapLines: boolean;
  placeholder?: string;
  taRef: (el: HTMLTextAreaElement | null) => void;
  onChange: (v: string, el: HTMLTextAreaElement) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}
const LineNumTextarea: React.FC<LineNumTAProps> = ({
  value, startLine, wrapLines, placeholder, taRef, onChange, onPaste,
}) => {
  const lines = value.split('\n');
  return (
    <div style={{ display: 'flex', position: 'relative', width: '100%' }}>
      {/* 行号栏（sticky left，横向滚动时固定不动） */}
      <div aria-hidden="true" style={{
        width: GUTTER_W, flexShrink: 0,
        position: 'sticky', left: 0,
        paddingTop: 0, paddingRight: 8,
        textAlign: 'right',
        lineHeight: `${EDITOR_LINE_H}px`,
        fontSize: EDITOR_FONT_SZ - 1,
        fontFamily: EDITOR_FONT,
        color: '#4e5568',
        background: '#0d1117',   // 与编辑区背景一致，遮住横向滚动内容
        zIndex: 1,
        userSelect: 'none',
        pointerEvents: 'none',
      }}>
        {lines.map((_, i) => (
          <div key={i} style={{ height: EDITOR_LINE_H }}>{startLine + i}</div>
        ))}
      </div>
      {/* 分割线（sticky） */}
      <div style={{
        width: 1, flexShrink: 0,
        position: 'sticky', left: GUTTER_W,
        background: 'rgba(255,255,255,0.06)', marginRight: 10,
        zIndex: 1,
      }} />
      {/* 文本区 */}
      <textarea
        ref={taRef}
        className="scratch-ta"
        value={value}
        onChange={e => onChange(e.target.value, e.currentTarget)}
        onPaste={onPaste}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          flex: 1,
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: '#cdd6f4',
          fontSize: EDITOR_FONT_SZ,
          lineHeight: `${EDITOR_LINE_H}px`,
          fontFamily: EDITOR_FONT,
          padding: 0,
          minHeight: EDITOR_LINE_H,
          // 换行模式：关闭时 pre = 不换行，横向可滚动；开启时自动换行
          whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
          overflowX: wrapLines ? 'hidden' : 'auto',
          overflowY: 'hidden',
          boxSizing: 'border-box',
          caretColor: '#7aa2f7',
        }}
      />
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
function popout(onClose?: () => void) {
  const url = `${location.pathname}${location.search ? location.search + '&' : '?'}scratchpad=1`;
  const win = window.open(url, 'agent-scratchpad',
    'width=560,height=800,resizable=yes,scrollbars=yes');
  if (!win) {
    alert('浏览器阻止了弹出窗口，请允许本站弹出窗口后重试');
    return;
  }
  // 弹出成功 → 关闭主窗口侧栏，实现"真正分离"
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
  const taRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const focusTarget = useRef<{ blockId: string; pos: number } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();

  const active = entries.find(e => e.id === activeId) ?? null;

  // 持久化
  useEffect(() => { persist(entries); }, [entries]);

  // 跨窗口同步（storage 事件只在 *其他* 窗口写入时触发）
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const fresh = load();
      setEntries(fresh);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // 初始化：选中最近一条，没有则新建
  useEffect(() => {
    const fresh = load();
    setEntries(fresh);
    if (fresh.length > 0) {
      setActiveId([...fresh].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
    } else {
      const e = emptyEntry();
      setEntries([e]);
      setActiveId(e.id);
    }
  }, []); // eslint-disable-line

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

  const handleNew = useCallback(() => {
    const e = emptyEntry();
    setEntries(prev => [e, ...prev]);
    setActiveId(e.id);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setEntries(prev => {
      const next = prev.filter(e => e.id !== id);
      if (id === activeId) {
        setActiveId([...next].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null);
      }
      return next;
    });
  }, [activeId]);

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
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e;
      const idx = e.blocks.findIndex(b => b.id === blockId);
      if (idx < 0) return e;
      const block = e.blocks[idx];
      if (block.type !== 'text') return e;
      const before = block.content.slice(0, cursorPos);
      const after  = block.content.slice(cursorPos);
      const imgBlock: Block  = { type: 'image', id: bid(), src };
      const afterBlock: Block = { type: 'text',  id: bid(), content: after };
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
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e;
      const idx = e.blocks.findIndex(b => b.id === blockId);
      if (idx < 0) return e;
      const without = e.blocks.filter(b => b.id !== blockId);
      // 合并相邻文本块
      const merged: Block[] = [];
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

  const groups = groupByDate(entries);
  const isWindow = mode === 'window';

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
    ? `${fmtDate(active.updatedAt)} ${fmtTime(active.updatedAt)}`
    : '无记录';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: isWindow ? '100vh' : '100%',
      background: 'var(--theme-bg, #1a1a2e)',
      color: 'var(--theme-text, #e0e0e0)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
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
        borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        flexShrink: 0, minWidth: 0,
      }}>
        <span style={{ fontSize: 13, flexShrink: 0 }}>📌</span>

        {/* 侧边栏模式：紧凑下拉选择器；独立窗口模式：标题文字（左栏负责导航） */}
        {isWindow ? (
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--theme-text)', flex: 1 }}>便签本</span>
        ) : (
          <div ref={pickerRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <button
              onClick={() => setShowPicker(v => !v)}
              title="切换记录"
              style={{
                display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                padding: '3px 7px', borderRadius: 5,
                border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
                background: showPicker ? 'rgba(122,162,247,0.12)' : 'rgba(255,255,255,0.04)',
                color: 'var(--theme-text-muted)', fontSize: 11, cursor: 'pointer',
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
                background: '#1e2030', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 7, boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
                zIndex: 200, maxHeight: 280, overflowY: 'auto',
              }}>
                {entries.length === 0 ? (
                  <div style={{ padding: '14px 10px', textAlign: 'center', fontSize: 11, color: 'var(--theme-text-muted)' }}>
                    还没有记录
                  </div>
                ) : groups.map(({ label, items }) => (
                  <div key={label}>
                    <div style={{ padding: '5px 10px 2px', fontSize: 10, fontWeight: 700, color: '#4e5568', letterSpacing: 0.4 }}>
                      {label}
                    </div>
                    {items.map(entry => {
                      const isAct = entry.id === activeId;
                      const textContent = entry.blocks
                        .filter(b => b.type === 'text').map(b => (b as any).content).join(' ').trim();
                      const imgCount = entry.blocks.filter(b => b.type === 'image').length;
                      const preview = textContent.split('\n')[0] || (imgCount > 0 ? '🖼' : '（空）');
                      return (
                        <div
                          key={entry.id}
                          onClick={() => { setActiveId(entry.id); setShowPicker(false); }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '6px 10px', cursor: 'pointer',
                            background: isAct ? 'rgba(122,162,247,0.15)' : 'transparent',
                            borderLeft: `2px solid ${isAct ? '#7aa2f7' : 'transparent'}`,
                          }}
                        >
                          <span style={{ fontSize: 10, color: isAct ? '#7aa2f7' : '#4e5568', flexShrink: 0 }}>
                            {fmtTime(entry.updatedAt)}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--theme-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {imgCount > 0 && <span style={{ marginRight: 3, opacity: 0.7 }}>🖼</span>}
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

        <button onClick={handleNew} title="新建" style={iconBtnStyle}>＋</button>
        {!isWindow && (
          <button onClick={() => popout(onClose)} title="弹出独立窗口" style={iconBtnStyle}>⤢</button>
        )}
        {onClose && (
          <button onClick={onClose} title="关闭" style={iconBtnStyle}>✕</button>
        )}
      </div>

      {/* 主体 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* 独立窗口模式：左侧可点选记录列（稍窄） */}
        {isWindow && (
          <div style={{
            width: 150, flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.07)',
            overflowY: 'auto', padding: '4px 0',
            background: '#0a0e1a',
          }}>
            {entries.length === 0 && (
              <div style={{ padding: '20px 8px', textAlign: 'center', fontSize: 11, color: '#4e5568', lineHeight: 1.8 }}>
                还没有记录<br />点击「＋」开始
              </div>
            )}
            {groups.map(({ label, items }) => (
              <div key={label}>
                <div style={{ padding: '5px 8px 2px', fontSize: 10, fontWeight: 700, color: '#4e5568', letterSpacing: 0.4 }}>
                  {label}
                </div>
                {items.map(entry => {
                  const isAct = entry.id === activeId;
                  const textContent = entry.blocks
                    .filter(b => b.type === 'text').map(b => (b as any).content).join(' ').trim();
                  const imgCount = entry.blocks.filter(b => b.type === 'image').length;
                  const preview = textContent.split('\n')[0] || (imgCount > 0 ? '🖼' : '（空）');
                  return (
                    <div key={entry.id} onClick={() => setActiveId(entry.id)} style={{
                      padding: '6px 8px', cursor: 'pointer',
                      background: isAct ? 'rgba(122,162,247,0.15)' : 'transparent',
                      borderLeft: `2px solid ${isAct ? '#7aa2f7' : 'transparent'}`,
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: isAct ? '#7aa2f7' : '#4e5568', marginBottom: 1 }}>
                        {fmtTime(entry.updatedAt)}
                      </div>
                      <div style={{ fontSize: 11, color: '#cdd6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {imgCount > 0 && <span style={{ marginRight: 3, opacity: 0.6 }}>🖼</span>}
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0d1117' }}>
          {active ? (
            <>
              {/* 元信息栏 */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 12px',
                borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                flexShrink: 0,
              }}>
                <span style={{ fontSize: 10, color: 'var(--theme-text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  🕐 {fmtFull(active.createdAt)}
                  {active.updatedAt !== active.createdAt && <> · 改 {fmtFull(active.updatedAt)}</>}
                </span>
                <button
                  onClick={() => setWrapLines(v => !v)}
                  title={wrapLines ? '关闭自动换行（横向可滚动）' : '开启自动换行'}
                  style={{
                    ...metaBtnBase,
                    color: wrapLines ? '#7aa2f7' : 'var(--theme-text-muted)',
                    borderColor: wrapLines ? '#7aa2f766' : 'var(--theme-border, rgba(255,255,255,0.1))',
                    background: wrapLines ? 'rgba(122,162,247,0.1)' : 'transparent',
                    fontFamily: EDITOR_FONT, fontSize: 10,
                  }}
                >
                  {wrapLines ? '↵ 换行' : '→ 不换行'}
                </button>
                <button
                  onClick={handleCopyAll}
                  title="复制全部内容（含图片，可粘贴到富文本编辑器）"
                  style={{
                    ...metaBtnBase,
                    color: copyOk ? '#3fb950' : 'var(--theme-text-muted)',
                    borderColor: copyOk ? '#3fb95066' : 'var(--theme-border, rgba(255,255,255,0.1))',
                    background: copyOk ? 'rgba(63,185,80,0.1)' : 'transparent',
                  }}
                >
                  {copyOk ? '✓ 已复制' : '📋 复制全部'}
                </button>
                <button onClick={() => handleDelete(active.id)} style={{
                  ...metaBtnBase, color: '#f85149',
                  borderColor: 'rgba(248,81,73,0.3)', background: 'rgba(248,81,73,0.06)',
                }}>
                  🗑
                </button>
              </div>

              {/* 内容块（editor 风格） */}
              <div style={{
                flex: 1, overflowY: 'auto',
                // 不换行时允许横向滚动；行号栏通过 sticky 固定在左侧
                overflowX: wrapLines ? 'hidden' : 'auto',
                padding: '12px 14px 12px 0',
                background: '#0d1117',
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
                              borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)',
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
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--theme-text-muted)', fontSize: 13 }}>
              <span style={{ fontSize: 32 }}>📌</span>
              <span>选择一条记录或新建</span>
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
  background: 'transparent', color: 'var(--theme-text-muted)',
  fontSize: 14, cursor: 'pointer', lineHeight: 1,
};

const metaBtnBase: React.CSSProperties = {
  padding: '2px 7px', borderRadius: 4, border: '1px solid', fontSize: 11, cursor: 'pointer',
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
    document.body.style.background = '#1a1a2e';
    // 注入基础 CSS 变量（dark 默认）
    document.documentElement.style.setProperty('--theme-bg', '#1a1a2e');
    document.documentElement.style.setProperty('--theme-bg-secondary', '#21262d');
    document.documentElement.style.setProperty('--theme-bg-tertiary', '#2d333b');
    document.documentElement.style.setProperty('--theme-border', 'rgba(255,255,255,0.1)');
    document.documentElement.style.setProperty('--theme-text', '#e0e0e0');
    document.documentElement.style.setProperty('--theme-text-muted', '#8b949e');
    document.documentElement.style.setProperty('--theme-accent', '#7aa2f7');
    document.documentElement.style.setProperty('--theme-accent-bg', 'rgba(122,162,247,0.15)');
    document.documentElement.style.setProperty('--theme-code-bg', '#161b22');
  }, []);
  return <ScratchPadEditor mode="window" />;
};
