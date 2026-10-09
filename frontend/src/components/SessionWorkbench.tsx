import React, { useEffect, useRef, useState } from 'react';
import { api, getCurrentUserProfile, getSessionExecKey } from '../api';
import { ChatPane, type ChatPaneProps } from './ChatPane';
import { FileTreePanel } from './FileTreePanel';
import { AppModalVisibilityContext, WorkbenchInteractionContext } from './AppModalPortal';
import { useSessionWindow } from '../hooks/useSessionWindow';
import { WindowRecoveryPanel } from './WindowRecoveryPanel';
import { WorkspaceTerminal } from './WorkspaceTerminal';
import { WorkspaceLanguageProvider, WorkspaceLanguagePanel } from './WorkspaceLanguages';
import { isSessionMetaReady } from '../utils/sessionRouting';
import { normalizeSessionViewMode, type SessionViewMode } from '../utils/sessionWorkbench';
import { localSessionView, rememberLocalSessionView, sessionViewKey } from '../utils/sessionViewPreference';
import type { AttentionContext } from '../utils/attentionContext';
import type { FileFocusRequest } from '../utils/fileFocus';
import { defaultEngineLayout, fittedEngineWidths, normalizeEngineLayout, readEngineLayout, writeEngineLayout, type EngineLayout } from '../utils/engineLayout';
import { WorkbenchResizeHandle } from './WorkbenchResizeHandle';
import { handoffParticipants, handoffScope } from '../utils/workbenchHandoffState';
import type { EngineeringActivity } from '../utils/loopControl';
import { WorkbenchButton, WorkbenchChromeStyles, WorkbenchIcon, WorkbenchPopover, workbenchNoticeStyle } from './WorkbenchChrome';

interface Props extends ChatPaneProps {
  onViewModeChange?: (key: string, mode: SessionViewMode) => void;
  onViewPresenceChange?: (key: string, present: boolean) => void;
  modeRequest?: { id: number; user: string; session: string; mode: SessionViewMode } | null;
  menuRequest?: { id: number; anchor: HTMLButtonElement };
  onAttentionChange?: (context: AttentionContext | null) => void;
  onRestoreFilePanel?: () => void;
}

