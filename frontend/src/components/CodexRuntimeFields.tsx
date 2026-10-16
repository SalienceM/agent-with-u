import React, { useId } from 'react';
import { resolveCodexModelOptions } from '../utils/codexModelOptions';
import { normalizeReasoningEffort } from '../utils/codexReasoning';
import { useCodexReasoning } from '../hooks/useCodexReasoning';
export { CODEX_MODELS } from '../utils/codexModelOptions';

export interface ModelRuntime {
  model?: string;
  reasoningEffort?: string;
}


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
  if (normalizeReasoningEffort(effort)) runtime.reasoningEffort = effort;
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
  sessionId?: string;
  execKey?: string;
}

/** 每个 Session 的运行参数。Backend 仍只负责账号、连接与 CLI 配置。 */
export const BackendRuntimeFields: React.FC<Props> = ({
  backend,
  value,
  onChange,
  inherited,
  compact = false,
  inheritLabel = '跟随 Backend / Codex 默认',
  sessionId,
  execKey,
}) => {
  const listId = `codex-models-${useId().replace(/:/g, '')}`;
  const catalog = useCodexReasoning(backend, sessionId, execKey);
  if (!isRuntimeConfigurableBackend(backend)) return null;
  const codex = isCodexBackend(backend);
  const own = normalizeModelRuntime(value);
  const resolved = resolveModelRuntime(backend, own, inherited);
  const capability = catalog.rows.find(item => item.model === resolved.model);
  const efforts = capability?.supportedReasoningEfforts || [];
  const unlistedEffort = own.reasoningEffort && !efforts.some(item => item.reasoningEffort === own.reasoningEffort);
  const patch = (next: Partial<ModelRuntime>) => {
    const normalized = normalizeModelRuntime({ ...own, ...next });
    if (!codex) delete normalized.reasoningEffort;
    onChange(normalized);
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: codex
        ? (compact ? 'minmax(0, 1.4fr) minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))')
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
            {resolveCodexModelOptions(backend).map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
          </datalist>
        )}
      </label>
      {codex && (
        <>
        <label style={fieldStyle}>
          <span style={labelStyle}>推理档位</span>
          <select
            value={own.reasoningEffort || ''}
            onChange={(e) => patch({ reasoningEffort: e.target.value || undefined })}
            style={inputStyle}
          >
            <option value="">{inheritLabel}</option>
            {unlistedEffort && <option value={own.reasoningEffort} disabled>{own.reasoningEffort} · 原配置（未确认支持）</option>}
            {efforts.map((effort) => (
              <option key={effort.reasoningEffort} value={effort.reasoningEffort} title={effort.description}>
                {effort.reasoningEffort}{effort.reasoningEffort === capability?.defaultReasoningEffort ? ' · Codex 目录默认' : ''}
              </option>
            ))}
          </select>
        </label>
        <div role="status" style={{ ...labelStyle, gridColumn: '1 / -1', fontSize: 10, lineHeight: 1.4 }}>
          {catalog.loading ? '正在读取 Codex 档位…' : catalog.error || (capability
            ? efforts.length ? '来源：当前执行节点 Codex。继承时仍由 Codex 配置决定。' : 'Codex 未提供可选档位，使用默认。'
            : resolved.model ? 'Codex 未返回此模型的档位，未使用固定列表。' : '请指定模型后查看其 Codex 档位。')}
          {!catalog.loading && (catalog.error || !capability) && <button type="button" onClick={catalog.retry}
            style={{ border: 0, background: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 10 }}>重新读取</button>}
          {!catalog.loading && unlistedEffort && <div>原档位已保留；可选跟随默认或重新选择受支持档位。</div>}
        </div>
        </>
      )}
      {!compact && (
        <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--theme-text-muted)', lineHeight: 1.45 }}>
          本次提交配置：<b style={{ color: 'var(--theme-text)' }}>{formatRuntimeLabel(backend, resolveModelRuntime(backend, own, inherited))}</b>。
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
