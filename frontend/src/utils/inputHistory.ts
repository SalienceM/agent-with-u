/** 控制端输入回看：只保存用户输入文字，不保存附件、发送参数或授权。 */
export const INPUT_HISTORY_LIMIT = 10;
const MAX_ENTRY_CHARS = 32_000;
const MAX_TOTAL_CHARS = 64_000;
const PREFIX = 'agent-with-u:input-history:v1:';

export function inputHistoryKey(
  identity: { mode: 'local' | 'relay'; userId: string },
  executor?: string | null,
  session?: string | null,
): string | null {
  // 节点尚未确定时不猜 home/local，也不读取未隔离的旧缓存。
  if (!identity.userId || identity.userId === 'legacy' || !executor || !session) return null;
  return PREFIX + [identity.mode, identity.userId, executor, session].map(encodeURIComponent).join(':');
}

export function normalizeInputHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  let size = 0;
  for (let i = value.length - 1; i >= 0 && result.length < INPUT_HISTORY_LIMIT; i--) {
    const text = typeof value[i] === 'string' ? value[i].trim() : '';
    // 不截断命令或长文本，避免回看后误发半条指令。
    if (!text || text.length > MAX_ENTRY_CHARS || text === result[0]) continue;
    if (size + text.length > MAX_TOTAL_CHARS) break;
    result.unshift(text);
    size += text.length;
  }
  return result;
}

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function createInputHistoryStore(storage: () => HistoryStorage = () => window.localStorage) {
  // 存储禁用/满额不能阻塞发送；失败的最新写入在本窗口仍可回看。
  const fallback = new Map<string, string[]>();
  const read = (key: string | null): string[] => {
    if (!key) return [];
    if (fallback.has(key)) return [...fallback.get(key)!];
    try {
      const raw = storage().getItem(key);
      const saved = raw ? JSON.parse(raw) : null;
      return saved?.version === 1 ? normalizeInputHistory(saved.entries) : [];
    } catch { return []; }
  };
  const write = (key: string | null, entries: string[]) => {
    if (!key) return { entries, persisted: false };
    try {
      storage().setItem(key, JSON.stringify({ version: 1, entries }));
      fallback.delete(key);
      return { entries, persisted: true };
    } catch {
      fallback.set(key, entries);
      return { entries, persisted: false };
    }
  };
  return {
    read,
    append(key: string | null, text: string) {
      return write(key, normalizeInputHistory([...read(key), text]));
    },
    seed(key: string | null, texts: readonly string[]) {
      const existing = read(key);
      return existing.length ? existing : write(key, normalizeInputHistory(texts)).entries;
    },
    remove(key: string | null) {
      if (!key) return;
      fallback.delete(key);
      try { storage().removeItem(key); } catch { fallback.set(key, []); }
    },
  };
}

export const inputHistoryStore = createInputHistoryStore();
