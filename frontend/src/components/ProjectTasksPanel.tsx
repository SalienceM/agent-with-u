import { WorkflowButton, WorkflowEmptyState, workflowHeaderStyle, workflowNavStyle, workflowDialogStyle, workflowFieldStyle } from './WorkflowControls';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { TaskWorkspace, TaskRepository } from '../types/taskWorkspaces';
import type { CollaborationSummary } from '../types/sessionCollaboration';
import { AppModalPortal } from './AppModalPortal';
import { BackendRuntimeFields, isRuntimeConfigurableBackend } from './CodexRuntimeFields';
import { useCollaborationRead } from '../hooks/useCollaborationRead';
import { uuid } from '../utils/uuid';
import { ProjectMergePanel } from './ProjectMergePanel';

interface Props { session: string; executor: string; backendId: string; backends: any[]; onOpenSession?: (id: string) => void }
const statusLabel: Record<string, string> = { preview: '待确认创建', creating: '正在创建', ready: '工作区就绪', error: '创建失败', unknown: '结果未知', archived: '已归档', cleaned: '已清理' };
const field = workflowFieldStyle;

export const ProjectTasksPanel: React.FC<Props> = ({ session, executor, backendId, backends, onOpenSession }) => {
  const [open, setOpen] = useState(false), [revision, setRevision] = useState(0), [rows, setRows] = useState<CollaborationSummary[]>([]);
  const [selected, setSelected] = useState(''), [task, setTask] = useState<TaskWorkspace>(), [next, setNext] = useState<number | null>(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [repo, setRepo] = useState<TaskRepository>(), [config, setConfig] = useState<TaskWorkspace['config']>({ title: '', goal: '', backendId, runtime: {}, constraints: '', skills: [], skipPermissions: false, includePaths: [] });
  const [uncertain, setUncertain] = useState(false), [readNonce, setReadNonce] = useState(0);
  const [mode, setMode] = useState<'tasks' | 'merge'>('tasks');
  const current = useRef(`${executor}:${session}`); current.current = `${executor}:${session}`;
  const busyRef = useRef(false), panel = useRef<HTMLDivElement>(null);
  const runtimeBackend = backends.find(row => row.id === config.backendId);
  useEffect(() => { setOpen(false); setRows([]); setSelected(''); setTask(undefined); setEditing(false); setRepo(undefined); setNotice(''); setUncertain(false); }, [session, executor]);
  useEffect(() => api.onTaskWorkspaceUpdated((row, node) => { if (node === executor && (row.sourceSessionId === session || row.sessionId === session)) setRevision(n => n + 1); }), [session, executor]);
  useCollaborationRead(`${executor}:${session}:tasks`, revision, open && mode === 'tasks',
    () => api.collaborationList(session, executor, 'workspace'),
    result => { setRows(old => [...result.items, ...old.filter(row => !result.items.some(item => item.id === row.id))]); setNext(result.nextOffset); setSelected(id => id || result.items[0]?.id || ''); }, error => setNotice(String(error)));
  useCollaborationRead(`${executor}:${session}:task:${selected}:${readNonce}`, rows.find(row => row.id === selected)?.revision || 0, open && mode === 'tasks' && !!selected && !editing,
    () => api.taskWorkspaceStatus(session, executor, selected), setTask, error => setNotice(String(error)));
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
    const identity = current.current; const result = await api.taskWorkspaceInspect(session, executor);
    if (identity !== current.current) return;
    if (result.status !== 'ready') { setNotice([result.notice, result.preparation].filter(Boolean).join(' ')); return; }
    setRepo(result); setConfig({ title: '', goal: '', backendId, runtime: {}, constraints: '', skills: [], skipPermissions: false, includePaths: [] });
    setEditing(true); setUncertain(false);
  });
  const preview = () => void act(async () => {
    const identity = current.current, frozen = structuredClone(config);
    const result = await api.taskWorkspacePlan(session, executor, uuid(), frozen);
    if (identity !== current.current) return;
    setTask(result); setSelected(result.id); setEditing(false); setRevision(n => n + 1); setUncertain(false);
  });
  const create = () => void act(async () => {
    if (!task || uncertain) return;
    const identity = current.current; setUncertain(true);
    try {
      const result = await api.taskWorkspaceCreate(session, executor, task.id, uuid(), task.planFingerprint);
      if (identity !== current.current) return;
      setTask(result); setRevision(n => n + 1); setUncertain(false);
      setNotice('创建请求已接收；以工作区和 Session 校验回执为准。');
    } catch { if (identity === current.current) setNotice('创建接收结果未知，请核对原任务；没有重复提交。'); }
  });
  const shown = task?.id === selected ? task : undefined;
  return <>
    <WorkflowButton tone="quiet" icon="branch" aria-label="项目任务与汇合" title="独立任务与成果汇合" onClick={() => setOpen(true)} style={{ whiteSpace: 'nowrap' }}>项目任务</WorkflowButton>
    {open && <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31100, display: 'grid', placeItems: 'center', padding: 10, background: '#0007' }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="项目任务" style={{ ...workflowDialogStyle, width: 'min(1060px, 100%)', height: 'min(86vh, 800px)', display: 'flex', flexDirection: 'column', background: 'var(--theme-bg-secondary, white)', color: 'var(--theme-text, black)', borderRadius: 16, overflow: 'hidden' }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
          if (event.key === 'Tab') { const nodes = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, summary')];
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header style={workflowHeaderStyle}><strong style={{ flex: 1 }}>项目任务</strong>
          <WorkflowButton tone="quiet" aria-pressed={mode === 'tasks'} onClick={() => setMode('tasks')}>任务</WorkflowButton><WorkflowButton tone="quiet" aria-pressed={mode === 'merge'} onClick={() => setMode('merge')}>成果汇合</WorkflowButton>
          {mode === 'tasks' && <><WorkflowButton tone="primary" icon="plus" disabled={busy} onClick={newTask}>新建独立任务</WorkflowButton>
          <WorkflowButton onClick={() => { setRevision(n => n + 1); setReadNonce(n => n + 1); }}>核对任务状态</WorkflowButton></>}
          <WorkflowButton onClick={() => setOpen(false)}>返回对话</WorkflowButton>
        </header>
        {mode === 'merge' ? <ProjectMergePanel key={`${executor}:${session}`} session={session} executor={executor} onOpenSession={id => { onOpenSession?.(id); setOpen(false); }} /> : <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          <nav aria-label="项目子任务" style={{ ...workflowNavStyle, display: rows.length ? 'flex' : 'none', width: 'clamp(85px, 24%, 230px)', overflow: 'auto', borderRight: '1px solid var(--theme-border)', flexShrink: 0 }}>
            {rows.map(row => <WorkflowButton tone="quiet" key={row.id} aria-pressed={selected === row.id && !editing} disabled={busy} style={{ width: '100%', padding: 9, overflowWrap: 'anywhere' }} onClick={() => { setSelected(row.id); setEditing(false); setUncertain(false); }}>{row.title} · {statusLabel[row.status || ''] || row.status}</WorkflowButton>)}
            {next !== null && <WorkflowButton onClick={() => void act(async () => { const identity = current.current; const result = await api.collaborationList(session, executor, 'workspace', next); if (identity === current.current) { setRows(old => [...old, ...result.items.filter(row => !old.some(item => item.id === row.id))]); setNext(result.nextOffset); } })}>更多任务</WorkflowButton>}
          </nav>
          <section style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 20 }}>
            {editing && repo ? <div style={{ display: 'grid', gap: 10 }}>
              <p>每个任务拥有独立分支、目录和上下文。默认从提交 {repo.head.slice(0, 12)} 建立。</p>
              <label>任务标题<input style={field} value={config.title} onChange={e => setConfig(old => ({ ...old, title: e.target.value }))} /></label>
              <label>初始需求<textarea rows={4} style={field} value={config.goal} onChange={e => setConfig(old => ({ ...old, goal: e.target.value }))} /></label>
              <label>执行 Backend<select style={field} value={config.backendId} onChange={e => setConfig(old => ({ ...old, backendId: e.target.value, runtime: {} }))}>{backends.filter(row => row.enabled !== false).map(row => <option key={row.id} value={row.id}>{row.label || row.id}</option>)}</select></label>
              {isRuntimeConfigurableBackend(runtimeBackend) && <BackendRuntimeFields backend={runtimeBackend} value={config.runtime} onChange={runtime => setConfig(old => ({ ...old, runtime }))} execKey={executor} />}
              <label>任务约束<textarea rows={3} style={field} value={config.constraints} onChange={e => setConfig(old => ({ ...old, constraints: e.target.value }))} /></label>
              <label>Skills（每行一个已安装 ID）<textarea rows={2} style={field} value={config.skills.join('\n')} onChange={e => setConfig(old => ({ ...old, skills: e.target.value.split('\n') }))} /></label>
              <label><input type="checkbox" checked={config.skipPermissions} onChange={e => setConfig(old => ({ ...old, skipPermissions: e.target.checked }))} />跳过该子 Session 的普通执行确认</label>
              {repo.dirty.length > 0 && <details open><summary>{repo.dirty.length} 条未提交路径 · 默认不包含</summary>
                {repo.dirty.map(row => <label key={row.path} style={{ display: 'block', padding: 4, overflowWrap: 'anywhere' }}><input type="checkbox" disabled={!!row.blocked} checked={config.includePaths.includes(row.path)} onChange={e => setConfig(old => ({ ...old, includePaths: e.target.checked ? [...old.includePaths, row.path] : old.includePaths.filter(path => path !== row.path) }))} />{row.path}{row.blocked ? ` · ${row.blocked}` : ''}</label>)}
                <p>选中路径将形成私有索引快照；主目录文件、暂存区和 HEAD 保持原样。</p>
              </details>}
              <WorkflowButton disabled={busy || !config.title.trim()} onClick={preview}>预览任务创建计划</WorkflowButton>
            </div> : shown ? <>
              <h3>{shown.title} · {statusLabel[shown.status] || shown.status}</h3>
              <p style={{ overflowWrap: 'anywhere' }}>{shown.root}</p><p style={{ overflowWrap: 'anywhere' }}>分支：{shown.branch}</p>
              <p>来源提交：{shown.repository.head.slice(0, 12)} · {shown.config.includePaths.length ? `包含 ${shown.config.includePaths.length} 条明确选定路径` : '仅含已提交内容'}</p>
              <details open={shown.status === 'preview'}><summary>需求与运行配置</summary><p style={{ whiteSpace: 'pre-wrap' }}>{shown.config.goal}</p>
                <p>Backend：{shown.config.backendId} · {shown.config.runtime.model || '默认模型'} · {shown.config.runtime.reasoningEffort || '默认推理档位'}</p>
                <p>普通执行确认：{shown.config.skipPermissions ? '跳过' : '保留'} · Skills：{shown.config.skills.filter(Boolean).join('、') || '无'}</p>
                <p style={{ whiteSpace: 'pre-wrap' }}>约束：{shown.config.constraints || '无附加约束'}</p>
                {shown.config.includePaths.map(path => <p key={path}>{path}</p>)}
              </details>
              {shown.notice && <p>{shown.notice}</p>}
              {shown.status === 'preview' && <WorkflowButton disabled={busy || uncertain} onClick={create}>确认创建独立任务（不运行模型）</WorkflowButton>}
              {['ready', 'archived'].includes(shown.status) && <WorkflowButton disabled={!onOpenSession} onClick={() => { onOpenSession?.(shown.sessionId); setOpen(false); }}>打开任务会话</WorkflowButton>}
              {shown.startReceipt && <p>初始需求：{shown.startReceipt.result?.notice || shown.startReceipt.status}</p>}
              {shown.status === 'ready' && shown.config.goal && !shown.startRequestId && <WorkflowButton disabled={busy || uncertain} onClick={() => void act(async () => {
                const identity = current.current; setUncertain(true);
                const result = await api.taskWorkspaceStart(session, executor, shown.id, uuid());
                if (identity === current.current) { setNotice(result.result?.notice || result.status); if (result.status === 'succeeded') { onOpenSession?.(shown.sessionId); setOpen(false); } }
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
            </> : <WorkflowEmptyState icon="branch" title="让每项需求独立推进">新建任务后，每项需求拥有自己的分支、目录与会话。完成后，在“成果汇合”中整合改动。</WorkflowEmptyState>}
            {notice && <p role="status" style={{ overflowWrap: 'anywhere' }}>{notice}</p>}
          </section>
        </div>}
      </div>
    </div></AppModalPortal>}
  </>;
};
