import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { api } from '../api';
import { useLoopControl } from '../hooks/useLoopControl';
import { markdownToHtml } from '../utils/markdown';
import { ImagePreview } from './ImagePreview';
import { useClipboardImage } from './../hooks/useClipboardImage';
import type { ImageAttachment } from './../hooks/useClipboardImage';
import { LoopPolicyEditor, normalizePolicy } from './LoopPolicyEditor';
import type { LoopPolicy } from './LoopPolicyEditor';
import { LoopProgressNotice, LoopDeliveryDetail } from './LoopDeliveryStatus';
import { LoopDecisionNotice, LoopSourceCard } from './LoopContinuationStatus';
import { LoopTaskBlockerDetail } from './LoopTaskBlockerDetail';
import { LoopEnvironmentCard, EnvironmentEvidence } from './LoopExecutionEnvironment';
import type { ModelRuntime } from './CodexRuntimeFields';
import { activeLoopSeq, CALL_PHASE, CALL_ERROR, type CallDiagnostic } from '../utils/loopDiagnostics';
import { AppModalVisibilityContext } from './AppModalPortal';
import {
  AdvancedPromptTextarea,
  type AdvancedPromptTextareaProps,
} from './AdvancedPromptTextarea';

import type { LoopStep, LoopRecord, StageDetail, DetailTarget, Addon, AddonImage, LoopStateT } from '../types/loopWorkbench';
import { useLoopWorkbenchState } from '../hooks/useLoopWorkbenchState';
import { loopWorkbenchView, boundedText, loopSubstageLabel, type WorkbenchSection } from '../utils/loopWorkbenchView';
import { loopControlTarget } from '../api';
import { controlKey } from '../utils/loopControl';
import { LoopControlStatus } from './LoopControlStatus';
import { LoopWorkbench } from './LoopWorkbench';

const SUB_LABEL: Record<string, string> = {
  prepare: 'Prepare', execute: 'Execute', analysis: 'Analysis', done: 'Done',
};
const SUB_ORDER = ['prepare', 'execute', 'analysis', 'done'];

export interface LoopPanelProps {
  onRefreshBackends?: () => void;
  sessionId: string;
  headerActions?: React.ReactNode;
  controlFeedback?: React.ReactNode;
  onClose?: () => void;
  embedded?: boolean;   // true = 作为会话内容内嵌渲染（无浮层、无关闭按钮）
  inspectOnly?: boolean; // true = 人工接管期间的只读总览（只查阅目标与证据，不暴露状态变更操作）
  sessionBackendId?: string;
  sessionRuntime?: ModelRuntime;
  backends?: any[];
  workingDir?: string;
  execKey?: string;
}

interface LoopPromptContextValue {
  sessionId: string;
  workingDir?: string;
  execKey?: string;
}

const LoopPromptContext = React.createContext<LoopPromptContextValue>({ sessionId: '' });
type LoopPromptTextareaProps = Omit<
  AdvancedPromptTextareaProps,
  'sessionId' | 'workingDir' | 'execKey'
>;

const LoopPromptTextarea: React.FC<LoopPromptTextareaProps> = (props) => {
  const context = useContext(LoopPromptContext);
  return <AdvancedPromptTextarea {...context} {...props} />;
};


export const LoopPanel: React.FC<LoopPanelProps> = props => {
  const identity = controlKey(loopControlTarget(props.sessionId, props.execKey));
  return <LoopPanelContent key={identity} {...props} identity={identity} />;
};

