import type { LoopDecision, LoopSourceSummary, MilestoneSummary } from '../types/loopContinuation';
import type { ExecutionEnvironment } from '../types/loopEnvironment';
import type { BlockerReview } from './loopTaskBlockers';
import { contractLabel, type ContractDiagnostic } from '../types/loopContract';

// 只投影执行端事实，不负责调度、权限判定或恢复。
export interface WorkbenchRecord {
  contractValidation?: ContractDiagnostic;
  seq: number; round: number; subStage: string; completed: boolean; error: string;
  goal?: string; resultPreview?: string; taskResult?: string; decision?: LoopDecision;
  blockerSummary?: BlockerReview;
  openspecSummary?: { phase: string; status: string; message: string; verified: boolean; fixes: number };
  orchestration: Array<{ index: number; desc: string; status: string }>;
  deliverySummary?: { mode?: string; counts?: Record<string, number>; blockerCount?: number;
    formal?: { total?: number; checked?: number }; milestones?: MilestoneSummary };
  analysisPreview?: { verified?: string; gaps?: string; nextFocus?: string };
}
export interface WorkbenchState {
  contractRepairActive?: boolean;
  iterationRequest?: IterationRequest;
  controlRevision?: number;
  sessionId: string; stage: string; goal: string; round: number; running: boolean; resumable: boolean;
  auto: boolean; controlMode?: string; stopReason: string; loops: WorkbenchRecord[];
  taskSource?: LoopSourceSummary; executionEnvironment?: ExecutionEnvironment;
  progressGuard?: { pause?: boolean; reason?: string; scopeLost?: boolean; needsReplan?: boolean;
    causeRef?: string; causeRevision?: number; round?: number; seq?: number };
  unresolvedBlockers?: { available?: boolean; count?: number };
  intentAlert?: { dismissed?: boolean; aligned?: boolean; divergence?: string; suggestion?: string; round?: number; seq?: number };
}
export interface IterationRequest {
  version: number; sessionId: string; round: number; seq: number; controlRevision: number;
  environmentRevision: number; sourceRevision: number; action: 'run' | 'resume';
  canRequest: boolean; reasonCode: string; message: string; recheckRequired?: boolean; basisRefs?: string[];
}
export type WorkbenchSection = 'process' | 'evidence' | 'goal' | 'source' | 'environment' | 'policy' | 'issues';
export interface IssueTarget { section: WorkbenchSection; sessionId: string; round: number; seq?: number; revision?: number; id: string; }
export interface WorkbenchIssue {
  id: string; priority: number; title: string; reason: string; next: string;
  section: WorkbenchSection; refs: string[];
  severity?: 'warning' | 'blocked'; effect?: 'local' | 'review' | 'paused'; affectedIds?: string[]; target?: IssueTarget;
}
export const loopStageLabel = (stage: string): string => ({ loopidea: '整理目标', loopexecute: '执行任务', loopout: '本轮结果' }[stage] || '状态待核对');
export const loopSubstageLabel = (stage: string): string => ({ prepare: '规划', execute: '执行', analysis: '核验', done: '本次已结束' }[stage] || '等待状态');
export const boundedText = (text?: string, limit = 220): string => text ? text.length > limit ? text.slice(0, limit) + '…' : text : '';

