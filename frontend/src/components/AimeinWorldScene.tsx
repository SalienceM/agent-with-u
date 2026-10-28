import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';
import type { AimeinAnchor, AimeinReview } from '../types/aimein';
import { targetPosition, type WorldLayout, type WorldPoint, type worldProjection, type FlowSnapshot } from '../utils/aimeinWorld';
import { AimeinFlowMotion } from './AimeinFlowMotion';
import { assemblyClosure, playablePosition, type AimeinPlayState } from '../utils/aimeinPlay';

interface Props {
  projection: ReturnType<typeof worldProjection>; layout: WorldLayout; built: boolean; motion: FlowSnapshot;
  selected: AimeinAnchor; reviews: AimeinReview[];
  focus: { anchor: AimeinAnchor | null; serial: number };
  active: boolean; reduced: boolean; lowQuality: boolean;
  onSelect: (anchor: AimeinAnchor) => void; onReady: () => void; onFailure: () => void;
  play?: AimeinPlayState;
}

const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const palette = ['#325b50', '#376355', '#3e6a59', '#456f5c'];
const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(color: string) {
  if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: .82, metalness: .06 }));
  return materials.get(color)!;
}
const Box: React.FC<{ at?: WorldPoint; size?: WorldPoint; color?: string; rotation?: WorldPoint }> = ({ at = [0, 0, 0], size = [1, 1, 1], color = '#729a80', rotation }) =>
  <mesh geometry={boxGeometry} material={material(color)} position={at} scale={size} rotation={rotation} dispose={null} />;

/** 每帧只修改 Three 对象。状态稳定后停止请求帧，不走 React setState。 */
const Move: React.FC<{ to: WorldPoint; active: boolean; reduced: boolean; arc?: number; children: React.ReactNode }> = ({ to, active, reduced, arc = 0, children }) => {
  const group = useRef<THREE.Group>(null!);
  const initial = useRef(to);
  const { invalidate } = useThree();
  const motion = useRef({ from: new THREE.Vector3(...to), end: new THREE.Vector3(...to), t: 1 });
  useEffect(() => {
    const m = motion.current; m.from.copy(group.current.position); m.end.set(...to); m.t = active && !reduced ? 0 : 1;
    if (m.t === 1) group.current.position.copy(m.end);
    invalidate();
  }, [to[0], to[1], to[2], active, reduced, invalidate]);
  useFrame((_, delta) => {
    const m = motion.current;
    if (m.t >= 1 || !active) return;
    m.t = Math.min(1, m.t + Math.min(delta, .05) / .95);
    const t = m.t * m.t * (3 - 2 * m.t);
    group.current.position.lerpVectors(m.from, m.end, t);
    group.current.position.y += Math.sin(Math.PI * t) * arc;
    if (m.t < 1) invalidate();
  });
  return <group ref={group} position={initial.current}>{children}</group>;
};

const Label: React.FC<{ text: string; at: WorldPoint; color?: string; width?: number }> = ({ text, at, color = '#dbeddf', width = Math.max(1.3, Math.min(2.8, text.length * .29)) }) => {
  const textureWidth = Math.max(144, Math.min(576, text.length * 44 + 48));
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = textureWidth; canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#102c2be6'; ctx.beginPath(); ctx.roundRect(3, 3, textureWidth - 6, 90, 14); ctx.fill();
    ctx.strokeStyle = '#739b82'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = color; ctx.font = '500 40px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 18), textureWidth / 2, 48, textureWidth - 28);
    const result = new THREE.CanvasTexture(canvas); result.colorSpace = THREE.SRGBColorSpace; return result;
  }, [text, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <sprite raycast={() => null} position={at} scale={[width, width * 96 / textureWidth, 1]}><spriteMaterial map={texture} transparent depthTest={false} /></sprite>;
};

const Ring: React.FC<{ radius: number; color: string }> = ({ radius, color }) => <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .065, 0]}>
  <ringGeometry args={[radius, radius + .055, 40]} /><meshBasicMaterial color={color} transparent opacity={.8} side={THREE.DoubleSide} />
</mesh>;

