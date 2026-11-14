import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, getCurrentUserProfile, getSessionExecKey, onCurrentUserChanged } from '../api';
import type { InteractionResponse, UserInteraction } from '../types/userInteractions';
import { interactionIndex, mergeInteractions } from '../utils/userInteractions';
import { WorkflowButton, WorkflowPopover, workflowNoticeStyle } from './WorkflowControls';

const labels: Record<UserInteraction['status'], string> = {
  pending: '待回答', responding: '已接收，正在回传', answered: '已回传', auto_handled: '已自动处理',
  cancelled: '已取消', expired: '已过期', failed: '失败', unknown: '回传结果未知', interrupted: '原运行已中断',
};
const drafts = new Map<string, Record<string, string[]>>();
let focusSession = '';
export function focusUserInteraction(sessionId: string): void {
  focusSession = sessionId;
  window.dispatchEvent(new Event('awu-focus-user-interaction'));
}
const button: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)' };

export const InteractionBadge: React.FC<{ sessionId: string; executor?: string; onOpen: () => void }> = ({ sessionId, executor, onOpen }) => {
  useSyncExternalStore(interactionIndex.subscribe, interactionIndex.snapshot);
  const count = interactionIndex.count(executor || getSessionExecKey(sessionId) || 'local', sessionId);
  if (!count) return null;
  return <button style={{ ...button, padding: '2px 5px', color: 'var(--theme-warning, #b7791f)', whiteSpace: 'nowrap' }}
    onClick={event => { event.stopPropagation(); focusSession = sessionId; onOpen(); window.dispatchEvent(new Event('awu-focus-user-interaction')); }} aria-label={`${count} 个问题待回答`}>待答 {count}</button>;
};

