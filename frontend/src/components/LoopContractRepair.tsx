import React from 'react';
import { repairActive, type RepairEligibility } from '../types/loopContract';
import type { RepairFeedback } from '../utils/loopContractController';

const buttonStyle: React.CSSProperties = { background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)',
  border: '1px solid var(--theme-border)', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' };

export const LoopContractRepair: React.FC<{
  supported: boolean; eligibility?: RepairEligibility; feedback: RepairFeedback; available: boolean; current: boolean;
  onRepair: () => void; onCheck: () => void; onCancel: () => void;
}> = ({ supported, eligibility, feedback, available, current, onRepair, onCheck, onCancel }) => {
  const receipt = feedback.receipt;
  const active = repairActive(receipt);
  const labels: Record<string, string> = { accepted: '修复请求已接收，尚未完成', running: '正在只读修复任务映射',
    unknown: '修复结果待确认', succeeded: '映射已修复，尚未运行', blocked: '需要用户核对原始依据', failed: '修复失败，原记录已保留',
    cancelled: '修复已停止', stale: '问题已变化，未提交旧结果' };
  return <section aria-label="任务映射修复" style={{ padding: 12, border: '1px solid var(--theme-border)', borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
    <strong>{labels[receipt?.status || ''] || '显式修复任务映射'}</strong>
    <p>仅核对并修复任务映射，不运行项目步骤、不解除真实阻塞、不启用 Auto。</p>
    {receipt?.status && <p role="status">{receipt.reason} · 本次修复调用 {receipt.attemptCount || 0}/2</p>}
    {feedback.error && <p role="status">{feedback.error}</p>}
    {!supported ? <p>当前执行端未提供修复协议；不会回退成普通运行。</p> : <>
      <button style={buttonStyle} disabled={!available || !current || !eligibility?.canRequest || active || feedback.sending}
        onClick={onRepair}>修复任务映射</button>
      {!eligibility?.canRequest && <p>{eligibility?.message || '动作资格尚未确认，请刷新状态。'}</p>}
      {receipt?.requestId && <button style={{ ...buttonStyle, marginLeft: 8, marginTop: 8 }} disabled={feedback.checking || !available} onClick={onCheck}>
        {feedback.checking ? '正在读取回执…' : '查询原修复回执'}</button>}
      {active && <button style={{ ...buttonStyle, marginLeft: 8, marginTop: 8 }} disabled={feedback.sending || !available} onClick={onCancel}>停止修复</button>}
    </>}
  </section>;
};
