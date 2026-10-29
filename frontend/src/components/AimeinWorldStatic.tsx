import React, { useId, useEffect, useRef, useState } from 'react';
import type { LoopRecord } from '../types/loopWorkbench';
import type { AimeinAnchor } from '../types/aimein';
import { goalObservation } from '../utils/aimeinWorld';

const Cube: React.FC<{ x: number; y: number; size?: number; height?: number; color?: string; pale?: boolean }> = ({ x, y, size = 28, height = 26, color = '#73b99b', pale }) => <g opacity={pale ? .4 : 1}>
  <path d={`M${x},${y} l${size},${size / 2} v${height} l-${size},-${size / 2}Z`} fill={color} />
  <path d={`M${x + size},${y + size / 2} l${size},-${size / 2} v${height} l-${size},${size / 2}Z`} fill={color} filter="brightness(.65)" />
  <path d={`M${x},${y} l${size},-${size / 2} l${size},${size / 2} l-${size},${size / 2}Z`} fill={color} filter="brightness(1.2)" />
</g>;

export const AimeinWorldStatic: React.FC<{
  current?: LoopRecord; selected: AimeinAnchor; built: boolean; onSelect: (value: AimeinAnchor) => void; contained?: boolean; reviewerCount?: number;
}> = ({ current, selected, built, onSelect, contained, reviewerCount = 3 }) => {
  const uid = useId().replace(/:/g, '');
  const viewport = useRef<HTMLDivElement>(null);
  const [sceneWidth, setSceneWidth] = useState(0);
  useEffect(() => {
    if (!contained || !viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setSceneWidth(Math.min(entry.contentRect.width, entry.contentRect.height * 900 / 530)));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [contained]);
  const observation = goalObservation(current);
  const run = current?.aimeinSummary;
  const compact = contained && sceneWidth < 500;
  const items: Array<{ kind: AimeinAnchor['kind']; name: string; x: number; y: number; reviewId?: string }> = [
    { kind: 'goal', name: '目标灯塔与目标瓶', x: 58, y: 16 },
    { kind: 'flow', name: '功能工坊', x: 27, y: 39 },
    { kind: 'infra', name: '基础设施', x: 72, y: 51 },
    { kind: 'artifact', name: '成果架', x: 18, y: 70 },
    ...Array.from({ length: reviewerCount }, (_, i) => ({ kind: 'review' as const, name: `评委 ${i + 1}`, x: 41 + i * 15, y: 86, reviewId: run?.reviews[i]?.id || `review${i + 1}` })),
  ];
  const active = (item: typeof items[number]) => selected.kind === item.kind && selected.reviewId === item.reviewId;
  return <div data-testid="aimein-world-static" style={{ border: '1px solid #385b57', borderRadius: 16, overflow: 'hidden', background: '#112927', color: '#dceddc', ...(contained ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } : {}) }}>
    <div ref={viewport} style={{ position: 'relative', isolation: 'isolate', ...(contained ? { flex: 1, minHeight: 0 } : {}) }}>
    <div style={contained ? { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: sceneWidth, aspectRatio: '900 / 530' } : { position: 'relative' }}>
      <svg viewBox="0 0 900 530" role="img" aria-label={`AIMEIN 方块建设场景，目标瓶、功能工坊、基础设施、成果与 ${reviewerCount} 位评委`} style={{ display: 'block', width: '100%' }}>
        <defs>
          <linearGradient id={`${uid}-sky`} x2="0" y2="1"><stop stopColor="#193d38" /><stop offset="1" stopColor="#0f2427" /></linearGradient>
          <linearGradient id={`${uid}-glow`}><stop stopColor="#b2e2a5" stopOpacity="0" /><stop offset="1" stopColor="#b2e2a5" stopOpacity=".13" /></linearGradient>
          <clipPath id={`${uid}-bottle`}><path d="M457 122 H503 V156 H518 V252 H442 V156 H457Z" /></clipPath>
          <pattern id={`${uid}-grid`} width="64" height="32" patternUnits="userSpaceOnUse"><path d="M32 0L64 16L32 32L0 16Z" fill="none" stroke="#82ab95" strokeOpacity=".07" /></pattern>
        </defs>
        <path d="M0 0H900V530H0Z" fill={`url(#${uid}-sky)`} />
        <path d="M0 0H900V530H0Z" fill={`url(#${uid}-grid)`} />
        <path d="M0 142L68 102L68 81L126 48L194 82L194 113L250 143L0 286Z" fill="#244d40" opacity=".55" />
        <path d="M765 100L819 72L819 46L900 0V263L785 211Z" fill="#244d40" opacity=".55" />
        <path d="M95 297L420 126L820 327L493 503Z" fill="#091d1c" opacity=".7" />
        <path d="M94 282L419 111L820 312L493 486L94 305Z" fill="#294a3e" />
        <path d="M94 282L419 111L820 312L493 462Z" fill="#426553" />
        <path d="M94 282L419 111L820 312L493 462Z" fill={`url(#${uid}-grid)`} />
        <path d="M262 247L444 338L619 249M444 338L444 400" fill="none" stroke="#99ae7e" strokeWidth="17" opacity=".65" />
        <path d="M262 247L444 338L619 249M444 338L444 400" fill="none" stroke="#d0c79b" strokeWidth="3" strokeDasharray="5 9" opacity=".55" />
        {/* 一条功能流程：已实施只改变建筑，目标瓶仍只读共同验收。 */}
        {[0, 1, 2].map(i => <g key={i}>
          <Cube x={185 + i * 52} y={222 + i * 26 - (built ? 42 : 0)} size={34} height={built ? 68 : 26} color={run?.accepted ? '#7eaf87' : '#baac74'} pale={!built} />
          {built && <path d={`M${199 + i * 52} ${218 + i * 26} v14 l10 5 v-14Z`} fill="#e9d790" />}
        </g>)}
        {/* 基础设施积木支撑。 */}
        {[0, 1, 2].map(i => <Cube key={i} x={572 + i * 33} y={286 + i * 16} size={34} height={22} color="#6a9496" />)}
        {built && <><Cube x={603} y={248} size={34} height={52} color="#91b2ab" /><path d="M618 266v24m9-19v24" stroke="#304c4b" strokeWidth="5" /></>}
        {/* 灯塔指明方向；瓶内装的是有依据的目标覆盖。 */}
        <path d="M649 96L304 60L340 148Z" fill={`url(#${uid}-glow)`} />
        <Cube x={612} y={209} size={40} height={18} color="#799078" />
        <Cube x={635} y={96} size={17} height={112} color="#c3c3a3" />
        <Cube x={627} y={85} size={25} height={20} color="#668b78" />
        <path d="M641 83v18l12 6V90Z" fill="#f7df94" />
        <path d="M640 60l17-9l26 13l-18 9Z" fill="#88a982" />
        <Cube x={413} y={265} size={67} height={16} color="#5e8b76" />
        <path d="M453 117H507V151H523V256H437V151H453Z" fill="#b5e0c5" fillOpacity=".09" stroke="#a6cdb6" strokeWidth="4" />
        <g clipPath={`url(#${uid}-bottle)`}><rect x="438" y={252 - observation.fraction * 125} width="84" height={observation.fraction * 125} fill="#9dd5a9" fillOpacity=".8" />
          {[0, 1, 2, 3, 4].map(i => <path key={i} d={`M442 ${237 - i * 24}h76`} stroke="#dcf0bf" strokeOpacity=".25" strokeWidth="2" />)}</g>
        <path d="M448 113h64v10h-64Z" fill="#d3b780" />
        <path d="M446 165v73" stroke="#d9efdb" strokeOpacity=".55" strokeWidth="3" />
        <text x="480" y="197" textAnchor="middle" fill="#eff8df" fontSize="22" fontWeight="700">{observation.known ? `${observation.verified}/${observation.total}` : '· · ·'}</text>
        <text x="480" y="217" textAnchor="middle" fill="#c6ddca" fontSize="11">整体目标核实</text>
        {/* 成果架。 */}
        <Cube x={174} y={345} size={49} height={16} color="#b5966b" />
        <Cube x={190} y={303} size={18} height={42} color={built ? '#91bea2' : '#6a8673'} />
        <Cube x={218} y={320} size={18} height={36} color="#779d9d" />
        <path d="M190 311l18 9l18-9m-1 17l13 7l15-8" stroke="#d5e5bb" fill="none" strokeWidth="3" />
        {/* 三席保持独立，身体和颜色区分评审状态。 */}
        {Array.from({ length: reviewerCount }, (_, i) => {
          const x = 365 + i * 104;
          const review = run?.reviews[i];
          const color = review?.status === 'passed' ? '#99c3a0' : review?.status === 'changes_requested' ? '#d5b270' : '#87aaa7';
          return <g key={i}><Cube x={x - 13} y={418} size={33} height={12} color="#76907a" />
            <Cube x={x} y={374} size={19} height={39} color={color} />
            <Cube x={x - 1} y={350} size={20} height={24} color="#ddc9a4" />
            <path d={`M${x+8} 356v5m9-1v5`} stroke="#28413b" strokeWidth="3" />
            <path d={`M${x-3} 346l22-11l22 11l-22 11Z`} fill={['#71928a', '#b29c71', '#8e92af'][i]} />
          </g>;
        })}
        {[{ x: 111, y: 250 }, { x: 740, y: 287 }, { x: 310, y: 158 }].map(({ x, y }) => <g key={x}>
          <Cube x={x+9} y={y} size={6} height={30} color="#988469" /><Cube x={x} y={y-16} size={16} height={24} color="#6b9b69" />
        </g>)}
        <text x="29" y="38" fill="#adccb6" fontSize="12" letterSpacing="4">AIMEIN · BUILDING WORLD</text>
        <text x="29" y="61" fill="#779e88" fontSize="11">保留每一块有依据的成长</text>
      </svg>
      {items.map(item => <button key={item.name} title={item.name} aria-label={`观察${item.name}`} aria-pressed={active(item)} onClick={() => onSelect({ kind: item.kind, seq: current?.seq || 0, reviewId: item.reviewId })}
        style={{ position: 'absolute', left: `${item.x}%`, top: `${item.y}%`, transform: 'translate(-50%, -50%)', fontSize: compact ? 9 : 'clamp(9px, 1.1vw, 12px)', padding: compact ? '3px' : '6px 9px', minWidth: compact ? 18 : undefined, borderRadius: 4,
          background: active(item) ? '#c4dfab' : '#122c29e8', border: `1px solid ${active(item) ? '#e4f4d3' : '#719b80'}`, color: active(item) ? '#173529' : '#e0edd8', cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: '0 3px 0 #071c18aa' }}>{compact ? ({ goal: '瓶', flow: '工', infra: '基', artifact: '果', review: item.name.slice(-1) })[item.kind] : item.name}</button>)}
    </div></div>
    <div style={{ display: 'flex', flexWrap: contained ? 'nowrap' : 'wrap', overflowX: 'auto', whiteSpace: contained ? 'nowrap' : undefined, flexShrink: 0, gap: 6, alignItems: 'center', padding: contained ? '4px 8px' : '12px 16px', borderTop: '1px solid #36554a', fontSize: 11, lineHeight: 1.8 }}>
      <span style={{ color: '#b8c9ae', marginRight: 'auto' }}>点击场景中的标牌，查看成果与提出建议</span>
      <span>◇ 待核实</span><span style={{ color: '#d7c28c' }}>▣ 已实施</span><span style={{ color: '#a5d5ae' }}>▣ 评审核实</span>
    </div>
  </div>;
};
