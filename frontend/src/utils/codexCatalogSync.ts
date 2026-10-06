import { normalizeCodexModelOptions, type CodexModelOption } from './codexModelOptions';

interface ConnectionConfig {
  id: string;
  type: string;
  cliPath?: string;
  apiKey?: string;
  baseUrl?: string;
  workingDir?: string;
  env?: Record<string, string>;
}

// 与 Backend 保存时的 trim/空值处理一致；指纹只留在内存，不能输出到日志。
function connectionKey(value: ConnectionConfig): string {
  return JSON.stringify([value.id, value.type, ...[
    value.cliPath, value.apiKey, value.baseUrl, value.workingDir,
  ].map(item => (item || '').trim()), Object.entries(value.env || {})
    .map(([key, val]) => [key, val.trim()]).filter(([, val]) => val)
    .sort(([a], [b]) => a.localeCompare(b))]);
}

export function catalogConnectionSaved(draft: ConnectionConfig, saved?: ConnectionConfig | null): boolean {
  return !!saved && connectionKey(draft) === connectionKey(saved);
}

export interface CodexCatalogResult {
  modelOptions: CodexModelOption[];
  fetchedAt: string;
}

const errors: Record<string, string> = {
  backend: '请先保存这个 Codex Backend，再同步目录。',
  configuration: 'Codex 代理配置无效，请先修正配置。',
  unsupported: '目标 Codex 不支持目录查询，请升级目标节点 Codex 或继续手工维护。',
  auth: '目录认证或访问权限不可用，请检查目标 Backend 的登录和配置。',
  empty: 'Codex 返回空目录，未清空候选；可继续手工维护。',
  invalid: 'Codex 返回非法、重复或超限候选，原草稿未修改。',
  incomplete: '未取得完整目录，原草稿未修改。',
  timeout: '目录查询超时，原草稿未修改；可重试或手工维护。',
  limit: '目录查询超过安全上限，原草稿未修改。',
};

export function parseCodexCatalogResult(value: unknown): CodexCatalogResult {
  const data = value as Record<string, unknown> | null;
  if (!data || data.status !== 'ok') {
    throw new Error(errors[String(data?.code)] || '目录查询失败，请检查目标节点的 CLI、网络、认证或版本；仍可手工维护。');
  }
  try {
    const rows = normalizeCodexModelOptions(data.modelOptions);
    if (!rows?.length || data.source !== 'codex-app-server' || data.freshness !== 'unknown'
      || typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error();
    return { modelOptions: rows, fetchedAt: new Date(data.fetchedAt).toISOString() };
  } catch {
    throw new Error('目录响应无效或不完整，原草稿未修改；可继续手工维护。');
  }
}
