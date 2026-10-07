import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, loopControls, loopControlTarget } from '../api';
import { controlBusy, controlKey, type ControlAction } from '../utils/loopControl';

export function useLoopControl(sessionId: string | null | undefined, executor?: string, enabled = true) {
  const raw = loopControlTarget(sessionId || '', executor);
  const key = controlKey(raw);
  const target = useMemo(() => raw, [key]);
  const subscribe = useCallback((fn: () => void) => loopControls.subscribe(target, fn), [target]);
  const snapshot = useCallback(() => loopControls.get(target), [target]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const check = useCallback(() => loopControls.check(target), [target]);
  const request = useCallback((action: ControlAction, goal = '') => loopControls.request(target, action, goal), [target]);
  useEffect(() => {
    if (!enabled || !target.session || !target.executor) return;
    void check();
    let first = true;
    const unsubscribe = api.onSessionConnectionStatus(target.session, connected => {
      if (connected && !first) void check();
      first = false;
    });
    const offSession = api.onSessionUpdated(data => {
      if (data.sessionId === target.session && data.type === 'chat_turn_started') void check();
    });
    const offStream = api.onStreamDelta(delta => {
      if (delta.sessionId === target.session && (delta.type === 'done' || delta.type === 'error')) void check();
    });
    const offQueue = api.onSeqtaskUpdated(data => { if (data.sessionId === target.session) void check(); });
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', visible);
    return () => { unsubscribe(); offSession(); offStream(); offQueue(); document.removeEventListener('visibilitychange', visible); };
  }, [target, enabled, check]);
  return { target, state, check, request, busy: controlBusy(state),
    retry: () => loopControls.retry(target),
    viewReady: (error = '') => loopControls.view(target, state.summary?.controlRevision ?? -1, error) };
}
