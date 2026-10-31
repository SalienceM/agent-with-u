/** 只保留本窗口的浏览状态，不落盘正文、确认、授权或待执行请求。 */
export class FilePanelViewCache<T> {
  private entries = new Map<string, { value: T; weight: number }>();
  constructor(private readonly maxEntries = 24, private readonly maxWeight = 150_000) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, weight = 1): void {
    this.entries.delete(key);
    if (!Number.isFinite(weight) || weight < 0 || weight > this.maxWeight) return;
    this.entries.set(key, { value, weight });
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.weight, 0);
    while (this.entries.size > this.maxEntries || total > this.maxWeight) {
      const oldest = this.entries.keys().next().value!;
      total -= this.entries.get(oldest)!.weight; this.entries.delete(oldest);
    }
  }
  clear(): void { this.entries.clear(); }
}

export function filePanelViewKey(owner: string, executor: string, session: string, directory: string,
  mode: string, engine: boolean): string {
  return JSON.stringify([owner, executor, session, directory, mode, engine]);
}

const EXPANSION_KEY = 'awu-file-tree-expansion-v1';
const MAX_EXPANSION_CHARS = 256 * 1024;
type ExpansionStorage = Pick<Storage, 'getItem' | 'setItem'>;

function validDirectoryPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
    && !/[\\\u0000-\u001f:]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function readExpansions(storage: ExpansionStorage): Record<string, string[]> {
  const raw = storage.getItem(EXPANSION_KEY);
  if (!raw || raw.length > MAX_EXPANSION_CHARS) return {};
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) return {};
  return Object.fromEntries(Object.entries(data.entries).filter(([key, paths]) => key.length <= 4096 && Array.isArray(paths))
    .slice(-32).map(([key, paths]) => [key, [...new Set((paths as unknown[]).filter(validDirectoryPath))].slice(-512)]));
}

/** 刷新只恢复目录的展示偏好，不持久化目录清单、文件正文、比对结果或授权。 */
export function loadFileTreeExpansion(key: string, storage?: ExpansionStorage): Record<string, boolean> {
  try {
    const paths = readExpansions(storage ?? window.localStorage)[key];
    return Object.fromEntries((Array.isArray(paths) ? paths : []).map(path => [path, true]));
  } catch { return {}; }
}

export function saveFileTreeExpansion(key: string, expanded: Record<string, boolean>, storage?: ExpansionStorage): boolean {
  try {
    if (!key || key.length > 4096) return false;
    const target = storage ?? window.localStorage;
    let entries: Record<string, string[]>;
    try { entries = readExpansions(target); } catch { entries = {}; }
    delete entries[key];
    entries[key] = Object.keys(expanded).filter(path => expanded[path] === true && validDirectoryPath(path)).slice(-512);
    const bounded = Object.entries(entries).slice(-32);
    const serialize = () => JSON.stringify({ version: 1, entries: Object.fromEntries(bounded) });
    while (bounded.length > 1 && serialize().length > MAX_EXPANSION_CHARS) bounded.shift();
    const raw = serialize();
    if (raw.length > MAX_EXPANSION_CHARS) return false;
    target.setItem(EXPANSION_KEY, raw);
    return true;
  } catch { return false; }
}
