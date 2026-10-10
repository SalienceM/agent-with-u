import type { LoopDecision, LoopSourceSummary } from '../types/loopContinuation';
import type { ExecutionEnvironment } from '../types/loopEnvironment';
import type { BlockerReview } from './loopTaskBlockers';

// 只投影执行端事实，不负责调度、权限判定或恢复。
export interface WorkbenchRecord {
  seq: number; round: number; subStage: string; completed: boolean; error: string;
  goal?: string; resultPreview?: string; taskResult?: string; decision?: LoopDecision;
  blockerSummary?: BlockerReview;
  orchestration: Array<{ index: number; desc: string; status: string }>;
  deliverySummary?: { mode?: string; counts?: Record<string, number>; blockerCount?: number;
    formal?: { total?: number; checked?: number }; milestones?: { counts?: Record<string, number> } };
  analysisPreview?: { verified?: string; gaps?: string; nextFocus?: string };
}
export interface WorkbenchState {
  sessionId: string; stage: string; goal: string; round: number; running: boolean; resumable: boolean;
  auto: boolean; controlMode?: string; stopReason: string; loops: WorkbenchRecord[];
  taskSource?: LoopSourceSummary; executionEnvironment?: ExecutionEnvironment;
  progressGuard?: { pause?: boolean; reason?: string; scopeLost?: boolean; needsReplan?: boolean };
  unresolvedBlockers?: { available?: boolean; count?: number };
  intentAlert?: { dismissed?: boolean; aligned?: boolean; divergence?: string; suggestion?: string; round?: number; seq?: number };
}
export type WorkbenchSection = 'process' | 'evidence' | 'goal' | 'settings' | 'issues';
export interface WorkbenchIssue {
  id: string; priority: number; title: string; reason: string; next: string;
  section: WorkbenchSection; refs: string[];
}
export const loopStageLabel = (stage: string): string => ({ loopidea: '整理目标', loopexecute: '执行任务', loopout: '本轮结果' }[stage] || '状态待核对');
export const loopSubstageLabel = (stage: string): string => ({ prepare: '规划', execute: '执行', analysis: '核验', done: '本次已结束' }[stage] || '等待状态');
export const boundedText = (text?: string, limit = 220): string => text ? text.length > limit ? text.slice(0, limit) + '…' : text : '';

