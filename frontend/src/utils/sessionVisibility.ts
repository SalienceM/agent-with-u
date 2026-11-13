import { workbenchSessionId, type WorkbenchState } from './workbench';

export type SessionVisibility = 'public' | 'private' | 'unknown';
/** null 表示尚未取得元数据；旧节点完整元数据没有私密字段时兼容为公开。 */
export function sessionVisibility(meta: any): SessionVisibility {
  if (!meta || meta.privacyKnown === false || (typeof meta.isPrivate !== 'boolean' && typeof meta.title !== 'string' && !meta.sessionType)) return 'unknown';
  return meta.isPrivate === true ? 'private' : 'public';
}
export function canShowSession(meta: any, reveal: boolean): boolean {
  const state = sessionVisibility(meta);
  return state === 'public' || (state === 'private' && reveal);
}
export function canNotifySession(meta: any): boolean { return sessionVisibility(meta) === 'public'; }

// 仅当前 JS 窗口的临时选择；绝不写 Storage、BroadcastChannel 或远端。
let revealed = false;
const listeners = new Set<() => void>();
export const privateSessionsShown = (): boolean => revealed;
export function showPrivateSessions(value: boolean): void {
  if (revealed === value) return;
  revealed = value; listeners.forEach(listener => listener());
}
export function subscribeSessionVisibility(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function projectSessionNavigation(state: WorkbenchState, panes: (string | null)[],
  metadata: (id: string) => any, reveal: boolean, suppressed: ReadonlySet<string> = new Set()) {
  const tabs = state.tabs.filter(tab => { const id = workbenchSessionId(tab); return !id || canShowSession(metadata(id), reveal); });
  const activeId = workbenchSessionId(state.active);
  const active = tabs.includes(state.active) && !(activeId && suppressed.has(activeId)) ? state.active : 'chat';
  return { workbench: { tabs, active } as WorkbenchState,
    panes: panes.map(id => id && canShowSession(metadata(id), reveal) && !suppressed.has(id) ? id : null) };
}
