import type { AimeinRun, AimeinSummary } from '../types/aimein';
import { expectedReviewers } from '../types/aimein';

export type CollectionState = 'missing' | 'invalid' | 'empty' | 'ready';
export interface AimeinDataState { collections: Record<string, CollectionState>; }
export const dataObject = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value);

/** 只读投影：安全数组和原始状态分开，不能把缺字段解释成零任务。 */
export function readCollection<T>(value: T[] | undefined, valid: (item: T) => boolean = item => dataObject(item)) {
  const state: CollectionState = value === undefined ? 'missing'
    : !Array.isArray(value) || !value.every(valid) ? 'invalid' : value.length ? 'ready' : 'empty';
  return { state, items: (state === 'ready' || state === 'empty') ? value! : [] as T[] };
}

interface DataRecord {
  orchestration: Array<{ index: number; status: string; desc: string; output: string }>;
  aimeinSummary?: AimeinSummary; aimeinRun?: AimeinRun; detailLoaded?: boolean; aimeinData?: AimeinDataState;
}

export function projectAimeinRecord<T extends DataRecord>(record: T): T {
  const collections: Record<string, CollectionState> = {};
  function list<V>(path: string, raw: V[] | undefined, valid?: (item: V) => boolean): V[] {
    const value = readCollection(raw, valid);
    collections[path] = value.state;
    return value.items;
  }
  const orchestration = list('orchestration', record.orchestration, step => dataObject(step)
    && Number.isInteger(step.index) && typeof step.status === 'string' && typeof step.desc === 'string' && typeof step.output === 'string');
  // run_summary({}) 的 {} 是“尚无 AIMEIN 尝试”，不是具有 reviews 的摘要。
  const rawSummary = record.aimeinSummary;
  let aimeinSummary: AimeinSummary | undefined;
  if (rawSummary != null && dataObject(rawSummary) && !Object.keys(rawSummary).length) {
    aimeinSummary = undefined;
  } else if (rawSummary !== undefined) {
    if (!dataObject(rawSummary)) collections.aimeinSummary = 'invalid';
    else aimeinSummary = { ...rawSummary,
      title: typeof rawSummary.title === 'string' ? rawSummary.title : '',
      reviews: list('summary.reviews', rawSummary.reviews, r => dataObject(r) && typeof r.id === 'string' && typeof r.model === 'string' && typeof r.status === 'string'),
      criteria: list('summary.criteria', rawSummary.criteria, c => dataObject(c) && typeof c.id === 'string' && typeof c.lane === 'string' && typeof c.acceptance === 'string'),
      issues: list('summary.issues', rawSummary.issues, i => dataObject(i) && typeof i.reason === 'string' && typeof i.model === 'string'),
    };
  }
  let aimeinRun = record.aimeinRun;
  if (aimeinRun !== undefined && !dataObject(aimeinRun)) {
    collections.aimeinRun = 'invalid'; aimeinRun = undefined;
  } else if (aimeinRun && Object.keys(aimeinRun).length) {
    const reports = list('detail.reviews', aimeinRun.reviews, r => dataObject(r) && typeof r.id === 'string' && typeof r.model === 'string' && typeof r.status === 'string');
    const reviews = reports.map(r => {
      const report = { ...r };
      for (const key of ['criteria', 'targets'] as const) {
        // 待评审记录允许尚无报告。已返回的报告缺字段仍为未知。
        if (r[key] !== undefined || ['passed', 'changes_requested'].includes(r.status)) {
          report[key] = list(`detail.${r.id}.${key}`, r[key], c => dataObject(c) && typeof c.id === 'string'
            && typeof c.status === 'string' && typeof c.reason === 'string' && Array.isArray(c.evidence) && c.evidence.every(v => typeof v === 'string'));
        }
      }
      if (r.attempts !== undefined) report.attempts = list(`detail.${r.id}.attempts`, r.attempts);
      return report;
    });
    let plan = aimeinRun.plan;
    if (plan !== undefined && !dataObject(plan)) { collections['detail.plan'] = 'invalid'; plan = undefined; }
    else if (plan && Object.keys(plan).length) {
      plan = { ...plan, targets: list('detail.targets', plan.targets, t => dataObject(t) && typeof t.id === 'string' && typeof t.title === 'string'
        && typeof t.acceptance === 'string' && Array.isArray(t.dependsOn) && t.dependsOn.every(id => typeof id === 'string')) };
      if (plan.sprint !== undefined && !dataObject(plan.sprint)) { collections['detail.sprint'] = 'invalid'; plan.sprint = undefined; }
      else if (plan.sprint) plan.sprint = { ...plan.sprint,
        criteria: list('detail.criteria', plan.sprint.criteria, c => dataObject(c) && typeof c.id === 'string' && typeof c.targetId === 'string' && typeof c.lane === 'string'),
        ...(plan.sprint.deferred === undefined ? {} : { deferred: list('detail.deferred', plan.sprint.deferred, v => typeof v === 'string') }),
      };
    }
    aimeinRun = { ...aimeinRun, reviews, plan };
    // 结构损坏不能靠过滤坏成员凑齐评审组，也不能获得覆盖信用。
    if (Object.entries(collections).some(([path, state]) => path.startsWith('detail.') && ['missing', 'invalid'].includes(state))) {
      aimeinRun.reviewerCount = 0;
    }
  }
  if (aimeinSummary && Object.entries(collections).some(([path, state]) => path !== 'orchestration' && ['missing', 'invalid'].includes(state))) {
    aimeinSummary = { ...aimeinSummary, accepted: false, complete: false,
      status: aimeinSummary.status === 'accepted' ? 'needs_attention' : aimeinSummary.status };
  }
  if (aimeinSummary && (!aimeinSummary.criteria.length || expectedReviewers(aimeinSummary) !== aimeinSummary.reviews.length
    || !aimeinSummary.reviews.length || aimeinSummary.reviews.some(r => r.status !== 'passed'))) {
    aimeinSummary = { ...aimeinSummary, accepted: false, complete: false,
      status: aimeinSummary.status === 'accepted' ? 'needs_attention' : aimeinSummary.status };
  }
  return { ...record, orchestration, aimeinSummary, aimeinRun, aimeinData: { collections } };
}

export function aimeinDataMessages(data?: AimeinDataState, loading = false): string[] {
  const labels: Record<string, string> = { orchestration: '步骤集合', aimeinSummary: '阶段摘要', aimeinRun: '阶段详情',
    'summary.reviews': '评审集合', 'summary.criteria': '验收条件', 'summary.issues': '问题集合', 'detail.reviews': '评审详情',
    'detail.targets': '目标集合', 'detail.plan': '目标计划', 'detail.sprint': '阶段计划', 'detail.criteria': '阶段条件', 'detail.deferred': '后续范围' };
  return [...new Set(Object.entries(data?.collections || {}).filter(([, state]) => state === 'missing' || state === 'invalid')
    .map(([path, state]) => `${labels[path] || '评审报告'}${state === 'invalid' ? '格式异常，暂不可用' : loading ? '尚未加载' : '未提供，状态未知'}`))];
}
