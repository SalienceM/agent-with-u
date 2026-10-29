import React, { useEffect, useState } from 'react';
import type { LoopStateT } from '../types/loopWorkbench';
import type { ActionResult } from '../utils/loopActionController';
import { LoopPolicyEditor, normalizePolicy, aimeinReviewerIssue, type LoopPolicy } from './LoopPolicyEditor';
import { AimeinSetupWorld, setupButton, setupPrimary, setupHint, setupHighlight } from './AimeinSetupWorld';

export const AimeinPreparation: React.FC<{
  state: LoopStateT; workingDir?: string; sessionId: string; execKey: string; backends?: any[]; sessionBackendId?: string;
  busy: boolean; canRequest: boolean; requestReason?: string; step: number | null; onStep: (step: number) => void;
  onGoal: (text: string) => Promise<ActionResult>; onPolicy: (policy: LoopPolicy) => Promise<ActionResult>;
  onRun: () => void; onSettings: () => void; ideas: React.ReactNode; feedback: React.ReactNode;
}> = props => {
  const [goal, setGoal] = useState(props.state.goal || '');
  const [goalDirty, setGoalDirty] = useState(false);
  const [policy, setPolicy] = useState(() => normalizePolicy(props.state.policy));
  const [policyDirty, setPolicyDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { if (!goalDirty) setGoal(props.state.goal || ''); }, [props.state.goal, goalDirty]);
  useEffect(() => { if (!policyDirty) setPolicy(normalizePolicy(props.state.policy)); }, [props.state.policy, policyDirty]);
  const issue = aimeinReviewerIssue(policy, props.backends || []);
  const goalReady = props.state.stage !== 'loopidea' && !!props.state.goal.trim() && !goalDirty;
  const reviewersReady = !policyDirty && !aimeinReviewerIssue(normalizePolicy(props.state.policy), props.backends || []);
  const step = props.step ?? (!goalReady ? 1 : !reviewersReady ? 2 : 3);
  const disabled = props.busy || pending;
  const save = async (kind: 'goal' | 'policy') => {
    if (disabled) return;
    setPending(true); setMessage('');
    try {
      const result = await (kind === 'goal' ? props.onGoal(goal.trim()) : props.onPolicy(policy));
      if (result.status === 'ok') {
        if (kind === 'goal') setGoalDirty(false); else setPolicyDirty(false);
        props.onStep(kind === 'goal' ? 2 : 3);
      } else setMessage(result.message || '保存尚未确认，草稿已保留。');
    } catch (error: any) { setMessage(error?.message || '保存未确认，草稿已保留。'); }
    finally { setPending(false); }
  };
  const next = (value: number) => { setMessage(''); props.onStep(value); };
  const titles = ['工坊已经安放好', '你希望建成什么？', '选择适合这次任务的评委', '准备好了，就开始吧'];
  const hints = ['成果会保存在这座工坊对应的目录。接下来，为它点亮一个清晰的目标。', '描述希望看到的产品与行为。开始后，模型会把它拆成可以逐步核实的阶段。', '可邀请 1–3 位评委，各开独立会话查看同一份成果。评审档案可以在建设中持续完善。', '确认目标与评委后，点击开始。拆分、建设、评审与修补都将在这座沙盘里继续。'];
  return <div data-testid="aimein-preparation">
    <AimeinSetupWorld panelOnly step={step} onStep={next} complete={[true, goalReady, reviewersReady, false]} title={titles[step]} hint={hints[step]}>
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {step === 0 && <>
          <div style={{ ...setupHint, padding: 14, border: '1px solid #456654', borderRadius: 12 }}><b style={{ color: '#d9eac5' }}>✓ 工坊已创建</b><p style={{ overflowWrap: 'anywhere' }}>{props.workingDir || '已使用此会话的工作目录'}</p></div>
          <button type="button" style={{ ...setupPrimary, marginTop: 18 }} onClick={() => next(1)}>去点亮目标 →</button>
        </>}
        {step === 1 && <>
          <div data-testid="aimein-goal-target" style={goalReady ? { ...setupHighlight, borderColor: '#86ac83' } : setupHighlight}>
            <label htmlFor={`aimein-goal-${props.sessionId}`} style={{ fontSize: 12, color: goalReady ? '#c4d69b' : '#efaaa0' }}>{goalReady ? '目标已保存 · 可以继续调整' : '02 · 在这里写下你的目标'}</label>
            <textarea id={`aimein-goal-${props.sessionId}`} aria-label="AIMEIN 建设目标" rows={6} value={goal} onChange={event => { setGoal(event.target.value); setGoalDirty(true); }} placeholder="例如：做一个可以记录灵感、分类整理，并随时找回内容的小工具。"
              style={{ marginTop: 10, width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 150, border: '1px solid #527363', borderRadius: 8, padding: 12, background: '#0e241e', color: '#e2eedf', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.8 }} />
          </div>
          <button type="button" style={{ ...setupPrimary, marginTop: 18, width: '100%', opacity: !goal.trim() ? .5 : 1 }} disabled={!goal.trim()} onClick={() => goalReady ? next(2) : void save('goal')}>
            {pending ? '正在保存目标…' : goalReady ? '下一步，邀请评委 →' : '保存目标，下一步 →'}
          </button>
          <details style={{ ...setupHint, marginTop: 14 }}><summary>想法与参考{props.state.ideas.length ? ` · ${props.state.ideas.length}` : ''}</summary>{props.ideas}</details>
        </>}
        {step === 2 && <>
          <div data-testid="aimein-reviewers-target" style={{ ...setupHighlight, padding: 8, borderColor: reviewersReady ? '#86ac83' : '#e38d83' }}>
            <div style={{ ...setupHint, color: '#efaaa0', padding: '4px 6px 10px' }}>{issue ? `03 · ${issue}` : policyDirty ? '03 · 配置有改动，保存后继续' : '03 · 评委已配置'}</div>
            <LoopPolicyEditor value={policy} onChange={value => { setPolicy(value); setPolicyDirty(true); }} availableBackends={props.backends}
              sessionBackendId={props.sessionBackendId} sessionId={props.sessionId} execKey={props.execKey} />
          </div>
          <button type="button" style={{ ...setupPrimary, width: '100%', marginTop: 18, opacity: issue ? .5 : 1 }} disabled={!!issue} onClick={() => policyDirty ? void save('policy') : next(3)}>
            {pending ? '正在保存评委…' : policyDirty ? '保存评委，下一步 →' : '下一步，检查准备 →'}
          </button>
          <button type="button" style={{ ...setupButton, marginTop: 10 }} onClick={props.onSettings}>更多评审与执行设置</button>
        </>}
        {step === 3 && <>
          <div style={{ ...setupHighlight, borderColor: goalReady && reviewersReady ? '#a7c78b' : '#e38d83' }}>
            <div style={setupHint}>✓ 工坊已创建</div>
            <button type="button" style={{ ...setupButton, display: 'block', width: '100%', textAlign: 'left', marginTop: 9 }} onClick={() => next(1)}>{goalReady ? '✓ 目标已保存' : '02 · 目标还需要确认'} →</button>
            <button type="button" style={{ ...setupButton, display: 'block', width: '100%', textAlign: 'left', marginTop: 9 }} onClick={() => next(2)}>{reviewersReady ? '✓ 评审组已保存' : '03 · 评委配置还未完成'} →</button>
            {goalReady && reviewersReady && <p style={setupHint}>配置齐全。开始时会再次检查连接、权限与执行条件。</p>}
          </div>
          {!goalReady || !reviewersReady ? <button type="button" style={{ ...setupPrimary, width: '100%', marginTop: 18 }} onClick={() => next(!goalReady ? 1 : 2)}>补齐{!goalReady ? '目标' : '评委配置'} →</button> : <>
            <button type="button" style={{ ...setupPrimary, width: '100%', marginTop: 18, opacity: !props.canRequest ? .5 : 1 }} disabled={!props.canRequest} onClick={props.onRun}>开始建设 →</button>
            {!props.canRequest && <p role="status" style={{ ...setupHint, color: '#efaaa0' }}>{props.requestReason || '当前执行条件尚未就绪，请查看工作台提示。'}</p>}
          </>}
        </>}
      </fieldset>
      {message && <p role="alert" style={{ ...setupHint, color: '#f0aea2' }}>{message}</p>}
      {props.feedback}
    </AimeinSetupWorld>
  </div>;
};
