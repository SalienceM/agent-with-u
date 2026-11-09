import React, { useEffect, useRef } from 'react';
import { AppModalPortal } from './AppModalPortal';
import { WorkflowButton, workflowDialogStyle, workflowHeaderStyle } from './WorkflowControls';
import { useSessionBranchStatus } from '../hooks/useSessionBranchStatus';
import type { BranchSession } from './SessionBranchDialog';

export const SessionBranchStatusDialog: React.FC<{ session: BranchSession; focusTarget?: HTMLElement; onClose: () => void }> = ({ session, focusTarget, onClose }) => {
  const check = useSessionBranchStatus(session.id, session.execKey || 'local');
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(focusTarget || document.activeElement as HTMLElement | null);
  useEffect(() => () => { requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }); }, []);
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31100, display: 'grid', placeItems: 'center', padding: 12, background: '#0007' }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label="分支状态" style={{ ...workflowDialogStyle,
      width: 'min(580px, 100%)', maxHeight: 'calc(100dvh - 24px)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: 'var(--theme-panel-solid, var(--theme-bg-secondary, white))', color: 'var(--theme-text, #273244)' }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header style={workflowHeaderStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>分支状态</h2>
          <div style={{ color: 'var(--theme-text-muted)', fontSize: 12, overflowWrap: 'anywhere' }}>{session.title}</div>
        </div>
        <WorkflowButton icon="refresh" disabled={check.loading} onClick={check.refresh}>重新检查</WorkflowButton>
        <WorkflowButton autoFocus tone="quiet" icon="close" aria-label="关闭分支状态" onClick={onClose} />
      </header>
      <div style={{ padding: '8px 18px 16px', overflowY: 'auto', minHeight: 100 }} aria-busy={check.loading}>
        {check.loading && <p role="status">正在检查分支状态…</p>}
        {check.notice && <p role="status" style={{ overflowWrap: 'anywhere', color: 'var(--theme-text-muted)' }}>{check.notice}</p>}
        {check.rows.length > 0 && <>
          <p style={{ margin: '4px 0 12px', fontSize: 11, color: 'var(--theme-text-muted)' }}>
            检查于 {new Date(check.checkedAt * 1000).toLocaleTimeString()} · 以下为本次检查结果
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {check.rows.map(({ tip, badge }) => <li key={tip.sessionId} style={{ padding: '10px 0', borderTop: '1px solid var(--theme-border)', overflowWrap: 'anywhere' }}>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>{tip.title}{tip.main ? ' · 主 Session' : ''}</strong>
                <span style={{ fontSize: 12, color: badge.tone === 'warning' ? 'var(--theme-warning, #b7791f)' : 'var(--theme-text-muted)' }}>{badge.label}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 3 }}>{tip.branch || '分支待核对'}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 3 }}>{badge.detail}</div>
            </li>)}
          </ul>
        </>}
      </div>
    </div>
  </div></AppModalPortal>;
};