export function loopWorkbenchView(state: WorkbenchState, options: { readOnly?: boolean; controlPending?: boolean; controlError?: string; offline?: boolean } = {}) {
  const latest = state.loops.at(-1);
  const current = latest?.round === state.round ? latest : undefined;
  const issues: WorkbenchIssue[] = [];
  const add = (issue: WorkbenchIssue) => {
    const existing = issues.find(item => item.id === issue.id);
    if (existing) { existing.refs = [...new Set([...existing.refs, ...issue.refs])];
      existing.affectedIds = [...new Set([...(existing.affectedIds || []), ...(issue.affectedIds || [])])]; return; }
    issues.push(issue);
  };
  const source = state.taskSource;
  const sourceBad = source?.status && !['current', 'unbound'].includes(source.status);
  const sourceKey = `source:${state.sessionId}:${source?.executor || ''}:${source?.change || ''}:${source?.revision ?? 'unknown'}`;
  if (sourceBad) add({ id: sourceKey, priority: 20, title: '核对任务来源', reason: source.reason || '任务范围或来源需要核对',
    next: '核对范围差异；确认后不会自动运行。', section: 'source', refs: [sourceKey, `source:${source?.revision ?? 0}`] });
  const env = state.executionEnvironment;
  const checks = [...(env?.blockers || []), ...(env?.latest && (env.latest.status === 'blocked' || env.latest.quiesced === false) ? [env.latest] : [])];
  checks.forEach((check, index) => {
    const id = check.id ? `environment:${check.id}:${check.revision ?? env?.revision}` : `environment:unknown:${index}`;
    add({ id, priority: check.quiesced === false ? 1 : 10, title: check.quiesced === false ? '旧调用退出尚未确认' : '核对执行环境',
      reason: check.reason || '当前检查未取得可用证据', next: check.resumeCondition || '查看相同执行策略下的证据；不自动恢复。', section: 'environment', refs: [id], effect: 'paused',
      affectedIds: [({ prepare: '规划调用', execute: '执行调用', analysis: '核验调用' } as Record<string, string>)[check.role || ''] || '相关执行调用'] });
  });
  if (env?.incomplete) add({ id: `environment:incomplete:${env.revision}`, priority: 10, title: '环境证据不完整',
    reason: '不能据此解除已有阻塞。', next: '核对完整证据后显式恢复。', section: 'environment', refs: [], effect: 'paused' });
  const decision = current?.decision;
  const diagnostic = current?.contractValidation;
  const causalKey = decision?.causeRef && decision.causeRevision != null && decision.round === state.round && decision.seq === current?.seq
    ? `${decision.causeRef}:${decision.causeRevision}` : '';
  const contractCurrent = !!causalKey && diagnostic?.causeRef === decision?.causeRef && diagnostic?.causeRevision === decision?.causeRevision;
  let decisionIssueId = '';
  if (decision && (['wait', 'stop', 'retry'].includes(decision.action || '') && decision.reasonCode !== 'auto_off')) {
    // 仅当前轮的结构化来源原因可归入当前来源；自由文本相同不构成身份。
    const related = issues.find(issue => decision.round === state.round && decision.seq === current?.seq
      && (decision.basisRefs || []).some(ref => issue.refs.includes(ref))
      && (issue.section !== 'source' || decision.revision === source?.revision));
    const ref = `decision:${decision.decisionId || `${current?.seq}:${decision.revision ?? 'unknown'}`}`;
    decisionIssueId = related?.id || causalKey || ref;
    add({ id: decisionIssueId, priority: decision.reasonCode === 'call_active' ? 1 : 30,
      title: contractCurrent ? contractLabel(diagnostic) : decision.action === 'retry' ? '调用需要核对' : decision.action === 'stop' ? '本轮已停止' : '等待处理',
      reason: contractCurrent && diagnostic?.status === 'repaired' ? '协议映射已恢复一致，真实任务阻塞和验收要求仍保留。' : decision.reasonText || '执行端未提供具体原因',
      next: contractCurrent && diagnostic?.status === 'repaired' ? 'Auto 仍关闭。请另行使用原运行入口，执行端将重新核对所有边界。'
        : decision.resumeCondition || decision.nextStep || '查看执行端依据', section: 'evidence',
      refs: [ref, ...(causalKey ? [causalKey] : []), ...(decision.basisRefs || []).slice(0, 16), ...(contractCurrent ? diagnostic?.evidenceRefs || [] : [])],
      affectedIds: [...(decision.affectedIds || []), ...(contractCurrent ? diagnostic?.affectedIds || [] : [])] });
  }
  const guard = state.progressGuard;
  if (guard?.pause || guard?.scopeLost || guard?.needsReplan) {
    const ref = `guard:${state.round}:${current?.seq ?? 0}`;
    const sameCause = causalKey && guard.causeRef === decision?.causeRef && guard.causeRevision === decision?.causeRevision
      && guard.round === state.round && guard.seq === current?.seq;
    add({ id: sameCause ? decisionIssueId : ref,
      priority: 40, title: guard.pause ? '自动执行已暂停' : '下一轮需要调整', reason: guard.reason || (guard.scopeLost ? '任务范围需要核对' : '需要重新规划'),
      next: '成果已保留，尚未宣称完成。查看依据后显式继续。', section: 'evidence', refs: [ref] });
  }
  if (state.unresolvedBlockers?.available || (current?.deliverySummary?.blockerCount || 0) > 0 || current?.blockerSummary?.affectedIds?.length) {
    const ref = `tasks:${state.round}:${current?.seq ?? 0}`;
    add({ id: ref, priority: 50, title: '存在未解决任务阻塞', reason: '受影响任务及独立就绪任务需分别核对。',
      next: '局部阻塞不代表全部任务停止；查看任务与证据台账。', section: 'evidence', refs: [ref], effect: 'local', affectedIds: current?.blockerSummary?.affectedIds });
  }
  if (state.intentAlert && !state.intentAlert.dismissed && state.intentAlert.aligned === false) {
    add({ id: `intent:${state.intentAlert.round}:${state.intentAlert.seq}`, priority: 60, title: '目标方向需要关注',
      reason: state.intentAlert.divergence || '检测到方向偏差', next: state.intentAlert.suggestion || '核对原始想法和当前目标', section: 'goal', refs: ['intentAlert'] });
  }
  if (options.controlPending || options.controlError) add({ id: 'control', priority: 0, title: '控制权需要核对',
    reason: options.controlError || '正在等待控制权转交的确定结果', next: '使用共享控制状态核对，不重复提交。', section: 'issues', refs: ['control'] });
  issues.sort((a, b) => a.priority - b.priority);
  issues.forEach(issue => { issue.severity = issue.effect === 'local' ? 'warning' : 'blocked';
    issue.effect ??= 'review'; issue.target = { section: issue.section, sessionId: state.sessionId, round: state.round,
      seq: current?.seq, revision: issue.section === 'source' ? source?.revision : issue.section === 'environment' ? env?.revision : decision?.causeRevision ?? decision?.revision, id: issue.id }; });
  const manual = options.readOnly || state.controlMode === 'manual';
  const full = decision?.action === 'complete' && decision.completionScope === 'full' && current?.taskResult === 'verified';
  const acceptance = decision?.completionScope === 'automatic' ? '自动范围完成，待人工核验'
    : full && current?.openspecSummary ? '原任务完成，verify 无待修复问题'
    : full ? '执行端已确认完整验收' : current?.taskResult === 'blocked' ? '任务受阻，尚未完成'
    : current?.taskResult === 'implemented' ? '已实现，等待验收' : current?.taskResult === 'partial' ? '已有部分成果，尚未完成' : '尚未确认完整验收';
  const primary = manual ? 'manual' : options.controlPending || options.controlError ? 'check'
    : state.stage === 'loopout' ? 'continue' : state.running ? 'running' : state.stage === 'loopidea' ? 'seal'
    : state.resumable ? 'resume' : state.stage === 'loopexecute' ? 'run' : 'check';
  const request = state.iterationRequest;
  const requestCurrent = request?.version === 1 && request.sessionId === state.sessionId && request.round === state.round
    && request.seq === (latest?.seq || 0) && request.controlRevision === (state.controlRevision || 0)
    && request.environmentRevision === (env?.revision || 0) && request.sourceRevision === (source?.revision || 0);
  const requestReason = options.offline || options.controlError ? '当前连接或控制状态不可用，请核对连接；不会切换节点。'
    : state.contractRepairActive ? '任务映射修复或提交结果尚未确认，请查看原回执。'
    : options.controlPending ? '控制权处理中' : request && !requestCurrent ? '动作摘要已失效，请刷新当前状态。'
    : requestCurrent && !request!.canRequest ? request!.message
    : !request && (env?.checking || checks.some(check => check.quiesced === false)) ? '旧调用或检查退出尚未确认，请核对运行诊断。' : '';
  const activeStep = current?.orchestration.find(step => step.status === 'running');
  return { current, issues, primary, acceptance, full, manual, canRequest: !requestReason && !manual && !state.running,
    requestReason, requestCompatibility: !request ? '旧端未提供动作摘要；请求仍由执行端核验。' : '',
    status: manual ? '人工接管 · 只读总览' : state.running ? diagnostic?.status === 'retrying' ? contractLabel(diagnostic) : `正在${loopSubstageLabel(current?.subStage || '')}` : state.resumable ? '断点待恢复' : loopStageLabel(state.stage),
    focus: boundedText(activeStep?.desc || current?.goal || state.goal),
    steps: current ? `${current.orchestration.filter(step => step.status === 'done').length}/${current.orchestration.length} 步骤结束（不等于验收）` : '尚未执行',
  };
}
