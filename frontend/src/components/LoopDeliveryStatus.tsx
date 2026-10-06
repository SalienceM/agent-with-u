import React from 'react';
import type { MilestoneSummary } from '../types/loopContinuation';

export interface DeliveryReport {
  reconciliation?: { valid?: boolean; mappingValid?: boolean; total?: number; checked?: number; missing?: string[]; extra?: string[]; uncheckedVerified?: string[]; manualIds?: string[]; sourceMismatch?: boolean };
  milestoneSummary?: MilestoneSummary;
  milestoneReview?: { valid?: boolean; issues?: string[]; discoveries?: Array<{ id: string; parentId: string; acceptance: string; reason: string }>; milestones?: Array<{ id: string; parentId: string; acceptance: string; status: string; validity: string; evidenceRefs?: unknown[] }> };
  mode?: string; source?: string; scopeComplete?: boolean; valid?: boolean;
  items?: Array<{ id: string; title: string; status: string; dependsOn: string[]; evidence: string; manualBasis: string }>;
  blockers?: Array<{ id: string; kind: string; affected: string[]; reason: string; resolution: string }>;
  verification?: { status: string; evidence: string };
}
export interface ProgressGuard {
  pause?: boolean; reason?: string; noProgressCount?: number; needsReplan?: boolean;
  scopeLost?: boolean; readyIds?: string[]; basis?: string;
}
const labels: Record<string, string> = {
  pending: '待实现', implemented: '已实现待验', verified: '已验证', blocked: '受阻', manual: '人工项',
  local: '局部阻塞', global: '全局阻塞', safety: '安全阻塞', authorization: '授权阻塞', human: '需人工输入', passed: '通过',
};
const box: React.CSSProperties = {
  border: '1px solid var(--theme-border)', borderRadius: 8, padding: 10,
  marginBottom: 10, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere',
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)',
};

export const LoopProgressNotice: React.FC<{ guard?: ProgressGuard; handoff?: { available?: boolean; source?: string } }> = ({ guard, handoff }) => {
  if (!guard?.reason && !guard?.scopeLost && !handoff?.available) return null;
  return <div style={box} role="status" data-testid="loop-progress-notice">
    {handoff?.available && <div>已保留转换时的有限历史交接；历史结论需核实，旧工具授权不会继承。</div>}
    {guard?.reason && <div><strong>{guard.pause ? '自动执行已暂停' : '下一轮调整方向'}</strong>：{guard.reason}</div>}
    {guard?.scopeLost && <div>任务范围或来源出现变化，不能据此收口；请对照原任务表核实遗漏。</div>}
    {guard?.pause && <div>成果和步骤记录已保留，尚未宣称完成。补充条件或调整策略后，可手动执行下一次或重新开启 Auto。</div>}
    {!!guard?.readyIds?.length && <div>已识别就绪候选：{guard.readyIds.join('、')}</div>}
  </div>;
};

export const LoopDeliveryDetail: React.FC<{ report?: DeliveryReport }> = ({ report }) => {
  if (!report?.mode) return null;
  const items = report.items || [];
  return <section style={box} aria-label="任务与证据台账">
    <strong>任务与证据台账 · {report.mode === 'delivery' ? '任务交付' : '探索验证'}</strong>
    <div>来源：{report.source || '未明确'} · {report.scopeComplete ? '已声明完整范围' : '范围仍待核对'}</div>
    <div style={{ color: 'var(--theme-text-muted)' }}>以下是评审核实记录，不以模型自述或操作次数代替验收。</div>
    {!report.valid && <div>台账结构或来源/模式核对未通过，不能作为完成依据。</div>}
    {report.reconciliation && <div data-testid="loop-formal-count">正式任务勾选 {report.reconciliation.checked}/{report.reconciliation.total} · {report.reconciliation.valid ? '清单对账一致（仍需验收）' : '对账未通过，不能收口'}
      {!!report.reconciliation.missing?.length && <div>遗漏：{report.reconciliation.missing.join('、')}</div>}
      {!!report.reconciliation.extra?.length && <div>无法映射：{report.reconciliation.extra.join('、')}</div>}
      {report.reconciliation.sourceMismatch && <div>评审引用的来源与绑定 change 不一致，需核对。</div>}
      {!!report.reconciliation.uncheckedVerified?.length && <div>未勾选但声称验证：{report.reconciliation.uncheckedVerified.join('、')}</div>}
      {!!report.reconciliation.manualIds?.length && <div>正式范围内待人工核验：{report.reconciliation.manualIds.join('、')}</div>}
    </div>}
    {report.milestoneReview && <details data-testid="loop-milestones"><summary>子里程碑（独立侧台账，不计入正式任务分母）</summary>
      {!report.milestoneReview.valid && <div>子项条件/证据未通过核对，不计新增信用。</div>}
      {report.milestoneReview.discoveries?.map((d, index) => <div key={`${d.id}-${index}`}>基线候选 {d.parentId}/{d.id} · {d.acceptance} · {d.reason}</div>)}
      <div>本轮认可增量：{report.milestoneSummary?.credited?.join('、') || '无'} · 恢复旧高水位：{report.milestoneSummary?.restored?.join('、') || '无'}</div>
      <div>已实现待验 {report.milestoneSummary?.counts?.implemented || 0} · 已验证 {report.milestoneSummary?.counts?.verified || 0}</div>
      {report.milestoneReview.milestones?.map(m => <div key={m.id} style={{ marginTop: 6 }}>{m.parentId} / {m.id} · {m.acceptance}<br />{labels[m.status] || m.status} · 证据 {m.validity === 'current' ? '当前适用' : `失效/待核对：${m.validity}`}<br />{JSON.stringify(m.evidenceRefs || [])}</div>)}
      <div>子项全部已验证仍不代表父任务集成验收通过；旧记录不补造进度。</div>
    </details>}
    <div>{Object.entries(labels).filter(([key]) => items.some((i) => i.status === key)).map(([key, label]) =>
      <span key={key} style={{ marginRight: 10 }}>{label} {items.filter((i) => i.status === key).length}</span>)}</div>
    {(report.blockers || []).map((blocker, index) => <div key={`${blocker.id}-${index}`} style={{ marginTop: 8 }}>
      <strong>{labels[blocker.kind] || blocker.kind} · {blocker.id}</strong>
      <div>影响：{blocker.affected.join('、') || '需核实范围'} · {blocker.reason}</div>
      <div>解除条件：{blocker.resolution || '尚未提供'}</div>
    </div>)}
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer' }}>展开 {items.length} 项任务、依赖和证据</summary>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>{items.map((item) => <div key={item.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--theme-border)' }}>
        <strong>{item.id} · {labels[item.status] || item.status} · {item.title}</strong>
        {!!item.dependsOn.length && <div>依赖：{item.dependsOn.join('、')}</div>}
        <div style={{ whiteSpace: 'pre-wrap' }}>{item.evidence || '尚无验收证据'}</div>
        {item.manualBasis && <div>人工依据：{item.manualBasis}</div>}
      </div>)}</div>
    </details>
    <div style={{ marginTop: 8 }}>整体 verify：{report.verification?.status === 'passed' ? '通过' : report.verification?.status === 'blocked' ? '受阻' : '待验证'}</div>
    {report.verification?.evidence && <div style={{ whiteSpace: 'pre-wrap' }}>{report.verification.evidence}</div>}
  </section>;
};
