import React, { useRef, useState } from 'react';
import type { AimeinAnchor } from '../types/aimein';
import type { LoopRecord, LoopStateT } from '../types/loopWorkbench';
import { assemblyClosure, assemblyIntent, type AimeinTool } from '../utils/aimeinPlay';
import { aimeinButton as button, aimeinInput as input } from './AimeinReviewLibrary';

interface Draft { ids: string[]; note: string; notice: string; uncertain?: boolean; }
const empty: Draft = { ids: [], note: '', notice: '' };
const small: React.CSSProperties = { fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.7 };

export function useAimeinPlay(state: LoopStateT, current: LoopRecord | undefined, locked: boolean, executor: string,
  onFeedback: (text: string, anchor: AimeinAnchor) => Promise<{ status: string; message?: string }>) {
  const [tool, setTool] = useState<AimeinTool>('inspect');
  const targets = current?.aimeinRun?.plan?.targets?.slice(0, 40) || [];
  const basis = JSON.stringify([executor, state.sessionId, current?.seq || 0, targets, current?.aimeinRun?.plan?.sprint]);
  const [selection, setSelection] = useState({ basis: '', id: '' });
  const targetId = selection.basis === basis ? selection.id : '';
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draft = drafts[basis] || empty;
  const setDraft = (update: Partial<Draft>) => setDrafts(previous => ({ ...previous, [basis]: { ...(previous[basis] || empty), ...update } }));
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const closure = assemblyClosure(targets, draft.ids);
  const text = assemblyIntent(current?.seq || 0, current?.aimeinSummary?.sprintId || '', targets, draft.ids, closure.ids, draft.note);
  const pick = (id: string) => {
    setSelection({ basis, id });
    if (tool === 'assemble' && !saving && !draft.uncertain) setDraft({ ids: draft.ids.includes(id) ? draft.ids.filter(v => v !== id) : [...draft.ids, id], notice: '' });
  };
  const submit = async () => {
    if (inFlight.current || locked || !draft.ids.length || closure.errors.length || text.length > 4000 || draft.uncertain) return;
    const key = basis; inFlight.current = true; setSaving(true); setDraft({ notice: '正在把组合交给下一次规划…' });
    try {
      const result = await onFeedback(text, { kind: 'flow', seq: current?.seq || 0 });
      // 响应只写回发起时的计划草稿，不污染推送后的计划。
      setDrafts(previous => ({ ...previous, [key]: result.status === 'ok'
        ? { ...empty, notice: '组合已保存 · 等待下一次规划采纳。可以继续装配另一种方案。' }
        : { ...(previous[key] || draft), notice: result.message || '未确认保存，请先查看意见流，草稿保留。', uncertain: result.status !== 'error' } }));
    } catch (error: any) {
      setDrafts(previous => ({ ...previous, [key]: { ...(previous[key] || draft), uncertain: true, notice: `${error.message || '保存结果未知'} · 请先核对意见流，不会自动重发。` } }));
    } finally { inFlight.current = false; setSaving(false); }
  };
  return { tool, setTool, targets, targetId, pick, draft, setDraft, closure, saving, submit, tooLong: text.length > 4000, locked };
}