const LoopPanelContent: React.FC<LoopPanelProps & { identity: string }> = ({
  sessionId, onClose, embedded, inspectOnly = false, sessionBackendId, sessionRuntime, backends,
  workingDir, execKey, headerActions, controlFeedback, onRefreshBackends, identity,
}) => {
  const visible = useContext(AppModalVisibilityContext);
  const [section, setSection] = useState<WorkbenchSection | null>(null);
  const [visited, setVisited] = useState<Set<WorkbenchSection>>(new Set());
  const trigger = useRef<HTMLElement | null>(null);
  const [ideaInput, setIdeaInput] = useState('');
  const [goalDraft, setGoalDraft] = useState('');
  const [nextGoal, setNextGoal] = useState<string | null>(null);
  const [refineNext, setRefineNext] = useState(false);
  const [actionBusy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const control = useLoopControl(sessionId, execKey, !inspectOnly && visible);
  const busy = actionBusy || control.busy;
  const { state, loadError, refresh, selectedSeq, selectLoop, detailTarget, setDetailTarget, detailErrors, retryDetail, progress } =
    useLoopWorkbenchState(sessionId, control.target.executor, identity, visible, section === 'process' || section === 'evidence');
  useEffect(() => { setNextGoal(null); }, [state?.round]);
  const once = useCallback(async (request: () => Promise<{ status: string; message?: string }>) => {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true);
    try { const result = await request(); if (result.status !== 'ok' && result.message) alert(result.message); return result; }
    catch (error) { alert(String(error)); }
    finally { actionPending.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    if (inspectOnly || !control.state.summary?.operation?.committed || control.state.summary.controlMode !== 'loop') return;
    if (loadError) control.viewReady(loadError);
    else if (state?.sessionId === sessionId && state.controlMode !== 'manual') control.viewReady();
  }, [sessionId, inspectOnly, state, loadError, control.state.phase, control.state.summary?.controlRevision]);

  const openSection = (value: WorkbenchSection, seq?: number, target: DetailTarget = 'all') => {
    if (!section && document.activeElement instanceof HTMLElement) trigger.current = document.activeElement;
    setVisited(previous => new Set([...previous, value]));
    setSection(value);
    if (value === 'process' || value === 'evidence') {
      const chosen = seq ?? selectedSeq ?? (value === 'evidence' ? state?.loops.at(-1)?.seq : undefined);
      if (chosen != null) selectLoop(chosen, target);
    }
  };
  const closeSection = () => { setSection(null); requestAnimationFrame(() => trigger.current?.focus()); };
  const running = state?.running ?? false;
  const setAuto = useCallback((on: boolean) => once(() => api.loopSetAuto(sessionId, on)), [sessionId, once]);
  const addAddon = useCallback((text: string, images?: ImageAttachment[]) => api.loopAddAddon(sessionId, text, images), [sessionId]);
  const editAddon = useCallback((id: string, text: string, images?: any[]) => api.loopEditAddon(sessionId, id, text, images), [sessionId]);
  const removeAddon = useCallback((id: string) => api.loopRemoveAddon(sessionId, id), [sessionId]);
  const continueRound = useCallback(async (goal: string) => {
    await once(() => api.loopContinue(sessionId, goal));
  }, [sessionId, once]);

  const submitIdea = useCallback(async (images?: ImageAttachment[]) => {
    const text = ideaInput.trim();
    if (!text && !(images && images.length)) return;
    setIdeaInput('');
    await api.loopSubmitIdea(sessionId, text, images);
  }, [ideaInput, sessionId]);

  const sealIdea = useCallback(async () => {
    if (!window.confirm('确认目标后进入执行准备，不能退回想法阶段。继续？')) return;
    await once(async () => { const result = await api.loopSealIdea(sessionId, goalDraft.trim()); if (result.status === 'ok') setGoalDraft(''); return result; });
  }, [sessionId, goalDraft]);

  const runIteration = useCallback(async () => {
    await once(() => api.loopRunIteration(sessionId));
  }, [sessionId]);

  const takeover = useCallback(async (nextRoundGoal: string = '') => {
    const fromLoopout = state?.stage === 'loopout';
    if (!window.confirm(
      fromLoopout
        ? '开启新一轮并切换到普通会话进行人工处理？\n\n本轮会记录为 Manual LOOP；完成后可交还给自动 LOOP。'
        : '切换到普通会话进行人工接管？\n\n人工对话和工具操作会作为一轮 Manual LOOP 留在时间线中，完成后可交还 LOOP。'
    )) return;
    await control.request('takeover', fromLoopout ? nextRoundGoal.trim() : '');
  }, [control.request, state?.stage]);

  const discardLoop = useCallback(async () => {
    // seq=0 的执行端语义始终是最近一次，不能用历史未完成记录判断磁盘快照。
    const target = state?.loops[state.loops.length - 1];
    const hasGit = !!target?.hasGitCheckpoint;
    if (!window.confirm(
      `停止并删除最近一次 Loop #${target?.seq}？\n` +
      '· 这次 loop 记录与结果不保存\n' +
      '· 它消费的补充（addon）退回「待纳入」\n' +
      '· agent 上下文回滚到本次开跑前（不污染后续 loop）'
    )) return;
    let restoreFiles = false;
    if (hasGit) {
      restoreFiles = window.confirm(
        '同时把工作目录文件回滚到本次 loop 开跑前？\n\n' +
        '确定 = 用开跑前的 git 快照恢复工作树：丢弃本次 loop 的文件改动、删除它新建的文件\n' +
        '（开跑前你已有的改动/未跟踪文件会保留，.gitignore 忽略的文件不动）。\n\n' +
        '取消 = 仅丢弃记录/addon/上下文，保留磁盘上的文件改动。'
      );
    }
    await once(() => api.loopDiscard(sessionId, 0, restoreFiles));
  }, [sessionId, state]);

  const advanceOut = useCallback(async () => {
    const prompt = running
      ? '当前 Loop 仍在执行。停止它、保留已完成步骤的结果并进入本轮结果？'
      : '结束本轮并查看已保留成果？未完成事项仍会保留。';
    if (!window.confirm(prompt)) return;
    await once(() => api.loopAdvanceToOut(sessionId));
  }, [sessionId, running]);

  const saveGoal = useCallback(async () => {
    await api.loopSetGoal(sessionId, goalDraft.trim());
  }, [sessionId, goalDraft]);

  const refineGoal = useCallback(async (hint: string, images?: ImageAttachment[]) => {
    return api.loopRefineGoal(sessionId, hint, images);
  }, [sessionId]);


  const wrap = (children: React.ReactNode) => embedded
    ? <div className="awu-loop" style={embeddedShell}>{children}</div>
    : <div style={overlay}><div className="awu-loop" style={shell}>{children}</div></div>;
  if (!state) return wrap(<div style={{ padding: 20, color: 'var(--theme-text)' }}>
    {controlFeedback ?? <LoopControlStatus sessionId={sessionId} execKey={execKey} onReload={() => void refresh()} />}
    <strong>LOOP 工作台</strong><p>{loadError || '正在加载 LOOP 状态…'}</p>
    {loadError && <button style={btn} onClick={() => void refresh()}>重试加载 LOOP 面板</button>}
    {onClose && <button style={btn} onClick={onClose}>关闭</button>}
  </div>);
  const view = loopWorkbenchView(state, { readOnly: inspectOnly, controlPending: control.busy, controlError: control.state.error });
  const readOnly = view.manual;
  const canTakeover = !busy && control.state.summary?.eligibility.takeover.allowed === true;
  const takeoverReason = control.state.summary?.eligibility.takeover.message || control.state.error || '正在核对接管条件…';
  const latest = state.loops.at(-1);
  const selected = state.loops.find(loop => loop.seq === selectedSeq);
  const labels: Record<string, string> = { manual: '返回人工工作区', check: '检查控制状态', running: '本轮执行中', seal: '确认目标，进入执行',
    continue: state.running ? '停止上一轮并开启新一轮' : '开启新一轮', issues: '处理当前问题', resume: '继续未完成步骤', run: '运行下一次' };
  const primary = () => {
    switch (view.primary) {
      case 'manual': onClose?.(); break;
      case 'check': void control.check(); break;
      case 'seal': void sealIdea(); break;
      case 'continue': void continueRound(nextGoal ?? state.goal); break;
      case 'issues': openSection('issues'); break;
      case 'resume': case 'run': void runIteration(); break;
    }
  };
  const sourceLocked = readOnly || busy || state.running || state.resumable;
  const feedback = controlFeedback ?? <LoopControlStatus sessionId={sessionId} execKey={execKey} onReload={() => void refresh()} onChat={onClose} />;
  const issueList = <div>
    {section === 'issues' && feedback}
    {view.issues.filter(issue => issue.id !== 'control').map(issue => <section key={issue.id} style={{ ...sealBox, marginBottom: 10 }}>
      <strong>{issue.title}</strong><p>{issue.reason}</p><p>{issue.next}</p>
      <button style={btn} onClick={() => openSection(issue.section)}>查看相关{issue.section === 'settings' ? '设置' : '证据'}</button>
      <details style={{ marginTop: 8 }}><summary>关联依据</summary>{issue.refs.map(ref => <div key={ref}>{ref}</div>)}</details>
    </section>)}
    {!view.issues.length && <p>当前摘要没有待处理问题；这不代表完整验收。</p>}
    {!readOnly && !state.running && state.stage === 'loopexecute' && <div style={sealBox}>
      <p>查看、核对或修改设置不会自动恢复。处理条件后显式继续，执行端仍会检查原有授权、来源和环境门槛。</p>
      <button style={btn} disabled={busy || view.issues.some(issue => issue.priority < 30)}
        onClick={() => void runIteration()}>{state.resumable ? '按原条件恢复断点' : '按原条件运行下一次'}</button>
    </div>}
  </div>;
  const header = <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
      <strong style={{ fontSize: 14 }}>LOOP 工作台</strong>
      <span data-testid="loop-current-status">{view.status}</span><span>第 {state.round} 轮 · Auto {state.auto ? '开' : '关'}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{headerActions}{onClose && <button style={btn} onClick={onClose}>关闭总览</button>}</div>
    </div>
    <div data-testid="loop-goal-summary" style={{ marginTop: 8, fontSize: 15, lineHeight: 1.5, fontWeight: 600 }}>{boundedText(state.goal, 160) || '先整理想法，确认这次想完成什么'}</div>
    <div role="group" aria-label="LOOP 统一操作" style={{ position: 'relative', display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
      <button style={{ ...primaryBtn, opacity: busy || view.primary === 'running' ? 0.6 : 1 }}
        disabled={view.primary === 'running' || (busy && view.primary !== 'check') || view.primary === 'check' && control.state.checking}
        onClick={primary}>{labels[view.primary]}</button>
      {!readOnly && state.stage !== 'loopidea' && <>
        <button style={btn} disabled={busy} onClick={() => void setAuto(!state.auto)}>
          {state.auto ? '停止后续自动执行' : '开启 Auto'}</button>
        {state.stage === 'loopexecute' && <button style={btn} disabled={busy} onClick={() => void advanceOut()}>
          {state.running ? '停止本轮并查看结果' : '结束本轮并查看结果'}</button>}
      </>}
      <button style={btn} onClick={() => openSection('settings')}>任务设置</button>
      {!readOnly && <details style={{ position: 'relative', marginLeft: 'auto' }}>
        <summary style={{ ...btn, listStyle: 'none' }}>更多操作</summary>
        <div data-testid="loop-more-actions" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 5, width: 240, maxWidth: '80vw',
          ...sealBox, boxShadow: '0 6px 20px #0004', marginTop: 6 }}>
          <button style={btn} disabled={!canTakeover} onClick={() => void takeover(nextGoal ?? state.goal)}>
            {state.stage === 'loopout' ? `✋ 开启人工轮（第 ${state.round + 1} 轮）` : '✋ 人工接管'}</button>
          {!canTakeover && <p role="status" style={{ fontSize: 12 }}>人工接管：{takeoverReason}</p>}
          {!!state.loops.length && <button style={{ ...btn, color: '#f87171', marginTop: 8 }} disabled={busy}
            onClick={() => void discardLoop()}>丢弃本次记录…</button>}
        </div>
      </details>}
    </div>
    {!readOnly && state.stage !== 'loopidea' && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--theme-text-muted)' }}>
      {state.stage === 'loopout' ? (state.auto ? '新一轮将按当前 Auto 设置自动连跑。' : '新一轮沿用手动逐次执行。')
        : state.running ? '关闭 Auto 只停止后续自动执行，不等于当前调用已退出。' : state.resumable ? '继续当前断点，保留已完成步骤。' : '执行仍由当前节点的既有授权和恢复条件约束。'}
    </div>}
  </>;
  const details = <>
    {(section === 'process' || section === 'evidence') && <>
      <LoopProgressNotice guard={state.progressGuard} handoff={state.handoff} />
      {!selected && <LoopDecisionNotice decision={latest?.decision} blockerSummary={latest?.blockerSummary}
        callResults={latest?.callResults} taskResult={latest?.taskResult} />}
      {!!state.loops.length && <nav aria-label="流程轮次切换" style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', gap: 8,
        flexWrap: 'wrap', padding: '8px 0', background: 'var(--theme-bg-secondary)' }}>
        <label>查看轮次 <select style={btn} aria-label="查看流程轮次" value={selectedSeq ?? ''}
          onChange={event => selectLoop(Number(event.target.value), detailTarget)}>
          {state.loops.slice().reverse().map(loop => <option key={loop.seq} value={loop.seq}>第 {loop.round} 轮 · Loop #{loop.seq}</option>)}
        </select></label>
        <button style={btn} onClick={() => selectLoop(latest!.seq, detailTarget)}>返回最新 Loop</button>
      </nav>}
      {section === 'process' && <LoopFlowView state={state} selectedSeq={selectedSeq} setSelectedSeq={selectLoop} />}
      {selected && <LoopDetail key={selected.seq} loop={selected} progress={progress} target={detailTarget} onTarget={setDetailTarget}
        error={detailErrors[selected.seq!]?.message} onRetry={retryDetail} onClose={closeSection} />}
      {!state.loops.length && section === 'evidence' && <p>尚无执行记录。</p>}
    </>}
    <div hidden={section !== 'goal'}>
      {visited.has('goal') && <>
        <GoalCard state={state} readOnly={readOnly || busy} goalDraft={goalDraft}
          setGoalDraft={setGoalDraft} onSaveGoal={saveGoal} onRefineGoal={refineGoal} />
        {!readOnly && <IntentBanner state={state} sessionId={sessionId} />}
        <AddonHistoryCard addons={state.addons || []} loops={state.loops} />
        {readOnly && (state.addons || []).filter(addon => addon.status === 'pending').map(addon => <section key={addon.id} style={sealBox}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>待纳入补充 · 只读</div><div>{addon.text}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>{(addon.images || []).map((im, index) =>
            <img key={im.id || index} alt="待纳入补充图片" src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
              style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 5 }} />)}</div>
        </section>)}
      </>}
    </div>
    <div hidden={section !== 'settings'}>
      {visited.has('settings') && <>
        <LoopSourceCard sessionId={sessionId} execKey={execKey} source={state.taskSource} readOnly={sourceLocked} />
        <LoopEnvironmentCard sessionId={sessionId} execKey={execKey} environment={state.executionEnvironment} resumable={state.resumable}
          readOnly={readOnly || busy || state.running || !!state.executionEnvironment?.checking} />
        <PolicyCard onRefreshBackends={onRefreshBackends} sessionId={sessionId} policy={state.policy} readOnly={readOnly || busy}
          sessionBackendId={sessionBackendId} sessionRuntime={sessionRuntime} backends={backends} />
        <details><summary>诊断指标（不是验收）</summary><div>当前分数 {state.latestScore} · 历史最高分 {state.bestScore} · 风险 {state.riskCoefficient} · 本轮预算 {state.roundLoopCount}/{state.effectiveMaxLoops}</div></details>
      </>}
    </div>
    {section === 'issues' && issueList}
  </>;
  return wrap(<LoopPromptContext.Provider value={{ sessionId, workingDir, execKey }}>
    <LoopWorkbench header={header} section={section} onSection={value => value ? openSection(value) : closeSection()}
      trigger={trigger} details={details}>
      {!!view.issues.length && <section aria-label="需要处理" style={{ ...sealBox, borderColor: '#d2992255', marginBottom: 12 }}>
        <strong>{view.issues[0].title}</strong><div style={{ margin: '6px 0', fontSize: 12 }}>{boundedText(view.issues[0].reason)}</div>
        {view.issues[0].id === 'control' ? section !== 'issues' && feedback : <button style={btn} onClick={() => openSection(view.issues[0].section)}>查看处理依据</button>}
        <button style={{ ...btn, marginLeft: 6 }} onClick={() => openSection('issues')}>
          {view.issues.length > 1 ? `还有 ${view.issues.length - 1} 个问题` : '查看问题详情'}</button>
      </section>}
      {section !== 'issues' && !view.issues.some(issue => issue.id === 'control') && feedback}
      {state.stage === 'loopidea' && !readOnly ? <>
        <div style={{ marginBottom: 12 }}><label style={{ fontSize: 13 }}>本次目标
          <LoopPromptTextarea value={goalDraft} onValueChange={setGoalDraft}
            placeholder="直接写目标，或留空让模型汇总下方想法" containerStyle={{ width: '100%', marginTop: 6 }}
            style={{ ...inputBase, width: '100%', minHeight: 70, boxSizing: 'border-box' }} /></label></div>
        <IdeaStage state={state} ideaInput={ideaInput} setIdeaInput={setIdeaInput} onSubmit={submitIdea} busy={busy}
          onRemove={id => { void api.loopRemoveIdea(sessionId, id); }} />
      </> : <>
        <section style={{ ...sealBox, marginBottom: 12 }} aria-label="当前进展">
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 7 }}>
            {view.current ? `Loop #${view.current.seq} · ${loopSubstageLabel(view.current.subStage)} · ${view.steps}` : '准备执行'}</div>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{view.focus}</div>
          <div data-testid="loop-acceptance" style={{ marginTop: 8, fontSize: 12 }}>{view.acceptance}</div>
          {state.taskSource?.status === 'current' && <div style={{ marginTop: 6, fontSize: 12 }}>来源 {boundedText(state.taskSource.change, 60)} · 正式任务勾选 {state.taskSource.checked ?? '?'}/{state.taskSource.total ?? '?'}（不是验收比例）</div>}
          {view.current?.deliverySummary?.counts && <div style={{ marginTop: 6, fontSize: 12 }}>
            已实现待验 {view.current.deliverySummary.counts.implemented || 0} · 已验证 {view.current.deliverySummary.counts.verified || 0} · 待人工 {view.current.deliverySummary.counts.manual || 0} · 受阻 {view.current.deliverySummary.counts.blocked || 0}</div>}
          {view.current?.analysisPreview?.gaps && <p style={{ fontSize: 12 }}>剩余缺口：{boundedText(view.current.analysisPreview.gaps)}</p>}
          {view.current?.analysisPreview?.nextFocus && <p style={{ fontSize: 12 }}>下一步：{boundedText(view.current.analysisPreview.nextFocus)}</p>}
          {state.stage === 'loopout' && <p style={{ fontSize: 12 }}>停止原因：{boundedText(state.stopReason) || '旧记录未提供原因；请核对证据'}</p>}
          {state.stage === 'loopout' && view.current?.resultPreview && <p style={{ fontSize: 12 }}>已保留成果：{boundedText(view.current.resultPreview)}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button style={btn} onClick={() => openSection('process')}>过程与历史</button>
            <button style={btn} onClick={() => openSection('evidence', undefined, 'analysis')}>成果与证据</button>
            <button style={btn} onClick={() => openSection('goal')}>目标与补充</button>
          </div>
        </section>
        {state.stage === 'loopout' && !readOnly && <section style={{ ...sealBox, marginBottom: 12 }}>
          <label style={{ fontSize: 13 }}>新一轮目标
            <LoopPromptTextarea value={nextGoal ?? state.goal} onValueChange={setNextGoal}
              placeholder="新一轮目标（支持 @ 文件/SESSION；默认沿用上一轮，可修改或追加）"
              containerStyle={{ marginTop: 6, width: '100%' }} style={{ ...inputBase, width: '100%', minHeight: 70, boxSizing: 'border-box' }} /></label>
          <button style={{ ...btn, marginTop: 6 }} onClick={() => setRefineNext(true)}>微调新一轮目标</button>
          {refineNext && <RefineBox onRefineGoal={refineGoal} onResult={setNextGoal} onCancel={() => setRefineNext(false)} />}
        </section>}
        {!readOnly && <details style={{ ...sealBox, fontSize: 12 }}><summary style={{ cursor: 'pointer' }}>
          补充要求 · {(state.addons || []).filter(addon => addon.status === 'pending').length} 条待纳入</summary>
          <p>纳入下一次适用规划；不修改当前已开始的调用。</p>
          <AddonPanel addons={state.addons || []} onAdd={addAddon} onRemove={removeAddon} onEdit={editAddon} />
        </details>}
      </>}
    </LoopWorkbench>
  </LoopPromptContext.Provider>);
};

