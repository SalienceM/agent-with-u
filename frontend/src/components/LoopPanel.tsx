import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { markdownToHtml } from '../utils/markdown';
import { ImagePreview } from './ImagePreview';
import { useClipboardImage } from './../hooks/useClipboardImage';
import type { ImageAttachment } from './../hooks/useClipboardImage';
import { LoopPolicyEditor, normalizePolicy } from './LoopPolicyEditor';
import type { LoopPolicy } from './LoopPolicyEditor';

/**
 * LoopPanel — 可视化 Loop 集成的全屏面板。
 *
 * 阶段（单向）：loopidea → loopexecute → loopout
 *  - loopidea ：非阻塞投递多条想法（后端并发池跑），封口后形成全局目标
 *  - loopexecute：每次 loop 走 prepare → execute → analysis，时间轴可视化 +
 *    点击查看任意 loop 的详情；带分数环、风险系数、可交付/可输出徽标
 *  - loopout ：全局产出
 *
 * 右上角可切换「Hack 模式」——整份状态以 terminal 风格的等宽文本呈现。
 */

interface LoopStep { index: number; mode: string; desc: string; status: string; output: string; startedAt?: number; endedAt?: number; }
interface LoopAnalysis {
  score: number; notes: string; trend: string;
  optimizationPotential: number; challenges: string;
  deliverable: boolean; outputtable: boolean;
}
interface LoopRecord {
  seq: number; subStage: string; round: number; goal: string; orchestration: LoopStep[];
  completed: boolean; result: string; analysis: LoopAnalysis | null; error: string;
  subStarted?: Record<string, number>; createdAt?: number; updatedAt?: number;
  hasGitCheckpoint?: boolean;
  backends?: Record<string, string>;          // {execute, analysis} → backend id
  backendLabels?: Record<string, string>;     // {execute, analysis} → 可读 label
}
interface IdeaEntry { id: string; prompt: string; status: string; result: string; error: string; images?: AddonImage[]; }
interface GoalRevision { goal: string; hint: string; source: string; createdAt: number; }
interface AsideTurn { id: string; question: string; answer: string; status: string; stage: string; seq: number; imageCount?: number; }
interface AddonImage { id?: string; base64: string; mime_type?: string; }
interface Addon { id: string; text: string; status: string; appliedSeq: number; images?: AddonImage[]; }
interface LoopStateT {
  sessionId: string; stage: string; goal: string;
  goalHistory: GoalRevision[];
  policy?: LoopPolicy;
  ideas: IdeaEntry[]; loops: LoopRecord[];
  riskCoefficient: number; maxLoops: number; effectiveMaxLoops: number;
  round: number; roundLoopCount: number;
  status: string; stopReason: string; bestScore: number; latestScore: number;
  asides: AsideTurn[];
  addons: Addon[];
  intentAlert?: { round?: number; seq?: number; aligned?: boolean; severity?: string; divergence?: string; suggestion?: string; dismissed?: boolean };
  auto: boolean; running: boolean; resumable: boolean;
}

const SUB_LABEL: Record<string, string> = {
  prepare: 'Prepare', execute: 'Execute', analysis: 'Analysis', done: 'Done',
};
const SUB_ORDER = ['prepare', 'execute', 'analysis', 'done'];

export interface LoopPanelProps {
  sessionId: string;
  onClose?: () => void;
  embedded?: boolean;   // true = 作为会话内容内嵌渲染（无浮层、无关闭按钮）
  sandboxEnabled?: boolean;            // loop 会话没有聊天工具栏，这里提供沙盒开关
  onSandboxChange?: (enabled: boolean) => void;
}

