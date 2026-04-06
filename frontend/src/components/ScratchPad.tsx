/**
 * ScratchPad — 全局临时记事本
 *
 * 内容模型：每条记录由「文本块 / 图片块」交替组成
 * 粘贴图片时在光标处拆分文本块，将图片内联插入
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';

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
let _blockCounter = 0;
function bid() { return `b${Date.now()}-${++_blockCounter}`; }
function eid() { return `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }
function emptyEntry(): ScratchEntry {
  return { id: eid(), createdAt: Date.now(), updatedAt: Date.now(), blocks: [{ type: 'text', id: bid(), content: '' }] };
}

function load(): ScratchEntry[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function persist(entries: ScratchEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
}

// ── 时间格式 ─────────────────────────────────────────────────────────
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ts: number) {
  const d = new Date(ts), t = new Date(), y = new Date(t);
  y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return '今天';
  if (d.toDateString() === y.toDateString()) return '昨天';
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}
function fmtFull(ts: number) {
  return new Date(ts).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function groupByDate(entries: ScratchEntry[]) {
  const map = new Map<string, ScratchEntry[]>();
  for (const e of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const k = fmtDate(e.updatedAt);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(e);
  }
  return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
}

// ── 自动伸缩 textarea ─────────────────────────────────────────────────
function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ── 主组件 ────────────────────────────────────────────────────────────
interface Props { open: boolean; onClose: () => void; }

export const ScratchPad: React.FC<Props> = ({ open, onClose }) => {
  const [entries, setEntries] = useState<ScratchEntry[]>(load);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // ref map: blockId → textarea element，用于 focus 和 autoResize
  const taRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const focusTarget = useRef<{ blockId: string; pos: number } | null>(null);

  const active = entries.find(e => e.id === activeId) ?? null;

  // 持久化
  useEffect(() => { persist(entries); }, [entries]);

  // 打开时加载并选中最近一条
  useEffect(() => {
    if (!open) return;
    const fresh = load();
    setEntries(fresh);
    if (fresh.length > 0) {
      setActiveId([...fresh].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
    } else {
      const e = emptyEntry();
      setEntries([e]);
      setActiveId(e.id);
    }
  }, [open]); // eslint-disable-line

  // focus 指定块
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
        const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
        setActiveId(sorted[0]?.id ?? null);
      }
      return next;
    });
  }, [activeId]);

  // 更新某条记录的 blocks
  const updateBlocks = useCallback((entryId: string, blocks: Block[]) => {
    setEntries(prev => prev.map(e =>
      e.id === entryId ? { ...e, blocks, updatedAt: Date.now() } : e
    ));
  }, []);

  // 文本块内容变化
  const handleTextChange = useCallback((entryId: string, blockId: string, text: string, el: HTMLTextAreaElement) => {
    autoResize(el);
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e;
      return {
        ...e,
        updatedAt: Date.now(),
        blocks: e.blocks.map(b => b.type === 'text' && b.id === blockId ? { ...b, content: text } : b),
      };
    }));
  }, []);

  // 在指定文本块的光标处插入图片
  const insertImageAt = useCallback((entryId: string, blockId: string, cursorPos: number, src: string) => {
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e;
      const blocks = e.blocks;
      const idx = blocks.findIndex(b => b.id === blockId);
      if (idx < 0) return e;
      const block = blocks[idx];
      if (block.type !== 'text') return e;

      const before = block.content.slice(0, cursorPos);
      const after  = block.content.slice(cursorPos);
      const imgBlock: Block = { type: 'image', id: bid(), src };
      const afterBlock: Block = { type: 'text', id: bid(), content: after };

      const newBlocks = [
        ...blocks.slice(0, idx),
        { ...block, content: before },
        imgBlock,
        afterBlock,
        ...blocks.slice(idx + 1),
      ];
      focusTarget.current = { blockId: afterBlock.id, pos: 0 };
      return { ...e, blocks: newBlocks, updatedAt: Date.now() };
    }));
  }, []);

  // 删除图片块，合并前后文本块
  const removeImageBlock = useCallback((entryId: string, blockId: string) => {
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId) return e;
      const blocks = e.blocks;
      const idx = blocks.findIndex(b => b.id === blockId);
      if (idx < 0) return e;
      // 删掉图片块，把相邻文本块合并
      const newBlocks = [...blocks];
      newBlocks.splice(idx, 1);
      // 合并相邻文本块
      const merged: Block[] = [];
      for (const b of newBlocks) {
        const last = merged[merged.length - 1];
        if (last?.type === 'text' && b.type === 'text') {
          merged[merged.length - 1] = { ...last, content: last.content + b.content };
        } else {
          merged.push(b);
        }
      }
      if (merged.length === 0) merged.push({ type: 'text', id: bid(), content: '' });
      return { ...e, blocks: merged, updatedAt: Date.now() };
    }));
  }, []);

  // 处理 paste：图片拦截，并阻止冒泡（防止触发全局 clipboard hook）
  const handlePaste = useCallback((
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    entryId: string,
    blockId: string,
  ) => {
    const items = Array.from(e.clipboardData.items);
    const imgItem = items.find(it => it.type.startsWith('image/'));
    if (!imgItem) return;

    // 阻止事件冒泡到 document，防止全局 paste 监听器也捕获
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    const cursorPos = e.currentTarget.selectionStart ?? e.currentTarget.value.length;
    const file = imgItem.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      if (src) insertImageAt(entryId, blockId, cursorPos, src);
    };
    reader.readAsDataURL(file);
  }, [insertImageAt]);

  const groups = groupByDate(entries);

  return (
    <>
      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1200,
            background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={lightbox}
            alt="preview"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.6)', cursor: 'default' }}
          />
          <button onClick={() => setLightbox(null)} style={{
            position: 'fixed', top: 16, right: 20,
            background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
            fontSize: 22, width: 36, height: 36, borderRadius: '50%',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>×</button>
        </div>
      )}

      {/* 遮罩 */}
      {open && (
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)' }} />
      )}

      {/* 面板 */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 700, maxWidth: '95vw',
        zIndex: 1101,
        display: 'flex', flexDirection: 'column',
        background: 'var(--theme-bg, #1a1a2e)',
        borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
        boxShadow: '-8px 0 32px rgba(0,0,0,0.4)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.26s cubic-bezier(0.22,0.61,0.36,1)',
      }}>
        {/* 标题栏 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px',
          borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 16 }}>📌</span>
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--theme-text)', flex: 1 }}>便签本</span>
          <button onClick={handleNew} style={{
            padding: '4px 12px', borderRadius: 6, border: 'none',
            background: 'var(--theme-accent, #7aa2f7)', color: '#fff',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>+ 新建</button>
          <button onClick={onClose} style={{
            padding: '4px 8px', borderRadius: 6,
            border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
            background: 'transparent', color: 'var(--theme-text-muted)',
            fontSize: 14, cursor: 'pointer',
          }}>✕</button>
        </div>

        {/* 主体 */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* 时间线 */}
          <div style={{
            width: 190, flexShrink: 0,
            borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
            overflowY: 'auto', padding: '8px 0',
          }}>
            {entries.length === 0 && (
              <div style={{ padding: '20px 12px', textAlign: 'center', fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.8 }}>
                还没有记录<br />点击「新建」开始
              </div>
            )}
            {groups.map(({ label, items }) => (
              <div key={label}>
                <div style={{ padding: '6px 12px 2px', fontSize: 10, fontWeight: 700, color: 'var(--theme-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {label}
                </div>
                {items.map(entry => {
                  const isActive = entry.id === activeId;
                  const textContent = entry.blocks.filter(b => b.type === 'text').map(b => (b as any).content).join(' ').trim();
                  const imgCount = entry.blocks.filter(b => b.type === 'image').length;
                  const preview = textContent.split('\n')[0] || (imgCount > 0 ? '' : '（空）');
                  return (
                    <div
                      key={entry.id}
                      onClick={() => setActiveId(entry.id)}
                      style={{
                        padding: '8px 12px', cursor: 'pointer',
                        background: isActive ? 'var(--theme-accent-bg, rgba(122,162,247,0.15))' : 'transparent',
                        borderLeft: isActive ? '2px solid var(--theme-accent, #7aa2f7)' : '2px solid transparent',
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 600, color: isActive ? 'var(--theme-accent, #7aa2f7)' : 'var(--theme-text-muted)', marginBottom: 2 }}>
                        {fmtTime(entry.updatedAt)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {imgCount > 0 && <span style={{ marginRight: 4 }}>🖼×{imgCount}</span>}
                        {preview}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 编辑区 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {active ? (
              <>
                {/* 时间戳 + 删除 */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 14px',
                  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                  flexShrink: 0,
                }}>
                  <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    🕐 {fmtFull(active.createdAt)}
                    {active.updatedAt !== active.createdAt && <> · 改 {fmtFull(active.updatedAt)}</>}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => handleDelete(active.id)} style={{
                    padding: '2px 8px', borderRadius: 4,
                    border: '1px solid rgba(248,81,73,0.3)', background: 'rgba(248,81,73,0.08)', color: '#f85149',
                    fontSize: 11, cursor: 'pointer',
                  }}>🗑 删除</button>
                </div>

                {/* 内容块（文本+图片交替） */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
                  {active.blocks.map((block) => {
                    if (block.type === 'text') {
                      return (
                        <textarea
                          key={block.id}
                          ref={el => {
                            if (el) { taRefs.current.set(block.id, el); autoResize(el); }
                            else taRefs.current.delete(block.id);
                          }}
                          value={block.content}
                          onChange={e => handleTextChange(active.id, block.id, e.target.value, e.currentTarget)}
                          onPaste={e => handlePaste(e, active.id, block.id)}
                          placeholder={active.blocks.length === 1 ? '在这里写点什么…\n\nCtrl+V 可粘贴图片，图片将出现在光标位置' : ''}
                          style={{
                            display: 'block', width: '100%', resize: 'none',
                            border: 'none', outline: 'none',
                            background: 'transparent',
                            color: 'var(--theme-text)',
                            fontSize: 13, lineHeight: 1.7,
                            fontFamily: 'system-ui, sans-serif',
                            padding: 0, minHeight: 24,
                            overflow: 'hidden',
                            boxSizing: 'border-box',
                          }}
                        />
                      );
                    }
                    // image block
                    return (
                      <div key={block.id} style={{ position: 'relative', margin: '6px 0', display: 'inline-block', maxWidth: '100%' }}>
                        <img
                          src={block.src}
                          alt=""
                          onClick={() => setLightbox(block.src)}
                          style={{
                            maxWidth: '100%', maxHeight: 320, display: 'block',
                            borderRadius: 6, border: '1px solid var(--theme-border)',
                            cursor: 'zoom-in',
                          }}
                        />
                        <button
                          onClick={() => removeImageBlock(active.id, block.id)}
                          style={{
                            position: 'absolute', top: 4, right: 4,
                            width: 20, height: 20, borderRadius: '50%',
                            border: 'none', background: 'rgba(248,81,73,0.85)', color: '#fff',
                            fontSize: 11, cursor: 'pointer', lineHeight: 1,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >✕</button>
                      </div>
                    );
                  })}
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
    </>
  );
};
