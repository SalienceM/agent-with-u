import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../api';
import { markdownToHtml } from '../utils/markdown';

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

interface LoopStep { index: number; mode: string; desc: string; status: string; output: string; }
interface LoopAnalysis {
  score: number; notes: string; trend: string;
  optimizationPotential: number; challenges: string;
  deliverable: boolean; outputtable: boolean;
}
interface LoopRecord {
  seq: number; subStage: string; goal: string; orchestration: LoopStep[];
  completed: boolean; result: string; analysis: LoopAnalysis | null; error: string;
}
interface IdeaEntry { id: string; prompt: string; status: string; result: string; error: string; }
interface AsideTurn { id: string; question: string; answer: string; status: string; stage: string; seq: number; }
interface Addon { id: string; text: string; status: string; appliedSeq: number; }
interface LoopStateT {
  sessionId: string; stage: string; goal: string;
  ideas: IdeaEntry[]; loops: LoopRecord[];
  riskCoefficient: number; maxLoops: number; effectiveMaxLoops: number;
  status: string; stopReason: string; bestScore: number; latestScore: number;
  asides: AsideTurn[];
  addons: Addon[];
  auto: boolean; running: boolean; resumable: boolean;
}

const SUB_LABEL: Record<string, string> = {
  prepare: 'Prepare', execute: 'Execute', analysis: 'Analysis', done: 'Done',
};
const SUB_ORDER = ['prepare', 'execute', 'analysis', 'done'];

export interface LoopPanelProps {
  sessionId: string;
  onClose: () => void;
}