// ══ 意图守卫提示横幅（非阻塞）═══════════════════════════════════
const IntentBanner: React.FC<{ state: LoopStateT; sessionId: string }> = ({ state, sessionId }) => {
  const a = state.intentAlert;
  const [busy, setBusy] = useState(false);
  if (!a || a.dismissed || a.aligned || !(a.severity === 'medium' || a.severity === 'high')) return null;
  const high = a.severity === 'high';
  const col = high ? '#f87171' : '#bf8700';
  const adopt = async () => {
    const hint = [a.suggestion, a.divergence ? `（针对偏差：${a.divergence}）` : ''].filter(Boolean).join(' ').trim();
    if (!hint) return;
    setBusy(true);
    const r = await api.loopRefineGoal(sessionId, hint);
    setBusy(false);
    if (r.status === 'ok') api.loopDismissIntent(sessionId);
    else if (r.message) alert(r.message);
  };
  return (
    <div className="awu-reveal" style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: `${col}1a`, border: `1px solid ${col}55` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: col }}>⚠️ 意图可能跑偏（{high ? '高' : '中'}）</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => api.loopDismissIntent(sessionId)} style={miniX} title="知道了，关闭">✕</button>
      </div>
      {a.divergence && <div style={{ fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.55 }}>{a.divergence}</div>}
      {a.suggestion && <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginTop: 4, lineHeight: 1.55 }}>建议：{a.suggestion}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        {a.suggestion && (
          <button onClick={adopt} disabled={busy}
            style={{ ...primaryBtn, padding: '6px 12px', background: col, opacity: busy ? 0.6 : 1 }}>
            {busy ? '⏳ 微调中…' : '✨ 采纳建议（微调目标）'}
          </button>
        )}
        <span style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>
          不打断执行。采纳会请求模型微调目标；也可手动编辑。正常停止与危险的丢弃记录是独立操作。
        </span>
      </div>
    </div>
  );
};

const Badge: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <div style={{
    alignSelf: 'center', padding: '4px 12px', borderRadius: 14, fontSize: 12, fontWeight: 600,
    color, background: `${color}1f`, border: `1px solid ${color}55`,
  }}>{text}</div>
);

// ══ Idea stage ════════════════════════════════════════════════
const IdeaStage: React.FC<{
  state: LoopStateT; ideaInput: string; setIdeaInput: (v: string) => void;
  onSubmit: (images?: ImageAttachment[]) => void; busy: boolean;
  onRemove: (id: string) => void;
}> = ({ state, ideaInput, setIdeaInput, onSubmit, busy, onRemove }) => {
  const runningCount = state.ideas.filter((i) => i.status === 'running').length;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage(inputRef);
  const submit = () => {
    if (!ideaInput.trim() && images.length === 0) return;
    onSubmit(images); clearImages();
  };
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--theme-text-muted)', margin: '0 0 12px' }}>
        也可以投递想法和参考图片，由模型分别展开。
        {runningCount > 0 && <span style={{ color: 'var(--theme-accent)' }}> · {runningCount} 个进行中</span>}
      </p>

      {images.length > 0 && <ImagePreview images={images} onRemove={removeImage} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'flex-end' }}>
        <LoopPromptTextarea
          textareaRef={inputRef}
          value={ideaInput}
          onValueChange={setIdeaInput}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
          placeholder="一条想法/方向…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
          containerStyle={{ flex: 1 }}
          style={{ ...inputBase, width: '100%', minHeight: 56, resize: 'vertical' }}
        />
        <button onClick={submit} disabled={busy || (!ideaInput.trim() && images.length === 0)}
          style={{ ...primaryBtn, opacity: (ideaInput.trim() || images.length) ? 1 : 0.5 }}>投递</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 24 }}>
        {state.ideas.length === 0 && (
          <div style={{ color: 'var(--theme-text-muted)', fontSize: 13 }}>还没有想法，先投递几条吧。</div>
        )}
        {state.ideas.map((idea) => (
          <div key={idea.id} style={ideaCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <StatusDot status={idea.status} />
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{idea.status}</span>
              <div style={{ flex: 1 }} />
              <button disabled={busy} onClick={() => onRemove(idea.id)} style={miniX} title="删除">✕</button>
            </div>
            {(idea.images || []).length > 0 && (
              <div style={{ display: 'flex', gap: 4, marginBottom: 5, flexWrap: 'wrap' }}>
                {(idea.images || []).map((im, i) => (
                  <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                    style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                ))}
              </div>
            )}
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 4 }}>{idea.prompt}</div>
            {idea.result && <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{idea.result}</div>}
            {idea.error && <div style={{ fontSize: 12, color: '#f87171' }}>{idea.error}</div>}
          </div>
        ))}
      </div>


    </div>
  );
};

