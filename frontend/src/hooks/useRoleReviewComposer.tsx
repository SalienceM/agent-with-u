import { WorkflowButton } from '../components/WorkflowControls';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { composerDrafts } from '../utils/composerDrafts';
import { roleQueryAt } from '../utils/roleReviews';
import { uuid } from '../utils/uuid';
import type { CollaborationSummary, ReviewSnapshot } from '../types/sessionCollaboration';

interface Props { session: string; executor: string; scope: string; textarea: React.RefObject<HTMLTextAreaElement>; changed: () => void; onSubmitted?: (id: string) => void; onOpenResults?: () => void; onManageRoles?: () => void }
export function useRoleReviewComposer({ session, executor, scope, textarea, changed, onSubmitted, onOpenResults, onManageRoles }: Props) {
  useSyncExternalStore(composerDrafts.subscribe, composerDrafts.snapshot);
  const review = composerDrafts.ensure(scope).review;
  const [query, setQuery] = useState<string | null>(null), [roles, setRoles] = useState<CollaborationSummary[]>([]), [index, setIndex] = useState(0);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [targetsOpen, setTargetsOpen] = useState(false);
  const [targets, setTargets] = useState<Array<{ id: string; text: string; characters: number }>>([]);
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>();
  const [targetsReady, setTargetsReady] = useState(false);
  const pickerOnly = useRef(false);
  const [unknown, setUnknown] = useState('');
  const [nextRole, setNextRole] = useState<number | null>(null);
  const menuEpoch = useRef(0);
  const epoch = useRef(0), pending = useRef(false), attempted = useRef<{ request: string; revision: number }>();
  const change = (next: typeof review) => { composerDrafts.setReview(scope, next); changed(); setSnapshot(undefined); };
  useEffect(() => { epoch.current++; setQuery(null); setNotice(''); setSnapshot(undefined);
    const receipt = composerDrafts.ensure(scope).review.receipt;
    setUnknown(receipt?.request || ''); setBusy(false); pending.current = false;
    attempted.current = receipt ? { request: receipt.request, revision: receipt.draftRevision } : undefined;
    setTargets([]); setTargetsReady(false); setTargetsOpen(false); pickerOnly.current = false;
    return () => { epoch.current++; }; }, [scope]);
  const hasRoles = review.roles.length > 0;
  const targetKey = JSON.stringify(review.targetIds);
  useEffect(() => {
    if (!hasRoles) { setTargetsReady(false); return; }
    let live = true;
    setTargetsReady(false);
    void api.reviewTargets(session, executor, JSON.parse(targetKey)).then(rows => {
      if (live) { setTargets(rows); setTargetsReady(true); }
    }).catch(error => { if (live) setNotice(`无法读取待评议回答：${String(error)}`); });
    return () => { live = false; };
  }, [hasRoles, session, executor, targetKey]);
  useEffect(() => {
    const version = ++menuEpoch.current;
    if (query === null) return;
    setRoles([]); setNextRole(null);
    const timer = setTimeout(() => { void api.collaborationList(session, executor, 'role', 0, query).then(data => {
      if (version === menuEpoch.current) { setRoles(data.items.filter(row => row.enabled !== false && !row.archived)); setNextRole(data.nextOffset); }
    }).catch(error => { if (version === menuEpoch.current) setNotice(String(error)); }); }, 100);
    return () => { clearTimeout(timer); menuEpoch.current++; };
  }, [query, session, executor]);
  const candidates = roles.filter(row => !review.roles.some(role => role.id === row.id) && (!query || row.name?.toLowerCase().includes(query.toLowerCase())));
  const select = (row: CollaborationSummary) => {
    if (review.roles.length >= 8) { setNotice('每批最多8个角色'); return; }
    const el = textarea.current, found = el && roleQueryAt(el.value, el.selectionStart);
    if (!el || (!found && !pickerOnly.current)) return;
    if (found && !pickerOnly.current) {
      const cursor = el.selectionStart;
      el.value = el.value.slice(0, found.start) + el.value.slice(cursor); el.setSelectionRange(found.start, found.start);
      composerDrafts.edit(scope, 'main', el.value);
    }
    change({ ...review, roles: [...review.roles, { id: row.id, revision: row.revision, name: row.name || row.id }] });
    pickerOnly.current = false; setQuery(null); el.focus();
  };
  const start = (targetIds?: string[], resetSelection = false) => {
    if (targetIds || resetSelection) change({ ...composerDrafts.ensure(scope).review,
      ...(resetSelection ? { roles: [], targetIds: [], newContext: false } : {}), ...(targetIds ? { targetIds } : {}) });
    pickerOnly.current = true; setQuery(''); setIndex(0); textarea.current?.focus();
  };
  const onInput = (text: string, cursor: number) => { pickerOnly.current = false; const match = roleQueryAt(text, cursor); setQuery(match?.query ?? null); setIndex(0); return !!match; };
  const onKey = (event: React.KeyboardEvent | KeyboardEvent) => {
    if (query === null) return false;
    if (event.key === 'Escape') { event.preventDefault(); setQuery(null); return true; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(i => Math.max(0, Math.min(candidates.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); if (candidates[index]) select(candidates[index]); return true; }
    return false;
  };
  const accept = (revision: number, request: string) => {
    if (composerDrafts.get(scope)?.revision === revision) {
      const row = composerDrafts.ensure(scope);
      // 附件未被明确选为评议材料，保留；只清理已接收的角色选择和问题。
      composerDrafts.edit(scope, 'main', ''); composerDrafts.setReview(scope, { ...row.review, roles: [], receipt: undefined }); changed();
    } else if (composerDrafts.get(scope)?.review.receipt?.request === request) {
      composerDrafts.setReview(scope, { ...composerDrafts.ensure(scope).review, receipt: undefined }); changed();
    }
    setNotice('评议已提交。可以继续主对话，或查看评议进度与意见。'); setUnknown(''); onSubmitted?.(request);
  };
  const send = async () => {
    if (!review.roles.length || pending.current) return;
    let revision = composerDrafts.ensure(scope).revision;
    if (composerDrafts.ensure(scope).review.receipt) { setUnknown(composerDrafts.ensure(scope).review.receipt!.request); setNotice('原评议已提交，请核对原请求；没有重复发送。'); return; }
    if (!targetsReady) { setNotice('正在读取待评议回答，请稍后再开始。'); return; }
    if (!targets.length) { setNotice('当前还没有可评议的已完成回答。'); return; }
    const question = textarea.current?.value || '', frozen = structuredClone(review), current = epoch.current;
    pending.current = true; setBusy(true); setNotice('正在冻结评议材料…');
    let submitted = false;
    try {
      // 默认对象也绑定用户已看到的回答，主线新增回答不能悄悄替换它。
      const selectedIds = frozen.targetIds.length ? frozen.targetIds : [targets[targets.length - 1].id];
      const material = snapshot || await api.reviewSnapshot(session, executor, selectedIds);
      if (current !== epoch.current) return;
      if (composerDrafts.ensure(scope).revision !== revision) { setNotice('草稿已变化，本次未启动评议；请按当前内容发送。'); return; }
      const request = uuid(); submitted = true;
      composerDrafts.setReview(scope, { ...frozen, receipt: { request, draftRevision: revision, fingerprint: material.fingerprint } });
      revision = composerDrafts.ensure(scope).revision;
      composerDrafts.ensure(scope).review.receipt!.draftRevision = revision;
      attempted.current = { request, revision }; changed();
      const batch = await api.reviewSubmit(session, executor, request, { snapshotId: material.id, fingerprint: material.fingerprint,
        roles: frozen.roles.map(({ id, revision }) => ({ id, revision })), question, newContext: frozen.newContext });
      if (current !== epoch.current) return;
      if (batch.status === 'error') { setNotice(batch.notice || '评议未启动'); attempted.current = undefined; composerDrafts.setReview(scope, { ...composerDrafts.ensure(scope).review, receipt: undefined }); changed(); return; }
      if (batch.status === 'unknown') { setUnknown(request); setNotice(batch.notice || '评议结果未知；保留草稿，仅核对原请求。'); return; }
      accept(revision, request);
    } catch (error) {
      if (current !== epoch.current) return;
      if (submitted) { setUnknown(attempted.current!.request); setNotice('评议接收结果未知，草稿已保留；仅核对原请求。'); }
      else setNotice(String(error));
    } finally { if (current === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const check = async () => {
    const current = epoch.current, attempt = attempted.current;
    if (!attempt) return;
    try { const result = await api.reviewStatus(session, executor, attempt.request);
      if (current === epoch.current) { if (result.status === 'error') { setNotice(result.notice || '原评议失败'); composerDrafts.setReview(scope, { ...composerDrafts.ensure(scope).review, receipt: undefined }); changed(); setUnknown(''); } else if (result.status === 'unknown') setNotice(result.notice || '原评议结果仍未知，未重发。'); else accept(attempt.revision, attempt.request); }
    } catch { if (current === epoch.current) setNotice('仍无法确认原评议；未重发。'); }
  };
  const summarize = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); const current = epoch.current;
    const revision = composerDrafts.ensure(scope).revision;
    try { const row = await api.reviewSummarize(session, executor, uuid(), review.targetIds.length ? review.targetIds : targets.slice(-1).map(item => item.id)); if (current === epoch.current && composerDrafts.ensure(scope).revision === revision) { setSnapshot(row); setNotice('已生成摘要；发送评议时将使用此摘要，未声称完整审阅。'); } }
    catch (error) { if (current === epoch.current) setNotice(String(error)); }
    finally { if (current === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const controls = <>
    {review.roles.length > 0 && <section aria-label="评议选择" style={{ padding: 12, marginBottom: 8, borderRadius: 10, border: '1px solid var(--theme-border)', background: 'var(--theme-panel-solid, var(--theme-bg-secondary))', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><strong style={{ flex: 1 }}>请角色评议回答</strong><WorkflowButton tone="quiet" disabled={busy || !!unknown} onClick={() => { change({ ...review, roles: [], targetIds: [], newContext: false }); setNotice(''); }}>退出评议</WorkflowButton></div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}><span style={{ color: 'var(--theme-text-muted)' }}>参与角色</span>{review.roles.map(role => <WorkflowButton disabled={busy} key={role.id} onClick={() => change({ ...review, roles: review.roles.filter(item => item.id !== role.id) })}>#{role.name} ×</WorkflowButton>)}<WorkflowButton tone="quiet" disabled={busy} onClick={() => start()}>添加角色</WorkflowButton></div>
      <div style={{ marginTop: 10, padding: '8px 10px', borderLeft: '2px solid var(--theme-accent)', background: 'var(--theme-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong style={{ flex: 1 }}>{review.targetIds.length ? `评议对象 · ${review.targetIds.length} 条回答` : '评议对象 · 最近完成的回答'}</strong><WorkflowButton tone="quiet" onClick={() => setTargetsOpen(!targetsOpen)}>{targetsOpen ? '收起选择' : '更换回答'}</WorkflowButton></div>
        {!targetsReady ? <p>正在读取回答…</p> : !targets.length ? <p>当前没有已完成的回答，请先与主助手完成一次对话。</p> : (review.targetIds.length ? targets.filter(item => review.targetIds.includes(item.id)) : targets.slice(-1)).map(item => <p key={item.id} style={{ margin: '6px 0 0', color: 'var(--theme-text-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</p>)}
      </div>
      {targetsOpen && <div style={{ maxHeight: 200, overflow: 'auto' }}>
        <WorkflowButton onClick={() => change({ ...review, targetIds: [] })}>使用最近回答</WorkflowButton>
        {targets.map(item => <label key={item.id} style={{ display: 'block', padding: 4 }}><input type="checkbox" checked={review.targetIds.includes(item.id)} onChange={e => change({ ...review,
          targetIds: e.target.checked ? [...review.targetIds, item.id].slice(-20) : review.targetIds.filter(id => id !== item.id) })} />{item.text}（{item.characters}字）</label>)}
      </div>}
      <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', color: 'var(--theme-text-muted)' }}>更多评议设置</summary>
        <label style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={review.newContext} onChange={e => change({ ...review, newContext: e.target.checked })} />重新开始角色上下文（保留旧记录）</label>
        <WorkflowButton disabled={busy || !targets.length} onClick={() => void summarize()}>先生成摘要再评议</WorkflowButton><p style={{ color: 'var(--theme-text-muted)' }}>长回答可先摘要，会额外调用一次模型。</p>
      </details>
      {snapshot && <details><summary>查看冻结摘要 · {snapshot.characters} 字{snapshot.omittedCharacters ? ` · 原文省略 ${snapshot.omittedCharacters} 字` : ''}</summary>{snapshot.limits?.map(text => <p key={text}>{text}</p>)}{snapshot.messages.map(item => <p key={item.id}>{item.text}</p>)}</details>}
      <div style={{ color: 'var(--theme-text-muted)', marginTop: 8 }}>下方可补充关注点，点击「开始评议」后在“评议”中查看意见。附件留在当前草稿。</div>
    </section>}
    {(notice || unknown) && <div role="status" style={{ fontSize: 12, padding: 6, overflowWrap: 'anywhere' }}>{notice || '原评议接收结果待核对'}{unknown && <WorkflowButton onClick={() => void check()}>核对原评议</WorkflowButton>}{notice && onOpenResults && <WorkflowButton onClick={onOpenResults}>查看评议</WorkflowButton>}</div>}
  </>;
  const menu = query !== null && <div role="listbox" aria-label="选择评议角色" style={{ position: 'absolute', bottom: '100%', left: 8, right: 8, zIndex: 20, maxHeight: 240, overflow: 'auto', padding: 8, borderRadius: 10, boxShadow: '0 8px 28px #0002', border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary, white)' }}>
    {!candidates.length && <div>没有匹配角色；可在角色库中维护。</div>}
    {onManageRoles && <WorkflowButton tone="quiet" onClick={() => { setQuery(null); onManageRoles(); }}>管理角色</WorkflowButton>}
    {candidates.map((row, i) => <WorkflowButton role="option" aria-selected={i === index} key={row.id} onMouseEnter={() => setIndex(i)} onClick={() => select(row)} style={{ display: 'block', padding: 8, width: '100%', textAlign: 'left' }}>#{row.name}</WorkflowButton>)}
    {nextRole !== null && <WorkflowButton onClick={() => { const version = menuEpoch.current; void api.collaborationList(session, executor, 'role', nextRole, query || '').then(data => {
      if (version === menuEpoch.current) { setRoles(old => [...old, ...data.items.filter(row => row.enabled !== false && !row.archived && !old.some(item => item.id === row.id))]); setNextRole(data.nextOffset); }
    }).catch(error => { if (version === menuEpoch.current) setNotice(String(error)); }); }}>更多角色</WorkflowButton>}
  </div>;
  return { review, menu, controls, open: query !== null, busy, send, start, onInput, onKey, dismiss: () => setQuery(null) };
}
