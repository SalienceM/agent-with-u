import React, { useState, useCallback, useRef } from 'react';
import { api } from '../api';

interface EditImage {
  id: string;
  base64: string;
  mime_type: string;
  size: number;
}

// 序列任务：用户预排的一串渐进明细的想法/指令。一条答完再发下一条；
// 可 auto 自动连发，也可手动一条条触发。喂进队列的方式是输入框的「🧬 序列模式」
// （回车即排入）；本组件是那条 slim 队列条：显示进度、开关、手动「下一步」，
// 点开可看/编辑/增删/调序队列里的条目。
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
  chainActive?: boolean;   // auto 链是否激活（false=auto 开但被你插话暂停了）
  isStreaming: boolean;
  seqMode?: boolean;       // 输入框是否处于序列模式（决定条子的醒目度/文案）
  onSendNext: () => void;
}

export const SeqTaskPanel: React.FC<Props> = ({ sessionId, tasks, auto, chainActive, isStreaming, seqMode, onSendNext }) => {
  const pending = tasks.filter((t) => t.status === 'pending');
  const sent = tasks.filter((t) => t.status === 'sent');
  const [open, setOpen] = useState(false);   // 默认收起,只留一条 slim 条
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editImages, setEditImages] = useState<EditImage[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);  // ★ 历史条目折叠
  const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null);  // ★ 历史图片编辑
  const [historyImages, setHistoryImages] = useState<EditImage[]>([]);
  const editPasteRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = useCallback((t: SeqTaskT) => {
    setEditingId(t.id);
    setEditText(t.text);
    setEditImages([]);
    // 异步聚焦
    setTimeout(() => editPasteRef.current?.focus(), 50);
  }, []);

  const saveEdit = useCallback(async (id: string) => {
    const imgs = editImages.length ? editImages.map((im) => ({
      id: im.id, base64: im.base64, mime_type: im.mime_type, size: im.size,
    })) : undefined;
    await api.seqtaskEdit(sessionId, id, editText.trim(), imgs);
    setEditingId(null);
    setEditImages([]);
  }, [editText, editImages, sessionId]);

  // ★ 编辑区粘贴图片
  const handleEditPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImgs: EditImage[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          newImgs.push({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            base64,
            mime_type: file.type,
            size: file.size,
          });
          if (newImgs.length === Array.from(items).filter((it) => it.type.startsWith('image/')).length) {
            setEditImages((prev) => [...prev, ...newImgs]);
          }
        };
        reader.readAsDataURL(file);
        e.preventDefault();
      }
    }
  }, []);

  const removeEditImage = useCallback((id: string) => {
    setEditImages((prev) => prev.filter((im) => im.id !== id));
  }, []);

  // ★ 历史条目的图片编辑（仅图片，文本不可改）
  const startHistoryEdit = useCallback((t: SeqTaskT) => {
    setEditingHistoryId(t.id);
    // 载入已有图片
    const existing: EditImage[] = (t.images || []).map((im: any, i: number) => ({
      id: im.id || `existing_${i}`,
      base64: im.base64 || '',
      mime_type: im.mime_type || 'image/png',
      size: im.size || 0,
    }));
    setHistoryImages(existing);
  }, []);

  const saveHistoryEdit = useCallback(async (id: string) => {
    const imgs = historyImages.length ? historyImages.map((im) => ({
      id: im.id, base64: im.base64, mime_type: im.mime_type, size: im.size,
    })) : undefined;
    await api.seqtaskEdit(sessionId, id, '', imgs);
    setEditingHistoryId(null);
    setHistoryImages([]);
  }, [historyImages, sessionId]);

  const handleHistoryPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImgs: EditImage[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          newImgs.push({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            base64,
            mime_type: file.type,
            size: file.size,
          });
          if (newImgs.length === Array.from(items).filter((it) => it.type.startsWith('image/')).length) {
            setHistoryImages((prev) => [...prev, ...newImgs]);
          }
        };
        reader.readAsDataURL(file);
        e.preventDefault();
      }
    }
  }, []);

  const removeHistoryImage = useCallback((id: string) => {
    setHistoryImages((prev) => prev.filter((im) => im.id !== id));
  }, []);

  const move = useCallback(async (idx: number, dir: -1 | 1) => {
    const ids = pending.map((t) => t.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api.seqtaskReorder(sessionId, ids);
  }, [pending, sessionId]);

  const canSendNext = pending.length > 0 && !isStreaming;

  return (
    <div style={{ ...wrap, ...(seqMode ? seqActiveWrap : {}) }}>
      <div style={header}>
        <button onClick={() => setOpen(!open)} style={chevBtn} title={open ? '收起' : '展开队列'}>{open ? '▾' : '▸'}</button>
        <span
          onClick={() => setOpen(!open)}
          style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--theme-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title="点击查看/管理队列"
        >
          🧬 序列队列
          {pending.length > 0 && <span style={countPill}>{pending.length}</span>}
        </span>
        {seqMode && <span style={modeTag}>模式开 · 回车排入</span>}
        <div style={{ flex: 1 }} />
        <label style={autoLabel} title="开启后：一条答完自动发送下一条，直到队列清空">
          <input type="checkbox" checked={auto} onChange={(e) => api.seqtaskSetAuto(sessionId, e.target.checked)} />
          <span>自动连发</span>
        </label>
        <button onClick={onSendNext} disabled={!canSendNext}
          title={isStreaming ? '当前回答完成后才能发下一条' : '把队首任务发进对话'}
          style={{ ...sendBtn, opacity: canSendNext ? 1 : 0.45, cursor: canSendNext ? 'pointer' : 'not-allowed' }}>
          ▶ 下一步
        </button>
        {pending.length > 0 && (
          <button onClick={() => api.seqtaskClear(sessionId)} style={clearBtn} title="清空队列">清空</button>
        )}
      </div>

      {/* auto / 暂停 状态提示（收起时也给一行,避免用户不知道在自动连发） */}
      {auto && pending.length > 0 && (
        <div style={autoHint}>
          {chainActive === false
            ? '⏸ 自动连发已暂停（你插了话接管）—— 点「▶ 下一步」继续抽队列。'
            : isStreaming ? '⏳ 正在回答，完成后自动发送下一条…' : '⚡ 自动连发已开启，将依次发送队列。'}
        </div>
      )}

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {pending.length === 0 ? (
            <div style={emptyHint}>
              队列为空。在下方输入框点亮 <b>🧬 序列模式</b> 后，回车即可把内容一条条排入这里。
            </div>
          ) : pending.map((t, i) => (
            <div key={t.id} style={card}>
              <span style={idxBadge}>{i + 1}</span>
              {editingId === t.id ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea ref={editPasteRef} value={editText} onChange={(e) => setEditText(e.target.value)}
                    onPaste={handleEditPaste}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit(t.id); if (e.key === 'Escape') { setEditingId(null); setEditImages([]); } }}
                    placeholder="编辑内容… 可粘贴图片（Ctrl+V）"
                    style={editArea} />
                  {/* ★ 编辑区图片预览 */}
                  {editImages.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {editImages.map((im) => (
                        <div key={im.id} style={editImgWrap}>
                          <img src={`data:${im.mime_type};base64,${im.base64}`} style={editImgThumb} alt="" />
                          <button onClick={() => removeEditImage(im.id)} style={editImgRemove} title="移除">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => saveEdit(t.id)} style={tinyPrimary}>保存</button>
                    <button onClick={() => { setEditingId(null); setEditImages([]); }} style={tinyGhost}>取消</button>
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, minWidth: 0 }}
                  onClick={() => startEdit(t)} title="点击编辑">
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

          {/* ★ 历史已发送条目（可追加/编辑图片） */}
          {sent.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => setHistoryOpen(!historyOpen)}
                style={historyToggleBtn}
              >
                {historyOpen ? '▾' : '▸'} 📋 已发送历史 ({sent.length})
              </button>
              {historyOpen && sent.map((t) => (
                <div key={t.id} style={historyCard}>
                  <span style={historyBadge}>✓</span>
                  {editingHistoryId === t.id ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={historyText}>{t.text}</div>
                      {/* 图片编辑区：粘贴添加 */}
                      <div
                        onPaste={handleHistoryPaste}
                        style={historyPasteArea}
                      >
                        {historyImages.length === 0
                          ? <span style={{ color: 'var(--theme-text-muted)', fontSize: 11 }}>点击此处后粘贴图片（Ctrl+V）</span>
                          : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {historyImages.map((im) => (
                                <div key={im.id} style={editImgWrap}>
                                  {im.base64 && <img src={`data:${im.mime_type};base64,${im.base64}`} style={editImgThumb} alt="" />}
                                  <button onClick={() => removeHistoryImage(im.id)} style={editImgRemove} title="移除">✕</button>
                                </div>
                              ))}
                            </div>
                          )}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => saveHistoryEdit(t.id)} style={tinyPrimary}>保存图片</button>
                        <button onClick={() => { setEditingHistoryId(null); setHistoryImages([]); }} style={tinyGhost}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ flex: 1, minWidth: 0 }} onClick={() => startHistoryEdit(t)} title="点击编辑图片">
                        <div style={historyText}>{t.text || <span style={{ color: 'var(--theme-text-muted)' }}>（仅图片）</span>}</div>
                        {!!(t.imageCount || t.images?.length) && (
                          <span style={imgBadge}>🖼️ {t.imageCount ?? t.images?.length}</span>
                        )}
                      </div>
                      <button onClick={() => startHistoryEdit(t)} style={histEditBtn} title="编辑图片">🖼️</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const wrap: React.CSSProperties = { borderTop: '1px solid var(--theme-border)', padding: '7px 12px', background: 'var(--theme-bg-secondary)' };
const seqActiveWrap: React.CSSProperties = { borderTop: '1px solid #22d3ee', boxShadow: 'inset 0 1px 0 rgba(34,211,238,0.35)' };
const header: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const chevBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text-muted)', fontSize: 12, padding: 0 };
const countPill: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: '#fff', background: 'var(--theme-accent)', borderRadius: 999, padding: '0 7px', lineHeight: 1.7 };
const modeTag: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: '#0891b2', background: 'rgba(34,211,238,0.15)', border: '1px solid rgba(34,211,238,0.4)', borderRadius: 6, padding: '1px 7px' };
const autoLabel: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--theme-text-muted)', cursor: 'pointer' };
const sendBtn: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 7, border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' };
const clearBtn: React.CSSProperties = { fontSize: 11, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--theme-border)', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const autoHint: React.CSSProperties = { fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 6, fontStyle: 'italic' };
const emptyHint: React.CSSProperties = { fontSize: 11.5, color: 'var(--theme-text-muted)', lineHeight: 1.6, padding: '4px 2px' };
const card: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 9px', borderRadius: 8, background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)' };
const idxBadge: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: 'var(--theme-text-muted)', minWidth: 16, textAlign: 'center', marginTop: 2 };
const taskText: React.CSSProperties = { fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'text' };
const imgBadge: React.CSSProperties = { fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 3, display: 'inline-block' };
const editArea: React.CSSProperties = { width: '100%', minHeight: 48, fontSize: 12.5, padding: 6, borderRadius: 6, border: '1px solid var(--theme-accent)', background: 'var(--theme-bg)', color: 'var(--theme-text)', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' };
const arrowBtn: React.CSSProperties = { fontSize: 9, lineHeight: 1, padding: '2px 4px', border: '1px solid var(--theme-border)', borderRadius: 4, background: 'var(--theme-bg)', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const removeBtn: React.CSSProperties = { fontSize: 11, padding: '2px 6px', border: 'none', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const tinyPrimary: React.CSSProperties = { fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: 'none', background: 'var(--theme-accent)', color: '#fff', cursor: 'pointer' };
const tinyGhost: React.CSSProperties = { fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--theme-border)', background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
const editImgWrap: React.CSSProperties = { position: 'relative', width: 40, height: 40, borderRadius: 6, border: '1px solid var(--theme-border)', overflow: 'hidden', flexShrink: 0 };
const editImgThumb: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
const editImgRemove: React.CSSProperties = { position: 'absolute', top: -2, right: -2, width: 14, height: 14, borderRadius: '50%', border: 'none', background: 'var(--theme-error, #cf222e)', color: '#fff', fontSize: 8, lineHeight: '14px', textAlign: 'center', cursor: 'pointer', padding: 0 };

// ★ 历史条目样式
const historyToggleBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text-muted)', fontSize: 11, fontWeight: 600, padding: '4px 0', textAlign: 'left' };
const historyCard: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 8px', borderRadius: 6, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', opacity: 0.75, marginTop: 4 };
const historyBadge: React.CSSProperties = { fontSize: 10, color: 'var(--theme-success, #2da44e)', minWidth: 14, textAlign: 'center', marginTop: 2 };
const historyText: React.CSSProperties = { fontSize: 11.5, color: 'var(--theme-text-muted)', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'pointer' };
const historyPasteArea: React.CSSProperties = { minHeight: 32, padding: 6, borderRadius: 6, border: '1px dashed var(--theme-border)', background: 'var(--theme-bg-secondary)', cursor: 'text' };
const histEditBtn: React.CSSProperties = { fontSize: 10, padding: '2px 6px', border: '1px solid var(--theme-border)', borderRadius: 4, background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer' };
