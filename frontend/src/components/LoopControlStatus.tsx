import React, { useEffect, useState } from 'react';
import { useLoopControl } from '../hooks/useLoopControl';

const phases: Record<string, string> = {
  validating: '正在核对条件', snapshot: '正在保存工作区快照', manual_record: '正在整理人工记录',
  committing: '正在提交控制权切换', recovery: '正在核对上次转交',
};
const buttonStyle: React.CSSProperties = { padding: '6px 10px', border: '1px solid var(--theme-border)',
  borderRadius: 6, background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer', minHeight: 32 };

export const LoopControlStatus: React.FC<{
  sessionId: string; execKey?: string; onReload?: () => void; onQueue?: () => void; onChat?: () => void;
}> = ({ sessionId, execKey, onReload, onQueue, onChat }) => {
  const control = useLoopControl(sessionId, execKey, false);
  const { state } = control;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!control.busy || state.phase === 'view-error') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000); // 仅本地计时，不请求服务端。
    return () => clearInterval(timer);
  }, [control.busy, state.phase, state.since]);
  if (state.phase === 'idle' && !state.error) return null;
  const summary = state.summary;
  const operation = summary?.operation?.requestId === state.requestId ? summary?.operation : undefined;
  const action = state.action === 'release' ? '交还 LOOP' : '人工接管';
  const elapsed = Math.max(0, Math.floor((now - (state.since || now)) / 1000));
  const phaseElapsed = operation?.updatedAt ? now / 1000 - operation.updatedAt : elapsed;
  const title = state.phase === 'sending' ? `正在申请${action}…`
    : state.phase === 'reconciling' ? '转交结果待确认，请检查状态'
    : state.phase === 'view-error' ? '切换已完成，界面加载失败'
    : state.phase === 'view-loading' ? `已${action}，正在加载${summary?.controlMode === 'manual' ? '聊天' : 'LOOP 面板'}…`
    : state.phase === 'succeeded' ? (summary?.controlMode === 'manual' ? '已人工接管' : '已交还 LOOP')
      + (summary?.auto ? '，Auto 当前开启' : '，Auto 仍关闭')
    : state.phase === 'running' ? `${phases[operation?.phase || ''] || '执行端正在处理'}…`
    : `${action}未完成`;
  const reason = summary?.eligibility[state.action || 'takeover'];
  return <section data-testid="loop-control-status" role={['failed', 'blocked', 'view-error'].includes(state.phase) ? 'alert' : 'status'}
    aria-live="polite" style={{ flexShrink: 0, padding: '10px 14px', borderBottom: '1px solid #d2992255',
      background: '#d2992210', fontSize: 12, color: 'var(--theme-text)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    <div style={{ flex: '1 1 220px' }}>
      <strong>{title}</strong>
      {control.busy && state.phase !== 'view-error' && <span> · 已用 {elapsed} 秒{phaseElapsed >= 5 ? ' · 耗时较长，仍在等待确定结果' : ''}</span>}
      {state.error && <div>{state.error}</div>}
      {summary?.protocolVersion === 0 && <div>旧执行端不支持阶段详情；仅核对当前控制权。</div>}
      {operation?.checkpointAvailable === false && operation.committed && <div>文件检查点不可用，不能依赖它恢复。</div>}
      {state.phase === 'succeeded' && summary?.controlMode === 'loop' && <div>交还本身未启动模型。可在面板独立选择运行下一次或开启 Auto。</div>}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <button style={buttonStyle} disabled={state.checking} onClick={() => void control.check()}>{state.checking ? '正在核对…' : '检查状态'}</button>
      {['failed', 'blocked'].includes(state.phase) && <button style={buttonStyle} disabled={!reason?.allowed}
        onClick={() => void control.retry()}>重新申请</button>}
      {state.phase === 'view-error' && onReload && <button style={buttonStyle} onClick={onReload}>重试加载{summary?.controlMode === 'manual' ? '聊天' : 'LOOP 面板'}</button>}
      {reason?.nextStep === 'queue' && onQueue && <button style={buttonStyle} onClick={onQueue}>查看队列</button>}
      {reason?.nextStep === 'chat' && onChat && <button style={buttonStyle} onClick={onChat}>返回聊天</button>}
    </div>
  </section>;
};
