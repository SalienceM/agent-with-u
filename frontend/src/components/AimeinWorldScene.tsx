import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';
import type { AimeinAnchor, AimeinReview } from '../types/aimein';
import { targetPosition, taskPage, targetRelations, type WorldLayout, type WorldPoint, type worldProjection, type FlowSnapshot } from '../utils/aimeinWorld';
import { AimeinFlowMotion } from './AimeinFlowMotion';
import type { AimeinPlayState } from '../utils/aimeinPlay';

interface Props {
  projection: ReturnType<typeof worldProjection>; layout: WorldLayout; built: boolean; motion: FlowSnapshot;
  selected: AimeinAnchor; reviews: AimeinReview[]; reviewerCount: number;
  focus: { anchor: AimeinAnchor | null; serial: number };
  active: boolean; reduced: boolean; lowQuality: boolean;
  onSelect: (anchor: AimeinAnchor) => void; onReady: () => void; onFailure: () => void;
  play?: AimeinPlayState;
  taskPage: number; targetId: string; hoverId: string;
  onTarget: (id: string) => void; onHover: (id: string) => void;
}

const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const palette = ['#34564f', '#365950', '#385b52', '#35584f'];
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

const Label: React.FC<{ text: string; at: WorldPoint; color?: string; width?: number; subtle?: boolean }> = ({ text, at, color = '#dbeddf', width = Math.max(1.45, Math.min(2.5, text.length * .3)), subtle = false }) => {
  const textureWidth = Math.max(96, Math.min(576, text.length * 36 + 24));
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = textureWidth; canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    if (!subtle) { ctx.fillStyle = '#102825b8'; ctx.beginPath(); ctx.roundRect(3, 3, textureWidth - 6, 90, 14); ctx.fill(); }
    ctx.fillStyle = color; ctx.font = '500 40px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 18), textureWidth / 2, 48, textureWidth - 28);
    const result = new THREE.CanvasTexture(canvas); result.colorSpace = THREE.SRGBColorSpace; return result;
  }, [text, color, subtle]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <sprite raycast={() => null} position={at} scale={[width, width * 96 / textureWidth, 1]}><spriteMaterial map={texture} transparent depthWrite={false} /></sprite>;
};

const Ring: React.FC<{ radius: number; color: string }> = ({ radius, color }) => <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .065, 0]}>
  <ringGeometry args={[radius, radius + .055, 40]} /><meshBasicMaterial color={color} transparent opacity={.8} side={THREE.DoubleSide} />
</mesh>;

