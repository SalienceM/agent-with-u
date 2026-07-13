import React, { useEffect, useState } from 'react';
import {
  SMOOTH_GHOST_READY_EVENT,
  SMOOTH_GHOST_STATE_EVENT,
  type SmoothGhostState,
} from '../utils/smoothGhost';

export const isSmoothGhostWindow =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('smooth-ghost');

const EMPTY: SmoothGhostState = {
  sessionId: '',
  sessionTitle: 'AgentWithU',
  backendLabel: '',
  question: '',
  answer: '',
  isStreaming: false,
  updatedAt: Date.now(),
};

export const SmoothGhostWindow: React.FC = () => {
  const [state, setState] = useState<SmoothGhostState>(EMPTY);

  useEffect(() => {
    document.title = 'AgentWithU · Smooth Ghost';
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.documentElement.style.pointerEvents = 'none';
    let unlisten: undefined | (() => void);
    let cancelled = false;
    (async () => {
      const { emitTo, listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<SmoothGhostState>(SMOOTH_GHOST_STATE_EVENT, (event) => {
        if (!cancelled && event.payload) setState(event.payload);
      });
      await emitTo('main', SMOOTH_GHOST_READY_EVENT, {});
    })().catch((error) => console.error('[smooth-ghost] event setup failed:', error));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  return (
    <div style={rootStyle}>
      <div style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={titleStyle}>{state.sessionTitle || 'AgentWithU'}</div>
          <div style={metaStyle}>{state.backendLabel || '当前会话'}</div>
        </div>
        <div style={{ ...statusStyle, color: state.isStreaming ? '#67e8f9' : '#a7f3d0' }}>
          <span style={{ ...dotStyle, background: state.isStreaming ? '#22d3ee' : '#34d399' }} />
          {state.isStreaming ? '回答中' : '已就绪'}
        </div>
      </div>

      <div style={contentStyle}>
        <section style={sectionStyle}>
          <div style={labelStyle}>最新问题</div>
          <div style={questionStyle}>{state.question || '等待新的问题…'}</div>
        </section>
        <section style={{ ...sectionStyle, flex: 1, minHeight: 0 }}>
          <div style={labelStyle}>AgentWithU</div>
          <div style={answerStyle}>
            {state.answer || (state.isStreaming ? '正在组织回答…' : '暂无回答')}
            {state.isStreaming && <span style={cursorStyle}>▋</span>}
          </div>
        </section>
      </div>
      <div style={footerStyle}>SMOOTH GHOST · Alt + 左键双击隐藏</div>
    </div>
  );
};

const rootStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  color: '#e5eefb', fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif',
  background: 'linear-gradient(145deg, rgba(5,12,24,.76), rgba(10,24,42,.63))',
  border: '1px solid rgba(103,232,249,.32)', borderRadius: 14,
  boxShadow: 'inset 0 0 42px rgba(34,211,238,.055), 0 12px 48px rgba(0,0,0,.18)',
  backdropFilter: 'blur(12px)', pointerEvents: 'none', userSelect: 'none',
};
const headerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 18px 11px', borderBottom: '1px solid rgba(148,163,184,.16)' };
const titleStyle: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15, fontWeight: 750, letterSpacing: '.02em' };
const metaStyle: React.CSSProperties = { marginTop: 3, fontSize: 10, color: '#8ca3bd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const statusStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: '.08em' };
const dotStyle: React.CSSProperties = { width: 7, height: 7, borderRadius: '50%', boxShadow: '0 0 10px currentColor' };
const contentStyle: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: '13px 18px 10px' };
const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: '#67e8f9', letterSpacing: '.12em', textTransform: 'uppercase' };
const questionStyle: React.CSSProperties = { padding: '9px 11px', borderRadius: 9, background: 'rgba(30,64,107,.34)', border: '1px solid rgba(96,165,250,.16)', color: '#dbeafe', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' };
const answerStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'hidden', color: '#e2e8f0', fontSize: 13, lineHeight: 1.62, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maskImage: 'linear-gradient(to bottom, black 88%, transparent 100%)' };
const cursorStyle: React.CSSProperties = { color: '#22d3ee', marginLeft: 2, animation: 'blink 1s step-end infinite' };
const footerStyle: React.CSSProperties = { padding: '0 18px 9px', color: 'rgba(148,163,184,.55)', fontSize: 9, letterSpacing: '.11em', textAlign: 'right' };

