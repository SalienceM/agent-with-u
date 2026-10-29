import type { AimeinRun, AimeinSummary } from '../types/aimein';
import { expectedReviewers } from '../types/aimein';

interface GoalRecord {
  completed: boolean;
  aimeinRun?: {
    reviewerCount?: number;
    plan?: { targets?: Array<{ id: string }> };
    reviews?: Array<{ status: string; targets?: Array<{ id: string; status: string; fingerprints?: Record<string, string> }> }>;
  };
}

export type WorldLayout = 'split' | 'cluster';
export type WorldPoint = [number, number, number];
export interface WorldTarget {
  id: string; title: string; dependsOn: string[]; inSprint: boolean; verified: boolean;
}

/** 空计划是正常启动状态；停止或规划失败后不能继续显示“正在规划”。 */
export function planWaitingMessage(record: {
  completed: boolean; error?: string; detailLoaded?: boolean;
  aimeinRun?: AimeinRun; aimeinSummary?: { status: string };
} | undefined, running: boolean) {
  if (!record || record.aimeinRun?.plan?.targets?.length) return '';
  if (record.detailLoaded === false || !record.aimeinRun) return '正在读取阶段详情…';
  if (running && !record.completed && !record.error && ['planning', 'preparing'].includes(record.aimeinSummary?.status || '')) {
    return '正在拆解目标并生成阶段计划…';
  }
  return '尚未生成阶段计划，请查看当前阶段状态。';
}

/** 紧凑推送没有目标原文时等待详情，不按数量捏造方块或完成状态。 */
export function worldProjection(record?: { seq: number; completed: boolean; aimeinRun?: AimeinRun; aimeinSummary?: AimeinSummary }) {
  const observation = goalObservation(record);
  const plan = record?.aimeinRun?.plan;
  const scoped = new Set(plan?.sprint?.criteria?.map(c => c.targetId) || []);
  const targets: WorldTarget[] = (plan?.targets || []).slice(0, 40).map(t => ({
    id: t.id, title: t.title, dependsOn: t.dependsOn || [], inSprint: scoped.has(t.id),
    verified: observation.known && record!.aimeinRun!.reviews!.every(r => r.targets?.some(v => v.id === t.id && v.status === 'verified')),
  }));
  const status = record?.aimeinSummary?.status || 'planning';
  const layout: WorldLayout = ['planning', 'preparing'].includes(status) ? 'split' : 'cluster';
  return { targets, observation, layout, seq: record?.seq || 0,
    // 只以真实范围与阶段驱动默认布局，分数/推送时间不会重播。
    basis: JSON.stringify([record?.seq || 0, layout, targets.map(t => [t.id, t.inSprint, t.dependsOn])]),
    scoped: scoped.size > 0,
  };
}

export const TASK_PAGE_SIZE = 12;

/** 每页保留可点击的地块间距。聚合只改变水平间距，装配不再另建一套坐标。 */
export function targetPosition(index: number, targets: WorldTarget[], layout: WorldLayout): WorldPoint {
  const start = Math.floor(index / TASK_PAGE_SIZE) * TASK_PAGE_SIZE;
  const count = Math.min(TASK_PAGE_SIZE, targets.length - start);
  const columns = Math.max(1, Math.min(4, count));
  const rows = Math.ceil(count / columns);
  const local = index - start;
  const dx = layout === 'split' ? 1.28 : 1.15;
  const dz = layout === 'split' ? 1.42 : 1.3;
  return [-2.9 + (local % columns - (columns - 1) / 2) * dx, .24,
    -.45 + (Math.floor(local / columns) - (rows - 1) / 2) * dz];
}

export function taskPage(targets: WorldTarget[], requested = 0) {
  const pages = Math.max(1, Math.ceil(targets.length / TASK_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Math.floor(requested) || 0));
  const start = page * TASK_PAGE_SIZE;
  return { page, pages, start, targets: targets.slice(start, start + TASK_PAGE_SIZE) };
}

/** 仅投影直接关联，不把跨页、缺失或循环依赖悄悄当成完成。 */
export function targetRelations(targets: WorldTarget[], focused: string) {
  const target = targets.find(t => t.id === focused);
  if (!target) return [];
  const edges = new Map<string, { from: string; to: string; missing: boolean }>();
  const ids = new Set(targets.map(t => t.id));
  targets.forEach(t => t.dependsOn.forEach(id => {
    if (t.id === focused || id === focused) edges.set(JSON.stringify([id, t.id]), { from: id, to: t.id, missing: !ids.has(id) });
  }));
  return [...edges.values()];
}

