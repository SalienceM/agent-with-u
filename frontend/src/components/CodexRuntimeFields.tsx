import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type PoeModelInfo } from '../api';
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

export function isPoeBackend(backend: any): boolean {
  if (backend?.type !== 'openai-compatible') return false;
  try {
    const url = new URL(String(backend?.baseUrl || '').trim());
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.poe.com'
      && (!url.port || url.port === '443')
      && url.pathname.replace(/\/+$/, '') === '/v1'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function isRuntimeConfigurableBackend(backend: any): boolean {
  return isCodexBackend(backend) || isQwenBackend(backend) || isPoeBackend(backend);
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

const PoeBotPicker: React.FC<{
  models: PoeModelInfo[];
  value?: string;
  inheritedModel?: string;
  disabled?: boolean;
  onChange: (model?: string) => void;
}> = ({ models, value, inheritedModel, disabled, onChange }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => {
    if (!normalizedQuery) return models;
    return models.filter((item) => (
      `${item.id} ${item.description || ''} ${item.ownedBy || ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ));
  }, [models, normalizedQuery]);
  // 初始只展示少量热门/靠前项；搜索后也设置上限，避免几百个节点同时挂进 DOM。
  const visibleModels = matches.slice(0, normalizedQuery ? 80 : 30);
  const choices: Array<string | undefined> = [undefined, ...visibleModels.map(item => item.id)];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    const positionMenu = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const margin = 12;
      const gap = 6;
      const below = Math.max(0, viewportHeight - rect.bottom - margin - gap);
      const above = Math.max(0, rect.top - margin - gap);
      const openBelow = below >= 260 || below >= above;
      const available = openBelow ? below : above;
      const width = Math.min(Math.max(rect.width, 320), viewportWidth - margin * 2);
      const left = Math.min(Math.max(margin, rect.left), viewportWidth - margin - width);
      setMenuPosition({
        left,
        width,
        maxHeight: Math.max(180, Math.min(360, available)),
        ...(openBelow
          ? { top: rect.bottom + gap, bottom: 'auto' }
          : { bottom: viewportHeight - rect.top + gap, top: 'auto' }),
      });
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    const focusTimer = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusTimer);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [open]);

  const choose = (model?: string) => {
    onChange(model);
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  };
  const moveActive = (delta: number) => {
    setActiveIndex(index => Math.max(0, Math.min(choices.length - 1, index + delta)));
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => {
          setOpen(current => !current);
          setQuery('');
          setActiveIndex(0);
        }}
        style={{
          ...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, textAlign: 'left', cursor: disabled ? 'wait' : 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value || (inheritedModel ? `跟随 Backend：${inheritedModel}` : '跟随 Backend 默认')}
        </span>
        <span aria-hidden="true" style={{ flex: '0 0 auto', opacity: 0.7 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          style={{ ...poePickerMenuStyle, ...menuPosition }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
              else if (event.key === 'Enter') { event.preventDefault(); choose(choices[activeIndex]); }
              else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
            }}
            placeholder="搜索 Bot 名称、厂商或描述…"
            aria-label="搜索 Poe Bot"
            style={{ ...inputStyle, flex: '0 0 auto' }}
          />
          <div style={{ fontSize: 10, color: 'var(--theme-text-muted)', padding: '6px 2px 4px' }}>
            {normalizedQuery
              ? `匹配 ${matches.length} / ${models.length} 个 Bot${matches.length > visibleModels.length ? `，显示前 ${visibleModels.length} 个` : ''}`
              : `共 ${models.length} 个 Bot，先显示 ${visibleModels.length} 个；输入关键字可筛选全部`}
          </div>
          <div role="listbox" aria-label="Poe Bot 列表" style={{ minHeight: 0, overflowY: 'auto' }}>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={() => choose(undefined)}
              style={poeOptionStyle(activeIndex === 0, !value)}
            >
              <span style={{ fontWeight: 600 }}>{inheritedModel ? `跟随 Backend：${inheritedModel}` : '跟随 Backend 默认'}</span>
            </button>
            {visibleModels.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={value === item.id}
                title={item.description || item.id}
                onMouseEnter={() => setActiveIndex(index + 1)}
                onClick={() => choose(item.id)}
                style={poeOptionStyle(activeIndex === index + 1, value === item.id)}
              >
                <span style={{ display: 'block', fontWeight: 600 }}>{item.id}</span>
                {!!item.description && (
                  <span style={{
                    display: 'block', marginTop: 2, fontSize: 10, color: 'var(--theme-text-muted)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {item.description}
                  </span>
                )}
              </button>
            ))}
            {visibleModels.length === 0 && (
              <div style={{ padding: '14px 8px', textAlign: 'center', fontSize: 11, color: 'var(--theme-text-muted)' }}>
                没有匹配的 Bot，请换个关键词
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

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
  const codex = isCodexBackend(backend);
  const poe = isPoeBackend(backend);
  const [poeModels, setPoeModels] = useState<PoeModelInfo[]>([]);
  const [poeLoading, setPoeLoading] = useState(false);
  const [poeError, setPoeError] = useState('');
  const [poeReload, setPoeReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!poe || !backend?.id) {
      setPoeModels([]);
      setPoeLoading(false);
      setPoeError('');
      return () => { cancelled = true; };
    }
    setPoeLoading(true);
    setPoeError('');
    api.poeModelCatalog(backend.id, execKey).then((result) => {
      if (cancelled) return;
      setPoeModels(result.models || []);
      if (result.status === 'error' || result.catalogError) {
        setPoeError(result.message || result.catalogError || '无法读取 Poe Bot 目录');
      }
    }).catch((error: any) => {
      if (!cancelled) setPoeError(error?.message || '无法读取 Poe Bot 目录');
    }).finally(() => {
      if (!cancelled) setPoeLoading(false);
    });
    return () => { cancelled = true; };
  }, [poe, backend?.id, execKey, poeReload]);
  if (!isRuntimeConfigurableBackend(backend)) return null;
  const own = normalizeModelRuntime(value);
  const resolved = resolveModelRuntime(backend, own, inherited);
  const inheritedResolved = resolveModelRuntime(backend, undefined, inherited);
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
      <div style={fieldStyle}>
        <span style={labelStyle}>{codex ? 'Codex 模型' : poe ? 'Poe 官方 Bot' : 'Qwen 模型'}</span>
        {poe ? (
          <PoeBotPicker
            models={poeModels}
            value={own.model}
            inheritedModel={inheritedResolved.model}
            onChange={(model) => patch({ model })}
            disabled={poeLoading && poeModels.length === 0}
          />
        ) : (
          <input
            value={own.model || ''}
            onChange={(e) => patch({ model: e.target.value || undefined })}
            list={codex ? listId : undefined}
            placeholder={resolved.model ? `继承：${resolved.model}` : '跟随默认'}
            style={inputStyle}
          />
        )}
        {codex && (
          <datalist id={listId}>
            {resolveCodexModelOptions(backend).map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
          </datalist>
        )}
      </div>
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
      {poe && (
        <div role="status" style={{ ...labelStyle, gridColumn: '1 / -1', fontSize: 10, lineHeight: 1.4 }}>
          {poeLoading
            ? '正在从 Poe 加载官方 Bot 目录…'
            : poeError || `已加载 ${poeModels.length} 个 API 可用 Bot。Poe 通道仅进行普通 Chat，不传递 Agent 工具。`}
          {!poeLoading && (
            <button type="button" onClick={() => setPoeReload(value => value + 1)}
              style={{ border: 0, background: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 10 }}>
              重新加载
            </button>
          )}
        </div>
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

const poePickerMenuStyle: React.CSSProperties = {
  position: 'fixed', zIndex: 10000, boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column', maxHeight: 340, padding: 8,
  border: '1px solid var(--theme-border)', borderRadius: 9,
  background: 'var(--theme-bg-secondary, #242a31)',
  boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
};

const poeOptionStyle = (active: boolean, selected: boolean): React.CSSProperties => ({
  display: 'block', width: '100%', padding: '7px 8px', border: 0, borderRadius: 6,
  textAlign: 'left', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer',
  color: 'var(--theme-text)',
  background: selected
    ? 'var(--theme-accent-bg, rgba(9,105,218,0.22))'
    : active ? 'var(--theme-bg-tertiary, rgba(255,255,255,0.08))' : 'transparent',
});