const ObjectSite: React.FC<{ name: string; at: WorldPoint; selected: boolean; onClick: () => void; children: React.ReactNode; radius?: number }> = ({ name, at, selected, onClick, children, radius = .8 }) => {
  const [hover, setHover] = useState(false);
  const { gl } = useThree();
  const click = (e: ThreeEvent<MouseEvent>) => { if (e.delta > 6) return; e.stopPropagation(); onClick(); };
  return <group position={at} onClick={click} onPointerOver={e => { e.stopPropagation(); setHover(true); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { setHover(false); gl.domElement.style.cursor = 'grab'; }}>
    {children}
    {(selected || hover) && <Ring radius={radius} color={selected ? '#e8d79b' : '#8fdcc2'} />}
    <Label text={name} at={[0, -.04, radius + .32]} color={selected ? '#f5e2ae' : '#c5dfce'} />
  </group>;
};

function Ground() {
  const tiles = useRef<THREE.InstancedMesh>(null!);
  useEffect(() => {
    const transform = new THREE.Object3D();
    for (let i = 0; i < 108; i++) {
      transform.position.set(i % 12 - 5.5, .01, Math.floor(i / 12) - 4);
      transform.scale.set(.96, .045, .96); transform.updateMatrix();
      tiles.current.setMatrixAt(i, transform.matrix); tiles.current.setColorAt(i, new THREE.Color(palette[(i * 7 + Math.floor(i / 12)) % palette.length]));
    }
    tiles.current.instanceMatrix.needsUpdate = true;
    if (tiles.current.instanceColor) tiles.current.instanceColor.needsUpdate = true;
  }, []);
  return <>
    <Box at={[0, -.48, 0]} size={[12.5, .9, 9.5]} color="#203e38" />
    <Box at={[0, -.08, 0]} size={[12.7, .16, 9.7]} color="#6b9270" />
    <Box at={[0, -.94, 0]} size={[11.7, .13, 8.8]} color="#193434" />
    <instancedMesh ref={tiles} args={[boxGeometry, material('#ffffff'), 108]} dispose={null} />
    <Box at={[.3, .06, 2.45]} size={[8.6, .05, .34]} color="#adac7b" />
    <Box at={[1.7, .06, .7]} size={[.34, .05, 3.8]} color="#adac7b" />
    <Box at={[-2.6, .08, -.8]} size={[5.8, .12, 4.8]} color="#264e48" />
    <mesh position={[0, -1.1, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[9, 48]} /><meshBasicMaterial color="#08191f" transparent opacity={.18} /></mesh>
    {[[-5.5, -3.7], [-5.6, 2.8], [5.5, 3.7], [5.6, -.9], [.1, -4]].map(([x, z], i) => <group key={i} position={[x, 0, z]}>
      <Box at={[0, .44, 0]} size={[.15, .8, .15]} color="#af9867" />
      <Box at={[0, 1.0, 0]} size={[.65, .65, .65]} color={i % 2 ? '#9fba79' : '#78a17a'} />
      <Box at={[0, 1.4, 0]} size={[.4, .4, .4]} color="#a3bd82" />
    </group>)}
  </>;
}

function Vessel({ fraction, active, reduced }: { fraction: number; active: boolean; reduced: boolean }) {
  const liquid = useRef<THREE.Mesh>(null!);
  const value = useRef(fraction);
  const { invalidate, gl } = useThree();
  useEffect(() => { if (!active || reduced) value.current = fraction; invalidate(); }, [fraction, active, reduced, invalidate]);
  useFrame((_, delta) => {
    value.current = reduced || !active ? fraction : THREE.MathUtils.damp(value.current, fraction, 4.5, Math.min(delta, .05));
    if (Math.abs(value.current - fraction) < .001) value.current = fraction;
    const height = Math.max(.001, value.current * 2.6);
    liquid.current.scale.y = height; liquid.current.position.y = .43 + height / 2; liquid.current.visible = value.current > .001;
    gl.domElement.dataset.vesselFill = value.current.toFixed(3);
    if (value.current !== fraction && active) invalidate();
  });
  return <>
    <mesh position={[0, .18, 0]}><cylinderGeometry args={[1.12, 1.23, .3, 8]} /><meshStandardMaterial color="#b6b981" roughness={.7} /></mesh>
    <mesh ref={liquid} position={[0, .43 + fraction * 1.3, 0]} scale={[1, Math.max(.001, fraction * 2.6), 1]}>
      <cylinderGeometry args={[.82, .82, 1, 8]} /><meshStandardMaterial color="#8fdfb0" emissive="#286846" emissiveIntensity={.35} roughness={.4} metalness={.15} />
    </mesh>
    <mesh position={[0, 1.77, 0]}><cylinderGeometry args={[.92, .92, 2.8, 8, 1, true]} /><meshStandardMaterial color="#b5f4dc" transparent opacity={.16} depthWrite={false} side={THREE.DoubleSide} roughness={.3} /></mesh>
    {[.4, 1.07, 1.74, 2.41, 3.12].map(y => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[.925, .018, 4, 8]} /><meshStandardMaterial color="#b8e3ca" transparent opacity={.65} /></mesh>)}
    <mesh position={[0, 3.29, 0]}><cylinderGeometry args={[.42, .92, .34, 8, 1, true]} /><meshStandardMaterial color="#b5f4dc" transparent opacity={.3} depthWrite={false} /></mesh>
    <mesh position={[0, 3.6, 0]}><cylinderGeometry args={[.42, .42, .32, 8]} /><meshStandardMaterial color="#b5f4dc" transparent opacity={.23} depthWrite={false} /></mesh>
    <mesh position={[0, 3.83, 0]}><cylinderGeometry args={[.51, .51, .18, 8]} /><meshStandardMaterial color="#d1b77c" metalness={.3} roughness={.6} /></mesh>
    <Box at={[-.55, 1.8, .7]} size={[.035, 2.2, .035]} color="#d9f3df" />
  </>;
}

function CameraRig({ focus, active, reduced, reviews, onReady, onFailure }: Pick<Props, 'focus' | 'active' | 'reduced' | 'reviews' | 'onReady' | 'onFailure'>) {
  const { camera, gl, size, invalidate } = useThree();
  const orbit = useRef<OrbitControls>();
  const motion = useRef({ t: 1, target: new THREE.Vector3(0, .5, 0), position: new THREE.Vector3(12, 11, 15), zoom: 1 });
  const callbacks = useRef({ onReady, onFailure }); callbacks.current = { onReady, onFailure };
  const stopped = useRef(false);
  const viewScale = useRef(0);
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement); orbit.current = controls;
    controls.enablePan = false; controls.enableDamping = false; controls.enableZoom = true;
    controls.minPolarAngle = .55; controls.maxPolarAngle = 1.25;
    controls.minAzimuthAngle = -.25; controls.maxAzimuthAngle = 1.3;
    controls.target.set(0, .5, 0); controls.update();
    const change = () => { gl.domElement.dataset.cameraPose = [...camera.position.toArray(), ...controls.target.toArray()].map(n => n.toFixed(3)).join(','); gl.domElement.dataset.cameraZoom = String(camera.zoom); invalidate(); }; const start = () => { stopped.current = true; };
    change();
    controls.addEventListener('change', change); controls.addEventListener('start', start);
    const lost = (event: Event) => { event.preventDefault(); callbacks.current.onFailure(); };
    gl.domElement.addEventListener('webglcontextlost', lost);
    gl.domElement.style.cursor = 'grab';
    callbacks.current.onReady();
    return () => { controls.removeEventListener('change', change); controls.removeEventListener('start', start); controls.dispose(); orbit.current = undefined; gl.domElement.removeEventListener('webglcontextlost', lost); };
  }, [camera, gl, invalidate]);
  useEffect(() => {
    const scale = Math.max(1, Math.min(size.width / 19, size.height / 12));
    // 面板开合只调整取景比例，保留用户环视的位置和焦点。
    if (viewScale.current) { camera.zoom *= scale / viewScale.current; motion.current.zoom *= scale / viewScale.current; }
    viewScale.current = scale;
    if (orbit.current) { orbit.current.minZoom = scale * .8; orbit.current.maxZoom = scale * 1.9; }
    camera.updateProjectionMatrix(); gl.domElement.dataset.cameraZoom = String(camera.zoom); invalidate();
  }, [size.width, size.height, camera, invalidate]);
  useEffect(() => {
    const positions: Record<string, WorldPoint> = { goal: [1.5, 1.3, -1.35], flow: [-3, .6, -.5], infra: [4.3, .65, .2], artifact: [-4.3, .4, 3.3], review1: [-1.5, .65, 3.5], review2: [.65, .65, 3.5], review3: [2.8, .65, 3.5] };
    const key = focus.anchor?.kind === 'review' ? `review${Math.max(0, reviews.findIndex(r => r.id === focus.anchor?.reviewId)) + 1}` : focus.anchor?.kind;
    motion.current.target.set(...(key ? positions[key] || positions.review1 : [0, .5, 0] as WorldPoint));
    motion.current.position.set(12, 10.5, 15).add(motion.current.target);
    motion.current.zoom = Math.min(size.width / 19, size.height / 12) * (key ? 1.24 : 1);
    if (orbit.current) { orbit.current.minZoom = Math.min(size.width / 19, size.height / 12) * .8; orbit.current.maxZoom = Math.min(size.width / 19, size.height / 12) * 1.9; }
    motion.current.t = 0; stopped.current = false; invalidate();
  }, [focus.serial, invalidate]);
  useFrame((_, delta) => {
    const controls = orbit.current;
    if (!controls || stopped.current || motion.current.t >= 1) return;
    const m = motion.current;
    const blend = reduced || !active ? 1 : 1 - Math.exp(-5 * Math.min(delta, .05));
    controls.target.lerp(m.target, blend);
    camera.position.lerp(m.position, blend);
    camera.zoom = THREE.MathUtils.lerp(camera.zoom, m.zoom, blend);
    if (controls.target.distanceTo(m.target) < .006 && camera.position.distanceTo(m.position) < .006 && Math.abs(camera.zoom - m.zoom) < .02) m.t = 1;
    camera.updateProjectionMatrix(); controls.update(); gl.domElement.dataset.cameraZoom = String(camera.zoom);
    if (m.t < 1 && active) invalidate();
  });
  return null;
}