const ObjectSite: React.FC<{ name: string; at: WorldPoint; selected: boolean; onClick: () => void; children: React.ReactNode; radius?: number; quiet?: boolean }> = ({ name, at, selected, onClick, children, radius = .8, quiet = false }) => {
  const [hover, setHover] = useState(false);
  const { gl } = useThree();
  const click = (e: ThreeEvent<MouseEvent>) => { if (e.delta > 6) return; e.stopPropagation(); onClick(); };
  return <group position={at} onClick={click} onPointerOver={e => { e.stopPropagation(); setHover(true); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { setHover(false); gl.domElement.style.cursor = 'grab'; }}>
    {children}
    {(selected || hover) && <Ring radius={radius} color={selected ? '#e8d79b' : '#8fdcc2'} />}
    {(!quiet || selected || hover) && <Label text={name} at={[0, .12, radius + .22]} color={selected ? '#f5e2ae' : '#c5dfce'} subtle={!selected && !hover} width={quiet ? .55 : undefined} />}
  </group>;
};

function Ground() {
  const tiles = useRef<THREE.InstancedMesh>(null!);
  useEffect(() => {
    const transform = new THREE.Object3D();
    for (let i = 0; i < 108; i++) {
      transform.position.set(i % 12 - 5.5, .01, Math.floor(i / 12) - 4);
      transform.scale.set(.99, .035, .99); transform.updateMatrix();
      tiles.current.setMatrixAt(i, transform.matrix); tiles.current.setColorAt(i, new THREE.Color(palette[(i * 7 + Math.floor(i / 12)) % palette.length]));
    }
    tiles.current.instanceMatrix.needsUpdate = true;
    if (tiles.current.instanceColor) tiles.current.instanceColor.needsUpdate = true;
  }, []);
  return <>
    <Box at={[0, -.48, 0]} size={[12.5, .9, 9.5]} color="#203e38" />
    <Box at={[0, -.08, 0]} size={[12.7, .16, 9.7]} color="#537768" />
    <Box at={[0, -.94, 0]} size={[11.7, .13, 8.8]} color="#193434" />
    <instancedMesh ref={tiles} args={[boxGeometry, material('#ffffff'), 108]} dispose={null} />
    <Box at={[.3, .06, 2.45]} size={[8.6, .05, .34]} color="#adac7b" />
    <Box at={[1.7, .06, .7]} size={[.34, .05, 3.8]} color="#adac7b" />
    <Box at={[-2.9, .055, -.45]} size={[5.25, .06, 4.45]} color="#294c46" />
    <Box at={[-2.9, .09, 1.87]} size={[4.65, .025, .045]} color="#648677" />
    <mesh position={[0, -1.1, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[9, 48]} /><meshBasicMaterial color="#08191f" transparent opacity={.18} /></mesh>
    {[[-5.7, -4], [5.5, 3.7], [5.6, -1]].map(([x, z], i) => <group key={i} position={[x, 0, z]}>
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
    const scale = Math.max(1, Math.min(size.width / 19, size.height / 11));
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
    motion.current.zoom = Math.min(size.width / 19, size.height / 11) * (key ? 1.24 : 1);
    if (orbit.current) { orbit.current.minZoom = Math.min(size.width / 19, size.height / 11) * .8; orbit.current.maxZoom = Math.min(size.width / 19, size.height / 11) * 1.9; }
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
  const page = taskPage(targets, props.taskPage);
  const positions = targets.map((_, i) => targetPosition(i, targets, layout));
  const focused = props.hoverId || props.targetId;
  const relations = targetRelations(targets, focused);
  const visible = new Set(page.targets.map(t => t.id));
  const related = new Set(relations.flatMap(r => [r.from, r.to]));
  const connections = useMemo(() => relations.filter(r => !r.missing && visible.has(r.from) && visible.has(r.to) && r.from !== r.to).map(r => {
    const from = new THREE.Vector3(...positions[targets.findIndex(t => t.id === r.from)]);
    const to = new THREE.Vector3(...positions[targets.findIndex(t => t.id === r.to)]);
    from.y += .14; to.y += .14;
    const middle = from.clone().lerp(to, .5); middle.y += .35;
    const curve = new THREE.QuadraticBezierCurve3(from, middle, to);
    const samples = curve.getPoints(24);
    const direction = curve.getTangent(.72).normalize();
    const tip = curve.getPoint(.72);
    const sideways = new THREE.Vector3(-direction.z, 0, direction.x).normalize().multiplyScalar(.065);
    const back = tip.clone().addScaledVector(direction, -.14);
    const points = samples.slice(1).flatMap((v, i) => [samples[i], v]);
    points.push(back.clone().add(sideways), tip, tip, back.clone().sub(sideways));
    return { ...r, geometry: new THREE.BufferGeometry().setFromPoints(points) };
  }), [projection.basis, layout, focused, page.page]);
  useEffect(() => () => connections.forEach(c => c.geometry.dispose()), [connections]);
  useEffect(() => {
    gl.domElement.dataset.heldTarget = props.targetId;
    gl.domElement.dataset.assembled = (play?.assembled || []).join(',');
    gl.domElement.dataset.taskIds = page.targets.map(t => t.id).join(',');
    gl.domElement.dataset.taskPositions = JSON.stringify(page.targets.map((t, i) => ({ id: t.id, at: positions[page.start + i] })));
    gl.domElement.dataset.taskEdges = String(connections.length);
    gl.domElement.dataset.reviewerCount = String(props.reviewerCount);
  }, [props.targetId, props.reviewerCount, play?.assembled.join(','), projection.basis, page.page, layout, connections.length, gl]);
  return <>
    <ambientLight intensity={1.4} color="#b6d2db" /><directionalLight position={[5, 12, 8]} intensity={2.4} color="#ffebc5" /><directionalLight position={[-7, 6, -4]} intensity={1.2} color="#8dc8c2" />
    <CameraRig {...props} />
    <Ground />
    <AimeinFlowMotion snapshot={props.motion} reviewerCount={props.reviewerCount} active={active} reduced={reduced} lowQuality={props.lowQuality} preferTargets={play?.tool === 'inspect' || play?.tool === 'assemble'} onSelect={onSelect} />
    {connections.map(c => <lineSegments key={`${c.from}:${c.to}`} geometry={c.geometry} raycast={() => null}><lineBasicMaterial color={c.to === focused ? '#dfc68c' : '#86bdb5'} transparent opacity={.8} /></lineSegments>)}
    <group>
      {page.targets.map((target, i) => {
        const selectedTask = focused === target.id;
        const assembly = play?.assembled.includes(target.id);
        const color = selectedTask ? '#dfce9d' : target.verified ? '#9ebf9d' : target.inSprint ? '#b6ac89' : '#6f9490';
        const index = page.start + i;
        return <Move key={`${projection.seq}:${target.id}`} to={positions[index]} active={active} reduced={reduced} arc={.12}>
          <group userData={{ aimeinTarget: true }} onClick={e => { if (e.delta > 6) return; e.stopPropagation(); props.onTarget(target.id); }}
            onPointerOver={e => { e.stopPropagation(); props.onHover(target.id); gl.domElement.style.cursor = 'pointer'; }}
            onPointerOut={() => { props.onHover(''); gl.domElement.style.cursor = 'grab'; }}>
            <Box at={[0, -.08, 0]} size={[.88, .12, .86]} color={selectedTask ? '#a69c76' : related.has(target.id) ? '#607e6b' : '#41655a'} />
            <Box at={[0, -.005, 0]} size={[.8, .045, .78]} color={selectedTask ? '#d5c59c' : '#527367'} />
            <Box at={[-.12, .13, -.1]} size={[.36, .24, .37]} color={color} />
            <Box at={[-.12, .27, -.1]} size={[.43, .055, .43]} color={target.verified ? '#c2d4ab' : target.inSprint ? '#dbcea4' : '#92b4ad'} />
            <Box at={[.21, .07, -.12]} size={[.12, .12, .26]} color={color} />
            <Box at={[0, .035, .29]} size={[.54, .025, .035]} color={assembly ? '#e4d3a2' : target.verified ? '#b4dab6' : '#34544d'} />
            <Label text={target.id.length > 7 ? `${index + 1}` : target.id} at={[0, .12, .42]} width={.66} subtle color={selectedTask ? '#fff1ca' : '#c7d9cb'} />
            {selectedTask && <Ring radius={.5} color="#e8d69e" />}
          </group>
        </Move>;
      })}
    </group>
    {play?.footprints.map((footprint, i) => <ObjectSite key={footprint.seq} name={`#${footprint.seq}`} quiet at={[-5.1 + i * .88, 0, 4.2]} radius={.27} selected={projection.seq === footprint.seq} onClick={() => play.onHistory(footprint.seq)}>
      <Box at={[0, .15, 0]} size={[.55, .2, .45]} color="#557565" />
      <Box at={[0, .3 + Math.min(footprint.saved ?? 0, 6) * .035, 0]} size={[.33, .13 + Math.min(footprint.saved ?? 0, 6) * .07, .3]} color={footprint.accepted ? '#b9d997' : footprint.saved ? '#c3ac79' : '#638d87'} />
    </ObjectSite>)}
    <ObjectSite name="功能工坊" at={[-3.5, 0, -3.45]} selected={selected.kind === 'flow'} radius={.9} onClick={() => choose('flow')}>
      <Box at={[0, .2, 0]} size={[2.4, .3, .85]} color="#7d9f7e" />
      {[0, 1, 2].map(i => <group key={i} position={[-.75 + i * .75, .3, 0]}><Box at={[0, props.built ? .52 : .2, 0]} size={[.62, props.built ? 1.04 : .4, .65]} color="#c1b47f" /><Box at={[0, props.built ? 1.08 : .45, 0]} size={[.72, .13, .75]} color="#e0d29c" /><Box at={[0, .4, .34]} size={[.24, .25, .03]} color="#f1dda4" /></group>)}
    </ObjectSite>
    <ObjectSite name="目标瓶" at={[1.5, 0, -1.35]} selected={selected.kind === 'goal'} radius={1.25} onClick={() => choose('goal')}>
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
    {Array.from({ length: props.reviewerCount }, (_, i) => {
      const review = reviews[i]; const id = review?.id || `review${i + 1}`;
      const color = review?.status === 'passed' ? '#a6d3a0' : review?.status === 'changes_requested' ? '#d7b172' : review?.status === 'error' ? '#cc8e80' : '#87aaa6';
      return <ObjectSite key={id} name={`评委 ${i + 1}`} at={[-1.5 + i * 2.15, 0, 3.5]} radius={.73} selected={selected.kind === 'review' && selected.reviewId === id} onClick={() => choose('review', id)}>
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