export const LoopPanel: React.FC<LoopPanelProps> = ({ sessionId, onClose }) => {
  const [state, setState] = useState<LoopStateT | null>(null);
  const [hackMode, setHackMode] = useState(false);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
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
  const submitAside = useCallback(async () => {
    const text = asideInput.trim();
    if (!text || asideAnswering) return;
    setAsideInput('');
    const r = await api.loopAsk(sessionId, text);
    if (r.status !== 'ok' && r.message) alert(r.message);
  }, [asideInput, asideAnswering, sessionId]);

  const running = state?.running ?? false;
  const setAuto = useCallback((on: boolean) => api.loopSetAuto(sessionId, on), [sessionId]);
  const addAddon = useCallback((text: string) => api.loopAddAddon(sessionId, text), [sessionId]);
  const removeAddon = useCallback((id: string) => api.loopRemoveAddon(sessionId, id), [sessionId]);

  const submitIdea = useCallback(async () => {
    const text = ideaInput.trim();
    if (!text) return;
    setIdeaInput('');
    await api.loopSubmitIdea(sessionId, text);
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

  const advanceOut = useCallback(async () => {
    if (!window.confirm('进入 loopout 全局产出阶段（单向）。继续？')) return;
    setBusy(true);
    await api.loopAdvanceToOut(sessionId);
    setBusy(false);
  }, [sessionId]);

  const saveGoal = useCallback(async () => {
    await api.loopSetGoal(sessionId, goalDraft.trim());
  }, [sessionId, goalDraft]);

  if (!state) {
    return (
      <div style={overlay}>
        <div style={shell}>
          <Header stage="…" hackMode={hackMode} setHackMode={setHackMode}
            asideOpen={false} setAsideOpen={() => {}} asideCount={0} onClose={onClose} />
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text-muted)' }}>
            正在加载 Loop 状态…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={overlay}>
      <div style={shell}>
        <Header stage={state.stage} hackMode={hackMode} setHackMode={setHackMode}
          asideOpen={asideOpen} setAsideOpen={setAsideOpen} asideCount={state.asides?.length || 0}
          onClose={onClose} />
        <StageRail stage={state.stage} />

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {hackMode ? (
              <HackView state={state} progress={progress} />
            ) : (
              <div style={{ flex: 1, overflow: 'auto', padding: '12px 18px 24px' }}>
                {/* 全局指标条 */}
                {state.stage !== 'loopidea' && <MetricBar state={state} />}

                {state.stage === 'loopidea' && (
                  <IdeaStage
                    state={state} ideaInput={ideaInput} setIdeaInput={setIdeaInput}
                    goalDraft={goalDraft} setGoalDraft={setGoalDraft}
                    onSubmit={submitIdea} onSeal={sealIdea} busy={busy}
                    onRemove={(id) => api.loopRemoveIdea(sessionId, id)}
                  />
                )}

                {(state.stage === 'loopexecute' || state.stage === 'loopout') && (
                  <ExecuteStage
                    state={state} progress={progress}
                    selectedSeq={selectedSeq} setSelectedSeq={setSelectedSeq}
                    onRun={runIteration} onAdvanceOut={advanceOut} onSetAuto={setAuto}
                    onAddAddon={addAddon} onRemoveAddon={removeAddon}
                    running={running} busy={busy}
                    goalDraft={goalDraft} setGoalDraft={setGoalDraft} onSaveGoal={saveGoal}
                  />
                )}
              </div>
            )}
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
      </div>
    </div>
  );
};

// ══ Header ════════════════════════════════════════════════════
const Header: React.FC<{
  stage: string; hackMode: boolean; setHackMode: (v: boolean) => void;
  asideOpen: boolean; setAsideOpen: (v: boolean) => void; asideCount: number;
  onClose: () => void;
}> = ({ stage, hackMode, setHackMode, asideOpen, setAsideOpen, asideCount, onClose }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
      borderBottom: '1px solid var(--theme-border)',
    }}>
      <span style={{ fontSize: 18 }}>🔁</span>
      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text)' }}>可视化 Loop</span>
      <span style={{ fontSize: 12, color: 'var(--theme-accent)', fontFamily: 'monospace' }}>{stage}</span>
      <div style={{ flex: 1 }} />
      {/* ★ session 级 By the way 激活按钮：旁路问答，不污染 loop 主线 */}
      <button
        onClick={() => setAsideOpen(!asideOpen)}
        style={{ ...btn, ...(asideOpen ? btnActive : {}) }}
        title="By the way — 基于当前 loop 状态旁路问答，不影响 loop 上下文"
      >
        💬 By the way{asideCount > 0 ? ` (${asideCount})` : ''}
      </button>
      <button
        onClick={() => setHackMode(!hackMode)}
        style={{ ...btn, ...(hackMode ? btnActive : {}) }}
        title="切换 terminal / 可视化视图"
      >
        {hackMode ? '🎛 可视化' : '⌨ Hack'}
      </button>
      <button onClick={onClose} style={btn}>✕ 关闭</button>
    </div>
  );