export const LoopPanel: React.FC<LoopPanelProps> = ({ sessionId, onClose, embedded, sandboxEnabled, onSandboxChange }) => {
  const [state, setState] = useState<LoopStateT | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'panel' | 'flow'>('panel');  // 可切换的执行流程视图
  const [ideaInput, setIdeaInput] = useState('');
  const [goalDraft, setGoalDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // By the way 旁路问答抽屉
  const [asideOpen, setAsideOpen] = useState(false);
  const [asideInput, setAsideInput] = useState('');
  const [asideLive, setAsideLive] = useState<Record<string, string>>({});

  // 子阶段实时流式文本：key = `${seq}:${subStage}`
  const [progress, setProgress] = useState<Record<string, string>>({});
  const progressRef = useRef(progress);
  progressRef.current = progress;

  const refresh = useCallback(async () => {
    const s = await api.loopGetState(sessionId);
    if (s) setState(s);
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  // 订阅整份状态更新 + 子阶段流式文本（仅本 session）
  useEffect(() => {
    const un1 = api.onLoopUpdated((s: LoopStateT) => {
      if (s.sessionId === sessionId) setState(s);
    });
    const un2 = api.onLoopProgress((d) => {
      if (d.sessionId !== sessionId) return;
      const key = `${d.seq}:${d.subStage}`;
      setProgress((prev) => ({ ...prev, [key]: (prev[key] || '') + d.text }));
    });
    const un3 = api.onLoopAsideDelta((d) => {
      if (d.sessionId !== sessionId) return;
      setAsideLive((prev) => ({ ...prev, [d.turnId]: (prev[d.turnId] || '') + d.text }));
    });
    return () => { un1(); un2(); un3(); };
  }, [sessionId]);

  const asideAnswering = state?.asides?.some((a) => a.status === 'answering') ?? false;
  const submitAside = useCallback(async (images?: ImageAttachment[]) => {
    const text = asideInput.trim();
    if ((!text && !(images && images.length)) || asideAnswering) return;
    setAsideInput('');
    const r = await api.loopAsk(sessionId, text, images);
    if (r.status !== 'ok' && r.message) alert(r.message);
  }, [asideInput, asideAnswering, sessionId]);

  const running = state?.running ?? false;
  const setAuto = useCallback((on: boolean) => api.loopSetAuto(sessionId, on), [sessionId]);
  const addAddon = useCallback((text: string, images?: ImageAttachment[]) => api.loopAddAddon(sessionId, text, images), [sessionId]);
  const editAddon = useCallback((id: string, text: string, images?: any[]) => api.loopEditAddon(sessionId, id, text, images), [sessionId]);
  const removeAddon = useCallback((id: string) => api.loopRemoveAddon(sessionId, id), [sessionId]);
  const continueRound = useCallback(async (goal: string) => {
    setBusy(true);
    await api.loopContinue(sessionId, goal);
    setBusy(false);
  }, [sessionId]);

  const submitIdea = useCallback(async (images?: ImageAttachment[]) => {
    const text = ideaInput.trim();
    if (!text && !(images && images.length)) return;
    setIdeaInput('');
    await api.loopSubmitIdea(sessionId, text, images);
  }, [ideaInput, sessionId]);

  const sealIdea = useCallback(async () => {
    if (!window.confirm('封口 loopidea 后将单向进入 loopexecute，无法回退。继续？')) return;
    setBusy(true);
    await api.loopSealIdea(sessionId, goalDraft.trim());
    setGoalDraft('');
    setBusy(false);
  }, [sessionId, goalDraft]);

  const runIteration = useCallback(async () => {
    setBusy(true);
    const r = await api.loopRunIteration(sessionId);
    if (r.status !== 'ok' && r.message) alert(r.message);
    setBusy(false);
  }, [sessionId]);

  const discardLoop = useCallback(async () => {
    // 丢弃目标：正在跑的那次（或最后一次）
    const target = state?.loops.find((l) => !l.completed && !l.error) || state?.loops[state.loops.length - 1];
    const hasGit = !!target?.hasGitCheckpoint;
    if (!window.confirm(
      '停止并删除本次 loop？当作没发生过：\n' +
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
    const r = await api.loopDiscard(sessionId, 0, restoreFiles);
    if (r.status !== 'ok' && r.message) alert(r.message);
  }, [sessionId, state]);

  const advanceOut = useCallback(async () => {
    if (!window.confirm('进入 loopout 全局产出阶段（单向）。继续？')) return;
    setBusy(true);
    await api.loopAdvanceToOut(sessionId);
    setBusy(false);
  }, [sessionId]);

  const saveGoal = useCallback(async () => {
    await api.loopSetGoal(sessionId, goalDraft.trim());
  }, [sessionId, goalDraft]);

  const refineGoal = useCallback(async (hint: string) => {
    return api.loopRefineGoal(sessionId, hint);
  }, [sessionId]);

  // embedded = 作为会话内容内嵌（填满 pane，无浮层 backdrop）；否则浮层模式
  const wrap = (children: React.ReactNode) => embedded
    ? <div className="awu-loop" style={embeddedShell}>{children}</div>
    : <div style={overlay}><div className="awu-loop" style={shell}>{children}</div></div>;

  if (!state) {
    return wrap(
      <>
        <Header stage="…"
          asideOpen={false} setAsideOpen={() => {}} asideCount={0} onClose={onClose} embedded={embedded}
          sandboxEnabled={sandboxEnabled} onSandboxChange={onSandboxChange} />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text-muted)' }}>
          正在加载 Loop 状态…
        </div>
      </>
    );
  }

  return wrap(
    <>
      <Header stage={state.stage}
        asideOpen={asideOpen} setAsideOpen={setAsideOpen} asideCount={state.asides?.length || 0}
        onClose={onClose} embedded={embedded}
        sandboxEnabled={sandboxEnabled} onSandboxChange={onSandboxChange}
        viewMode={viewMode} setViewMode={setViewMode} canFlow={state.stage !== 'loopidea'} />
      <StageRail stage={state.stage} />

        <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflow: 'auto', padding: '12px 18px 24px' }}>
              <IntentBanner state={state} sessionId={sessionId} />
              {state.stage === 'loopidea' ? (
                <>
                  <PolicyCard sessionId={sessionId} policy={state.policy} />
                  <IdeaStage
                    state={state} ideaInput={ideaInput} setIdeaInput={setIdeaInput}
                    goalDraft={goalDraft} setGoalDraft={setGoalDraft}
                    onSubmit={submitIdea} onSeal={sealIdea} busy={busy}
                    onRemove={(id) => api.loopRemoveIdea(sessionId, id)}
                  />
                </>
              ) : viewMode === 'flow' ? (
                /* ★ 流程视图：把执行过程画成可追踪的流程图（当前位置 / 每步耗时 / doing 动线） */
                <>
                  <MetricBar state={state} />
                  <LoopFlowView state={state} selectedSeq={selectedSeq} setSelectedSeq={setSelectedSeq} />
                  {selectedSeq != null && state.loops.find((l) => l.seq === selectedSeq) && (
                    <LoopDetail loop={state.loops.find((l) => l.seq === selectedSeq)!} progress={progress} onClose={() => setSelectedSeq(null)} />
                  )}
                </>
              ) : (
                <>
                  <MetricBar state={state} />
                  <PolicyCard sessionId={sessionId} policy={state.policy} />
                  <ExecuteStage
                    state={state} progress={progress}
                    selectedSeq={selectedSeq} setSelectedSeq={setSelectedSeq}
                    onRun={runIteration} onAdvanceOut={advanceOut} onSetAuto={setAuto}
                    onAddAddon={addAddon} onRemoveAddon={removeAddon} onEditAddon={editAddon} onContinue={continueRound}
                    onDiscard={discardLoop}
                    running={running} busy={busy}
                    goalDraft={goalDraft} setGoalDraft={setGoalDraft} onSaveGoal={saveGoal}
                    onRefineGoal={refineGoal}
                  />
                </>
              )}
            </div>
          </div>

          {asideOpen && (
            <AsideDrawer
              asides={state.asides || []} live={asideLive}
              input={asideInput} setInput={setAsideInput}
              onSend={submitAside} answering={asideAnswering}
              onClose={() => setAsideOpen(false)}
            />
          )}
        </div>
    </>
  );
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
          不打断执行。采纳=让模型按建议微调全局目标；也可手动改目标或「🗑 停止并删除本次」止损。
        </span>
      </div>
    </div>
  );
};

// ══ Header ════════════════════════════════════════════════════
const Header: React.FC<{
  stage: string;
  asideOpen: boolean; setAsideOpen: (v: boolean) => void; asideCount: number;
  onClose?: () => void; embedded?: boolean;
  sandboxEnabled?: boolean; onSandboxChange?: (enabled: boolean) => void;
  viewMode?: 'panel' | 'flow'; setViewMode?: (v: 'panel' | 'flow') => void; canFlow?: boolean;
}> = ({ stage, asideOpen, setAsideOpen, asideCount, onClose, embedded, sandboxEnabled, onSandboxChange, viewMode, setViewMode, canFlow }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
      borderBottom: '1px solid var(--theme-border)',
    }}>
      <span style={{ fontSize: 18 }}>🔁</span>
      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text)' }}>可视化 Loop</span>
      <span style={{ fontSize: 12, color: 'var(--theme-accent)', fontFamily: 'monospace' }}>{stage}</span>
      {/* ★ 视图切换：面板（原功能）⇄ 流程（执行追踪），随时切 */}
      {canFlow && setViewMode && (
        <div style={{ display: 'flex', gap: 0, border: '1px solid var(--theme-border)', borderRadius: 7, overflow: 'hidden', marginLeft: 4 }}>
          <button onClick={() => setViewMode('panel')} title="面板视图（原功能）"
            style={{ ...segBtn, ...(viewMode === 'panel' ? segActive : {}) }}>🗂 面板</button>
          <button onClick={() => setViewMode('flow')} title="流程视图：执行追踪 / 每步耗时"
            style={{ ...segBtn, ...(viewMode === 'flow' ? segActive : {}) }}>🔀 流程</button>
        </div>
      )}
      <div style={{ flex: 1 }} />
      {/* ★ 沙盒开关：loop 会话没有聊天工具栏，在这里开/关文件操作的工作目录边界限制 */}
      {onSandboxChange && (
        <button
          onClick={() => onSandboxChange(!sandboxEnabled)}
          style={{ ...btn, ...(sandboxEnabled ? {} : { background: '#bf87001f', color: '#bf8700', borderColor: '#bf870055' }) }}
          title={sandboxEnabled
            ? '沙盒已启用：文件操作限制在工作目录内。若误报越界（如 /d/ 这类路径），可在此关闭'
            : '沙盒已关闭：无路径限制'}
        >
          {sandboxEnabled ? '🔒 沙盒' : '🔓 沙盒关'}
        </button>
      )}
      {/* ★ session 级 By the way 激活按钮：旁路问答，不污染 loop 主线 */}
      <button
        onClick={() => setAsideOpen(!asideOpen)}
        style={{ ...btn, ...(asideOpen ? btnActive : {}) }}
        title="By the way — 基于当前 loop 状态旁路问答，不影响 loop 上下文"
      >
        💬 By the way{asideCount > 0 ? ` (${asideCount})` : ''}
      </button>
      {!embedded && onClose && <button onClick={onClose} style={btn}>✕ 关闭</button>}
    </div>
  );

