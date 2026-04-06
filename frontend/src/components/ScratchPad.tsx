/**
 * ScratchPad — 全局临时记事本
 *
 * 功能：
 * - 右侧滑入面板
 * - 每条记录自动打上创建/修改时间戳
 * - 支持文字输入 + Ctrl+V 粘贴图片
 * - localStorage 持久化，关闭再打开有效
 * - 按日期分组的时间线视图
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── 数据类型 ──────────────────────────────────────────────────────────
export interface ScratchEntry {
  id: string;
  createdAt: number;   // ms timestamp
  updatedAt: number;
  text: string;
  images: string[];    // base64 data-URLs
}

const STORAGE_KEY = 'agent-with-u:scratchpad';

function loadEntries(): ScratchEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveEntries(entries: ScratchEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── 时间格式化 ────────────────────────────────────────────────────────
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return '今天';
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}
function fmtFull(ts: number) {
  return new Date(ts).toLocaleString([], {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── 按日期分组 ────────────────────────────────────────────────────────
function groupByDate(entries: ScratchEntry[]): { label: string; items: ScratchEntry[] }[] {
  const map = new Map<string, ScratchEntry[]>();
  for (const e of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const label = fmtDate(e.updatedAt);
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(e);
  }
  return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
}

// ── 主组件 ────────────────────────────────────────────────────────────
interface Props {
  open: boolean;
  onClose: () => void;
}

export const ScratchPad: React.FC<Props> = ({ open, onClose }) => {
  const [entries, setEntries] = useState<ScratchEntry[]>(loadEntries);
  const [activeId, setActiveId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // 当前编辑条目
  const active = entries.find(e => e.id === activeId) ?? null;

  // 持久化
  useEffect(() => {
    saveEntries(entries);
  }, [entries]);

  // 打开时默认选中最近一条，没有则新建
  useEffect(() => {
    if (!open) return;
    setEntries(loadEntries()); // 刷新（多窗口场景）
    if (entries.length > 0) {
      const latest = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      setActiveId(latest.id);
    } else {
      handleNew();
    }
  }, [open]); // eslint-disable-line

  // focus textarea when switching entries
  useEffect(() => {
    if (open && activeId) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [activeId, open]);

  const handleNew = useCallback(() => {
    const entry: ScratchEntry = {
      id: newId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      text: '',
      images: [],
    };
    setEntries(prev => [entry, ...prev]);
    setActiveId(entry.id);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setEntries(prev => {
      const next = prev.filter(e => e.id !== id);
      // 选下一条
      if (id === activeId) {
        const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
        setActiveId(sorted[0]?.id ?? null);
      }
      return next;
    });
  }, [activeId]);

  const handleTextChange = useCallback((text: string) => {
    const now = Date.now();
    setEntries(prev => prev.map(e =>
      e.id === activeId ? { ...e, text, updatedAt: now } : e
    ));
  }, [activeId]);

  // 粘贴图片
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(it => it.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      if (!dataUrl) return;
      const now = Date.now();
      setEntries(prev => prev.map(e =>
        e.id === activeId
          ? { ...e, images: [...e.images, dataUrl], updatedAt: now }
          : e
      ));
    };
    reader.readAsDataURL(file);
  }, [activeId]);

  const handleRemoveImage = useCallback((idx: number) => {
    setEntries(prev => prev.map(e =>
      e.id === activeId
        ? { ...e, images: e.images.filter((_, i) => i !== idx), updatedAt: Date.now() }
        : e
    ));
  }, [activeId]);

  const groups = groupByDate(entries);

  return (
    <>
      {/* 遮罩 */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 1100,
            background: 'rgba(0,0,0,0.3)',
          }}
        />
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
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--theme-text)', flex: 1 }}>
            便签本
          </span>
          <button
            onClick={handleNew}
            style={{
              padding: '4px 12px', borderRadius: 6, border: 'none',
              background: 'var(--theme-accent, #7aa2f7)', color: '#fff',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            + 新建
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '4px 8px', borderRadius: 6,
              border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
              background: 'transparent', color: 'var(--theme-text-muted)',
              fontSize: 14, cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {/* 主体：左侧时间线 + 右侧编辑器 */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* 时间线列表 */}
          <div style={{
            width: 200, flexShrink: 0,
            borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
            overflowY: 'auto',
            padding: '8px 0',
          }}>
            {entries.length === 0 && (
              <div style={{
                padding: '20px 12px', textAlign: 'center',
                fontSize: 12, color: 'var(--theme-text-muted)',
                lineHeight: 1.8,
              }}>
                还没有记录<br />点击「新建」开始
              </div>
            )}
            {groups.map(({ label, items }) => (
              <div key={label}>
                {/* 日期分组标题 */}
                <div style={{
                  padding: '6px 12px 2px',
                  fontSize: 10, fontWeight: 700,
                  color: 'var(--theme-text-muted)',
                  textTransform: 'uppercase', letterSpacing: 0.5,
                }}>
                  {label}
                </div>
                {items.map(entry => {
                  const isActive = entry.id === activeId;
                  const preview = entry.text.trim().split('\n')[0] || (entry.images.length > 0 ? '🖼 图片' : '（空）');
                  return (
                    <div
                      key={entry.id}
                      onClick={() => setActiveId(entry.id)}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        background: isActive ? 'var(--theme-accent-bg, rgba(122,162,247,0.15))' : 'transparent',
                        borderLeft: isActive ? '2px solid var(--theme-accent, #7aa2f7)' : '2px solid transparent',
                        transition: 'background 0.12s',
                      }}
                    >
                      <div style={{
                        fontSize: 11, fontWeight: 600,
                        color: isActive ? 'var(--theme-accent, #7aa2f7)' : 'var(--theme-text-muted)',
                        marginBottom: 2,
                      }}>
                        {fmtTime(entry.updatedAt)}
                      </div>
                      <div style={{
                        fontSize: 11,
                        color: 'var(--theme-text)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {preview}
                      </div>
                      {entry.images.length > 0 && (
                        <div style={{ fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 2 }}>
                          🖼 ×{entry.images.length}
                        </div>
                      )}
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
                  padding: '6px 14px',
                  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                  flexShrink: 0,
                }}>
                  <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                    🕐 创建 {fmtFull(active.createdAt)}
                    {active.updatedAt !== active.createdAt && (
                      <span> · 修改 {fmtFull(active.updatedAt)}</span>
                    )}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => handleDelete(active.id)}
                    style={{
                      padding: '2px 8px', borderRadius: 4,
                      border: '1px solid rgba(248,81,73,0.3)',
                      background: 'rgba(248,81,73,0.08)', color: '#f85149',
                      fontSize: 11, cursor: 'pointer',
                    }}
                  >
                    🗑 删除
                  </button>
                </div>

                {/* 图片缩略图 */}
                {active.images.length > 0 && (
                  <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: 8,
                    padding: '8px 14px',
                    borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                    flexShrink: 0,
                  }}>
                    {active.images.map((src, idx) => (
                      <div key={idx} style={{ position: 'relative' }}>
                        <img
                          src={src}
                          alt=""
                          style={{
                            width: 80, height: 80, objectFit: 'cover',
                            borderRadius: 6, border: '1px solid var(--theme-border)',
                            cursor: 'pointer',
                          }}
                          onClick={() => window.open(src, '_blank')}
                        />
                        <button
                          onClick={() => handleRemoveImage(idx)}
                          style={{
                            position: 'absolute', top: -4, right: -4,
                            width: 18, height: 18, borderRadius: '50%',
                            border: 'none', background: '#f85149', color: '#fff',
                            fontSize: 10, cursor: 'pointer', lineHeight: 1,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* 文本编辑器 */}
                <textarea
                  ref={textareaRef}
                  value={active.text}
                  onChange={e => handleTextChange(e.target.value)}
                  onPaste={handlePaste}
                  placeholder={`在这里写点什么…\n\n支持 Ctrl+V 粘贴图片`}
                  style={{
                    flex: 1, resize: 'none', border: 'none', outline: 'none',
                    padding: '14px 16px',
                    background: 'transparent',
                    color: 'var(--theme-text)',
                    fontSize: 13, lineHeight: 1.7,
                    fontFamily: 'system-ui, sans-serif',
                  }}
                />
              </>
            ) : (
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexDirection: 'column', gap: 12,
                color: 'var(--theme-text-muted)', fontSize: 13,
              }}>
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