// ══ By the way 旁路问答抽屉 ════════════════════════════════════
const AsideDrawer: React.FC<{
  asides: AsideTurn[]; live: Record<string, string>;
  input: string; setInput: (v: string) => void;
  onSend: () => void; answering: boolean; onClose: () => void;
}> = ({ asides, live, input, setInput, onSend, answering, onClose }) => {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [asides, live]);
  return (
    <div style={{
      width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderLeft: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--theme-border)' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>💬 By the way</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={miniX}>✕</button>
      </div>
      <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--theme-text-muted)', borderBottom: '1px solid var(--theme-border)', lineHeight: 1.5 }}>
        随手问。模型只读当前 loop 状态快照作答，用独立上下文，<b>不影响 / 不打断</b> loop 主线。
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                  {t.question}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ maxWidth: '90%', padding: '7px 11px', borderRadius: '12px 12px 12px 2px', background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)', fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', border: '1px solid var(--theme-border)' }}>
                  {t.seq > 0 && <span style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 3 }}>↳ 提问时：Loop #{t.seq} · {t.stage}</span>}
                  {answer || (t.status === 'answering' ? '思考中…' : '—')}
                  {t.status === 'answering' && <span style={{ animation: 'awu-loop-pulse 1s infinite' }}>▋</span>}
                  {t.status === 'error' && !answer && <span style={{ color: '#f87171' }}>回答失败</span>}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div style={{ padding: 10, borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 6 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSend(); }}
          placeholder={answering ? '上一条回答中…' : '顺便问一句…（Ctrl/Cmd+Enter）'}
          disabled={answering}
          style={{ ...inputBase, flex: 1, minHeight: 40, maxHeight: 120, resize: 'vertical', opacity: answering ? 0.6 : 1 }}
        />
        <button onClick={onSend} disabled={answering || !input.trim()} style={{ ...primaryBtn, padding: '8px 12px', opacity: (answering || !input.trim()) ? 0.5 : 1 }}>发送</button>
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
    <Metric label="已跑 Loop" value={`${state.loops.length} / ${state.effectiveMaxLoops}`} />
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
  onSubmit: () => void; onSeal: () => void; busy: boolean;
  onRemove: (id: string) => void;
}> = ({ state, ideaInput, setIdeaInput, goalDraft, setGoalDraft, onSubmit, onSeal, busy, onRemove }) => {
  const runningCount = state.ideas.filter((i) => i.status === 'running').length;
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--theme-text-muted)', margin: '0 0 12px' }}>
        头脑风暴阶段 · 非阻塞投递想法，后端最多 3 个并发展开。封口后形成全局目标并单向进入 loopexecute。
        {runningCount > 0 && <span style={{ color: 'var(--theme-accent)' }}> · {runningCount} 个进行中</span>}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <textarea
          value={ideaInput}
          onChange={(e) => setIdeaInput(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit(); }}
          placeholder="一条想法/方向…（Ctrl/Cmd+Enter 投递）"
          style={{ ...inputBase, minHeight: 56, resize: 'vertical', flex: 1 }}
        />
        <button onClick={onSubmit} disabled={!ideaInput.trim()} style={{ ...primaryBtn, opacity: ideaInput.trim() ? 1 : 0.5 }}>投递</button>
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
  addons: Addon[]; onAdd: (text: string) => void; onRemove: (id: string) => void;
}> = ({ addons, onAdd, onRemove }) => {
  const [text, setText] = useState('');
  const pending = addons.filter((a) => a.status === 'pending');
  const applied = addons.filter((a) => a.status === 'applied');
  const submit = () => { const t = text.trim(); if (!t) return; setText(''); onAdd(t); };
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
        随手补充要求 —— <b>不影响当前正在跑的 loop</b>；下一次 loop 的分析与规划会带上并设法完成。纳入前可随时增删。
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: pending.length || applied.length ? 10 : 0 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="补充一条要求 / 修正…（Enter 添加）"
          style={{ ...inputBase, flex: 1 }}
        />
        <button onClick={submit} disabled={!text.trim()} style={{ ...btn, opacity: text.trim() ? 1 : 0.5 }}>＋ 添加</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pending.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 10px', borderRadius: 8, background: '#bf87000d', border: '1px solid #bf870033' }}>
            <span style={{ fontSize: 12, color: '#bf8700', marginTop: 1 }}>●</span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--theme-text)', whiteSpace: 'pre-wrap' }}>{a.text}</span>
            <button onClick={() => onRemove(a.id)} style={miniX} title="删除">✕</button>
          </div>
        ))}
        {applied.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 10px', borderRadius: 8, opacity: 0.6 }}>
            <span style={{ fontSize: 11, color: '#2da44e', marginTop: 1 }}>✓</span>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--theme-text-muted)', textDecoration: 'line-through', whiteSpace: 'pre-wrap' }}>{a.text}</span>
            <span style={{ fontSize: 10, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>已纳入 #{a.appliedSeq}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ══ Execute stage ═════════════════════════════════════════════
const ExecuteStage: React.FC<{
  state: LoopStateT; progress: Record<string, string>;
  selectedSeq: number | null; setSelectedSeq: (v: number | null) => void;
  onRun: () => void; onAdvanceOut: () => void; onSetAuto: (on: boolean) => void;
  onAddAddon: (text: string) => void; onRemoveAddon: (id: string) => void;
  running: boolean; busy: boolean;
  goalDraft: string; setGoalDraft: (v: string) => void; onSaveGoal: () => void;
}> = ({ state, progress, selectedSeq, setSelectedSeq, onRun, onAdvanceOut, onSetAuto, onAddAddon, onRemoveAddon, running, busy, goalDraft, setGoalDraft, onSaveGoal }) => {
  const isOut = state.stage === 'loopout';
  const selected = state.loops.find((l) => l.seq === selectedSeq) || null;
  const [editGoal, setEditGoal] = useState(false);
  const runLabel = state.resumable
    ? `▶ 继续未完成的 Loop #${state.loops.length}`
    : `▶ 运行第 ${state.loops.length + 1} 次 Loop`;

  return (
    <div>
      {/* 全局目标 */}
      <div style={{ ...sealBox, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>🎯 全局目标</span>
          <div style={{ flex: 1 }} />
          {!isOut && (
            <button onClick={() => { setEditGoal(!editGoal); setGoalDraft(state.goal); }} style={btn}>
              {editGoal ? '取消' : '编辑'}
            </button>
          )}
        </div>
        {editGoal ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <textarea value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)} style={{ ...inputBase, flex: 1, minHeight: 54 }} />
            <button onClick={() => { onSaveGoal(); setEditGoal(false); }} style={primaryBtn}>保存</button>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: state.goal ? 'var(--theme-text)' : 'var(--theme-text-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {state.goal || '（封口后由模型收敛中…刷新可见）'}
          </div>
        )}
      </div>

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
          {state.auto && running && (
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>完成本次后将自动继续…</span>
          )}
        </div>
      )}
      {isOut && state.stopReason && (
        <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--theme-text-muted)' }}>
          ⏹ 收口原因：{state.stopReason}
        </div>
      )}

      {/* ★ 执行中补充（addon）：不影响当前 loop，下一次 loop 纳入并完成 */}
      {!isOut && <AddonPanel addons={state.addons || []} onAdd={onAddAddon} onRemove={onRemoveAddon} />}

      {/* Loop 时间轴 */}
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 12, marginBottom: 8 }}>
        {state.loops.length === 0 && <div style={{ color: 'var(--theme-text-muted)', fontSize: 13 }}>还没有 loop，点击上方按钮开始第 1 次。</div>}
        {state.loops.map((l) => (
          <LoopNode key={l.seq} loop={l} selected={l.seq === selectedSeq} onClick={() => setSelectedSeq(l.seq === selectedSeq ? null : l.seq)} />
        ))}
      </div>

      {/* 详情面板 */}
      {selected && <LoopDetail loop={selected} progress={progress} onClose={() => setSelectedSeq(null)} />}
    </div>
  );
};