const InteractionCard: React.FC<{ row: UserInteraction; scope: string; respond: (id: string, value: InteractionResponse) => Promise<void> }> = ({ row, scope, respond }) => {
  const draftKey = `${scope}:${row.id}`;
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => drafts.get(draftKey) || {});
  const [other, setOther] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const pending = row.status === 'pending';
  useEffect(() => {
    if (['answered', 'auto_handled', 'cancelled', 'expired'].includes(row.status)) { drafts.delete(draftKey); setAnswers({}); setOther({}); }
  }, [row.status, draftKey]);
  const change = (id: string, value: string[]) => {
    const next = { ...answers, [id]: value }; setAnswers(next);
    drafts.set(draftKey, Object.fromEntries(Object.entries(next).filter(([key]) => !row.questions.find(q => q.id === key)?.secret)));
  };
  const submit = async (value: InteractionResponse) => {
    if (submitting || uncertain) return;
    if (value.kind === 'answers') {
      const missing = row.questions.find(q => q.required && !(value.answers[q.id] || []).length);
      if (missing) {
        setError(`请回答：${missing.header || missing.question}`);
        form.current?.querySelector<HTMLElement>(`[data-question-index="${row.questions.indexOf(missing)}"] input, [data-question-index="${row.questions.indexOf(missing)}"] textarea`)?.focus();
        return;
      }
    }
    setError(''); setSubmitting(true);
    try { await respond(row.id, value); }
    catch (cause) {
      // 写请求失败可能已经到达。仅提供只读核对，不恢复为可重发按钮。
      setUncertain(true); setError(`${cause instanceof Error ? cause.message : '提交失败'}。请核对状态；未自动重发答案。`);
    } finally { setSubmitting(false); }
  };
  return <details open={pending || row.status === 'responding'} style={{ border: '1px solid var(--theme-border)', borderRadius: 10, padding: 12, marginTop: 10, background: 'var(--theme-bg, #fff)' }}>
    <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, lineHeight: 1.6 }}>{row.title || (row.kind === 'question' ? 'Agent 需要你的回答' : '执行审批')} · {labels[row.status]}</summary>
    {row.notice && <p role="status" style={workflowNoticeStyle}>{row.notice}</p>}
    {row.detail && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>{row.detail}</pre>}
    {pending || row.status === 'unknown' ? <form ref={form} onSubmit={event => { event.preventDefault(); void submit({ kind: 'answers', answers }); }}>
      <fieldset disabled={!pending || submitting || uncertain} style={{ border: 0, padding: 0, minWidth: 0 }}>
        {row.questions.map((q, index) => <fieldset key={q.id} data-question-index={index} style={{ border: 0, padding: '10px 0', minWidth: 0 }}>
          <legend>{q.header && <strong>{q.header} · </strong>}{q.question}{q.required && ' *'}{q.multiple && '（可多选）'}</legend>
          {q.options.map(option => <label key={option.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '6px 0', padding: '7px 9px', borderRadius: 7, border: '1px solid var(--theme-border)', cursor: 'pointer', overflowWrap: 'anywhere', background: (answers[q.id] || []).includes(option.id) ? 'var(--theme-accent-bg, #4b82f014)' : 'transparent' }}>
            <input type={q.multiple ? 'checkbox' : 'radio'} name={`${draftKey}:${q.id}`} checked={(answers[q.id] || []).includes(option.id)}
              onChange={event => change(q.id, q.multiple ? event.target.checked ? [...(answers[q.id] || []), option.id] : (answers[q.id] || []).filter(v => v !== option.id) : [option.id])} />
            {option.label}{option.description && <span style={{ opacity: .7 }}> — {option.description}</span>}
          </label>)}
          {q.allowOther && <label style={{ display: 'block' }}>{q.options.length ? '其他回答' : '你的回答'}
            <input type={q.secret ? 'password' : 'text'} autoComplete="off" maxLength={8000} value={other[q.id] ?? (answers[q.id] || []).filter(value => !q.options.some(option => option.id === value)).join('\n')}
              style={{ width: '100%', boxSizing: 'border-box', padding: 8, background: 'var(--theme-input-bg)', color: 'var(--theme-text)', border: '1px solid var(--theme-border)', borderRadius: 6 }}
              onChange={event => {
                const value = event.target.value; setOther(old => ({ ...old, [q.id]: value }));
                change(q.id, [...(q.multiple ? (answers[q.id] || []).filter(v => q.options.some(o => o.id === v)) : []), ...(value.trim() ? [value] : [])]);
              }} />
          </label>}
        </fieldset>)}
        {pending && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {row.kind === 'approval' ? <><button type="button" style={button} onClick={() => void submit({ kind: 'approved', approved: true })}>允许一次</button>
            <button type="button" style={button} onClick={() => void submit({ kind: 'approved', approved: false })}>拒绝</button></>
            : <><button type="submit" style={button}>{submitting ? '提交中…' : '提交答案'}</button>
              {row.canSkip && <button type="button" style={button} onClick={() => void submit({ kind: 'skipped' })}>跳过这次问题</button>}</>}
          <button type="button" style={button} onClick={() => void submit({ kind: 'cancelled' })}>取消这次请求</button>
        </div>}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form> : <>
      {row.questions.map(q => <p key={q.id}>{q.question}<br /><span style={{ opacity: .7 }}>{q.secret ? '保密答案不留存' : (row.answers?.[q.id] || []).join('、') || '未填写答案'}</span></p>)}
      {row.kind === 'approval' && <p>{row.approved === true ? '已允许本次操作' : row.approved === false ? '已拒绝本次操作' : '未作允许决定'}</p>}
      <p style={{ opacity: .7 }}>{row.receiptLevel === 'transport_write' ? '答案已写入原运行的响应通道；这不代表后续任务已完成。' : '历史记录不会重新提交到新一轮。'}</p>
    </>}
  </details>;
};

