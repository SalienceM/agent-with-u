import React, { useContext, useEffect, useState } from 'react';
import { api, getCurrentUserProfile, onCurrentUserChanged } from '../api';
import type { MergeRepairSnapshot, ProjectMerge } from '../types/taskWorkspaces';
import { AppModalVisibilityContext } from './AppModalPortal';
import { PermissionGate } from './PermissionGate';
import { UserInteractionsPanel } from './UserInteractionsPanel';
import { WorkflowButton, workflowNoticeStyle } from './WorkflowControls';

const labels: Record<string, string> = { idle: '需要解决冲突或补充验证', running: '正在修复并生成候选提交', unknown: '运行状态待核对', needs_attention: '仍需处理', failed: '修复未完成', ready: '候选提交已核对' };
interface Props { session: string; executor: string; row: ProjectMerge; disabled: boolean; active: boolean; onStart: () => void }

/** 仅承载本次修复，不挂载普通聊天的自动续跑、发送输入及全量工作台。 */
export const ProjectMergeRepair: React.FC<Props> = ({ session, executor, row, disabled, active, onStart }) => {
  const visible = useContext(AppModalVisibilityContext);
  const [owner, setOwner] = useState(getCurrentUserProfile().userId);
  const [snapshot, setSnapshot] = useState<MergeRepairSnapshot>();
  const [notice, setNotice] = useState(''), [liveText, setLiveText] = useState('');
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(true);
  const child = row.integration!.sessionId;
  useEffect(() => onCurrentUserChanged(() => { setOwner(getCurrentUserProfile().userId); setSnapshot(undefined); setLiveText(''); }), []);
  useEffect(() => {
    if (!visible || !active) return;
    let mounted = true, reading = false, again = false, frame = 0, text = '';
    const current = () => mounted && getCurrentUserProfile().userId === owner;
    const read = async () => {
      if (!current() || document.visibilityState === 'hidden') return;
      if (reading) { again = true; return; }
      reading = true; setLoading(true);
      try {
        const value = await api.projectMergeRepairRead(session, executor, row.id);
        if (current() && value.sessionId === child && value.operationId === row.id) {
          setSnapshot(value); setNotice('');
          if (value.repair.status !== 'running') { text = ''; setLiveText(''); }
        }
      } catch (error) { if (current()) setNotice(`修复记录读取失败：${String(error)}`); }
      finally { reading = false; if (current()) { setLoading(false); if (again) { again = false; void read(); } } }
    };
    const offStream = api.onStreamDelta(delta => {
      if (!current() || document.visibilityState === 'hidden' || delta.executor !== executor || delta.sessionId !== child) return;
      if (delta.type === 'done') { void read(); return; }
      // 忽略思考与大工具载荷，仅缓存有界可见进度；每帧至多渲染一次。
      if (delta.type === 'text_delta' && typeof delta.text === 'string') text = (text + delta.text).slice(-12000);
      else if (delta.type === 'tool_start') text = (text + '\n正在执行：' + String(delta.toolCall?.name || '工具') + '\n').slice(-12000);
      else return;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (current()) setLiveText(text); });
    });
    const offPermission = api.onPermissionRequest(value => {
      if (current() && value.executor === executor && value.sessionId === child) void read();
    });
    const offActivity = api.onSessionUpdated(value => {
      if (current() && value.execKey === executor && value.sessionId === child && value.type === 'merge_activity') void read();
    });
    const offConnection = api.onExecutorConnectionStatus(executor, connected => {
      if (!current()) return;
      if (connected) void read(); else { setNotice('执行节点离线，保留原修复；重连后只核对状态。'); setSnapshot(undefined); }
    });
    const returned = () => { void read(); };
    document.addEventListener('visibilitychange', returned);
    void read();
    return () => { mounted = false; cancelAnimationFrame(frame); offStream(); offPermission(); offActivity(); offConnection(); document.removeEventListener('visibilitychange', returned); };
  }, [owner, session, executor, row.id, row.revision, child, visible, active, reload]);
  const repair = snapshot && snapshot.revision >= row.revision ? snapshot.repair : row.repair;
  const own = row.sourceSessionId === session;
  return <section aria-label="合并修复" style={{ border: '1px solid var(--theme-border)', borderRadius: 10, padding: 16, margin: '14px 0', minWidth: 0 }}>
    <strong>{labels[repair?.status || 'idle']}</strong>
    <p style={{ color: 'var(--theme-text-muted)', fontSize: 13 }}>{['succeeded', 'cancelled'].includes(row.status) ? '本次修复记录已保留，可在这里回看执行结果。' : '在本请求内完成冲突处理、验证和候选提交。目标分支将在你确认合并后更新。'}</p>
    {repair?.notice && <p role="status">{repair.notice}</p>}
    {own && ['conflict', 'candidate'].includes(row.status) && !['ready', 'running', 'unknown'].includes(repair?.status || '') && <WorkflowButton tone="primary"
      style={{ minHeight: 36, padding: '8px 14px' }} disabled={disabled || loading || !repair?.canStart || !!notice} onClick={onStart}>{row.startRequestId ? '继续修复与验证' : '开始修复与验证'}</WorkflowButton>}
    <WorkflowButton tone="quiet" style={{ minHeight: 36, padding: '8px 14px' }} disabled={loading} onClick={() => setReload(value => value + 1)}>刷新修复记录</WorkflowButton>
    {notice && <p role="status" style={workflowNoticeStyle}>{notice}</p>}
    {snapshot && own && !notice && active && visible && <>
      {snapshot.permission && <PermissionGate key={snapshot.permission.requestId} request={{ ...snapshot.permission, allowSkip: false }}
        onDismiss={() => { setSnapshot(old => old ? { ...old, permission: null } : old); setReload(value => value + 1); }} onSkipRest={() => {}}
        onGrant={async granted => { await api.projectMergeRepairPermission(session, executor, row.id, snapshot.permission!.requestId || '', granted); }} />}
      <UserInteractionsPanel key={`${owner}:${executor}:${child}`} sessionId={child} executor={executor} />
    </>}
    {liveText && <pre aria-label="当前修复进度" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto', fontSize: 12 }}>{liveText}</pre>}
    {!!snapshot?.messages.length && <details open={repair?.status === 'failed' || repair?.status === 'needs_attention'} style={{ marginTop: 12 }}>
      <summary style={{ cursor: 'pointer' }}>修复执行记录{snapshot.truncated ? '（近期内容）' : ''}</summary>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>{snapshot.messages.filter(message => message.role === 'assistant').map(message =>
        <pre key={message.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{message.content}</pre>)}</div>
    </details>}
  </section>;
};
