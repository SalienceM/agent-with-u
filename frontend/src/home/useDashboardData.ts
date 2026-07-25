import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getExecutors, onExecStatus } from '../api';
import {
  buildDashboardViewModel,
  type DashboardActivitySource,
  type DashboardBackendSource,
  type DashboardLoadState,
  type DashboardLoopSource,
  type DashboardSessionSource,
  type DashboardTaskSource,
  type DashboardViewModel,
} from './dashboardModel';
import { mapSettledWithConcurrency, mergeSuccessfulSnapshots } from './dashboardPerformance';

interface UseDashboardDataArgs {
  sessions: DashboardSessionSource[];
  backends: DashboardBackendSource[];
  activeBackendId?: string;
  connected: boolean | null;
  streamingSessionIds: ReadonlySet<string>;
  completedSessionIds: ReadonlySet<string>;
}

interface UseDashboardDataResult {
  viewModel: DashboardViewModel;
  refresh: () => void;
}

const activityId = (prefix: string): string =>
  `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

export function useDashboardData({
  sessions,
  backends,
  activeBackendId,
  connected,
  streamingSessionIds,
  completedSessionIds,
}: UseDashboardDataArgs): UseDashboardDataResult {
  const [loopStates, setLoopStates] = useState<Record<string, DashboardLoopSource | undefined>>({});
  const [taskStates, setTaskStates] = useState<Record<string, DashboardTaskSource | undefined>>({});
  const [executors, setExecutors] = useState(() => getExecutors());
  const [activity, setActivity] = useState<DashboardActivitySource[]>([]);
  const [loadState, setLoadState] = useState<DashboardLoadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState(Date.now());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const loadedOnceRef = useRef(false);
  const streamingSeenRef = useRef(new Set<string>());
  const pendingLoopStatesRef = useRef<Record<string, DashboardLoopSource>>({});
  const pendingTaskStatesRef = useRef<Record<string, DashboardTaskSource>>({});
  const pendingActivityRef = useRef<DashboardActivitySource[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = useCallback(() => {
    flushTimerRef.current = null;
    const loopBatch = pendingLoopStatesRef.current;
    const taskBatch = pendingTaskStatesRef.current;
    const activityBatch = pendingActivityRef.current;
    pendingLoopStatesRef.current = {};
    pendingTaskStatesRef.current = {};
    pendingActivityRef.current = [];
    if (Object.keys(loopBatch).length) {
      setLoopStates((previous) => ({ ...previous, ...loopBatch }));
    }
    if (Object.keys(taskBatch).length) {
      setTaskStates((previous) => ({ ...previous, ...taskBatch }));
    }
    if (activityBatch.length) {
      setActivity((previous) => [...activityBatch].reverse().concat(previous).slice(0, 50));
    }
    if (Object.keys(loopBatch).length || Object.keys(taskBatch).length || activityBatch.length) {
      setUpdatedAt(Date.now());
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(flushPending, 120);
  }, [flushPending]);

  const appendActivity = useCallback((item: DashboardActivitySource) => {
    const destinationKey = item.destination && 'sessionId' in item.destination
      ? item.destination.sessionId
      : item.destination?.kind || '';
    const semanticKey = `${item.kind}:${destinationKey}:${item.title}`;
    const existing = pendingActivityRef.current.findIndex((candidate) => {
      const candidateDestination = candidate.destination && 'sessionId' in candidate.destination
        ? candidate.destination.sessionId
        : candidate.destination?.kind || '';
      return `${candidate.kind}:${candidateDestination}:${candidate.title}` === semanticKey;
    });
    if (existing >= 0) pendingActivityRef.current[existing] = item;
    else pendingActivityRef.current.push(item);
    if (pendingActivityRef.current.length > 50) pendingActivityRef.current.shift();
    scheduleFlush();
  }, [scheduleFlush]);

  const queueLoopState = useCallback((state: DashboardLoopSource) => {
    pendingLoopStatesRef.current[state.sessionId] = state;
    scheduleFlush();
  }, [scheduleFlush]);

  const queueTaskState = useCallback((state: DashboardTaskSource) => {
    pendingTaskStatesRef.current[state.sessionId] = state;
    scheduleFlush();
  }, [scheduleFlush]);

  useEffect(() => () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);

  const sessionKey = useMemo(
    () => sessions.map((session) => `${session.id}:${session.sessionType || 'normal'}`).sort().join('|'),
    [sessions],
  );
  const sessionInventory = useMemo(
    () => sessions.map(({ id, sessionType }) => ({ id, sessionType })),
    [sessionKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    setExecutors(getExecutors());
    return onExecStatus(() => {
      const next = getExecutors();
      setExecutors((previous) => (
        previous.length === next.length
        && previous.every((item, index) => (
          item.key === next[index]?.key
          && item.connected === next[index]?.connected
          && item.label === next[index]?.label
          && item.isHome === next[index]?.isHome
        ))
          ? previous
          : next
      ));
      appendActivity({
        id: activityId('executors'),
        at: Date.now(),
        kind: 'connection',
        title: '执行节点状态已更新',
        detail: `${next.filter((executor) => executor.connected).length}/${next.length} 在线`,
        tone: next.some((executor) => executor.connected) ? 'success' : 'danger',
        destination: { kind: 'settings', section: 'connections' },
      });
    });
  }, [appendActivity]);

  useEffect(() => {
    if (connected !== true) {
      setLoadState(loadedOnceRef.current ? 'stale' : connected === null ? 'loading' : 'error');
      if (connected === false) setErrorMessage('服务连接已断开，当前显示最后一次成功同步的数据。');
      return;
    }

    let cancelled = false;
    setLoadState('loading');
    setErrorMessage(undefined);

    const loadDetails = async () => {
      const loopSessions = sessionInventory.filter((session) => session.sessionType === 'loop');
      const normalSessions = sessionInventory.filter((session) => session.sessionType !== 'loop');
      const jobs = [
        ...loopSessions.map((session) => ({ kind: 'loop' as const, session })),
        ...normalSessions.map((session) => ({ kind: 'tasks' as const, session })),
      ];
      const results = await mapSettledWithConcurrency(jobs, 6, async (job) => {
        if (job.kind === 'loop') {
          const state = await api.loopGetState(job.session.id);
          if (!state) throw new Error(`Loop ${job.session.id} 无状态`);
          return { kind: 'loop' as const, sessionId: job.session.id, state };
        }
        const state = await api.seqtaskGet(job.session.id);
        if (state.status !== 'ok') throw new Error(`会话 ${job.session.id} 待办加载失败`);
        return {
          kind: 'tasks' as const,
          sessionId: job.session.id,
          state: { sessionId: job.session.id, seqTasks: state.seqTasks || [] },
        };
      });
      if (cancelled) return;

      const nextLoops: Record<string, DashboardLoopSource> = {};
      const nextTasks: Record<string, DashboardTaskSource> = {};
      let failureCount = 0;
      for (const result of results) {
        if (result.status === 'rejected') {
          failureCount += 1;
        } else if (result.value.kind === 'loop') {
          nextLoops[result.value.sessionId] = result.value.state;
        } else {
          nextTasks[result.value.sessionId] = result.value.state;
        }
      }

      setLoopStates((previous) => mergeSuccessfulSnapshots(
        previous,
        loopSessions.map((session) => session.id),
        nextLoops,
      ));
      setTaskStates((previous) => mergeSuccessfulSnapshots(
        previous,
        normalSessions.map((session) => session.id),
        nextTasks,
      ));
      loadedOnceRef.current = true;
      setUpdatedAt(Date.now());
      if (failureCount > 0) {
        setLoadState('stale');
        setErrorMessage(`${failureCount} 个数据源暂时不可用，其余首页数据已更新。`);
      } else {
        setLoadState('ready');
        setErrorMessage(undefined);
      }
    };

    loadDetails().catch((error) => {
      if (cancelled) return;
      setLoadState(loadedOnceRef.current ? 'stale' : 'error');
      setErrorMessage(error instanceof Error ? error.message : '首页数据加载失败');
    });
    return () => { cancelled = true; };
  }, [connected, refreshVersion, sessionInventory]);

  useEffect(() => {
    const unsubscribeLoop = api.onLoopUpdated((state: DashboardLoopSource) => {
      if (!state?.sessionId) return;
      queueLoopState(state);
      appendActivity({
        id: activityId('loop'),
        at: Date.now(),
        kind: 'loop',
        title: state.running ? 'Loop 开始或继续执行' : 'Loop 状态已更新',
        detail: `第 ${state.round || 1} 轮 · ${state.stage || '未知阶段'}`,
        tone: state.running ? 'info' : state.stage === 'loopout' ? 'success' : 'neutral',
        destination: { kind: 'loop', sessionId: state.sessionId },
      });
    });
    const unsubscribeTasks = api.onSeqtaskUpdated((state) => {
      if (!state?.sessionId) return;
      queueTaskState({ sessionId: state.sessionId, seqTasks: state.seqTasks || [], updatedAt: Date.now() });
      appendActivity({
        id: activityId('tasks'),
        at: Date.now(),
        kind: 'task',
        title: '待办队列已更新',
        detail: `${state.seqTasks?.filter((task: any) => task.status === 'pending').length || 0} 项等待处理`,
        tone: 'info',
        destination: { kind: 'tasks', sessionId: state.sessionId },
      });
    });
    const unsubscribeSessions = api.onSessionUpdated((event: any) => {
      const sessionId = event?.summary?.id || event?.sessionId;
      appendActivity({
        id: activityId('session'),
        at: Date.now(),
        kind: 'session',
        title: event?.type === 'session_deleted' ? '会话已删除' : '会话列表已更新',
        detail: event?.summary?.title || event?.title || '',
        tone: event?.type === 'session_deleted' ? 'warning' : 'neutral',
        destination: sessionId && event?.type !== 'session_deleted'
          ? { kind: 'session', sessionId }
          : undefined,
      });
    });
    const unsubscribeStream = api.onStreamDelta((delta: any) => {
      const sessionId = delta?.sessionId;
      if (!sessionId) return;
      if (delta.type === 'done') {
        streamingSeenRef.current.delete(sessionId);
        appendActivity({
          id: activityId('stream-done'),
          at: Date.now(),
          kind: 'session',
          title: '会话响应已完成',
          tone: 'success',
          destination: { kind: 'session', sessionId },
        });
      } else if (!streamingSeenRef.current.has(sessionId)) {
        streamingSeenRef.current.add(sessionId);
        appendActivity({
          id: activityId('stream-start'),
          at: Date.now(),
          kind: 'session',
          title: '会话开始响应',
          tone: 'info',
          destination: { kind: 'session', sessionId },
        });
      }
    });
    return () => {
      unsubscribeLoop();
      unsubscribeTasks();
      unsubscribeSessions();
      unsubscribeStream();
    };
  }, [appendActivity, queueLoopState, queueTaskState]);

  const viewModel = useMemo(() => buildDashboardViewModel({
    sessions,
    loopStates,
    taskStates,
    backends,
    executors,
    activeBackendId,
    connected,
    streamingSessionIds,
    completedSessionIds,
    activity,
    loadState,
    errorMessage,
    updatedAt,
  }), [
    sessions, loopStates, taskStates, backends, executors, activeBackendId, connected,
    streamingSessionIds, completedSessionIds, activity, loadState, errorMessage, updatedAt,
  ]);

  return { viewModel, refresh };
}
