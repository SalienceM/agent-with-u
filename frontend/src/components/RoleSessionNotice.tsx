import React from 'react';
import { WorkflowButton } from './WorkflowControls';

/** 评议子会话是历史视图，不能套用普通聊天的空态和发送提示。 */
export const RoleSessionNotice: React.FC<{ empty?: boolean; onReturn?: () => void }> = ({ empty = false, onReturn }) =>
  <section aria-label="角色评议记录" style={{ padding: empty ? 24 : '12px 16px', margin: empty ? 20 : 0,
    maxWidth: empty ? 460 : undefined, borderRadius: empty ? 14 : 0, background: 'var(--theme-panel-solid, var(--theme-bg-secondary, #161d29))',
    color: 'var(--theme-text, #e5eaf3)', border: '1px solid var(--theme-border)', lineHeight: 1.7 }}>
    <strong style={{ fontSize: empty ? 17 : 13 }}>{empty ? '这里还没有评议内容' : '角色评议记录'}</strong>
    <p style={{ fontSize: 13, color: 'var(--theme-text-muted)', margin: '8px 0 12px' }}>{empty
      ? '评议尚未产生记录，可能还未开始或启动失败。请回到来源对话，在“评议”中查看状态并重新发起。'
      : '这里保存该角色的历史与产出。选择回答、发起评议和引用意见，都在来源对话中完成。'}</p>
    {onReturn && <WorkflowButton tone="primary" onClick={onReturn}>返回来源对话</WorkflowButton>}
  </section>;
