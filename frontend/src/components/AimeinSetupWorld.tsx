import React, { useEffect, useRef, useState } from 'react';
import { AimeinWorld } from './AimeinWorld';
import { AimeinSceneDock } from './AimeinSceneDock';
import type { AimeinAnchor } from '../types/aimein';

export const setupButton: React.CSSProperties = { border: '1px solid #48736a', borderRadius: 9, padding: '9px 13px', background: '#193b35', color: '#dfefdf', cursor: 'pointer', fontSize: 12 };
export const setupPrimary: React.CSSProperties = { ...setupButton, background: '#d8eab0', color: '#17382d', borderColor: '#d8eab0', fontWeight: 650 };
export const setupHint: React.CSSProperties = { fontSize: 12, color: '#a6c3b5', lineHeight: 1.8 };
export const setupHighlight: React.CSSProperties = { border: '1px solid #e38d83', borderRadius: 12, padding: 14, boxShadow: '0 0 0 3px #e38d8310' };
const names = ['安放工坊', '点亮目标', '邀请评委', '开始建设'];
const anchors: AimeinAnchor['kind'][] = ['infra', 'goal', 'review', 'flow'];

/** 纯视觉准备层：步骤导航、点击场景和收起卡片不提交任何 RPC。 */
export const AimeinSetupWorld: React.FC<{
  step: number; onStep: (step: number) => void; complete: boolean[];
  title: string; hint: string; children: React.ReactNode; actions?: React.ReactNode; panelOnly?: boolean;
  externalPanel?: boolean; onPanelHost?: React.Ref<HTMLDivElement>;
}> = ({ step, onStep, complete, title, hint, children, actions, panelOnly, externalPanel, onPanelHost }) => {
  const root = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const reveal = (next: number) => { setCollapsed(false); onStep(next); };
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 900));
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { guide.current?.scrollTo(0, 0); }, [step]);
  const guideContent = <aside ref={guide} aria-label="场景准备指引" style={{ minWidth: 0, padding: panelOnly ? 0 : 6, overflowWrap: 'anywhere' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 10, letterSpacing: 2, color: '#c4d69b' }}>STEP {String(step + 1).padStart(2, '0')} / 04</span>
      {!panelOnly && <button type="button" style={{ ...setupButton, padding: '4px 8px', background: 'transparent' }} onClick={() => setCollapsed(true)}>先看看沙盘</button>}</div>
    <h3 style={{ fontSize: 21, fontWeight: 500, margin: '18px 0 8px' }}>{title}</h3><p style={{ ...setupHint, margin: '0 0 18px' }}>{hint}</p>
    {children}
  </aside>;
  return <div ref={root} data-testid="aimein-setup-world" style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, height: panelOnly ? undefined : '100%', color: '#e2eedf', background: '#102725', borderRadius: 14,
    '--theme-text': '#e2eedf', '--theme-text-muted': '#a6c3b5', '--theme-text-secondary': '#bed3c4', '--theme-border': '#456654', '--theme-bg-secondary': '#17362c', '--theme-bg-tertiary': '#203e32', '--theme-input-bg': '#0e241e', '--theme-accent': '#b9d397', '--theme-accent-bg': '#2b4937' } as React.CSSProperties}>
    {!panelOnly && <header style={{ padding: narrow ? 8 : '16px 20px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, flexShrink: 0 }}>
      <div style={{ marginRight: 'auto' }}><div style={{ fontSize: 10, letterSpacing: 4, color: '#afc78e' }}>AIMEIN · YOUR WORLD</div>
        <h2 style={{ fontSize: narrow ? 18 : 26, fontWeight: 500, margin: '6px 0' }}>先进入世界，再让目标成形。</h2></div>{actions}
    </header>}
    <nav aria-label="AIMEIN 建设准备步骤" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 5, padding: panelOnly ? 0 : '0 8px', flexShrink: 0 }}>
      {names.map((name, index) => <button key={name} type="button" aria-current={index === step ? 'step' : undefined} onClick={() => reveal(index)}
        style={{ ...setupButton, minWidth: 0, padding: '8px 3px', textAlign: 'center', background: index === step ? '#30473c' : '#16332d', borderColor: index === step && !complete[index] ? '#e38d83' : index === step ? '#afc78e' : '#365548' }}>
        <span style={{ opacity: .8, marginRight: 4 }}>{complete[index] ? '✓' : `0${index + 1}`}</span>{name}
      </button>)}
    </nav>
    {panelOnly ? guideContent : <AimeinSceneDock balanced={externalPanel} panelRef={onPanelHost} open={!collapsed || !!externalPanel} scene={<>
      <AimeinWorld preparing contained selected={{ kind: anchors[step], seq: 0, ...(step === 2 ? { reviewId: 'review1' } : {}) }} built={false} running={false} latest
        onSelect={anchor => reveal(anchor.kind === 'goal' ? 1 : anchor.kind === 'review' ? 2 : anchor.kind === 'flow' || anchor.kind === 'artifact' ? 3 : 0)} />
      {collapsed && <button type="button" style={setupPrimary} onClick={() => setCollapsed(false)}>继续准备 · {names[step]}</button>}
    </>}><div hidden={externalPanel}>{guideContent}</div></AimeinSceneDock>}
  </div>;
};