// ══ By the way 旁路问答抽屉 ════════════════════════════════════
const AsideDrawer: React.FC<{
  asides: AsideTurn[]; live: Record<string, string>;
  input: string; setInput: (v: string) => void;
  onSend: (images?: ImageAttachment[]) => void; answering: boolean; onClose: () => void;
}> = ({ asides, live, input, setInput, onSend, answering, onClose }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autoScrollRef = useRef(true);   // 是否跟随最新(用户停在底部时为 true)
  const [showJump, setShowJump] = useState(false);
  // 图片附件:粘贴(含 Snipaste)自动入列,与主聊天框一致,作用域限定本输入框
  const { images, removeImage, clearImages } = useClipboardImage(inputRef);

  // 跟踪最新:仅当用户停在底部时才自动滚到底(与普通会话一致)
  useEffect(() => {
    if (!autoScrollRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [asides, live]);

  // 滚动事件:用户向上滚则暂停跟随并显示「最新」按钮;回到底部则恢复
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    if (atBottom) { autoScrollRef.current = true; setShowJump(false); }
    else { autoScrollRef.current = false; setShowJump(true); }
  }, []);

  const jumpToLatest = useCallback(() => {
    autoScrollRef.current = true;
    setShowJump(false);
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // 发送新问题是显式操作:无论之前滚到哪,都恢复跟随,好看到自己的提问与流式回答
  const handleSend = useCallback(() => {
    if (answering) return;
    if (!input.trim() && images.length === 0) return;
    autoScrollRef.current = true;
    setShowJump(false);
    onSend(images);
    clearImages();
  }, [onSend, answering, input, images, clearImages]);


  return (
    <div style={asideDrawerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--theme-border)' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>💬 By the way</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={miniX}>✕</button>
      </div>
      <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--theme-text-muted)', borderBottom: '1px solid var(--theme-border)', lineHeight: 1.5 }}>
        随手问。模型只读当前 loop 状态快照作答，用独立上下文，<b>不影响 / 不打断</b> loop 主线。
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex' }}>
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {asides.length === 0 && (
          <div style={{ color: 'var(--theme-text-muted)', fontSize: 12 }}>例如：“第 3 次 loop 为什么分数低？”、“现在卡在哪？”、“下一步该往哪个方向调？”</div>
        )}
        {asides.map((t) => {
          const liveText = live[t.id];
          const answer = t.status === 'answering' ? (liveText ?? t.answer) : t.answer;
          return (
            <div key={t.id}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                <div style={{ maxWidth: '85%', padding: '7px 11px', borderRadius: '12px 12px 2px 12px', background: 'var(--theme-accent)', color: '#fff', fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {!!t.imageCount && <span style={{ display: 'inline-block', marginRight: 5, opacity: 0.85 }}>🖼️{t.imageCount > 1 ? `×${t.imageCount}` : ''}</span>}
                  {t.question}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ maxWidth: '90%', padding: '7px 11px', borderRadius: '12px 12px 12px 2px', background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)', fontSize: 12.5, lineHeight: 1.55, border: '1px solid var(--theme-border)', overflowWrap: 'anywhere' }}>
                  {t.seq > 0 && <span style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 3 }}>↳ 提问时：Loop #{t.seq} · {t.stage}</span>}
                  {answer
                    ? <Md text={answer} />
                    : <span style={{ whiteSpace: 'pre-wrap' }}>{t.status === 'answering' ? '思考中…' : '—'}</span>}
                  {t.status === 'answering' && <span style={{ animation: 'awu-loop-pulse 1s infinite' }}>▋</span>}
                  {t.status === 'error' && !answer && <span style={{ color: '#f87171' }}>回答失败</span>}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
        {showJump && (
          <button onClick={jumpToLatest} style={asideJumpBtn}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
            最新
          </button>
        )}
      </div>

      <div style={{ padding: 10, borderTop: '1px solid var(--theme-border)' }}>
        {images.length > 0 && <ImagePreview images={images} onRemove={removeImage} />}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend(); }}
            placeholder={answering ? '上一条回答中…' : '顺便问一句…（可粘贴/插入图片，Ctrl/Cmd+Enter）'}
            disabled={answering}
            style={{ ...inputBase, flex: 1, minHeight: 40, maxHeight: 120, resize: 'vertical', opacity: answering ? 0.6 : 1 }}
          />
          <button onClick={handleSend} disabled={answering || (!input.trim() && images.length === 0)} style={{ ...primaryBtn, padding: '8px 12px', opacity: (answering || (!input.trim() && images.length === 0)) ? 0.5 : 1 }}>发送</button>
        </div>
      </div>
    </div>
  );
};

// ══ Stage rail ════════════════════════════════════════════════
const StageRail: React.FC<{ stage: string }> = ({ stage }) => {
  const stages = ['loopidea', 'loopexecute', 'loopout'];
  const cur = stages.indexOf(stage);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '10px 18px', borderBottom: '1px solid var(--theme-border)' }}>
      {stages.map((s, i) => (
        <React.Fragment key={s}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            opacity: i <= cur ? 1 : 0.4,
          }}>
            <span style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
              background: i < cur ? 'var(--theme-accent)' : i === cur ? 'var(--theme-accent-bg)' : 'var(--theme-bg-tertiary)',
              color: i < cur ? '#fff' : 'var(--theme-accent)',
              border: `1px solid ${i <= cur ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
            }}>{i < cur ? '✓' : i + 1}</span>
            <span style={{ fontSize: 13, fontWeight: i === cur ? 700 : 500, color: i === cur ? 'var(--theme-text)' : 'var(--theme-text-muted)' }}>{s}</span>
          </div>
          {i < stages.length - 1 && (
            <div style={{ flex: 1, height: 2, margin: '0 10px', background: i < cur ? 'var(--theme-accent)' : 'var(--theme-border)' }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

// ══ Metric bar ════════════════════════════════════════════════
const MetricBar: React.FC<{ state: LoopStateT }> = ({ state }) => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
    <Metric label="最佳分数" value={state.bestScore.toFixed(0)} accent={scoreColor(state.bestScore)} />
    <Metric label="最近分数" value={state.latestScore.toFixed(0)} accent={scoreColor(state.latestScore)} />
    <Metric label={state.round > 1 ? `本轮 Loop（第${state.round}轮）` : '已跑 Loop'} value={`${state.roundLoopCount} / ${state.effectiveMaxLoops}`} />
    <RiskMetric risk={state.riskCoefficient} />
    {state.bestScore >= 70 && <Badge text="可交付" color="#2da44e" />}
    {state.bestScore >= 85 && <Badge text="可输出" color="#8957e5" />}
    {state.status !== 'active' && <Badge text={state.status} color="#bf8700" />}
  </div>
);

const Metric: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div style={metricBox}>
    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color: accent || 'var(--theme-text)', fontFamily: 'monospace' }}>{value}</div>
  </div>
);

const RiskMetric: React.FC<{ risk: number }> = ({ risk }) => (
  <div style={metricBox}>
    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>风险系数</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'monospace', color: riskColor(risk) }}>{risk.toFixed(2)}</div>
      <div style={{ width: 50, height: 6, borderRadius: 3, background: 'var(--theme-bg-tertiary)', overflow: 'hidden' }}>
        <div style={{ width: `${risk * 100}%`, height: '100%', background: riskColor(risk) }} />
      </div>
    </div>
  </div>
);

const Badge: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <div style={{
    alignSelf: 'center', padding: '4px 12px', borderRadius: 14, fontSize: 12, fontWeight: 600,
    color, background: `${color}1f`, border: `1px solid ${color}55`,
  }}>{text}</div>
);

// ══ Idea stage ════════════════════════════════════════════════
const IdeaStage: React.FC<{
  state: LoopStateT; ideaInput: string; setIdeaInput: (v: string) => void;
  goalDraft: string; setGoalDraft: (v: string) => void;
  onSubmit: (images?: ImageAttachment[]) => void; onSeal: () => void; busy: boolean;
  onRemove: (id: string) => void;
}> = ({ state, ideaInput, setIdeaInput, goalDraft, setGoalDraft, onSubmit, onSeal, busy, onRemove }) => {
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
        头脑风暴阶段 · 非阻塞投递想法（可粘贴图片），后端最多 3 个并发展开。封口后形成全局目标并单向进入 loopexecute。
        {runningCount > 0 && <span style={{ color: 'var(--theme-accent)' }}> · {runningCount} 个进行中</span>}
      </p>

      {images.length > 0 && <ImagePreview images={images} onRemove={removeImage} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={ideaInput}
          onChange={(e) => setIdeaInput(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
          placeholder="一条想法/方向…（可粘贴图片，Ctrl/Cmd+Enter 投递）"
          style={{ ...inputBase, minHeight: 56, resize: 'vertical', flex: 1 }}
        />
        <button onClick={submit} disabled={!ideaInput.trim() && images.length === 0}
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
              <button onClick={() => onRemove(idea.id)} style={miniX} title="删除">✕</button>
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

      <div style={sealBox}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 8 }}>封口 → 形成全局目标</div>
        <textarea
          value={goalDraft}
          onChange={(e) => setGoalDraft(e.target.value)}
          placeholder="可选：直接写全局目标。留空则封口后由模型把想法收敛成目标。"
          style={{ ...inputBase, minHeight: 60, resize: 'vertical', width: '100%', marginBottom: 10 }}
        />
        <button onClick={onSeal} disabled={busy} style={{ ...primaryBtn, background: '#bf8700' }}>
          🔒 封口并进入 loopexecute
        </button>
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
        随手补充要求（可粘贴图片）—— <b>不影响当前正在跑的 loop</b>；下一次 loop 的分析与规划会带上并设法完成。纳入前可随时增删。已纳入的见下方「Addon 历史」。
      </div>
      {images.length > 0 && <ImagePreview images={images} onRemove={removeImage} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: pending.length ? 12 : 0, alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
          placeholder="补充一条要求 / 修正…（可粘贴图片，Ctrl/Cmd+Enter 添加）"
          style={{ ...inputBase, flex: 1, minHeight: 56, maxHeight: 160, resize: 'vertical', lineHeight: 1.5 }}
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
        <textarea
          ref={editRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); }}
          placeholder="编辑补充内容…（可粘贴图片，Ctrl/Cmd+Enter 保存）"
          autoFocus
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

// ══ loopout 引导：本轮产出 + 开启新一轮 ════════════════════════
const LoopOutBanner: React.FC<{
  state: LoopStateT; onContinue: (goal: string) => void; busy: boolean;
  onRefineGoal: (hint: string) => Promise<{ status: string; goal?: string; message?: string }>;
}> =
  ({ state, onContinue, busy, onRefineGoal }) => {
    const [goal, setGoal] = useState(state.goal || '');
    const [editing, setEditing] = useState(false);
    const [refineOpen, setRefineOpen] = useState(false);
    return (
      <div style={{ ...sealBox, marginBottom: 16, borderColor: '#8957e555', background: '#8957e50d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text)' }}>
            ✅ loopout · 第 {state.round} 轮已产出
          </span>
          <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>最佳分数 {state.bestScore.toFixed(0)}</span>
        </div>
        {state.stopReason && (
          <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginBottom: 8 }}>收口原因：{state.stopReason}</div>
        )}
        <div style={{ fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.6, marginBottom: 10 }}>
          loopout 是本轮的产出阶段，<b>不是会话终点</b>。你可以在现有成果（同一工作目录与上下文）的
          基础上 <b>设定 / 修改任务，开启新一轮迭代</b>——相当于一段新的 auto-loop，轮次 +1、趋势与
          风险从头计。{state.auto && <span style={{ color: '#2da44e' }}> Auto 已开启：开启后将自动连跑。</span>}
        </div>
        {refineOpen ? (
          <RefineBox onRefineGoal={onRefineGoal} onResult={(g) => setGoal(g)} onCancel={() => setRefineOpen(false)} />
        ) : (
          <>
            {editing ? (
              <textarea
                value={goal} onChange={(e) => setGoal(e.target.value)}
                placeholder="新一轮的目标（默认沿用上一轮目标，可在此修改 / 追加新任务）"
                style={{ ...inputBase, width: '100%', minHeight: 64, resize: 'vertical', marginBottom: 10 }}
              />
            ) : (
              <div
                onClick={() => setEditing(true)}
                title="点击修改新一轮目标"
                style={{ fontSize: 13, color: 'var(--theme-text)', lineHeight: 1.6, marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px dashed var(--theme-border)', cursor: 'text', whiteSpace: 'pre-wrap' }}
              >
                🎯 {goal || '（点击设定新一轮目标）'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button onClick={() => setRefineOpen(true)} style={{ ...btn, ...btnActive }}
                title="给一句提示，让模型基于当前目标+原始诉求自动改写新一轮目标">✨ 微调目标</button>
            </div>
          </>
        )}
        <button
          onClick={() => onContinue(goal.trim())}
          disabled={busy}
          style={{ ...primaryBtn, background: '#8957e5' }}
        >
          ▶ 开启新一轮（第 {state.round + 1} 轮 loopexecute）
        </button>
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
const PolicyCard: React.FC<{ sessionId: string; policy?: LoopPolicy }> = ({ sessionId, policy }) => {
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
        <button onClick={() => setOpen(!open)}
          style={{ ...linkBtn, fontWeight: 700, fontSize: 13, color: 'var(--theme-text)' }}>
          {open ? '▾' : '▸'} ⚙️ 策略与心智
        </button>
        <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          可交付≥{p.deliverableScore} · 可输出≥{p.outputtableScore} · 最多 {p.maxLoops} loop · 风险≥{p.riskThreshold.toFixed(2)} 收口 · 评审{p.independentEval ? '独立防自欺' : '常规'}{Object.values(p.backends || {}).some(Boolean) ? ' · 异构 backend' : ''}
        </span>
      </div>
      {open && (
        <div className="awu-reveal" style={{ marginTop: 10 }}>
          <LoopPolicyEditor value={draft} onChange={(v) => { setDraft(v); setDirty(true); }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving || !dirty}
              style={{ ...primaryBtn, opacity: (saving || !dirty) ? 0.5 : 1 }}>
              {saving ? '保存中…' : '保存策略'}
            </button>
            {dirty && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>改动未保存 · 不影响进行中的 loop，从下一次起生效</span>}
          </div>
        </div>
      )}
    </div>
  );
};

// 按提示让模型微调目标的输入框（GoalCard 与 loopout 新一轮共用）
const RefineBox: React.FC<{
  onRefineGoal: (hint: string) => Promise<{ status: string; goal?: string; message?: string }>;
  onResult?: (goal: string) => void;   // 拿到微调结果（loopout 用来同步本地草稿）
  onCancel: () => void;
}> = ({ onRefineGoal, onResult, onCancel }) => {
  const [hint, setHint] = useState('');
  const [refining, setRefining] = useState(false);
  const doRefine = async () => {
    const h = hint.trim();
    if (!h) return;
    setRefining(true);
    const r = await onRefineGoal(h);
    setRefining(false);
    if (r.status === 'ok') { if (r.goal) onResult?.(r.goal); setHint(''); onCancel(); }
    else if (r.message) alert(r.message);
  };
  return (
    <div className="awu-reveal" style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-accent)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--theme-text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
        给一句提示，由模型在「当前目标 + 原始诉求」基础上自动改写。例如「更强调性能」「缩小到只做后端」「把验收标准写细」。每次微调都会留一版历史。
      </div>
      <textarea value={hint} onChange={(e) => setHint(e.target.value)} disabled={refining}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doRefine(); }}
        placeholder="微调提示…（Ctrl/Cmd+Enter 提交）"
        style={{ ...inputBase, width: '100%', minHeight: 50, resize: 'vertical', opacity: refining ? 0.6 : 1 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={doRefine} disabled={refining || !hint.trim()} style={{ ...primaryBtn, opacity: (refining || !hint.trim()) ? 0.5 : 1 }}>
          {refining ? '⏳ 微调中…' : '✨ 让模型微调'}
        </button>
        <button onClick={onCancel} disabled={refining} style={btn}>取消</button>
      </div>
    </div>
  );
};

const GoalCard: React.FC<{
  state: LoopStateT; isOut: boolean;
  onRefineGoal: (hint: string) => Promise<{ status: string; goal?: string; message?: string }>;
  goalDraft: string; setGoalDraft: (v: string) => void; onSaveGoal: () => void;
}> = ({ state, isOut, onRefineGoal, goalDraft, setGoalDraft, onSaveGoal }) => {
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
        {mode === 'view' && (
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
      {mode === 'refine' && (
        <RefineBox onRefineGoal={onRefineGoal} onCancel={() => setMode('view')} />
      )}

      {/* 手动编辑（兜底） */}
      {mode === 'edit' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <textarea value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)} style={{ ...inputBase, flex: 1, minHeight: 54 }} />
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

// ══ Execute stage ═════════════════════════════════════════════
const ExecuteStage: React.FC<{
  state: LoopStateT; progress: Record<string, string>;
  selectedSeq: number | null; setSelectedSeq: (v: number | null) => void;
  onRun: () => void; onAdvanceOut: () => void; onSetAuto: (on: boolean) => void;
  onAddAddon: (text: string, images?: ImageAttachment[]) => void; onRemoveAddon: (id: string) => void;
  onEditAddon: (id: string, text: string, images?: any[]) => Promise<{ status: string; message?: string }>;
  onContinue: (goal: string) => void; onDiscard: () => void;
  running: boolean; busy: boolean;
  goalDraft: string; setGoalDraft: (v: string) => void; onSaveGoal: () => void;
  onRefineGoal: (hint: string) => Promise<{ status: string; goal?: string; message?: string }>;
}> = ({ state, progress, selectedSeq, setSelectedSeq, onRun, onAdvanceOut, onSetAuto, onAddAddon, onRemoveAddon, onEditAddon, onContinue, onDiscard, running, busy, goalDraft, setGoalDraft, onSaveGoal, onRefineGoal }) => {
  const isOut = state.stage === 'loopout';
  const selected = state.loops.find((l) => l.seq === selectedSeq) || null;
  const runLabel = state.resumable
    ? `▶ 继续未完成的 Loop #${state.loops.length}`
    : `▶ 运行下一次 Loop${state.round > 1 ? `（第 ${state.round} 轮）` : ''}`;

  return (
    <div>
      {/* 全局目标（含演变历史 + 按提示微调 + 原始诉求回看） */}
      <GoalCard state={state} isOut={isOut} onRefineGoal={onRefineGoal}
        goalDraft={goalDraft} setGoalDraft={setGoalDraft} onSaveGoal={onSaveGoal} />

      {/* 操作 */}
      {!isOut && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={onRun} disabled={busy || running} style={{ ...primaryBtn, opacity: (busy || running) ? 0.5 : 1 }}>
            {running ? '⏳ Loop 进行中…' : runLabel}
          </button>
          {/* ★ 自动连跑开关：开则一次 loop 完成自动续下一次，可随时取消 */}
          <button
            onClick={() => onSetAuto(!state.auto)}
            style={{ ...btn, ...(state.auto ? { background: '#2da44e1f', color: '#2da44e', borderColor: '#2da44e55' } : {}) }}
            title="自动连跑：开启后一次 loop 完成即自动开始下一次，直到收口或你取消"
          >
            {state.auto ? '🔄 Auto 连跑中（点此暂停）' : '⏸ Auto 关（点此自动连跑）'}
          </button>
          <button onClick={onAdvanceOut} disabled={busy} style={btn}>⏹ 进入 loopout</button>
          {/* ★ 误触兜底：停止并删除本次 loop（当作没发生过，addon 退回待纳入） */}
          {(running || state.resumable) && (
            <button onClick={onDiscard}
              style={{ ...btn, background: '#f871711f', color: '#f87171', borderColor: '#f8717155', marginLeft: 'auto' }}
              title="停止并删除本次 loop：不保存结果，已消费的补充(addon)退回待纳入">
              🗑 停止并删除本次
            </button>
          )}
          {state.auto && running && (
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>完成本次后将自动继续…</span>
          )}
        </div>
      )}
      {/* loopout：不是终点 —— 展示本轮产出小结 + 开启新一轮的引导 */}
      {isOut && <LoopOutBanner state={state} onContinue={onContinue} busy={busy} onRefineGoal={onRefineGoal} />}

      {/* ★ 执行中补充（addon）：不影响当前 loop，下一次 loop 纳入并完成 */}
      {!isOut && <AddonPanel addons={state.addons || []} onAdd={onAddAddon} onRemove={onRemoveAddon} onEdit={onEditAddon} />}

      {/* ★ Addon 历史：哪一轮/哪次 loop 纳入了哪些补充（执行中 & loopout 都可看） */}
      <AddonHistoryCard addons={state.addons || []} loops={state.loops} />

      {/* Loop 时间轴（多轮时按轮分隔） */}
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 12, marginBottom: 8, alignItems: 'stretch' }}>
        {state.loops.length === 0 && <div style={{ color: 'var(--theme-text-muted)', fontSize: 13 }}>还没有 loop，点击上方按钮开始第 1 次。</div>}
        {state.loops.map((l, i) => {
          const newRound = state.round > 1 && (i === 0 || state.loops[i - 1].round !== l.round);
          return (
            <React.Fragment key={l.seq}>
              {newRound && (
                <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ writingMode: 'vertical-rl', fontSize: 10, fontWeight: 700, color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', borderRadius: 6, padding: '6px 3px', letterSpacing: 1 }}>
                    第 {l.round} 轮
                  </span>
                </div>
              )}
              <LoopNode loop={l} selected={l.seq === selectedSeq} onClick={() => setSelectedSeq(l.seq === selectedSeq ? null : l.seq)} />
            </React.Fragment>
          );
        })}
      </div>

      {/* 详情面板 */}
      {selected && <LoopDetail loop={selected} progress={progress} onClose={() => setSelectedSeq(null)} />}
    </div>
  );
};

