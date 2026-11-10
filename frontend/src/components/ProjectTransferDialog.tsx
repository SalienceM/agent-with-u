import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, onCurrentUserChanged, onExecStatus } from '../api';
import { AppModalPortal } from './AppModalPortal';
import type { BranchSession } from './SessionBranchDialog';
import { WorkflowButton, workflowDialogStyle, workflowFieldStyle, workflowHeaderStyle, workflowNoticeStyle } from './WorkflowControls';
import { checkTransfer, confirmTransfer, prepareTransfer, recoverTransfer, resetTransfer, subscribeTransfer, transferState } from '../utils/projectTransfers';
import type { ProjectTransferCapability } from '../types/projectTransfers';

export const ProjectTransferDialog: React.FC<{ session: BranchSession; mode: 'project' | 'return'; focusTarget?: HTMLElement;
  onClose: () => void; onOpenSession: (id: string) => void }> = ({ session, mode, focusTarget, onClose, onOpenSession }) => {
  const scope = useMemo(() => ({ session: session.id, executor: session.execKey || 'local', mode }), [session.id, session.execKey, mode]);
  const state = useSyncExternalStore(cb => subscribeTransfer(scope, cb), () => transferState(scope));
  const [nodes, setNodes] = useState(api.projectTransferExecutors), [target, setTarget] = useState(state.target);
  const [backends, setBackends] = useState<{ id: string; label: string }[]>([]), [backend, setBackend] = useState('');
  const [title, setTitle] = useState(`${session.title} · ${mode === 'return' ? '成果' : '节点副本'}`);
  const [capability, setCapability] = useState<ProjectTransferCapability | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [opening, setOpening] = useState(false);
  const panel = useRef<HTMLDivElement>(null), returnFocus = useRef(focusTarget || document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const identity = useRef(api.projectTransferIdentity());
  const alive = useRef(true);
  const current = () => alive.current && identity.current === api.projectTransferIdentity();
  useEffect(() => {
    alive.current = true;
    const unlisten = onExecStatus(() => setNodes(api.projectTransferExecutors()));
    const stop = onCurrentUserChanged((_profile, changed) => { if (changed) closeRef.current(); });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); closeRef.current(); } };
    document.addEventListener('keydown', escape);
    return () => { alive.current = false; unlisten(); stop(); document.removeEventListener('keydown', escape); requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }); };
  }, []);
  useEffect(() => {
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [state.phase]);
  useEffect(() => {
    let live = true;
    api.projectTransferCapabilities(scope.executor, session.id).then(value => {
      if (!live || !current()) return;
      setCapability(value);
      if (!value.git) setError('源节点需要安装本地 Git');
      if (mode === 'return' && !value.origin) setError('此项目没有可核验的跨节点来源，不能回传');
    }, reason => { if (live && current()) setError(String(reason)); });
    return () => { live = false; };
  }, [scope.executor, session.id, mode]);
  useEffect(() => {
    let live = true; setBackends([]); setBackend('');
    if (!target) return;
    setLoading(true); setError('');
    Promise.all([api.getBackends(target), api.projectTransferCapabilities(target)]).then(([rows, cap]) => {
      if (!live || !current()) return;
      if (!cap.git) throw new Error('目标节点未安装本地 Git，请安装后重新选择');
      if (mode === 'return' && capability?.origin && capability.origin.executorId !== cap.executorId) throw new Error('请选择原项目所在节点');
      const enabled = rows.filter((item: { enabled?: boolean }) => item.enabled !== false);
      setBackends(enabled); setBackend(enabled[0]?.id || '');
      if (!enabled.length) throw new Error('目标节点没有启用的 Backend');
    }).catch(reason => { if (live && current()) setError(String(reason)); }).finally(() => { if (live && current()) setLoading(false); });
    return () => { live = false; };
  }, [target, capability?.origin?.executorId, mode]);
  const targets = nodes.filter(node => node.key !== scope.executor);
  const targetNode = targets.find(node => node.key === target);
  const busy = ['preparing', 'sending'].includes(state.phase), form = ['idle', 'error'].includes(state.phase);
  const blocked = !capability?.git || mode === 'return' && !capability.origin || !targetNode?.connected || !backend || !title.trim() || loading || !!error;
  const heading = mode === 'return' ? '回传项目成果' : '发送项目到节点';
  const open = async () => {
    if (!state.plan || !current()) return;
    setOpening(true); setError('');
    try { await api.collaborationOpenSession(state.plan.sessionId, state.target); if (current()) { onOpenSession(state.plan.sessionId); onClose(); } }
    catch (reason) { if (current()) setError(String(reason)); }
    finally { setOpening(false); }
  };
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31100, display: 'grid', placeItems: 'center', padding: 12, background: '#0007' }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={heading} style={{ ...workflowDialogStyle, width: 'min(480px, 100%)', maxHeight: 'calc(100dvh - 24px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--theme-panel-solid, var(--theme-bg-secondary, white))', color: 'var(--theme-text, #273244)' }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const elements = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')];
          const first = elements[0], last = elements[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header style={workflowHeaderStyle}><h2 style={{ flex: 1, margin: 0, fontSize: 16 }}>{heading}</h2>
        <WorkflowButton autoFocus tone="quiet" icon="close" aria-label={`关闭${heading}`} onClick={onClose} /></header>
      <div style={{ padding: '16px 18px', overflowY: 'auto', overflowWrap: 'anywhere' }}>
        {form && <form id="project-transfer-form" onSubmit={event => { event.preventDefault(); if (!blocked) void prepareTransfer(scope, target, targetNode!.label, title, backend, backends.find(item => item.id === backend)?.label || backend); }}>
          <p style={{ margin: '0 0 16px', color: 'var(--theme-text-muted)', fontSize: 12 }}>{mode === 'return' ? '把当前成果送回原项目，作为分支审阅并合并。' : '在另一个节点继续开发，本地分支照常使用。'}</p>
          <label style={{ display: 'block', marginBottom: 12 }}>目标节点
            <select aria-label="目标节点" style={workflowFieldStyle} value={target} onChange={event => setTarget(event.target.value)} required>
              <option value="">选择节点</option>{targets.map(node => <option key={node.key} value={node.key} disabled={!node.connected}>{node.label}{!node.connected ? ' · 离线' : ''}</option>)}
            </select>
          </label>
          <label style={{ display: 'block', marginBottom: 12 }}>Backend
            <select aria-label="Backend" style={workflowFieldStyle} value={backend} disabled={loading || !backends.length} onChange={event => setBackend(event.target.value)} required>
              {!backends.length && <option value="">{loading ? '正在读取…' : '先选择节点'}</option>}{backends.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
            </select>
          </label>
          <label style={{ display: 'block' }}>标题<input aria-label="标题" style={workflowFieldStyle} value={title} maxLength={120} onChange={event => setTitle(event.target.value)} required /></label>
          <p style={{ ...workflowNoticeStyle, padding: 0, background: 'transparent', marginBottom: 0 }}>目录自动分配。目标节点需要本地 Git，无需连接远端仓库。</p>
        </form>}
        {state.plan && <>
          <p style={{ margin: '0 0 10px', fontWeight: 600 }}>{session.title} <span aria-hidden="true">→</span> {state.targetLabel}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0,1fr)', gap: '6px 12px', fontSize: 12 }}>
            <span style={{ color: 'var(--theme-text-muted)' }}>新会话</span><span>{state.plan.title}</span>
            <span style={{ color: 'var(--theme-text-muted)' }}>Backend</span><span>{state.backendLabel || state.plan.backendId}</span>
            <span style={{ color: 'var(--theme-text-muted)' }}>项目快照</span><span>{state.plan.descriptor.files} 个文件 · {(state.plan.descriptor.bytes / 1024 / 1024).toFixed(2)} MiB</span>
          </div>
          {state.phase === 'preview' && <p style={workflowNoticeStyle}>{mode === 'return' ? '确认后在原项目下创建待审阅分支；合并需另行确认。' : '确认后在目标节点创建独立本地仓库和主 Session。'}不会自动运行模型。仅包含预览时已保存的项目文件，不含忽略文件和编辑器未保存草稿。</p>}
          <details style={{ fontSize: 11, marginTop: 12, color: 'var(--theme-text-muted)' }}><summary style={{ cursor: 'pointer' }}>交接详情</summary>
            <p>自动分配目录：{state.plan.root}</p><p>来源：{state.plan.descriptor.sourceExecutor} · {state.plan.descriptor.sourceSessionId}</p>
            <p>目标：{state.plan.descriptor.targetExecutor}</p><p>校验：{state.plan.descriptor.sha256}</p><p>操作：{state.plan.id}</p>
          </details>
        </>}
        {busy && <div role="status"><p>{state.phase === 'preparing' ? '正在准备项目快照…' : state.notice}</p>
          {state.phase === 'sending' && <progress aria-label="项目传输进度" value={state.progress} max={state.plan?.descriptor.size || 1} style={{ width: '100%' }} />}</div>}
        {!busy && state.notice && <p role="status" style={workflowNoticeStyle}>{state.notice}</p>}
        {error && <p role="alert" style={{ color: 'var(--theme-danger, #cf4343)', marginBottom: 0 }}>{error}</p>}
      </div>
      <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        {form && <><WorkflowButton disabled={!targetNode?.connected || loading} onClick={() => void recoverTransfer(scope, target, targetNode!.label)}>核对最近交接</WorkflowButton>
          <WorkflowButton tone="primary" type="submit" form="project-transfer-form" disabled={blocked}>预览交接</WorkflowButton></>}
        {state.phase === 'preview' && <><WorkflowButton onClick={() => resetTransfer(scope)}>返回修改</WorkflowButton><WorkflowButton tone="primary" onClick={() => void confirmTransfer(scope)}>确认传输并创建</WorkflowButton></>}
        {state.phase === 'unknown' && <WorkflowButton onClick={() => void checkTransfer(scope)}>核对原请求</WorkflowButton>}
        {state.phase === 'succeeded' && <><WorkflowButton onClick={() => resetTransfer(scope)}>新的交接</WorkflowButton><WorkflowButton tone="primary" disabled={opening} onClick={() => void open()}>{mode === 'return' ? '打开待合并分支' : '打开目标项目'}</WorkflowButton></>}
        {busy && <WorkflowButton onClick={onClose}>关闭面板</WorkflowButton>}
      </footer>
    </div>
  </div></AppModalPortal>;
};
