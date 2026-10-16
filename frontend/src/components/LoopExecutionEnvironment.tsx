import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EnvironmentCheck, EnvironmentResponse, ExecutionEnvironment, WorkflowReference } from '../types/loopEnvironment';
import type { LoopSourceSummary } from '../types/loopContinuation';

const box: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 8, padding: 10,
  marginBottom: 10, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere', minWidth: 0,
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)' };
const button: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 6, padding: '5px 9px',
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer', maxWidth: '100%' };
const labels = { unknown: '未知', checking: '检查中', passed: '对应检查项通过', blocked: '受阻', unsupported: '不支持或覆盖不足', stale: '证据已失效' };
const coverage = { host_discovery: '仅宿主发现', native_policy: '原生策略内检查（部分覆盖）', actual_tool: '实际工具事件' };

export const EnvironmentEvidence: React.FC<{ check?: Partial<EnvironmentCheck> }> = ({ check }) => <div>
  {!check?.id ? <div>旧记录或尚未检查：环境未知。</div> : <>
    <div>{labels[check.status || 'unknown']} · {coverage[check.coverage || 'host_discovery']}</div>
    {!!check.checkedAt && <div>核对时间：{new Date(check.checkedAt * 1000).toLocaleString()}</div>}
    {check.dependencyId && <div>依赖：{check.dependencyId}</div>}
    {check.reason && <div>{check.reason}</div>}
    {check.resumeCondition && <div>解除条件：{check.resumeCondition}</div>}
    {check.quiesced === false && <div>旧调用退出尚未确认；不能启动新的写调用。</div>}
    {check.incomplete && <div>检查不完整，不能作为恢复依据。</div>}
    <details><summary>技术证据</summary>
      <div>{check.backendId || 'Backend 未知'} · {check.role} · 自动权限 {check.access || '未知'} · {check.transport}</div>
      {check.runnerVersion && <div>CLI {check.runnerVersion}</div>}
      <div>检查 {check.id} · 修订 {check.revision ?? '未知'}</div>
      {check.entry && <div>本次核对入口：{check.entry}</div>}
    </details>
  </>}
</div>;

