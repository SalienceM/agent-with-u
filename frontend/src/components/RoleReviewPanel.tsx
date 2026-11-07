import { WorkflowButton, WorkflowEmptyState, workflowHeaderStyle, workflowNavStyle, workflowDialogStyle, workflowNoticeStyle } from './WorkflowControls';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CollaborationSummary, OpinionReference, ReviewBatch, ReviewProgress, ReviewReport } from '../types/sessionCollaboration';
import { AppModalPortal } from './AppModalPortal';
import { useCollaborationRead } from '../hooks/useCollaborationRead';
import { ReviewProgressPanel } from './ReviewProgressPanel';

interface Props { session: string; executor: string; open: boolean; onOpen: () => void; onClose: () => void; latestRequest?: string;
  onReference: (reference: OpinionReference) => void; onOpenSession?: (id: string) => void; onStartReview?: (targetIds?: string[]) => void }
const labels: Record<string, string> = { preparing: '准备中', queued: '排队中', running: '评议中', stopping: '停止中', done: '已完成', completed_with_issues: '已结束 · 有未完成意见', invalid: '意见校验未通过', error: '失败', cancelled: '已停止', unknown: '结果未知' };
const stances = { agree: '同意', partial: '部分同意', disagree: '不同意', unknown: '证据不足' };
export const RoleReviewPanel: React.FC<Props> = ({ session, executor, open, onOpen, onClose, latestRequest, onReference, onOpenSession, onStartReview }) => {
  const [batches, setBatches] = useState<CollaborationSummary[]>([]), [batchId, setBatchId] = useState('');
  const [batch, setBatch] = useState<ReviewBatch>(), [reportId, setReportId] = useState(''), [report, setReport] = useState<ReviewReport>();
  const [claims, setClaims] = useState<string[]>([]), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0);
  const [next, setNext] = useState<number | null>(null), [busy, setBusy] = useState(false);
  const [checkNonce, setCheckNonce] = useState(0);
  const [progress, setProgress] = useState<Record<string, ReviewProgress>>({});
  const [connected, setConnected] = useState(true);
  const identity = useRef(`${executor}:${session}`); identity.current = `${executor}:${session}`;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { setBatches([]); setBatchId(''); setBatch(undefined); setReportId(''); setReport(undefined); setNotice(''); setProgress({}); }, [session, executor]);
  useEffect(() => api.onExecutorConnectionStatus(executor, value => {
    setConnected(value);
    if (value) { setRevision(v => v + 1); setCheckNonce(v => v + 1); }
  }), [session, executor]);
  useEffect(() => api.onReviewUpdated((row, source) => {
    if (source !== executor || row.sourceSessionId !== session) return;
    if (row.kind === 'progress' && row.progress) {
      const latest = row.progress;
      setProgress(old => {
        if ((old[row.id]?.sequence || 0) >= latest.sequence) return old;
        const next = { ...old, [row.id]: { ...old[row.id], ...latest } };
        if (Object.keys(next).length > 32) delete next[Object.keys(next)[0]];
        return next;
      });
      return;
    }
    if (row.kind === 'report') setBatch(old => old && old.id === row.batchId ? { ...old, reportSummaries: old.reportSummaries.map(item => item.id === row.id && row.revision >= item.revision ? { ...item, ...row } : item) } : old);
    setRevision(v => v + 1);
  }), [session, executor]);
  useEffect(() => { if (latestRequest) { if (!open) setBatchId(latestRequest); setRevision(v => v + 1); } }, [latestRequest]);
  useCollaborationRead(`${executor}:${session}:list`, revision, true,
    () => api.collaborationList(session, executor, 'review'),
    result => { setBatches(old => [...result.items, ...old.filter(row => !result.items.some(item => item.id === row.id))]); setNext(result.nextOffset); setBatchId(id => id || result.items[0]?.id || ''); }, error => setNotice(String(error)));
  const selectedRevision = batches.find(row => row.id === batchId)?.revision || 0;
  useCollaborationRead(`${executor}:${session}:batch:${batchId}:${checkNonce}`, selectedRevision, open && !!batchId,
    () => api.reviewStatus(session, executor, batchId),
    row => { setBatch(row); setReportId(id => row.reports.includes(id) ? id : row.reports[0] || '');
      setProgress(old => { const next = { ...old }; for (const item of row.reportSummaries) if (item.progress && (!next[item.id] || item.progress.sequence >= next[item.id].sequence)) next[item.id] = item.progress; return next; });
    }, error => setNotice(String(error)));
  const summary = batch?.reportSummaries.find(row => row.id === reportId);
  useCollaborationRead<ReviewReport>(`${executor}:${session}:report:${reportId}`, summary?.revision || 0,
    open && !!reportId && !!summary && !['preparing', 'queued', 'running', 'stopping'].includes(summary.status || ''),
    () => api.collaborationGet(session, executor, 'report', reportId, summary!.revision), setReport, error => setNotice(String(error)));
  useEffect(() => { setClaims([]); }, [reportId]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { previous?.focus(); };
  }, [open]);
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    const current = identity.current; setBusy(true); setNotice('');
    try { await action(); if (current === identity.current) setRevision(v => v + 1); }
    catch (error) { if (current === identity.current) setNotice(String(error)); }
    finally { if (current === identity.current) setBusy(false); }
  };
  const reference = async (selected: string[]) => {
    if (!report || report.status !== 'done') return;
    const current = identity.current;
    const value = await api.reviewReference(session, executor, report.id, report.revision, selected);
    if (current === identity.current) { onClose(); onReference(value); }
  };
  const latest = batches[0], visible = report?.id === reportId ? report : undefined;
  const disagreement = (visible?.counts?.disagree || 0) + (visible?.counts?.partial || 0) > 0;
  const activeBatch = batch?.id === batchId ? batch : undefined;
  const running = (status?: string) => !!status && ['preparing', 'queued', 'running', 'stopping'].includes(status);
  const start = (targets?: string[]) => { onClose(); onStartReview?.(targets); };
  return <>
    <WorkflowButton tone="quiet" icon="review" aria-label="查看角色评议" onClick={onOpen} title={latest ? `${labels[latest.status || ''] || latest.status} · ${latest.counts?.done || 0}/${latest.counts?.total || 0} 个角色完成${latest.counts?.failed ? ` · ${latest.counts.failed} 个未完成` : ''}` : '查看角色意见、分歧与评议历史'} style={{ whiteSpace: 'nowrap' }}>
      评议{latest && <span style={{ fontSize: 11, color: latest.counts?.disagree || latest.counts?.partial ? 'var(--theme-warning, #b7791f)' : 'var(--theme-text-muted)' }}>
        {latest.status === 'error' ? '· 未能开始' : latest.status === 'unknown' ? '· 待核对' : latest.counts?.failed ? `· ${latest.counts.failed} 个未完成` : latest.counts?.disagree || latest.counts?.partial ? '· 有异议' : `· ${latest.counts?.done || 0}/${latest.counts?.total || 0}`}
      </span>}
    </WorkflowButton>
    {open && <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31000, display: 'grid', placeItems: 'center', padding: 10, background: '#0007' }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="角色评议详情" style={{ ...workflowDialogStyle, width: 'min(1080px, 100%)', height: 'min(85vh, 800px)', background: 'var(--theme-panel-solid, var(--theme-bg-secondary, white))', color: 'var(--theme-text, black)', borderRadius: 16, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          if (event.key === 'Tab') { const nodes = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary')];
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header style={workflowHeaderStyle}><strong style={{ flex: 1 }}>角色评议</strong>
          {onStartReview && <WorkflowButton tone="primary" onClick={() => start()}>发起新评议</WorkflowButton>}
          <WorkflowButton onClick={() => { setRevision(v => v + 1); setCheckNonce(v => v + 1); }}>核对状态</WorkflowButton><WorkflowButton onClick={onClose}>收起评议</WorkflowButton>
        </header>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <nav aria-label="评议批次和角色" style={{ ...workflowNavStyle, display: batches.length ? 'flex' : 'none', width: 'clamp(90px, 25%, 230px)', flexShrink: 0, overflow: 'auto', padding: 6, borderRight: '1px solid var(--theme-border)' }}>
            {!batches.length && <p style={{ fontSize: 12 }}>输入 # 召集角色后，意见将在这里显示。</p>}
            {batches.map(item => <div key={item.id}><WorkflowButton tone="quiet" aria-pressed={batchId === item.id} onClick={() => { setBatchId(item.id); setReportId(''); }} style={{ width: '100%', padding: 7, overflowWrap: 'anywhere' }}>评议 {new Date(item.updatedAt * 1000).toLocaleTimeString()} · {labels[item.status || ''] || item.status}</WorkflowButton>
              {batchId === item.id && batch?.id === item.id && batch.reportSummaries.map(row => <WorkflowButton tone="quiet" key={row.id} aria-pressed={reportId === row.id} onClick={() => setReportId(row.id)} style={{ width: '100%', padding: '8px 6px', overflowWrap: 'anywhere', margin: '2px 0' }}>#{row.name} · {labels[row.status || ''] || row.status}</WorkflowButton>)}
            </div>)}
            {next !== null && <WorkflowButton onClick={() => { const current = identity.current; void api.collaborationList(session, executor, 'review', next).then(rows => { if (current === identity.current) { setBatches(old => [...old, ...rows.items.filter(row => !old.some(item => item.id === row.id))]); setNext(rows.nextOffset); } }).catch(error => { if (current === identity.current) setNotice(String(error)); }); }}>更早评议</WorkflowButton>}
          </nav>
          <section style={{ padding: 20, flex: 1, minWidth: 0, overflow: 'auto' }}>
            {!batches.length && <WorkflowEmptyState icon="review" title="请角色帮你核对回答"><p>选择回答和角色，开始评议后在这里比较意见，再把有用的建议引用回对话。</p>{onStartReview && <WorkflowButton tone="primary" icon="role" onClick={() => start()}>选择评议角色</WorkflowButton>}<p style={{ fontSize: 12 }}>也可在回答下点击“请角色评议”，或输入 # 选择角色。</p></WorkflowEmptyState>}
            {activeBatch && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}><span>{activeBatch.counts?.done || 0}/{activeBatch.counts?.total || 0} 位角色已给出意见</span>
              {running(activeBatch.status) && <WorkflowButton disabled={busy || activeBatch.status === 'stopping'} onClick={() => void act(() => api.reviewStop(session, executor, activeBatch.id))}>停止本批</WorkflowButton>}
            </div>}
            {activeBatch?.targets?.length ? <details style={{ ...workflowNoticeStyle, marginBottom: 16 }}><summary style={{ cursor: 'pointer' }}>评议了哪条回答 · {activeBatch.targets.length} 条</summary>{activeBatch.targets.map(item => <p key={item.id} style={{ whiteSpace: 'pre-wrap' }}>{item.text}</p>)}{activeBatch.question && <p>关注点：{activeBatch.question}</p>}</details> : null}
            {activeBatch?.status === 'error' && <div role="status" style={{ ...workflowNoticeStyle, border: '1px solid var(--theme-warning, #c58a38)' }}><strong style={{ color: 'var(--theme-text)' }}>评议未能开始</strong><p>本次没有生成可用意见。请回到输入区调整角色或配置后重新发起，原记录会保留。</p>{activeBatch.notice && <p>原因：{activeBatch.notice}</p>}{onStartReview && <WorkflowButton onClick={() => start(activeBatch.targets?.map(item => item.id))}>重新选择角色</WorkflowButton>}</div>}
            {summary && <h3 style={{ margin: '8px 0', overflowWrap: 'anywhere' }}>{summary.name} · {labels[summary.status || ''] || summary.status}</h3>}
            {summary && <ReviewProgressPanel key={`${executor}:${session}:${reportId}`} progress={progress[reportId] || summary.progress || visible?.progress} status={summary.status} connected={connected} />}
            {running(summary?.status) && <WorkflowButton disabled={busy || summary?.status === 'stopping'} onClick={() => void act(() => api.reviewStop(session, executor, batchId, reportId))}>停止此角色</WorkflowButton>}
            {visible && <>
              {visible.status === 'done' && <>
                <p>{disagreement ? '🌦 这位角色有不同意见' : visible.counts?.unknown ? '☁ 仍有未判断项' : '☀ 这位角色同意所评要点'}</p>
                <p>同意 {visible.counts?.agree || 0}/{visible.counts?.total || 0} 个评估要点 · 部分同意 {visible.counts?.partial || 0} · 不同意 {visible.counts?.disagree || 0} · 未判断 {visible.counts?.unknown || 0}</p>
                <p>角色自评置信：{visible.confidence == null ? '未知' : `${Math.round(visible.confidence * 100)}%`}。这些意见不构成事实正确率或验收。</p>
                <p style={{ whiteSpace: 'pre-wrap' }}>{visible.summary}</p>
                {visible.claims?.map(item => <article key={item.id} style={{ padding: 8, marginBottom: 8, border: '1px solid var(--theme-border)', borderRadius: 6 }}>
                  <label><input type="checkbox" checked={claims.includes(item.id)} onChange={e => setClaims(old => e.target.checked ? [...old, item.id] : old.filter(id => id !== item.id))} />{stances[item.stance]}</label>
                  {item.quote && <blockquote style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{item.quote}</blockquote>}
                  <p style={{ whiteSpace: 'pre-wrap' }}>{item.reason}</p>{item.suggestion && <p>建议：{item.suggestion}</p>}
                  <small>来源回答：{item.sourceMessageId}{item.evidenceRefs.length ? ` · 证据：${item.evidenceRefs.join(', ')}` : ''}</small>
                </article>)}
                <WorkflowButton disabled={busy || !claims.length} onClick={() => void act(() => reference(claims))}>引用所选要点</WorkflowButton>
                <WorkflowButton disabled={busy} onClick={() => void act(() => reference([]))}>引用完整意见</WorkflowButton>
              </>}
              {(summary?.notice || visible.notice) && <p role="status" style={workflowNoticeStyle}>{summary?.notice || visible.notice}</p>}
              {visible.limits?.map(item => <p key={item} style={{ fontSize: 12 }}>限制：{item}</p>)}
              {visible.status === 'invalid' && visible.raw && <WorkflowButton disabled={busy} onClick={() => void act(async () => {
                const current = identity.current;
                const saved = await api.reviewRevalidate(session, executor, visible.id, visible.revision);
                if (current === identity.current) { setReport(saved); setCheckNonce(v => v + 1); }
              })}>重新解析已有意见</WorkflowButton>}
              {activeBatch?.status !== 'error' && ['error', 'invalid', 'cancelled'].includes(summary?.status || '') && <p>最终意见尚不可引用，已收到的正文和证据仍可查看。{onStartReview && <WorkflowButton onClick={() => start(activeBatch?.targets?.map(item => item.id))}>重新选择角色</WorkflowButton>}</p>}
              <details style={{ marginTop: 16 }}><summary style={{ cursor: 'pointer', color: 'var(--theme-text-muted)' }}>查看原文、证据与角色历史</summary>
                <p style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>{visible.mode === 'native-restricted' ? '独立原生上下文 · 受限证据读取' : '纯文本评议 · 保留可见历史，无原生线程恢复'} · 角色版本 {visible.roleVersion}</p>
                {!!(visible.raw || visible.outputPath) && visible.sessionId && <WorkflowButton disabled={busy || !onOpenSession} onClick={() => void act(async () => { await api.collaborationOpenSession(visible.sessionId!, executor); onOpenSession?.(visible.sessionId!); onClose(); })}>查看角色历史会话</WorkflowButton>}
                <p style={{ overflowWrap: 'anywhere' }}>{visible.outputPath}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{JSON.stringify(visible.evidence || [], null, 2)}</pre><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{visible.raw}</pre>
              </details>
            </>}
            {notice && <p role="status" style={{ overflowWrap: 'anywhere' }}>{notice}</p>}
          </section>
        </div>
      </div>
    </div></AppModalPortal>}
  </>;
};
