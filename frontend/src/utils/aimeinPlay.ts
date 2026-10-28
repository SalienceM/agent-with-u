import type { AimeinRun } from '../types/aimein';
import type { WorldPoint, WorldTarget } from './aimeinWorld';

export type AimeinTool = 'inspect' | 'assemble' | 'probe' | 'reviewers';
export type BuildTarget = NonNullable<NonNullable<AimeinRun['plan']>['targets']>[number];
export interface WorldFootprint { seq: number; title: string; accepted: boolean; saved: number | null; }
export interface AimeinPlayState {
  tool: AimeinTool; targetId: string; assembled: string[]; roots: string[];
  onTool: (tool: AimeinTool) => void; onTarget: (id: string) => void;
  footprints: WorldFootprint[]; onHistory: (seq: number) => void;
  launch?: { label: string; disabled: boolean; reason: string; onClick: () => void };
}

/** 装配依赖必须完整，缺失或环不能被画成可用配方。 */
export function assemblyClosure(targets: Pick<BuildTarget, 'id' | 'dependsOn'>[], roots: string[]) {
  const byId = new Map(targets.map(t => [t.id, t]));
  const visiting = new Set<string>(); const done = new Set<string>();
  const ids: string[] = []; const errors = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) { errors.add(`依赖形成循环：${id}`); return; }
    const target = byId.get(id);
    if (!target) { errors.add(`缺少依赖详情：${id}`); return; }
    visiting.add(id);
    for (const dependency of target.dependsOn || []) visit(dependency);
    visiting.delete(id); done.add(id); ids.push(id);
  };
  roots.forEach(visit);
  return { ids, errors: [...errors] };
}

export function assemblyPosition(index: number): WorldPoint {
  return [-4.6 + index % 5 * .7, .85 + Math.floor(index / 20) * .65, -.7 + Math.floor(index % 20 / 5) * .7];
}

export function playablePosition(index: number, targets: WorldTarget[], assembled: string[], focused: string, fallback: WorldPoint): WorldPoint {
  const rank = assembled.indexOf(targets[index].id);
  const position = rank < 0 ? [...fallback] as WorldPoint : assemblyPosition(rank);
  if (targets[index].id === focused) position[1] += .55;
  return position;
}

export function assemblyIntent(seq: number, sprint: string, targets: BuildTarget[], roots: string[], ids: string[], note: string) {
  return [`【沙盘装配意图 · 来源尝试 #${seq} / ${sprint}】`,
    `下一次规划优先组合这些目标：${roots.join('、')}`,
    `包含传递依赖：${ids.filter(id => !roots.includes(id)).join('、') || '无'}`,
    ...targets.filter(t => roots.includes(t.id)).map(t => `${t.id} · ${t.title}\n验收：${t.acceptance}`),
    note.trim() ? `用户希望看到：${note.trim()}` : '',
    '请结合当前真实成果与依赖重新核对安排，保留原验收标准和真实阻塞；此意图不修改已冻结阶段，也不表示目标已完成。',
  ].filter(Boolean).join('\n');
}
