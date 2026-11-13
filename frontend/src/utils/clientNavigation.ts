import { uuid } from './uuid';

export interface NavigationIdentity { mode: 'local' | 'relay'; userId: string; realm?: string }
export const NAVIGATION_CHANGED = 'awu:client-navigation';
export const NAVIGATION_ERROR = 'awu:client-navigation-error';
const memory = new Map<string, string>();
const temporaryClients = new WeakMap<Storage, Map<string, string>>();
let failed = false;
export const navigationSaveFailed = (): boolean => failed;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

function storage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
export function navigationError(): void {
  failed = true;
  try { window.dispatchEvent(new CustomEvent(NAVIGATION_ERROR)); } catch { /* 非浏览器或存储被禁用 */ }
}
export function navigationScope(identity: NavigationIdentity): string {
  const clientKey = `awu-window-client-v1:${identity.userId}`;
  let client = memory.get(clientKey);
  const local = storage();
  try { if (local) client = local.getItem(clientKey) || temporaryClients.get(local)?.get(clientKey); } catch { /* 内存回退 */ }
  if (!validId(client)) {
    client = uuid(); memory.set(clientKey, client);
    try { if (!local) throw new Error(); local.setItem(clientKey, client); }
    catch {
      if (local) { const entries = temporaryClients.get(local) || new Map<string, string>(); entries.set(clientKey, client); temporaryClients.set(local, entries); }
      navigationError();
    }
  }
  let realm = identity.realm || '';
  if (!realm) { try { realm = window.location?.origin || ''; } catch { /* 单测 */ } }
  return `awu:navigation:v2:${encodeURIComponent(JSON.stringify([identity.mode, realm, identity.userId, client]))}`;
}
export function readNavigation(key: string): string | null {
  try { return memory.get(key) ?? storage()?.getItem(key) ?? null; } catch { return memory.get(key) ?? null; }
}
export function writeNavigation(key: string, value: string): boolean {
  if (value.length > 262144) { navigationError(); return false; }
  try { if (!storage()) throw new Error(); storage()!.setItem(key, value); memory.delete(key); return true; }
  catch { memory.set(key, value); navigationError(); return false; }
}
// 每个分组单独写键，两个窗口同时操作不同节点不会以整表读改写覆盖彼此。
export function groupCollapsed(identity: NavigationIdentity, group: string): boolean {
  try { const row = JSON.parse(readNavigation(`${navigationScope(identity)}:group:${encodeURIComponent(group)}`) || 'null');
    return row?.version === 1 && row.collapsed === true;
  } catch { return false; }
}
export function saveGroupCollapsed(identity: NavigationIdentity, group: string, collapsed: boolean): boolean {
  if (!group || group.length > 1024) return false;
  const result = writeNavigation(`${navigationScope(identity)}:group:${encodeURIComponent(group)}`, JSON.stringify({ version: 1, collapsed }));
  try { window.dispatchEvent(new CustomEvent(NAVIGATION_CHANGED)); } catch { /* 单测 */ }
  return result;
}

export function navigationWindowId(identity: NavigationIdentity): string {
  let current = '';
  try {
    current = new URLSearchParams(window.location?.search || '').get('workbenchWindow')
      || window.sessionStorage.getItem(`awu-window-id-v1:${identity.userId}`) || '';
    if (!validId(current)) { current = uuid(); window.sessionStorage.setItem(`awu-window-id-v1:${identity.userId}`, current); }
  } catch { current = memory.get(`window:${navigationScope(identity)}`) || uuid(); memory.set(`window:${navigationScope(identity)}`, current); }
  return current;
}
export function isDetachedNavigation(): boolean {
  try { return new URLSearchParams(window.location?.search || '').get('sessionWindow') === '1'; } catch { return false; }
}
