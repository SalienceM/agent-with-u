import React, { useState } from 'react';
import { SessionBranchDialog, type BranchSession } from './SessionBranchDialog';
import { WorkflowButton } from './WorkflowControls';

export const MergeSessionNotice: React.FC<{ session: BranchSession; onOpenSession?: (id: string) => void }> = ({ session, onOpenSession }) => {
  const [open, setOpen] = useState(false);
  return <div style={{ padding: '6px 12px', background: 'var(--theme-bg-secondary)', fontSize: 12 }}>
    此会话是合并的独立处理空间，完成后成果保留在合并历史。
    <WorkflowButton tone="quiet" onClick={() => setOpen(true)}>返回合并记录</WorkflowButton>
    {open && <SessionBranchDialog session={session} action="merge" onClose={() => setOpen(false)} onOpenSession={id => onOpenSession?.(id)} />}
  </div>;
};
