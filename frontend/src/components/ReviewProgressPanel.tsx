import React, { useEffect, useRef, useState } from 'react';
import type { ReviewProgress } from '../types/sessionCollaboration';

export const ReviewProgressPanel: React.FC<{ progress?: ReviewProgress; status?: string; connected: boolean }> = ({ progress, status, connected }) => {
  const active = ['preparing', 'queued', 'running', 'stopping'].includes(status || '');
  const [now, setNow] = useState(Date.now());
  const output = useRef<HTMLPreElement>(null), follow = useRef(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { if (expanded && follow.current && output.current) output.current.scrollTop = output.current.scrollHeight; }, [progress?.output, expanded]);
  if (!progress && !active) return null;
  const elapsed = progress ? Math.max(0, Math.floor(((active ? now / 1000 : progress.updatedAt) - progress.startedAt))) : 0;
  const last = progress?.lastOutputAt ? Math.max(0, Math.floor(now / 1000 - progress.lastOutputAt)) : null;
  return <section aria-label="评议运行与实时输出" style={{ border: '1px solid var(--theme-border)', borderRadius: 8, padding: 12, margin: '12px 0', minWidth: 0 }}>
    <div role="status" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <strong>{!connected && active ? '连接中断 · 保留最后输出' : status === 'unknown' ? '运行状态待核对'
        : progress?.message || (status === 'queued' ? '等待执行名额' : '等待模型输出')}</strong>
      {progress && <span style={{ color: 'var(--theme-text-muted)', fontSize: 12 }}>已耗时 {elapsed} 秒 · 已获取 {progress.evidenceCount} 条证据</span>}
    </div>
    {active && <p style={{ margin: '8px 0', color: 'var(--theme-text-muted)', fontSize: 12 }}>{last == null ? '尚未收到正文；等待时间不表示已经生成结果。'
      : `最近收到正文：${last} 秒前`}{!connected ? '。重新连接后会核对原任务，不会重复发起。' : last != null && last >= 30 ? '。暂未收到新正文，可核对状态或停止评议。' : ''}</p>}
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary style={{ cursor: 'pointer', padding: '6px 0', color: 'var(--theme-accent)' }}>实时输出 · 第 {progress?.round || 1} 轮 · 已接收 {progress?.outputCharacters || 0} 字</summary>
      <p style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>以下是模型正在生成的正文，尚未完成引文与证据校验；最终意见在校验后单独展示。</p>
      {progress?.roundOutputs?.map(row => <details key={row.round}><summary>第 {row.round} 轮已收到的输出</summary><pre style={textStyle}>{row.output}</pre></details>)}
      <pre ref={output} aria-label="角色实时正文" onScroll={() => { const el = output.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; }} style={textStyle}>{progress?.output || '等待正文输出…'}</pre>
    </details>
    {!!progress?.events.length && <details><summary style={{ cursor: 'pointer', padding: '6px 0', fontSize: 12 }}>运行记录 · {progress.events.length} 项</summary>
      <ol style={{ margin: '4px 0', paddingLeft: 20, fontSize: 12, lineHeight: 1.8 }}>{progress.events.map((event, index) => <li key={`${event.at}:${index}`} style={{ overflowWrap: 'anywhere' }}><span style={{ color: 'var(--theme-text-muted)' }}>{new Date(event.at * 1000).toLocaleTimeString()} </span>{event.message}</li>)}</ol>
    </details>}
  </section>;
};
const textStyle: React.CSSProperties = { maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 10,
  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: 12, lineHeight: 1.65 };
