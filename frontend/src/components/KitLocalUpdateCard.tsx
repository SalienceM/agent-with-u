import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { KitRun, KitStepRun, KitCapabilityRuntime } from '../types/workspaceKits';

const phases: Record<string, string> = {
  preparing: '核对执行设备', staging: '下载并校验本次制品', needs_selection: '请选择安装器',
  waiting_approval: '等待独立安装确认', handing_off: '正在交接安装', waiting_restart: '等待目标节点重启',
  verifying: '核对实际启动版本', result_unknown: '安装结果未知', failed: '本机更新失败', succeeded: '重启验收通过', cancelled: '交接前已取消',
};

export const KitLocalUpdateCard: React.FC<{
  sessionId: string; run: KitRun; step: KitStepRun; responding: boolean; onRespond: (approved: boolean) => void;
}> = ({ sessionId, run, step, responding, onRespond }) => {
  const runtime = (step.config.capabilityRuntime || {}) as KitCapabilityRuntime;
  const plan = runtime.plan || {};
  const phase = String(runtime.phase || step.status);
  const handed = ['handing_off', 'waiting_restart', 'verifying', 'result_unknown'].includes(phase);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const live = useRef(true);
  const selection = useRef<{ fingerprint: string; artifact: string; request: string }>();
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const act = async (artifact?: string) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      if (artifact) {
        const fp = String(runtime.planFingerprint || '');
        if (!selection.current || selection.current.fingerprint !== fp) selection.current = { fingerprint: fp, artifact, request: crypto.randomUUID() };
        if (selection.current.artifact !== artifact) throw new Error('已有选择请求结果待核对，请勿重复提交其他制品');
        const result = await api.kitUpdateSelect(sessionId, run.id, artifact, fp, selection.current.request);
        if (!['ok', 'accepted'].includes(result.status)) throw new Error(result.message || '制品选择未被接受');
        if (live.current) setNotice('选择已提交，等待执行端下载校验');
      } else {
        const result = await api.kitUpdateReconcile(sessionId, run.id);
        if (result.status !== 'ok') throw new Error(result.message || '核对未完成');
        if (live.current) setNotice('已读取原请求结果，没有重新安装');
      }
    } catch (error) {
      if (live.current) setNotice(String(error instanceof Error ? error.message : error));
    } finally { if (live.current) setBusy(false); }
  };
  const artifact = plan.artifact;
  return <section aria-label="本机更新安装计划" style={{ marginTop: 10, padding: 13, borderRadius: 10,
    border: '1px solid var(--theme-border)', background: 'var(--theme-panel-bg, #1b2230)', overflowWrap: 'anywhere' }}>
    <strong>本机更新 · {phases[phase] || phase}</strong>
    <p>目标是 Session 执行设备，不是当前控制窗口。发布与安装分别确认。</p>
    <div>设备：{String(plan.desktop?.deviceId || plan.device || '核对中')} · 安装实例：{String(plan.desktop?.instanceId || plan.instanceId || '—')}</div>
    <div>当前：{String(plan.current?.version || '—')} / {String(plan.current?.buildId || '—')}</div>
    <div>目标：{String(plan.release?.version || '—')} / {String(plan.release?.buildId || '—')} · 序号 {String(plan.release?.sequence || '—')}</div>
    <div>通道：{String(plan.channel || '—')} · 计划指纹：{runtime.planFingerprint || '准备中'}</div>
    {artifact && <div style={{ marginTop: 8 }}>
      <div>{String(artifact.fileName || artifact.id)} · {String(artifact.platform)} / {String(artifact.arch)} · {Number(artifact.size).toLocaleString()} 字节</div>
      <div>SHA-256：{String(artifact.sha256)}</div>
    </div>}
    {phase === 'needs_selection' && plan.artifacts?.map(item => <button key={String(item.id)} disabled={busy || responding}
      onClick={() => void act(String(item.id))} style={{ display: 'block', marginTop: 8, maxWidth: '100%', whiteSpace: 'normal' }}>
      选择 {String(item.fileName || item.id)} · {String(item.kind)} · {Number(item.size).toLocaleString()} 字节
    </button>)}
    {phase === 'waiting_approval' && plan.preflight?.map((message, index) =>
      <p key={index} style={{ color: '#e3b341' }}>准备时提示：{message}；确认时会重新检查。</p>)}
    {plan.warnings?.map((message, index) => <p key={index}>{message}</p>)}
    {runtime.message ? <p role="status">{String(runtime.message)}</p> : null}
    {notice && <p role="status">{notice}</p>}
    {phase === 'waiting_approval' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <button disabled={responding} onClick={() => onRespond(false)}>取消本次安装</button>
      <button disabled={responding} onClick={() => onRespond(true)}>{responding ? '提交中…' : '确认安装并重启目标节点'}</button>
    </div>}
    {handed && <div><p>安装已交接，关闭面板或停止聊天不会撤回；不会自动重装。</p>
      <button disabled={busy} onClick={() => void act()}>只读核对原安装结果</button></div>}
    {runtime.receipt ? <details><summary>安装回执</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(runtime.receipt, null, 2)}</pre></details> : null}
    {runtime.verification ? <details><summary>实际启动验收</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(runtime.verification, null, 2)}</pre></details> : null}
  </section>;
};
