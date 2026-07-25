/**
 * 首页只消费这一份聚合模型，不直接拼接各业务组件的局部 state。
 *
 * 这里刻意保持纯函数：第 5 步接入 RPC / WebSocket 时，只需把真实快照喂给
 * buildDashboardViewModel；后续高频事件也可以先批量合并，再生成一个新快照。
 */

export type DashboardModuleId =
  | 'global-status'
  | 'quick-actions'
  | 'sessions'
  | 'loops'
  | 'tasks'
  | 'model-status'
  | 'metrics'
  | 'activity';

export type DashboardTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type DashboardLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'stale';

export type DashboardDestination =
  | { kind: 'session'; sessionId: string }
  | { kind: 'loop'; sessionId: string }
  | { kind: 'tasks'; sessionId: string }
  | { kind: 'new-session'; sessionType?: 'normal' | 'loop' }
  | { kind: 'settings'; section: 'general' | 'models' | 'connections' | 'home' };

export interface DashboardSessionSource {
  id: string;
  title: string;
  messageCount?: number;
  updatedAt?: number;
  workingDir?: string;
  backendId?: string;
  modelOverride?: string;
  reasoningEffort?: string;
  sessionType?: 'normal' | 'loop';
  execKey?: string;
  execLabel?: string;
}

export interface DashboardLoopSource {
  sessionId: string;
  stage?: 'loopidea' | 'loopexecute' | 'loopout' | string;
  status?: string;
  running?: boolean;
  resumable?: boolean;
  round?: number;
  roundLoopCount?: number;
  effectiveMaxLoops?: number;
  latestScore?: number;
  riskCoefficient?: number;
  updatedAt?: number;
  loops?: Array<{ seq?: number; subStage?: string; completed?: boolean; updatedAt?: number }>;
}

export interface DashboardTaskSource {
  sessionId: string;
  seqTasks: Array<{
    id: string;
    text?: string;
    status?: string;
    createdAt?: number;
    updatedAt?: number;
  }>;
  updatedAt?: number;
}

export interface DashboardBackendSource {
  id: string;
  label?: string;
  type?: string;
  enabled?: boolean;
}

export interface DashboardExecutorSource {
  key: string;
  label: string;
  connected: boolean;
  isHome?: boolean;
}

export interface DashboardActivitySource {
  id: string;
  at: number;
  kind: 'session' | 'loop' | 'task' | 'connection' | 'model' | 'system';
  title: string;
  detail?: string;
  tone?: DashboardTone;
  destination?: DashboardDestination;
}

export interface DashboardSourceSnapshot {
  sessions: DashboardSessionSource[];
  loopStates: Record<string, DashboardLoopSource | undefined>;
  taskStates: Record<string, DashboardTaskSource | undefined>;
  backends: DashboardBackendSource[];
  executors: DashboardExecutorSource[];
  activeBackendId?: string;
  connected: boolean | null;
  streamingSessionIds: ReadonlySet<string>;
  completedSessionIds: ReadonlySet<string>;
  activity: DashboardActivitySource[];
  loadState: DashboardLoadState;
  errorMessage?: string;
  updatedAt: number;
}

export interface DashboardStatusItem {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: DashboardTone;
  destination?: DashboardDestination;
}

export interface DashboardSessionItem {
  id: string;
  title: string;
  subtitle: string;
  updatedAt: number;
  state: 'running' | 'unread' | 'idle';
  destination: DashboardDestination;
}

export interface DashboardLoopItem {
  sessionId: string;
  title: string;
  stageLabel: string;
  progressLabel: string;
  score: number | null;
  state: 'running' | 'resumable' | 'ready' | 'output';
  destination: DashboardDestination;
}

export interface DashboardTaskItem {
  id: string;
  sessionId: string;
  text: string;
  status: string;
  destination: DashboardDestination;
}

export interface DashboardQuickAction {
  id: 'new-chat' | 'new-loop' | 'resume-work' | 'open-tasks' | 'manage-models';
  label: string;
  description: string;
  destination: DashboardDestination;
  disabled?: boolean;
}

export interface DashboardMetric {
  id: 'active-sessions' | 'running-loops' | 'pending-tasks' | 'online-executors';
  label: string;
  value: number;
  tone: DashboardTone;
}

export interface DashboardViewModel {
  generatedAt: number;
  loadState: DashboardLoadState;
  errorMessage?: string;
  globalStatus: DashboardStatusItem[];
  quickActions: DashboardQuickAction[];
  sessions: DashboardSessionItem[];
  loops: DashboardLoopItem[];
  tasks: DashboardTaskItem[];
  modelStatus: {
    backendId: string | null;
    label: string;
    detail: string;
    tone: DashboardTone;
    destination: DashboardDestination;
  };
  metrics: DashboardMetric[];
  activity: DashboardActivitySource[];
}

