import React, { useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { useClipboardImage } from '../hooks/useClipboardImage';

// 序列任务：用户预排的一串渐进明细的想法/指令。一条答完再发下一条；
// 可 auto 自动连发，也可手动一条条触发。未发送的随时可编辑/增删/调序。
export interface SeqTaskT {
  id: string;
  text: string;
  images?: any[];
  imageCount?: number;
  status: string;
  createdAt?: number;
}

interface Props {
  sessionId: string;
  tasks: SeqTaskT[];
  auto: boolean;
  isStreaming: boolean;
  onSendNext: () => void;
}

export const SeqTaskPanel: React.FC<Props> = ({ sessionId, tasks, auto, isStreaming, onSendNext }) => {
  const pending = tasks.filter((t) => t.status === 'pending');
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const addBoxRef = useRef<HTMLDivElement>(null);
  const { images, removeImage, clearImages, readFromClipboard } = useClipboardImage(addBoxRef);

  const add = useCallback(async () => {
    const t = draft.trim();
    if (!t && images.length === 0) return;
    await api.seqtaskAdd(sessionId, t, images.length ? images : undefined);
    setDraft('');
    clearImages();
  }, [draft, images, sessionId, clearImages]);

  const saveEdit = useCallback(async (id: string) => {
    await api.seqtaskEdit(sessionId, id, editText.trim());
    setEditingId(null);
  }, [editText, sessionId]);

  const move = useCallback(async (idx: number, dir: -1 | 1) => {
    const ids = pending.map((t) => t.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api.seqtaskReorder(sessionId, ids);
  }, [pending, sessionId]);

  const canSendNext = pending.length > 0 && !isStreaming;

  return (
    <div style={wrap}>
      <div style={header}>
        <button onClick={() => setOpen(!open)} style={chevBtn} title={open ? '收起' : '展开'}>{open ? '▾' : '▸'}</button>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--theme-text)' }}>🧩 序列任务</span>
        {pending.length > 0 && <span style={countPill}>{pending.length}</span>}
        <div style={{ flex: 1 }} />
        <label style={autoLabel} title="开启后：一条答完自动发送下一条，直到队列清空">
          <input type="checkbox" checked={auto} onChange={(e) => api.seqtaskSetAuto(sessionId, e.target.checked)} />
          <span>自动连发</span>
        </label>
        <button onClick={onSendNext} disabled={!canSendNext}
          title={isStreaming ? '当前回答完成后才能发下一条' : '把队首任务发进对话'}
          style={{ ...sendBtn, opacity: canSendNext ? 1 : 0.45, cursor: canSendNext ? 'pointer' : 'not-allowed' }}>
          ▶ 发送下一个
        </button>
      </div>

      {open && (
        <>
          {auto && pending.length > 0 && (
            <div style={autoHint}>
              {isStreaming ? '⏳ 正在回答，完成后自动发送下一条…' : '自动连发已开启，将依次发送队列。'}
            </div>
          )}

          {pending.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {pending.map((t, i) => (
                <div key={t.id} style={card}>
                  <span style={idxBadge}>{i + 1}</span>
                  {editingId === t.id ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <textarea value={editText} autoFocus onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit(t.id); if (e.key === 'Escape') setEditingId(null); }}
                        style={editArea} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => saveEdit(t.id)} style={tinyPrimary}>保存</button>
                        <button onClick={() => setEditingId(null)} style={tinyGhost}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ flex: 1, minWidth: 0 }}
                      onClick={() => { setEditingId(t.id); setEditText(t.text); }} title="点击编辑">
                      <div style={taskText}>{t.text || <span style={{ color: 'var(--theme-text-muted)' }}>（仅图片）</span>}</div>
                      {!!(t.imageCount || t.images?.length) && (
                        <span style={imgBadge}>🖼️ {t.imageCount ?? t.images?.length}</span>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <button onClick={() => move(i, -1)} disabled={i === 0} style={arrowBtn} title="上移">▲</button>
                    <button onClick={() => move(i, 1)} disabled={i === pending.length - 1} style={arrowBtn} title="下移">▼</button>
                  </div>
                  <button onClick={() => api.seqtaskRemove(sessionId, t.id)} style={removeBtn} title="删除">✕</button>
                </div>
              ))}
            </div>
          )}

          {/* 添加 */}
          <div ref={addBoxRef} style={{ marginTop: 8 }}>
            {images.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                {images.map((img) => (
                  <div key={img.id} style={{ position: 'relative' }}>
                    <img src={`data:${img.mime_type};base64,${img.base64}`} style={thumb} alt="" />
                    <button onClick={() => removeImage(img.id)} style={thumbX}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <textarea value={draft} placeholder="加入一个任务（渐进明细的下一步想法）… Ctrl+Enter 添加，可粘贴图片"
                onChange={(e) => setDraft(e.target.value)}
                onPaste={readFromClipboard}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } }}
                style={addArea} />
              <button onClick={add} disabled={!draft.trim() && images.length === 0}
                style={{ ...addBtn, opacity: (draft.trim() || images.length) ? 1 : 0.45 }}>加入</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const wrap: React.CSSProperties = { borderTop: '1px solid var(--theme-border)', padding: '8px 12px', background: 'var(--theme-bg-secondary)' };
const header: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const chevBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text-muted)', fontSize: 12, padding: 0 };
const countPill: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: '#fff', background: 'var(--theme-accent)', borderRadius: 999, padding: '0 7px', lineHeight: 1.7 };
const autoLabel: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--theme-text-muted)', cursor: 'pointer' };
const sendBtn: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 7, border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' };
const autoHint: React.CSSProperties = { fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 6, fontStyle: 'italic' };
const card: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 9px', borderRadius: 8, background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)' };
const idxBadge: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: 'var(--theme-text-muted)', minWidth: 16, textAlign: 'center', marginTop: 2 };
const taskText: React.CSSProperties = { fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'text' };
const imgBadge: React.CSSProperties = { fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 3, display: 'inline-block' };
const editArea: React.CSSProperties = { width: '100%', minHeight: 48, fontSize: 12.5, padding: 6, borderRadius: 6, border: '1px solid var(--theme-accent)', background: 'var(--theme-bg)', color: 'var(--theme-text)', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' };
const arrowBtn: React.CSSProperties = { fontSize: 9, lineHeight: 1, padding: '2px 4px', border: '1px solid var(--theme-border)', borderRadius: 4, background: 'var(--theme-bg)', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const removeBtn: React.CSSProperties = { fontSize: 11, padding: '2px 6px', border: 'none', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const addArea: React.CSSProperties = { flex: 1, minHeight: 38, maxHeight: 120, fontSize: 12.5, padding: 7, borderRadius: 7, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', color: 'var(--theme-text)', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' };
const addBtn: React.CSSProperties = { fontSize: 12, fontWeight: 600, padding: '8px 14px', borderRadius: 7, border: 'none', background: 'var(--theme-accent)', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' };
const tinyPrimary: React.CSSProperties = { fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: 'none', background: 'var(--theme-accent)', color: '#fff', cursor: 'pointer' };
const tinyGhost: React.CSSProperties = { fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--theme-border)', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const thumb: React.CSSProperties = { width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--theme-border)' };
const thumbX: React.CSSProperties = { position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 9, cursor: 'pointer', lineHeight: 1 };
