import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { ProjectTasksPanel } from './ProjectTasksPanel';
import { AppModalPortal } from './AppModalPortal';
import { WorkflowButton, workflowDialogStyle } from './WorkflowControls';

export interface BranchSession {
  id: string; title: string; backendId: string; execKey?: string; parentSessionId?: string;
  relationKind?: string; workspaceId?: string;
}

export const SessionBranchDialog: React.FC<{ session: BranchSession; action: 'create' | 'manage' | 'merge';
  onClose: () => void; onOpenSession: (id: string) => void }> = ({ session, action, onClose, onOpenSession }) => {
  const [backends, setBackends] = useState<any[]>(), [error, setError] = useState(''), [nonce, setNonce] = useState(0);
  const executor = session.execKey || 'local';
  useEffect(() => {
    let live = true; setError('');
    api.getBackends(executor).then(value => { if (live) setBackends(value); }, e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [executor, session.id, nonce]);
  if (backends) return <ProjectTasksPanel session={session.id} executor={executor} backendId={session.backendId} backends={backends}
    initialAction={action} workspaceId={session.workspaceId} mergeTarget={session.relationKind === 'task' ? session.parentSessionId : undefined}
    canCreate={!session.parentSessionId && !session.relationKind && !session.workspaceId} onClose={onClose} onOpenSession={onOpenSession} />;
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31100, display: 'grid', placeItems: 'center', padding: 12, background: '#0007' }}>
    <div role="dialog" aria-modal="true" aria-label="分支副本" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
      style={{ ...workflowDialogStyle, padding: 24, maxWidth: '100%', overflowWrap: 'anywhere' }}>
      <p role="status">{error || '正在读取此 Session 所属节点的运行配置…'}</p>
      {error && <WorkflowButton onClick={() => setNonce(n => n + 1)}>重新读取</WorkflowButton>}
      <WorkflowButton autoFocus onClick={onClose}>返回对话</WorkflowButton>
    </div>
  </div></AppModalPortal>;
};