export interface DashboardModuleDefinition {
  id: DashboardModuleId;
  label: string;
  priority: 1 | 2 | 3;
  defaultVisible: boolean;
  minimumVisible?: boolean;
  defaultOrder: number;
  destination?: DashboardDestination;
}

/**
 * priority=1 必须在首屏且不可隐藏；priority=2 是核心工作；priority=3 是补充态势。
 * 后续定制只能调整可见模块，不得让连接、运行中任务和关键快捷操作消失。
 */
export const DASHBOARD_MODULES: readonly DashboardModuleDefinition[] = [
  { id: 'global-status', label: '全局状态', priority: 1, defaultVisible: true, minimumVisible: true, defaultOrder: 0 },
  { id: 'quick-actions', label: '快捷操作', priority: 1, defaultVisible: true, minimumVisible: true, defaultOrder: 1 },
  { id: 'loops', label: 'Loop 进度', priority: 1, defaultVisible: true, minimumVisible: true, defaultOrder: 2 },
  { id: 'tasks', label: '待办事项', priority: 1, defaultVisible: true, minimumVisible: true, defaultOrder: 3 },
  { id: 'sessions', label: '最近会话', priority: 2, defaultVisible: true, defaultOrder: 4 },
  {
    id: 'model-status',
    label: '模型状态',
    priority: 2,
    defaultVisible: true,
    defaultOrder: 5,
    destination: { kind: 'settings', section: 'models' },
  },
  { id: 'metrics', label: '关键指标', priority: 2, defaultVisible: true, defaultOrder: 6 },
  { id: 'activity', label: '实时状态流', priority: 3, defaultVisible: true, defaultOrder: 7 },
] as const;

const LOOP_STAGE_LABELS: Record<string, string> = {
  loopidea: '构思',
  loopexecute: '执行',
  loopout: '输出',
};

