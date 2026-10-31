import React, { useEffect, useRef, useState } from 'react';
import type { LoopRecord, LoopStateT } from '../types/loopWorkbench';
import type { AimeinAnchor, AimeinLibraryResult } from '../types/aimein';
import { expectedReviewers } from '../types/aimein';
import { AimeinRecordView } from './AimeinRecordView';
import { AimeinWorld } from './AimeinWorld';
import { AimeinSceneDock } from './AimeinSceneDock';
import { AimeinRuntimePanel } from './AimeinRuntimePanel';
import { aimeinCurrent, aimeinRecords, aimeinRuntime } from '../utils/aimeinRuntime';
import { AimeinPlayPanel, useAimeinPlay } from './AimeinPlayPanel';
import type { AimeinPlayState, AimeinTool } from '../utils/aimeinPlay';
import { goalObservation, planWaitingMessage } from '../utils/aimeinWorld';
import { AimeinReviewLibrary, aimeinButton as button, aimeinInput as input } from './AimeinReviewLibrary';
import { aimeinDataMessages } from '../utils/aimeinRecordData';

const muted: React.CSSProperties = { fontSize: 12, lineHeight: 1.8, color: 'var(--theme-text-muted)' };
const panel: React.CSSProperties = { padding: 18, border: '1px solid var(--theme-border)', borderRadius: 12, background: 'var(--theme-bg-secondary)', minWidth: 0, overflowWrap: 'anywhere' };
const labels: Record<AimeinAnchor['kind'], string> = { goal: '目标灯塔', flow: '功能工坊', infra: '基础设施', artifact: '成果架', review: '评委席' };
const statuses: Record<string, string> = { pending: '待规划', planned: '已纳入阶段', deferred: '留待后续', needs_work: '待修补', verified: '评审核实' };
const reviewStatus: Record<string, string> = { pending: '等待核对', running: '正在核对', passed: '通过', changes_requested: '需要修补', error: '评审失败' };

