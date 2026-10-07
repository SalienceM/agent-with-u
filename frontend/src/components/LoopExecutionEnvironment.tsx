import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EnvironmentCheck, EnvironmentResponse, ExecutionEnvironment, WorkflowReference } from '../types/loopEnvironment';

const box: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 8, padding: 10,
  marginBottom: 10, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere', minWidth: 0,
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)' };
const button: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 6, padding: '5px 9px',
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer', maxWidth: '100%' };
const labels = { unknown: '未知', checking: '检查中', passed: '对应检查项通过', blocked: '受阻', unsupported: '不支持或覆盖不足', stale: '证据已失效' };
const coverage = { host_discovery: '仅宿主发现', native_policy: '原生策略内检查（部分覆盖）', actual_tool: '实际工具事件' };

export const EnvironmentEvidence: React.FC<{ check?: Partial<EnvironmentCheck> }> = ({ check }) => <div>
  {!check?.id ? <div>旧记录或尚未检查：环境未知。</div> : <>
    <div>{check.backendId || 'Backend 未知'} · {check.role} · 自动权限 {check.access || '未知'} · {check.transport}</div>
    <div>{labels[check.status || 'unknown']} · {coverage[check.coverage || 'host_discovery']}
      {check.runnerVersion && <> · CLI {check.runnerVersion}</>}</div>
    {!!check.checkedAt && <div>核对时间：{new Date(check.checkedAt * 1000).toLocaleString()}</div>}
    {check.dependencyId && <div>依赖：{check.dependencyId}</div>}
    {check.reason && <div>{check.reason}</div>}
    {check.resumeCondition && <div>解除条件：{check.resumeCondition}</div>}
    {check.quiesced === false && <div>旧调用退出尚未确认；不能启动新的写调用。</div>}
    {check.incomplete && <div>检查不完整，不能作为恢复依据。</div>}
    {check.entry && <div>本次核对入口：{check.entry}</div>}
  </>}
</div>;

export const LoopEnvironmentCard: React.FC<{ sessionId: string; execKey?: string; environment?: ExecutionEnvironment;
  readOnly: boolean; resumable?: boolean }> = ({ sessionId, execKey, environment, readOnly, resumable }) => {
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
  return <section style={box} data-testid="loop-environment-card" aria-label="LOOP 执行环境">
    <strong>执行环境 · {labels[value?.status || 'unknown']}</strong>
    {value?.incomplete && <div>证据记录不完整，不能据此解除阻塞。</div>}
    <EnvironmentEvidence check={value?.latest} />
    {value?.blockers?.filter(item => item.id !== value.latest?.id).map(item => <details key={item.id}>
      <summary>保留阻塞 · {item.role} · {item.reasonCode}</summary><EnvironmentEvidence check={item} /></details>)}
    <div>工作流依赖：{value?.workflowRef?.command || '未选择（通用 LOOP 不强制依赖 OpenSpec）'}</div>
    <div style={{ color: 'var(--theme-text-muted)' }}>人工权限可能不同；人工成功不能证明自动受限路径可用。检查通过不等于任务完成。</div>
    {readOnly ? <div>当前只读：运行、检查或人工接管期间不能检查、选择依赖。</div> : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      <button style={button} disabled={busy} onClick={() => void run(() => api.loopExecutionEnvironmentCheck(sessionId, value?.revision || 0, execKey), true)}>重新检查环境</button>
      <button style={button} disabled={busy} onClick={() => void run(() => api.loopExecutionEnvironmentGet(sessionId, execKey))}>查看详情与工作流选项</button>
    </div>}
    {!readOnly && choices && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      <select style={button} aria-label="工作流依赖" disabled={busy || resumable} value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">通用模式（不选择工作流）</option>
        {choices.map(item => <option key={item.command} value={item.command}>{item.command}</option>)}
      </select>
      <button style={button} disabled={busy || resumable} onClick={choose}>确认依赖选择</button>
      <div>选择不绑定 change、不执行工作流；可恢复记录须先处理，再改变依赖。</div>
    </div>}
    {busy && <div role="status">正在进行有界检查或读取；不会发送任务模型请求。</div>}
    {message && <div role="status">{message}</div>}
  </section>;
};
