import { parseCodexCatalogResult } from './codexCatalogSync';

export interface CodexReasoningCapability {
  model: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
}

// 只校验可安全传给 CLI 的 token；不是支持档位列表。
export function normalizeReasoningEffort(value: unknown): string {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_-]{0,63}$/.test(effort) ? effort : '';
}

export function parseCodexReasoningCatalog(raw: unknown): CodexReasoningCapability[] {
  const catalog = parseCodexCatalogResult(raw);
  const value = (raw as Record<string, unknown>).reasoningCapabilities;
  // 旧节点没有此字段：未知，不使用写死档位补齐。
  if (value === undefined) return [];
  const invalid = () => new Error('Codex 推理档位响应无效；未使用本地固定列表。');
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const models = new Set(catalog.modelOptions.map(item => item.id));
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || !models.has(item.model) || seen.has(item.model)
      || !Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.length > 32
      || !normalizeReasoningEffort(item.defaultReasoningEffort)
      || normalizeReasoningEffort(item.defaultReasoningEffort) !== item.defaultReasoningEffort) throw invalid();
    seen.add(item.model);
    const efforts = new Set<string>();
    const options = item.supportedReasoningEfforts.map((option: any) => {
      if (!option || !normalizeReasoningEffort(option.reasoningEffort)
        || normalizeReasoningEffort(option.reasoningEffort) !== option.reasoningEffort
        || efforts.has(option.reasoningEffort) || typeof option.description !== 'string'
        || option.description.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(option.description)) throw invalid();
      efforts.add(option.reasoningEffort);
      return { reasoningEffort: option.reasoningEffort, description: option.description };
    });
    if (options.length && !efforts.has(item.defaultReasoningEffort)) throw invalid();
    return { model: item.model, supportedReasoningEfforts: options, defaultReasoningEffort: item.defaultReasoningEffort };
  });
}

// 同一设置面板中的 LOOP 角色合并在途只读查询，完成后不保留跨会话缓存。
const pending = new Map<string, Promise<CodexReasoningCapability[]>>();
export function readCodexReasoning(key: string, read: () => Promise<unknown>): Promise<CodexReasoningCapability[]> {
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= 16) return Promise.reject(new Error('Codex 目录读取繁忙，请稍后重试。'));
  const request = Promise.resolve().then(read).then(parseCodexReasoningCatalog)
    .finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}
