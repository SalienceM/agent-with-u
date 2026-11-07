import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, getCurrentUserProfile } from '../api';
import { WorkflowButton, WorkflowPopover, workflowFieldStyle } from './WorkflowControls';
import type { ScheduleConfig, ScheduleIntent, ScheduleOccurrence, SchedulePage, ScheduleReceipt, SessionSchedule } from '../types/sessionSchedules';
import { scheduleStateLabel } from '../types/sessionSchedules';
import { uuid } from '../utils/uuid';

interface Props { session: string; executor: string; owner: string; onStop: () => void; onLocate?: (messageId: string) => boolean; onPending?: () => void }
const field: React.CSSProperties = { display: 'block', marginTop: 10 };
const actions: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 };
const fmt = (value?: number | null, timezone?: string) => value ? new Date(value * 1000).toLocaleString(undefined,
  timezone ? { timeZone: timezone, timeZoneName: 'shortOffset' } : undefined) : '无下一时点';
const fresh = (): ScheduleConfig => ({ title: '', prompt: '', enabled: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  rule: { kind: 'once', at: '' }, misfirePolicy: 'catch_up_once' });
type Pending = { intent: ScheduleIntent; draft: string };

/** 身份由父级 key 隔离；关闭浮层仍保留草稿，连接恢复只核对原回执。 */
export const SessionSchedules: React.FC<Props> = ({ session, executor, owner, onStop, onLocate, onPending }) => {
  const [open, setOpen] = useState(false), [page, setPage] = useState<SchedulePage<SessionSchedule> | null>(null);
  const [draft, setDraft] = useState<ScheduleConfig>(fresh), [editing, setEditing] = useState<SessionSchedule | null>(null);
  const [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [online, setOnline] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null), [preview, setPreview] = useState('');
  const [history, setHistory] = useState<ScheduleOccurrence[]>([]), [historyOpen, setHistoryOpen] = useState(false), [nextHistory, setNextHistory] = useState<number | null>(null);
  const [output, setOutput] = useState<{ id: string; messageId: string; text: string; nextOffset: number | null } | null>(null);
  const [lastState, setLastState] = useState(''), [lastSync, setLastSync] = useState(0);
  const [waitingInput, setWaitingInput] = useState(false);
  const interactionVersions = useRef(new Map<string, number>()), waitingRequests = useRef(new Set<string>()), activityGeneration = useRef(0);
  const activeOccurrence = useRef('');
  const queueGeneration = useRef(0);
  const alive = useRef(true), openRef = useRef(false), historyRef = useRef(false), onlineRef = useRef(false);
  const pendingRef = useRef<Pending | null>(null), draftRef = useRef(draft), inFlight = useRef<Promise<void> | null>(null);
  const historyFlight = useRef<Promise<void> | null>(null), versions = useRef(new Map<string, number>()), readSerial = useRef(0);
  const requestCheck = useRef<Promise<void> | null>(null);
  const needsRefresh = useRef(false), needsHistory = useRef(false);
  const outputRef = useRef(output), outputRequest = useRef(0), outputFlight = useRef('');
  outputRef.current = output;
  const scope = JSON.stringify([owner, executor, session]);
  const storageKey = `awu:schedule-draft:${scope}`;
  draftRef.current = draft; pendingRef.current = pending; openRef.current = open; historyRef.current = historyOpen;
  const current = useCallback(() => alive.current && getCurrentUserProfile().userId === owner, [owner]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved?.draft) { setDraft(saved.draft); setEditing(saved.editing || null); }
      if (saved?.pending) { pendingRef.current = saved.pending; setPending(saved.pending); setNotice('上次保存结果待核对；不会自动重发。'); }
    } catch { /* 损坏的草稿不产生运行 */ }
  }, [storageKey]);
  // 草稿保存与提交时的 requestId 采用同一个 scope；存储失败时提交前显式阻止。
  const persist = (value: Pending | null, config = draftRef.current, base = editing) => {
    sessionStorage.setItem(storageKey, JSON.stringify({ draft: config, editing: base, pending: value }));
  };
  const change = (patch: Partial<ScheduleConfig>) => { setDraft(old => { const next = { ...old, ...patch }; try { persist(pendingRef.current, next); } catch { /* 提交时再次检查 */ } return next; }); setPreview(''); };

  const load = useCallback(async (offset = 0) => {
    if (inFlight.current) { needsRefresh.current = true; return inFlight.current; }
    const job = (async () => {
      try {
        const generation = activityGeneration.current;
        const queueVersion = queueGeneration.current;
        const row = await api.sessionScheduleList(session, executor, offset);
        if (!current() || row.revision < readSerial.current) return;
        readSerial.current = row.revision;
        setPage(old => {
          const value = offset && old ? { ...row, items: [...old.items.filter(x => !row.items.some(y => y.id === x.id)), ...row.items] } : row;
          return old && queueVersion !== queueGeneration.current ? { ...value, queuePaused: old.queuePaused, queueError: old.queueError } : value;
        });
        setLastSync(row.observedAt || Date.now() / 1000);
        if (row.activity && generation === activityGeneration.current && row.activity.revision >= (versions.current.get(row.activity.id) || 0)) {
          activeOccurrence.current = ['claimed', 'running'].includes(row.activity.state) ? row.activity.id : '';
          setLastState(scheduleStateLabel[row.activity.state] || row.activity.state);
          setWaitingInput(!!row.activity.waitingForInput);
        }
      } catch (error) { if (current()) setNotice(String(error)); }
    })();
    inFlight.current = job;
    try { await job; } finally { if (inFlight.current === job) inFlight.current = null;
      if (needsRefresh.current) { needsRefresh.current = false; if (current() && openRef.current && onlineRef.current) void load(); } }
  }, [session, executor, current]);

  const loadHistory = useCallback(async (offset = 0) => {
    if (historyFlight.current) { needsHistory.current = true; return historyFlight.current; }
    const job = (async () => {
      try {
        const row = await api.sessionScheduleOccurrences(session, executor, offset);
        if (!current()) return;
        setHistory(old => offset ? [...old.filter(x => !row.items.some(y => y.id === x.id)), ...row.items] : row.items);
        setNextHistory(row.nextOffset);
      } catch (error) { if (current()) setNotice(String(error)); }
    })();
    historyFlight.current = job;
    try { await job; } finally { if (historyFlight.current === job) historyFlight.current = null;
      if (needsHistory.current) { needsHistory.current = false; if (current() && openRef.current && historyRef.current && onlineRef.current) void loadHistory(); } }
  }, [session, executor, current]);

  const accepted = (receipt: ScheduleReceipt, original: Pending) => {
    if (!current() || pendingRef.current?.intent.requestId !== original.intent.requestId || receipt.status !== 'succeeded') return;
    pendingRef.current = null; setPending(null);
    if (receipt.schedule && JSON.stringify(draftRef.current) === original.draft) { setEditing(receipt.schedule); }
    try { persist(null, draftRef.current, receipt.schedule || editing); } catch { /* 已获得真实回执，仍可手工查看 */ }
    setNotice(receipt.active?.length ? '已保存；本次正在启动或运行，修改作用于后续。' : '已保存到执行节点。');
    void load(); if (historyRef.current) void loadHistory();
  };
  const acceptedRef = useRef(accepted); acceptedRef.current = accepted;
  const check = useCallback(async () => {
    if (requestCheck.current) return requestCheck.current;
    const original = pendingRef.current; if (!original) return;
    const job = (async () => {
      try {
        const receipt = await api.sessionScheduleRequestStatus(session, executor, original.intent.requestId);
        if (!current()) return;
        if (receipt.status === 'succeeded') acceptedRef.current(receipt, original);
        else setNotice('未查到已提交回执，结果仍待核对；没有自动重发。');
      } catch (error) { if (current()) setNotice(`结果未知；核对失败：${String(error)}`); }
    })();
    requestCheck.current = job;
    try { await job; } finally { if (requestCheck.current === job) requestCheck.current = null; }
  }, [session, executor, current]);

  useEffect(() => {
    let initialized = false;
    return api.onExecutorConnectionStatus(executor, connected => {
      if (!current()) return;
      const recovered = connected && (!initialized || !onlineRef.current);
      initialized = true; onlineRef.current = connected; setOnline(connected);
      if (recovered) { void load(); void check(); if (historyRef.current) void loadHistory(); }
    });
  }, [executor, current, load, check, loadHistory]);
  useEffect(() => api.onSeqtaskUpdated((row, node) => {
    if (!current() || row.sessionId !== session || node !== executor) return;
    queueGeneration.current++;
    setPage(old => old ? { ...old, queuePaused: !row.seqAuto, queueError: row.seqError } : old);
  }), [session, executor, current]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onSessionSchedule((row, node) => {
      if (!current() || row.sessionId !== session || node !== executor || row.version !== 1) return;
      if ((versions.current.get(row.id) || 0) >= row.revision) return;
      versions.current.set(row.id, row.revision);
      activityGeneration.current++;
      if (row.state && (!activeOccurrence.current || activeOccurrence.current === row.id)) {
        setLastState(scheduleStateLabel[row.state] || row.state);
        if (['claimed', 'running'].includes(row.state)) activeOccurrence.current = row.id;
        else { activeOccurrence.current = ''; waitingRequests.current.clear(); setWaitingInput(false); }
      }
      setLastSync(row.updatedAt);
      if (!timer) timer = setTimeout(() => { timer = undefined; if (openRef.current || !row.state) void load(); if (historyRef.current && openRef.current) void loadHistory(); }, 300);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [session, executor, current, load, loadHistory]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (id: string, messageId: string, waiting: boolean) => {
      if (!messageId?.startsWith('schedule-assistant-')) return;
      activityGeneration.current++;
      if (waiting) waitingRequests.current.add(id); else waitingRequests.current.delete(id);
      setWaitingInput(waitingRequests.current.size > 0);
      setHistory(old => old.map(row => row.assistantMessageId === messageId ? { ...row, waitingForInput: waiting } : row));
      if (!timer) timer = setTimeout(() => {
        timer = undefined;
        if (onlineRef.current && openRef.current) { void load(); if (historyRef.current) void loadHistory(); }
      }, 300);
    };
    const off = api.onUserInteraction((row, node) => {
      if (!current() || node !== executor || row.sessionId !== session || (interactionVersions.current.get(row.id) || 0) >= row.revision) return;
      interactionVersions.current.set(row.id, row.revision);
      update(row.id, row.messageId, ['pending', 'responding'].includes(row.status));
    });
    const offPermission = api.onPermissionRequest(row => {
      if (current() && row.executor === executor && row.sessionId === session)
        update(`permission:${row.requestId}`, row.messageId, !row.resolved);
    });
    return () => { off(); offPermission(); if (timer) clearTimeout(timer); };
  }, [session, executor, current, load, loadHistory]);
  useEffect(() => { if (open && online) { void load(); void check(); } }, [open, online, load, check]);
  useEffect(() => {
    if (!open || !online || !draft.title.trim() || !draft.prompt.trim()) return;
    let cancelled = false;
    const snapshot = JSON.stringify(draft);
    const timer = setTimeout(() => {
      void api.sessionSchedulePreview(session, executor, draft).then(row => {
        if (!cancelled && current() && JSON.stringify(draftRef.current) === snapshot)
          setPreview(`${row.localTime || '无下一时点'} · ${row.timezone}。${row.dstPolicy}`);
      }).catch(() => { /* 表单编辑过程保持安静；显式预览/保存显示确切错误。 */ });
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, online, draft, session, executor, current]);

  const write = async (intent: ScheduleIntent) => {
    if (!onlineRef.current) { setNotice('所属执行节点离线，未提交；草稿保留。'); return; }
    if (pendingRef.current || saving) return;
    const saved: Pending = { intent, draft: JSON.stringify(draftRef.current) };
    try { persist(saved); } catch { setNotice('无法保存本地请求标识，未提交；请恢复浏览器存储后再试。'); return; }
    pendingRef.current = saved; setPending(saved); setSaving(true); setNotice('提交中…');
    try { acceptedRef.current(await api.sessionScheduleSave(session, executor, intent), saved); }
    catch (error) {
      if (!current()) return;
      const e = error as Error & { serverRejected?: boolean; notSubmitted?: boolean };
      if (e.serverRejected || e.notSubmitted) {
        pendingRef.current = null; setPending(null); try { persist(null); } catch { /* 草稿仍在 */ }
        setNotice(`未保存：${e.message}。草稿已保留。`);
      } else setNotice(`结果未知：${String(error)}。保留原请求，不自动重发。`);
    } finally { if (current()) setSaving(false); }
  };
  const save = async (enabled: boolean) => {
    const config = { ...draftRef.current, enabled }, original = JSON.stringify(draftRef.current);
    try {
      const value = await api.sessionSchedulePreview(session, executor, config);
      if (!current() || JSON.stringify(draftRef.current) !== original) return;
      setPreview(`${value.localTime || '无下一时点'} · ${value.timezone}`);
      await write({ action: 'save', id: editing?.id || uuid(), requestId: uuid(), expectedRevision: editing?.revision || 0, config });
    } catch (error) { if (current()) setNotice(`未提交：${String(error)}`); }
  };
  const edit = async (id: string) => {
    const previous = JSON.stringify(draftRef.current);
    try { const row = await api.sessionScheduleGet(session, executor, id); if (current() && previous === JSON.stringify(draftRef.current)) { setEditing(row); setDraft(row); setPreview(''); setNotice(''); } }
    catch (error) { if (current()) setNotice(String(error)); }
  };
  const showOutput = async (item: ScheduleOccurrence, offset = 0) => {
    const key = `${item.id}:${offset}`;
    if (outputFlight.current === key || offset && (outputRef.current?.id !== item.id || outputRef.current.nextOffset !== offset)) return;
    const serial = ++outputRequest.current;
    outputFlight.current = key;
    try {
      const row = await api.sessionScheduleOutput(session, executor, item.id, offset);
      if (current() && outputRequest.current === serial) setOutput(old => ({ id: item.id, ...row, text: offset && old?.id === item.id ? old.text + row.text : row.text }));
    } catch (error) { if (current()) setNotice(String(error)); }
    finally { if (outputRequest.current === serial) outputFlight.current = ''; }
  };
  const enabledCount = page?.enabledCount ?? page?.items.filter(x => x.enabled && !x.deleted).length;
  const waiting = waitingInput ? '等待用户输入' : activeOccurrence.current ? `${lastState}${page?.queuePaused ? ' · 后续队列暂停' : ''}` : page?.queuePaused ? '队列暂停' : page?.blockedReason || lastState;
  const disabled = saving || !!pending || !online || !page?.ready;
  const setRule = (kind: ScheduleConfig['rule']['kind']) => change({ rule: kind === 'once' ? { kind, at: '' } : kind === 'interval'
    ? { kind, seconds: 3600, anchor: Date.now() / 1000 + 3600 } : { kind, time: '09:00', ...(kind === 'weekly' ? { weekdays: [0] } : {}) } });
  return <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '2px 10px', fontSize: 12 }}>
    <WorkflowPopover label="Session 定时指令" title="定时" icon="bell" badge={enabledCount || undefined} open={open} onOpenChange={setOpen} width={520} warning={!!pending || page?.unknown}>
      <p style={{ margin: 0 }}>到点在本 Session 执行，使用执行时的模型与上下文。关闭页签或远端断线不停止任务；执行节点需保持运行。</p>
      <p role="status">{online ? '已连接' : '连接中断，保留已收到的状态'}{lastSync ? ` · 最近同步 ${fmt(lastSync)}` : ''}</p>
      {page?.error && <p role="alert">{page.error}</p>}
      {page?.blockedReason && <p>等待执行：{page.blockedReason}</p>}
      {page?.queuePaused && <p>队列已暂停：{page.queueError || '需要手动继续'}。到点不会自动恢复。</p>}
      {notice && <p role="status" style={{ overflowWrap: 'anywhere' }}>{notice}</p>}
      {pending && <WorkflowButton onClick={() => void check()}>只读核对原请求</WorkflowButton>}
      <div style={actions}><WorkflowButton onClick={() => void load()}>刷新状态</WorkflowButton>
        <WorkflowButton disabled={!!pending} onClick={() => { setEditing(null); setDraft(fresh()); setPreview(''); }}>新建计划</WorkflowButton></div>
      {page?.items.filter(row => !row.deleted).map(row => <div key={row.id} style={{ borderBottom: '1px solid var(--theme-border)', padding: '10px 0' }}>
        <strong>{row.title}</strong> · {row.enabled ? '已启用' : '已停用'}<div>下次：{fmt(row.nextDueAt, row.timezone)} · {row.timezone}</div>
        <div style={actions}><WorkflowButton disabled={!!pending} onClick={() => void edit(row.id)}>编辑 {row.title}</WorkflowButton>
          <WorkflowButton disabled={disabled} onClick={() => void write({ action: 'enable', id: row.id, expectedRevision: row.revision, enabled: !row.enabled, requestId: uuid() })}>{row.enabled ? '停用' : '启用'}</WorkflowButton>
          <WorkflowButton disabled={disabled} onClick={() => void write({ action: 'delete', id: row.id, expectedRevision: row.revision, requestId: uuid() })}>删除计划</WorkflowButton></div>
      </div>)}
      {page?.nextOffset != null && <WorkflowButton onClick={() => void load(page.nextOffset!)}>更多计划</WorkflowButton>}
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: '12px 0', minWidth: 0 }}>
        <legend>{editing ? `编辑计划 · 修订 ${editing.revision}` : '新建定时指令'}</legend>
        <label style={field}>名称<input aria-label="定时名称" maxLength={120} style={workflowFieldStyle} value={draft.title} onChange={e => change({ title: e.target.value })} /></label>
        <label style={field}>预设指令<textarea aria-label="预设指令" rows={4} maxLength={64000} style={{ ...workflowFieldStyle, resize: 'vertical' }} value={draft.prompt} onChange={e => change({ prompt: e.target.value })} /></label>
        <label style={field}>运行规则<select aria-label="运行规则" style={workflowFieldStyle} value={draft.rule.kind} onChange={e => setRule(e.target.value as ScheduleConfig['rule']['kind'])}>
          <option value="once">单次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">固定间隔</option></select></label>
        <label style={field}>时区<input aria-label="定时时区" style={workflowFieldStyle} value={draft.timezone} placeholder="Asia/Shanghai" onChange={e => change({ timezone: e.target.value })} /></label>
        {draft.rule.kind === 'once' && <>
          {typeof draft.rule.at === 'number' && <p>已保存时间：{new Date(draft.rule.at * 1000).toLocaleString(undefined, { timeZone: draft.timezone })} · {draft.timezone}</p>}
          <label style={field}>当地日期和时间<input aria-label="单次当地时间" type="datetime-local" style={workflowFieldStyle} value={typeof draft.rule.at === 'string' ? draft.rule.at : ''} onChange={e => change({ rule: { ...draft.rule, at: e.target.value } })} /></label>
          <label style={field}>重复时间的 UTC 时差（可选）<select aria-label="UTC 时差" style={workflowFieldStyle} value={draft.rule.offsetMinutes ?? ''} onChange={e => change({ rule: { ...draft.rule, offsetMinutes: e.target.value === '' ? undefined : Number(e.target.value) } })}>
            <option value="">自动；歧义时提示选择</option>{Array.from({ length: 105 }, (_, i) => i * 15 - 720).map(n => <option key={n} value={n}>{`UTC${n < 0 ? '-' : '+'}${String(Math.floor(Math.abs(n) / 60)).padStart(2, '0')}:${String(Math.abs(n) % 60).padStart(2, '0')}`}</option>)}</select></label>
        </>}
        {(draft.rule.kind === 'daily' || draft.rule.kind === 'weekly') && <label style={field}>当地时间<input aria-label="每日时间" type="time" style={workflowFieldStyle} value={draft.rule.time || ''} onChange={e => change({ rule: { ...draft.rule, time: e.target.value } })} /></label>}
        {draft.rule.kind === 'weekly' && <div style={actions}>{['一', '二', '三', '四', '五', '六', '日'].map((day, index) => <label key={day}><input type="checkbox" checked={draft.rule.weekdays?.includes(index) || false} onChange={e => change({ rule: { ...draft.rule, weekdays: e.target.checked ? [...draft.rule.weekdays || [], index] : draft.rule.weekdays?.filter(d => d !== index) } })} />周{day}</label>)}</div>}
        {draft.rule.kind === 'interval' && <label style={field}>间隔分钟<input aria-label="间隔分钟" type="number" min={1} max={527040} style={workflowFieldStyle} value={(draft.rule.seconds || 60) / 60} onChange={e => { const seconds = Number(e.target.value) * 60; change({ rule: { kind: 'interval', seconds, anchor: Date.now() / 1000 + seconds } }); }} /></label>}
        <label style={field}>错过时间时<select aria-label="错过时间时" style={workflowFieldStyle} value={draft.misfirePolicy} onChange={e => change({ misfirePolicy: e.target.value as ScheduleConfig['misfirePolicy'] })}><option value="catch_up_once">合并补跑一次</option><option value="skip">跳过，等待下一次</option></select></label>
        <p>忙时排队，同一计划最多保留一次待执行；失败或结果未知不会自动重试。</p>
        <div style={actions}><WorkflowButton disabled={!online} onClick={() => { const original = JSON.stringify(draftRef.current); void api.sessionSchedulePreview(session, executor, draftRef.current).then(row => { if (current() && original === JSON.stringify(draftRef.current)) setPreview(`${row.localTime || '无下一时点'} · ${row.timezone}。${row.dstPolicy}`); }).catch(e => { if (current()) setNotice(String(e)); }); }}>预览下一次时间</WorkflowButton></div>
        {preview && <p role="status">下次：{preview}</p>}
        <div style={actions}><WorkflowButton tone="primary" disabled={disabled} onClick={() => void save(true)}>保存并启用</WorkflowButton><WorkflowButton disabled={disabled} onClick={() => void save(false)}>保存为停用</WorkflowButton></div>
      </fieldset>
      <WorkflowButton aria-expanded={historyOpen} onClick={() => { setHistoryOpen(!historyOpen); if (!historyOpen) void loadHistory(); }}>运行历史</WorkflowButton>
      {historyOpen && <div>{!history.length && <p>暂无运行记录。</p>}{history.map(item => <div key={item.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--theme-border)' }}>
        <strong>{item.title}</strong> · {item.waitingForInput ? '等待用户输入' : scheduleStateLabel[item.state] || item.state}
        <div>原定 {fmt(item.scheduledAt)}{item.startedAt ? ` · 开始 ${fmt(item.startedAt)}` : ''}</div>
        {item.coalescedCount > 1 && <div>已合并 {item.coalescedCount} 个时点，至 {fmt(item.coveredThrough)}</div>}
        {item.error && <div style={{ overflowWrap: 'anywhere' }}>{item.error}</div>}
        <div style={actions}><WorkflowButton onClick={() => void showOutput(item)}>查看原输出</WorkflowButton>
          {onLocate && <WorkflowButton onClick={() => { if (onLocate(item.assistantMessageId)) setOpen(false); else { setNotice('原消息不在当前已加载范围，已读取原保存内容；完整工具记录可在聊天加载更早消息查看。'); void showOutput(item); } }}>定位原聊天</WorkflowButton>}
          {item.waitingForInput && onPending && <WorkflowButton onClick={() => { setOpen(false); onPending(); }}>处理待输入</WorkflowButton>}
          {['prepared', 'queued', 'failed', 'interrupted'].includes(item.state) && <WorkflowButton disabled={disabled} onClick={() => void write({ action: 'cancel', id: item.id, requestId: uuid() })}>取消本次</WorkflowButton>}
          {['failed', 'interrupted'].includes(item.state) && <WorkflowButton disabled={disabled} onClick={() => void write({ action: 'retry', id: item.id, requestId: uuid() })}>重试本次并继续</WorkflowButton>}
          {['claimed', 'running'].includes(item.state) && <WorkflowButton onClick={onStop}>停止当前轮</WorkflowButton>}
          {item.state === 'unknown' && <WorkflowButton disabled={disabled} onClick={() => { if (window.confirm('请先查看原聊天并核对副作用。结束本次不会重试，也不表示任务成功。确认已核对？')) void write({ action: 'resolve', id: item.id, confirmed: true, requestId: uuid() }); }}>核对后结束本次</WorkflowButton>}
        </div></div>)}{nextHistory != null && <WorkflowButton onClick={() => void loadHistory(nextHistory)}>更早记录</WorkflowButton>}</div>}
      {output && <section aria-label="定时原输出"><p>原聊天已保存内容 · {output.messageId}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflow: 'auto' }}>{output.text || '尚无保存的正文；活动输出可在本 Session 聊天中查看。'}</pre>
        {output.nextOffset != null && <WorkflowButton onClick={() => { const item = history.find(x => x.id === output.id); if (item) void showOutput(item, output.nextOffset!); }}>继续读取原输出</WorkflowButton>}
        <WorkflowButton onClick={() => { outputRequest.current++; outputFlight.current = ''; setOutput(null); }}>收起原输出</WorkflowButton></section>}
    </WorkflowPopover>
    {(waiting || pending || !online && lastSync > 0) && <span style={{ color: 'var(--theme-text-muted)' }}>{pending ? '保存结果待核对' : !online ? '离线 · 保留上次状态' : waiting}</span>}
    {waitingInput && onPending && <WorkflowButton onClick={onPending}>处理待输入</WorkflowButton>}
  </div>;
};