function epochMs(value?: number): number {
  if (!value || !Number.isFinite(value)) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function trimLabel(value: string | undefined, fallback: string, max = 80): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function buildDashboardViewModel(source: DashboardSourceSnapshot): DashboardViewModel {
  const sessionsById = new Map(source.sessions.map((session) => [session.id, session]));
  const sortedSessions = [...source.sessions].sort(
    (a, b) => epochMs(b.updatedAt) - epochMs(a.updatedAt),
  );
  const runningLoops = Object.values(source.loopStates).filter((loop) => loop?.running);
  let pendingTaskCount = 0;
  const taskCandidates: Array<DashboardTaskItem & { updatedAt: number }> = [];
  for (const state of Object.values(source.taskStates)) {
    if (!state) continue;
    for (const task of state.seqTasks) {
      if (['done', 'completed', 'cancelled'].includes(task.status || 'pending')) continue;
      pendingTaskCount += 1;
      const candidate: DashboardTaskItem & { updatedAt: number } = {
        id: task.id,
        sessionId: state.sessionId,
        text: trimLabel(task.text, '未命名待办'),
        status: task.status || 'pending',
        destination: { kind: 'tasks', sessionId: state.sessionId },
        updatedAt: epochMs(task.updatedAt || task.createdAt || state.updatedAt),
      };
      const insertAt = taskCandidates.findIndex((item) => candidate.updatedAt > item.updatedAt);
      if (insertAt < 0) taskCandidates.push(candidate);
      else taskCandidates.splice(insertAt, 0, candidate);
      if (taskCandidates.length > 8) taskCandidates.pop();
    }
  }
  const onlineExecutors = source.executors.filter((executor) => executor.connected);
  const activeBackend = source.backends.find((backend) => backend.id === source.activeBackendId);

  const sessions: DashboardSessionItem[] = sortedSessions.slice(0, 8).map((session) => {
    const running = source.streamingSessionIds.has(session.id) || Boolean(source.loopStates[session.id]?.running);
    return {
      id: session.id,
      title: trimLabel(session.title, '未命名会话'),
      subtitle: trimLabel(
        [session.execLabel, session.modelOverride || session.backendId, session.workingDir]
          .filter(Boolean)
          .join(' · '),
        `${session.messageCount || 0} 条消息`,
      ),
      updatedAt: epochMs(session.updatedAt),
      state: running ? 'running' : source.completedSessionIds.has(session.id) ? 'unread' : 'idle',
      destination: { kind: 'session', sessionId: session.id },
    };
  });

  const loops: DashboardLoopItem[] = Object.values(source.loopStates)
    .filter((loop): loop is DashboardLoopSource => Boolean(loop))
    .sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return epochMs(b.updatedAt) - epochMs(a.updatedAt);
    })
    .slice(0, 6)
    .map((loop) => {
      const session = sessionsById.get(loop.sessionId);
      const stage = loop.stage || 'loopexecute';
      const lastLoop = loop.loops?.[loop.loops.length - 1];
      const state: DashboardLoopItem['state'] =
        stage === 'loopout' ? 'output' : loop.running ? 'running' : loop.resumable ? 'resumable' : 'ready';
      return {
        sessionId: loop.sessionId,
        title: trimLabel(session?.title, 'Loop 会话'),
        stageLabel: LOOP_STAGE_LABELS[stage] || stage,
        progressLabel:
          stage === 'loopexecute'
            ? `第 ${loop.round || 1} 轮 · ${lastLoop?.subStage || '待开始'} · ${loop.roundLoopCount || 0}/${loop.effectiveMaxLoops || '—'}`
            : stage === 'loopout'
              ? '本轮可输出'
              : '等待目标确认',
        score: Number.isFinite(loop.latestScore) ? Number(loop.latestScore) : null,
        state,
        destination: { kind: 'loop', sessionId: loop.sessionId },
      };
    });

  const tasks: DashboardTaskItem[] = taskCandidates
    .map(({ updatedAt: _updatedAt, ...task }) => task);

  const resumeTarget =
    loops.find((loop) => loop.state === 'running' || loop.state === 'resumable')?.destination
    || sessions.find((session) => session.state === 'running' || session.state === 'unread')?.destination
    || sessions[0]?.destination;
  const taskTarget = tasks[0]?.destination || sessions[0]?.destination;

  const connectionTone: DashboardTone =
    source.connected === null ? 'info' : source.connected ? 'success' : 'danger';
  const connectionValue = source.connected === null ? '连接中' : source.connected ? '已连接' : '已断开';

  return {
    generatedAt: source.updatedAt,
    loadState: source.loadState,
    errorMessage: source.errorMessage,
    globalStatus: [
      {
        id: 'connection',
        label: '服务连接',
        value: connectionValue,
        detail: `${onlineExecutors.length}/${source.executors.length || 1} 个执行节点在线`,
        tone: connectionTone,
        destination: { kind: 'settings', section: 'connections' },
      },
      {
        id: 'active-work',
        label: '正在执行',
        value: String(source.streamingSessionIds.size + runningLoops.length),
        detail: `${runningLoops.length} 个 Loop 正在运行`,
        tone: runningLoops.length || source.streamingSessionIds.size ? 'info' : 'neutral',
        destination: resumeTarget,
      },
      {
        id: 'attention',
        label: '需要关注',
        value: String(source.completedSessionIds.size + pendingTaskCount),
        detail: `${source.completedSessionIds.size} 个完成待查看 · ${pendingTaskCount} 个待办`,
        tone: source.completedSessionIds.size || pendingTaskCount ? 'warning' : 'success',
        destination: taskTarget,
      },
    ],
    quickActions: [
      { id: 'new-chat', label: '新建会话', description: '创建普通会话', destination: { kind: 'new-session', sessionType: 'normal' } },
      { id: 'new-loop', label: '新建 Loop', description: '创建循环交付任务', destination: { kind: 'new-session', sessionType: 'loop' } },
      {
        id: 'resume-work',
        label: '继续工作',
        description: resumeTarget ? '打开最需要处理的工作' : '暂无可继续工作',
        destination: resumeTarget || { kind: 'new-session', sessionType: 'normal' },
        disabled: !resumeTarget,
      },
      {
        id: 'open-tasks',
        label: '处理待办',
        description: taskTarget ? `${pendingTaskCount} 项等待处理` : '暂无待办',
        destination: taskTarget || { kind: 'new-session', sessionType: 'normal' },
        disabled: !taskTarget,
      },
      { id: 'manage-models', label: '模型与连接', description: '检查运行配置', destination: { kind: 'settings', section: 'models' } },
    ],
    sessions,
    loops,
    tasks,
    modelStatus: {
      backendId: activeBackend?.id || source.activeBackendId || null,
      label: activeBackend?.label || activeBackend?.id || source.activeBackendId || '未选择模型',
      detail: activeBackend
        ? `${activeBackend.type || 'backend'} · ${source.connected ? '可用' : '等待连接'}`
        : '请配置或选择模型',
      tone: activeBackend && source.connected ? 'success' : source.connected === null ? 'info' : 'warning',
      destination: { kind: 'settings', section: 'models' },
    },
    metrics: [
      { id: 'active-sessions', label: '活动会话', value: source.streamingSessionIds.size, tone: 'info' },
      { id: 'running-loops', label: '运行 Loop', value: runningLoops.length, tone: 'info' },
      { id: 'pending-tasks', label: '待办', value: pendingTaskCount, tone: pendingTaskCount ? 'warning' : 'neutral' },
      { id: 'online-executors', label: '在线节点', value: onlineExecutors.length, tone: onlineExecutors.length ? 'success' : 'danger' },
    ],
    activity: [...source.activity].sort((a, b) => epochMs(b.at) - epochMs(a.at)).slice(0, 50),
  };
}
