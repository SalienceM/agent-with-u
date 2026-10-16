// 合成值夹具：不读取 Session，不连接网络，不调用模型或文件系统。
const base = () => ({ sessionId: 'synthetic-loop', stage: 'loopexecute', goal: '交付可验证的工作台', round: 1,
  running: false, resumable: false, auto: false, stopReason: '', loops: [],
  ideas: [], goalHistory: [], addons: [], asides: [], bestScore: 99, latestScore: 99, riskCoefficient: 0, maxLoops: 10, effectiveMaxLoops: 10, roundLoopCount: 0, status: 'active' });
const record = () => ({ seq: 1, round: 1, subStage: 'execute', completed: false, error: '', goal: '验证界面', result: '', analysis: null,
  orchestration: [{ index: 1, status: 'running', mode: 'sequential', desc: '检查实现', output: '' }] });
const states = () => ({
  idea: { ...base(), stage: 'loopidea' }, idle: base(),
  running: { ...base(), running: true, auto: true, loops: [record()] },
  resumable: { ...base(), resumable: true, loops: [record()] },
  multi: { ...base(), taskSource: { status: 'conflict', revision: 4, change: 'fixture' },
    executionEnvironment: { revision: 1, status: 'blocked', latest: { id: 'env-1', status: 'blocked', quiesced: false } },
    unresolvedBlockers: { available: true, count: 2 }, loops: [{ ...record(), decision: { action: 'wait', reasonCode: 'scope_conflict', decisionId: 'd1', round: 1, seq: 1, revision: 4, basisRefs: ['source:4'] } }] },
  result: { ...base(), stage: 'loopout', stopReason: '预算耗尽', loops: [{ ...record(), completed: true, taskResult: 'partial', decision: { action: 'stop', reasonCode: 'budget_exhausted' } }] },
  manual: { ...base(), controlMode: 'manual' }, legacy: { ...base(), loops: [record()] },
  human: { ...base(), stage: 'loopout', loops: [{ ...record(), taskResult: 'verified', decision: { action: 'complete', completionScope: 'automatic' } }] },
});
const migrations = { 'panel|flow': '过程与历史', StageRail: '中文状态', MetricBar: '成果与证据', ScoreRing: '评审详情',
  LoopSourceCard: '任务设置', LoopEnvironmentCard: '任务设置', PolicyCard: '任务设置', AddonHistoryCard: '目标与补充' };
const environmentStates = () => {
  const check = { id: 'probe', revision: 3, status: 'unsupported', coverage: 'native_policy', quiesced: true };
  const state = (environment) => ({ ...base(), resumable: true, loops: [record()], executionEnvironment: { revision: 3, blockers: [], ...environment } });
  return {
    unsupported: state({ status: 'unsupported', latest: check }),
    stale: state({ status: 'stale', latest: { ...check, status: 'stale' } }),
    actualFault: state({ status: 'blocked', latest: { ...check, status: 'passed' }, blockers: [{ ...check, id: 'fault', status: 'blocked', coverage: 'actual_tool' }] }),
    incomplete: state({ status: 'unknown', incomplete: true }),
    unconfirmed: state({ status: 'unsupported', latest: { ...check, quiesced: false } }),
    local: { ...base(), loops: [{ ...record(), blockerSummary: { valid: true, readyIds: ['U'], affectedIds: ['T'] } }], unresolvedBlockers: { available: true } },
    source: { ...base(), taskSource: { status: 'conflict', revision: 4 } },
    paused: { ...base(), progressGuard: { pause: true, reason: '显式恢复后核对' } },
    legacy: base(),
  };
};
const restored = ['StageRail', 'panel|flow', 'MetricBar', 'ScoreRing', 'FlowLane', 'Addon', 'Policy', 'Goal'];
module.exports = { base, record, states, migrations, environmentStates, restored };
