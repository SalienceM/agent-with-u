import React from 'react';
import { blockerLabel, type TaskBlockerDetails } from '../utils/loopTaskBlockers';
import { contractLabel } from '../types/loopContract';

export const LoopTaskBlockerDetail: React.FC<{ record: TaskBlockerDetails; open?: boolean }> = ({ record, open }) => {
  const review = record.blockerSummary?.status ? record.blockerSummary : record.blockerReview;
  const contract = record.contractValidation;
  if (!contract?.status && !review?.status && !record.taskPlan?.valid && !record.taskBlockers?.items?.length) return null;
  return <details open={open} data-testid="loop-task-blockers" style={{ fontSize: 12, overflowWrap: 'anywhere', minWidth: 0, marginBottom: 10 }}>
    <summary style={{ cursor: 'pointer' }}>{blockerLabel(review) || '任务映射与测试隔离前置'} · 详情</summary>
    {contract?.status && contract.status !== 'valid' && <section data-testid="loop-contract-diagnostic">
      <strong>{contractLabel(contract)}</strong><p>{contract.reason || '旧记录未保留具体字段原因，请核对原文。'}</p>
      <p>规划调用 {contract.attemptCount || 0}/3 · {contract.scopeUnknown ? '影响范围未确认，不能缩小保护' : '影响范围见任务编号'}</p>
      {!!contract.fields?.length && <p>错误字段：{contract.fields.join('、')}</p>}
      {!!contract.affectedIds?.length && <p>受影响任务：{contract.affectedIds.join('、')}</p>}
      {!!contract.identityDimensions?.length && <p>变化维度：{contract.identityDimensions.join('、')}</p>}
      <details><summary>校验依据</summary><div>{contract.reasonCode} · {contract.origin}</div>
        {contract.evidenceRefs?.map(ref => <div key={ref}>{ref}</div>)}</details>
    </section>}
    {record.contractRepairAudits?.map(audit => <details key={audit.requestId} style={{ marginTop: 8 }}>
      <summary>修复审计 · {audit.requestId} · {audit.status}</summary>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(audit, null, 2)}</pre>
    </details>)}
    {!!review?.affectedIds?.length && <div>冻结任务（含依赖）：{review.affectedIds.join('、')}</div>}
    {!!review?.readyIds?.length && <div>独立就绪：{review.readyIds.join('、')}（是否执行仍由 Auto、预算和环境门槛决定）</div>}
    {record.taskBlockers?.valid === false && <div>范围未知：{record.taskBlockers.reason || '协议未确认'}</div>}
    {record.taskBlockers?.items?.map(item => <div key={item.id} style={{ marginTop: 8 }}>
      <strong>{item.id} · {item.affectedTaskIds.join('、')}</strong>
      <div>{item.reason}</div><div>解除条件：{item.resolution}</div>
      <div style={{ color: 'var(--theme-text-muted)' }}>模型观察（非 OS 证明） · {item.evidenceRefs.join('；')}</div>
    </div>)}
    {!!record.taskPlan?.tasks?.length && <div style={{ marginTop: 8 }}>
      {record.taskPlan.sourceKind === 'formal' ? '正式来源映射' : '模型冻结台账（非正式来源）'}：
      {record.taskPlan.tasks.map(task => <div key={task.id}>{task.id} · 依赖 {task.dependsOn.join('、') || '无'}</div>)}
    </div>}
    {record.taskPlan?.preconditions?.map(item => {
      const receipt = record.isolationEvidence?.items?.[item.id];
      return <div key={item.id} style={{ marginTop: 8 }}>隔离前置 {item.id} · {item.affectedTaskIds.join('、')}
        <div>{item.isolatedRoot} · {item.verificationMethod}</div>
        <div>{receipt && record.isolationEvidence?.valid ? '有限模型观察 + 文件修订核对，调用时重验' : '尚未核实，不能启动对应测试'}</div>
        <div>真实基线依据：{item.baselineBasis || '未要求；不额外读取真实存档'}</div>
      </div>;
    })}
    {!!record.blockerReview?.evidenceRefs?.length && <div>独立评审引用：{record.blockerReview.evidenceRefs.join('；')}</div>}
    <div style={{ color: 'var(--theme-text-muted)', marginTop: 6 }}>只读复核不等于验收通过或写权限已验证；原始结果见阶段/步骤详情。</div>
  </details>;
};
