import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { LoopRecord } from '../types/loopWorkbench';
import type { AimeinAnchor } from '../types/aimein';
import { worldProjection, flowProjection, taskPage, TASK_PAGE_SIZE, type WorldLayout } from '../utils/aimeinWorld';
import { AimeinTaskMap } from './AimeinTaskMap';
import { AimeinWorldStatic } from './AimeinWorldStatic';
import { AimeinHotbar, tools } from './AimeinHotbar';
import type { AimeinPlayState } from '../utils/aimeinPlay';

const Scene = lazy(() => import('./AimeinWorldScene'));
const controlStyle: React.CSSProperties = { border: '1px solid #487573', borderRadius: 8, background: '#153b3b', color: '#d9eee3', padding: '8px 12px', fontSize: 12, cursor: 'pointer' };

class SceneBoundary extends React.Component<{ children: React.ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export const AimeinWorld: React.FC<{
  current?: LoopRecord; selected: AimeinAnchor; built: boolean; running: boolean; latest: boolean; onSelect: (value: AimeinAnchor) => void;
  preparing?: boolean; immersive?: boolean; contained?: boolean;
  reviewerCount?: number; observing?: boolean; onModeChange?: (value: '3d' | 'static' | 'fallback') => void;
  play?: AimeinPlayState;
  goal?: string; activityLabel?: string;
}> = props => {
  const { current, selected, onSelect } = props;
  const projection = useMemo(() => worldProjection(current), [current]);
  const motion = useMemo(() => flowProjection(current, props.running, props.latest), [current, props.running, props.latest]);
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setCompact(!!props.contained && (entry.contentRect.width < 600 || entry.contentRect.height < 360)));
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [props.contained]);
  const actionStyle: React.CSSProperties = compact ? { ...controlStyle, padding: '4px 7px', fontSize: 10, flexShrink: 0 } : controlStyle;
  const [active, setActive] = useState(true);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [staticView, setStaticView] = useState(false);
  const [failure, setFailure] = useState('');
  const [ready, setReady] = useState(false);
  const [lowQuality, setLowQuality] = useState(false);
  const [choice, setChoice] = useState<{ basis: string; layout: WorldLayout }>();
  const [replay, setReplay] = useState(0);
  const [phase, setPhase] = useState('');
  const [focus, setFocus] = useState<{ anchor: AimeinAnchor | null; serial: number }>({ anchor: null, serial: 0 });
  const layout = props.play?.tool === 'assemble' ? 'split' : choice?.basis === projection.basis ? choice.layout : projection.layout;
  const useStatic = staticView || !!failure;
  useEffect(() => { props.onModeChange?.(failure ? 'fallback' : staticView ? 'static' : '3d'); }, [failure, staticView, props.onModeChange]);
  const quietStatic = compact && useStatic && props.observing;
  const taskIdentity = JSON.stringify([projection.seq, projection.targets.map(t => t.id)]);
  const [taskView, setTaskView] = useState({ identity: '', page: 0, target: '' });
  const [hoverId, setHoverId] = useState('');
  const targetId = props.play?.targetId ?? (taskView.identity === taskIdentity ? taskView.target : '');
  const page = taskPage(projection.targets, taskView.identity === taskIdentity ? taskView.page : 0).page;
  const showTaskPage = (next: number) => { setHoverId(''); setTaskView(v => ({ ...v, identity: taskIdentity, page: next })); };
  const chooseTarget = (id: string, inspect = false) => {
    const index = projection.targets.findIndex(t => t.id === id);
    if (index < 0 && id) return;
    setTaskView({ identity: taskIdentity, page: index < 0 ? page : Math.floor(index / TASK_PAGE_SIZE), target: id });
    setHoverId('');
    if (inspect) props.play?.onInspectTarget?.(id);
    else props.play?.onTarget(id);
  };
  useEffect(() => {
    setHoverId('');
    const index = projection.targets.findIndex(t => t.id === targetId);
    if (index >= 0) setTaskView({ identity: taskIdentity, page: Math.floor(index / TASK_PAGE_SIZE), target: targetId });
  }, [targetId, taskIdentity]);
  const stripStyle: React.CSSProperties = props.contained ? { flexWrap: 'nowrap', overflowX: 'auto', flexShrink: 0, whiteSpace: 'nowrap', padding: '5px 8px' } : {};
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    let visible = true;
    const visibility = () => setActive(visible && !document.hidden);
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; visibility(); }, { threshold: .05 });
    if (root.current) observer.observe(root.current);
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => { observer.disconnect(); query.removeEventListener('change', update); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    if (!replay || !active || useStatic || reduced || !projection.scoped) { setPhase(''); return; }
    setChoice({ basis: projection.basis, layout: 'split' }); setPhase('视觉回放 · 拆分子目标');
    const gather = window.setTimeout(() => { setChoice({ basis: projection.basis, layout: 'cluster' }); setPhase('视觉回放 · 聚合本阶段'); }, 1200);
    const finish = window.setTimeout(() => setPhase(''), 3400);
    return () => { clearTimeout(gather); clearTimeout(finish); };
    // 离屏/历史切换取消回放；恢复可见时不自动补播。
  }, [replay]);
  useEffect(() => { setReplay(0); setPhase(''); }, [projection.basis, active, useStatic, reduced]);
  const choose = (value: AimeinAnchor) => { setMenu(false); setFocus(f => ({ anchor: value, serial: f.serial + 1 })); onSelect(value); };
  const selectLayout = (next: WorldLayout) => { setMenu(false); setReplay(0); setPhase(''); setChoice({ basis: projection.basis, layout: next }); };
  const items: Array<{ name: string; kind: AimeinAnchor['kind']; reviewId?: string }> = [
    { name: '目标灯塔与目标瓶', kind: 'goal' }, { name: '功能工坊', kind: 'flow' }, { name: '基础设施', kind: 'infra' }, { name: '成果架', kind: 'artifact' },
    ...Array.from({ length: props.reviewerCount ?? 3 }, (_, i) => ({ name: `评委 ${i + 1}`, kind: 'review' as const, reviewId: current?.aimeinSummary?.reviews[i]?.id || `review${i + 1}` })),
  ];
  // 窄屏历史条参与菜单滚动，不再绝对定位压住底部的评委按钮。
  const historyStrip = props.play && !!props.play.footprints.length && <nav aria-label="世界足迹" style={{ display: (compact || props.observing) && !menu ? 'none' : 'flex', gap: 5, padding: '5px 8px', flexShrink: 0, overflowX: 'auto', fontSize: 10, alignItems: 'center', background: '#0d2325' }}><span style={{ color: '#93ac97', whiteSpace: 'nowrap' }}>世界足迹</span>{props.play.footprints.map(f => <button key={f.seq} aria-label={`足迹 #${f.seq}：${f.title}`} aria-pressed={projection.seq === f.seq} onClick={() => { setMenu(false); props.play!.onHistory(f.seq); }} style={{ ...actionStyle, padding: '3px 7px', font: '11px monospace', color: f.accepted ? '#c6e4aa' : '#cfb786', borderColor: projection.seq === f.seq ? '#d6d5a2' : '#35564b', whiteSpace: 'nowrap' }} title={`${f.title} · ${f.saved === null ? '输出详情待展开' : `${f.saved} 步已保存`} · ${f.accepted ? '阶段通过' : '尚未通过'}`}>{f.accepted ? '▣' : '◇'} {f.seq}</button>)}</nav>;
  return <div ref={root} tabIndex={0} aria-label="交互沙盘" onKeyDown={event => {
    if (event.key === 'Escape' && menu) { event.stopPropagation(); setMenu(false); return; }
    if (!props.play || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    const tool = tools[Number(event.key) - 1];
    if (tool) { event.preventDefault(); props.play.onTool(tool.id); }
  }} data-testid="aimein-world" data-tool={props.play?.tool} data-layout={layout} data-active={active} data-reduced-motion={reduced} style={{ position: 'relative', border: '1px solid #315e5a', borderRadius: 18, overflow: 'hidden', background: '#10282b', color: '#dceee2', minWidth: 0, ...(props.contained ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : {}) }}>
    <div style={{ padding: '16px 18px 10px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', ...stripStyle }}>
      <div style={{ marginRight: 'auto', minWidth: 0, flex: 1 }}><div data-testid="aimein-world-activity" style={{ fontSize: 11, color: motion.activity.length ? '#b9edbe' : '#a2c8b2' }}>{props.activityLabel ? `${motion.activity.length ? '●' : '◇'} ${props.activityLabel}` : 'AIMEIN'}{motion.activity.length > 0 && reduced ? ' · 正在工作（减少动态）' : ''}</div>{!props.contained && <strong style={{ display: 'block', marginTop: 6, fontSize: 17 }}>{props.preparing ? '你的第一座工坊' : '目标正在这里成形'}</strong>}</div>
      {props.play && <button style={actionStyle} aria-expanded={menu} onClick={() => setMenu(v => !v)}>场景菜单</button>}
      <button style={actionStyle} aria-pressed={useStatic} disabled={!!failure} onClick={() => setStaticView(v => !v)}>{useStatic ? '切换 3D 沙盘' : '静态视图'}</button>
      {!useStatic && <button style={actionStyle} aria-pressed={lowQuality} onClick={() => setLowQuality(v => !v)}>{lowQuality ? '画质 · 轻量' : '画质 · 标准'}</button>}
    </div>
    {failure && <p role="status" title={`${failure}，已保留静态场景和所有观察入口。`} style={{ padding: '0 12px', margin: '3px 0', fontSize: 11 }}>{compact ? '3D 不可用 · 已切换静态场景' : `${failure}，已保留静态场景和所有观察入口。`}</p>}
    {useStatic ? <AimeinWorldStatic {...props} onSelect={choose} /> : <>
      <div data-testid="aimein-3d-viewport" data-ready={ready} style={{ position: 'relative', ...(props.contained ? { flex: 1, minHeight: 0 } : { height: props.immersive ? 'clamp(290px, calc(100dvh - 320px), 650px)' : 'clamp(310px, calc(100dvh - 400px), 560px)' }), background: 'radial-gradient(ellipse at 48% 30%, #254e4d, #0c2026 80%)' }}>
        <SceneBoundary onFailure={() => setFailure('3D 场景加载失败')}><Suspense fallback={<div role="status" style={{ padding: 36 }}>正在搭建 3D 沙盘…</div>}>
          <Scene projection={projection} motion={motion} layout={layout} built={props.built} selected={selected} reviews={current?.aimeinSummary?.reviews || []} reviewerCount={props.reviewerCount ?? 3}
            play={props.play} taskPage={page} targetId={targetId} hoverId={hoverId} onTarget={chooseTarget} onHover={setHoverId}
            focus={focus} active={active} reduced={reduced} lowQuality={lowQuality} onSelect={choose} onReady={() => setReady(true)} onFailure={() => setFailure('当前设备的 3D 渲染不可用')} />
        </Suspense></SceneBoundary>
        <div style={{ position: 'absolute', top: compact ? 5 : 14, left: compact ? 8 : 18, pointerEvents: 'none', maxWidth: '60%' }}>
          <div style={{ color: '#94b8b0', fontSize: 11 }}>{props.preparing ? '建设准备 · 尚未开始' : `观察版本 ${projection.seq ? `#${projection.seq}` : '· 等待规划'}`}</div>
          {props.observing && !compact && <div style={{ fontSize: 21, marginTop: 8, lineHeight: 1.5, maxWidth: 290, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{props.goal || '目标正在这里成形'}</div>}
          <div data-testid="aimein-vessel-value" style={{ fontSize: props.observing ? 13 : compact ? 15 : 25, marginTop: compact ? 2 : 6, fontWeight: 600, color: props.observing ? '#a5c4b3' : undefined }}>{projection.observation.known ? `${projection.observation.verified} / ${projection.observation.total}` : '待核实'}<span style={{ fontSize: 11, marginLeft: 7, fontWeight: 400 }}>整体目标</span></div>
          {!compact && <div title={props.goal} style={{ color: '#91b5ab', fontSize: 11, marginTop: 5, maxWidth: 270, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{props.preparing ? '点击灯塔、工坊或评委席开始准备' : projection.targets.length ? `${projection.targets.length} 个子目标 · ${projection.targets.filter(t => t.inSprint).length} 个纳入本阶段` : props.goal || '等待已保存的目标详情'}</div>}
        </div>
        {!props.preparing && <div data-testid="aimein-flow-status" style={{ position: 'absolute', top: 14, right: 14, maxWidth: '36%', textAlign: 'right', pointerEvents: 'none', fontSize: 11, color: '#b5d9d3', lineHeight: 1.8 }}>
          <div style={{ color: motion.status === 'repair' ? '#ffc276' : '#80f1d5' }}>{!props.latest ? '历史观察' : props.activityLabel || ({ planning: '目标拆解', preparing: '阶段聚合', executing: '工坊建设', reviewing: '独立评审', accepted: '阶段通过', repair: '回流修补' } as Record<string, string>)[motion.status] || '等待处理'}</div>
          {!compact && <><div>已保存产出 {motion.saved.length} / {motion.totalSteps} 步</div>
          <div style={{ color: '#88aaa6' }}>{motion.activity.length ? '搬运中 · 表示执行活动' : '当前保存状态'}</div></>}
        </div>}
        <button style={{ ...actionStyle, position: 'absolute', right: 14, bottom: 14, background: '#153b3be8' }} onClick={() => setFocus(f => ({ anchor: null, serial: f.serial + 1 }))}>回到全景</button>
        {!compact && <div style={{ position: 'absolute', left: 18, bottom: 17, color: '#a5c8bd', fontSize: 11, pointerEvents: 'none', maxWidth: '65%' }}>{phase || (reduced ? '已按偏好减少动态效果' : '拖动环视 · 点击观察 · 双指缩放')}</div>}
      </div>
      <div style={props.play ? { display: menu ? 'block' : 'none', position: 'absolute', top: compact ? 35 : 48, left: 6, right: 6, maxHeight: '75%', overflow: 'auto', zIndex: 5, background: '#102c2cf5', border: '1px solid #68846c', borderRadius: 8 } : { flexShrink: 0 }}>
      {!props.preparing && <details open={!props.contained || compact && !!props.play} style={{ flexShrink: 0, maxHeight: props.contained && !compact ? '35%' : undefined, overflow: 'auto' }}>
        <summary style={{ padding: '5px 8px', cursor: 'pointer', fontSize: 11 }}>拆分、聚合与路径</summary>
        <div style={{ padding: '12px 18px', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', borderTop: '1px solid #31514d', ...stripStyle }}>
        <button style={actionStyle} disabled={!projection.targets.length} aria-pressed={layout === 'split'} onClick={() => selectLayout('split')}>拆分目标</button>
        <button style={actionStyle} disabled={!projection.scoped} aria-pressed={layout === 'cluster'} onClick={() => selectLayout('cluster')}>聚合本阶段</button>
        <button style={actionStyle} disabled={!projection.scoped || reduced || !ready || !active} onClick={() => { setMenu(false); setReplay(n => n + 1); }}>▷ 回放拆分聚合</button>
        <span style={{ fontSize: 11, color: '#94b8ac' }}>视觉观察，不启动执行</span>
      </div>
      <nav aria-label="工作流路径" style={{ padding: '0 18px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, ...stripStyle }}>
        <span style={{ fontSize: 11, color: '#a2c0b4', marginRight: 4 }}>沿路径观察</span>
        {([{ name: '建设 → 产出', kind: 'artifact' }, ...motion.reviews.map((r, i) => ({ name: `产出 → 评委 ${i + 1}`, kind: 'review', reviewId: r.id })), { name: '核实 → 目标瓶', kind: 'goal' }, ...(motion.status === 'repair' ? [{ name: '修补 → 工坊', kind: 'flow' }] : [])] as Array<{ name: string; kind: AimeinAnchor['kind']; reviewId?: string }>).map(item =>
          <button key={item.name} style={{ ...actionStyle, padding: '6px 9px', background: '#142e30', color: '#b9dacd' }} aria-label={`路径：${item.name}`} onClick={() => choose({ kind: item.kind, reviewId: item.reviewId, seq: projection.seq })}>{item.name}</button>)}
      </nav>
      {props.contained && <details style={{ margin: '4px 8px 10px', fontSize: 12 }}><summary>子目标与阶段范围</summary>{projection.targets.map(t => <p key={t.id}>{t.id} · {t.title} · {t.verified ? '共同核实' : '待核实'} · {t.inSprint ? '本阶段' : projection.scoped ? '阶段外' : '范围待确认'}</p>)}</details>}
      </details>}
      <nav aria-label="沙盘对象" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 18px 16px', ...stripStyle }}>{items.map(item => {
        const isSelected = selected.kind === item.kind && selected.reviewId === item.reviewId;
        return <button key={item.name} aria-label={`观察${item.name}`} aria-pressed={isSelected} style={{ ...actionStyle, background: isSelected ? '#cee1ad' : '#193634', color: isSelected ? '#16372b' : '#c8dfd1' }} onClick={() => choose({ kind: item.kind, reviewId: item.reviewId, seq: projection.seq })}>{item.name}</button>;
      })}</nav>
      {compact && historyStrip}
      </div>
      {!props.preparing && !props.contained && <details style={{ margin: '0 18px 16px', fontSize: 12, color: '#a9c7b9' }}><summary style={{ cursor: 'pointer' }}>子目标与阶段范围</summary>{projection.targets.map(t => <p key={t.id}>{t.id} · {t.title} · {t.verified ? '共同核实' : '待核实'} · {t.inSprint ? '本阶段' : projection.scoped ? '阶段外' : '范围待确认'}</p>)}</details>}
    </>}
    <div style={quietStatic ? { display: menu ? 'flex' : 'none', flexDirection: 'column', position: 'absolute', top: 35, left: 6, right: 6, maxHeight: '75%', overflow: 'auto', zIndex: 5, background: '#102c2c', border: '1px solid #68846c', borderRadius: 8 } : compact && useStatic ? { display: 'flex', flexDirection: 'column', flex: '0 1 auto', minHeight: 60, overflow: 'hidden' } : { display: 'contents' }}>
      <div style={compact && useStatic ? { minHeight: 0, overflow: 'auto', flex: 1 } : { display: 'contents' }}>
        {(!compact || !props.observing || menu || useStatic) && <AimeinTaskMap targets={projection.targets} page={page} selected={targetId} hover={hoverId} quiet={props.observing} compact={compact} staticView={useStatic} onPage={showTaskPage} onTarget={id => chooseTarget(id, true)} />}
      </div>
      {props.play && <AimeinHotbar play={{ ...props.play, onTool: tool => { setMenu(false); props.play!.onTool(tool); } }} compact={compact} quiet={props.observing || compact && useStatic} />}
      {quietStatic && historyStrip}
    </div>
    {compact && useStatic && !quietStatic && menu && <div style={{ position: 'absolute', top: 35, left: 6, right: 6, maxHeight: '75%', overflow: 'auto', zIndex: 5, background: '#102c2c', border: '1px solid #68846c', borderRadius: 8 }}>{historyStrip}</div>}
    {!compact && historyStrip}
  </div>;
};
