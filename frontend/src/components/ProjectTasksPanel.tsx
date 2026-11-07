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

interface Props { session: string; executor: string; backendId: string; backends: any[]; onOpenSession?: (id: string) => void;
  initialAction?: 'create' | 'manage' | 'merge'; workspaceId?: string; mergeTarget?: string; canCreate?: boolean; onClose?: () => void }
const statusLabel: Record<string, string> = { preview: '待确认创建', creating: '正在创建', ready: '工作区就绪', error: '创建失败', unknown: '结果未知', archived: '已归档', cleaned: '已清理', discarded: '预览已移除' };
const field = workflowFieldStyle;

export const ProjectTasksPanel: React.FC<Props> = ({ session, executor, backendId, backends, onOpenSession, initialAction, workspaceId, mergeTarget, canCreate = true, onClose }) => {
  const [open, setOpen] = useState(!!initialAction), [revision, setRevision] = useState(0), [rows, setRows] = useState<CollaborationSummary[]>([]);
  const [selected, setSelected] = useState(workspaceId || ''), [task, setTask] = useState<TaskWorkspace>(), [next, setNext] = useState<number | null>(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [repo, setRepo] = useState<TaskRepository>(), [config, setConfig] = useState<TaskWorkspace['config']>({ title: '', goal: '', backendId, runtime: {}, constraints: '', skills: [], skipPermissions: false, includePaths: [] });
  const [uncertain, setUncertain] = useState(false), [readNonce, setReadNonce] = useState(0);
  const [mode, setMode] = useState<'tasks' | 'merge'>(initialAction === 'merge' ? 'merge' : 'tasks');
  const current = useRef(`${executor}:${session}`); current.current = `${executor}:${session}`;
  const busyRef = useRef(false), panel = useRef<HTMLDivElement>(null);
  const createdHere = useRef('');
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
  const close = () => { setOpen(false); onClose?.(); };
  useEffect(() => { current.current = `${executor}:${session}`; return () => { current.current = ''; }; }, [session, executor]);
  useEffect(() => api.onTaskWorkspaceUpdated((row, node) => {
    if (node !== executor || row.sourceSessionId !== session && row.sessionId !== session) return;
    if (row.status === 'discarded') removePreview(row.id);
    setRevision(n => n + 1);
  }), [session, executor, selected]);
  useCollaborationRead(`${executor}:${session}:tasks`, revision, open && mode === 'tasks',
    () => api.collaborationList(session, executor, 'workspace'),
    result => { const items = result.items.filter(row => row.status !== 'discarded' && !discardedPreviews.current.has(row.id));
      setRows(old => [...items, ...old.filter(row => !discardedPreviews.current.has(row.id) && !items.some(item => item.id === row.id))]); setNext(result.nextOffset); setSelected(id => id || items[0]?.id || ''); }, error => setNotice(String(error)));
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
    createdHere.current = '';
    const identity = current.current; const result = await api.taskWorkspaceInspect(session, executor);
    if (identity !== current.current) return;
    if (result.status !== 'ready') { setNotice([result.notice, result.preparation].filter(Boolean).join(' ')); return; }
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
  const create = () => void act(async () => {
    if (!task || uncertain) return;
    createdHere.current = task.id;
    const identity = current.current; setUncertain(true);
    try {
      const result = await api.taskWorkspaceCreate(session, executor, task.id, uuid(), task.planFingerprint);
      if (identity !== current.current) return;
      setTask(result); setRevision(n => n + 1); setUncertain(false);
      setNotice('创建请求已接收；以工作区和 Session 校验回执为准。');
    } catch { if (identity === current.current) setNotice('创建接收结果未知，请核对原任务；没有重复提交。'); }
  });
  const shown = task?.id === selected ? task : undefined;
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
    if (!open || editing || mode !== 'tasks' || initialAction !== 'create' || !onOpenSession || shown?.status !== 'ready' || shown.id !== createdHere.current) return;
    createdHere.current = '';
    onOpenSession(shown.sessionId); setOpen(false); onClose?.();
  }, [open, editing, mode, initialAction, shown, onOpenSession, onClose]);
  return <>
    {!initialAction && <WorkflowButton tone="quiet" icon="branch" aria-label="分支副本与合并" onClick={() => setOpen(true)} style={{ whiteSpace: 'nowrap' }}>分支副本</WorkflowButton>}
    {open && <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31100, display: 'grid', placeItems: 'center', padding: 10, background: '#0007' }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="分支副本" style={{ ...workflowDialogStyle, width: 'min(1060px, 100%)', height: 'min(86vh, 800px)', display: 'flex', flexDirection: 'column', background: 'var(--theme-bg-secondary, white)', color: 'var(--theme-text, black)', borderRadius: 16, overflow: 'hidden' }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          if (event.key === 'Tab') { const nodes = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, summary')];
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header style={workflowHeaderStyle}><strong style={{ flex: 1 }}>分支副本</strong>
          <WorkflowButton tone="quiet" aria-pressed={mode === 'tasks'} onClick={() => setMode('tasks')}>副本</WorkflowButton><WorkflowButton tone="quiet" aria-pressed={mode === 'merge'} onClick={() => setMode('merge')}>{mergeTarget ? '合并到主 Session' : '合并记录'}</WorkflowButton>
          {mode === 'tasks' && <>{canCreate && <WorkflowButton tone="primary" icon="plus" disabled={busy} onClick={newTask}>新建分支副本</WorkflowButton>}
          <WorkflowButton onClick={() => { setRevision(n => n + 1); setReadNonce(n => n + 1); }}>核对副本状态</WorkflowButton></>}
          <WorkflowButton onClick={close}>返回对话</WorkflowButton>
        </header>
        {mode === 'merge' ? <ProjectMergePanel key={`${executor}:${session}`} session={session} executor={executor} fixedTarget={mergeTarget} onOpenSession={id => { onOpenSession?.(id); close(); }} /> : <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          <nav aria-label="分支副本记录" style={{ ...workflowNavStyle, display: rows.length ? 'flex' : 'none', width: 'clamp(85px, 24%, 230px)', overflow: 'auto', borderRight: '1px solid var(--theme-border)', flexShrink: 0 }}>
            {rows.map(row => <WorkflowButton tone="quiet" key={row.id} aria-pressed={selected === row.id && !editing} disabled={busy} style={{ width: '100%', padding: 9, overflowWrap: 'anywhere' }} onClick={() => { setSelected(row.id); setEditing(false); setUncertain(false); }}>{row.title} · {statusLabel[row.status || ''] || row.status}</WorkflowButton>)}
            {next !== null && <WorkflowButton onClick={() => void act(async () => { const identity = current.current; const result = await api.collaborationList(session, executor, 'workspace', next); if (identity === current.current) { setRows(old => [...old, ...result.items.filter(row => row.status !== 'discarded' && !discardedPreviews.current.has(row.id) && !old.some(item => item.id === row.id))]); setNext(result.nextOffset); } })}>更多任务</WorkflowButton>}
          </nav>
          <section style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 20 }}>
            {editing && repo ? <div style={{ display: 'grid', gap: 10 }}>
              <p>从当前 Git 分支 {repo.branch || repo.head.slice(0, 12)} 派生新分支和独立目录，创建一个普通子 Session，挂在主 Session 下。创建成功后直接进入对话，也可合并回主 Session。默认带入当前项目修改、新文件和项目 Skills，继承主 Session 配置；聊天线程独立，子 Session 不能再次派生。</p>
              <p>其他 Git 忽略文件（含依赖、缓存、构建产物）不复制；队列、定时任务及单次授权不复制。</p>
              <label>副本名称<input style={field} value={config.title} onChange={e => setConfig(old => ({ ...old, title: e.target.value }))} /></label>
              <label>初始需求<textarea rows={4} style={field} value={config.goal} onChange={e => setConfig(old => ({ ...old, goal: e.target.value }))} /></label>
              <label>执行 Backend<select style={field} value={config.backendId} onChange={e => setConfig(old => ({ ...old, backendId: e.target.value, runtime: {} }))}>{backends.filter(row => row.enabled !== false).map(row => <option key={row.id} value={row.id}>{row.label || row.id}</option>)}</select></label>
              {isRuntimeConfigurableBackend(runtimeBackend) && <BackendRuntimeFields backend={runtimeBackend} value={config.runtime} onChange={runtime => setConfig(old => ({ ...old, runtime }))} execKey={executor} />}
              <label>任务约束<textarea aria-label="任务约束" rows={3} style={field} value={config.constraints} onChange={e => setConfig(old => ({ ...old, constraints: e.target.value }))} /></label>
              <label>Skills（每行一个已安装 ID）<textarea aria-label="Skills（每行一个已安装 ID）" rows={2} style={field} value={config.skills.join('\n')} onChange={e => setConfig(old => ({ ...old, skills: e.target.value.split('\n') }))} /></label>
              <label><input type="checkbox" checked={config.skipPermissions} onChange={e => setConfig(old => ({ ...old, skipPermissions: e.target.checked }))} />跳过该子 Session 的普通执行确认</label>
              <label>项目文件范围<select aria-label="项目文件范围" style={field} value={config.snapshotMode} onChange={e => setConfig(old => ({ ...old, snapshotMode: e.target.value as 'current' | 'selected', includePaths: e.target.value === 'current' ? repo.dirty.filter(row => !row.blocked).map(row => row.path) : old.includePaths }))}><option value="current">当前项目内容（默认）</option><option value="selected">手动选择未提交路径（可全部取消，仅提交基线）</option></select></label>
              {repo.dirty.length > 0 && <details open><summary>{repo.dirty.length} 条未提交路径 · {config.snapshotMode === 'current' ? '默认包含' : '手动选择'}</summary>
                {repo.dirty.some(row => row.blocked) && <p role="alert">存在不能复制的路径。请处理后重新检查，或明确选择部分路径。</p>}
                {repo.dirty.map(row => <label key={row.path} style={{ display: 'block', padding: 4, overflowWrap: 'anywhere' }}><input type="checkbox" disabled={!!row.blocked || config.snapshotMode === 'current'} checked={config.includePaths.includes(row.path)} onChange={e => setConfig(old => ({ ...old, includePaths: e.target.checked ? [...old.includePaths, row.path] : old.includePaths.filter(path => path !== row.path) }))} />{row.path}{row.blocked ? ` · ${row.blocked}` : ''}</label>)}
                <p>选中路径将形成私有索引快照；主目录文件、暂存区和 HEAD 保持原样。</p>
              </details>}
              <WorkflowButton disabled={busy || !config.title.trim() || config.snapshotMode === 'current' && repo.dirty.some(row => !!row.blocked)} onClick={preview}>预览副本创建计划</WorkflowButton>
            </div> : shown ? <>
              <h3>{shown.title} · {statusLabel[shown.status] || shown.status}</h3>
              <p style={{ overflowWrap: 'anywhere' }}>{shown.root}</p><p style={{ overflowWrap: 'anywhere' }}>分支：{shown.branch}</p>
              <p>来源提交：{shown.repository.head.slice(0, 12)} · {shown.config.includePaths.length ? `包含 ${shown.config.includePaths.length} 条明确选定路径` : '仅含已提交内容'}</p>
              <details open={shown.status === 'preview'}><summary>需求与运行配置</summary><p style={{ whiteSpace: 'pre-wrap' }}>{shown.config.goal}</p>
                <p>Backend：{shown.config.backendId} · {shown.config.runtime.model || '默认模型'} · {shown.config.runtime.reasoningEffort || '默认推理档位'}</p>
                <p>普通执行确认：{shown.config.skipPermissions ? '跳过' : '保留'} · Skills：{shown.config.skills.filter(Boolean).join('、') || '无'}</p>
                <p style={{ whiteSpace: 'pre-wrap' }}>约束：{shown.config.constraints || '无附加约束'}</p>
                {shown.inherited && <><p>继承 Prompts：{shown.inherited.abilities?.prompts?.join('、') || '无'}；自动继续：{shown.inherited.auto_continue ? '开启' : '关闭'}；自动提交 / 推送：{shown.inherited.auto_commit ? '开启' : '关闭'} / {shown.inherited.auto_commit_push ? '开启' : '关闭'}；输入建议：{shown.inherited.followup_suggestions_enabled ? '开启' : '关闭'}</p>
                  <p>Kit 工具：{shown.inherited.abilities?.kitToolsMode || '默认'}；工作区工具：{shown.inherited.abilities?.workspaceToolsMode || '默认'}。工具开关不授予本次执行许可。</p></>}
                <details><summary>另行复制的项目 Skills：{shown.skillFiles?.length || 0} 个文件</summary>{shown.skillFiles?.map(row => <div key={row.path} style={{ overflowWrap: 'anywhere' }}>{row.path}</div>)}</details>
                {shown.config.includePaths.map(path => <p key={path}>{path}</p>)}
              </details>
              {shown.notice && <p>{shown.notice}</p>}
              {shown.status === 'preview' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <WorkflowButton disabled={busy || uncertain} onClick={create}>确认创建副本（不运行模型）</WorkflowButton>
                <WorkflowButton disabled={busy || uncertain} onClick={() => { setRepo(shown.repository); setConfig(shown.config); setEditing(true); }}>修改创建配置</WorkflowButton>
                <WorkflowButton tone="quiet" icon="close" disabled={busy || uncertain} onClick={discardPreview} title="取消这条待确认计划，不删除目录或 Git 分支">移除预览</WorkflowButton>
              </div>}
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
      </div>
    </div></AppModalPortal>}
  </>;
};