const LoopNode: React.FC<{ loop: LoopRecord; selected: boolean; onClick: () => void }> = ({ loop, selected, onClick }) => {
  const score = loop.analysis?.score ?? null;
  const subIdx = SUB_ORDER.indexOf(loop.subStage);
  return (
    <div
      onClick={onClick}
      style={{
        flexShrink: 0, width: 150, cursor: 'pointer', padding: 12, borderRadius: 12,
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
        transition: 'all 0.15s',
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

      <Section title="本次执行结果">
        {loop.result ? <Md text={loop.result} />
          : liveExec ? <Live text={liveExec} /> : '—'}
      </Section>

      {loop.analysis ? (
        <Section title={`Execute Analysis · 分数 ${loop.analysis.score.toFixed(0)}`}>
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
      ) : liveAna ? <Section title="Execute Analysis（进行中）"><Live text={liveAna} /></Section> : null}

      {loop.error && <Section title="错误"><span style={{ color: '#f87171' }}>{loop.error}</span></Section>}
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{title}</div>
    <div style={{ fontSize: 13, color: 'var(--theme-text)' }}>{children}</div>
  </div>
);

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

// ══ Hack / terminal view ══════════════════════════════════════
const HackView: React.FC<{ state: LoopStateT; progress: Record<string, string> }> = ({ state, progress }) => {
  const text = useMemo(() => renderHack(state, progress), [state, progress]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return (
    <pre ref={ref} style={{
      flex: 1, overflow: 'auto', margin: 0, padding: 18,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5, lineHeight: 1.55,
      background: '#0b0e14', color: '#9ece6a', whiteSpace: 'pre-wrap',
    }}>{text}</pre>
  );
};

function renderHack(s: LoopStateT, progress: Record<string, string>): string {
  const L: string[] = [];
  L.push('┌─ LOOP SESSION ───────────────────────────────');
  L.push(`│ stage   : ${s.stage}`);
  L.push(`│ status  : ${s.status}${s.stopReason ? `  (${s.stopReason})` : ''}`);
  L.push(`│ goal    : ${s.goal || '(none)'}`);
  L.push(`│ risk    : ${s.riskCoefficient.toFixed(2)}   loops ${s.loops.length}/${s.effectiveMaxLoops}   best ${s.bestScore.toFixed(0)}  latest ${s.latestScore.toFixed(0)}`);
  L.push('└──────────────────────────────────────────────');
  if (s.stage === 'loopidea') {
    L.push('');
    L.push('# IDEAS');
    s.ideas.forEach((i) => {
      L.push(`  [${i.status.padEnd(7)}] ${i.prompt}`);
      if (i.result) i.result.split('\n').forEach((r) => L.push(`            ${r}`));
      if (i.error) L.push(`            ! ${i.error}`);
    });
  }
  s.loops.forEach((l) => {
    L.push('');
    L.push(`# LOOP #${l.seq}  [${l.subStage}]  ${l.analysis ? 'score=' + l.analysis.score.toFixed(0) : (l.error ? 'ERROR' : '...')}`);
    L.push(`  goal: ${l.goal || '—'}`);
    l.orchestration.forEach((o) => L.push(`   ${o.index}. (${o.mode}) ${o.desc}`));
    const liveP = progress[`${l.seq}:prepare`];
    const liveE = progress[`${l.seq}:execute`];
    const liveA = progress[`${l.seq}:analysis`];
    if (l.result) { L.push('  result:'); l.result.split('\n').forEach((r) => L.push(`    ${r}`)); }
    else if (liveE) { L.push('  exec~:'); liveE.split('\n').slice(-12).forEach((r) => L.push(`    ${r}`)); }
    else if (liveP) { L.push('  prep~:'); liveP.split('\n').slice(-6).forEach((r) => L.push(`    ${r}`)); }
    if (l.analysis) {
      L.push(`  analysis: opt=${(l.analysis.optimizationPotential * 100).toFixed(0)}% trend=${l.analysis.trend} deliverable=${l.analysis.deliverable} output=${l.analysis.outputtable}`);
      if (l.analysis.notes) l.analysis.notes.split('\n').forEach((r) => L.push(`    ${r}`));
      if (l.analysis.challenges) L.push(`    ! ${l.analysis.challenges}`);
    } else if (liveA) { L.push('  ana~:'); liveA.split('\n').slice(-8).forEach((r) => L.push(`    ${r}`)); }
    if (l.error) L.push(`  ! ${l.error}`);
  });
  const pend = (s.addons || []).filter((a) => a.status === 'pending');
  if (pend.length) {
    L.push('');
    L.push('# ADDON (待纳入下一次 loop)');
    pend.forEach((a) => L.push(`  + ${a.text}`));
  }
  if (s.asides && s.asides.length) {
    L.push('');
    L.push('# BY THE WAY (旁路，不污染主线)');
    s.asides.forEach((a) => {
      L.push(`  Q: ${a.question}`);
      (a.answer || '...').split('\n').forEach((r) => L.push(`     ${r}`));
    });
  }
  L.push('');
  L.push('▋');
  return L.join('\n');
}

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

// 注入脉冲动画（一次性）
if (typeof document !== 'undefined' && !document.getElementById('awu-loop-css')) {
  const s = document.createElement('style');
  s.id = 'awu-loop-css';
  s.textContent = `@keyframes awu-loop-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }`;
  document.head.appendChild(s);
}