export function loopWorkbenchView(state: WorkbenchState, options: { readOnly?: boolean; controlPending?: boolean; controlError?: string } = {}) {
  const latest = state.loops.at(-1);
  const current = latest?.round === state.round ? latest : undefined;
  const issues: WorkbenchIssue[] = [];
  const add = (issue: WorkbenchIssue) => {
    const existing = issues.find(item => item.id === issue.id);
    if (existing) { existing.refs = [...new Set([...existing.refs, ...issue.refs])]; return; }
    issues.push(issue);
  };
  const source = state.taskSource;
  const sourceBad = source?.status && !['current', 'unbound'].includes(source.status);
  const sourceKey = `source:${state.sessionId}:${source?.executor || ''}:${source?.change || ''}:${source?.revision ?? 'unknown'}`;
  if (sourceBad) add({ id: sourceKey, priority: 20, title: '核对任务来源', reason: source.reason || '任务范围或来源需要核对',
    next: '查看差异与处置依据；确认后不会自动运行。', section: 'settings', refs: [sourceKey] });
  const env = state.executionEnvironment;
  const checks = [...(env?.blockers || []), ...(env?.latest && (['blocked', 'stale', 'unsupported'].includes(env.latest.status || '') || env.latest.quiesced === false) ? [env.latest] : [])];
  checks.forEach((check, index) => {
    const id = check.id ? `environment:${check.id}:${check.revision ?? env?.revision}` : `environment:unknown:${index}`;
    add({ id, priority: check.quiesced === false ? 1 : 10, title: check.quiesced === false ? '旧调用退出尚未确认' : '核对执行环境',
      reason: check.reason || '当前检查未取得可用证据', next: check.resumeCondition || '查看相同执行策略下的证据；不自动恢复。', section: 'settings', refs: [id] });
  });
  const decision = current?.decision;
  if (decision && (['wait', 'stop', 'retry'].includes(decision.action || '') && decision.reasonCode !== 'auto_off')) {
    // 仅当前轮的结构化来源原因可归入当前来源；自由文本相同不构成身份。
    const sourceDecision = sourceBad && ({ conflict: 'scope_conflict', blocked: 'workflow_blocked', stale: 'source_unavailable', unavailable: 'source_unavailable', invalid: 'source_unavailable' }[source!.status!] === decision.reasonCode);
    const ref = `decision:${decision.decisionId || `${current?.seq}:${decision.revision ?? 'unknown'}`}`;
    add({ id: sourceDecision ? sourceKey : ref, priority: decision.reasonCode === 'call_active' ? 1 : 30,
      title: decision.action === 'retry' ? '调用需要核对' : decision.action === 'stop' ? '本轮已停止' : '等待处理',
      reason: decision.reasonText || '执行端未提供具体原因', next: decision.resumeCondition || decision.nextStep || '查看执行端依据', section: 'evidence', refs: [ref] });
  }
  const guard = state.progressGuard;
  if (guard?.pause || guard?.scopeLost || guard?.needsReplan) {
    const ref = `guard:${state.round}:${current?.seq ?? 0}`;
    add({ id: guard.pause && decision?.reasonCode === 'no_progress' ? `decision:${decision.decisionId || `${current?.seq}:${decision.revision ?? 'unknown'}`}` : ref,
      priority: 40, title: guard.pause ? '自动执行已暂停' : '下一轮需要调整', reason: guard.reason || (guard.scopeLost ? '任务范围需要核对' : '需要重新规划'),
      next: '成果已保留，尚未宣称完成。查看依据后显式继续。', section: 'evidence', refs: [ref] });
  }
  if (state.unresolvedBlockers?.available || (current?.deliverySummary?.blockerCount || 0) > 0 || current?.blockerSummary?.affectedIds?.length) {
    const ref = `tasks:${state.round}:${current?.seq ?? 0}`;
    add({ id: ref, priority: 50, title: '存在未解决任务阻塞', reason: '受影响任务及独立就绪任务需分别核对。',
      next: '局部阻塞不代表全部任务停止；查看任务与证据台账。', section: 'evidence', refs: [ref] });
  }
  if (state.intentAlert && !state.intentAlert.dismissed && state.intentAlert.aligned === false) {
    add({ id: `intent:${state.intentAlert.round}:${state.intentAlert.seq}`, priority: 60, title: '目标方向需要关注',
      reason: state.intentAlert.divergence || '检测到方向偏差', next: state.intentAlert.suggestion || '核对原始想法和当前目标', section: 'goal', refs: ['intentAlert'] });
  }
  if (options.controlPending || options.controlError) add({ id: 'control', priority: 0, title: '控制权需要核对',
    reason: options.controlError || '正在等待控制权转交的确定结果', next: '使用共享控制状态核对，不重复提交。', section: 'issues', refs: ['control'] });
  issues.sort((a, b) => a.priority - b.priority);
  const manual = options.readOnly || state.controlMode === 'manual';
  const full = decision?.action === 'complete' && decision.completionScope === 'full' && current?.taskResult === 'verified';
  const acceptance = decision?.completionScope === 'automatic' ? '自动范围完成，待人工核验'
    : full ? '执行端已确认完整验收' : current?.taskResult === 'blocked' ? '任务受阻，尚未完成'
    : current?.taskResult === 'implemented' ? '已实现，等待验收' : current?.taskResult === 'partial' ? '已有部分成果，尚未完成' : '尚未确认完整验收';
  const primary = manual ? 'manual' : options.controlPending || options.controlError ? 'check'
    : state.stage === 'loopout' ? 'continue' : state.running ? 'running' : state.stage === 'loopidea' ? 'seal'
    : issues.some(issue => issue.priority < 50) ? 'issues' : state.resumable ? 'resume' : state.stage === 'loopexecute' ? 'run' : 'check';
  const activeStep = current?.orchestration.find(step => step.status === 'running');
  return { current, issues, primary, acceptance, full, manual,
    status: manual ? '人工接管 · 只读总览' : state.running ? `正在${loopSubstageLabel(current?.subStage || '')}` : state.resumable ? '断点待恢复' : loopStageLabel(state.stage),
    focus: boundedText(activeStep?.desc || current?.goal || state.goal),
    steps: current ? `${current.orchestration.filter(step => step.status === 'done').length}/${current.orchestration.length} 步骤结束（不等于验收）` : '尚未执行',
  };
}