const fill: React.CSSProperties = { display: 'flex', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' };
const iconButtonStyle: React.CSSProperties = { borderColor: 'transparent', background: 'transparent', padding: '4px 7px' };

/** 展示壳不接管 useChat/LOOP。ChatPane 永远位于同一 React 位置，切换模式不重挂载。 */
export const SessionWorkbench: React.FC<Props> = props => {
  const { sessionId, currentUser, isVisible = true, onViewModeChange, onAttentionChange } = props;
  // peekSessionMeta 合并路由后返回新对象，不能直接作为 external-store 快照。
  const [metadata, setMetadata] = useState<any>(() => sessionId ? api.peekSessionMeta(sessionId) : null);
  useEffect(() => {
    if (!sessionId) { setMetadata(null); return; }
    const unsubscribe = api.onSessionMetaChanged(sessionId, setMetadata);
    setMetadata(api.peekSessionMeta(sessionId));
    return unsubscribe;
  }, [sessionId]);
  const meta = metadata?.id === sessionId ? metadata : null;
  const executor = meta?.execKey || getSessionExecKey(sessionId) || '';
  const workingDir = meta?.workingDir || '';
  const identity = sessionViewKey(currentUser.userId, executor, sessionId || '');
  const scope = JSON.stringify([identity, workingDir]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [choice, setChoice] = useState<{ key: string; mode: SessionViewMode; message: string } | null>(null);
  const [request, setRequest] = useState<{ scope: string; busy: boolean; error: string } | null>(null);
  const generation = useRef(0);
  const modeInFlight = useRef(false);
  const consumedModeRequest = useRef<number>();
  const local = (() => { try { return localSessionView(window.localStorage, identity); } catch { return undefined; } })();
  const mode = choice?.key === identity ? choice.mode : local || normalizeSessionViewMode(meta?.viewMode);
  const engine = mode === 'engine';
  const ready = !!sessionId && isSessionMetaReady(meta, sessionId) && !!executor && !!workingDir;
  const windowState = useSessionWindow(currentUser.userId, executor, sessionId || '', workingDir, ready);
  const busy = request?.scope === scope && request.busy;
  const [visited, setVisited] = useState(false);
  const [activityFocus, setActivityFocus] = useState<EngineeringActivity | null>(null);
  const [documentHost, setDocumentHost] = useState<HTMLDivElement | null>(null);
  const restoreLayout = () => { try { return readEngineLayout(window.sessionStorage, identity); } catch { return { ...defaultEngineLayout }; } };
  const [layoutState, setLayoutState] = useState(() => ({ key: identity, layout: restoreLayout(), persistent: true }));
  const layout = layoutState.key === identity ? layoutState.layout : restoreLayout();
  const updateLayout = (patch: Partial<EngineLayout>) => setLayoutState(previous => {
    const next = normalizeEngineLayout({ ...(previous.key === identity ? previous.layout : restoreLayout()), ...patch });
    let persistent = false;
    try { persistent = writeEngineLayout(window.sessionStorage, identity, next); } catch { /* 当前窗口内仍保留布局 */ }
    return { key: identity, layout: next, persistent };
  });
  const { terminalOpen, region } = layout;
  const setRegion = (value: EngineLayout['region']) => updateLayout({ region: value, ...(value === 'files' ? { filesCollapsed: false } : {}), ...(value === 'terminal' ? { terminalOpen: true } : {}) });
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const narrow = width > 0 && width < 900;
  const widths = fittedEngineWidths(layout, width || 1200);
  const terminalHeight = Math.min(layout.terminalHeight, Math.max(100, height - 220));
  const [fileFocus, setFileFocus] = useState<FileFocusRequest | null>(null);
  const focusSequence = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const onModeRef = useRef(onViewModeChange); onModeRef.current = onViewModeChange;
  useEffect(() => { onModeRef.current?.(identity, mode); if (engine) setVisited(true); }, [identity, mode, engine]);
  const onPresenceRef = useRef(props.onViewPresenceChange); onPresenceRef.current = props.onViewPresenceChange;
  // 只有已确认移出的视图释放原窗口导航；等待/未知交接仍留在当前工程。
  useEffect(() => { onPresenceRef.current?.(identity, windowState.renderView); }, [identity, windowState.renderView]);
  useEffect(() => {
    const target = container.current; if (!target) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      if (width > 0) { setWidth(width); setHeight(entries[0].contentRect.height); }
    });
    observer.observe(target); return () => observer.disconnect();
  }, []);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { generation.current++; setRequest(null); }, [scope]);
  const transferLayout = useRef({ export: () => ({} as unknown), import: (_value: unknown) => {} });
  const transferScope = handoffScope(currentUser.userId, executor, sessionId || '', workingDir);
  transferLayout.current = {
    export: () => {
      if (busy) throw new Error('展示模式正在保存，请先核对完成');
      return { mode, layout, visited, chatFiles: handoffParticipants.has(transferScope, 'filesChat') };
    },
    import: value => {
      const row = value as any;
      if (currentScope.current !== scope || getCurrentUserProfile().userId !== currentUser.userId || !row
        || !['chat', 'engine'].includes(row.mode) || typeof row.visited !== 'boolean' || typeof row.chatFiles !== 'boolean') throw new Error('交接布局身份或内容不匹配');
      updateLayout(normalizeEngineLayout(row.layout)); setVisited(row.visited || row.mode === 'engine');
      setChoice({ key: identity, mode: row.mode, message: '' });
      if (row.chatFiles) props.onRestoreFilePanel?.();
    },
  };
  useEffect(() => ready ? handoffParticipants.register(transferScope, 'layout', {
    export: () => transferLayout.current.export(), import: value => transferLayout.current.import(value),
  }) : undefined, [transferScope, ready]);

  const selectMode = async (next: SessionViewMode) => {
    if (!ready || busy || modeInFlight.current || windowState.frozen || next === mode || !sessionId) return;
    modeInFlight.current = true;
    const captured = scope, seq = ++generation.current;
    const current = () => currentScope.current === captured && generation.current === seq
      && getCurrentUserProfile().userId === currentUser.userId;
    setRequest({ scope: captured, busy: true, error: '' });
    try {
      const response = await api.updateSessionWorkbench(sessionId, { viewMode: next }, executor, workingDir, current);
      if (!current()) return;
      if (response.status === 'unsupported') {
        let remembered = false;
        try { remembered = rememberLocalSessionView(window.localStorage, identity, next); } catch { /* 禁用存储只影响偏好 */ }
        setChoice({ key: identity, mode: next, message: remembered
          ? '旧执行端：展示模式仅记在本设备，未保存到服务器。' : '旧执行端且本地存储不可用：展示模式仅本次页面有效。' });
      } else if (response.status === 'ok' && response.viewMode === next) {
        try { rememberLocalSessionView(window.localStorage, identity, null); } catch { /* 已持久化服务器 */ }
        setChoice(null);
      } else throw new Error(response.message || '无法确认展示模式已保存');
      setRequest({ scope: captured, busy: false, error: '' });
    } catch (error) {
      if (current()) setRequest({ scope: captured, busy: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      modeInFlight.current = false;
    }
  };
  useEffect(() => {
    const next = props.modeRequest;
    if (!next || next.user !== currentUser.userId || next.session !== sessionId || !ready || consumedModeRequest.current === next.id) return;
    consumedModeRequest.current = next.id;
    void selectMode(next.mode);
  }, [props.modeRequest, ready, identity]);
  const focusFile: ChatPaneProps['onRequestFileFocus'] = request => {
    if (!engine) { props.onRequestFileFocus?.(request); return; }
    if (request.sessionId !== sessionId || request.workingDir !== workingDir) return;
    setRegion('files'); setFileFocus({ ...request, requestId: ++focusSequence.current });
  };
  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.user !== currentUser.userId || detail.executor !== executor || detail.session !== sessionId
        || detail.activity?.workspace?.workingDir?.replace(/\\/g, '/').toLowerCase() !== workingDir.replace(/\\/g, '/').toLowerCase()) return;
      setActivityFocus(detail.activity); void selectMode('engine');
    };
    window.addEventListener('awu:locate-engineering', locate);
    return () => window.removeEventListener('awu:locate-engineering', locate);
  }, [scope, mode, busy]);
  useEffect(() => {
    if (!engine || !activityFocus) return;
    if (activityFocus.kind === 'terminal') updateLayout({ terminalOpen: true, region: 'terminal' });
    else if (activityFocus.kind === 'document-save' && activityFocus.relativePath) {
      setRegion('document'); setFileFocus({ sessionId: sessionId!, workingDir, relativePath: activityFocus.relativePath, requestId: ++focusSequence.current });
    }
  }, [engine, activityFocus]);
  const fileVisible = engine && isVisible && (narrow ? region === 'files' : !layout.filesCollapsed);
  const conversationVisible = !engine || (narrow ? region === 'conversation' : !layout.conversationCollapsed);
  const terminalVisible = engine && (narrow ? region === 'terminal' : terminalOpen);
  const message = choice?.key === identity ? choice.message : local
    ? '旧执行端：展示模式仅记在本设备，未保存到服务器。' : '';
  const showHandoffNotice = !!windowState.progress.message && (!windowState.progress.settled || windowState.frozen || !!windowState.checkpoint);
  const folderName = workingDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const moveDisabled = !windowState.available || windowState.frozen || windowState.progress.phase === 'preparing';
  const windowActions = (close: () => void) => <>
    <p style={{ margin: '6px 8px', color: 'var(--theme-text-muted)' }}>{windowState.detached ? '独立会话窗口' : '主窗口中的会话'} · 关闭视图不会停止后台任务</p>
    {!engine && <WorkbenchButton className="awu-wb-menu-action" icon={windowState.detached ? 'attach' : 'window'} disabled={moveDisabled}
      title={windowState.detached ? '合并回主窗口（保留此窗口）' : 'Web 使用此入口；跨窗口拖拽仅桌面端支持'}
      onClick={() => { close(); windowState.move(); }}>{windowState.detached ? '合并回主窗口' : '分离到独立窗口'}</WorkbenchButton>}
    {windowState.detached && <WorkbenchButton className="awu-wb-menu-action" icon="attach" disabled={moveDisabled} onClick={() => { close(); windowState.safeClose(); }}>安全合并并关闭</WorkbenchButton>}
    {engine && <WorkbenchButton className="awu-wb-menu-action" icon="restore" disabled={windowState.frozen} onClick={() => { updateLayout(defaultEngineLayout); close(); }}>重置布局</WorkbenchButton>}
    {windowState.available && <WorkbenchButton className="awu-wb-menu-action" icon="restore" onClick={() => { close(); windowState.reconcile(); }}>核对窗口归属</WorkbenchButton>}
    {windowState.progress.settled && <p role="status" style={{ margin: '8px', color: 'var(--theme-text-muted)' }}>{windowState.progress.message}</p>}
    {windowState.available && <WindowRecoveryPanel user={currentUser.userId} />}
    {!windowState.available && <p style={{ margin: 8, color: 'var(--theme-text-muted)' }}>窗口交接暂不可用，请检查连接与节点能力；不会创建副本。</p>}
  </>;
  return <WorkspaceLanguageProvider user={currentUser.userId} executor={executor} session={sessionId || ''} workingDir={workingDir} ready={ready}>
    <div ref={container} className="awu-session-workbench" data-view-mode={mode} onPointerDown={props.onFocus} style={{ ...fill, flexDirection: 'column' }}>
    <WorkbenchChromeStyles />
    <div aria-label={engine ? '会话工具栏' : undefined} data-workbench-header={engine ? '' : undefined} style={engine ? { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, minWidth: 0, padding: '5px 10px', borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-sidebar-solid, var(--theme-bg-secondary))' } : { display: 'contents' }}>
      <WorkbenchPopover label="当前会话菜单" icon={engine ? 'code' : 'chat'} contextMenu openSignal={props.menuRequest?.id}
        triggerless={!engine} externalTrigger={props.menuRequest?.anchor} disabled={!isVisible}
        triggerStyle={{ minWidth: 0, maxWidth: engine ? '45%' : '65%', flexShrink: 1 }}
        trigger={<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta?.title || 'Session'} <span aria-hidden="true" style={{ color: 'var(--theme-text-muted)' }}>⌄</span></span>}>
        {close => <>
          <div role="menu" aria-label="会话模式">
            {(['chat', 'engine'] as const).map(value => <WorkbenchButton key={value} className="awu-wb-menu-action" icon={value === 'chat' ? 'chat' : 'code'}
              role="menuitemradio" aria-checked={mode === value} disabled={!ready || busy || windowState.frozen}
              onClick={() => { close(); void selectMode(value); }}>{value === 'chat' ? 'Chat · 多会话' : 'Engine · 工程工作区'}</WorkbenchButton>)}
          </div>
          <p style={{ margin: '8px', color: 'var(--theme-text-muted)' }}>{engine ? '当前窗口专注此工程。返回 Chat 后可切换其他会话。' : 'Engine 专注单个工程；模式切换保留草稿，不启动命令。'}</p>
          {!engine && <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 6 }}>{windowActions(close)}</div>}
        </>}
      </WorkbenchPopover>
      {engine && <>
      {busy && <span role="status" style={{ fontSize: 12 }}>保存展示模式…</span>}
      <div title={`${meta?.title || sessionId} · ${meta?.execLabel || executor} · ${workingDir}`}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, overflow: 'hidden', whiteSpace: 'nowrap', color: 'var(--theme-text-muted)' }}>
        {engine && !narrow && <><WorkbenchIcon name="files" /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--theme-text)' }}>{folderName || '未设置工作目录'}</span>
          <span style={{ opacity: .5 }}> / </span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta?.execLabel || executor}</span></>}
      </div>
      {engine && !narrow && <>
        <div role="group" aria-label="工作台布局" style={{ display: 'flex', gap: 2 }}>
          <WorkbenchButton icon="files" style={iconButtonStyle} title="目录区域" aria-label="目录区域" aria-pressed={!layout.filesCollapsed} aria-expanded={!layout.filesCollapsed} disabled={windowState.frozen} onClick={() => updateLayout({ filesCollapsed: !layout.filesCollapsed })} />
          <WorkbenchButton icon="panel" style={iconButtonStyle} title="对话区域" aria-label="对话区域" aria-pressed={!layout.conversationCollapsed} aria-expanded={!layout.conversationCollapsed} disabled={windowState.frozen} onClick={() => updateLayout({ conversationCollapsed: !layout.conversationCollapsed })} />
          <WorkbenchButton icon="terminal" style={iconButtonStyle} title="终端区域" aria-label="终端区域" aria-pressed={terminalOpen} aria-expanded={terminalOpen} disabled={windowState.frozen} onClick={() => updateLayout({ terminalOpen: !terminalOpen })} />
        </div>
      </>}
      {engine && <WorkbenchInteractionContext.Provider value={windowState.frozen}><WorkspaceLanguagePanel openSignal={activityFocus?.kind === 'language-write' ? activityFocus : undefined} /></WorkbenchInteractionContext.Provider>}
      <WorkbenchButton icon={windowState.detached ? 'attach' : 'window'} style={iconButtonStyle} disabled={moveDisabled}
        aria-label={windowState.detached ? '合并回主窗口' : '分离到独立窗口'}
        title={windowState.detached ? '合并回主窗口（保留此窗口）' : '分离到独立窗口 · Web 请使用此入口，跨窗口拖拽仅桌面端支持'}
        onClick={windowState.move} />
      <WorkbenchPopover label="窗口与布局" icon="more">
        {windowActions}
      </WorkbenchPopover>
      </>}
    </div>
    {!engine && busy && <div role="status" style={workbenchNoticeStyle}>保存展示模式…</div>}
    {engine && narrow && <div role="group" aria-label="Engine 区域" style={{ display: 'flex', flexShrink: 0, gap: 4, padding: '4px 10px', borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-sidebar-solid)' }}>
      {([['files', '目录', 'files'], ['document', '文件', 'code'], ['conversation', '对话 / LOOP', 'chat'], ['terminal', '终端', 'terminal']] as const).map(([value, label, icon]) =>
        <WorkbenchButton key={value} icon={icon} style={{ ...iconButtonStyle, flex: 1, whiteSpace: 'nowrap' }} disabled={windowState.frozen} aria-label={label} aria-pressed={region === value} onClick={() => setRegion(value)}>{value === 'conversation' ? meta?.sessionType === 'loop' ? 'LOOP' : '对话' : label}</WorkbenchButton>)}
    </div>}
    {showHandoffNotice && <div role="status" data-window-handoff-status style={workbenchNoticeStyle}>
      <div>{windowState.progress.message}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
      {windowState.available && <WorkbenchButton onClick={windowState.reconcile}>核对窗口归属</WorkbenchButton>}
      {windowState.progress.phase === 'unknown' && <WorkbenchButton onClick={windowState.cancel}>取消原交接</WorkbenchButton>}
      {windowState.progress.phase === 'unknown' && !windowState.checkpoint && <WorkbenchButton onClick={windowState.resume}>继续原交接</WorkbenchButton>}
      {windowState.progress.phase === 'moved' && <WorkbenchButton onClick={windowState.focus}>聚焦所属窗口</WorkbenchButton>}
      {windowState.checkpoint && <WorkbenchButton onClick={windowState.restore}>恢复最后交接状态</WorkbenchButton>}
      {windowState.checkpoint && <WorkbenchButton onClick={windowState.skipRestore}>保留恢复包并继续当前视图</WorkbenchButton>}
      {windowState.available && ['moved', 'unknown'].includes(windowState.progress.phase) && <WorkbenchButton onClick={windowState.reclaim}>显式收回视图归属</WorkbenchButton>}
      </div>
    </div>}
    {message && <div role="status" style={workbenchNoticeStyle}>{message}</div>}
    {engine && layoutState.key === identity && !layoutState.persistent && <div role="status" style={workbenchNoticeStyle}>布局存储不可用，本次窗口内仍可调整；刷新后无法恢复。</div>}
    {request?.scope === scope && request.error && <div role="alert" style={{ ...workbenchNoticeStyle, color: 'var(--theme-error)' }}>{request.error}；未重新发送请求。</div>}
    {windowState.renderView && <WorkbenchInteractionContext.Provider value={windowState.frozen}>
    <div {...(windowState.frozen ? { inert: '' } as any : {})} style={{ ...fill, display: engine && narrow && region === 'terminal' ? 'none' : 'flex', flexDirection: 'row' }}>
      <aside aria-label="Engine 文件目录" hidden={!fileVisible} style={{ ...fill, display: fileVisible ? 'flex' : 'none', flexDirection: 'column', flex: narrow ? 1 : `0 0 ${widths.files}px`, borderRight: '1px solid var(--theme-border)', background: 'var(--theme-sidebar-solid, var(--theme-bg-secondary))' }}>
        {(visited || engine) && <AppModalVisibilityContext.Provider value={isVisible && engine}>
          {meta?.codexRemoteHost ? <div role="status" style={{ padding: 12, fontSize: 12 }}>SSH 会话文件位于 {meta.codexRemoteHost}；不展示本机同名目录。</div>
            : ready && documentHost ? <FileTreePanel key={scope} sessionId={sessionId!} workingDir={workingDir} execKey={executor}
              execLabel={meta?.execLabel} execMode={meta?.execMode} backendId={meta?.backendId}
              documentHost={documentHost} isVisible={isVisible && engine}
              focusRequest={fileFocus} onDocumentOpen={() => setRegion('document')}
              onBrowseFiles={() => setRegion('files')}
              onAttentionChange={isVisible && engine ? onAttentionChange : undefined} />
            : <p style={{ padding: 12, fontSize: 12 }}>请先设置会话工作目录。</p>}
        </AppModalVisibilityContext.Provider>}
      </aside>
      {engine && !narrow && !layout.filesCollapsed && <WorkbenchResizeHandle label="目录宽度" value={layout.filesWidth} min={160} max={480} onChange={filesWidth => updateLayout({ filesWidth })} />}
      <section aria-label="Engine 文件工作区" hidden={!engine || narrow && region !== 'document'}
        style={{ ...fill, display: engine && (!narrow || region === 'document') ? 'flex' : 'none', flexDirection: 'column', background: 'var(--theme-panel-solid, var(--theme-bg))' }}>
        <div ref={setDocumentHost} style={{ ...fill, flexDirection: 'column' }} />
        {meta?.codexRemoteHost && <p style={{ padding: 16 }}>SSH 工作区文件预览尚不支持；不会回退其他节点。</p>}
      </section>
      {engine && !narrow && !layout.conversationCollapsed && <WorkbenchResizeHandle label="对话宽度" value={layout.conversationWidth} min={280} max={720} reverse onChange={conversationWidth => updateLayout({ conversationWidth })} />}
      <div data-workbench-conversation hidden={!conversationVisible} style={{ ...fill, display: conversationVisible ? 'flex' : 'none',
        flex: engine && !narrow ? `0 0 ${widths.conversation}px` : 1, borderLeft: engine ? '1px solid var(--theme-border)' : undefined }}>
        <ChatPane {...props} isVisible={isVisible && conversationVisible} isFocused={props.isFocused && conversationVisible} onRequestFileFocus={focusFile} />
      </div>
    </div>
    {terminalVisible && !narrow && <WorkbenchResizeHandle label="终端高度" value={terminalHeight} min={100} max={Math.max(100, Math.min(600, height - 220))} horizontal reverse onChange={terminalHeight => updateLayout({ terminalHeight })} />}
    <section aria-label="Engine 终端区域" hidden={!terminalVisible} style={{ display: terminalVisible ? 'block' : 'none', boxSizing: 'border-box', flex: narrow ? 1 : `0 0 ${terminalHeight}px`, minHeight: 0, overflow: 'hidden', borderTop: '1px solid var(--theme-border)', fontSize: 12 }}>
      {ready && <WorkspaceTerminal key={scope} user={currentUser.userId} executor={executor} session={sessionId!} workingDir={workingDir} visible={isVisible && terminalVisible} focusResource={activityFocus?.kind === 'terminal' ? activityFocus.resourceId : undefined} />}
    </section>
    </WorkbenchInteractionContext.Provider>}
  </div></WorkspaceLanguageProvider>;
};
