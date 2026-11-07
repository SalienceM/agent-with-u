import { WorkflowButton, workflowNavStyle, workflowFieldStyle, workflowNoticeStyle } from './WorkflowControls';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ProjectMerge } from '../types/taskWorkspaces';
import type { CollaborationSummary } from '../types/sessionCollaboration';
import { useCollaborationRead } from '../hooks/useCollaborationRead';
import { uuid } from '../utils/uuid';

const labels: Record<string, string> = { preview: '待确认准备', blocked: '需要处理', preparing: '准备中', conflict: '待解决冲突', candidate: '候选待核对/应用', applying: '应用中', succeeded: '已完成', unknown: '结果未知', error: '失败', cancelled: '已取消' };
interface Props { session: string; executor: string; onOpenSession?: (id: string) => void }
export const ProjectMergePanel: React.FC<Props> = ({ session, executor, onOpenSession }) => {
  const [history, setHistory] = useState<CollaborationSummary[]>([]), [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState(''), [row, setRow] = useState<ProjectMerge>(), [revision, setRevision] = useState(0), [nonce, setNonce] = useState(0);
  const [items, setItems] = useState<Array<{ id: string; title: string; workingDir: string }>>([]);
  const [source, setSource] = useState(''), [target, setTarget] = useState(''), [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [unknown, setUnknown] = useState(false);
  const identity = `${executor}:${session}`, current = useRef(identity); current.current = identity;
  const running = useRef(false);
  useEffect(() => api.onProjectMergeUpdated((value, node) => { if (node === executor && value.sourceSessionId === session) setRevision(n => n + 1); }), [session, executor]);
  useCollaborationRead(`${identity}:merges`, revision, true, () => api.collaborationList(session, executor, 'merge'),
    value => { setHistory(old => [...value.items, ...old.filter(row => !value.items.some(item => item.id === row.id))]); setNext(value.nextOffset); }, e => setNotice(String(e)));
  useCollaborationRead(`${identity}:merge:${selected}:${nonce}`, history.find(item => item.id === selected)?.revision || 0, !!selected,
    () => api.projectMergeStatus(session, executor, selected), value => { setRow(value); setUnknown(false); }, e => setNotice(String(e)));
  const run = async (operation: () => Promise<void>) => {
    if (running.current) return; running.current = true; setBusy(true); setNotice('');
    try { await operation(); } catch (e) { if (current.current === identity) setNotice(String(e)); }
    finally { running.current = false; if (current.current === identity) setBusy(false); }
  };
  const discover = () => void run(async () => { const result = await api.projectMergeDiscover(session, executor, query); if (current.current === identity) { setItems(result.items); if (result.truncated) setNotice('候选较多，请输入名称缩小范围。'); } });
  const preview = () => void run(async () => {
    const result = await api.projectMergePreview(session, executor, source, target, uuid());
    if (current.current === identity) { setRow(result); setSelected(result.id); setRevision(n => n + 1); setUnknown(false); }
  });
  const action = (name: 'Prepare' | 'Verify' | 'Apply' | 'Cancel' | 'Start') => void run(async () => {
    if (!row || unknown) return; setUnknown(true);
    try {
      const result = await api.projectMergeAction(session, executor, name, row, uuid());
      if (current.current !== identity) return;
      setRow(result); setUnknown(false); setRevision(n => n + 1);
      if (name === 'Start' && result.integration) onOpenSession?.(result.integration.sessionId);
    } catch (e) { if (current.current === identity) setNotice(`接收结果待核对；没有重发。请核对原操作。${String(e)}`); }
  });
  return <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
    <nav aria-label="汇合历史" style={{ ...workflowNavStyle, width: 'clamp(85px, 24%, 230px)', overflow: 'auto', flexShrink: 0 }}>
      <WorkflowButton onClick={() => { setSelected(''); setRow(undefined); setUnknown(false); }}>新建汇合</WorkflowButton>
      {history.map(item => <WorkflowButton tone="quiet" key={item.id} disabled={busy} aria-pressed={selected === item.id} style={{ display: 'block', width: '100%', padding: 8, overflowWrap: 'anywhere' }} onClick={() => { setSelected(item.id); setUnknown(false); }}>{item.title} · {labels[item.status || ''] || item.status}</WorkflowButton>)}
      {next !== null && <WorkflowButton disabled={busy} onClick={() => void run(async () => { const result = await api.collaborationList(session, executor, 'merge', next); if (current.current === identity) { setHistory(old => [...old, ...result.items.filter(item => !old.some(row => row.id === item.id))]); setNext(result.nextOffset); } })}>更多汇合</WorkflowButton>}
    </nav>
    <section style={{ minWidth: 0, flex: 1, overflow: 'auto', padding: 20, overflowWrap: 'anywhere' }}>
      {!selected ? <>
        <p>选择同节点、同仓库的独立来源和目标。先在整合目录准备，确认后才快进目标。</p>
        <label style={{ display: 'block', marginBottom: 8 }}>查找会话<input value={query} onChange={e => setQuery(e.target.value)} style={workflowFieldStyle} /></label><WorkflowButton disabled={busy} onClick={discover}>发现项目会话</WorkflowButton>
        {(['source', 'target'] as const).map(side => <label key={side} style={{ display: 'block', margin: '12px 0' }}>{side === 'source' ? '来源会话' : '目标会话'}
          <select aria-label={side === 'source' ? '来源会话' : '目标会话'} style={workflowFieldStyle} value={side === 'source' ? source : target} onChange={e => side === 'source' ? setSource(e.target.value) : setTarget(e.target.value)}>
            <option value="">请选择真实会话</option>{items.map(item => <option key={item.id} value={item.id}>{item.title} · {item.id} · {item.workingDir}</option>)}
          </select></label>)}
        <WorkflowButton tone="primary" disabled={busy || !source || !target || source === target} onClick={preview}>预览汇合计划</WorkflowButton>
      </> : row?.id === selected ? <>
        <h3>{row.title} · {labels[row.status] || row.status}</h3>
        <p>来源：{row.source.title} · {row.source.head.slice(0, 12)}<br />目标：{row.target.title} · {row.target.head.slice(0, 12)}</p>
        <p>{row.policy}</p>
        <details><summary>目录、运行配置与冻结范围（{row.files.length} 个文件）</summary>
          <p>来源：{row.source.root}<br />目标：{row.target.root}</p>
          <p>整合 Backend：{row.integrationConfig.backendId} · {row.integrationConfig.model || '默认模型'} · 保留执行确认</p>
          {row.files.map(file => <div key={file}>{file}</div>)}
        </details>
        {row.blockers.map((text, i) => <p key={i}>{text}</p>)}
        {row.notice && <p>{row.notice}</p>}
        <p>{row.verification.notice}</p>
        {row.integration && <>
          <p>整合目录：{row.integration.root}</p>
          {row.integration.conflicts.map(file => <div key={file}>冲突：{file}</div>)}
          <WorkflowButton disabled={!onOpenSession} onClick={() => onOpenSession?.(row.integration!.sessionId)}>打开整合会话</WorkflowButton>
          {['candidate', 'conflict'].includes(row.status) && !row.startRequestId && <WorkflowButton disabled={busy || unknown} onClick={() => action('Start')}>启动冲突修复与验证</WorkflowButton>}
        </>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 12 }}>
          {row.status === 'preview' && <WorkflowButton disabled={busy || unknown} onClick={() => action('Prepare')}>确认准备独立整合空间</WorkflowButton>}
          {['candidate', 'conflict'].includes(row.status) && <WorkflowButton disabled={busy || unknown} onClick={() => action('Verify')}>核对实际 Git 候选</WorkflowButton>}
          {row.status === 'candidate' && row.verification.head === row.candidate && <WorkflowButton disabled={busy || unknown} onClick={() => action('Apply')}>确认快进应用到目标</WorkflowButton>}
          {!['applying', 'preparing', 'unknown', 'succeeded', 'cancelled'].includes(row.status) && <WorkflowButton disabled={busy || unknown} onClick={() => action('Cancel')}>取消后续汇合（保留成果）</WorkflowButton>}
          <WorkflowButton disabled={busy} onClick={() => setNonce(n => n + 1)}>核对原操作</WorkflowButton>
          {['blocked', 'error', 'cancelled'].includes(row.status) && <WorkflowButton disabled={busy} onClick={() => { setSource(row.source.sessionId); setTarget(row.target.sessionId); setSelected(''); setRow(undefined); setUnknown(false); }}>返回选择并重新预览</WorkflowButton>}
        </div>
        {row.finalHead && <p>最终提交：{row.finalHead}</p>}
      </> : <p>正在读取原操作…</p>}
      {notice && <p role="status" style={workflowNoticeStyle}>{notice}</p>}
    </section>
  </div>;
};
