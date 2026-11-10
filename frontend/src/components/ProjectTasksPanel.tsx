import { WorkflowButton, WorkflowEmptyState, workflowHeaderStyle, workflowDialogStyle } from './WorkflowControls';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { TaskWorkspace, TaskRepository } from '../types/taskWorkspaces';
import type { CollaborationSummary } from '../types/sessionCollaboration';
import { AppModalPortal } from './AppModalPortal';
import { TaskWorkspaceForm, TaskWorkspaceDetails, copyActionStyle } from './TaskWorkspaceForm';
import { useCollaborationRead } from '../hooks/useCollaborationRead';
import { uuid } from '../utils/uuid';
import { ProjectMergePanel } from './ProjectMergePanel';
import { ProjectBranchGraph } from './ProjectBranchGraph';

interface Props { session: string; executor: string; backendId: string; backends: any[]; onOpenSession?: (id: string) => void;
  sessionTitle?: string; sessionRole?: string;
  initialAction?: 'create' | 'manage' | 'merge'; workspaceId?: string; mergeTarget?: string; initialOperation?: string; canCreate?: boolean; onClose?: () => void }
const statusLabel: Record<string, string> = { preview: '待确认创建', creating: '正在创建', ready: '工作区就绪', error: '创建失败', unknown: '结果未知', archived: '已归档', cleaned: '已清理', discarded: '预览已移除' };