/** 仅对所查看版本的完整评审组报告投影；不从成熟度、轮次或文件数量推断。 */
export function goalObservation(record?: GoalRecord) {
  const targets = record?.aimeinRun?.plan?.targets || [];
  const reviews = record?.aimeinRun?.reviews || [];
  const expected = expectedReviewers(record?.aimeinRun);
  const known = !!record?.completed && !!targets.length && expected > 0 && reviews.length === expected
    && reviews.every(r => ['passed', 'changes_requested'].includes(r.status) && targets.every(t => r.targets?.some(v => v.id === t.id
      && ['verified', 'gap', 'unknown'].includes(v.status) && (v.status !== 'verified' || Object.keys(v.fingerprints || {}).length > 0))));
  const verified = known ? targets.filter(t => reviews.every(r => r.targets?.some(v => v.id === t.id && v.status === 'verified'))).length : 0;
  return { known, verified, total: targets.length, fraction: known ? verified / targets.length : 0 };
}

export type FlowRouteId = 'prepare' | 'plan' | 'build' | 'infra' | 'store' | 'repair' | `review${number}` | `verify${number}`;
interface FlowRecord {
  seq: number; completed: boolean; aimeinRun?: AimeinRun; aimeinSummary?: AimeinSummary;
  orchestration: Array<{ index: number; status: string; output: string }>;
  error?: string; callDiagnostics?: Array<{ stage: string; status: string; phase: string }>;
}

/** 运行颗粒表达活动；只有已保存输出才形成堆积，绝不猜测步骤属于哪个目标。 */
export function flowProjection(record: FlowRecord | undefined, running: boolean, latest: boolean) {
  const summary = record?.aimeinSummary;
  const status = summary?.status || 'planning';
  const ready = !!record?.aimeinRun?.plan?.targets?.length;
  const steps = record?.orchestration || [];
  const saved = steps.filter(s => s.status === 'done' && !!s.output?.trim()).map(s => s.index);
  const reviews = (summary?.reviews || []).slice(0, 3).map(r => ({ id: r.id, status: r.status }));
  const lanes = new Set((record?.aimeinRun?.plan?.sprint?.criteria || summary?.criteria || []).map(c => c.lane));
  const workRoutes: FlowRouteId[] = [...(lanes.has('flow') ? ['build' as const] : []), ...(lanes.has('infra') ? ['infra' as const] : [])];
  const live = !!record && latest && running && !record.completed && !record.error;
  const calls = record?.callDiagnostics || [];
  const working = calls.filter(call => call.status === 'running' && ['thinking', 'text', 'tools', 'running', 'local_prepare', 'environment_check'].includes(call.phase));
  const preparation: FlowRouteId[] = working.flatMap(call => call.stage === 'prepare' ? ['prepare' as const] : ['aimein-plan', 'aimein-prepare'].includes(call.stage) ? ['plan' as const] : []);
  // 有诊断时尊重实际等待/重试；兼容旧记录的步骤状态，但不凭 ready 伪造活动。
  const observable = !calls.length || working.length > 0;
  const activity: FlowRouteId[] = !live || !observable ? [] : preparation.length ? [...new Set(preparation)] : !ready ? [] : status === 'executing' && steps.some(s => s.status === 'running')
    ? [...workRoutes, 'store'] : status === 'reviewing'
      ? reviews.flatMap((r, i) => r.status === 'running' && (!calls.length || working.some(call => call.stage === `aimein-${r.id}`)) ? [`review${i}` as FlowRouteId] : [])
      : ['planning', 'preparing'].includes(status) && lanes.size ? ['build'] : [];
  const coverage = goalObservation(record);
  return { identity: `${record?.seq || 0}:${summary?.sprintId || ''}:${summary?.attempt || 0}`, seq: record?.seq || 0,
    status, ready, latest, live, saved, totalSteps: steps.length, reviews, workRoutes, activity,
    verified: coverage.known ? coverage.verified : 0, known: coverage.known };
}

export type FlowSnapshot = ReturnType<typeof flowProjection>;

/** 首次加载、身份切换、历史和重复推送均只建立基线。 */
export function flowTransitions(previous: FlowSnapshot | undefined, next: FlowSnapshot): FlowRouteId[] {
  if (!previous || !previous.ready || !next.ready || !previous.latest || !next.latest || previous.identity !== next.identity) return [];
  const routes: FlowRouteId[] = [];
  if (previous.status !== next.status) {
    if (next.status === 'executing' && next.live) routes.push(...next.workRoutes);
    if (next.status === 'reviewing' && next.live) routes.push(...next.reviews.map((_, i) => `review${i}` as FlowRouteId));
    if (next.status === 'repair') routes.push('repair');
  }
  if (next.saved.some(id => !previous.saved.includes(id))) routes.push('store');
  if (next.known && next.verified > previous.verified) routes.push(...next.reviews.map((_, i) => `verify${i}` as FlowRouteId));
  return [...new Set(routes)];
}