export const AimeinPlayPanel: React.FC<{
  play: ReturnType<typeof useAimeinPlay>; current?: LoopRecord; progress: Record<string, string>;
  historical: boolean; running: boolean; onReview: (id: string) => void; onCalibrate: (id: string) => void;
}> = ({ play, current, progress, historical, running, onReview, onCalibrate }) => {
  const target = play.targets.find(t => t.id === play.targetId);
  const summary = current?.aimeinSummary;
  const title = { inspect: '拿起来看', assemble: '装配台', probe: '故障探针', reviewers: '评委席' }[play.tool];
  if (play.tool === 'inspect' && !target) return null;
  return <section aria-label={title} style={{ padding: 16, marginBottom: 14, border: '1px solid #647c65', background: 'linear-gradient(145deg, #203c35, #152d2d)', color: '#e0ebd9', borderRadius: 12 }}>
    <div style={{ font: '10px monospace', letterSpacing: 2, color: '#a7b797' }}>WORKSHOP / {play.tool.toUpperCase()} / #{current?.seq || '—'}</div>
    <h3 style={{ margin: '6px 0 12px', fontSize: 20 }}>{title}</h3>
    {historical && <p style={{ ...small, color: '#e1c68d' }}>正在回看历史。返回最新阶段后再提交或开工。</p>}
    {(play.tool === 'inspect' || play.tool === 'assemble') && <>
      {play.tool === 'assemble' && <>
        <p style={{ ...small, color: '#bed0ba' }}>把想一起建的模块放上来。依赖会跟过来；再点一次取回。组合将交给下一次规划。</p>
        <div aria-label="装配槽" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(68px,1fr))', gap: 6, margin: '12px 0' }}>
          {play.closure.ids.length ? play.closure.ids.map(id => <button key={id} type="button" aria-label={`装配槽 ${id}`} onClick={() => play.pick(id)} style={{ ...button, minHeight: 57, borderColor: play.draft.ids.includes(id) ? '#dbc892' : '#598a7f', background: play.draft.ids.includes(id) ? '#596143' : '#294940', color: '#e5e8cf' }}><b>{id}</b><small style={{ display: 'block', marginTop: 3 }}>{play.draft.ids.includes(id) ? '已放入' : '所需依赖'}</small></button>)
            : [1, 2, 3].map(i => <div key={i} style={{ minHeight: 57, border: '1px dashed #6b826e', borderRadius: 6, display: 'grid', placeItems: 'center', color: '#8caa96' }}>＋</div>)}
        </div>
        {!!play.closure.ids.length && <p style={{ ...small, color: '#b9cebd' }}>{play.draft.ids.length} 个主动选择 · {play.closure.ids.length - play.draft.ids.length} 个依赖自动纳入</p>}
      </>}
      {target && <article data-testid="aimein-held-target" style={{ padding: 12, borderLeft: '2px solid #dccb91', background: '#071b1b70', margin: '12px 0' }}>
        <b>{target.id} · {target.title}</b><p style={{ ...small, color: '#d3dfcb' }}>{target.acceptance}</p>
        <div style={{ fontSize: 11, color: '#a9c7b7' }}>先要有 {target.dependsOn?.length ? target.dependsOn.join(' → ') : '· 无前置依赖'}</div>
      </article>}
      <div aria-label="模块背包" style={{ display: 'grid', gap: 5, maxHeight: 250, overflowY: 'auto' }}>{play.targets.map(t => <button key={t.id} type="button" aria-label={`模块 ${t.id}：${t.title}`} aria-pressed={play.tool === 'assemble' ? play.draft.ids.includes(t.id) : t.id === play.targetId} onClick={() => play.pick(t.id)} style={{ ...button, textAlign: 'left', display: 'flex', gap: 9, background: t.id === play.targetId ? '#536447' : '#1b3632', borderColor: t.id === play.targetId ? '#decd95' : '#48665a', color: '#d2e0c9' }}><span style={{ color: '#e4ce91', fontFamily: 'monospace' }}>{play.closure.ids.includes(t.id) ? '▣' : '◇'} {t.id}</span><span>{t.title}</span></button>)}</div>
      {!play.targets.length && <p style={small}>目标拆解后，真实模块会出现在这里。先点亮目标，再开工。</p>}
      {play.tool === 'assemble' && <form onSubmit={e => { e.preventDefault(); void play.submit(); }}>
        <label style={{ display: 'block', fontSize: 12, marginTop: 14 }}>这次组合，希望先玩到什么？<textarea aria-label="装配意图" value={play.draft.note} maxLength={1000} rows={2} disabled={play.saving || play.draft.uncertain} onChange={e => play.setDraft({ note: e.target.value })} style={{ ...input, marginTop: 6 }} placeholder="例如：先让我完成保存、断网、重开这一轮体验" /></label>
        {play.closure.errors.map(error => <p key={error} role="alert" style={{ fontSize: 12, color: '#efb09a' }}>{error}</p>)}
        {play.tooLong && <p role="alert" style={small}>组合原文超过 4000 字符，请减少模块或补充说明。</p>}
        <button type="submit" disabled={play.locked || play.saving || !play.draft.ids.length || !!play.closure.errors.length || play.tooLong || play.draft.uncertain} style={{ ...button, marginTop: 12, background: '#c8d49f', color: '#253e2d' }}>{play.saving ? '正在交付组合…' : '交给下次规划'}</button>
        {running && <p style={small}>当前工坊正在执行；可以试组合，结束后再提交。</p>}
        {play.draft.notice && <p role="status" style={{ fontSize: 12, lineHeight: 1.7, color: '#e0dcae' }}>{play.draft.notice}</p>}
      </form>}
    </>}
    {play.tool === 'probe' && <>
      <p style={{ ...small, color: '#bfd0bd' }}>沿真实步骤向下追。保存产出、尚未执行和待修补各有依据。</p>
      {current?.error && <p role="alert" style={{ color: '#f0ba9c', fontSize: 13 }}>{current.error}</p>}
      {summary?.issues.map((issue, i) => <div key={`${issue.id}:${i}`} style={{ padding: 10, marginBottom: 8, borderLeft: '2px solid #d79e6c', background: '#502f202f', fontSize: 12 }}><b>{issue.id} · {issue.model}</b><p>{issue.reason}</p><button style={button} disabled={!summary.reviews.some(r => r.model === issue.model)} onClick={() => { const review = summary.reviews.find(r => r.model === issue.model); if (review) onReview(review.id); }}>追到评审依据</button></div>)}
      {current?.orchestration.map(step => <details key={step.index} open={step.status === 'error' || step.status === 'running'} style={{ borderTop: '1px solid #3b5c4e', padding: '10px 0', fontSize: 12 }}>
        <summary style={{ cursor: 'pointer', color: step.status === 'error' ? '#f1b490' : '#d6e4c7' }}>{({ done: '▣ 已保存', error: '⚡ 失败', running: '◉ 运行中', pending: '◇ 待执行' } as Record<string, string>)[step.status] || step.status} · {step.desc}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflow: 'auto', fontSize: 11, lineHeight: 1.7, color: '#a9d5c1' }}>{step.output || progress[`${current.seq}:step${step.index}`] || '尚无保存输出'}</pre>
      </details>)}
      {!current?.orchestration.length && <p style={small}>这次尝试尚无执行步骤。规划完成后可以沿线路逐步查看。</p>}
      {!current?.error && !summary?.issues.length && <p style={small}>当前记录没有已报告的故障；这不等于所有目标已验收。</p>}
      <p style={{ ...small, color: '#bfd0bd' }}>修补意见可以写在下方，连同对象与尝试一起留给下一次规划。</p>
    </>}
    {play.tool === 'reviewers' && <>
      <p style={{ ...small, color: '#bfd0bd' }}>每位评委都有自己的模型、口味和聚焦。先看判断依据，再调下一次的理解。</p>
      {(summary?.reviews || []).map((review, i) => <div key={review.id} style={{ padding: 12, marginBottom: 8, background: '#0e2424', border: '1px solid #4d685a', borderRadius: 7 }}>
        <b style={{ fontSize: 13 }}>{i + 1} · {review.profileName || review.model}</b><p style={{ fontSize: 12, color: review.status === 'passed' ? '#b6d79c' : '#e0c18b' }}>{review.error || review.summary || '等待独立核对'}</p>
        <div style={{ display: 'flex', gap: 7 }}><button style={button} onClick={() => onReview(review.id)}>查看依据</button><button style={button} onClick={() => onCalibrate(review.id)}>校准这位评委</button></div>
      </div>)}
      {!summary?.reviews.length && <p style={small}>在评委工坊建立模型的口味与聚焦档案，首次评审后再积累校准。</p>}
    </>}
  </section>;
};
