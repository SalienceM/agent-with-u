import React, { useEffect, useState } from 'react';
import { api } from '../api';

/** Loop 策略与心智（与后端 LoopPolicy 对齐，camelCase）。 */
export interface LoopPolicy {
  deliverableScore: number;
  outputtableScore: number;
  maxLoops: number;
  riskThreshold: number;
  independentEval: boolean;
  strategy: string;
}

export const DEFAULT_STRATEGY =
  `每一次 loop 都是对【全局目标】的一次完整、尽力的尝试（不是把任务拆到多个 loop 分步完成）。
- prepare：规划这一遍的策略与分步编排（可并发 concurrent / 顺次 sequential）。
- execute：实际执行编排（读写文件、运行命令），如实记录产出与成败。
- analysis：对照全局目标打分（0–100），评估趋势、优化空间与硬约束。

评分心智（防自欺，必须遵守）：
1. 以可验证的实际产物为准——文件是否真存在、代码是否真能跑、命令/测试输出是否真通过；不要轻信执行阶段的自述总结，能验证就动手验证。
2. 默认未完成：除非有明确证据满足验收标准，否则不给高分；模糊、未验证、想当然一律压低。
3. 警惕「美好陷阱」：流程跑顺 ≠ 目标达成；高分（≥可输出门槛）必须对应验收标准逐条被证据支撑。
4. 趋势判断要看实质改进（新增能力/缺陷修复/通过的检查），而非措辞更乐观。
5. 宁可保守扣分、点明差距与下一步，也不要为了收口而粉饰；真完不成就如实在 challenges 标注。`;

export const DEFAULT_POLICY: LoopPolicy = {
  deliverableScore: 70,
  outputtableScore: 85,
  maxLoops: 8,
  riskThreshold: 0.85,
  independentEval: true,
  strategy: DEFAULT_STRATEGY,
};

/** 兜底归一：补默认 + 夹取范围（可输出门槛不低于可交付门槛）。 */
export function normalizePolicy(p?: Partial<LoopPolicy> | null): LoopPolicy {
  const d = { ...DEFAULT_POLICY, ...(p || {}) };
  const del = clamp(num(d.deliverableScore, 70), 0, 100);
  const out = clamp(num(d.outputtableScore, 85), del, 100);
  const ml = Math.round(clamp(num(d.maxLoops, 8), 1, 50));
  const rt = clamp(num(d.riskThreshold, 0.85), 0.1, 1);
  const ie = d.independentEval !== false;
  const strat = (typeof d.strategy === 'string' && d.strategy.trim()) ? d.strategy : DEFAULT_STRATEGY;
  return { deliverableScore: del, outputtableScore: out, maxLoops: ml, riskThreshold: rt, independentEval: ie, strategy: strat };
}

