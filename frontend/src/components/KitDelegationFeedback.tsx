import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { api, getCurrentUserProfile, getSessionExecKey, onCurrentUserChanged } from '../api';
import { delegationLabel, kitDelegations, openKitReceipt } from '../utils/kitDelegationFeedback';
import { WorkflowButton, WorkflowPopover, workflowNoticeStyle } from './WorkflowControls';

export const KitDelegationBadge: React.FC<{ sessionId: string; messageId: string }> = ({ sessionId, messageId }) => {
  useSyncExternalStore(kitDelegations.subscribe, kitDelegations.snapshot);
  const executor = getSessionExecKey(sessionId) || 'local';
  const row = kitDelegations.get(executor, sessionId, messageId);
  const [notice, setNotice] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    if (!row?.expiresAt || !['accepted', 'bound'].includes(row.status)) return;
    const timer = setTimeout(() => tick(n => n + 1), Math.max(0, row.expiresAt * 1000 - Date.now()) + 5);
    return () => clearTimeout(timer);
  }, [row?.expiresAt, row?.status]);
  if (!row) return null;
  return <details style={{ fontSize: 11, marginTop: 6 }}>
    <summary>Kit 代确认 · {delegationLabel(row)}{row.runStatus === 'waiting_approval' ? ' · 等待核对' : ''}</summary>
    <div>{row.reason}{notice}</div>
    {row.expiresAt && <div>本次截止 {new Date(row.expiresAt * 1000).toLocaleString()}</div>}
    {row.runId && <WorkflowButton onClick={() => openKitReceipt(executor, row)}>查看原运行 / 步骤</WorkflowButton>}
    {['unknown', 'awaiting', 'accepted'].includes(row.status) && <WorkflowButton onClick={() => {
      void api.kitDelegationList(sessionId, executor).then(() => setNotice('已核对执行器回执。')).catch(() => setNotice('核对失败，请保持原请求，勿重复发送。'));
    }}>核对回执</WorkflowButton>}
  </details>;
};

/** 每 Session 一次重连读取；徽标共享紧凑缓存，不逐气泡请求。 */
export const KitDelegationStatus: React.FC<{ sessionId: string; executor: string; compact?: boolean }> = ({ sessionId, executor, compact = false }) => {
  useSyncExternalStore(kitDelegations.subscribe, kitDelegations.snapshot);
  const prefKey = () => `awu:kit-reminder:${getCurrentUserProfile().userId}`;
  const readPref = () => { try { return localStorage.getItem(prefKey()) !== 'off'; } catch { return true; } };
  const [remind, setRemind] = useState(readPref);
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [sessionId, executor]);
  useEffect(() => onCurrentUserChanged(() => setRemind(readPref())), []);
  useEffect(() => {
    let active = true;
    const refresh = () => { void api.kitDelegationList(sessionId, executor).then(() => { if (active) setNotice(''); }).catch(() => { if (active) setNotice('委托回执暂不可核对'); }); };
    refresh();
    let wasConnected = true;
    const off = api.onSessionConnectionStatus(sessionId, connected => { if (connected && !wasConnected) refresh(); wasConnected = connected; });
    return () => { active = false; off(); };
  }, [sessionId, executor]);
  const waiting = kitDelegations.waitingRuns(executor || 'local', sessionId);
  const content = <div style={{ fontSize: 12, display: 'flex', alignItems: 'stretch', flexDirection: 'column', gap: 10 }}>
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}><input type="checkbox" style={{ accentColor: 'var(--theme-accent, #4b82f0)', width: 15, height: 15, margin: 0 }} checked={remind} onChange={e => {
      setRemind(e.target.checked); try { localStorage.setItem(prefKey(), e.target.checked ? 'on' : 'off'); } catch { /* 仅提醒偏好 */ }
    }} />提醒 Kit 待确认</label>
    {compact && <p style={{ color: 'var(--theme-text-muted)', margin: 0 }}>仅记住提醒偏好。代确认仍由每次发送前的独立开关决定。</p>}
    {remind && waiting.map(row => <WorkflowButton key={row.id} onClick={() => { setOpen(false); openKitReceipt(executor, row); }}>Kit 等待确认 · 查看步骤</WorkflowButton>)}
    {notice && <span role="status" style={workflowNoticeStyle}>{notice}</span>}
  </div>;
  return compact ? <WorkflowPopover label="Kit 提醒设置" title="提醒" icon="bell" badge={remind && waiting.length ? waiting.length : undefined}
    warning={remind && waiting.length > 0} open={open} onOpenChange={setOpen}>{content}</WorkflowPopover> : content;
};
