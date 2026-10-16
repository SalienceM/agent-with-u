import React from 'react';
import type { LoopStateT } from '../types/loopWorkbench';
import { activeLoopSeq } from '../utils/loopDiagnostics';

const scoreColor = (score: number) => score >= 85 ? '#8957e5' : score >= 70 ? '#2da44e' : score >= 40 ? '#bf8700' : '#f87171';
export const StageRail: React.FC<{ stage: string }> = ({ stage }) => {
  const stages = ['loopidea', 'loopexecute', 'loopout'], labels = ['想法', '执行', '成果'];
  const current = stages.indexOf(stage);
  return <div aria-label="LOOP 三阶段" data-testid="loop-stage-rail" style={{ display: 'flex', alignItems: 'center', padding: '12px 0' }}>
    {stages.map((value, index) => <React.Fragment key={value}>
      {!!index && <div style={{ flex: 1, minWidth: 6, height: 2, margin: '0 8px', background: index <= current ? 'var(--theme-accent)' : 'var(--theme-border)' }} />}
      <div aria-current={index === current ? 'step' : undefined} style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: index > current ? .45 : 1 }}>
        <span style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 11,
          border: '1px solid var(--theme-border)', background: index <= current ? 'var(--theme-accent-bg)' : 'var(--theme-bg-tertiary)', color: 'var(--theme-accent)' }}>{index + 1}</span>
        <span style={{ fontSize: 12, fontWeight: index === current ? 700 : 400 }}>{labels[index]}<small style={{ display: 'block', fontSize: 10, color: 'var(--theme-text-muted)' }}>{value}</small></span>
      </div>
    </React.Fragment>)}
  </div>;
};

export const ScoreRing: React.FC<{ score: number | null; pending?: boolean }> = ({ score, pending }) => {
  const color = score == null ? 'var(--theme-text-muted)' : scoreColor(score);
  return <span data-testid="loop-score-ring" aria-label={score == null ? '未评审' : `评审 ${score} 分`} style={{
    width: 36, height: 36, flexShrink: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', color,
    background: score == null ? 'var(--theme-border)' : `conic-gradient(${color} ${Math.max(0, Math.min(100, score)) * 3.6}deg, var(--theme-bg-tertiary) 0deg)` }}>
    <span style={{ width: 29, height: 29, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12,
      background: 'var(--theme-bg-secondary)', fontWeight: 700 }}>{score == null ? pending ? '…' : '—' : score.toFixed(0)}</span>
  </span>;
};

export const MetricBar: React.FC<{ state: LoopStateT }> = ({ state }) => {
  const observed = state.loops.some(loop => loop.round === state.round && loop.analysis && loop.analysis.scoreObserved !== false && !loop.blockerSummary?.status);
  const risk = state.riskCoefficient ?? 0;
  return <section aria-label="本轮诊断指标" style={{ marginBottom: 12 }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8 }}>
      {[['最佳评分', observed && Number.isFinite(state.bestScore) ? state.bestScore.toFixed(0) : '未评审'], ['最近评分', observed && Number.isFinite(state.latestScore) ? state.latestScore.toFixed(0) : '未评审'],
        ['本轮预算', `${state.roundLoopCount ?? '?'} / ${state.effectiveMaxLoops ?? '?'}`], ['风险系数', Number.isFinite(state.riskCoefficient) ? risk.toFixed(2) : '未知']].map(([label, value]) =>
        <div key={label} style={{ border: '1px solid var(--theme-border)', borderRadius: 9, background: 'var(--theme-bg-secondary)', padding: '8px 12px' }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{label}</div><div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
          {label === '风险系数' && <div style={{ height: 3, background: 'var(--theme-border)', borderRadius: 3 }}><div style={{ height: '100%', width: `${Math.min(1, risk) * 100}%`, background: risk >= .7 ? '#f87171' : '#bf8700' }} /></div>}
        </div>)}
    </div>
    <div style={{ marginTop: 5, fontSize: 11, color: 'var(--theme-text-muted)' }}>第 {state.round} 轮诊断 · 评分不是任务验收，预算结束不代表完成。</div>
  </section>;
};

export const LoopTimeline: React.FC<{ state: LoopStateT; selected: number | null; onSelect: (seq: number) => void }> = ({ state, selected, onSelect }) => {
  const active = activeLoopSeq(state);
  return <nav aria-label="Loop 轮次时间轴" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 10, marginBottom: 8 }}>
    {state.loops.map(loop => <button key={loop.seq} onClick={() => onSelect(loop.seq)} aria-pressed={selected === loop.seq}
      className={active === loop.seq ? 'awu-pulse' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
        flexShrink: 0, maxWidth: 240, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', color: 'var(--theme-text)',
        border: `1px solid ${selected === loop.seq ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
        background: selected === loop.seq ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)' }}>
      <ScoreRing score={loop.analysis && loop.analysis.scoreObserved !== false && !loop.blockerSummary?.status ? loop.analysis.score : null} pending={active === loop.seq} />
      <span><strong style={{ fontSize: 12 }}>{loop.kind === 'manual' ? 'Manual' : 'Loop'} #{loop.seq}</strong>
        <small style={{ display: 'block', fontSize: 11, marginTop: 4 }}>第 {loop.round} 轮 · {active === loop.seq ? '执行中' : loop.error ? '中断' : loop.completed ? '记录已结束' : '未完成'}</small></span>
    </button>)}
    {!state.loops.length && <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>还没有迭代记录。</span>}
  </nav>;
};