function num(v: any, fb: number): number { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

export const LoopPolicyEditor: React.FC<{
  value: LoopPolicy;
  onChange: (p: LoopPolicy) => void;
}> = ({ value, onChange }) => {
  const set = (patch: Partial<LoopPolicy>) => onChange({ ...value, ...patch });
  const [presets, setPresets] = useState<any[]>([]);
  const [sel, setSel] = useState('');
  const reload = () => api.loopPolicyPresetList().then((r) => setPresets(r.presets || [])).catch(() => {});
  useEffect(() => { reload(); }, []);

  const applyPreset = (id: string) => {
    setSel(id);
    const p = presets.find((x) => x.id === id);
    if (p?.policy) onChange(normalizePolicy(p.policy));
  };
  const saveAsPreset = async () => {
    const name = window.prompt('预设名称：', '我的策略');
    if (!name || !name.trim()) return;
    const r = await api.loopPolicyPresetSave(name.trim(), normalizePolicy(value));
    if (r.status === 'ok') { await reload(); if (r.preset?.id) setSel(r.preset.id); }
    else if (r.message) alert(r.message);
  };
  const delPreset = async () => {
    const p = presets.find((x) => x.id === sel);
    if (!p || p.builtin) return;
    if (!window.confirm(`删除预设「${p.name}」？`)) return;
    const r = await api.loopPolicyPresetDelete(sel);
    if (r.status === 'ok') { setSel(''); reload(); }
    else if (r.message) alert(r.message);
  };
  const selPreset = presets.find((x) => x.id === sel);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 预设：像 Prompts/Skills 一样直接选用，选完仍可调整 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ ...labelText, marginBottom: 0 }}>预设</span>
        <select value={sel} onChange={(e) => applyPreset(e.target.value)} style={{ ...inputBase, flex: '1 1 180px', minWidth: 160 }}>
          <option value="">— 选择一个预设套用 —</option>
          <optgroup label="内置">
            {presets.filter((p) => p.builtin).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </optgroup>
          {presets.some((p) => !p.builtin) && (
            <optgroup label="我的">
              {presets.filter((p) => !p.builtin).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          )}
        </select>
        <button type="button" onClick={saveAsPreset} style={smallBtn} title="把当前配置另存为预设">＋ 存为预设</button>
        {selPreset && !selPreset.builtin && (
          <button type="button" onClick={delPreset} style={{ ...smallBtn, color: '#f87171', borderColor: '#f8717155' }}>删除</button>
        )}
      </div>
      {selPreset?.desc && <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{selPreset.desc}</div>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <NumField label="可交付门槛" hint="分数 ≥ 此值视为可交付" value={value.deliverableScore}
          min={0} max={100} step={1} onChange={(v) => set({ deliverableScore: v })} />
        <NumField label="可输出门槛" hint="分数 ≥ 此值视为可输出" value={value.outputtableScore}
          min={0} max={100} step={1} onChange={(v) => set({ outputtableScore: v })} />
        <NumField label="最大 Loop 数" hint="基础上限（风险越高实际越少）" value={value.maxLoops}
          min={1} max={50} step={1} onChange={(v) => set({ maxLoops: v })} />
        <NumField label="风险止损阈值" hint="风险系数 ≥ 此值即收口" value={value.riskThreshold}
          min={0.1} max={1} step={0.05} onChange={(v) => set({ riskThreshold: v })} />
      </div>

      {/* 防自欺：独立对抗式评审 */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
        <input type="checkbox" checked={value.independentEval} onChange={(e) => set({ independentEval: e.target.checked })} style={{ marginTop: 2 }} />
        <span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--theme-text)' }}>独立对抗式评审（防自欺）</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 2, lineHeight: 1.5 }}>
            评分用独立上下文、不复用执行对话；以实际产物/可运行性为准核实，默认未完成，避免「越跑越自我感觉良好」的失真。建议开启。
          </span>
        </span>
      </label>

      <div>
        <div style={labelRow}>
          <span style={labelText}>策略与心智</span>
          <button type="button" onClick={() => set({ strategy: DEFAULT_STRATEGY })} style={resetBtn}
            title="恢复默认策略文本">↺ 默认</button>
        </div>
        <textarea
          value={value.strategy}
          onChange={(e) => set({ strategy: e.target.value })}
          placeholder="描述 loop 的策略与评分心智，会注入到每次 prepare / analysis 提示中…"
          style={{ ...inputBase, width: '100%', minHeight: 120, resize: 'vertical', lineHeight: 1.55, fontSize: 12.5 }}
        />
        <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 4 }}>
          这段文本会在每次 prepare（规划）与 analysis（评分）时作为「须遵循」的指导注入给模型。
        </div>
      </div>
    </div>
  );
};

const NumField: React.FC<{
  label: string; hint: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}> = ({ label, hint, value, min, max, step, onChange }) => (
  <div style={{ flex: '1 1 120px', minWidth: 120 }}>
    <div style={labelText}>{label}</div>
    <input
      type="number" value={value} min={min} max={max} step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ ...inputBase, width: '100%' }}
    />
    <div style={{ fontSize: 10.5, color: 'var(--theme-text-muted)', marginTop: 2 }}>{hint}</div>
  </div>
);

const inputBase: React.CSSProperties = {
  background: 'var(--theme-input-bg, #fff)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)', borderRadius: 8, padding: '7px 9px', fontSize: 13,
  outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
};
const labelRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 };
const labelText: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--theme-text, #1f2328)', marginBottom: 4 };
const resetBtn: React.CSSProperties = {
  marginLeft: 'auto', background: 'none', border: '1px solid var(--theme-border)', borderRadius: 6,
  color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 11, padding: '2px 8px',
};
const smallBtn: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary, #f6f8fa)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 7, color: 'var(--theme-text, #1f2328)', cursor: 'pointer', fontSize: 12, padding: '6px 10px', whiteSpace: 'nowrap',
};
