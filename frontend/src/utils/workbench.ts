export type SidebarView = 'sessions' | 'files' | 'extensions';
export type WorkbenchTab = 'chat' | 'library' | 'market' | `session:${string}`;
export interface WorkbenchState { tabs: WorkbenchTab[]; active: WorkbenchTab }
export type WorkbenchAction = { type: 'open' | 'close'; tab: WorkbenchTab } | { type: 'reset' }
  | { type: 'restore'; state: WorkbenchState }
  | { type: 'syncSessions'; sessionIds: (string | null)[]; focusedSessionId: string | null }
  | { type: 'migrateSessions'; ids: Record<string, string> };
export const initialWorkbench: WorkbenchState = { tabs: ['chat'], active: 'chat' };
export const sessionWorkbenchTab = (id: string): WorkbenchTab => `session:${id}`;
export const workbenchSessionId = (tab: WorkbenchTab): string | null => tab.startsWith('session:') ? tab.slice(8) : null;
export const isConversationTab = (tab: WorkbenchTab): boolean => tab === 'chat' || !!workbenchSessionId(tab);

/** 一个 Session 只拥有一个渲染实例；已在分屏中可见时聚焦它，不复制到另一个格子。 */
export function selectSessionPane(panes: (string | null)[], id: string | null, focused: number, slots: number) {
  const visibleIndex = id ? panes.slice(0, slots).indexOf(id) : -1;
  const index = visibleIndex >= 0 ? visibleIndex : Math.max(0, Math.min(focused, slots - 1));
  const next = panes.map((value, i) => i === index ? id : id && value === id ? null : value);
  return { panes: next.every((value, i) => value === panes[i]) ? panes : next, focused: index };
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  if (action.type === 'reset') return initialWorkbench;
  if (action.type === 'restore') return action.state;
  if (action.type === 'syncSessions') {
    const tabs = [...state.tabs];
    for (const id of action.sessionIds) {
      if (id && !tabs.includes(sessionWorkbenchTab(id))) tabs.push(sessionWorkbenchTab(id));
    }
    const active = isConversationTab(state.active)
      ? (action.focusedSessionId ? sessionWorkbenchTab(action.focusedSessionId) : 'chat') : state.active;
    return tabs.length === state.tabs.length && active === state.active ? state : { tabs, active };
  }
  if (action.type === 'migrateSessions') {
    const remap = (tab: WorkbenchTab): WorkbenchTab => {
      const id = workbenchSessionId(tab);
      return id && action.ids[id] ? sessionWorkbenchTab(action.ids[id]) : tab;
    };
    return { tabs: [...new Set(state.tabs.map(remap))], active: remap(state.active) };
  }
  if (action.type === 'open' && state.active === action.tab && state.tabs.includes(action.tab)) return state;
  if (action.type === 'open') return {
    tabs: state.tabs.includes(action.tab) ? state.tabs : [...state.tabs, action.tab], active: action.tab,
  };
  if (action.tab === 'chat' || !state.tabs.includes(action.tab)) return state;
  const index = state.tabs.indexOf(action.tab);
  const tabs = state.tabs.filter(tab => tab !== action.tab);
  return { tabs, active: state.active === action.tab ? tabs[Math.max(0, index - 1)] : state.active };
}

export interface WorkbenchSnapshot {
  version: 1;
  workbench: WorkbenchState;
  panes: (string | null)[];
  focused: number;
  layout: '1x1' | '1x2' | '2x2';
}
type WorkbenchIdentity = { mode: 'local' | 'relay'; userId: string };
export const workbenchStorageKey = (identity: WorkbenchIdentity): string =>
  `agent-with-u:workbench:v1:${identity.mode}:${encodeURIComponent(identity.userId || 'legacy')}`;

/** 只持久化导航 ID；不包含消息、附件、凭据或 Kit 本次授权。 */
export function normalizeWorkbenchSnapshot(value: any): WorkbenchSnapshot {
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]+$/.test(id);
  const validTab = (tab: unknown): tab is WorkbenchTab => typeof tab === 'string'
    && (['chat', 'library', 'market'].includes(tab) || (tab.startsWith('session:') && validId(tab.slice(8))));
  const source = value?.version === 1 ? value : {};
  const tabs: WorkbenchTab[] = ['chat'];
  for (const tab of Array.isArray(source.workbench?.tabs) ? source.workbench.tabs : []) {
    if (validTab(tab) && !tabs.includes(tab)) tabs.push(tab);
  }
  const seen = new Set<string>();
  const panes = Array.from({ length: 4 }, (_, i) => {
    const id = source.panes?.[i];
    if (!validId(id) || seen.has(id)) return null;
    seen.add(id);
    if (!tabs.includes(sessionWorkbenchTab(id))) tabs.push(sessionWorkbenchTab(id));
    return id;
  });
  const layout = source.layout === '1x2' || source.layout === '2x2' ? source.layout : '1x1';
  const slots = layout === '2x2' ? 4 : layout === '1x2' ? 2 : 1;
  let focused = Number.isInteger(source.focused) ? Math.max(0, Math.min(source.focused, slots - 1)) : 0;
  const active: WorkbenchTab = tabs.includes(source.workbench?.active) ? source.workbench.active : 'chat';
  if (isConversationTab(active)) {
    const selected = selectSessionPane(panes, workbenchSessionId(active), focused, slots);
    panes.splice(0, panes.length, ...selected.panes);
    focused = selected.focused;
  }
  return { version: 1, workbench: { tabs, active }, panes, focused, layout };
}

export function loadWorkbenchSnapshot(identity: WorkbenchIdentity): WorkbenchSnapshot {
  const key = workbenchStorageKey(identity);
  for (const kind of ['sessionStorage', 'localStorage'] as const) {
    try {
      const raw = window[kind].getItem(key);
      if (raw) return normalizeWorkbenchSnapshot(JSON.parse(raw));
    } catch { /* 损坏/禁用的存储不阻止打开应用 */ }
  }
  // 旧版分屏未隔离身份，仅允许本机用户首次迁移，不能泄漏给 Relay 用户。
  if (identity.mode === 'local' && identity.userId === 'local') {
    try {
      const panes = JSON.parse(localStorage.getItem('agent-with-u:pane-sessions') || 'null');
      return normalizeWorkbenchSnapshot({ version: 1, panes,
        layout: localStorage.getItem('agent-with-u:layout'),
        workbench: { tabs: [], active: panes?.[0] ? sessionWorkbenchTab(panes[0]) : 'chat' } });
    } catch { /* */ }
  }
  return normalizeWorkbenchSnapshot(null);
}

export function saveWorkbenchSnapshot(identity: WorkbenchIdentity, snapshot: WorkbenchSnapshot): void {
  const key = workbenchStorageKey(identity);
  const raw = JSON.stringify(normalizeWorkbenchSnapshot(snapshot));
  // 本浏览器页优先；本地副本供关闭应用后恢复，多个窗口不覆盖彼此的刷新状态。
  for (const kind of ['sessionStorage', 'localStorage'] as const) {
    try { window[kind].setItem(key, raw); } catch { /* 无存储权限时仍可使用当前窗口 */ }
  }
}