// ══ 流程视图：把执行过程画成可追踪的流程图 ════════════════════
//   每个 loop 一条横向泳道：[#seq] → Prepare → Execute(分步) → Analysis
//   节点按状态着色，当前在跑的节点脉冲 + 入边走「marching ants」动线，
//   每个节点/分步标注耗时（进行中实时累计）。
function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// 进行中需要实时刷新耗时：active 时每秒 tick
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const FLOW_STATUS_COLOR: Record<string, string> = {
  done: '#2da44e', running: '#0969da', error: '#f87171', current: '#bf8700', pending: 'var(--theme-text-muted)',
};

const LoopFlowView: React.FC<{
  state: LoopStateT; selectedSeq: number | null; setSelectedSeq: (v: number | null) => void;
}> = ({ state, selectedSeq, setSelectedSeq }) => {
  const now = useNow(state.running);
  const loops = state.loops;
  // 当前真正在跑的 loop（用于脉冲 / 动线）
  const activeSeq = state.running
    ? (loops.find((l) => !l.completed && !l.error)?.seq ?? null)
    : null;

  if (loops.length === 0) {
    return <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, padding: '20px 0' }}>还没有 loop —— 切回「面板」点运行开始第 1 次。</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginBottom: 10 }}>
        每条泳道是一次 loop 的执行流程；颜色表状态，<span style={{ color: '#0969da' }}>蓝色脉冲 = 正在执行</span>，节点下标注耗时。点节点看详情。
      </div>
      {loops.map((loop, i) => {
        const newRound = state.round > 1 && (i === 0 || loops[i - 1].round !== loop.round);
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
              onSelect={() => setSelectedSeq(loop.seq === selectedSeq ? null : loop.seq)} />
          </React.Fragment>
        );
      })}
    </div>
  );
};