// ══ Addon 面板（执行中补充要求）═══════════════════════════════
const AddonPanel: React.FC<{
  addons: Addon[]; onAdd: (text: string, images?: ImageAttachment[]) => void; onRemove: (id: string) => void;
  onEdit: (id: string, text: string, images?: any[]) => Promise<{ status: string; message?: string }>;
}> = ({ addons, onAdd, onRemove, onEdit }) => {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage(inputRef);
  const pending = addons.filter((a) => a.status === 'pending');
  const submit = () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    setText(''); onAdd(t, images); clearImages();
  };
  return (
    <div style={{ ...sealBox, marginBottom: 16, borderColor: pending.length ? '#bf870055' : 'var(--theme-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>📌 执行中补充 (addon)</span>
        {pending.length > 0 && (
          <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#bf87001f', color: '#bf8700', border: '1px solid #bf870055' }}>
            {pending.length} 条待纳入
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
        支持粘贴图片；纳入下一次适用规划，不改变当前调用。纳入前可编辑或移除，已纳入内容见「目标与补充」。
      </div>
      {images.length > 0 && <ImagePreview images={images} onRemove={removeImage} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: pending.length ? 12 : 0, alignItems: 'flex-end' }}>
        <LoopPromptTextarea
          textareaRef={inputRef}
          value={text}
          onValueChange={setText}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
          placeholder="补充要求 / 修正…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
          containerStyle={{ flex: 1 }}
          style={{ ...inputBase, width: '100%', minHeight: 56, maxHeight: 160, resize: 'vertical', lineHeight: 1.5 }}
        />
        <button onClick={submit} disabled={!text.trim() && images.length === 0}
          style={{ ...primaryBtn, padding: '8px 14px', opacity: (text.trim() || images.length) ? 1 : 0.5 }}>＋ 添加</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pending.map((a) => (
          <AddonItem key={a.id} addon={a} onRemove={() => onRemove(a.id)} onEdit={onEdit} />
        ))}
      </div>
    </div>
  );
};

// 单条待纳入 addon：默认收成 2 行（上行缩略素材 + 下行截断文字），可点开展开 / 编辑
const AddonItem: React.FC<{
  addon: Addon; onRemove: () => void;
  onEdit: (id: string, text: string, images?: any[]) => Promise<{ status: string; message?: string }>;
}> = ({ addon, onRemove, onEdit }) => {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(addon.text);
  const [keptImgs, setKeptImgs] = useState<AddonImage[]>(addon.images || []);
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { images: newImgs, removeImage, clearImages } = useClipboardImage(editRef);
  const imgs = addon.images || [];

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setText(addon.text === '（图片）' ? '' : addon.text);
    setKeptImgs(addon.images || []);
    clearImages();
    setEditing(true);
  };
  const save = async () => {
    const combined = [
      ...keptImgs.map((i) => ({ id: i.id, base64: i.base64, mime_type: i.mime_type })),
      ...newImgs.map((i) => ({ id: i.id, base64: i.base64, mime_type: i.mime_type })),
    ];
    if (!text.trim() && combined.length === 0) return;
    setSaving(true);
    const r = await onEdit(addon.id, text.trim(), combined);
    setSaving(false);
    if (r.status === 'ok') { clearImages(); setEditing(false); }
    else if (r.message) alert(r.message);
  };

  if (editing) {
    return (
      <div className="awu-reveal" style={{ padding: '8px 10px', borderRadius: 8, background: '#bf87000d', border: '1px solid #bf870055' }}>
        {(keptImgs.length > 0 || newImgs.length > 0) && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
            {keptImgs.map((im, i) => (
              <div key={im.id || i} style={{ position: 'relative' }}>
                <img src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                  style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                <button onClick={() => setKeptImgs((p) => p.filter((x) => x !== im))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', border: 'none', background: '#f87171', color: '#fff', fontSize: 10, cursor: 'pointer', lineHeight: '16px', padding: 0 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {newImgs.length > 0 && <ImagePreview images={newImgs} onRemove={removeImage} />}
        <LoopPromptTextarea
          textareaRef={editRef}
          value={text}
          onValueChange={setText}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); }}
          placeholder="编辑补充…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
          autoFocus
          containerStyle={{ width: '100%' }}
          style={{ ...inputBase, width: '100%', minHeight: 54, maxHeight: 160, resize: 'vertical', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={save} disabled={saving || (!text.trim() && keptImgs.length === 0 && newImgs.length === 0)}
            style={{ ...primaryBtn, padding: '6px 14px', opacity: saving ? 0.5 : 1 }}>{saving ? '保存中…' : '保存'}</button>
          <button onClick={() => { setEditing(false); clearImages(); }} style={btn}>取消</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', borderRadius: 8, background: '#bf87000d', border: '1px solid #bf870033' }}>
      <span style={{ fontSize: 12, color: '#bf8700', marginTop: 2 }}>●</span>
      <div style={{ flex: 1, minWidth: 0, cursor: imgs.length || addon.text.length > 60 ? 'pointer' : 'default' }}
        onClick={() => setOpen((v) => !v)}>
        {imgs.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: open ? 'wrap' : 'nowrap', overflow: 'hidden' }}>
            {imgs.map((im, i) => (
              <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                style={{ width: open ? 56 : 30, height: open ? 56 : 30, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)', flexShrink: 0 }} />
            ))}
          </div>
        )}
        <div style={{
          fontSize: 13, color: 'var(--theme-text)', lineHeight: 1.5,
          whiteSpace: open ? 'pre-wrap' : 'nowrap',
          overflow: open ? 'visible' : 'hidden', textOverflow: open ? 'clip' : 'ellipsis',
        }}>{addon.text}</div>
        {!open && (imgs.length > 0 || addon.text.length > 40) && (
          <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>点开看全部{imgs.length ? ` · 🖼️${imgs.length}` : ''}</span>
        )}
      </div>
      <button onClick={startEdit} style={miniX} title="编辑">✎</button>
      <button onClick={onRemove} style={miniX} title="删除">✕</button>
    </div>
  );
};

// ══ Addon 历史：哪一轮(第几轮 / 哪次 loop)纳入了哪些补充，随时可展开 ═══
const AddonHistoryCard: React.FC<{ addons: Addon[]; loops: LoopRecord[] }> = ({ addons, loops }) => {
  const [open, setOpen] = useState(false);
  const applied = addons.filter((a) => a.status === 'applied');
  if (applied.length === 0) return null;
  const roundOf = (seq: number) => loops.find((l) => l.seq === seq)?.round ?? 1;
  const groups = new Map<number, Addon[]>();
  applied.forEach((a) => {
    const arr = groups.get(a.appliedSeq) || [];
    arr.push(a); groups.set(a.appliedSeq, arr);
  });
  const seqs = Array.from(groups.keys()).sort((x, y) => y - x);  // 最近纳入的在上
  return (
    <div style={{ ...sealBox, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setOpen(!open)}
          style={{ ...linkBtn, fontWeight: 700, fontSize: 13, color: 'var(--theme-text)' }}>
          {open ? '▾' : '▸'} 📌 Addon 历史
        </button>
        <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{applied.length} 条已纳入 · 跨 {seqs.length} 次 loop</span>
      </div>
      {open && (
        <div className="awu-reveal" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {seqs.map((seq) => (
            <div key={seq}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--theme-accent)', marginBottom: 4 }}>
                第 {roundOf(seq)} 轮 · 由 Loop #{seq} 纳入（{groups.get(seq)!.length} 条）
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {groups.get(seq)!.map((a) => (
                  <div key={a.id} style={{ display: 'flex', gap: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
                    <span style={{ fontSize: 11, color: '#2da44e', marginTop: 1 }}>✓</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {(a.images || []).length > 0 && (
                        <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                          {(a.images || []).map((im, i) => (
                            <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                              style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                          ))}
                        </div>
                      )}
                      <span style={{ fontSize: 12.5, color: 'var(--theme-text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{a.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ══ Goal card：全局目标 + 演变历史 + 按提示微调 + 原始诉求回看 ═══
const SRC_LABEL: Record<string, { t: string; c: string }> = {
  seal: { t: '封口汇总', c: '#0969da' },
  refine: { t: '提示微调', c: '#8957e5' },
  manual: { t: '手动', c: '#bf8700' },
};

function relTime(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// ══ 策略与心智卡片：实时查看 / 调整 ═══════════════════════════
const PolicyCard: React.FC<{
  onRefreshBackends?: () => void;
  sessionId: string;
  policy?: LoopPolicy;
  readOnly?: boolean;
  sessionBackendId?: string;
  sessionRuntime?: ModelRuntime;
  backends?: any[];
}> = ({ sessionId, policy, readOnly = false, sessionBackendId, sessionRuntime, backends, onRefreshBackends }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LoopPolicy>(() => normalizePolicy(policy));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 外部（loopUpdated）更新 policy 时，未在编辑则同步进草稿
  useEffect(() => { if (!dirty) setDraft(normalizePolicy(policy)); }, [policy, dirty]);
  const p = normalizePolicy(policy);
  const save = async () => {
    setSaving(true);
    const r = await api.loopSetPolicy(sessionId, normalizePolicy(draft));
    setSaving(false);
    if (r.status === 'ok') setDirty(false);
    else if (r.message) alert(r.message);
  };
  return (
    <div style={{ ...sealBox, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {readOnly ? (
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--theme-text)' }}>⚙️ 策略与心智</span>
        ) : (
          <button onClick={() => { if (!open) onRefreshBackends?.(); setOpen(!open); }}
            style={{ ...linkBtn, fontWeight: 700, fontSize: 13, color: 'var(--theme-text)' }}>
            {open ? '▾' : '▸'} ⚙️ 策略与心智
          </button>
        )}
        <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          诊断阈值 {p.deliverableScore}/{p.outputtableScore}（不代替验收） · 最多 {p.maxLoops} loop · 风险≥{p.riskThreshold.toFixed(2)} 收口 · 评审{p.independentEval ? '独立防自欺' : '常规'}{Object.values(p.backends || {}).some(Boolean) ? ' · 异构 Backend' : ''}{Object.values(p.runtimes || {}).some((r) => r?.model || r?.reasoningEffort) ? ' · 模型分档' : ''}
        </span>
      </div>
      {open && !readOnly && (
        <div className="awu-reveal" style={{ marginTop: 10 }}>
          <LoopPolicyEditor value={draft} onChange={(v) => { setDraft(v); setDirty(true); }}
            availableBackends={backends} sessionBackendId={sessionBackendId} sessionRuntime={sessionRuntime} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving || !dirty}
              style={{ ...primaryBtn, opacity: (saving || !dirty) ? 0.5 : 1 }}>
              {saving ? '保存中…' : '保存策略'}
            </button>
            {dirty && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>改动未保存 · 不影响进行中的 loop，从下一次起生效</span>}
          </div>
        </div>
      )}
      {readOnly && <details style={{ marginTop: 8 }}><summary>查看只读策略配置</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(p, null, 2)}</pre></details>}
    </div>
  );
};

// 按提示让模型微调目标的输入框（GoalCard 与 loopout 新一轮共用）
const RefineBox: React.FC<{
  onRefineGoal: (hint: string, images?: ImageAttachment[]) => Promise<{ status: string; goal?: string; message?: string }>;
  onResult?: (goal: string) => void;   // 拿到微调结果（loopout 用来同步本地草稿）
  onCancel: () => void;
}> = ({ onRefineGoal, onResult, onCancel }) => {
  const [hint, setHint] = useState('');
  const [refining, setRefining] = useState(false);
  const refineRef = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage(refineRef);
  const doRefine = async () => {
    const h = hint.trim();
    if (!h && images.length === 0) return;
    setRefining(true);
    const r = await onRefineGoal(h, images.length ? images : undefined);
    setRefining(false);
    if (r.status === 'ok') { if (r.goal) onResult?.(r.goal); setHint(''); clearImages(); onCancel(); }
    else if (r.message) alert(r.message);
  };
  return (
    <div className="awu-reveal" style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-accent)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--theme-text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
        给一句提示，由模型在「当前目标 + 原始诉求」基础上自动改写。支持贴图（Snipaste/粘贴）作为参考。每次微调都会留一版历史。
      </div>
      <LoopPromptTextarea textareaRef={refineRef} autoFocus value={hint} onValueChange={setHint} disabled={refining}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doRefine(); }}
        placeholder="微调提示…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
        containerStyle={{ width: '100%' }}
        style={{ ...inputBase, width: '100%', minHeight: 50, resize: 'vertical', opacity: refining ? 0.6 : 1 }} />
      <ImagePreview images={images} onRemove={removeImage} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={doRefine} disabled={refining || (!hint.trim() && images.length === 0)} style={{ ...primaryBtn, opacity: (refining || (!hint.trim() && images.length === 0)) ? 0.5 : 1 }}>
          {refining ? '⏳ 微调中…' : '✨ 让模型微调'}
        </button>
        <button onClick={onCancel} disabled={refining} style={btn}>取消</button>
      </div>
    </div>
  );
};

const GoalCard: React.FC<{
  state: LoopStateT;
  readOnly?: boolean;
  onRefineGoal: (hint: string, images?: ImageAttachment[]) => Promise<{ status: string; goal?: string; message?: string }>;
  goalDraft: string; setGoalDraft: (v: string) => void; onSaveGoal: () => void;
}> = ({ state, readOnly = false, onRefineGoal, goalDraft, setGoalDraft, onSaveGoal }) => {
  const [mode, setMode] = useState<'view' | 'refine' | 'edit'>('view');
  const [showHist, setShowHist] = useState(false);
  const [showIdeas, setShowIdeas] = useState(false);
  const history = state.goalHistory || [];
  const ideas = state.ideas || [];

  return (
    <div style={{ ...sealBox, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>🎯 全局目标</span>
        {history.length > 0 && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>v{history.length}</span>}
        <div style={{ flex: 1 }} />
        {mode === 'view' && !readOnly && (
          <>
            <button onClick={() => setMode('refine')} style={{ ...btn, ...btnActive }} title="给一句提示，让模型在当前目标+原始诉求基础上自动微调">✨ 微调目标</button>
            <button onClick={() => { setMode('edit'); setGoalDraft(state.goal); }} style={btn} title="手动改写">编辑</button>
          </>
        )}
      </div>

      {/* 当前目标 */}
      <div style={{ fontSize: 13, color: state.goal ? 'var(--theme-text)' : 'var(--theme-text-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
        {state.goal || '（封口后由模型收敛中…稍候自动出现）'}
      </div>

      {/* 按提示微调（引导模型，无需人手编辑） */}
      {mode === 'refine' && !readOnly && (
        <RefineBox onRefineGoal={onRefineGoal} onCancel={() => setMode('view')} />
      )}

      {/* 手动编辑（兜底） */}
      {mode === 'edit' && !readOnly && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <LoopPromptTextarea value={goalDraft} onValueChange={setGoalDraft}
            containerStyle={{ flex: 1 }} style={{ ...inputBase, width: '100%', minHeight: 54 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={() => { onSaveGoal(); setMode('view'); }} style={primaryBtn}>保存</button>
            <button onClick={() => setMode('view')} style={btn}>取消</button>
          </div>
        </div>
      )}

      {/* 折叠入口：目标演变 + 原始诉求 */}
      <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
        {history.length > 1 && (
          <button onClick={() => setShowHist(!showHist)} style={linkBtn}>
            {showHist ? '▾' : '▸'} 目标演变（{history.length} 版）
          </button>
        )}
        {ideas.length > 0 && (
          <button onClick={() => setShowIdeas(!showIdeas)} style={linkBtn}>
            {showIdeas ? '▾' : '▸'} 原始诉求（{ideas.length} 条）
          </button>
        )}
      </div>

      {showHist && history.length > 0 && (
        <div className="awu-reveal" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {history.map((g, i) => {
            const sl = SRC_LABEL[g.source] || SRC_LABEL.manual;
            const cur = i === history.length - 1;
            return (
              <div key={i} style={{ padding: '8px 10px', borderRadius: 8, background: cur ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)', border: `1px solid ${cur ? 'var(--theme-accent)' : 'var(--theme-border)'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: sl.c, borderRadius: 4, padding: '1px 6px' }}>v{i + 1} · {sl.t}</span>
                  {cur && <span style={{ fontSize: 10, color: 'var(--theme-accent)', fontWeight: 600 }}>当前</span>}
                  <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>{relTime(g.createdAt)}</span>
                </div>
                {g.hint && <div style={{ fontSize: 11.5, color: 'var(--theme-text-muted)', marginBottom: 4 }}>提示：{g.hint}</div>}
                <div style={{ fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{g.goal}</div>
              </div>
            );
          })}
        </div>
      )}

      {showIdeas && ideas.length > 0 && (
        <div className="awu-reveal" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>封口前投递的想法 / 原始诉求（全局目标由此收敛而来）：</div>
          {ideas.map((it) => (
            <div key={it.id} style={{ padding: '7px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
              {(it.images || []).length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                  {(it.images || []).map((im, i) => (
                    <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                      style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: 'var(--theme-text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{it.prompt}</div>
              {it.result && <div style={{ fontSize: 11.5, color: 'var(--theme-text-muted)', marginTop: 4, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>↳ {it.result}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// 进行中需要实时刷新耗时：active 时每秒 tick
function useNow(active: boolean): number {
  const visible = useContext(AppModalVisibilityContext);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active || !visible) return;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [active, visible]);
  return now;
}

const FLOW_STATUS_COLOR: Record<string, string> = {
  done: '#2da44e', running: '#0969da', error: '#f87171', current: '#bf8700', pending: 'var(--theme-text-muted)',
  retrying: '#bf8700', degraded: '#bf8700',
};
const STAGE_STATUS_LABEL: Record<string, string> = { done: '已完成', running: '进行中', retrying: '规划重试中', degraded: '已降级', error: '失败', current: '待继续', pending: '未开始' };

function stageStatus(loop: LoopRecord, stage: string, live: boolean): string {
  if (loop.error && stage === loop.subStage) return 'error';
  const explicit = loop.stageDetails?.[stage]?.status;
  if (explicit) return explicit === 'running' && !live ? 'current' : explicit;
  const index = SUB_ORDER.indexOf(stage);
  const current = SUB_ORDER.indexOf(loop.subStage);
  if (loop.error && index === current) return 'error';
  if (stage === 'prepare' && (current > 0 || loop.completed) && !loop.orchestration.length) return 'degraded';
  if (stage === 'execute' && loop.orchestration.some(step => step.status === 'error')) return 'error';
  if (loop.completed || index < current) return 'done';
  return index === current ? (live ? 'running' : 'current') : 'pending';
}

const LoopFlowView: React.FC<{
  state: LoopStateT; selectedSeq: number | null; setSelectedSeq: (v: number | null, target?: DetailTarget) => void;
}> = ({ state, selectedSeq, setSelectedSeq }) => {
  const now = useNow(state.running);
  const loops = state.loops;
  // 当前真正在跑的 loop（用于脉冲 / 动线）
  const activeSeq = activeLoopSeq(state);

  if (loops.length === 0) {
    return <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, padding: '20px 0' }}>尚无执行记录，可从工作台开始第一次运行。</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginBottom: 10 }}>
        每条泳道是一次 loop 的执行流程；颜色表状态，<span style={{ color: '#0969da' }}>蓝色脉冲 = 正在执行</span>，节点下标注耗时。点节点看详情。
      </div>
      {loops.slice().reverse().map((loop, i, arr) => {
        const newRound = state.round > 1 && (i === 0 || arr[i - 1].round !== loop.round);
        return (
          <React.Fragment key={loop.seq}>
            {newRound && (
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', borderRadius: 6, padding: '3px 10px', alignSelf: 'flex-start', margin: '6px 0' }}>
                第 {loop.round} 轮
              </div>
            )}
            {i > 0 && !newRound && (
              <div style={{ width: 2, height: 14, background: 'var(--theme-border)', marginLeft: 28 }} />
            )}
            <FlowLane loop={loop} live={loop.seq === activeSeq} now={now}
              selected={loop.seq === selectedSeq}
              onSelect={target => setSelectedSeq(loop.seq, target)} />
          </React.Fragment>
        );
      })}
    </div>
  );
};

const FlowLane: React.FC<{
  loop: LoopRecord; live: boolean; now: number; selected: boolean; onSelect: (target?: DetailTarget) => void;
}> = ({ loop, live, now, selected, onSelect }) => {
  const order = ['prepare', 'execute', 'analysis'];
  const sub = loop.subStarted || {};
  const done = loop.completed;

  const nstatus = (i: number): string => stageStatus(loop, order[i], live);
  // 子阶段耗时：start 到下一阶段 start（或进行中到 now / 完成到 done）
  const subDur = (i: number): number => {
    const starts = [sub.prepare ?? loop.createdAt, sub.execute, sub.analysis];
    const st = starts[i];
    if (!st) return 0;
    const nextStart = i < 2 ? starts[i + 1] : (sub.done ?? (done ? loop.updatedAt : undefined));
    const end = nextStart ?? (live && (nstatus(i) === 'running' || nstatus(i) === 'retrying') ? now : loop.updatedAt);
    return end ? end - st : 0;
  };

  const score = loop.analysis?.scoreObserved === false || loop.blockerSummary?.status ? null : loop.analysis?.score ?? null;
  if (loop.kind === 'manual') {
    const duration = (loop.subStarted?.execute && loop.updatedAt)
      ? fmtDur(loop.updatedAt - loop.subStarted.execute) : '';
    return (
      <div className="awu-card" style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : '#d2992255'}`,
      }}>
        <FlowChip title={`Manual #${loop.seq}`} status={loop.completed ? 'done' : 'current'}
          sub={`${loop.orchestration.length} 次人工交互`} big onSelect={() => onSelect('all')} />
        <FlowEdge active={false} done={loop.completed} />
        <FlowChip title="人工接管" status={loop.completed ? 'done' : 'current'} dur={duration}
          onSelect={() => onSelect('all')}
          sub={loop.completed ? '已交还 LOOP' : '接管中'} steps={loop.orchestration} now={now}
          tag={<BackendTag role="execute" label={loop.backendLabels?.execute} />} />
      </div>
    );
  }
  return (
    <div className="awu-card" role="group" aria-label={`Loop #${loop.seq} 流程`} data-selected={selected}
      style={{
        display: 'flex', alignItems: 'stretch', gap: 0, padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
        overflowX: 'auto',
      }}>
      {/* loop 头节点 */}
      <FlowChip title={`Loop #${loop.seq}`} status={done ? 'done' : (loop.error ? 'error' : (live ? 'running' : 'current'))}
        onSelect={() => onSelect('all')}
        sub={score != null ? `score ${score.toFixed(0)}` : (live ? '进行中' : loop.error ? '已中断' : done ? '已完成' : '未完成')} big />
      <FlowEdge active={nstatus(0) === 'running'} done={nstatus(0) !== 'pending'} />
      <FlowChip title="Prepare" status={nstatus(0)} dur={fmtDur(subDur(0))}
        onSelect={() => onSelect('prepare')} sub={STAGE_STATUS_LABEL[nstatus(0)]}
        tag={<BackendTag role="prepare" label={loop.backendLabels?.prepare} />} />
      <FlowEdge active={nstatus(1) === 'running'} done={nstatus(1) !== 'pending'} />
      {/* Execute：含分步 */}
      <FlowChip title="Execute" status={nstatus(1)} dur={fmtDur(subDur(1))}
        onSelect={() => onSelect('execute')} onSelectStep={index => onSelect(`step${index}`)}
        sub={loop.orchestration.length ? `${loop.orchestration.filter((s) => s.status === 'done').length}/${loop.orchestration.length} 步` : undefined}
        steps={loop.orchestration} now={live ? now : loop.updatedAt} liveSteps={live}
        tag={<BackendTag role="execute" label={loop.backendLabels?.execute} />} />
      <FlowEdge active={nstatus(2) === 'running'} done={nstatus(2) !== 'pending'} />
      <FlowChip title="Analysis" status={nstatus(2)} dur={fmtDur(subDur(2))}
        onSelect={() => onSelect('analysis')}
        sub={score != null ? `score ${score.toFixed(0)}` : undefined}
        tag={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />} />
    </div>
  );
};

const FlowEdge: React.FC<{ active: boolean; done: boolean }> = ({ active, done }) => (
  <div style={{ alignSelf: 'center', flexShrink: 0, width: 34, height: 2, margin: '0 2px', position: 'relative' }}>
    <div className={active ? 'awu-flow-dash' : undefined}
      style={{
        position: 'absolute', inset: 0,
        background: active ? undefined : (done ? 'var(--theme-accent)' : 'var(--theme-border)'),
      }} />
  </div>
);

const FlowChip: React.FC<{
  title: string; status: string; dur?: string; sub?: string; big?: boolean;
  steps?: LoopStep[]; now?: number; liveSteps?: boolean; tag?: React.ReactNode;
  onSelect?: () => void; onSelectStep?: (index: number) => void;
}> = ({ title, status, dur, sub, big, steps, now, liveSteps = false, tag, onSelect, onSelectStep }) => {
  const col = FLOW_STATUS_COLOR[status] || FLOW_STATUS_COLOR.pending;
  const pulse = status === 'running';
  return (
    <div style={{
      flexShrink: 0, minWidth: big ? 96 : 110, display: 'flex', flexDirection: 'column', gap: 4,
      padding: 0, borderRadius: 10,
      background: 'var(--theme-bg-tertiary)',
      border: `1.5px solid ${col === 'var(--theme-text-muted)' ? 'var(--theme-border)' : col}`,
      boxShadow: pulse ? `0 0 0 0 ${col}` : 'none',
      animation: pulse ? 'awu-flow-pulse 1.3s infinite' : 'none',
    }}>
      <button type="button" onClick={onSelect} aria-label={`查看 ${title} 阶段`} data-stage-status={status}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '12px 10px', border: 0, borderRadius: 10, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0,
          animation: pulse ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text)' }}>{title}</span>
        </span>
      {sub && <span style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>{sub}</span>}
      {dur && <span style={{ fontSize: 10.5, color: col, fontFamily: 'monospace', fontWeight: 600 }}>⏱ {dur}</span>}
      {tag && <span style={{ marginTop: 1 }}>{tag}</span>}
      </button>
      {steps && steps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '0 10px 8px' }}>
          {steps.map((s) => {
            const sc = FLOW_STATUS_COLOR[s.status === 'running' && !liveSteps ? 'current' : s.status] || FLOW_STATUS_COLOR.pending;
            const d = s.startedAt ? ((s.endedAt || (s.status === 'running' ? (now || s.startedAt) : 0)) - s.startedAt) : 0;
            return (
              <button type="button" key={s.index} title={s.desc} aria-label={`查看步骤 ${s.index}：${s.desc}`}
                onClick={() => onSelectStep ? onSelectStep(s.index) : onSelect?.()}
                style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 200, padding: '4px 0', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc, flexShrink: 0,
                  animation: s.status === 'running' && liveSteps ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />
                <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>
                  {s.mode === 'concurrent' && s.access === 'read' ? '∥' : '→'}{s.index}
                  {s.access === 'write' ? ' ✎' : ''}
                </span>
                <span style={{ fontSize: 10, color: 'var(--theme-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{s.desc}</span>
                {d > 0 && <span style={{ fontSize: 9.5, color: sc, fontFamily: 'monospace', flexShrink: 0 }}>{fmtDur(d)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// 把编排步按「连续 concurrent 归并为一个并行组、sequential 各自成组」分组
function groupSteps(steps: LoopStep[]): LoopStep[][] {
  const groups: LoopStep[][] = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].mode === 'concurrent' && steps[i].access === 'read') {
      const g: LoopStep[] = [];
      while (i < steps.length && steps[i].mode === 'concurrent' && steps[i].access === 'read') { g.push(steps[i]); i++; }
      groups.push(g);
    } else {
      groups.push([steps[i]]); i++;
    }
  }
  return groups;
}

const STEP_ICON: Record<string, string> = { pending: '○', running: '⏳', done: '✓', error: '✗' };
const STEP_COLOR: Record<string, string> = { pending: 'var(--theme-text-muted)', running: '#0969da', done: '#2da44e', error: '#f87171' };

const StepRow: React.FC<{ step: LoopStep; live?: string; expanded?: boolean }> = ({ step, live, expanded = false }) => {
  const [open, setOpen] = useState(expanded);
  useEffect(() => { if (expanded) setOpen(true); }, [expanded]);
  const body = step.status === 'running' && live ? live : step.output || live;
  const canExpand = true;
  const description = step.desc?.trim();
  return (
    <div style={{ marginBottom: 6 }}>
      <button type="button" aria-expanded={open} aria-label={`步骤 ${step.index} 详情`}
        onClick={() => (canExpand ? setOpen(!open) : undefined)}
        style={{ display: 'flex', width: '100%', textAlign: 'left', padding: '4px 0', border: 0, background: 'transparent', alignItems: 'baseline', gap: 6, cursor: 'pointer' }}
      >
        <span style={{ color: STEP_COLOR[step.status] || 'var(--theme-text-muted)', fontSize: 13,
          animation: step.status === 'running' ? 'awu-loop-pulse 1.2s infinite' : 'none' }}>
          {STEP_ICON[step.status] || '○'}
        </span>
        <span style={{ fontSize: 11, color: STEP_COLOR[step.status], minWidth: 42 }}>{step.status}</span>
        <span style={{ fontSize: 13, color: description ? 'var(--theme-text)' : '#f59e0b', flex: 1 }}>
          {step.index}. {description || '步骤说明缺失（旧版本规划解析异常）'}
        </span>
        {!!step.attempts && step.attempts > 1 && (
          <span style={{ fontSize: 10.5, color: '#d29922', background: '#d2992218', border: '1px solid #d2992240', borderRadius: 999, padding: '1px 7px' }}>
            自动恢复 {step.attempts - 1} 次
          </span>
        )}
        {canExpand && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{open ? '收起' : '展开'}</span>}
      </button>
      {!!step.recoveryNotes?.length && (
        <div style={{ marginLeft: 22, marginTop: 4, color: '#d29922', fontSize: 11, lineHeight: 1.45 }}>
          {step.recoveryNotes[step.recoveryNotes.length - 1]}
        </div>
      )}
      {open && (
        body && step.status === 'running'
          ? <div style={{ marginLeft: 22, marginTop: 4 }}><Live text={body} /></div>
          : body
            ? <div style={{ marginLeft: 22, marginTop: 4, background: 'var(--theme-code-bg)', borderRadius: 6, padding: '6px 10px' }}><Md text={body} /></div>
            : <div style={{ marginLeft: 22, marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 11 }}>
                {step.status === 'pending' ? '该步骤尚未开始。' : step.status === 'running' ? '正在等待该步骤的新实时输出…' : '该步骤已结束，暂无已加载的文本产出。可通过上方按钮重新加载详情。'}
              </div>
      )}
    </div>
  );
};

const StageAudit: React.FC<{ stage: string; detail?: StageDetail; live?: string }> = ({ stage, detail, live }) => (
  <Section title={`${SUB_LABEL[stage]} · 阶段记录`}>
    {detail?.status && <div style={{ color: FLOW_STATUS_COLOR[detail.status], marginBottom: 6 }}>
      {STAGE_STATUS_LABEL[detail.status] || detail.status}{detail.attemptCount ? ` · ${detail.attemptCount} 次尝试` : ''} · {detail.message}
    </div>}
    {(detail?.attempts || []).map((attempt, index) => (
      <div key={index} style={{ margin: '8px 0', padding: '8px 10px', border: '1px solid var(--theme-border)', borderRadius: 6 }}>
        <div style={{ color: attempt.valid ? '#2da44e' : '#bf8700', fontSize: 12 }}>第 {index + 1} 次 · {attempt.kind === 'initial' ? '首次规划' : attempt.kind === 'retry' ? '重试' : '重规划'} · {attempt.valid ? '结构校验通过' : '结构校验失败'}</div>
        <div style={{ fontSize: 12, margin: '5px 0' }}>{attempt.validation.join(' ')}</div>
        <details><summary style={{ cursor: 'pointer' }}>原始输出 · 第 {index + 1} 次</summary><pre style={auditPreStyle}>{attempt.rawOutput || '（无文本输出）'}</pre></details>
        <details><summary style={{ cursor: 'pointer' }}>解析后的计划 · 第 {index + 1} 次</summary><pre style={auditPreStyle}>{attempt.parsed ? JSON.stringify(attempt.parsed, null, 2) : '未解析出 JSON 对象'}</pre></details>
      </div>
    ))}
    {detail?.validation && <div style={{ marginBottom: 8 }}>{detail.validation.join(' ')}</div>}
    {detail?.rawOutput && <details><summary style={{ cursor: 'pointer' }}>阶段原始输出</summary><pre style={auditPreStyle}>{detail.rawOutput}</pre></details>}
    {detail?.parsed != null && <details><summary style={{ cursor: 'pointer' }}>解析结果</summary><pre style={auditPreStyle}>{JSON.stringify(detail.parsed, null, 2)}</pre></details>}
    {detail?.partialOutput && <details><summary style={{ cursor: 'pointer' }}>中断前的输出尾部（非完整结果）</summary><pre style={auditPreStyle}>{detail.partialOutput}</pre></details>}
    {live && (detail?.status === 'running' || detail?.status === 'retrying' || !detail) && <Live text={live} />}
    {!detail && !live && <div style={{ color: 'var(--theme-text-muted)', fontSize: 12 }}>暂无阶段原文：可能尚未开始，或旧版本未保存；不会把其他阶段的内容当作此阶段结果。</div>}
  </Section>
);
const auditPreStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 350, overflow: 'auto', fontSize: 12, background: 'var(--theme-code-bg)', padding: 10 };

const CallDiagnostics: React.FC<{ calls: CallDiagnostic[]; live: boolean }> = ({ calls, live }) => {
  const [selectedId, setSelectedId] = useState('');
  const call = calls.find(item => item.id === selectedId) || calls[calls.length - 1];
  const active = live && call?.status === 'running';
  const now = useNow(active);
  if (!call) return <div style={{ color: 'var(--theme-text-muted)', fontSize: 12, marginBottom: 12 }}>
    调用诊断暂无记录（阶段尚未调用，或旧版本未采集）。
  </div>;
  const end = call.endedAt || (active ? now : call.observedAt || call.startedAt);
  const elapsed = (from?: number, to?: number) => from && to ? fmtDur(Math.max(0.001, to - from)) : '尚未观察到';
  const wait = (at?: number) => at ? elapsed(call.dispatchedAt, at) : call.dispatchedAt
    ? `尚未观察到 · ${active ? '已等' : '观察到'} ${elapsed(call.dispatchedAt, end)}` : '尚未进入 Backend';
  const counts = call.eventCounts || {};
  return <section aria-label="模型调用诊断" style={{ border: '1px solid var(--theme-border)', borderRadius: 8, padding: 12, marginBottom: 14, overflowWrap: 'anywhere' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <strong>调用诊断</strong>
      <select aria-label="选择调用记录" value={call.id} onChange={event => setSelectedId(event.target.value)} style={{ ...btn, maxWidth: '100%' }}>
        {calls.map((item, index) => <option key={item.id} value={item.id}>{item.stage} · 第 {index + 1} 次调用 · {CALL_PHASE[item.status] || item.status}</option>)}
      </select>
    </div>
    <div style={{ minHeight: 38, color: call.status === 'error' || call.status === 'stalled' ? '#f87171' : 'var(--theme-accent)', fontSize: 12, marginBottom: 8 }}>
      {call.status === 'running' && !live ? '当前已不在运行；以下为最后一次诊断快照' : CALL_PHASE[call.phase] || call.phase}
      {' · '}总耗时 {elapsed(call.startedAt, end)}
      {call.httpStatus ? ` · HTTP ${call.httpStatus}` : ''}
    </div>
    <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '8px 14px', margin: 0, fontSize: 12 }}>
      {[
        ['实际调用', `${call.backendType || '初始化中'} / ${call.model || '尚未解析'}${call.reasoningEffort ? ` / ${call.reasoningEffort}` : ''}`],
        ['本地准备', call.localPrepareMs != null ? fmtDur(call.localPrepareMs / 1000) || '<1ms' : elapsed(call.startedAt, end)],
        ['进入 Backend 后 → 首个可见事件（含错误）', wait(call.firstEventAt)],
        ['进入 Backend 后 → 首段正文', wait(call.firstTextAt)],
        ['最近可见事件距今', call.lastActivityAt ? elapsed(call.lastActivityAt, end) : '尚未观察到'],
        ['本次传入提示', `${call.promptChars.toLocaleString()} 字符 · 约 ${call.estimatedPromptTokens.toLocaleString()} tokens · ${call.imageCount} 张图片`],
        ['Backend 上报用量', call.usage?.inputTokens != null || call.usage?.outputTokens != null
          ? `输入 ${call.usage.inputTokens?.toLocaleString() ?? '未提供'} / 输出 ${call.usage.outputTokens?.toLocaleString() ?? '未提供'} tokens` : '尚未提供实际计数'],
        ['派发时本节点同 Backend 的 LOOP 调用', call.activeLoopCallsAtDispatch != null
          ? `${call.activeLoopCallsAtDispatch} 个（含本次，不含聊天／外部系统，非服务商并发额度）` : '未采集'],
        ['可见事件', `正文 ${counts.text_delta || 0} · 思考 ${counts.thinking || 0} · 工具 ${counts.tool_start || 0} 次启动 / ${counts.tool_result || 0} 次结束`],
        ['输出体量', `正文 ${call.textChars.toLocaleString()} 字符 · 思考 ${call.thinkingChars.toLocaleString()} 字符`],
        ['HTTP 请求／后端重试', `${call.transportAttempts} 次可观测请求 · ${call.retryCount} 次可观测重试 · 计划退避累计 ${call.retryWaitSeconds}s`],
        ['无事件超时设置', call.inactivityTimeoutSeconds ? `${call.inactivityTimeoutSeconds}s（不是整个阶段的总时限）` : '未设置'],
      ].map(([label, value]) => <div key={label}><dt style={{ color: 'var(--theme-text-muted)' }}>{label}</dt><dd style={{ margin: '3px 0 0' }}>{value}</dd></div>)}
    </dl>
    {call.lastError && <div style={{ marginTop: 10, color: '#bf8700', fontSize: 12 }}>
      最近错误证据：{call.lastError.httpStatus ? `HTTP ${call.lastError.httpStatus} · ` : ''}{CALL_ERROR[call.lastError.category] || CALL_ERROR.unknown}
      {call.status === 'done' ? '（调用随后结束；请另看计划校验结果）' : ''}
    </div>}
    <div style={{ marginTop: 10, color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.6 }}>
      提示大小只统计本次传入文本，不含 Agent 隐式系统提示、工具定义及原生历史；tokens 为估算，不是服务商实际计费输入。
      {call.resumedContext ? ' 本次续用原生上下文，其大小未在此计量。' : ''}
      {call.requestBytes != null ? ` 最近 HTTP JSON 约 ${(call.requestBytes / 1024).toFixed(1)} KiB（含附件，不含请求头）。` : ''}
      {' '}进入 Backend／Agent 接受任务不等于服务商已开始推理；没有明确错误时，无法确认内部排队、并发限额或服务商耗时。阶段总时长还可能包括快照、校验及多次规划调用。
    </div>
    <details style={{ marginTop: 8, fontSize: 12 }}><summary style={{ cursor: 'pointer' }}>事件时间线（最近 32 个状态变化，无请求原文／密钥）</summary>
      <ol style={{ paddingLeft: 22 }}>{(call.timeline || []).map((item, index) => <li key={index} style={{ margin: '5px 0' }}>
        +{fmtDur(Math.max(0.001, item.elapsedMs / 1000))} · {CALL_PHASE[item.phase] || item.phase}
        {item.httpStatus ? ` · HTTP ${item.httpStatus}` : ''}{item.attempt ? ` · 第 ${item.attempt} 次` : ''}
        {item.delaySeconds ? ` · 等待 ${item.delaySeconds}s` : ''}
      </li>)}</ol>
      <div>调用 ID：{call.id} · 开始：{new Date(call.startedAt * 1000).toLocaleString()}</div>
    </details>
  </section>;
};

const LoopDetail: React.FC<{
  loop: LoopRecord; progress: Record<string, string>; onClose: () => void;
  target: DetailTarget; onTarget: (target: DetailTarget) => void; error?: string; onRetry: () => void;
}> = ({ loop, progress, onClose, target, onTarget, error, onRetry }) => {
  const liveExec = progress[`${loop.seq}:execute`];
  const livePrep = progress[`${loop.seq}:prepare`];
  const liveAna = progress[`${loop.seq}:analysis`];
  const targetStage = target.startsWith('step') ? 'execute' : target;
  const diagnostics = <CallDiagnostics key={target} live={!!loop.diagnosticLive} calls={(loop.callDiagnostics || []).filter(call =>
    target === 'all' || call.stage === target || (target === 'execute' && call.stage.startsWith('step')))} />;
  const show = (stage: string) => targetStage === 'all' || targetStage === stage;
  const groups = groupSteps(target.startsWith('step') ? loop.orchestration.filter(step => `step${step.index}` === target) : loop.orchestration);
  if (loop.detailLoaded === false) {
    return (
      <div style={{ ...sealBox, marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 12 }}>
        {error ? <span role="alert">{error} <button type="button" style={btn} onClick={onRetry}>重试加载详情</button></span> : `正在按需加载 Loop #${loop.seq} 详情…`}
        <button type="button" onClick={onClose} style={miniX}>✕</button>
        {diagnostics}
      </div>
    );
  }
  if (loop.kind === 'manual') {
    return (
      <div style={{ ...sealBox, marginTop: 4, borderColor: '#d2992255' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#d29922' }}>✋ Manual LOOP #{loop.seq}</span>
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--theme-text-muted)' }}>
            {loop.completed ? '已交还 LOOP' : '人工接管中'}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={miniX}>✕</button>
        </div>
        <Section title="人工上下文与处理步骤">
          {loop.manualContext && (
            <details style={{ marginBottom: 10 }}>
              <summary style={{ cursor: 'pointer', color: '#d29922', fontSize: 12 }}>查看接管时的 LOOP 上下文快照</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, color: 'var(--theme-text-muted)', maxHeight: 220, overflow: 'auto' }}>
                {loop.manualContext}
              </pre>
            </details>
          )}
          {(loop.manualMessages || []).length === 0 ? (
            <span style={{ color: 'var(--theme-text-muted)' }}>尚未发送人工指令。</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {(loop.manualMessages || []).map((message) => (
                <div key={message.id} style={{
                  borderLeft: `3px solid ${message.role === 'user' ? '#d29922' : '#2da44e'}`,
                  padding: '7px 10px', borderRadius: 6, background: 'var(--theme-code-bg)',
                }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--theme-text-muted)', marginBottom: 4 }}>
                    {message.role === 'user' ? '人工指令' : '模型处理'}
                  </div>
                  {message.content ? <Md text={message.content} /> : <span style={{ color: 'var(--theme-text-muted)' }}>（无文本）</span>}
                  {!!message.toolCalls?.length && (
                    <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {message.toolCalls.map((tool, index) => (
                        <details key={`${tool.name}-${index}`}>
                          <summary style={{ cursor: 'pointer', fontSize: 11.5, color: '#58a6ff' }}>
                            ⚙ {tool.name} · {tool.status || 'done'}
                          </summary>
                          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10.5, color: 'var(--theme-text-muted)', margin: '5px 0 0' }}>
                            {[tool.input, tool.output, tool.error].filter(Boolean).join('\n\n')}
                          </pre>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    );
  }
  return (
    <div aria-label={`Loop #${loop.seq} 阶段详情`} style={{ ...sealBox, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text)' }}>Loop #{loop.seq} 详情</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onRetry} style={btn}>重新加载详情</button>
        <button onClick={onClose} style={miniX}>✕</button>
      </div>

      {error && <div role="alert" style={{ color: '#f87171', marginBottom: 8 }}>{error}（保留已加载的内容）</div>}
      {diagnostics}
      <div role="group" aria-label="阶段详情切换" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {(['all', 'prepare', 'execute', 'analysis'] as const).map(stage => <button type="button" key={stage} aria-pressed={targetStage === stage}
          onClick={() => onTarget(stage)} style={{ ...btn, ...(targetStage === stage ? { borderColor: 'var(--theme-accent)', color: 'var(--theme-accent)' } : {}) }}>
          {stage === 'all' ? '全部' : SUB_LABEL[stage]}
        </button>)}
      </div>

      {show('prepare') && <Section title="本次增量焦点">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: loop.evolutionBasis ? 6 : 0 }}>
          <Badge text={loop.iterationMode === 'evolution' ? '增量演进' : '基线核实'} color="#2563eb" />
          <div style={{ flex: 1 }}>{loop.goal ? <Md text={loop.goal} /> : '—'}</div>
        </div>
        {loop.evolutionBasis && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--theme-text-muted)' }}>查看本次冻结的诊断与 Addon</summary>
            <div style={{ marginTop: 6, padding: '7px 9px', background: 'var(--theme-code-bg)', fontSize: 11 }}>
              <Md text={loop.evolutionBasis} />
            </div>
          </details>
        )}
      </Section>}
      {show('prepare') && <StageAudit stage="prepare" detail={loop.stageDetails?.prepare} live={livePrep} />}
      {targetStage === 'prepare' && <Section title="规范化执行计划">
        {loop.orchestration.length ? <ol>{loop.orchestration.map(step => <li key={step.index}>[{step.mode} / {step.access || 'write'}] {step.desc}</li>)}</ol> : '尚未获得有效步骤。'}
      </Section>}

      {show('execute') && <Section title="编排与分步执行（点步可展开产出）" extra={(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <BackendTag role="prepare" label={loop.backendLabels?.prepare} />
          <BackendTag role="execute" label={loop.backendLabels?.execute} />
        </span>
      )}>
        {loop.orchestration.length === 0 ? '尚未获得执行步骤；规划进度请查看 Prepare 阶段。' : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {groups.map((g, gi) => g.length > 1 ? (
              // 并行组：左侧竖条 + 「并行」标识
              <div key={gi} style={{ borderLeft: '3px solid #8957e5', paddingLeft: 10, background: '#8957e50d', borderRadius: 6, padding: '6px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#8957e5', marginBottom: 4 }}>⚡ 并行执行（{g.length} 步同时）</div>
                {g.map((s) => <StepRow key={s.index} step={s} live={progress[`${loop.seq}:step${s.index}`]} expanded={target === `step${s.index}`} />)}
              </div>
            ) : (
              <div key={gi}><StepRow step={g[0]} live={progress[`${loop.seq}:step${g[0].index}`]} expanded={target === `step${g[0].index}`} /></div>
            ))}
          </div>
        )}
      </Section>}

      {show('execute') && <StageAudit stage="execute" detail={loop.stageDetails?.execute} />}
      {show('execute') && <Section title="本次执行结果" extra={<BackendTag role="execute" label={loop.backendLabels?.execute} />}>
        {loop.result ? <Md text={loop.result} />
          : liveExec ? <Live text={liveExec} /> : '—'}
      </Section>}

      {show('analysis') && <StageAudit stage="analysis" detail={loop.stageDetails?.analysis} />}
      {show('analysis') && (loop.analysis ? (
        <Section title={loop.blockerSummary?.status ? '任务级只读复核 · 未执行验收测试' : `累计目标诊断 · 整体分数 ${loop.analysis.score.toFixed(0)}`}
          extra={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', alignSelf: 'center' }}>
              优化空间 {(loop.analysis.optimizationPotential * 100).toFixed(0)}% · 趋势 {loop.analysis.trend || '—'}
            </span>
          </div>
          {loop.analysis.verified && (
            <div style={{ marginBottom: 7, padding: '7px 9px', borderLeft: '3px solid #2da44e', background: '#2da44e0d' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#2da44e', marginBottom: 3 }}>已核实</div>
              <Md text={loop.analysis.verified} />
            </div>
          )}
          {loop.analysis.gaps && (
            <div style={{ marginBottom: 7, padding: '7px 9px', borderLeft: '3px solid #d29922', background: '#d299220d' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#bf8700', marginBottom: 3 }}>剩余缺口</div>
              <Md text={loop.analysis.gaps} />
            </div>
          )}
          {loop.analysis.nextFocus && (
            <div style={{ marginBottom: 7, padding: '7px 9px', borderLeft: '3px solid #2563eb', background: '#2563eb0d' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#2563eb', marginBottom: 3 }}>下一次优先焦点</div>
              <Md text={loop.analysis.nextFocus} />
            </div>
          )}
          {loop.analysis.notes && <Md text={loop.analysis.notes} />}
          {loop.analysis.challenges && <div style={{ fontSize: 12, color: '#bf8700', marginTop: 6 }}>⚠ 约束：{loop.analysis.challenges}</div>}
        </Section>
      ) : liveAna ? <Section title="累计目标诊断（进行中）"
          extra={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />}><Live text={liveAna} /></Section> : null)}

      <LoopDecisionNotice decision={loop.decision} blockerSummary={loop.blockerSummary} callResults={loop.callResults} taskResult={loop.taskResult} steps={loop.outcomeVersion ? loop.orchestration : undefined} />
      <LoopTaskBlockerDetail record={loop} />
      <details data-testid="loop-environment-history"><summary>本轮执行环境证据 · {loop.environmentChecks?.length || 0}</summary>
        {loop.environmentChecks?.length ? loop.environmentChecks.map(check => <EnvironmentEvidence key={check.id} check={check} />) : <EnvironmentEvidence />}
      </details>
      {(target === 'all' || target === 'analysis') && <LoopDeliveryDetail report={loop.delivery} />}
      {loop.error && <Section title="错误"><span style={{ color: '#f87171' }}>{loop.error}</span></Section>}
    </div>
  );
};

const Section: React.FC<{ title: string; extra?: React.ReactNode; children: React.ReactNode }> = ({ title, extra, children }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</div>
      {extra}
    </div>
    <div style={{ fontSize: 13, color: 'var(--theme-text)' }}>{children}</div>
  </div>
);

// 一个紧凑的 backend 选型标签：标出某阶段实际跑在哪个 backend（规划 / 执行 / 评审）
const BackendTag: React.FC<{ role: 'prepare' | 'execute' | 'analysis'; label?: string }> = ({ role, label }) => {
  if (!label) return null;
  const meta = role === 'analysis'
    ? { icon: '🔍', tip: '评审 backend / 模型', col: '#8957e5' }
    : role === 'prepare'
      ? { icon: '🧭', tip: '规划 backend / 模型', col: '#d29922' }
      : { icon: '⚙️', tip: '执行 backend / 模型', col: '#0969da' };
  return (
    <span title={`${meta.tip}：${label}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5,
      padding: '1px 7px', borderRadius: 999, lineHeight: 1.7, whiteSpace: 'nowrap',
      background: `${meta.col}14`, border: `1px solid ${meta.col}44`, color: meta.col,
    }}>{meta.icon}{label}</span>
  );
};

const Live: React.FC<{ text: string }> = ({ text }) => (
  <div style={{
    whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.5, fontFamily: 'monospace',
    color: 'var(--theme-text-muted)', maxHeight: 200, overflow: 'auto',
    background: 'var(--theme-code-bg)', borderRadius: 6, padding: 8,
  }}>{text}<span style={{ animation: 'awu-loop-pulse 1s infinite' }}>▋</span></div>
);

// markdown 渲染（复用全站 .md-content 样式 + markdownToHtml）
const Md: React.FC<{ text: string }> = ({ text }) => (
  <div className="md-content" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text)' }}
    dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} />
);

// ══ small bits ════════════════════════════════════════════════
const StatusDot: React.FC<{ status: string }> = ({ status }) => {
  const c = status === 'done' ? '#2da44e' : status === 'running' ? '#0969da' : status === 'error' ? '#f87171' : '#bf8700';
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, animation: status === 'running' ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />;
};

// ══ styles ════════════════════════════════════════════════════
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1200,
  background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const shell: React.CSSProperties = {
  width: '92%', maxWidth: 1000, height: '88vh', display: 'flex', flexDirection: 'column',
  background: 'var(--theme-bg-secondary, #fff)', border: '1px solid var(--theme-border)',
  borderRadius: 14, overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
};
// 内嵌模式：填满所在 pane，无浮层 backdrop / 圆角 / 阴影
const embeddedShell: React.CSSProperties = {
  width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
  overflow: 'hidden', minHeight: 0,
  // ★ 不再全透明：给一层近实色磨砂底,保证密集内容在壁纸上可读
  background: 'var(--theme-panel-bg, var(--theme-bg))',
  backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
};
const btn: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
};
const btnActive: React.CSSProperties = { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', borderColor: 'var(--theme-accent)' };
const primaryBtn: React.CSSProperties = {
  background: 'var(--theme-accent)', border: 'none', color: '#fff',
  fontSize: 13, fontWeight: 600, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
};
const inputBase: React.CSSProperties = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};
const ideaCard: React.CSSProperties = {
  padding: 'var(--ui-section-padding, 12px)', borderRadius: 10, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)',
};
const sealBox: React.CSSProperties = {
  padding: 'var(--ui-section-padding, 14px)', borderRadius: 12, background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)',
};
const miniX: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 12, padding: 2,
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 12, padding: 0,
};

// 注入脉冲 / 流程动画（一次性）
if (typeof document !== 'undefined' && !document.getElementById('awu-loop-css')) {
  const s = document.createElement('style');
  s.id = 'awu-loop-css';
  s.textContent = `
@keyframes awu-loop-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes awu-flow-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(9,105,218,0.45); } 50% { box-shadow: 0 0 0 5px rgba(9,105,218,0); } }
@keyframes awu-flow-dash { to { background-position: 16px 0; } }
@keyframes awu-loop-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.awu-flow-dash { background-image: repeating-linear-gradient(90deg, var(--theme-accent) 0 8px, transparent 8px 16px); background-size: 16px 100%; animation: awu-flow-dash 0.55s linear infinite; }

/* ── 优雅交互层：统一过渡 / hover / 聚焦反馈（inline 样式不含 :hover，故此处生效）── */
.awu-loop button { transition: background-color .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .1s ease, opacity .16s ease; }
.awu-loop button:not(:disabled) { cursor: pointer; }
.awu-loop button:not(:disabled):hover { filter: brightness(1.07); }
.awu-loop button:not(:disabled):active { transform: translateY(1px) scale(0.985); }
.awu-loop button:disabled { cursor: default; }
.awu-loop textarea, .awu-loop input { transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease; }
.awu-loop textarea:focus, .awu-loop input:focus { border-color: var(--theme-accent) !important; box-shadow: 0 0 0 3px var(--theme-accent-bg); }
.awu-loop ::placeholder { color: var(--theme-text-muted); opacity: 0.7; }
/* 细滚动条，统一观感 */
.awu-loop *::-webkit-scrollbar { width: 9px; height: 9px; }
.awu-loop *::-webkit-scrollbar-thumb { background: var(--theme-border); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
.awu-loop *::-webkit-scrollbar-thumb:hover { background: var(--theme-text-muted); background-clip: padding-box; }
.awu-loop *::-webkit-scrollbar-track { background: transparent; }
/* 卡片悬停轻微抬升（仅标了 awu-card 的） */
.awu-loop .awu-card { transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
.awu-loop .awu-card:hover { border-color: var(--theme-accent); box-shadow: 0 4px 18px rgba(0,0,0,0.10); }
/* 折叠区域展开的淡入 */
.awu-loop .awu-reveal { animation: awu-loop-fade .2s ease both; }
`;
  document.head.appendChild(s);
}