function World(props: Props) {
  const { projection, layout, active, reduced, selected, reviews, onSelect } = props;
  const { gl } = useThree();
  const frame = useRef(0);
  useFrame(() => { gl.domElement.dataset.renderedFrames = String(++frame.current); gl.domElement.dataset.drawCalls = String(gl.info.render.calls); });
  const choose = (kind: AimeinAnchor['kind'], reviewId?: string) => onSelect({ kind, reviewId, seq: projection.seq });
  const targets = projection.targets;
  const { play } = props;
  const positions = targets.map((_, i) => playablePosition(i, targets, play?.assembled || [], play?.targetId || '', targetPosition(i, targets, layout)));
  const highlighted = assemblyClosure(targets, play?.targetId ? [play.targetId] : []).ids;
  const lineGeometry = useMemo(() => {
    const points: THREE.Vector3[] = [];
    targets.forEach((t, i) => t.dependsOn.forEach(id => {
      const j = targets.findIndex(v => v.id === id);
      if (j >= 0) points.push(new THREE.Vector3(...positions[i]), new THREE.Vector3(...positions[j]));
    }));
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [projection.basis, layout, play?.targetId, play?.assembled.join(',')]);
  useEffect(() => () => lineGeometry.dispose(), [lineGeometry]);
  const highlightedGeometry = useMemo(() => {
    const points: THREE.Vector3[] = [];
    targets.forEach((t, i) => { if (highlighted.includes(t.id)) t.dependsOn.forEach(id => {
      const j = targets.findIndex(v => v.id === id); if (j < 0) return;
      const from = new THREE.Vector3(...positions[i]); const to = new THREE.Vector3(...positions[j]);
      const middle = from.clone().lerp(to, .5); middle.y += .65;
      const samples = new THREE.QuadraticBezierCurve3(from, middle, to).getPoints(18);
      samples.slice(1).forEach((p, n) => points.push(samples[n], p));
    }); });
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [projection.basis, layout, play?.targetId, play?.assembled.join(',')]);
  useEffect(() => () => highlightedGeometry.dispose(), [highlightedGeometry]);
  useEffect(() => { gl.domElement.dataset.heldTarget = play?.targetId || ''; gl.domElement.dataset.assembled = (play?.assembled || []).join(','); }, [play?.targetId, play?.assembled.join(','), gl]);
  return <>
    <ambientLight intensity={1.4} color="#b6d2db" /><directionalLight position={[5, 12, 8]} intensity={2.4} color="#ffebc5" /><directionalLight position={[-7, 6, -4]} intensity={1.2} color="#8dc8c2" />
    <CameraRig {...props} />
    <Ground />
    <AimeinFlowMotion snapshot={props.motion} active={active} reduced={reduced} lowQuality={props.lowQuality} preferTargets={play?.tool === 'inspect' || play?.tool === 'assemble'} onSelect={onSelect} />
    <lineSegments geometry={lineGeometry}><lineBasicMaterial color="#add4bd" transparent opacity={.28} /></lineSegments>
    <lineSegments geometry={highlightedGeometry}><lineBasicMaterial color="#ecda94" transparent opacity={.9} /></lineSegments>
    {play?.tool === 'assemble' && <group><Box at={[-3.2, .15, .35]} size={[3.75, .16, 3.1]} color="#4b6957" /><Label text="装配台 · 下次建设意图" at={[-3.2, .35, 2.1]} width={3} /></group>}
    <group>
      {targets.map((target, i) => <Move key={`${projection.seq}:${target.id}`} to={positions[i]} active={active} reduced={reduced} arc={.8}>
        <group userData={{ aimeinTarget: true }} onClick={e => { if (e.delta > 6) return; e.stopPropagation(); if (play) play.onTarget(target.id); else choose('flow'); }} onPointerOver={e => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = 'grab'; }}>
        <Box size={[.56, .53, .56]} color={play?.targetId === target.id ? '#e1ce8c' : play?.assembled.includes(target.id) ? '#96bfa8' : target.verified ? '#a3d7a8' : target.inSprint ? '#cbb785' : '#709e9a'} />
        <Box at={[0, .29, 0]} size={[.46, .055, .46]} color={target.verified ? '#d1e9ad' : '#e2d4a6'} />
        <Box at={[.07, -.05, .29]} size={[.18, .18, .015]} color="#325c50" />
        {(layout === 'split' || !target.inSprint || play?.targetId === target.id) && <Label text={play?.targetId === target.id ? `${target.id} · ${target.title}` : target.id} at={[0, .63, 0]} width={play?.targetId === target.id ? 2.7 : .72} />}
        {play?.targetId === target.id && <Ring radius={.43} color="#f5dfa2" />}
        </group>
      </Move>)}
      {layout === 'cluster' && projection.scoped && <Label text={`本阶段 · ${targets.filter(t => t.inSprint).length} 个子目标`} at={[-3, 2.15, .1]} width={2.7} />}
    </group>
    {play?.footprints.map((footprint, i) => <ObjectSite key={footprint.seq} name={`#${footprint.seq}`} at={[-5.1 + i * .88, 0, 4.2]} radius={.27} selected={projection.seq === footprint.seq} onClick={() => play.onHistory(footprint.seq)}>
      <Box at={[0, .15, 0]} size={[.55, .2, .45]} color="#557565" />
      <Box at={[0, .3 + Math.min(footprint.saved ?? 0, 6) * .035, 0]} size={[.33, .13 + Math.min(footprint.saved ?? 0, 6) * .07, .3]} color={footprint.accepted ? '#b9d997' : footprint.saved ? '#c3ac79' : '#638d87'} />
    </ObjectSite>)}
    <ObjectSite name="功能工坊" at={[-3.5, 0, -3.45]} selected={selected.kind === 'flow'} radius={.9} onClick={() => choose('flow')}>
      <Box at={[0, .2, 0]} size={[2.4, .3, .85]} color="#7d9f7e" />
      {[0, 1, 2].map(i => <group key={i} position={[-.75 + i * .75, .3, 0]}><Box at={[0, props.built ? .52 : .2, 0]} size={[.62, props.built ? 1.04 : .4, .65]} color="#c1b47f" /><Box at={[0, props.built ? 1.08 : .45, 0]} size={[.72, .13, .75]} color="#e0d29c" /><Box at={[0, .4, .34]} size={[.24, .25, .03]} color="#f1dda4" /></group>)}
    </ObjectSite>
    <ObjectSite name="目标瓶 / 共同核实" at={[1.5, 0, -1.35]} selected={selected.kind === 'goal'} radius={1.25} onClick={() => choose('goal')}>
      <Vessel fraction={projection.observation.fraction} active={active} reduced={reduced} />
      <Label text={projection.observation.known ? `${projection.observation.verified} / ${projection.observation.total}` : '待核实'} at={[0, 2.05, 0]} width={1.5} />
    </ObjectSite>
    <ObjectSite name="基础设施" at={[4.2, 0, .4]} selected={selected.kind === 'infra'} radius={1} onClick={() => choose('infra')}>
      <Box at={[0, .14, 0]} size={[2, .22, 1.45]} color="#6c8e88" />
      {[-.5, .2].map((x, i) => <group key={i}><Box at={[x, .7, 0]} size={[.54, 1.1, .8]} color="#789ea1" />{[.4, .7, 1].map(y => <Box key={y} at={[x, y, .42]} size={[.35, .06, .04]} color="#b3e5bf" />)}</group>)}
    </ObjectSite>
    <ObjectSite name="成果架" at={[-4.3, 0, 3.3]} selected={selected.kind === 'artifact'} onClick={() => choose('artifact')}>
      <Box at={[0, .2, 0]} size={[1.65, .25, .9]} color="#b59b70" />
      {[0, 1, 2].map(i => <Box key={i} at={[-.48 + i * .47, .65, 0]} size={[.32, .65 + i * .12, .48]} color={['#a3bf91', '#7aa4a1', '#c4b585'][i]} />)}
    </ObjectSite>
    {[0, 1, 2].map(i => {
      const review = reviews[i]; const id = review?.id || `review${i + 1}`;
      const color = review?.status === 'passed' ? '#a6d3a0' : review?.status === 'changes_requested' ? '#d7b172' : review?.status === 'error' ? '#cc8e80' : '#87aaa6';
      return <ObjectSite key={id} name={review?.profileName || `评委 ${i + 1}`} at={[-1.5 + i * 2.15, 0, 3.5]} radius={.73} selected={selected.kind === 'review' && selected.reviewId === id} onClick={() => choose('review', id)}>
        <Box at={[0, .1, 0]} size={[1.15, .18, .9]} color="#6c9279" />
        <Move to={[0, selected.kind === 'review' && selected.reviewId === id ? .16 : 0, 0]} active={active} reduced={reduced}>
          <Box at={[0, .66, 0]} size={[.55, .62, .37]} color={color} />
          <Box at={[0, 1.22, 0]} size={[.5, .48, .45]} color="#e0cca0" />
          <Box at={[0, 1.5, 0]} size={[.65, .12, .6]} color={['#78a39c', '#bba479', '#9895b5'][i]} />
          {[-.12, .12].map(x => <Box key={x} at={[x, 1.23, .235]} size={[.065, .075, .025]} color="#24463d" />)}
          <Box at={[.36, .65, .17]} size={[.18, .35, .16]} color="#e0cca0" />
          <Box at={[-.36, .65, .17]} size={[.18, .35, .16]} color="#e0cca0" />
          <Box at={[0, .69, .36]} size={[.65, .1, .42]} rotation={[-.3, 0, 0]} color="#e2dcb4" />
        </Move>
      </ObjectSite>;
    })}
    <group position={[4.4, 0, -3.3]} onClick={e => { e.stopPropagation(); choose('goal'); }}>
      <Box at={[0, .2, 0]} size={[1.15, .35, 1.15]} color="#85977c" />
      <Box at={[0, 1.55, 0]} size={[.52, 2.4, .52]} color="#c6c8ab" />
      <Box at={[0, 2.85, 0]} size={[.78, .15, .78]} color="#718c79" />
      <Box at={[0, 3.12, 0]} size={[.5, .42, .5]} color="#f5d998" />
      <Box at={[0, 3.4, 0]} size={[.85, .18, .85]} color="#8eaa83" />
      <mesh raycast={() => null} position={[-1.8, 3.1, 0]} rotation={[0, 0, -Math.PI / 2]}><coneGeometry args={[.95, 3.2, 4, 1, true]} /><meshBasicMaterial color="#e6df9d" transparent opacity={.045} depthWrite={false} side={THREE.DoubleSide} /></mesh>
    </group>
  </>;
}

export default function AimeinWorldScene(props: Props) {
  return <Canvas orthographic camera={{ position: [12, 11, 15], zoom: 38, near: .1, far: 80 }}
    frameloop={props.active ? 'demand' : 'never'} dpr={props.lowQuality ? 1 : [1, 1.5]}
    gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }} style={{ touchAction: 'pan-y' }}
    fallback={<span>当前浏览器不支持画布，请切换静态视图。</span>}>
    <World {...props} />
  </Canvas>;
}
