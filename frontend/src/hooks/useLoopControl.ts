import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, getCurrentUserProfile, loopControls, loopControlTarget } from '../api';
import { documentStore } from '../utils/documentStore';
import { windowTransport } from '../utils/workbenchWindows';
import { sameWorkspace } from '../utils/workspaceDocuments';
import { controlBusy, controlKey, type ControlAction } from '../utils/loopControl';

export function useLoopControl(sessionId: string | null | undefined, executor?: string, enabled = true) {
  const raw = loopControlTarget(sessionId || '', executor);
  const key = controlKey(raw);
  const target = useMemo(() => raw, [key]);
  const subscribe = useCallback((fn: () => void) => loopControls.subscribe(target, fn), [target]);
  const snapshot = useCallback(() => loopControls.get(target), [target]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const check = useCallback(() => loopControls.check(target), [target]);
  const request = useCallback(async (action: ControlAction, goal = '') => {
    if (action === 'release') {
      // 只提示、不保存/丢弃。计数不跨账号展示正文；提交边界仍由执行端判定。
      const workspace = windowTransport.get(target.executor, target.session)?.state.workspace;
      const dirty = documentStore.all().filter(d => d.dirty && d.identity.workspace.sessionId === target.session
        && d.identity.workspace.ownerId === getCurrentUserProfile().userId
        && (!workspace || sameWorkspace(workspace, d.identity.workspace))).length;
      if (dirty && !window.confirm(`还有 ${dirty} 个未保存草稿。交还不会自动保存或丢弃它们，之后写入需要再次人工接管。仍要交还 LOOP？`)) return;
    }
    await loopControls.request(target, action, goal);
  }, [target]);
  useEffect(() => {
    if (!enabled || !target.session || !target.executor) return;
    void check();
    let first = true;
    const unsubscribe = api.onSessionConnectionStatus(target.session, connected => {
      if (connected && !first) void check();
      first = false;
    });
    const offSession = api.onSessionUpdated(data => {
      if (data.sessionId === target.session && (!data.execKey || data.execKey === target.executor) && data.type === 'chat_turn_started') void check();
    });
    const offStream = api.onStreamDelta(delta => {
      if (delta.sessionId === target.session && (!delta.executor || delta.executor === target.executor) && (delta.type === 'done' || delta.type === 'error')) void check();
    });
    const offQueue = api.onSeqtaskUpdated(data => { if (data.sessionId === target.session) void check(); });
    const activityStates = new Map<string, string>();
    const activity = (data: any, from: string) => {
      if (from !== target.executor || data.sessionId !== target.session) return;
      const key = `${data.resourceId}:${data.generation}`;
      // 输出/诊断内容的每次更新不是控制权变更，不触发状态轮询。
      if (activityStates.get(key) === data.status) return;
      activityStates.set(key, data.status); void check();
    };
    const offTerminal = api.onTerminalUpdated(activity), offLanguage = api.onLanguageUpdated(activity);
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', visible);
    return () => { unsubscribe(); offSession(); offStream(); offQueue(); offTerminal(); offLanguage(); document.removeEventListener('visibilitychange', visible); };
  }, [target, enabled, check]);
  return { target, state, check, request, busy: controlBusy(state),
    retry: () => loopControls.retry(target),
    viewReady: (error = '') => loopControls.view(target, state.summary?.controlRevision ?? -1, error) };
}
