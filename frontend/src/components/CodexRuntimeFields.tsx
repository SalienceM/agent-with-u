import React, { useId } from 'react';

export interface ModelRuntime {
  model?: string;
  reasoningEffort?: string;
}

export const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · 复杂任务/精细交付' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 日常均衡执行' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 快速/轻量' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
];

export const CODEX_REASONING_EFFORTS = [
  { id: 'none', label: '关闭 · none' },
  { id: 'minimal', label: '最低 · minimal' },
  { id: 'low', label: '低 · low' },
  { id: 'medium', label: '中 · medium' },
  { id: 'high', label: '高 · high' },
  { id: 'xhigh', label: '极高 · xhigh' },
  { id: 'max', label: '顶格 · max' },
];

const EFFORT_IDS = new Set(CODEX_REASONING_EFFORTS.map((item) => item.id));

export function isCodexBackend(backend: any): boolean {
  return backend?.type === 'codex-office';
}

export function isQwenBackend(backend: any): boolean {
  return backend?.type === 'qwen-code-cli';
}

export function isRuntimeConfigurableBackend(backend: any): boolean {
  return isCodexBackend(backend) || isQwenBackend(backend);
}

export function normalizeModelRuntime(raw?: ModelRuntime | null): ModelRuntime {
  const runtime: ModelRuntime = {};
  const model = typeof raw?.model === 'string' ? raw.model.trim() : '';
  const effort = typeof raw?.reasoningEffort === 'string'
    ? raw.reasoningEffort.trim().toLowerCase()
    : '';
  if (model) runtime.model = model;
  if (EFFORT_IDS.has(effort)) runtime.reasoningEffort = effort;
  return runtime;
}

export function resolveModelRuntime(
  backend: any,
  explicit?: ModelRuntime | null,
  inherited?: ModelRuntime | null,
): ModelRuntime {
  const base = normalizeModelRuntime(inherited);
  const own = normalizeModelRuntime(explicit);
  return {
    model: own.model || base.model || backend?.model
      || backend?.env?.OPENAI_MODEL || backend?.env?.QWEN_MODEL || undefined,
    reasoningEffort: isCodexBackend(backend)
      ? own.reasoningEffort || base.reasoningEffort || undefined
      : undefined,
  };
}

export function formatRuntimeLabel(backend: any, runtime?: ModelRuntime | null): string {
  const resolved = resolveModelRuntime(backend, runtime);
  return [resolved.model || 'auto', resolved.reasoningEffort].filter(Boolean).join(' · ');
}

interface Props {
  backend: any;
  value: ModelRuntime;
  onChange: (runtime: ModelRuntime) => void;
  inherited?: ModelRuntime;
  compact?: boolean;
  inheritLabel?: string;
}

/** 每个 Session 的运行参数。Backend 仍只负责账号、连接与 CLI 配置。 */
export const BackendRuntimeFields: React.FC<Props> = ({
  backend,
  value,
  onChange,
  inherited,
  compact = false,
  inheritLabel = '跟随 Backend / Codex 默认',
}) => {
  const listId = `codex-models-${useId().replace(/:/g, '')}`;
  if (!isRuntimeConfigurableBackend(backend)) return null;
  const codex = isCodexBackend(backend);
  const own = normalizeModelRuntime(value);
  const resolved = resolveModelRuntime(backend, own, inherited);
  const patch = (next: Partial<ModelRuntime>) => {
    const normalized = normalizeModelRuntime({ ...own, ...next });
    if (!codex) delete normalized.reasoningEffort;
    onChange(normalized);
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: codex
        ? (compact ? 'minmax(145px, 1.4fr) minmax(120px, 1fr)' : 'repeat(2, minmax(180px, 1fr))')
        : 'minmax(180px, 1fr)',
      gap: 8, alignItems: 'end',
    }}>
      <label style={fieldStyle}>
        <span style={labelStyle}>{codex ? 'Codex' : 'Qwen'} 模型</span>
        <input
          value={own.model || ''}
          onChange={(e) => patch({ model: e.target.value || undefined })}
          list={codex ? listId : undefined}
          placeholder={resolved.model ? `继承：${resolved.model}` : '跟随默认'}
          style={inputStyle}
        />
        {codex && (
          <datalist id={listId}>
            {CODEX_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </datalist>
        )}
      </label>
      {codex && (
        <label style={fieldStyle}>
          <span style={labelStyle}>推理档位</span>
          <select
            value={own.reasoningEffort || ''}
            onChange={(e) => patch({ reasoningEffort: e.target.value || undefined })}
            style={inputStyle}
          >
            <option value="">{inheritLabel}</option>
            {CODEX_REASONING_EFFORTS.map((effort) => (
              <option key={effort.id} value={effort.id}>{effort.label}</option>
            ))}
          </select>
        </label>
      )}
      {!compact && (
        <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--theme-text-muted)', lineHeight: 1.45 }}>
          本次实际配置：<b style={{ color: 'var(--theme-text)' }}>{formatRuntimeLabel(backend, resolveModelRuntime(backend, own, inherited))}</b>。
          留空即继承，不需要为 Sol / Terra / 不同档位复制 Backend。
        </div>
      )}
    </div>
  );
};

/** 兼容旧调用名。 */
export const CodexRuntimeFields = BackendRuntimeFields;

const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--theme-text-muted)' };
const inputStyle: React.CSSProperties = {
  width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '7px 9px', borderRadius: 7,
  border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
  color: 'var(--theme-text)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
};