export const LoopEnvironmentCard: React.FC<{ sessionId: string; execKey?: string; environment?: ExecutionEnvironment;
  readOnly: boolean; resumable?: boolean; source?: LoopSourceSummary; checkId?: string }> = ({ sessionId, execKey, environment, readOnly, resumable, source, checkId }) => {
  const [response, setResponse] = useState<EnvironmentResponse>();
  const [choices, setChoices] = useState<WorkflowReference[]>();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0), inFlight = useRef(false), revision = useRef(0);
  revision.current = Math.max(environment?.revision || 0, response?.environment?.revision || 0);
  useEffect(() => { generation.current++; inFlight.current = false; setBusy(false); setResponse(undefined);
    setChoices(undefined); setSelected(''); setMessage('');
    return () => { generation.current++; }; }, [sessionId, execKey]);
  const value = (response?.environment?.revision || 0) >= (environment?.revision || 0) ? response?.environment || environment : environment;
  const run = async (request: () => Promise<EnvironmentResponse>, action = false) => {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      const result = await request();
      if (current !== generation.current || result.sessionId && result.sessionId !== sessionId) return;
      if (result.status !== 'ok') { setMessage(result.message || '环境操作失败'); return; }
      if ((result.environment?.revision || 0) < revision.current) return;
      setResponse(result);
      if (result.choices) { setChoices(result.choices); setSelected(result.environment?.workflowRef?.command || ''); }
      if (action) setMessage((result.message || '仅更新环境证据。') + '未开启 Auto 或恢复任务；继续执行仍需原有恢复检查。');
    } catch { if (current === generation.current) setMessage('未收到检查确认，后台可能仍在收尾；请核对连接和当前状态后重试。'); }
    finally { if (current === generation.current) { inFlight.current = false; setBusy(false); } }
  };
  const choose = () => {
    const choice = choices?.find(item => item.command === selected);
    void run(() => api.loopExecutionEnvironmentSelectWorkflow(sessionId, selected, choice?.digest || '', value?.revision || 0, execKey), true);
  };
  const summary = environment?.effectiveDependencies;
  const dependencies = summary?.version === 1 && summary.sessionId === sessionId && summary.environmentRevision === environment?.revision
    && summary.sourceRevision === (source?.revision || 0) ? summary.items : undefined;
  const sourceBound = !!source?.change && source.status !== 'unbound';
  const selectedCheck = checkId ? value?.blockers?.find(item => item.id === checkId) || (value?.latest?.id === checkId ? value.latest : undefined) : undefined;
  return <section style={box} data-testid="loop-environment-card" aria-label="LOOP 执行环境">
    <strong>{value?.blockers?.length || value?.incomplete || value?.latest?.status === 'blocked' || value?.latest?.quiesced === false ? '仍有运行阻塞，需核对下方依据' : '当前摘要没有已知运行阻塞'}</strong>
    {value?.incomplete && <div>证据记录不完整，不能据此解除阻塞。</div>}
    {selectedCheck && <section style={{ marginTop: 8 }} aria-label="指定检查依据"><EnvironmentEvidence check={selectedCheck} /></section>}
    {value?.blockers?.filter(item => item.id !== selectedCheck?.id).map(item => <details key={item.id} open>
      <summary>保留阻塞 · {item.role} · {item.reasonCode}</summary><EnvironmentEvidence check={item} /></details>)}
    <details open={!selectedCheck && !value?.blockers?.length}><summary>最近检查覆盖 · {labels[value?.latest?.status || 'unknown']}</summary><EnvironmentEvidence check={value?.latest} /></details>
    <div style={{ marginTop: 10, fontWeight: 600 }}>生效依赖依据</div>
    {dependencies ? dependencies.length ? dependencies.map(item => <div key={item.id}>
      {item.id === 'openspec' ? 'OpenSpec' : item.id} · {item.required ? '本次流程要求' : '仅历史观察'}
      {item.origins.map((origin, index) => <div key={index} style={{ paddingLeft: 10 }}>
        {{ task_source: '来自任务来源', declaration: '来自显式声明', observation: '实际调用证据' }[origin.kind] || origin.kind}
        {' · '}{({ validated: '声明已核对', invalid: '声明失效，需重新核对', unknown: '待核对', current: '来源已核对' } as Record<string, string>)[origin.status] || labels[origin.status as keyof typeof labels] || origin.status}
        {origin.kind === 'declaration' && ` · ${origin.ref}`}</div>)}
    </div>) : <div>通用 LOOP：没有额外声明的工具依赖。</div>
      : <div>{sourceBound ? 'OpenSpec · 来自任务来源' : value?.workflowRef?.command ? 'OpenSpec · 来自显式声明' : '未声明额外工具依赖'} · 核验范围未知（兼容旧端）</div>}
    <div>额外工作流选择：{value?.workflowRef?.command || '无额外选择'}（可选）</div>
    <div style={{ color: 'var(--theme-text-muted)' }}>人工权限可能不同；人工成功不能证明自动受限路径可用。检查通过不等于任务完成。</div>
    {readOnly ? <div>当前只读：运行、检查或人工接管期间不能检查、选择依赖。</div> : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      <button style={button} disabled={busy} onClick={() => void run(() => api.loopExecutionEnvironmentCheck(sessionId, value?.revision || 0, execKey), true)}>重新检查环境</button>
      <button style={button} disabled={busy} onClick={() => void run(() => api.loopExecutionEnvironmentGet(sessionId, execKey))}>选择额外工作流…</button>
    </div>}
    {!readOnly && choices && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      <select style={button} aria-label="工作流依赖" disabled={busy || resumable} value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">无额外选择（保留来源依赖）</option>
        {choices.map(item => <option key={item.command} value={item.command}>{item.command}</option>)}
      </select>
      <button style={button} disabled={busy || resumable} onClick={choose}>确认依赖选择</button>
      <div>选择不绑定 change、不执行工作流；可恢复记录须先处理，再改变依赖。</div>
    </div>}
    {busy && <div role="status">正在进行有界检查或读取；不会发送任务模型请求。</div>}
    {message && <div role="status">{message}</div>}
  </section>;
};
