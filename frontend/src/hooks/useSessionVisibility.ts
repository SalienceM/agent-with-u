import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { canShowSession, privateSessionsShown, subscribeSessionVisibility } from '../utils/sessionVisibility';

export function useSessionVisibility(): boolean {
  return useSyncExternalStore(subscribeSessionVisibility, privateSessionsShown, () => false);
}

/** 候选弹窗已经打开时，也要立即响应私密标记变化；键盘与鼠标共用过滤结果。 */
export function useVisibleSessionCandidates<T extends { id: string; execKey?: string }>(items: T[]): T[] {
  const reveal = useSessionVisibility();
  const [revision, setRevision] = useState(0);
  useEffect(() => api.onSessionUpdated(() => setRevision(value => value + 1)), []);
  return useMemo(() => items.filter(row => {
    const cached = api.peekSessionMeta(row.id);
    return canShowSession(cached && (!row.execKey || row.execKey === cached.execKey) ? cached : row, reveal);
  }), [items, reveal, revision]);
}
