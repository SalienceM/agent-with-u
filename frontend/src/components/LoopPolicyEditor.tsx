import React from 'react';

/** Loop 策略与心智（与后端 LoopPolicy 对齐，camelCase）。 */
export interface LoopPolicy {
  deliverableScore: number;
  outputtableScore: number;
  maxLoops: number;
  riskThreshold: number;
  strategy: string;
}

export const DEFAULT_STRATEGY =
  `每一次 loop 都是对【全局目标】的一次完整、尽力的尝试（不是把任务拆到多个 loop 分步完成）。
- prepare：规划这一遍的策略与分步编排（可并发 concurrent / 顺次 sequential）。
- execute：实际执行编排（读写文件、运行命令），如实记录产出与成败。
- analysis：对照全局目标打分（0–100），评估趋势、优化空间与硬约束。
评分心智：优先把每一遍做到尽量完整，而不是保留实力分多次；遇到环境/权限/网络等硬约束要在 challenges 里点明，避免为不可能的任务做无谓 loop。`;

export const DEFAULT_POLICY: LoopPolicy = {
  deliverableScore: 70,
  outputtableScore: 85,
  maxLoops: 8,
  riskThreshold: 0.85,
  strategy: DEFAULT_STRATEGY,
};

/** 兜底归一：补默认 + 夹取范围（可输出门槛不低于可交付门槛）。 */
export function normalizePolicy(p?: Partial<LoopPolicy> | null): LoopPolicy {
  const d = { ...DEFAULT_POLICY, ...(p || {}) };
  let del = clamp(num(d.deliverableScore, 70), 0, 100);
  let out = clamp(num(d.outputtableScore, 85), del, 100);
  const ml = Math.round(clamp(num(d.maxLoops, 8), 1, 50));
  const rt = clamp(num(d.riskThreshold, 0.85), 0.1, 1);
  const strat = (typeof d.strategy === 'string' && d.strategy.trim()) ? d.strategy : DEFAULT_STRATEGY;
  return { deliverableScore: del, outputtableScore: out, maxLoops: ml, riskThreshold: rt, strategy: strat };
}

function num(v: any, fb: number): number { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

export const LoopPolicyEditor: React.FC<{
  value: LoopPolicy;
  onChange: (p: LoopPolicy) => void;
}> = ({ value, onChange }) => {
  const set = (patch: Partial<LoopPolicy>) => onChange({ ...value, ...patch });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
