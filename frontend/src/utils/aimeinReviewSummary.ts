import type { AimeinRun, AimeinSummary } from '../types/aimein';
import { expectedReviewers } from '../types/aimein';

/** 汇总观察，不增加投票、评审调用或验收信用。缺少原报告时保持未知。 */
export function reviewOverview(summary?: AimeinSummary, detail?: AimeinRun) {
  const reviews = summary?.reviews || [];
  const reports = detail?.reviews || [];
  const expected = expectedReviewers(summary);
  const returned = reviews.filter(r => ['passed', 'changes_requested'].includes(r.status)).length;
  const completeReports = !['stale', 'blocked', 'needs_attention'].includes(summary?.status || '') && expected > 0 && reviews.length === expected && returned === expected && new Set(reviews.map(r => r.model.toLocaleLowerCase())).size === expected
    && expectedReviewers(detail) === expected && reports.length === expected
    && reviews.every(review => reports.some(r => r.id === review.id && r.model === review.model && Array.isArray(r.criteria)));
  const criteria = (summary?.criteria || []).map(condition => {
    const opinions = reviews.map(review => ({ model: review.model, reviewId: review.id,
      item: ['passed', 'changes_requested'].includes(review.status) ? reports.find(r => r.id === review.id)?.criteria?.find(c => c.id === condition.id) : undefined }));
    const known = opinions.filter(o => o.item && o.item.status !== 'unknown');
    const agreement = completeReports && opinions.every(o => o.item?.status === 'verified');
    const disagreement = known.some(o => o.item?.status === 'verified') && known.some(o => o.item?.status === 'gap');
    return { ...condition, opinions, agreement, disagreement, gap: opinions.some(o => o.item?.status === 'gap') };
  });
  const accepted = summary?.accepted === true && completeReports && criteria.length > 0 && criteria.every(c => c.agreement) && reviews.every(r => r.status === 'passed');
  const issues = (summary?.issues || []).filter(issue => !criteria.some(c => c.id === issue.id && c.gap));
  const problems = criteria.filter(c => c.gap);
  const unknown = criteria.filter(c => !c.agreement && !c.gap);
  const title = accepted ? summary?.complete ? '整体目标评审通过' : '本阶段通过' : returned < expected ? `评审尚未完成 · ${returned}/${expected} 已返回`
    : !completeReports ? '报告依据待核对' : '本阶段尚未通过';
  return { title, expected, accepted, returned, completeReports, criteria, common: criteria.filter(c => c.agreement), problems, unknown, issues,
    next: summary?.nextFocus || (problems.length || issues.length ? '先核对下列缺口和分歧，再推进修补。' : returned < expected ? '等待其余评委返回，保留已有观察。' : accepted ? '按剩余目标安排下一阶段。' : '补齐评审依据后再确定下一步。') };
}
