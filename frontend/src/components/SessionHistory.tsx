import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useVisibleSessionCandidates } from '../hooks/useSessionVisibility';
import { WorkflowButton, WorkflowPopover, workflowNoticeStyle } from './WorkflowControls';

interface Props { sessionId: string; executor: string; onOpenSession?: (id: string) => void }

export const SessionHistory: React.FC<Props> = ({ sessionId, executor, onOpenSession }) => {
  const [open, setOpen] = useState(false), [rows, setRows] = useState<any[]>([]);
  const [next, setNext] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [logs, setLogs] = useState<any>(null), [logBusy, setLogBusy] = useState(false), [logError, setLogError] = useState('');
  const identity = `${executor}:${sessionId}`, scope = useRef(identity); scope.current = identity;
  const generation = useRef(0), visible = useVisibleSessionCandidates(rows);
  const load = async (offset = 0) => {
    const turn = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await api.sessionHistory(sessionId, offset, executor);
      if (scope.current !== identity || turn !== generation.current) return;
      if (result.status !== 'ok') throw new Error(result.message || '无法读取会话历史');
      setRows(previous => offset ? [...new Map([...previous, ...result.items].map(row => [row.id, row])).values()] : result.items);
      setNext(result.nextOffset);
    } catch (e: any) { if (scope.current === identity && turn === generation.current) setError(e.message || '无法读取会话历史'); }
    finally { if (scope.current === identity && turn === generation.current) setBusy(false); }
  };
  useEffect(() => {
    setRows([]); setLogs(null); setLogError(''); setNext(null);
    if (open) void load();
    return () => { generation.current++; };
  }, [open, identity]);
  const readLogs = async () => {
    setLogBusy(true); setLogError('');
    try {
      const result = await api.sessionNativeLogLocation(sessionId, executor);
      if (scope.current === identity) setLogs(result);
    } catch (e: any) { if (scope.current === identity) setLogError(e.message || '无法读取日志位置'); }
    finally { if (scope.current === identity) setLogBusy(false); }
  };
  return <WorkflowPopover label="会话历史" title="历史" icon="history" open={open} onOpenChange={setOpen} width={400}>
    <div style={{ color: 'var(--theme-text-muted)', marginBottom: 12 }}>同目录开启的新会话会留在这里。点击即可回看，原记录完整保留。</div>
    {error && <div role="alert" style={workflowNoticeStyle}>{error} <WorkflowButton onClick={() => void load()}>重试</WorkflowButton></div>}
    <ol aria-label="会话时间轴" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {visible.map(row => <li key={row.id} style={{ paddingLeft: 12, borderLeft: '2px solid var(--theme-border)', marginLeft: 3, paddingBottom: 8 }}>
        <button type="button" aria-current={row.id === sessionId ? 'page' : undefined}
          disabled={!onOpenSession && row.id !== sessionId} onClick={() => { setOpen(false); if (row.id !== sessionId) onOpenSession?.(row.id); }}
          style={{ width: '100%', textAlign: 'left', display: 'grid', gap: 3, padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--theme-border)', cursor: 'pointer', font: 'inherit', color: 'var(--theme-text)',
            background: row.id === sessionId ? 'var(--theme-accent-bg)' : 'transparent' }}>
          <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{new Date(row.createdAt * 1000).toLocaleString('zh-CN', { hour12: false })}{row.id === sessionId ? ' · 当前' : ''}</span>
          <span style={{ overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{row.title || '会话'}</span>
          <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{row.messageCount || 0} 条消息{row.isPrivate ? ' · 私密' : ''}</span>
        </button>
      </li>)}
    </ol>
    {busy && <p role="status">正在读取…</p>}
    {!busy && !error && !visible.length && <p>暂无可显示的会话。</p>}
    {next != null && <WorkflowButton disabled={busy} onClick={() => void load(next)}>更早的会话</WorkflowButton>}
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--theme-border)' }}>
      <WorkflowButton tone="quiet" icon="block" disabled={logBusy} onClick={() => logs ? setLogs(null) : void readLogs()}>DSH 原始日志位置</WorkflowButton>
      {logError && <div role="alert" style={workflowNoticeStyle}>{logError}</div>}
      {logs?.status === 'unsupported' && <p style={workflowNoticeStyle}>当前会话未使用 DSH。</p>}
      {logs?.status === 'ok' && <div style={{ ...workflowNoticeStyle, marginBottom: 0 }}>
        <p style={{ marginTop: 0 }}>以下路径位于此会话的执行节点。原始日志为 JSONL，部分文件使用 Zstandard 压缩（.zst）。{!logs.exists && ' 当前尚未生成原生日志。'}</p>
        {([
          ['原生会话 ID', logs.nativeId || '尚未创建'], ['会话日志目录', logs.sessionsPath],
          ['当前绑定', logs.bindingPath], ['旧绑定目录', logs.archivedBindingsPath], ['AWU 运行日志', logs.backendLogPath],
        ] as [string, string][]).map(([label, value]) => <label key={label} style={{ display: 'block', marginTop: 8 }}>{label}
          <input aria-label={label} readOnly value={value} onFocus={e => e.target.select()}
            style={{ width: '100%', boxSizing: 'border-box', minWidth: 0, padding: 6, color: 'var(--theme-text)', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, fontSize: 11 }} />
        </label>)}
        <p style={{ marginBottom: 0 }}>切换到某条历史会话后，可查看它的日志位置。旧绑定用于定位此前清理过的原生日志。</p>
      </div>}
    </div>
  </WorkflowPopover>;
};
