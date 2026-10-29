import React, { useState } from 'react';
import { taskPage, targetRelations, TASK_PAGE_SIZE, type WorldTarget } from '../utils/aimeinWorld';

const action: React.CSSProperties = { border: '1px solid #3a5c52', borderRadius: 5, background: '#17322e', color: '#cbdaca', fontSize: 11, padding: '4px 7px', cursor: 'pointer' };

/** 3D、静态视图共享同一定位入口；翻页和查看关系只改变观察状态。 */
export const AimeinTaskMap: React.FC<{
  targets: WorldTarget[]; page: number; selected: string; hover: string; compact: boolean; staticView: boolean;
  quiet?: boolean;
  onPage: (page: number) => void; onTarget: (id: string) => void;
}> = ({ targets, page: requested, selected, hover, compact, staticView, quiet, onPage, onTarget }) => {
  const [open, setOpen] = useState(false);
  const page = taskPage(targets, requested);
  const target = targets.find(t => t.id === selected);
  const preview = targets.find(t => t.id === hover) || target;
  const relations = targetRelations(targets, selected);
  const expanded = !quiet || open || !!selected;
  if (!targets.length) return null;
  return <section aria-label="任务地图" data-testid="aimein-task-map" data-page={page.page} style={{ flexShrink: 0, borderTop: '1px solid #2f5148', background: '#102a27', padding: compact ? '4px 7px' : '7px 12px', minWidth: 0 }}>
    {quiet && <button style={{ ...action, border: 0, padding: 0, color: '#8fa99d', background: 'transparent' }} aria-expanded={expanded} onClick={() => setOpen(v => !v)}>目标地块 {targets.length} · {page.page + 1}/{page.pages} 片 · {expanded ? '定位与关联' : '展开观察'} ›</button>}
    <div style={{ display: expanded ? 'block' : 'none' }}>
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', minWidth: 0 }}>
      <span style={{ color: '#9ab4a5', fontSize: 10, whiteSpace: 'nowrap' }}>{page.start + 1}–{page.start + page.targets.length} / {targets.length}</span>
      <select aria-label="定位子目标" value={selected} onChange={e => onTarget(e.target.value)} style={{ ...action, minWidth: 0, flex: 1, width: 0, textOverflow: 'ellipsis' }}>
        <option value="">选择地块 · 查看目标与关联</option>
        {targets.map((t, i) => <option key={t.id} value={t.id}>{t.id} · {t.title}{page.pages > 1 ? ` · 第 ${Math.floor(i / TASK_PAGE_SIZE) + 1} 片` : ''}</option>)}
      </select>
      {page.pages > 1 && <>
        <button aria-label="上一片任务" disabled={!page.page} style={{ ...action, opacity: page.page ? 1 : .4 }} onClick={() => onPage(page.page - 1)}>‹</button>
        <span style={{ fontSize: 10, color: '#a9bcab', whiteSpace: 'nowrap' }}>{page.page + 1}/{page.pages}</span>
        <button aria-label="下一片任务" disabled={page.page === page.pages - 1} style={{ ...action, opacity: page.page < page.pages - 1 ? 1 : .4 }} onClick={() => onPage(page.page + 1)}>›</button>
      </>}
    </div>
    {staticView && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 4, marginTop: 5, maxHeight: 72, overflowY: 'auto' }}>
      {page.targets.map(t => <button key={t.id} title={t.title} aria-label={`地块 ${t.id}：${t.title}`} aria-pressed={selected === t.id} onClick={() => onTarget(t.id)} style={{ ...action, borderColor: selected === t.id ? '#d8c99b' : '#3a5c52', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.verified ? '✓' : t.inSprint ? '◆' : '◇'} {t.id}</button>)}
    </div>}
    {target ? <details key={target.id} style={{ fontSize: 11, color: '#a8bcad', marginTop: 5 }}>
      <summary title={`${target.id} · ${target.title}`} style={{ cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{target.id} · {target.title} · {relations.length} 条关联</summary>
      <div style={{ maxHeight: compact ? 76 : 105, overflowY: 'auto', overflowWrap: 'anywhere', paddingTop: 5, lineHeight: 1.7 }}>
        <div>{target.title} · {target.inSprint ? '本阶段' : '后续目标'} · {target.verified ? '已共同核实' : '待核实'}</div>
        {!page.targets.some(t => t.id === selected) && <button style={action} onClick={() => onTarget(selected)}>定位选中地块</button>}
        {relations.length ? relations.map(r => {
          const id = r.to === selected ? r.from : r.to;
          const index = targets.findIndex(t => t.id === id);
          const label = `${r.to === selected ? '前置' : '后继'} ${id}`;
          return <div key={`${r.from}:${r.to}`} style={{ marginTop: 3 }}>{index < 0 ? <span style={{ color: '#e4ba90' }}>{label} · 缺少详情</span> : <button style={action} title={targets[index].title} onClick={() => onTarget(id)}>{label} · {Math.floor(index / TASK_PAGE_SIZE) === page.page ? '本片' : `第 ${Math.floor(index / TASK_PAGE_SIZE) + 1} 片`} ↗</button>}</div>;
        }) : <span>没有已声明的直接关联</span>}
      </div>
    </details> : <div style={{ fontSize: 10, color: '#8da89b', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {preview ? `${preview.id} · ${preview.title}` : '砂金 · 本阶段　青石 · 后续　浅绿 · 已核实'}
    </div>}
    </div>
  </section>;
};
