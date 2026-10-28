import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { AimeinAnchor } from '../types/aimein';
import { flowTransitions, type FlowSnapshot, type FlowRouteId, type WorldPoint } from '../utils/aimeinWorld';

// 拿取/装配时优先方块；使用探针或评委工具时优先航线。
function hasTargetHit(hits: THREE.Intersection[]) {
  return hits.some(hit => {
    let object: THREE.Object3D | null = hit.object;
    while (object) { if (object.userData.aimeinTarget) return true; object = object.parent; }
    return false;
  });
}

interface Props {
  snapshot: FlowSnapshot; active: boolean; reduced: boolean; lowQuality: boolean;
  preferTargets?: boolean;
  onSelect: (anchor: AimeinAnchor) => void;
}
interface Route {
  id: FlowRouteId; color: string; kind: AimeinAnchor['kind']; review?: number; points: WorldPoint[];
}
// 路径只是对象间的工作流示意；没有步骤/目标映射时不制造目标级进度。
const routes: Route[] = [
  { id: 'build', color: '#6efde2', kind: 'flow', points: [[-2.4, .6, .9], [-4.1, .65, .4], [-4.85, .8, -1.5], [-3.5, 1.25, -3.45]] },
  { id: 'infra', color: '#8ebfff', kind: 'infra', points: [[-3.5, 1.25, -3.45], [-1.3, .7, -4.4], [3, .65, -3.8], [4.2, 1.3, .4]] },
  { id: 'store', color: '#ffdb8a', kind: 'artifact', points: [[-3.5, 1.25, -3.45], [-5.7, .8, -2.2], [-5.65, .7, 1.7], [-4.3, 1.15, 3.3]] },
  ...[0, 1, 2].map((i): Route => ({ id: `review${i}`, color: ['#7dffe3', '#ffda89', '#c5b2ff'][i], kind: 'review', review: i,
    points: [[-4.3, 1.15, 3.3], [-3.3, 1.7 + i * .3, 2.3 - i * .3], [-2 + i * 1.9, 2.1 + i * .3, 2.2], [-1.5 + i * 2.15, 1.65, 3.5]] })),
  ...[0, 1, 2].map((i): Route => ({ id: `verify${i}`, color: '#baff91', kind: 'goal',
    points: [[-1.5 + i * 2.15, 1.65, 3.5], [-1.8 + i * 1.9, 3, 2.1], [1.1 + i * .35, 4.4, -.4], [1.5, 3.35, -1.35]] })),
  { id: 'repair', color: '#ffb14e', kind: 'flow', points: [[.65, 1.65, 3.5], [-2, 3, 1.7], [-4.9, 3.4, -.4], [-3.5, 1.25, -3.45]] },
];
const PARTICLES = 64;
const CAPACITY = routes.length * PARTICLES;

