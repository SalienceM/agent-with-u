export interface ScheduleRef { scheduleId: string; scheduleRevision: number; occurrenceId: string; scheduledAt: number }
export type ScheduleRule = { kind: 'once' | 'daily' | 'weekly' | 'interval'; at?: number | string; offsetMinutes?: number;
  time?: string; weekdays?: number[]; anchor?: number; seconds?: number };
export interface ScheduleConfig { title: string; prompt: string; enabled: boolean; timezone: string; rule: ScheduleRule; misfirePolicy: 'catch_up_once' | 'skip' }
export interface SessionSchedule extends ScheduleConfig { id: string; sessionId: string; revision: number; nextDueAt: number | null; deleted?: boolean }
export interface ScheduleOccurrence extends Omit<ScheduleRef, 'occurrenceId'> { id: string; sessionId: string; title: string; state: string; error: string;
  createdAt: number; startedAt?: number; endedAt?: number; coveredThrough: number; coalescedCount: number;
  userMessageId: string; assistantMessageId: string; waitingForInput?: boolean; archived?: boolean }
export interface SchedulePage<T> { version: number; sessionId: string; executorId: string; revision: number; items: T[]; nextOffset: number | null;
  ready?: boolean; error?: string; blockedReason?: string; queuePaused?: boolean; queueError?: string; unknown?: boolean; observedAt?: number; enabledCount?: number;
  activity?: { id: string; revision: number; state: string; assistantMessageId: string; waitingForInput?: boolean } | null }
export interface ScheduleIntent { action: 'save' | 'enable' | 'delete' | 'cancel' | 'retry' | 'resolve'; requestId: string; id: string;
  expectedRevision?: number; enabled?: boolean; config?: ScheduleConfig; confirmed?: boolean }
export interface ScheduleReceipt { status: 'succeeded' | 'not_found'; requestId: string; sessionId: string; revision?: number;
  schedule?: SessionSchedule; occurrence?: ScheduleOccurrence; active?: { id: string; state: string }[] }
export interface ScheduleEvent { version: number; sessionId: string; executorId: string; id: string; revision: number; state?: string; updatedAt: number }
export const scheduleStateLabel: Record<string, string> = { prepared: '准备入队', queued: '等待执行', claimed: '启动中', running: '运行中',
  completed: '本轮已结束', failed: '失败', interrupted: '已中断', cancelled: '已取消', skipped: '已跳过', unknown: '结果未知' };