export const AimeinWorkbench: React.FC<{
  state: LoopStateT; selected?: LoopRecord; onSelect: (seq: number) => void; onSettings: () => void;
  progress: Record<string, string>; detailError?: string; onRetry: () => void;
  backends?: any[]; execKey: string; busy: boolean; readOnly: boolean;
  onFeedback: (text: string, anchor: AimeinAnchor) => Promise<{ status: string; message?: string }>;
  loadLibrary: (task: string) => Promise<AimeinLibraryResult>;
  updateLibrary: (command: Record<string, unknown>) => Promise<{ status: string; message?: string }>;
  preparation?: React.ReactNode; preparationStep?: number | null; preparationRevision?: number; onPreparationStep?: (step: number) => void;
  externalPanel?: boolean; onCloseExternal?: () => void; extra?: React.ReactNode;
  launch?: AimeinPlayState['launch'];
  connected: boolean; controls?: (compact: boolean) => React.ReactNode; notices?: React.ReactNode;
}> = props => {
  const { state, selected, onSelect, onSettings, onFeedback } = props;
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [sceneMode, setSceneMode] = useState<'3d' | 'static' | 'fallback'>('3d');
  useEffect(() => { const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 600)); if (root.current) observer.observe(root.current); return () => observer.disconnect(); }, []);
  const records = aimeinRecords(state);
  const current = aimeinCurrent(state, selected);
  const runtime = aimeinRuntime(state, current, props.progress, props.connected);
  const summary = current?.aimeinSummary;
  const dataMessages = aimeinDataMessages(current?.aimeinData, current?.detailLoaded === false && !props.detailError);
  const reviewState = current?.aimeinData?.collections['summary.reviews'];
  const reviewerCount = summary ? expectedReviewers(summary) : state.policy?.aimeinReviewers?.length || 3;
  const detail = current?.aimeinRun;
  const planMessage = planWaitingMessage(current, state.running && current?.seq === records.at(-1)?.seq);
  const [tab, setTab] = useState<'live' | 'world' | 'records' | 'reviewers'>(() => records.length || state.running ? 'live' : 'world');
  const [libraryVisited, setLibraryVisited] = useState(false);
  const [calibration, setCalibration] = useState<{ id: string; serial: number }>();
  const [panelOpen, setPanelOpen] = useState(true);
  const panelToggle = useRef<HTMLButtonElement>(null);
  const panelContent = useRef<HTMLDivElement>(null);
  const observatory = useRef<HTMLElement>(null);
  const openTab = (value: typeof tab) => { props.onCloseExternal?.(); setPanelOpen(true); setTab(value); };
  const openLibrary = () => { setLibraryVisited(true); openTab('reviewers'); };
  const [object, setObject] = useState<AimeinAnchor>({ kind: 'goal', seq: 0 });
  const historical = !!current && current !== records.at(-1);
  const play = useAimeinPlay(state, current, props.busy || props.readOnly || state.running || historical, props.execKey, onFeedback);
  const chooseTool = (tool: AimeinTool) => {
    play.setTool(tool); openTab('world');
    // 等新工具内容挂载后定位，避免浏览器滚动锚定把整体意见留在视口上方。
    requestAnimationFrame(() => panelContent.current?.closest('[data-testid="aimein-scene-panel"]')?.scrollTo(0, 0));
  };
  const chooseTarget = (id: string) => { play.pick(id); openTab('world'); };
  const calibrate = (id: string) => { setCalibration(previous => ({ id, serial: (previous?.serial || 0) + 1 })); openLibrary(); };
  const observe = (value: AimeinAnchor) => {
    setObject(value);
    if (play.tool !== 'inspect') play.setTool(value.kind === 'review' ? 'reviewers' : value.kind === 'artifact' ? 'probe' : 'inspect');
    openTab('world');
    if (props.preparation) props.onPreparationStep?.(value.kind === 'goal' ? 1 : value.kind === 'review' ? 2 : value.kind === 'infra' ? 0 : 3);
    requestAnimationFrame(() => {
      const panel = panelContent.current?.closest<HTMLElement>('[data-testid="aimein-scene-panel"]');
      if (panel && observatory.current && !props.preparation) panel.scrollTop += observatory.current.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
    });
  };
  useEffect(() => { if (props.preparationStep != null) setPanelOpen(true); }, [props.preparationStep, props.preparationRevision]);
  const wasRunning = useRef(state.running);
  useEffect(() => {
    if (state.running && !wasRunning.current && !historical) { setTab('live'); setPanelOpen(true); }
    wasRunning.current = state.running;
  }, [state.running, historical]);
  useEffect(() => { panelContent.current?.closest('[data-testid="aimein-scene-panel"]')?.scrollTo(0, 0); }, [tab]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedbackMessage, setFeedbackMessage] = useState<Record<string, string>>({});
  const anchor = { ...object, seq: current?.seq || 0 };
  const anchorKey = `${anchor.seq}:${anchor.kind}:${anchor.reviewId || ''}`;
  const review = summary?.reviews.find(r => r.id === object.reviewId);
  const fullReview = detail?.reviews?.find(r => r.id === object.reviewId);
  const observation = goalObservation(current);
  const selectedOpinions = state.addons.filter(a => a.feedback?.seq === anchor.seq && a.feedback.kind === anchor.kind && (a.feedback.reviewId || '') === (anchor.reviewId || ''));
  const opinions = state.addons.filter(a => a.feedback?.kind);
  const runtimePanel = <AimeinRuntimePanel compact={compact} state={state} current={current} connected={props.connected} progress={props.progress} onSelect={onSelect} detailError={props.detailError} onRetry={props.onRetry} />;
  const livePanel = !props.preparation && (tab === 'live' || tab === 'records' && !!current && !summary);
  return <div ref={root} data-testid="aimein-workbench" style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: compact ? 4 : 8, minWidth: 0, minHeight: 0, background: '#102625', borderRadius: 14,
    '--theme-bg-secondary': '#142d2c', '--theme-bg-tertiary': '#1d3730', '--theme-border': '#35574e', '--theme-text-muted': '#9bb7aa', '--theme-accent-bg': '#29483c' } as React.CSSProperties}>
    {props.controls?.(compact)}
    {props.notices}
    {!!dataMessages.length && <details data-testid="aimein-data-status" style={{ ...muted, color: '#e4c696', padding: '5px 10px', flexShrink: 0 }}>
      <summary style={{ cursor: 'pointer' }}>部分记录数据待核对 · {dataMessages[0]}</summary>
      <div style={{ maxHeight: 100, overflow: 'auto' }}>{dataMessages.slice(1).map(message => <div key={message}>{message}</div>)}缺少的数据不计入完成或验收。{props.detailError && <div>{props.detailError} <button style={button} onClick={props.onRetry}>重新读取详情</button></div>}</div>
    </details>}
    <header style={{ display: props.externalPanel ? 'none' : 'flex', gap: 5, alignItems: 'center', flexShrink: 0, overflowX: 'auto', whiteSpace: 'nowrap' }}>
      {!props.preparation && <nav aria-label="AIMEIN 视图" style={{ display: 'flex', gap: 5 }}>
        {([['live', '运行现场'], ['world', '建设场景'], ['records', '阶段记录'], ['reviewers', '评委工坊']] as const).map(([key, label]) => <button key={key} aria-label={label} style={{ ...button, ...(compact ? { padding: '5px 7px', fontSize: 11 } : {}), background: tab === key ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)', fontWeight: tab === key ? 700 : 400 }} aria-pressed={tab === key} onClick={() => key === 'reviewers' ? openLibrary() : openTab(key)}>{key === 'live' && runtime.live ? '● ' : ''}{compact ? ({ live: '运行', world: '观察', records: '阶段', reviewers: '评委' })[key] : label}</button>)}
      </nav>}
      <button ref={panelToggle} type="button" style={{ ...button, marginLeft: 'auto', ...(compact ? { padding: '5px 7px', fontSize: 11 } : {}) }} aria-expanded={panelOpen && !props.externalPanel} onClick={() => { props.onCloseExternal?.(); setPanelOpen(!panelOpen || !!props.externalPanel); }}>{panelOpen && !props.externalPanel ? '收起面板' : props.preparation ? '继续建设准备' : '展开观察'}</button>
    </header>
    <AimeinSceneDock live={livePanel} balanced={livePanel} sceneMinHeight={compact && sceneMode !== '3d' ? livePanel ? sceneMode === 'fallback' ? 200 : 180 : 244 : 0} open={panelOpen && !props.externalPanel} scene={<AimeinWorld contained onModeChange={setSceneMode} observing={tab === 'live' || props.externalPanel} reviewerCount={reviewerCount} preparing={!!props.preparation} current={current} selected={anchor} running={runtime.live} latest={current?.seq === records.at(-1)?.seq} goal={runtime.goal} activityLabel={runtime.title} built={records.some(r => r.seq <= (current?.seq || 0) && r.orchestration.some(step => step.status === 'done'))} onSelect={observe}
      play={!props.preparation ? { tool: play.tool, targetId: play.targetId, assembled: play.tool === 'assemble' ? play.closure.ids : [], roots: play.draft.ids, onTool: chooseTool, onTarget: chooseTarget, onInspectTarget: id => { play.inspect(id); openTab('world'); },
        footprints: records.slice(-12).map(r => ({ seq: r.seq, title: r.aimeinSummary?.title || '等待规划', accepted: !!r.aimeinSummary?.accepted, saved: r.detailLoaded === false ? null : r.orchestration.filter(s => s.status === 'done' && s.output).length })),
        onHistory: seq => { onSelect(seq); play.setTool('inspect'); openTab('world'); },
        launch: historical ? { label: '返回当前', disabled: false, reason: '历史只供观察', onClick: () => onSelect(records.at(-1)!.seq) } : props.launch } : undefined} />}>
    <div ref={panelContent} style={livePanel ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } : undefined} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setPanelOpen(false); panelToggle.current?.focus(); } }}>
    {props.preparation || <>
    {tab === 'live' && runtimePanel}
    {tab === 'world' && <div>
      <AimeinPlayPanel play={play} current={current} progress={props.progress} historical={historical} running={state.running}
        onReview={id => observe({ kind: 'review', reviewId: id, seq: current?.seq || 0 })} onCalibrate={calibrate} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {records.length > 0 && <label style={muted}>观察时间 <select aria-label="查看 AIMEIN 阶段" style={{ ...button, maxWidth: '100%' }} value={current!.seq} onChange={e => onSelect(Number(e.target.value))}>
          {records.slice().reverse().map(r => <option key={r.seq} value={r.seq}>{r.aimeinSummary ? `Sprint ${r.aimeinSummary.sprintNumber} · 尝试 ${r.aimeinSummary.attempt}` : `准备 #${r.seq}`} · 第 {r.round} 轮</option>)}
        </select></label>}
        {current && current !== records.at(-1) && <button style={button} onClick={() => onSelect(records.at(-1)!.seq)}>返回最新阶段</button>}
        <span style={{ ...muted, marginLeft: 'auto' }}>{state.running ? '◉ 正在建设' : state.resumable ? '◌ 等待继续' : '◇ 工坊待命'}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'start' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'grid', gap: 14, order: 2 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 14 }}>
        <section aria-label="阶段成熟度" style={panel}>
          <div style={muted}>{summary ? `Sprint ${summary.sprintNumber} · 尝试 ${summary.attempt}` : '下一个可用的结果'}</div>
          <h3 style={{ margin: '6px 0', fontSize: 15 }}>{summary?.title || '等待第一张建设蓝图'}</h3>
          <b style={{ fontSize: 28 }}>{summary?.maturityTarget == null ? '—' : `${summary.maturityTarget}%`}</b> <span style={muted}>本阶段目标成熟度</span>
          <p style={muted}>{summary?.maturityMeaning || '动态拆解目标，让每个阶段都有具体可核实的结果。'}</p><div style={muted}>只针对当前 Sprint 范围，不代表整体完成率。</div>
        </section>
        <section aria-label="评审验收" style={panel}>
          <div style={muted}>评委席 · 独立观察同版成果</div><h3 style={{ margin: '6px 0 14px', fontSize: 15 }}>{!summary ? '尚未开始评审' : reviewState === 'missing' || reviewState === 'invalid' ? '评审状态待核对' : `${summary.reviews.filter(r => r.status === 'passed').length} / ${reviewerCount || '待确认'} 通过`}</h3>
          {(summary?.reviews || []).map(r => <button key={r.id} style={{ ...button, display: 'block', width: '100%', textAlign: 'left', marginTop: 6 }} onClick={() => observe({ kind: 'review', reviewId: r.id, seq: current!.seq })}>{r.profileName || r.model} <span style={muted}>· {reviewStatus[r.status] || r.status}</span></button>)}
          <p style={muted}>{summary?.message || '可为每个模型建立口味与聚焦档案，逐步积累可校准的经验。'}</p>
        </section>
      </div>
        </div>
      <div style={{ display: 'grid', flex: '2 1 500px', minWidth: 0, alignContent: 'start', gap: 14 }}>
        <section ref={observatory} aria-label="场景观察" style={panel}>
          <div style={{ ...muted, fontSize: 10, letterSpacing: 2 }}>OBSERVATORY · {current ? `ATTEMPT ${current.seq}` : 'BLUEPRINT'}</div>
          <h3 style={{ fontSize: 17, margin: '6px 0 12px' }}>{labels[object.kind]}{review ? ` · ${review.profileName || review.model}` : ''}</h3>
          {object.kind === 'goal' && <>
            <p style={{ fontSize: 14, lineHeight: 1.8 }}>{detail?.goal || (current && current !== records.at(-1) ? '旧记录未保存整体目标原文，请结合下方子目标和当时依据查看。' : state.goal) || '先在目标准备中写下要建设的产品。'}</p>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><strong style={{ fontSize: 28 }}>{observation.known ? `${observation.verified} / ${observation.total}` : '—'}</strong><span style={muted}>整体子目标已核实</span></div>
            <p style={muted}>目标瓶表示所查看版本的评审观察，证据未齐时保持未知。工具数量和阶段成熟度不会填满它。</p>
            {observation.fraction === 1 && !summary?.complete && <p style={muted}>子目标已覆盖，整体收口条件尚未满足。</p>}
            {!props.detailError && planMessage && <p role="status" style={muted}>{planMessage}</p>}
            {detail?.plan?.targets?.map(target => <details key={target.id} style={muted}><summary style={{ cursor: 'pointer' }}>{target.title}</summary><p>{target.acceptance}</p><p>依赖：{target.dependsOn.join('、') || '可独立推进'}</p></details>)}
          </>}
          {(object.kind === 'flow' || object.kind === 'infra') && <>
            <p style={{ fontSize: 14, lineHeight: 1.8 }}>{(object.kind === 'flow' ? summary?.flowBuild : summary?.infra) || '下一次规划将在这里形成建设范围。'}</p>
            {summary?.criteria.filter(c => c.lane === object.kind).map(c => <p key={c.id} style={muted}><b>{c.id}</b> · {c.acceptance}</p>)}
            <p style={muted}>选中范围 → 逐步实施 → 独立核实。已完成的实施保留，缺口进入修补。</p>
          </>}
          {object.kind === 'artifact' && <>
            <p style={muted}>每次迭代留下的实施和审计记录。版本：{summary?.artifact?.digest?.slice(0, 16) || '待核对'} · {summary?.artifact?.files ?? '—'} 个文件</p>
            {current?.orchestration.map(step => <details key={step.index} style={muted}><summary style={{ cursor: 'pointer' }}>{step.status === 'done' ? '▣' : '◇'} {step.desc}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{step.output || props.progress[`${current.seq}:step${step.index}`] || '尚无保存输出'}</pre></details>)}
            {!current && <p style={muted}>开始建设后，成果与使用过的工具记录会留在这里。</p>}
          </>}
          {object.kind === 'review' && <>
            <p style={{ fontSize: 14 }}>{review ? reviewStatus[review.status] || review.status : '尚未开始评审'}{review?.maturity != null ? ` · 阶段成熟度 ${review.maturity}%` : ''}</p>
            <p style={muted}>{review?.error || review?.summary || '启用的评委分别独立查看同一版成果。'}</p>
            {fullReview?.profile && <p style={muted}><b>口味</b> {fullReview.profile.flavor}<br /><b>聚焦</b> {fullReview.profile.focus}<br />冻结版本 v{fullReview.profile.revision?.slice(0, 8)}</p>}
            {fullReview?.criteria?.map(c => <details key={c.id} style={muted}><summary style={{ cursor: 'pointer' }}>{c.id} · {c.status === 'verified' ? '已核实' : '待处理'}</summary><p>{c.reason}<br />{c.evidence.join(' · ')}</p></details>)}
            <button style={{ ...button, marginTop: 10 }} onClick={() => object.reviewId ? calibrate(object.reviewId) : openLibrary()}>查看档案与校准</button>
          </>}
          {props.detailError && <p role="alert" style={muted}>{props.detailError} <button style={button} onClick={props.onRetry}>重新读取详情</button></p>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 16 }}>
            <button style={button} onClick={() => openTab('records')}>查看完整阶段记录</button>
            <button style={button} onClick={onSettings}>{summary ? '评审与执行设置' : '配置评审组'}</button>
          </div>
        </section>
        <section style={panel} aria-label="对象意见">
          <div style={{ ...muted, fontSize: 10, letterSpacing: 2 }}>YOUR INPUT → NEXT ITERATION</div>
          <h3 style={{ margin: '6px 0 12px', fontSize: 17 }}>对{labels[object.kind]}说点什么</h3>
          <p style={muted}>建议保留对象与阶段来源，进入下一次规划。你可以在下方看到它如何被理解、纳入和核实。</p>
          <form onSubmit={async e => {
            e.preventDefault(); const value = (drafts[anchorKey] || '').trim(); if (!value || props.busy || props.readOnly) return;
            const key = anchorKey; setFeedbackMessage(prev => ({ ...prev, [key]: '正在提交…' }));
            try {
              const result = await onFeedback(value, anchor);
              setFeedbackMessage(prev => ({ ...prev, [key]: result.status === 'ok' ? '已保存，下一次规划会收敛这条意见。' : result.message || '结果未确认，草稿保留，请先核对意见流。' }));
              if (result.status === 'ok') setDrafts(prev => ({ ...prev, [key]: '' }));
            } catch (error: any) { setFeedbackMessage(prev => ({ ...prev, [key]: error.message || '提交失败，草稿保留' })); }
          }}>
            <label style={muted}>你的意见<textarea aria-label="对象建议" required rows={4} maxLength={4000} style={{ ...input, resize: 'vertical' }} value={drafts[anchorKey] || ''} onChange={e => setDrafts({ ...drafts, [anchorKey]: e.target.value })} placeholder="哪里符合你的期待？哪里需要调整？可以描述希望看到的行为。" /></label>
            <button type="submit" disabled={props.busy || props.readOnly || !(drafts[anchorKey] || '').trim()} style={{ ...button, marginTop: 10 }}>交给下一次迭代</button>
          </form>
          {feedbackMessage[anchorKey] && <p role="status" style={muted}>{feedbackMessage[anchorKey]}</p>}
          {selectedOpinions.map(a => <p key={a.id} style={muted}><b>{statuses[a.feedback!.status] || '待确认'}</b> · {a.text}</p>)}
        </section>
      </div>
      </div>
      {!!records.length && <section style={panel} aria-label="建设足迹"><div style={muted}>建设足迹 · 每一次尝试都有保留</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>{records.slice(-12).map(r => <button key={r.seq} style={{ ...button, borderColor: r === current ? 'var(--theme-accent)' : 'var(--theme-border)' }} onClick={() => onSelect(r.seq)}>{r.aimeinSummary?.accepted ? '▣' : '◇'} #{r.seq} · {r.aimeinSummary?.title.slice(0, 18)}</button>)}</div>
      </section>}
      {!!opinions.length && <section style={panel} aria-label="意见流"><h3 style={{ fontSize: 15, marginTop: 0 }}>意见正在变成什么</h3>
        {opinions.map(a => <div key={a.id} style={{ borderTop: '1px solid var(--theme-border)', padding: '12px 0' }}>
          <span style={muted}>{labels[a.feedback!.kind]} · 来源 #{a.feedback!.seq || '目标准备'} → {statuses[a.feedback!.status] || '待确认'}</span>
          <p style={{ fontSize: 13 }}>{a.text}</p>{a.feedback!.reason && <p style={muted}>{a.feedback!.reason}</p>}
          {!!a.feedback!.resultSeq && <button style={button} onClick={() => { onSelect(a.feedback!.resultSeq!); openTab('records'); }}>查看处理尝试 #{a.feedback!.resultSeq}</button>}
          {!!a.feedback!.history?.length && <details style={muted}><summary>处理轨迹</summary>{a.feedback!.history.map((h, i) => <p key={i}>#{h.resultSeq} · {statuses[h.status]} · {h.reason}<br />关联条件：{h.criteriaIds.join('、') || '未纳入本阶段'}</p>)}</details>}
        </div>)}
      </section>}
      {(summary?.issues.length || current?.error || summary?.noProgress || state.stage === 'loopout') ? <section style={panel} aria-label="建设状态">
        <strong>{summary?.complete ? '整体目标评审通过' : state.stage === 'loopout' ? '本轮已停止' : '接下来需要处理'}</strong><p style={muted}>{current?.error || state.stopReason || summary?.message}</p>
        {summary?.issues.map((i, n) => <p key={n} style={muted}>{i.model} · {i.reason}</p>)}
        {!!summary?.noProgress && <p style={muted}>连续 {summary.noProgress} 次未确认新增进展，重复阶段不计作成长。</p>}
      </section> : null}
      {props.extra}
    </div>}
    {tab === 'records' && (current && !summary ? runtimePanel : <AimeinRecordView {...props} />)}
    {libraryVisited && <div hidden={tab !== 'reviewers'}><AimeinReviewLibrary active={tab === 'reviewers' && panelOpen && !props.externalPanel} state={state} current={current} backends={props.backends} execKey={props.execKey} disabled={props.busy || props.readOnly || state.running}
      load={props.loadLibrary} update={props.updateLibrary} calibration={calibration} /></div>}
    </>}
    </div>
    </AimeinSceneDock>
  </div>;
};