export function AimeinFlowMotion({ snapshot, active, reduced, lowQuality, preferTargets = false, onSelect }: Props) {
  const { invalidate, gl } = useThree();
  const moving = active && !reduced;
  const previous = useRef<{ snapshot: FlowSnapshot; enabled: boolean }>();
  const pulseAges = useRef(new Map<FlowRouteId, number>());
  const pulseSerial = useRef(0);
  const clock = useRef(0);
  const blocks = useRef<THREE.InstancedMesh>(null);
  const halos = useRef<THREE.InstancedMesh>(null);
  const arrivals = useRef<THREE.InstancedMesh>(null);
  const currents = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const pile = useRef<THREE.InstancedMesh>(null);
  const savedBefore = useRef<{ identity: string; ids: number[] }>();
  const settling = useRef(new Map<number, number>());
  const scratch = useMemo(() => ({ object: new THREE.Object3D(), point: new THREE.Vector3(), tangent: new THREE.Vector3(),
    axis: new THREE.Vector3(0, 1, 0), color: new THREE.Color() }), []);
  const paths = useMemo(() => routes.map(route => {
    const curve = new THREE.CatmullRomCurve3(route.points.map(p => new THREE.Vector3(...p)), false, 'centripetal');
    return { ...route, colorValue: new THREE.Color(route.color), curve,
      rail: new THREE.TubeGeometry(curve, 64, .006, 4, false),
      energy: new THREE.TubeGeometry(curve, 64, .009, 5, false),
      hit: new THREE.TubeGeometry(curve, 64, .085, 4, false),
      samples: curve.getSpacedPoints(256) };
  }), []);
  useEffect(() => () => paths.forEach(p => { p.rail.dispose(); p.energy.dispose(); p.hit.dispose(); }), [paths]);
  useEffect(() => {
    const prior = previous.current;
    // 紧凑推送使详情短暂失效时保留同身份基线，等新详情到达再比较。
    // 隐藏、历史和身份切换仍立即取消，不能借此补播旧事件。
    if (!snapshot.ready && prior?.snapshot.identity === snapshot.identity && prior.enabled === moving && prior.snapshot.latest === snapshot.latest) {
      invalidate(); return;
    }
    const events = moving && prior?.enabled ? flowTransitions(prior.snapshot, snapshot) : [];
    if (!moving || !snapshot.latest || prior?.snapshot.identity !== snapshot.identity) pulseAges.current.clear();
    events.forEach((id, i) => pulseAges.current.set(id, -i * .1));
    if (events.length) {
      gl.domElement.dataset.flowPulseSerial = String(++pulseSerial.current);
      gl.domElement.dataset.flowLastEvent = events.join(',');
    }
    previous.current = { snapshot, enabled: moving };
    gl.domElement.dataset.flowStage = snapshot.status;
    gl.domElement.dataset.flowSaved = String(snapshot.saved.length);
    invalidate();
  }, [snapshot, moving, gl, invalidate]);
  useEffect(() => {
    const previousSaved = savedBefore.current;
    if (!moving || !snapshot.latest || previousSaved?.identity !== snapshot.identity) settling.current.clear();
    // 详情刷新不是新的落盘事件；动画集合也必须受 24 块展示上限约束。
    if (!snapshot.ready) {
      if (previousSaved?.identity !== snapshot.identity) savedBefore.current = undefined;
      invalidate(); return;
    }
    const visible = snapshot.saved.slice(0, 24);
    for (const id of settling.current.keys()) if (!visible.includes(id)) settling.current.delete(id);
    if (moving && snapshot.latest && previousSaved?.identity === snapshot.identity)
      visible.forEach(id => { if (!previousSaved.ids.includes(id)) settling.current.set(id, 0); });
    savedBefore.current = { identity: snapshot.identity, ids: snapshot.saved };
    invalidate();
  }, [snapshot, moving, invalidate]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, .06);
    if (moving) clock.current += delta;
    const { object, point, tangent, axis } = scratch;
    let count = 0, ringCount = 0;
    const traffic = moving ? snapshot.activity : [];
    const sample = (path: typeof paths[number], t: number) => {
      const index = Math.min(255, Math.max(0, t * 256));
      const n = Math.floor(index);
      point.lerpVectors(path.samples[n], path.samples[n + 1], index - n);
      tangent.subVectors(path.samples[n + 1], path.samples[n]).normalize();
    };
    paths.forEach((path, routeIndex) => {
      let age = pulseAges.current.get(path.id);
      if (age !== undefined) {
        age += delta; pulseAges.current.set(path.id, age);
        if (age > 2.5) { pulseAges.current.delete(path.id); age = undefined; }
      }
      const pulse = moving && age !== undefined && age >= 0;
      const running = traffic.includes(path.id);
      const energy = currents.current[routeIndex];
      if (energy) energy.opacity = pulse ? .24 * Math.max(0, 1 - age! / 2.5) : running ? .09 : 0;
      if (!running && !pulse) return;
      const limit = lowQuality ? PARTICLES / 2 : PARTICLES;
      for (let j = 0; j < limit; j++) {
        let t: number, size: number;
        if (pulse && j < limit / 2) {
          // 电流头在约一秒内贯穿，后面紧跟短促亮芯和锯齿状尾迹。
          t = age! / 1.05 - j * .007;
          if (t < 0 || t > 1) continue;
          size = j === 0 ? .12 : .045 * (1 - j / limit);
        } else {
          if (!running && age! > 1.8) continue;
          t = (j / limit + clock.current * (running ? .17 : .43) + routeIndex * .11) % 1;
          size = .032 + (j % 4) * .004;
        }
        sample(path, t);
        const lane = (j % 3 - 1) * .035;
        point.x += tangent.z * lane; point.z -= tangent.x * lane;
        point.y += .012 * Math.sin(t * 90 + j);
        object.position.copy(point); object.quaternion.setFromUnitVectors(axis, tangent);
        object.scale.set(size, size * (pulse ? 3.1 : 1.5), size); object.updateMatrix();
        blocks.current?.setMatrixAt(count, object.matrix); blocks.current?.setColorAt(count, path.colorValue);
        object.scale.multiplyScalar(pulse ? 2 : 1.8); object.updateMatrix();
        halos.current?.setMatrixAt(count, object.matrix); halos.current?.setColorAt(count, path.colorValue);
        count++;
      }
      if (pulse && age! > .85) {
        const expansion = (age! - .85) / 1.65;
        object.position.copy(path.samples[256]); object.rotation.set(-Math.PI / 2, 0, 0);
        object.scale.setScalar(.2 + expansion * 1.1); object.updateMatrix();
        arrivals.current?.setMatrixAt(ringCount, object.matrix);
        arrivals.current?.setColorAt(ringCount, scratch.color.copy(path.colorValue).multiplyScalar((1 - expansion) * 2)); ringCount++;
      }
    });
    [blocks.current, halos.current].forEach(mesh => {
      if (!mesh) return; mesh.count = count; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    if (arrivals.current) {
      arrivals.current.count = ringCount; arrivals.current.instanceMatrix.needsUpdate = true;
      if (arrivals.current.instanceColor) arrivals.current.instanceColor.needsUpdate = true;
    }
    // 保存块稳定存在；新增块从上方落入成果架，暂停/历史只显示最终保存值。
    const ids = snapshot.saved.slice(0, 24);
    ids.forEach((id, i) => {
      let t = settling.current.get(id) ?? 1;
      if (moving && t < 1) { t = Math.min(1, t + delta / 1.35); settling.current.set(id, t); }
      else { t = 1; settling.current.delete(id); }
      object.position.set(-4.88 + i % 4 * .36, .35 + Math.floor(i / 8) * .32 + (1 - t) ** 2 * 2.8, 2.15 + Math.floor(i % 8 / 4) * .34);
      object.rotation.set(0, (1 - t) * Math.PI, 0); object.scale.setScalar(.27); object.updateMatrix(); pile.current?.setMatrixAt(i, object.matrix);
    });
    if (pile.current) { pile.current.count = ids.length; pile.current.instanceMatrix.needsUpdate = true; }
    gl.domElement.dataset.flowParticles = String(count);
    gl.domElement.dataset.flowPulses = String(pulseAges.current.size);
    gl.domElement.dataset.flowCapacity = String(CAPACITY);
    gl.domElement.dataset.flowPile = String(ids.length);
    if (moving && (traffic.length || pulseAges.current.size || settling.current.size)) invalidate();
  });
  return <group>
    {paths.map((path, i) => <group key={path.id}>
      <mesh geometry={path.rail}><meshBasicMaterial color={path.color} transparent opacity={.16} depthWrite={false} /></mesh>
      <mesh geometry={path.energy}><meshBasicMaterial ref={material => { currents.current[i] = material; }} color={path.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} /></mesh>
      <mesh geometry={path.hit} raycast={path.id.startsWith('verify') && !snapshot.known || path.id === 'repair' && snapshot.status !== 'repair' ? () => null : THREE.Mesh.prototype.raycast}
        onPointerOver={e => { if (preferTargets && hasTargetHit(e.intersections)) return; e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = 'grab'; }}
        onClick={e => { if (e.delta > 6 || (preferTargets && hasTargetHit(e.intersections))) return; e.stopPropagation(); onSelect({ kind: path.kind, seq: snapshot.seq,
        reviewId: path.review === undefined ? undefined : snapshot.reviews[path.review]?.id || `review${path.review + 1}` }); }}>
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
    </group>)}
    <instancedMesh ref={blocks} args={[undefined, undefined, CAPACITY]} count={0} frustumCulled={false} raycast={() => null}>
      <boxGeometry /><meshBasicMaterial color="white" toneMapped={false} />
    </instancedMesh>
    <instancedMesh ref={halos} args={[undefined, undefined, CAPACITY]} count={0} frustumCulled={false} raycast={() => null}>
      <boxGeometry /><meshBasicMaterial color="white" transparent opacity={.075} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </instancedMesh>
    <instancedMesh ref={arrivals} args={[undefined, undefined, routes.length]} count={0} frustumCulled={false} raycast={() => null}>
      <torusGeometry args={[1, .012, 4, 48]} /><meshBasicMaterial color="white" transparent opacity={.45} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </instancedMesh>
    <instancedMesh ref={pile} args={[undefined, undefined, 24]} count={0} frustumCulled={false} onClick={e => { e.stopPropagation(); onSelect({ kind: 'artifact', seq: snapshot.seq }); }}>
      <boxGeometry /><meshStandardMaterial color="#e6d59a" emissive="#b9a456" emissiveIntensity={.24} roughness={.6} />
    </instancedMesh>
  </group>;
}
