import React, { useContext, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSpeechDictation } from '../hooks/useSpeechDictation';
import { AppModalVisibilityContext, WorkbenchInteractionContext } from './AppModalPortal';
import { WorkflowButton } from './WorkflowControls';

// 消息操作按钮为 100、跟踪最新为 50；语音浮层位于二者之上。
// 容器空白处仍允许操作对话，面板自身负责拦截指针事件。
export const speechPanelHostStyle: React.CSSProperties = {
  position: 'absolute', inset: 12, zIndex: 150, pointerEvents: 'none',
};

interface Props {
  scope: string;
  sessionId?: string;
  host?: HTMLElement | null;
  visible: boolean;
  disabled: boolean;
  onApply: (text: string) => boolean;
}

export const SpeechDictation: React.FC<Props> = ({ scope, sessionId, host, visible, disabled, onApply }) => {
  const ownerVisible = useContext(AppModalVisibilityContext);
  const frozen = useContext(WorkbenchInteractionContext);
  const available = visible && ownerVisible && !disabled && !frozen;
  const voice = useSpeechDictation(scope, sessionId, available);
  const trigger = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const show = voice.open && visible && ownerVisible && !frozen;
  const finalizing = voice.status === 'finalizing';
  const label = voice.status === 'connecting' ? '正在连接…' : voice.status === 'reconnecting' ? '正在恢复连接…'
    : finalizing ? '正在确认最后一句…' : voice.status === 'listening' ? '正在聆听' : voice.error ? '录音已停止' : '待应用';

  useLayoutEffect(() => {
    if (show && follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [voice.text, show]);
  const latest = () => {
    follow.current = true; setAtLatest(true);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };
  const hide = () => { voice.setOpen(false); trigger.current?.focus(); };
  const panel = show && <aside role="region" aria-label="语音转写" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); hide(); }
  }} style={{
    position: 'absolute', right: host ? 0 : 12, bottom: host ? 0 : 'calc(100% + 8px)',
    width: host ? 'min(364px, 100%)' : 'min(364px, calc(100% - 24px))',
    height: host ? 'min(460px, 100%)' : 'min(460px, 55dvh)', maxHeight: host ? '100%' : undefined,
    display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'auto',
    pointerEvents: 'auto', zIndex: 35, borderRadius: 14, border: '1px solid var(--theme-border, #dce1e8)',
    background: 'var(--theme-panel-solid, var(--theme-bg, #fff))', color: 'var(--theme-text, #273244)',
    boxShadow: '0 10px 36px rgba(0,0,0,.16)', fontSize: 13,
  }}>
    <header style={{ padding: '12px 14px 10px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      borderBottom: '1px solid var(--theme-border, #dce1e8)' }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: voice.busy ? 'var(--theme-error, #f85149)' : 'var(--theme-accent, #4b82f0)' }} />
      <div style={{ flex: 1 }}><strong style={{ fontWeight: 600 }}>语音转写</strong>
        <div role="status" style={{ color: 'var(--theme-text-muted, #687487)', fontSize: 11, marginTop: 3 }}>{label}</div></div>
      {voice.busy && <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--theme-text-muted)', fontSize: 11 }}>
        <span>{Math.floor(voice.audioSeconds)}s</span>
        <span role="meter" aria-label="麦克风输入音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(voice.audioLevel)}
          style={{ display: 'block', width: 40, height: 5, borderRadius: 3, overflow: 'hidden', background: 'var(--theme-border)' }}>
          <span style={{ display: 'block', height: '100%', width: `${voice.audioLevel}%`, background: 'var(--theme-accent, #4b82f0)', transition: 'width .15s' }} />
        </span>
      </div>}
      <WorkflowButton tone="quiet" icon="close" aria-label="收起语音面板" title="收起，保留转写内容" onClick={hide} style={{ padding: 4 }} />
    </header>
    {voice.deviceLabel && <div style={{ padding: '7px 14px', flexShrink: 0, fontSize: 11, color: 'var(--theme-text-muted)',
      borderBottom: '1px solid var(--theme-border)', overflowWrap: 'anywhere' }}>
      {voice.busy || !voice.microphones.length ? <span>麦克风 · {voice.deviceLabel}</span> : <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flexShrink: 0 }}>麦克风</span>
        <select aria-label="语音输入麦克风" value={voice.deviceChoice} onChange={event => voice.selectDevice(event.target.value)}
          style={{ minWidth: 0, width: '100%', font: 'inherit', color: 'var(--theme-text)', background: 'var(--theme-input-bg, var(--theme-bg))', border: '1px solid var(--theme-border)', borderRadius: 4, padding: 3 }}>
          <option value="">系统默认麦克风</option>
          {voice.microphones.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
        </select>
      </label>}
      {voice.deviceNotice && <div role="status" style={{ marginTop: 4 }}>{voice.deviceNotice}</div>}
    </div>}
    <div ref={scroller} role="region" aria-label="转写全文" tabIndex={0} onScroll={() => {
      const el = scroller.current; if (!el) return;
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
      follow.current = bottom; setAtLatest(bottom);
    }} style={{ flex: 1, minHeight: 64, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable',
      padding: '14px 16px', lineHeight: 1.85, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }}>
      {voice.text || <span style={{ color: 'var(--theme-text-muted, #687487)', fontSize: 12 }}>
        {voice.status === 'listening' ? '可以开始说话了，识别文字会在这里持续更新。'
          : voice.busy ? '连接准备好后，识别文字会在这里显示。' : '还没有识别到文字，可以再试一次。'}
      </span>}
    </div>
    <footer style={{ padding: '8px 12px 12px', flexShrink: 0, borderTop: '1px solid var(--theme-border, #dce1e8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 26,
        color: 'var(--theme-text-muted, #687487)', fontSize: 11 }}>
        <span>{voice.text.length.toLocaleString()} 字 · 尚未写入输入框</span>
        {!atLatest && <WorkflowButton tone="quiet" onClick={latest} style={{ fontSize: 11, padding: '0 4px', minHeight: 24 }}>↓ 回到最新</WorkflowButton>}
      </div>
      {(voice.error || voice.notice) && <div role={voice.error ? 'alert' : 'status'} style={{ fontSize: 11, lineHeight: 1.6,
        marginBottom: 8, maxHeight: 70, overflowY: 'auto', overflowWrap: 'anywhere', color: voice.error ? 'var(--theme-error, #cf222e)' : 'var(--theme-text-muted, #687487)' }}>
        {voice.error || voice.notice}
      </div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {voice.busy ? <WorkflowButton onClick={voice.stop} disabled={finalizing} style={{ flex: 1 }}>
          {finalizing ? '正在完成转写…' : '停止录音'}
        </WorkflowButton> : <>
          <WorkflowButton tone="quiet" onClick={() => { voice.clear(); latest(); trigger.current?.focus(); }}>放弃</WorkflowButton>
          <WorkflowButton onClick={voice.start} disabled={!available}>继续录音</WorkflowButton>
        </>}
        <WorkflowButton tone="primary" disabled={voice.busy || !voice.text.trim()} style={{ marginLeft: 'auto' }}
          title="追加到当前草稿，不会发送" onClick={() => {
            voice.apply(onApply);
            latest();
          }}>应用到输入框</WorkflowButton>
      </div>
    </footer>
  </aside>;

  return <>
    <button ref={trigger} type="button" aria-expanded={show}
      aria-label={voice.busy ? '停止实时语音输入' : voice.text ? '查看语音转写' : '开始实时语音输入'}
      title={disabled ? '实时语音对话正在使用麦克风' : voice.busy ? label : voice.text ? '查看尚未应用的语音转写' : '实时语音输入'}
      disabled={!available || finalizing} onClick={() => {
        if (voice.busy) { voice.setOpen(true); voice.stop(); }
        else if (voice.text) voice.setOpen(true);
        else { latest(); voice.start(); }
      }} style={{ width: 'var(--ui-send-size, 38px)', height: 'var(--ui-send-size, 38px)', flexShrink: 0,
        display: 'grid', placeItems: 'center', borderRadius: 10, border: '1px solid var(--theme-border)',
        background: voice.busy ? '#f85149' : voice.text ? 'var(--theme-accent-bg, #4b82f014)' : 'var(--theme-bg-tertiary, #eaeef2)',
        color: voice.busy ? '#fff' : voice.text ? 'var(--theme-accent, #4b82f0)' : 'var(--theme-text-muted)',
        cursor: available && !finalizing ? 'pointer' : 'not-allowed', opacity: available ? 1 : .4 }}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8" />
      </svg>
    </button>
    {host ? createPortal(panel, host) : panel}
  </>;
};