const FlowLane: React.FC<{
  loop: LoopRecord; live: boolean; now: number; selected: boolean; onSelect: () => void;
}> = ({ loop, live, now, selected, onSelect }) => {
  const order = ['prepare', 'execute', 'analysis'];
  const sub = loop.subStarted || {};
  const curName = loop.subStage === 'done' ? 'analysis' : loop.subStage;
  const curIdx = order.indexOf(curName);
  const done = loop.completed;

  const nstatus = (i: number): string => {
    if (loop.error && i === curIdx && !done) return 'error';
    if (done || i < curIdx) return 'done';
    if (i === curIdx) return live ? 'running' : 'current';
    return 'pending';
  };
  // 子阶段耗时：start 到下一阶段 start（或进行中到 now / 完成到 done）
  const subDur = (i: number): number => {
    const starts = [sub.prepare ?? loop.createdAt, sub.execute, sub.analysis];
    const st = starts[i];
    if (!st) return 0;
    const nextStart = i < 2 ? starts[i + 1] : (sub.done ?? (done ? loop.updatedAt : undefined));
    const end = nextStart ?? (nstatus(i) === 'running' ? now : undefined);
    return end ? end - st : 0;
  };

  const score = loop.analysis?.score ?? null;
  return (
    <div onClick={onSelect} className="awu-card"
      style={{
        display: 'flex', alignItems: 'stretch', gap: 0, padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
        overflowX: 'auto',
      }}>
      {/* loop 头节点 */}
      <FlowChip title={`Loop #${loop.seq}`} status={done ? 'done' : (loop.error ? 'error' : (live ? 'running' : 'current'))}
        sub={score != null ? `score ${score.toFixed(0)}` : (loop.round > 1 ? `第${loop.round}轮` : '进行中')} big />
      <FlowEdge active={nstatus(0) === 'running'} done={nstatus(0) !== 'pending'} />
      <FlowChip title="Prepare" status={nstatus(0)} dur={fmtDur(subDur(0))} />
      <FlowEdge active={nstatus(1) === 'running'} done={nstatus(1) !== 'pending'} />
      {/* Execute：含分步 */}
      <FlowChip title="Execute" status={nstatus(1)} dur={fmtDur(subDur(1))}
        sub={loop.orchestration.length ? `${loop.orchestration.filter((s) => s.status === 'done').length}/${loop.orchestration.length} 步` : undefined}
        steps={loop.orchestration} now={now}
        tag={<BackendTag role="execute" label={loop.backendLabels?.execute} />} />
      <FlowEdge active={nstatus(2) === 'running'} done={nstatus(2) !== 'pending'} />
      <FlowChip title="Analysis" status={nstatus(2)} dur={fmtDur(subDur(2))}
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
  steps?: LoopStep[]; now?: number; tag?: React.ReactNode;
}> = ({ title, status, dur, sub, big, steps, now, tag }) => {
  const col = FLOW_STATUS_COLOR[status] || FLOW_STATUS_COLOR.pending;
  const pulse = status === 'running';
  return (
    <div style={{
      flexShrink: 0, minWidth: big ? 96 : 110, display: 'flex', flexDirection: 'column', gap: 4,
      padding: '8px 10px', borderRadius: 10,
      background: 'var(--theme-bg-tertiary)',
      border: `1.5px solid ${col === 'var(--theme-text-muted)' ? 'var(--theme-border)' : col}`,
      boxShadow: pulse ? `0 0 0 0 ${col}` : 'none',
      animation: pulse ? 'awu-flow-pulse 1.3s infinite' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0,
          animation: pulse ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text)' }}>{title}</span>
      </div>
      {sub && <span style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>{sub}</span>}
      {dur && <span style={{ fontSize: 10.5, color: col, fontFamily: 'monospace', fontWeight: 600 }}>⏱ {dur}</span>}
      {tag && <div style={{ marginTop: 1 }}>{tag}</div>}
      {steps && steps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
          {steps.map((s) => {
            const sc = FLOW_STATUS_COLOR[s.status === 'pending' ? 'pending' : s.status] || FLOW_STATUS_COLOR.pending;
            const d = s.startedAt ? ((s.endedAt || (s.status === 'running' ? (now || Date.now() / 1000) : 0)) - s.startedAt) : 0;
            return (
              <div key={s.index} title={s.desc} style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 200 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc, flexShrink: 0,
                  animation: s.status === 'running' ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />
                <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>{s.mode === 'concurrent' ? '∥' : '→'}{s.index}</span>
                <span style={{ fontSize: 10, color: 'var(--theme-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{s.desc}</span>
                {d > 0 && <span style={{ fontSize: 9.5, color: sc, fontFamily: 'monospace', flexShrink: 0 }}>{fmtDur(d)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const LoopNode: React.FC<{ loop: LoopRecord; selected: boolean; onClick: () => void }> = ({ loop, selected, onClick }) => {
  const score = loop.analysis?.score ?? null;
  const subIdx = SUB_ORDER.indexOf(loop.subStage);
  return (
    <div
      onClick={onClick}
      className="awu-card"
      style={{
        flexShrink: 0, width: 150, cursor: 'pointer', padding: 12, borderRadius: 12,
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text)' }}>Loop #{loop.seq}</span>
        <ScoreRing score={score} pending={!loop.completed} />
      </div>
      {/* 子阶段进度 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {SUB_ORDER.slice(0, 3).map((s, i) => (
          <div key={s} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: loop.error ? '#f87171' : i < subIdx ? 'var(--theme-accent)' : i === subIdx && !loop.completed ? 'var(--theme-accent)' : i < subIdx || loop.completed ? 'var(--theme-accent)' : 'var(--theme-bg-tertiary)',
            opacity: i === subIdx && !loop.completed ? 0.6 : 1,
            animation: i === subIdx && !loop.completed ? 'awu-loop-pulse 1.2s infinite' : 'none',
          }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
        {loop.error ? '❌ 失败' : loop.completed ? '✓ 完成' : `${SUB_LABEL[loop.subStage] || loop.subStage}…`}
      </div>
      {loop.orchestration.length > 0 && !loop.completed && (
        <div style={{ fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 3 }}>
          步骤 {loop.orchestration.filter((s) => s.status === 'done').length}/{loop.orchestration.length}
          {loop.orchestration.some((s) => s.status === 'running') && ' · 执行中'}
        </div>
      )}
      {loop.goal && <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loop.goal}</div>}
    </div>
  );
};

// 把编排步按「连续 concurrent 归并为一个并行组、sequential 各自成组」分组
function groupSteps(steps: LoopStep[]): LoopStep[][] {
  const groups: LoopStep[][] = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].mode === 'concurrent') {
      const g: LoopStep[] = [];
      while (i < steps.length && steps[i].mode === 'concurrent') { g.push(steps[i]); i++; }
      groups.push(g);
    } else {
      groups.push([steps[i]]); i++;
    }
  }
  return groups;
}

const STEP_ICON: Record<string, string> = { pending: '○', running: '⏳', done: '✓', error: '✗' };
const STEP_COLOR: Record<string, string> = { pending: 'var(--theme-text-muted)', running: '#0969da', done: '#2da44e', error: '#f87171' };

const StepRow: React.FC<{ step: LoopStep; live?: string }> = ({ step, live }) => {
  const [open, setOpen] = useState(false);
  const body = step.status === 'running' && live ? live : step.output;
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        onClick={() => (body ? setOpen(!open) : undefined)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 6, cursor: body ? 'pointer' : 'default' }}
      >
        <span style={{ color: STEP_COLOR[step.status] || 'var(--theme-text-muted)', fontSize: 13,
          animation: step.status === 'running' ? 'awu-loop-pulse 1.2s infinite' : 'none' }}>
          {STEP_ICON[step.status] || '○'}
        </span>
        <span style={{ fontSize: 11, color: STEP_COLOR[step.status], minWidth: 42 }}>{step.status}</span>
        <span style={{ fontSize: 13, color: 'var(--theme-text)', flex: 1 }}>{step.index}. {step.desc}</span>
        {body && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{open ? '收起' : '展开'}</span>}
      </div>
      {open && body && (
        step.status === 'running'
          ? <div style={{ marginLeft: 22, marginTop: 4 }}><Live text={body} /></div>
          : <div style={{ marginLeft: 22, marginTop: 4, background: 'var(--theme-code-bg)', borderRadius: 6, padding: '6px 10px' }}><Md text={body} /></div>
      )}
    </div>
  );
};

const LoopDetail: React.FC<{ loop: LoopRecord; progress: Record<string, string>; onClose: () => void }> = ({ loop, progress, onClose }) => {
  const liveExec = progress[`${loop.seq}:execute`];
  const livePrep = progress[`${loop.seq}:prepare`];
  const liveAna = progress[`${loop.seq}:analysis`];
  const groups = groupSteps(loop.orchestration);
  return (
    <div style={{ ...sealBox, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text)' }}>Loop #{loop.seq} 详情</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={miniX}>✕</button>
      </div>

      <Section title="本遍策略 / 侧重">{loop.goal ? <Md text={loop.goal} /> : '—'}</Section>

      <Section title="编排与分步执行（点步可展开产出）">
        {loop.orchestration.length === 0 ? (livePrep ? <Live text={livePrep} /> : '—') : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {groups.map((g, gi) => g.length > 1 ? (
              // 并行组：左侧竖条 + 「并行」标识
              <div key={gi} style={{ borderLeft: '3px solid #8957e5', paddingLeft: 10, background: '#8957e50d', borderRadius: 6, padding: '6px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#8957e5', marginBottom: 4 }}>⚡ 并行执行（{g.length} 步同时）</div>
                {g.map((s) => <StepRow key={s.index} step={s} live={progress[`${loop.seq}:step${s.index}`]} />)}
              </div>
            ) : (
              <div key={gi}><StepRow step={g[0]} live={progress[`${loop.seq}:step${g[0].index}`]} /></div>
            ))}
          </div>
        )}
      </Section>

      <Section title="本次执行结果" extra={<BackendTag role="execute" label={loop.backendLabels?.execute} />}>
        {loop.result ? <Md text={loop.result} />
          : liveExec ? <Live text={liveExec} /> : '—'}
      </Section>

      {loop.analysis ? (
        <Section title={`Execute Analysis · 分数 ${loop.analysis.score.toFixed(0)}`}
          extra={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {loop.analysis.deliverable && <Badge text="可交付" color="#2da44e" />}
            {loop.analysis.outputtable && <Badge text="可输出" color="#8957e5" />}
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', alignSelf: 'center' }}>
              优化空间 {(loop.analysis.optimizationPotential * 100).toFixed(0)}% · 趋势 {loop.analysis.trend || '—'}
            </span>
          </div>
          {loop.analysis.notes && <Md text={loop.analysis.notes} />}
          {loop.analysis.challenges && <div style={{ fontSize: 12, color: '#bf8700', marginTop: 6 }}>⚠ 约束：{loop.analysis.challenges}</div>}
        </Section>
      ) : liveAna ? <Section title="Execute Analysis（进行中）"
          extra={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />}><Live text={liveAna} /></Section> : null}

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

// 一个紧凑的 backend 选型标签：标出某阶段实际跑在哪个 backend（执行 / 评审）
const BackendTag: React.FC<{ role: 'execute' | 'analysis'; label?: string }> = ({ role, label }) => {
  if (!label) return null;
  const meta = role === 'analysis'
    ? { icon: '🔍', tip: '评审 backend', col: '#8957e5' }
    : { icon: '⚙️', tip: '执行 backend', col: '#0969da' };
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

const ScoreRing: React.FC<{ score: number | null; pending: boolean }> = ({ score, pending }) => {
  if (score === null) {
    return <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{pending ? '…' : '—'}</span>;
  }
  const col = scoreColor(score);
  return (
    <div style={{
      width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 11, fontWeight: 700, color: col,
      background: `conic-gradient(${col} ${score * 3.6}deg, var(--theme-bg-tertiary) 0deg)`,
    }}>
      <div style={{ width: 23, height: 23, borderRadius: '50%', background: 'var(--theme-bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {score.toFixed(0)}
      </div>
    </div>
  );
};

function scoreColor(s: number): string {
  if (s >= 85) return '#8957e5';
  if (s >= 70) return '#2da44e';
  if (s >= 40) return '#bf8700';
  return '#f87171';
}
function riskColor(r: number): string {
  if (r >= 0.7) return '#f87171';
  if (r >= 0.4) return '#bf8700';
  return '#2da44e';
}

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
const metricBox: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 10, background: 'var(--theme-bg-secondary)',
  border: '1px solid var(--theme-border)', minWidth: 90,
};
const ideaCard: React.CSSProperties = {
  padding: 12, borderRadius: 10, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)',
};
const sealBox: React.CSSProperties = {
  padding: 14, borderRadius: 12, background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)',
};
const miniX: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 12, padding: 2,
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 12, padding: 0,
};
// By the way:浮动贴右、约半屏宽,覆盖在主面板之上(不挤压左侧)
const asideDrawerStyle: React.CSSProperties = {
  position: 'absolute', top: 0, right: 0, bottom: 0,
  width: 'clamp(360px, 50%, 640px)',
  display: 'flex', flexDirection: 'column',
  borderLeft: '1px solid var(--theme-border)',
  background: 'var(--theme-panel-bg, var(--theme-bg))',
  backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
  boxShadow: '-10px 0 40px rgba(0,0,0,0.35)', zIndex: 30,
};
const asideJumpBtn: React.CSSProperties = {
  position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
  display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 16,
  border: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary)',
  color: 'var(--theme-text)', fontSize: 11.5, fontWeight: 500, cursor: 'pointer',
  boxShadow: '0 2px 10px rgba(0,0,0,0.25)', whiteSpace: 'nowrap', zIndex: 5,
};
// 视图切换分段按钮
const segBtn: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)', border: 'none', color: 'var(--theme-text-muted)',
  fontSize: 12, padding: '4px 10px', cursor: 'pointer',
};
const segActive: React.CSSProperties = {
  background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', fontWeight: 600,
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
