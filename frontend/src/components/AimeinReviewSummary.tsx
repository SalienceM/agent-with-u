import React from 'react';
import type { AimeinRun, AimeinSummary } from '../types/aimein';
import { reviewOverview } from '../utils/aimeinReviewSummary';

export const AimeinReviewSummary: React.FC<{ summary?: AimeinSummary; detail?: AimeinRun; compact?: boolean }> = ({ summary, detail, compact }) => {
  const view = reviewOverview(summary, detail);
  const content = <>
    <p style={{ margin: '8px 0', color: view.accepted ? '#c4e6a9' : '#e4c696', fontWeight: 600 }}>{view.title}</p>
    <div style={{ fontSize: 12, lineHeight: 1.8 }}>
      <b>{view.expected === 1 ? '独立核实' : '共同认可'}</b>
      {view.common.length ? view.common.map(c => <div key={c.id}>✓ {c.acceptance}</div>) : <div style={{ color: '#9db6aa' }}>{view.completeReports ? '尚无完整核实的验收条件。' : '评审依据尚未齐全，暂不声称通过。'}</div>}
      {!!view.problems.length && <div style={{ marginTop: 10 }}><b>分歧与待修补</b>{view.problems.map(c => <details key={c.id} style={{ marginTop: 5 }}>
        <summary style={{ cursor: 'pointer', color: '#e5c698' }}>{c.disagreement ? '有分歧' : '待修补'} · {c.acceptance}</summary>
        {c.opinions.map(opinion => <p key={opinion.reviewId} style={{ paddingLeft: 10, borderLeft: '1px solid #587162' }}><b>{opinion.model}</b> · {opinion.item?.status === 'verified' ? '已核实' : opinion.item?.status === 'gap' ? '有缺口' : '未确认'}<br />{opinion.item?.reason || '尚无该条件的完整报告'}{opinion.item?.evidence?.length ? <><br /><span style={{ color: '#91b2a2' }}>{opinion.item.evidence.join(' · ')}</span></> : null}</p>)}
      </details>)}</div>}
      {view.issues.map((issue, i) => <p key={`${issue.id}:${i}`} style={{ color: '#e1bd8a' }}>{issue.model} · {issue.reason}</p>)}
      {!!view.unknown.length && <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer' }}>待核对依据 · {view.unknown.length} 项</summary>{view.unknown.map(c => <p key={c.id}>{c.acceptance}</p>)}</details>}
      <div style={{ marginTop: 10 }}><b>下一步</b><div style={{ whiteSpace: 'pre-wrap', color: '#bbd1bd' }}>{view.next}</div></div>
    </div>
  </>;
  return <section data-testid="aimein-review-overview" aria-label="评审整体意见" style={{ border: '1px solid #4b6958', borderRadius: 9, background: '#17312a', padding: compact ? '9px 12px' : 14, color: '#d7e6cc', marginBottom: compact ? 0 : 12, overflowWrap: 'anywhere' }}>
    {compact ? <details><summary style={{ cursor: 'pointer', fontSize: 12 }}>整体意见 · {view.title}</summary><div style={{ maxHeight: 200, overflow: 'auto' }}>{content}</div></details> : <><div style={{ fontSize: 14, fontWeight: 700 }}>整体意见 <span style={{ fontSize: 10, fontWeight: 400, color: '#8fab99' }}>· 汇总 {view.expected || "待确认"} 位评委报告</span></div>{content}</>}
  </section>;
};
