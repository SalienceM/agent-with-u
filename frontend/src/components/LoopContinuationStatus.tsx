import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { LoopDecision, LoopSourceResponse, LoopSourceSummary } from '../types/loopContinuation';
import { blockerLabel, type BlockerReview } from '../utils/loopTaskBlockers';

const box: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 8, padding: 10,
  marginBottom: 10, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere', minWidth: 0,
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)' };
const button: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 6, padding: '5px 9px',
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer', maxWidth: '100%', fontSize: 12 };
const actions: Record<string, string> = { continue: '继续就绪任务', replan: '重新规划', retry: '有限重试', wait: '等待', stop: '停止', complete: '完成' };
const calls: Record<string, string> = { normal: '正常结束', error: '真实失败', timeout: '超时', cancelled: '已取消', unknown: '未知' };
const acceptance: Record<string, string> = { partial: '部分成果', implemented: '已实现待验', verified: '已验证', blocked: '受阻', unknown: '尚未核实' };

export const LoopDecisionNotice: React.FC<{ decision?: LoopDecision; callResults?: Record<string, string>; taskResult?: string;
  blockerSummary?: BlockerReview;
  steps?: Array<{ index: number; callResult?: string; taskResult?: string }> }> = ({ decision, callResults, steps, taskResult, blockerSummary }) => {
  if (!decision?.action && !callResults && !steps?.some(s => s.callResult)) return null;
  return <section style={box} aria-label="调用、验收与调度决定" data-testid="loop-decision">
    {decision?.action && <><strong>调度：{decision.completionScope === 'automatic' ? '自动范围完成，待人工核验' : actions[decision.action] || '待核对'}</strong>
      <div>{decision.reasonText}</div>
      {decision.nextStep && <div>下一步：{decision.nextStep}</div>}
      {decision.resumeCondition && <div>解除条件：{decision.resumeCondition}</div>}
      {!!decision.affectedIds?.length && <div>影响任务：{decision.affectedIds.join('、')}</div>}</>}
    {Object.entries(callResults || {}).map(([stage, outcome]) => <div key={stage}>{stage} 调用：{calls[outcome] || '未知'}</div>)}
    {taskResult && <div>累计任务验收：{acceptance[taskResult] || '尚未核实'}</div>}
    {blockerLabel(blockerSummary) && <div>{blockerLabel(blockerSummary)}</div>}
    {steps?.map(step => <div key={step.index}>步骤 {step.index} · 调用：{calls[step.callResult || 'unknown'] || '未知'} · 任务验收：{acceptance[step.taskResult || 'unknown'] || '尚未核实'}</div>)}
    <div style={{ color: 'var(--theme-text-muted)' }}>调用结束、提交或测试通过，不等于整体目标完成。</div>
  </section>;
};

