import React, { useRef, useState } from 'react';
import { api } from '../api';
import { uuid } from '../utils/uuid';
import { SessionHistory } from './SessionHistory';
import { WorkflowButton, WorkflowIcon } from './WorkflowControls';
import type { useSessionRenewal } from '../hooks/useSessionRenewal';

export const ArchivedSessionNotice: React.FC<{ session: any; onOpenSession?: (id: string) => void; renewal?: ReturnType<typeof useSessionRenewal> }> = ({ session, onOpenSession, renewal }) => {
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [error, setError] = useState('');
  const request = useRef('');
  const restore = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = unknown ? await api.sessionArchiveStatus(session.id, session.execKey)
        : await api.sessionArchiveRestore(session.id, session.archiveRevision || 0, request.current ||= uuid(), session.execKey);
      setUnknown(false); request.current = '';
      if (result.status !== 'ok') setError(result.message || '归档状态已变化，请核对后重试。');
      else if (unknown && result.session?.isArchived) setError('会话仍已归档，可再次点击恢复。');
    } catch (cause: any) {
      setUnknown(!cause?.notSubmitted);
      setError(cause?.notSubmitted ? cause.message : '恢复结果尚未确认，请核对状态。');
    } finally { setBusy(false); }
  };
  return <section aria-label="已归档会话" style={{ borderTop: '1px solid var(--theme-border)', background: 'var(--theme-panel-solid, #fff)', padding: '14px 18px', fontSize: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <WorkflowIcon name="history" size={20} />
      <div style={{ flex: 1, minWidth: 150 }}><strong>已归档 · 仅供查阅</strong><div style={{ color: 'var(--theme-text-muted)', marginTop: 3 }}>聊天记录和草稿已保留，恢复归档后可继续对话。</div></div>
      <SessionHistory sessionId={session.id} executor={session.execKey || 'local'} onOpenSession={onOpenSession} />
      <WorkflowButton disabled={busy} onClick={() => void restore()}>{busy ? '正在核对…' : unknown ? '核对归档状态' : '恢复归档'}</WorkflowButton>
    </div>
    {error && <p role="alert" style={{ marginBottom: 0, color: 'var(--theme-text-muted)' }}>{error}</p>}
    {renewal?.unknown && <div style={{ marginTop: 10 }}>
      <p role="status">{renewal.message}</p>
      <WorkflowButton disabled={renewal.busy} onClick={() => void renewal.start()}>核对结果</WorkflowButton>
      {renewal.retryable && <WorkflowButton disabled={renewal.busy} onClick={() => void renewal.start(true)}>继续开启同一新会话</WorkflowButton>}
    </div>}
  </section>;
};