export const UserInteractionsPanel: React.FC<{ sessionId: string; runtimeKey?: string; compact?: boolean; executor?: string }> = ({ sessionId, runtimeKey = '', compact = false, executor: explicitExecutor }) => {
  const [rows, setRows] = useState<UserInteraction[]>([]);
  const [notice, setNotice] = useState('');
  const [capabilityNotice, setCapabilityNotice] = useState('');
  const [permissionNotice, setPermissionNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [owner, setOwner] = useState(getCurrentUserProfile().userId);
  const [open, setOpen] = useState(false);
  const executor = explicitExecutor || getSessionExecKey(sessionId) || '';
  const scope = JSON.stringify([owner, executor, sessionId]);
  const region = useRef<HTMLElement>(null);
  const pendingIds = rows.filter(row => row.status === 'pending').map(row => row.id).join(':');
  const pendingCount = rows.filter(row => row.status === 'pending').length;
  useEffect(() => { setOpen(false); }, [scope]);
  useEffect(() => { if (pendingIds) setOpen(true); }, [pendingIds]);
  useEffect(() => {
    const focus = () => {
      if (focusSession !== sessionId || !rows.some(row => row.status === 'pending')) return;
      focusSession = '';
      setOpen(true);
      requestAnimationFrame(() => {
        const target = region.current?.querySelector<HTMLElement>('details[open] summary');
        target?.scrollIntoView({ block: 'nearest' }); target?.focus();
      });
    };
    focus(); window.addEventListener('awu-focus-user-interaction', focus);
    return () => window.removeEventListener('awu-focus-user-interaction', focus);
  }, [sessionId, rows]);
  useEffect(() => onCurrentUserChanged(() => { drafts.clear(); setOwner(getCurrentUserProfile().userId); }), []);
  useEffect(() => {
    let active = true, reading = false;
    setRows([]); setNotice(''); setCapabilityNotice(''); setPermissionNotice('');
    const accept = (incoming: UserInteraction[]) => { if (active) setRows(old => mergeInteractions(old, incoming)); };
    const off = api.onUserInteraction((row, source) => { if (row.sessionId === sessionId && source === executor) accept([row]); });
    const offConnection = api.onSessionConnectionStatus(sessionId, connected => {
      if (!connected) { setNotice('执行节点离线，答案不会发送到其他节点。'); return; }
      if (reading) return;
      reading = true;
      void api.userInteractionList(sessionId, executor).then(result => {
        accept(result.items);
        if (active) { setNotice(''); setCapabilityNotice(result.capability?.questions === false ? result.capability.notice : ''); setPermissionNotice(result.capability?.permissionNotice || ''); }
      })
        .catch(error => { if (active && !String(error).includes('Unknown method')) setNotice(`原生问答状态不可用：${error.message}`); })
        .finally(() => { reading = false; });
    });
    return () => { active = false; off(); offConnection(); };
  }, [scope, reload, sessionId, executor, runtimeKey]);
  if (!rows.length && !notice && !capabilityNotice && !permissionNotice) return null;
  const content = <section ref={region} aria-label="原生交互" style={{ color: 'var(--theme-text)', padding: compact ? 0 : '8px 12px', maxHeight: compact ? undefined : '42vh', overflow: 'auto', flexShrink: 0, fontSize: 12, lineHeight: 1.6 }}>
    {notice && <p role="status" style={workflowNoticeStyle}>{notice}</p>}
    {capabilityNotice && <details style={workflowNoticeStyle}><summary style={{ cursor: 'pointer' }}>问答通道：下一轮文字回复</summary>{capabilityNotice}</details>}
    {permissionNotice && <details style={workflowNoticeStyle}><summary style={{ cursor: 'pointer' }}>确认策略：跳过执行确认</summary><p style={{ marginBottom: 0 }}>{permissionNotice}</p></details>}
    {!rows.length && !notice && <p style={{ color: 'var(--theme-text-muted)', margin: '8px 0' }}>暂无待回答问题。需要你的输入时会在这里提示。</p>}
    <WorkflowButton tone="quiet" icon="refresh" onClick={() => setReload(value => value + 1)}>核对问答状态</WorkflowButton>
    {rows.map(row => <InteractionCard key={`${scope}:${row.id}`} scope={scope} row={row} respond={async (id, value) => {
      const updated = await api.userInteractionRespond(sessionId, executor, id, value);
      if (getCurrentUserProfile().userId === owner && (explicitExecutor || getSessionExecKey(sessionId) || '') === executor) setRows(old => mergeInteractions(old, [updated]));
    }} />)}
  </section>;
  return compact ? <WorkflowPopover label="交互状态" title={pendingCount ? '待回答' : '问答与确认'} icon="question" badge={pendingCount || undefined}
    warning={!!pendingCount || !!notice} open={open} onOpenChange={setOpen} width={480}>{content}</WorkflowPopover> : content;
};