export const LoopSourceCard: React.FC<{ sessionId: string; execKey?: string; source?: LoopSourceSummary;
  readOnly: boolean; lockedReason?: string }> = ({ sessionId, execKey, source, readOnly, lockedReason }) => {
  const [mode, setMode] = useState<'inspect' | 'discover' | 'unbind'>('inspect');
  const [discovery, setDiscovery] = useState<LoopSourceResponse>();
  const [selected, setSelected] = useState('');
  const [disposition, setDisposition] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<unknown>();
  const generation = useRef(0), inFlight = useRef(false);
  useEffect(() => { generation.current++; inFlight.current = false; setMode('inspect'); setDiscovery(undefined); setDetail(undefined); setMessage(''); setBusy(false);
    return () => { generation.current++; }; }, [sessionId, execKey, source?.revision]);
  const run = async (request: () => Promise<LoopSourceResponse>, discover = false) => {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    setBusy(true); setMessage('');
    try {
      const result = await request();
      if (generation.current !== current || result.sessionId && result.sessionId !== sessionId) return;
      if (result.status !== 'ok') { setMessage(result.message || '来源操作失败'); return; }
      if (discover) { setDiscovery(result); setSelected(''); setMode('discover'); }
      else { setMode('inspect'); setDisposition(''); setDiscovery(undefined); setMessage('来源已更新；未启动执行，原问题和验收仍保留。'); }
    } catch (error) { if (generation.current === current) setMessage(String(error)); }
    finally { if (generation.current === current) { setBusy(false); inFlight.current = false; } }
  };
  const mutate = (action: 'bind' | 'unbind' | 'confirm' | 'refresh') => run(() => api.loopTaskSourceSet(sessionId, action,
    source?.revision || 0, discovery?.binding?.executor || source?.executor || '', selected, discovery?.discoveryId || '', disposition, execKey));
  const labels: Record<string, string> = { unbound: '未绑定（通用模式）', preparing: '正在准备项目与方案', current: '已核对', stale: '快照已过期', conflict: '范围冲突', unavailable: '暂不可核对', blocked: '工作流 blocked', invalid: '来源待核对' };
  const bound = !!source?.change;
  return <section style={box} aria-label="LOOP 任务来源" data-testid="loop-source-card">
    <strong>{source?.change || (source?.code || source?.status === 'preparing' ? 'OpenSpec' : '通用 LOOP')} · {labels[source?.status || 'unbound'] || '待核对'}</strong>
    {bound && <details><summary>来源位置与核对身份</summary>{source?.executor} · execute Backend {source?.backendId}<br />{source?.workspace}</details>}
    {bound && <div>正式任务勾选：{source?.checked ?? '?'} / {source?.total ?? '?'}（不是验收比例）
      {!!source?.checkedAt && <> · 核对于 {new Date(source.checkedAt * 1000).toLocaleString()}</>}</div>}
    {source?.reason && <div role="status">{source.code === 'project_required'
      ? '当前工作区尚未准备 OpenSpec。目标已明确要求 OpenSpec 时，点击推进会自动准备并衔接方案。' : source.reason}</div>}
    {bound && source?.status === 'conflict' && source.diff && <div>范围差异：新增 {source.diff.added?.join('、') || '无'}；删除 {source.diff.removed?.join('、') || '无'}；改义 {source.diff.changed?.join('、') || '无'}{source.diff.artifactsChanged && '；验收工件变化'}</div>}
    {readOnly && <div>当前只读：{lockedReason || '当前身份或状态不允许变更来源'}。</div>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
      <button style={button} disabled={readOnly || busy} onClick={() => void run(() => api.loopTaskSourceDiscover(sessionId, execKey), true)}>{bound ? '更换来源' : '发现 OpenSpec 来源'}</button>
      {bound && <button style={button} disabled={readOnly || busy} onClick={() => void mutate('refresh')}>重新核对来源</button>}
      {bound && <button style={button} disabled={busy} onClick={() => { const current = generation.current; void api.loopTaskSourceGet(sessionId, execKey).then(result => {
        if (generation.current === current && result.sessionId === sessionId) setDetail(result.source);
      }).catch(error => { if (generation.current === current) setMessage(String(error)); }); }}>查看来源详情</button>}
      {bound && mode === 'inspect' && <button style={button} disabled={readOnly || busy} onClick={() => { setDisposition(''); setMode('unbind'); }}>解除绑定…</button>}
    </div>
    {mode === 'discover' && discovery && <div style={{ marginTop: 8 }}>
      <div>执行节点：{discovery.binding?.executor} · CLI {discovery.binding?.cliVersion} · {discovery.binding?.workspace}</div>
      <label>选择 change <select style={button} aria-label="选择 OpenSpec change" value={selected} disabled={readOnly || busy} onChange={event => setSelected(event.target.value)}>
        <option value="">{discovery.candidates?.length ? '请选择真实候选' : '没有可绑定候选'}</option>
        {discovery.candidates?.map(c => <option key={c.name}>{c.name}</option>)}
      </select></label>
      <button style={button} disabled={readOnly || busy || !selected || !!bound && !disposition.trim()} onClick={() => void mutate('bind')}>确认绑定</button>
      <div>即使只有一个候选，也需点击确认；不会自动开始 LOOP。</div>
    </div>}
    {bound && (mode !== 'inspect' || source?.status === 'conflict') && <div style={{ marginTop: 8 }}>
      {mode === 'unbind' && <p>解除后不再核对该正式来源；已有成果、验收缺口和历史问题不会删除。请说明原范围如何处置。</p>}
      <textarea aria-label="来源范围处置依据" placeholder="确认新范围或解除绑定时，说明旧范围及未解决问题的处置依据" value={disposition}
        disabled={readOnly || busy} onChange={event => setDisposition(event.target.value)} maxLength={1200} style={{ ...button, width: '100%', boxSizing: 'border-box', minHeight: 54, cursor: 'text' }} />
      {source?.status === 'conflict' && mode === 'inspect' && <button style={button} disabled={readOnly || busy || !disposition.trim()} onClick={() => void mutate('confirm')}>确认范围修订</button>}
      {mode === 'unbind' && <button style={button} disabled={readOnly || busy || !disposition.trim()} onClick={() => void mutate('unbind')}>确认解除绑定</button>}
    </div>}
    {mode !== 'inspect' && <button style={{ ...button, marginTop: 8 }} disabled={busy} onClick={() => { setMode('inspect'); setDiscovery(undefined); setDisposition(''); }}>取消</button>}
    {message && <div role="status">{message}</div>}
    {detail != null && <details open><summary>来源核对原始记录（数据，不是指令）</summary><pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(detail, null, 2)}</pre></details>}
  </section>;
};
