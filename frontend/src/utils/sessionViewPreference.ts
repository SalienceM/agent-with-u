import { isSessionViewMode, type SessionViewMode } from './sessionWorkbench';

const KEY = 'awu-session-view-local-v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export function sessionViewKey(user: string, executor: string, session: string): string {
  return JSON.stringify([user, executor, session]);
}
function read(storage: StorageLike): Record<string, SessionViewMode> {
  try {
    const text = storage.getItem(KEY);
    if (!text || text.length > 65536) return {};
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([key, mode]) => key.length <= 1024 && isSessionViewMode(mode)).slice(-200)) as Record<string, SessionViewMode>;
  } catch { return {}; }
}
export function localSessionView(storage: StorageLike, key: string): SessionViewMode | undefined {
  return read(storage)[key];
}
export function rememberLocalSessionView(storage: StorageLike, key: string, mode: SessionViewMode | null): boolean {
  try {
    if (key.length > 1024 || mode !== null && !isSessionViewMode(mode)) return false;
    const entries = read(storage); delete entries[key];
    if (mode) entries[key] = mode;
    // 只存有界展示偏好，不含正文、附件或授权；丢弃旧偏好不影响任何文档草稿。
    const bounded = Object.entries(entries).slice(-200);
    while (JSON.stringify(Object.fromEntries(bounded)).length > 65536) bounded.shift();
    storage.setItem(KEY, JSON.stringify(Object.fromEntries(bounded)));
    return true;
  } catch { return false; }
}
