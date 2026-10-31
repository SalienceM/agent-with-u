import { activeLoopSeq, type CallDiagnostic } from './loopDiagnostics';
import type { AimeinRun, AimeinSummary } from '../types/aimein';
import { goalObservation } from './aimeinWorld';
import { readCollection, type AimeinDataState } from './aimeinRecordData';

interface RuntimeRecord {
  aimeinData?: AimeinDataState;
  detailLoaded?: boolean;
  seq: number; round: number; subStage: string; completed: boolean; error: string; kind?: string; goal?: string; createdAt?: number;
  aimeinRun?: AimeinRun; aimeinSummary?: Pick<AimeinSummary, 'status' | 'message'>;
  orchestration: Array<{ index: number; desc: string; status: string; output: string }>;
  stageDetails?: Record<string, { status?: string; rawOutput?: string; partialOutput?: string }>;
  callDiagnostics?: CallDiagnostic[]; decision?: { reasonText?: string };
}
interface RuntimeState {
  loops: RuntimeRecord[]; running: boolean; round: number; goal: string; resumable: boolean; stopReason?: string;
  startup?: { status: string; message?: string };
}

export const AIMEIN_OUTPUT_LIMIT = 50_000;
export const aimeinRecords = <T extends RuntimeRecord,>(state: { loops: T[] }) => state.loops.filter(record => record.kind !== 'manual');
export const aimeinCurrent = <T extends RuntimeRecord,>(state: { loops: T[] }, selected?: T) => selected || aimeinRecords(state).at(-1);

export function aimeinObservation(state: RuntimeState, record: RuntimeRecord | undefined, connected = true) {
  const runtime = aimeinRuntime(state, record, {}, connected);
  const collection = readCollection(record?.orchestration);
  const steps = collection.items;
  const stepState = record?.aimeinData?.collections.orchestration || collection.state;
  const saved = steps.filter(step => step.status === 'done' && !!step.output?.trim()).length;
  const failed = steps.filter(step => step.status === 'error').length;
  const waiting = runtime.activeCalls.every(call => !['tools', 'text', 'thinking', 'running', 'local_prepare', 'environment_check'].includes(call.phase));
  const health = !connected ? 'offline' : runtime.historical ? 'history' : runtime.error || failed ? 'attention' : runtime.live ? waiting ? 'waiting' : 'working' : 'idle';
  return { saved, savedKnown: record?.detailLoaded !== false && ['ready', 'empty'].includes(stepState), total: steps.length, stepState, failed, coverage: goalObservation(record), health,
    current: runtime.live ? steps.filter(step => step.status === 'running').map(step => step.desc).join(' · ') || runtime.title : runtime.title,
    issue: runtime.error || (failed ? `${failed} 个执行步骤失败，查看输出后处理。` : ''),
    measurement: '性能 / 效率：未测量' };
}

export function aimeinStageLabel(stage: string, record?: RuntimeRecord): string {
  if (stage === 'prepare') return record?.stageDetails?.openspecSetup ? 'OpenSpec 准备' : '阶段准备';
  if (stage === 'aimein-plan') return '目标拆解';
  if (stage === 'aimein-prepare') return '步骤编排';
  if (stage.startsWith('aimein-review')) return `评委 ${stage.replace('aimein-review', '')}`;
  if (stage.startsWith('step')) return readCollection(record?.orchestration).items.find(step => `step${step.index}` === stage)?.desc || `执行步骤 ${stage.slice(4)}`;
  return ({ execute: '建设执行', analysis: '成果核验', done: '本次结束', 'openspec-verify': 'OpenSpec 验证' } as Record<string, string>)[stage] || stage;
}

export interface AimeinOutputChannel {
  id: string; label: string; text: string; truncated: boolean; active: boolean;
  status: string; call?: CallDiagnostic;
}

/** 输出只按尝试和阶段归属，不从未完成的 JSON 流推断计划或验收。 */
export function aimeinRuntime(state: RuntimeState, record: RuntimeRecord | undefined, progress: Record<string, string>, connected = true) {
  const latest = state.loops.at(-1);
  const historical = !!record && record.seq !== latest?.seq;
  const live = connected && !!record && activeLoopSeq(state) === record.seq;
  const calls = record?.callDiagnostics || [];
  const activeCalls = live ? calls.filter(call => call.status === 'running') : [];
  const keys = new Set<string>();
  const details = record?.stageDetails || {};
  const steps = readCollection(record?.orchestration).items;
  Object.keys(details).filter(key => key !== 'openspecSetup').forEach(key => keys.add(key));
  calls.forEach(call => keys.add(call.stage));
  Object.keys(progress).filter(key => record && key.startsWith(`${record.seq}:`)).forEach(key => keys.add(key.slice(key.indexOf(':') + 1)));
  steps.forEach(step => keys.add(`step${step.index}`));
  if (!keys.size && record) keys.add(record.subStage || 'prepare');
  const channels: AimeinOutputChannel[] = [...keys].map(id => {
    const call = calls.filter(item => item.stage === id).at(-1);
    const step = steps.find(item => `step${item.index}` === id);
    const saved = details[id]?.rawOutput || details[id]?.partialOutput || step?.output || '';
    const stream = progress[`${record?.seq}:${id}`] || '';
    const active = live && (call?.status === 'running' || step?.status === 'running');
    const unfinished = !record?.completed && (call?.status === 'running' || step?.status === 'running');
    const text = unfinished ? stream || saved : saved || stream;
    return { id, label: aimeinStageLabel(id, record), text: text.slice(-AIMEIN_OUTPUT_LIMIT),
      truncated: text.length >= AIMEIN_OUTPUT_LIMIT, active, call,
      status: active ? 'running' : call?.status === 'running' || step?.status === 'running' ? 'unconfirmed' : call?.status || step?.status || details[id]?.status || 'pending' };
  });
  const currentCall = activeCalls.at(-1);
  const channel = channels.find(item => item.id === currentCall?.stage) || channels.find(item => item.active)
    || channels.find(item => item.id === calls.at(-1)?.stage) || channels.filter(item => item.text).at(-1) || channels.at(-1);
  const error = record?.error || (['blocked', 'needs_attention', 'stale', 'repair'].includes(record?.aimeinSummary?.status || '') ? record?.aimeinSummary?.message : '') || '';
  const phase = currentCall?.stage || (record?.aimeinSummary?.status === 'planning' ? 'aimein-plan' : record?.subStage || 'prepare');
  const title = !connected ? '连接中断 · 状态待核对' : historical ? `历史尝试 #${record!.seq}` : error ? '需要处理'
    : state.startup?.status === 'running' ? '工作区准备' : live ? aimeinStageLabel(phase, record)
      : record?.completed ? '本次执行已结束' : state.resumable ? '等待继续' : '工坊待命';
  return { historical, live, activeCalls, channels, channel, phase, title, error,
    startedAt: currentCall?.startedAt || record?.createdAt,
    goal: record?.aimeinRun?.goal || record?.goal || (!historical ? state.goal : ''),
    message: error || (!connected ? '已保留收到的输出；连接恢复后核对当前状态。'
      : historical ? '这里展示当时保存的记录。' : state.startup?.status === 'running' ? state.startup.message
        : live ? currentCall ? '' : '执行已接收，等待当前阶段的首个事件。'
          : record?.decision?.reasonText || state.stopReason || '') };
}
