import React from 'react';
import type { LoopRecord, LoopStateT } from '../types/loopWorkbench';
import { planWaitingMessage } from '../utils/aimeinWorld';

const status: Record<string, string> = { planning: '拆解目标', preparing: '编排步骤', executing: '建设中', reviewing: '独立验收中', accepted: '阶段通过', repair: '需要修补', blocked: '执行受阻', stale: '依据已变化', needs_attention: '需要处理', pending: '等待评审', running: '正在核对', passed: '通过', changes_requested: '需修补', error: '评审失败' };
const card: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 12, padding: 16, minWidth: 0, background: 'var(--theme-bg-secondary)', overflowWrap: 'anywhere' };
const muted: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 12, lineHeight: 1.65 };
const button: React.CSSProperties = { padding: '7px 11px', borderRadius: 7, border: '1px solid var(--theme-border)', color: 'var(--theme-text)', background: 'var(--theme-bg-secondary)', cursor: 'pointer' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 };

export const AimeinRecordView: React.FC<{
  state: LoopStateT; selected?: LoopRecord; onSelect: (seq: number) => void;
  onSettings: () => void; progress: Record<string, string>; detailError?: string; onRetry: () => void;
}> = ({ state, selected, onSelect, onSettings, progress, detailError, onRetry }) => {
  const records = state.loops.filter(r => r.aimeinSummary?.sprintId);
  const current = selected?.aimeinSummary?.sprintId ? selected : records.at(-1);
  const run = current?.aimeinSummary;
  const detail = current?.aimeinRun;
  const planMessage = planWaitingMessage(current, state.running && current?.seq === records.at(-1)?.seq);
  const deferred = detail?.plan?.sprint?.deferred || [];
  const stage = !run ? 0 : ['planning', 'preparing'].includes(run.status) ? 1 : run.status === 'executing' ? 2 : 3;
  return <div data-testid="aimein-records" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
    <div style={{ ...card, background: 'linear-gradient(120deg, var(--theme-accent-bg, #0969da12), var(--theme-bg-secondary))' }}>
      <div style={{ ...muted, letterSpacing: 2 }}>AIM ME IN</div>
      <h2 style={{ fontSize: 20, margin: '6px 0 10px', lineHeight: 1.4 }}>{run?.title || '让目标逐阶段成为可用的产品'}</h2>
      <p style={{ margin: '0 0 12px', lineHeight: 1.7, fontSize: 13 }}>{run?.outcome || '先确认产品目标，再动态生成 Sprint。每个阶段同时安排功能流程、必要基础设施和可核实的验收条件。'}</p>
      <ol aria-label="AIMEIN 执行流程" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 0, margin: 0, listStyle: 'none', fontSize: 12 }}>
        {['整体目标', '动态 Sprint', 'FlowBuild + Infra', '三模型验收'].map((name, i) => <li key={name} aria-current={stage === i ? 'step' : undefined}
          style={{ padding: '6px 10px', borderRadius: 20, border: `1px solid ${stage === i ? 'var(--theme-accent)' : 'var(--theme-border)'}`, fontWeight: stage === i ? 700 : 400 }}>{i + 1} · {name}</li>)}
      </ol>
    </div>
    {!run ? <section style={card}>
      <strong>开始前，选好三位评审</strong><p style={muted}>三个不同模型，各自开启新会话。三位全部通过当前阶段才继续；有分歧时保留标准并修补。</p>
      <button style={button} onClick={onSettings}>配置三模型评审</button>
    </section> : <>
      <nav aria-label="AIMEIN 阶段历史" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <label style={{ fontSize: 12 }}>阶段与尝试 <select style={{ ...button, maxWidth: '100%' }} aria-label="查看 AIMEIN 阶段" value={current!.seq} onChange={e => onSelect(Number(e.target.value))}>
          {records.slice().reverse().map(record => <option key={record.seq} value={record.seq}>第 {record.round} 轮 · Sprint {record.aimeinSummary!.sprintNumber} / 尝试 {record.aimeinSummary!.attempt} · {status[record.aimeinSummary!.status] || record.aimeinSummary!.status}</option>)}
        </select></label>
        {current !== records.at(-1) && <button style={button} onClick={() => onSelect(records.at(-1)!.seq)}>返回最新阶段</button>}
      </nav>
      <section aria-label="阶段成熟度" style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <strong>Sprint {run.sprintNumber} <span style={muted}>· 第 {run.attempt} 次尝试</span></strong>
          <span role="status" style={{ fontSize: 12, fontWeight: 600, color: run.accepted ? 'var(--theme-success, #238636)' : 'var(--theme-accent)' }}>{status[run.status] || run.status}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 12 }}><b style={{ fontSize: 32 }}>{run.maturityTarget ?? '—'}<span style={{ fontSize: 16 }}>%</span></b><span style={muted}>本阶段目标成熟度</span></div>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>{run.maturityMeaning || '正在形成具体成熟度条件…'}</p>
        <div style={muted}>仅适用于当前 Sprint 范围，不代表整体完成率。{run.scopeChanged ? '目标或补充已变化，本次重新规划范围。' : ''}</div>
      </section>
      <div style={grid}>
        {[['FlowBuild · 产品功能流程', run.flowBuild, 'flow'], ['Infra · 支撑基础设施', run.infra, 'infra']].map(([title, text, lane]) => <section key={lane} style={card}>
          <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>{title}</h3><p style={{ fontSize: 13, lineHeight: 1.7 }}>{text || '待规划'}</p>
          <ul style={{ paddingLeft: 20, marginBottom: 0, fontSize: 12, lineHeight: 1.8 }}>{run.criteria.filter(c => c.lane === lane).map(c => <li key={c.id}>{c.acceptance}</li>)}</ul>
        </section>)}
      </div>
      <section aria-label="三方验收">
        <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>三方验收 <span style={muted}>· {run.reviews.filter(r => r.status === 'passed').length} / 3 通过</span></h3>
        <div style={grid}>{run.reviews.map((review, i) => {
          const full = detail?.reviews?.find(r => r.id === review.id);
          const raw = current?.stageDetails?.[`aimein-${review.id}`]?.rawOutput || progress[`${current?.seq}:aimein-${review.id}`];
          return <article key={review.id} style={card}>
            <div style={muted}>独立评审 {i + 1}</div><h4 style={{ margin: '5px 0 10px', fontSize: 14 }}>{review.model}</h4>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{status[review.status] || review.status}{review.maturity != null ? ` · 成熟度 ${review.maturity}%` : ''}</div>
            {(review.attemptCount || 0) > 1 && <div style={muted}>第 {review.attemptCount} 次核对 · 已完成的实施保留</div>}
            <p style={{ ...muted, whiteSpace: 'pre-wrap' }}>{review.error || review.summary || '将按同一份阶段标准独立核实成果。'}</p>
            {(full?.criteria || full?.attempts?.length || raw) && <details><summary style={{ cursor: 'pointer', fontSize: 12 }}>查看依据与原文</summary>
              {full?.attempts?.filter(a => a.status === 'error').map(a => <details key={a.number} style={{ marginTop: 8 }}>
                <summary style={{ ...muted, cursor: 'pointer' }}>第 {a.number} 次核对失败：{a.error || '结果未通过协议检查'}</summary>
                {a.rawOutput && <pre style={{ ...muted, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{a.rawOutput}</pre>}
              </details>)}
              {full?.criteria?.map(c => <p key={c.id} style={muted}><b>{c.id} · {{ verified: '已核实', gap: '有缺口', unknown: '未确认' }[c.status] || c.status}</b><br />{c.reason}<br />{c.evidence.join(' · ')}</p>)}
              {raw && <pre style={{ ...muted, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{raw}</pre>}
            </details>}
          </article>;
        })}</div>
      </section>
      {(run.message || run.issues.length > 0 || current?.error) && <section aria-label="阶段结论" style={card}>
        <strong>{run.complete ? '三方整体目标验收通过' : run.accepted ? '本阶段通过，整体目标尚未完成' : '当前处理依据'}</strong>
        <p style={{ fontSize: 13, lineHeight: 1.7 }}>{current?.error || run.message}</p>
        {run.issues.map((issue, i) => <p key={i} style={muted}><b>{issue.model} · {issue.id}</b><br />{issue.reason}</p>)}
        {run.nextFocus && <p style={{ ...muted, whiteSpace: 'pre-wrap' }}>后续建议：{run.nextFocus}</p>}
        {!!run.noProgress && <p style={muted}>连续 {run.noProgress} 次未确认新增进展；重复阶段和分数上涨不计作推进。</p>}
      </section>}
      {current?.decision && <div style={muted} role="status">{current.decision.reasonText}</div>}
      <details style={card}><summary style={{ cursor: 'pointer', fontSize: 13 }}>目标图与执行记录</summary>
        {detailError ? <p role="alert">{detailError} <button style={button} onClick={onRetry}>重新读取详情</button></p> : planMessage && <p role="status" style={muted}>{planMessage}</p>}
        {detail?.plan?.targets?.map(target => <p key={target.id} style={muted}><b>{target.id} · {target.title}</b><br />{target.acceptance}{target.dependsOn.length > 0 && <><br />依赖：{target.dependsOn.join('、')}</>}</p>)}
        {deferred.length > 0 && <p style={muted}>留给后续阶段：{deferred.join('；')}</p>}
        {current?.orchestration.map(step => <details key={step.index} style={{ marginTop: 12 }}><summary style={{ fontSize: 12, cursor: 'pointer' }}>{step.status === 'done' ? '✓' : step.status === 'running' ? '◉' : '○'} {step.desc}</summary><pre style={{ ...muted, whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>{step.output || progress[`${current.seq}:step${step.index}`] || '暂无输出'}</pre></details>)}
        <p style={muted}>成果版本：{run.artifact?.digest?.slice(0, 16) || '待核对'} · {run.artifact?.files ?? '—'} 个文件。文件指纹用于关联版本，评审结论仍需结合实际证据判断。</p>
      </details>
    </>}
    {state.stage === 'loopout' && <section style={card}><strong>{state.status === 'output' ? '本轮已收口' : '本轮已停止'}</strong><p style={muted}>{state.stopReason}</p></section>}
  </div>;
};