export const ProjectTasksPanel: React.FC<Props> = ({ session, executor, backendId, backends, onOpenSession, sessionTitle, sessionRole, initialAction, workspaceId, mergeTarget, initialOperation, canCreate = true, onClose }) => {
  const [open, setOpen] = useState(!!initialAction), [revision, setRevision] = useState(0), [rows, setRows] = useState<CollaborationSummary[]>([]);
  const [selected, setSelected] = useState(workspaceId || ''), [task, setTask] = useState<TaskWorkspace>();
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [unavailable, setUnavailable] = useState<{ title: string; description: string; detail?: string }>();
  const [repo, setRepo] = useState<TaskRepository>(), [config, setConfig] = useState<TaskWorkspace['config']>({ title: '', goal: '', backendId, runtime: {}, constraints: '', skills: [], skipPermissions: false, includePaths: [] });
  const [uncertain, setUncertain] = useState(false), [readNonce, setReadNonce] = useState(0);
  const [mode, setMode] = useState<'tasks' | 'merge' | 'graph'>(initialAction === 'merge' ? 'merge' : 'tasks');
  const [mergeContext, setMergeContext] = useState({ session, operation: initialOperation, target: mergeTarget });
  const current = useRef(`${executor}:${session}`); current.current = `${executor}:${session}`;
  const busyRef = useRef(false), panel = useRef<HTMLDivElement>(null);
  const createdHere = useRef(''), viewEpoch = useRef(0);
  const discardedPreviews = useRef(new Set<string>());
  const removePreview = (id: string) => {
    discardedPreviews.current.add(id);
    setRows(old => old.filter(row => row.id !== id));
    setSelected(old => old === id ? '' : old);
    setTask(old => old?.id === id ? undefined : old);
    if (selected === id) { setUncertain(false); setNotice('已移除待确认预览。'); }
  };
  const acceptTask = (row: TaskWorkspace) => {
    if (row.status === 'discarded') removePreview(row.id);
    else if (!discardedPreviews.current.has(row.id)) setTask(row);
  };
  const runtimeBackend = backends.find(row => row.id === config.backendId);
  const close = () => { viewEpoch.current++; createdHere.current = ''; setOpen(false); onClose?.(); };
  useEffect(() => { current.current = `${executor}:${session}`; return () => { current.current = ''; }; }, [session, executor]);
  useEffect(() => api.onTaskWorkspaceUpdated((row, node) => {
    if (node !== executor || row.sourceSessionId !== session && row.sessionId !== session) return;
    if (row.status === 'discarded') removePreview(row.id);
    setRevision(n => n + 1);
  }), [session, executor, selected]);
  useCollaborationRead(`${executor}:${session}:tasks`, revision, open && mode === 'tasks',
    () => api.collaborationList(session, executor, 'workspace'),
    result => { const items = result.items.filter(row => row.status !== 'discarded' && !discardedPreviews.current.has(row.id));
      setRows(items); }, error => setNotice(String(error)));
  useEffect(() => {
    // 服务端按更新时间倒序；正在确认或结果未知时保留本条，不能切走待核对操作。
    if (!open || mode !== 'tasks' || editing || busy || uncertain
      || task?.id === selected && ['preview', 'creating', 'unknown'].includes(task.status)) return;
    const latest = workspaceId && !discardedPreviews.current.has(workspaceId) ? workspaceId : rows[0]?.id || '';
    if (latest === selected) return;
    if (selected) setNotice('');
    setSelected(latest); setTask(undefined);
  }, [open, mode, editing, busy, uncertain, task, selected, rows, workspaceId]);
  useCollaborationRead(`${executor}:${session}:task:${selected}:${readNonce}`, rows.find(row => row.id === selected)?.revision || 0, open && mode === 'tasks' && !!selected && !editing,
    () => api.taskWorkspaceStatus(session, executor, selected), acceptTask, error => setNotice(String(error)));
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { previous?.focus(); };
  }, [open]);
  const act = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    const identity = current.current;
    busyRef.current = true; setBusy(true); setNotice('');
    try { await work(); } catch (error) { if (identity === current.current) setNotice(String(error)); }
    finally { busyRef.current = false; if (identity === current.current) setBusy(false); }
  };
  const newTask = () => void act(async () => {
    viewEpoch.current++;
    createdHere.current = '';
    setUnavailable(undefined); setEditing(false);
    const identity = current.current; const result = await api.taskWorkspaceInspect(session, executor);
    if (identity !== current.current) return;
    if (result.status !== 'ready') {
      setUnavailable(result.reason ? { title: result.notice, description: result.preparation || '', detail: result.detail }
        : { title: '暂时无法创建分支副本', description: '请查看详情，处理后重新检查。', detail: result.notice });
      return;
    }
    if (!result.defaults) { setNotice('该执行节点尚不支持继承配置的分支副本，请更新节点后再创建。'); return; }
    setRepo(result); setConfig({ ...result.defaults, includePaths: result.dirty.filter(row => !row.blocked).map(row => row.path) });
    setEditing(true); setUncertain(false);
  });
  const initialStarted = useRef(false);
  useEffect(() => { if (initialAction === 'create' && !initialStarted.current) { initialStarted.current = true; newTask(); } }, [initialAction]);
  const preview = () => void act(async () => {
    const identity = current.current, frozen = structuredClone(config);
    const result = await api.taskWorkspacePlan(session, executor, uuid(), frozen);
    if (identity !== current.current) return;
    setTask(result); setSelected(result.id); setEditing(false); setRevision(n => n + 1); setUncertain(false);
  });
  const submitCreate = async (plan: TaskWorkspace, epoch: number) => {
    if (plan.status !== 'preview') return;
    if (epoch === viewEpoch.current) createdHere.current = plan.id;
    const identity = current.current; setUncertain(true);
    try {
      const result = await api.taskWorkspaceCreate(session, executor, plan.id, uuid(), plan.planFingerprint);
      if (identity !== current.current) return;
      setTask(result); setRevision(n => n + 1); setUncertain(false);
      setNotice(result.status === 'creating' ? '正在创建副本，完成后进入新对话。' : '');
    } catch { if (identity === current.current) setNotice('创建结果未知，请核对副本状态；没有重复提交。'); }
  };
  const create = () => void act(async () => {
    if (uncertain) return;
    const epoch = viewEpoch.current;
    if (!editing) { if (task) await submitCreate(task, epoch); return; }
    // 同一次用户点击先冻结配置，再按该计划创建；计划失败不能继续写入。
    const identity = current.current;
    const plan = await api.taskWorkspacePlan(session, executor, uuid(), structuredClone(config));
    if (identity !== current.current) return;
    setTask(plan); setSelected(plan.id); setEditing(false); setRevision(n => n + 1);
    await submitCreate(plan, epoch);
  });
  const shown = !unavailable && task?.id === selected ? task : undefined;
  const discardPreview = () => void act(async () => {
    if (!shown || shown.status !== 'preview' || uncertain) return;
    const identity = current.current; setUncertain(true);
    try {
      const result = await api.taskWorkspaceDiscardPreview(session, executor, shown.id, uuid(), shown.planFingerprint);
      if (identity !== current.current) return;
      acceptTask(result); setRevision(n => n + 1);
      if (result.status !== 'discarded') setNotice('移除尚未确认，请核对原预览；没有重复提交。');
    } catch { if (identity === current.current && !discardedPreviews.current.has(shown.id)) setNotice('移除结果未知，请核对副本状态；没有重复提交。'); }
  });
  useEffect(() => {
    // 仅本次创建得到就绪回执后进入普通会话；查看历史、关闭窗口或接收请求不会跳转。
    if (!open || editing || mode !== 'tasks' || !onOpenSession || shown?.status !== 'ready' || shown.id !== createdHere.current) return;
    createdHere.current = '';
    onOpenSession(shown.sessionId); setOpen(false); onClose?.();
  }, [open, editing, mode, initialAction, shown, onOpenSession, onClose]);
  const creationView = mode === 'tasks' && (!!unavailable || initialAction === 'create' || editing || shown?.status === 'preview' || !!shown && shown.id === createdHere.current);
  const createBlocked = busy || uncertain || (editing && (!config.title.trim() || !runtimeBackend || runtimeBackend.enabled === false || config.snapshotMode === 'current' && !!repo?.dirty.some(row => !!row.blocked)));
  const checkStatus = () => { setRevision(n => n + 1); setReadNonce(n => n + 1); };
  return <>
    {!initialAction && <WorkflowButton tone="quiet" icon="branch" aria-label="分支副本与合并" onClick={() => { setRevision(n => n + 1); setOpen(true); }} style={{ whiteSpace: 'nowrap' }}>分支副本</WorkflowButton>}
    {open && <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31100, display: 'grid', placeItems: 'center', padding: 10, background: '#0007' }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="分支副本" style={{ ...workflowDialogStyle, width: creationView ? 'min(560px, 100%)' : 'min(1060px, 100%)', height: creationView ? undefined : 'min(86vh, 800px)', maxHeight: 'calc(100dvh - 24px)', display: 'flex', flexDirection: 'column', background: 'var(--theme-panel-solid, var(--theme-bg-secondary, white))', color: 'var(--theme-text, black)', borderRadius: 16, overflow: 'hidden' }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          if (event.key === 'Tab') { const nodes = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(node => node.getClientRects().length > 0);
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        {creationView ? <header style={{ ...workflowHeaderStyle, padding: '20px 24px', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 18, lineHeight: 1.4, margin: 0 }}>新建分支副本</h2>
          <WorkflowButton tone="quiet" icon="close" aria-label="返回对话" title="关闭" onClick={close} style={{ minHeight: 36, width: 36, padding: 0 }} />
          {!unavailable && <p style={{ width: '100%', margin: 0, color: 'var(--theme-text-muted, #687487)' }}>从当前项目开启新对话，目录和分支自动分配。</p>}
        </header> : <header style={workflowHeaderStyle}><strong style={{ flex: 1, fontWeight: 600, whiteSpace: 'nowrap' }}>分支与合并</strong>
          <WorkflowButton tone="quiet" aria-pressed={mode === 'tasks'} onClick={() => setMode('tasks')}>副本</WorkflowButton><WorkflowButton tone="quiet" aria-label={mergeTarget ? '合并与同步' : '合并记录'} title={mergeTarget ? '合并与同步' : '合并记录'} aria-pressed={mode === 'merge'} onClick={() => setMode('merge')}>合并请求</WorkflowButton>
          <WorkflowButton tone="quiet" aria-pressed={mode === 'graph'} onClick={() => setMode('graph')}>分支</WorkflowButton>
          {mode === 'tasks' && <>{canCreate && <WorkflowButton tone="primary" icon="plus" disabled={busy} onClick={newTask}>新建分支副本</WorkflowButton>}
          <WorkflowButton onClick={checkStatus}>核对副本状态</WorkflowButton></>}
          <WorkflowButton onClick={close}>返回对话</WorkflowButton>
          {sessionTitle && <div aria-label="当前入口" style={{ width: '100%', color: 'var(--theme-text-muted)', fontSize: 12, overflowWrap: 'anywhere' }}>当前入口：{sessionRole || (mergeTarget ? '分支' : '会话')} · {sessionTitle}</div>}
        </header>}
        {mode === 'graph' ? <ProjectBranchGraph session={session} executor={executor} onOpenSession={id => { onOpenSession?.(id); close(); }}
          onOpenMerge={(source, parent) => { setMergeContext({ session: source, operation: undefined, target: parent }); setMode('merge'); }} /> : mode === 'merge' ? <ProjectMergePanel key={`${executor}:${mergeContext.session}:${mergeContext.target || ''}`} session={mergeContext.session} executor={executor}
          initialOperation={mergeContext.operation} fixedTarget={mergeContext.target}
          entrySession={session} entryRole={sessionRole} onBackToEntry={mergeContext.session !== session ? () => setMergeContext({ session, operation: initialOperation, target: mergeTarget }) : undefined}
          onOpenOrigin={(origin, operation, parent) => setMergeContext({ session: origin, operation, target: parent || (origin === session ? mergeTarget : undefined) })}
          onOpenSession={id => { onOpenSession?.(id); close(); }} /> : <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          <section aria-label="当前分支副本" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: creationView ? 24 : 20 }}>
            {unavailable ? <WorkflowEmptyState icon="branch" title={unavailable.title}>
              <span role="status">{unavailable.description}</span>
              {unavailable.detail && <details style={{ marginTop: 12, textAlign: 'left', overflowWrap: 'anywhere' }}><summary>查看详情</summary>{unavailable.detail}</details>}
            </WorkflowEmptyState> : editing && repo ? <TaskWorkspaceForm config={config} repo={repo} backends={backends} executor={executor}
              busy={busy} setConfig={setConfig} onPreview={preview} /> : shown ? <>
              <h3 style={{ margin: '0 0 12px', fontSize: 16, overflowWrap: 'anywhere' }}>{shown.title} · {statusLabel[shown.status] || shown.status}</h3>
              <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                <div>{backends.find(row => row.id === shown.config.backendId)?.label || shown.config.backendId} · {shown.config.runtime.model || '默认模型'}{shown.config.runtime.reasoningEffort ? ` · ${shown.config.runtime.reasoningEffort}` : ''}</div>
                <div style={{ color: 'var(--theme-text-muted)' }}>普通执行确认：{shown.config.skipPermissions ? '跳过' : '保留'}</div>
                {shown.config.goal && <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 120, overflow: 'auto' }}>{shown.config.goal}</p>}
              </div>
              <TaskWorkspaceDetails key={shown.id} task={shown} />
              {shown.notice && shown.status !== 'preview' && <p style={{ overflowWrap: 'anywhere' }}>{shown.notice}</p>}
              {['ready', 'archived'].includes(shown.status) && <WorkflowButton disabled={!onOpenSession} onClick={() => { onOpenSession?.(shown.sessionId); close(); }}>打开副本 Session</WorkflowButton>}
              {shown.startReceipt && <p>初始需求：{shown.startReceipt.result?.notice || shown.startReceipt.status}</p>}
              {shown.status === 'ready' && shown.config.goal && !shown.startRequestId && <WorkflowButton disabled={busy || uncertain} onClick={() => void act(async () => {
                const identity = current.current; setUncertain(true);
                const result = await api.taskWorkspaceStart(session, executor, shown.id, uuid());
                if (identity === current.current) { setNotice(result.result?.notice || result.status); if (result.status === 'succeeded') { onOpenSession?.(shown.sessionId); close(); } }
              })}>启动初始需求</WorkflowButton>}
              {shown.status === 'ready' && <WorkflowButton disabled={busy} onClick={() => void act(async () => {
                const identity = current.current; const result = await api.taskWorkspaceArchive(session, executor, shown.id, uuid()); if (identity === current.current) { setTask(result); setRevision(n => n + 1); }
              })}>归档任务（保留成果）</WorkflowButton>}
              {shown.status === 'archived' && <WorkflowButton disabled={busy} onClick={() => void act(async () => {
                const identity = current.current; const result = await api.taskWorkspaceCleanupPlan(session, executor, shown.id); if (identity === current.current) setTask(result);
              })}>预览清理本任务</WorkflowButton>}
              {shown.status === 'archived' && shown.cleanupPlan && <div><p>{shown.cleanupPlan.notice}</p>
                <p>将移除：{shown.cleanupPlan.workspace.root}<br />分支：{shown.cleanupPlan.workspace.branch}<br />已合入父项目：{shown.cleanupPlan.parent.head.slice(0, 12)}</p>
                <WorkflowButton disabled={busy || uncertain} onClick={() => void act(async () => {
                  const identity = current.current; setUncertain(true); const result = await api.taskWorkspaceCleanup(session, executor, shown.id, uuid(), shown.cleanupPlan!.fingerprint);
                  if (identity === current.current) { setTask(result); setRevision(n => n + 1); setUncertain(false); }
                })}>确认清理已合并的本任务目录与分支</WorkflowButton></div>}
            </> : <WorkflowEmptyState icon="branch" title={busy ? '正在检查主 Session…' : '独立分支，并行开发'}>主 Session 右键新建分支副本。完成后，右键副本合并到主 Session；原目录和分支会保留。</WorkflowEmptyState>}
            {notice && <p role="status" style={{ overflowWrap: 'anywhere' }}>{notice}</p>}
          </section>
        </div>}
        {creationView && <footer style={{ flexShrink: 0, padding: '16px 24px', borderTop: '1px solid var(--theme-border, #dce1e8)' }}>
          {!unavailable && <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text-muted, #687487)' }}>创建后进入新对话，由你发送消息开始。</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            {(uncertain || shown?.status === 'creating' || shown?.status === 'unknown') && <WorkflowButton icon="refresh" onClick={checkStatus} style={copyActionStyle}>核对副本状态</WorkflowButton>}
            {!editing && shown?.status === 'preview' && <WorkflowButton disabled={busy || uncertain} onClick={() => { setRepo(shown.repository); setConfig(shown.config); setEditing(true); }} style={copyActionStyle}>修改配置</WorkflowButton>}
            <WorkflowButton onClick={close} style={copyActionStyle}>{unavailable ? '知道了' : shown?.status === 'creating' || uncertain ? '关闭' : '取消'}</WorkflowButton>
            {unavailable && <WorkflowButton icon="refresh" disabled={busy} onClick={newTask} style={copyActionStyle}>重新检查</WorkflowButton>}
            {(editing || shown?.status === 'preview') && <WorkflowButton tone="primary" disabled={createBlocked} onClick={create} style={copyActionStyle}>{busy ? '正在创建…' : '创建副本'}</WorkflowButton>}
          </div>
          {!editing && shown?.status === 'preview' && <WorkflowButton tone="quiet" disabled={busy || uncertain} onClick={discardPreview} style={{ marginTop: 10 }}>移除预览</WorkflowButton>}
        </footer>}
      </div>
    </div></AppModalPortal>}
  </>;
};
