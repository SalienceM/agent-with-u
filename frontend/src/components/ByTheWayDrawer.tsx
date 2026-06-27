import React, { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useClipboardImage } from '../hooks/useClipboardImage';
import { markdownToHtml } from '../utils/markdown';

// By the way（旁路问答，普通 session 版）：随手问，跑在独立 agent 上下文，
// 带最近对话的只读摘要，不污染主对话、也不写进 transcript。
interface AsideT {
  id: string; question: string; answer: string; status: string; imageCount?: number; createdAt?: number;
}

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

export const ByTheWayDrawer: React.FC<Props> = ({ sessionId, open, onClose }) => {
  const [asides, setAsides] = useState<AsideT[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const { images, removeImage, clearImages, readFromClipboard } = useClipboardImage(boxRef);

  // 载入历史 + 订阅更新
  useEffect(() => {
    if (!sessionId) return;
    api.chatAsideList(sessionId).then((r) => { if (r.status === 'ok') setAsides(r.asides || []); });
    const un1 = api.onChatAsideUpdated((data) => {
      if (data.sessionId !== sessionId) return;
      setAsides(data.asides || []);
      // 完成的 turn 清掉其 live 缓冲
      setLive((prev) => {
        const next = { ...prev };
        for (const a of (data.asides || [])) if (a.status !== 'answering') delete next[a.id];
        return next;
      });
      setBusy((data.asides || []).some((a: AsideT) => a.status === 'answering'));
    });
    const un2 = api.onChatAsideDelta((data) => {
      if (data.sessionId !== sessionId) return;
      setLive((prev) => ({ ...prev, [data.turnId]: (prev[data.turnId] || '') + data.text }));
    });
    return () => { un1(); un2(); };
  }, [sessionId]);

  const ask = useCallback(async () => {
    const q = draft.trim();
    if ((!q && images.length === 0) || busy) return;
    setBusy(true);
    const r = await api.chatAsk(sessionId, q, images.length ? images : undefined);
    if (r.status === 'ok') { setDraft(''); clearImages(); }
    else { setBusy(false); if (r.message) alert(r.message); }
  }, [draft, images, busy, sessionId, clearImages]);

  if (!open) return null;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={drawer} onClick={(e) => e.stopPropagation()}>
        <div style={head}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--theme-text)' }}>💬 By the way · 旁路问答</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>
        <div style={subhead}>独立上下文 · 带最近对话摘要 · 不写入主对话</div>

        <div style={list}>
          {asides.length === 0 && (
            <div style={{ color: 'var(--theme-text-muted)', fontSize: 12.5, padding: '16px 4px', lineHeight: 1.6 }}>
              随手问点什么——它能看到你们最近几轮对话，但回答只在这里，不会打断或污染主线。
            </div>
          )}
          {asides.map((a) => {
            const liveText = live[a.id];
            const answering = a.status === 'answering';
            return (
              <div key={a.id} style={turn}>
                <div style={qRow}>
                  <span style={qTag}>问</span>
                  <span style={{ fontSize: 12.5, color: 'var(--theme-text)', whiteSpace: 'pre-wrap' }}>
                    {a.question}{!!a.imageCount && <span style={{ color: 'var(--theme-text-muted)' }}> 🖼️{a.imageCount}</span>}
                  </span>
                </div>
                <div style={aRow}>
                  <span style={aTag}>答</span>
                  {answering && !liveText ? (
                    <span style={{ fontSize: 12.5, color: 'var(--theme-text-muted)' }}>思考中…▋</span>
                  ) : (
                    <div className="md-content" style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--theme-text)', flex: 1, minWidth: 0 }}
                      dangerouslySetInnerHTML={{ __html: markdownToHtml(answering ? (liveText || '') : (a.answer || '')) + (answering ? ' ▋' : '') }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div ref={boxRef} style={inputWrap}>
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
            <textarea value={draft} placeholder="随手问… Enter 发送，Shift+Enter 换行，可粘贴图片"
              onChange={(e) => setDraft(e.target.value)}
              onPaste={readFromClipboard}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
              style={inputArea} />
            <button onClick={ask} disabled={busy || (!draft.trim() && images.length === 0)}
              style={{ ...askBtn, opacity: busy || (!draft.trim() && !images.length) ? 0.45 : 1 }}>
              {busy ? '…' : '问'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const overlay: React.CSSProperties = { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 40, display: 'flex', justifyContent: 'flex-end' };
const drawer: React.CSSProperties = { width: 'min(440px, 92%)', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--theme-bg)', borderLeft: '1px solid var(--theme-border)', boxShadow: '-8px 0 24px rgba(0,0,0,0.18)' };
const head: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '12px 14px 4px' };
const subhead: React.CSSProperties = { fontSize: 11, color: 'var(--theme-text-muted)', padding: '0 14px 8px', borderBottom: '1px solid var(--theme-border)' };
const xBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text-muted)', fontSize: 14 };
const list: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 12 };
const turn: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 10, borderBottom: '1px dashed var(--theme-border)' };
const qRow: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'flex-start' };
const aRow: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'flex-start' };
const qTag: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--theme-accent)', borderRadius: 4, padding: '1px 5px', flexShrink: 0, marginTop: 1 };
const aTag: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--theme-text-muted)', background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)', borderRadius: 4, padding: '1px 5px', flexShrink: 0, marginTop: 1 };
const inputWrap: React.CSSProperties = { padding: '10px 14px', borderTop: '1px solid var(--theme-border)' };
const inputArea: React.CSSProperties = { flex: 1, minHeight: 40, maxHeight: 140, fontSize: 12.5, padding: 8, borderRadius: 8, border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' };
const askBtn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--theme-accent)', color: '#fff', cursor: 'pointer' };
const thumb: React.CSSProperties = { width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--theme-border)' };
const thumbX: React.CSSProperties = { position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 9, cursor: 'pointer', lineHeight: 1 };
