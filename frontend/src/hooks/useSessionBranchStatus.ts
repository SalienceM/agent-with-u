import { useEffect, useState } from 'react';
import { api, getCurrentUserProfile, onCurrentUserChanged } from '../api';
import { branchFamilies, projectBranchBadges, type BranchBadge, type BranchSessionRef } from '../utils/sessionBranchStatus';
import type { SessionBranchTip } from '../types/taskWorkspaces';

// 跨挂载共享并发额度，旧代次的 RPC 未结束时，新代次不会额外占满节点。
let activeReads = 0;
const waiters: Array<() => void> = [];
async function limited<T>(read: () => Promise<T>): Promise<T> {
  if (activeReads >= 2) await new Promise<void>(resolve => waiters.push(resolve)); else activeReads++;
  try { return await read(); }
  finally { const next = waiters.shift(); if (next) next(); else activeReads--; }
}

export function useSessionBranchStatus(sessions: BranchSessionRef[], visible: BranchSessionRef[], enabled: boolean, streaming: Set<string>) {
  const [owner, setOwner] = useState(getCurrentUserProfile().userId);
  const [badges, setBadges] = useState<Record<string, BranchBadge>>({});
  useEffect(() => onCurrentUserChanged(() => { setOwner(getCurrentUserProfile().userId); setBadges({}); }), []);
  const families = branchFamilies(sessions, visible);
  const signature = JSON.stringify(families.map(f => [f.key, f.signature, f.ids.filter(id => streaming.has(id))]));
  useEffect(() => {
    let live = true;
    const current = () => live && getCurrentUserProfile().userId === owner;
    const shown = () => enabled && document.visibilityState !== 'hidden';
    const states = families.map(family => ({ family, version: 0, reading: false, dirty: true, online: true,
      busy: family.ids.some(id => streaming.has(id)), timer: undefined as ReturnType<typeof setTimeout> | undefined }));
    const publish = (state: typeof states[number], rows: Map<string, BranchBadge> | BranchBadge) => {
      if (!current()) return;
      setBadges(old => {
        const next = { ...old };
        for (const id of state.family.ids) next[`${state.family.executor}:${id}`] = rows instanceof Map
          ? rows.get(id) || { label: '状态待核对', detail: '当前成员不在读取结果中', tone: 'muted' } : rows;
        return next;
      });
    };
    setBadges({});
    const read = async (state: typeof states[number]) => {
      if (!current() || !shown() || !state.online || state.busy || state.reading || !state.dirty) return;
      state.reading = true; state.dirty = false;
      const version = state.version;
      const valid = () => current() && shown() && state.online && state.version === version;
      try {
        await limited(async () => {
          if (!valid()) return;
          const caps = await api.projectMergeCapabilities(state.family.root, state.family.executor);
          if (!valid()) return;
          if (caps.branchStatus !== 1) { publish(state, { label: '状态不可用', detail: '原节点尚不支持当前分支状态，请升级该节点', tone: 'muted' }); return; }
          let offset = 0, identity = '', total = -1, checkedAt = 0;
          const tips = new Map<string, SessionBranchTip>();
          do {
            const page = await api.projectBranchStatus(state.family.root, state.family.executor, offset);
            if (!valid()) return;
            const main = page.items.find(tip => tip.main);
            if (!main || page.parentSessionId !== state.family.root || page.version !== 1) throw Error('项目关联不可核对');
            const mark = JSON.stringify([page.familyRevision, main.head, main.branch, main.dirty, main.busy]);
            if (identity && identity !== mark) throw Error('分页期间主干或成员已变化');
            identity = mark; total = page.total; checkedAt = Math.min(checkedAt || page.checkedAt, page.checkedAt);
            page.items.forEach(tip => tips.set(tip.sessionId, tip));
            if (page.nextOffset === null) break;
            if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw Error('分页状态不可核对');
            offset = page.nextOffset;
          } while (valid());
          if (valid()) {
            if (tips.size !== total + 1) throw Error('项目成员读取不完整');
            if (!Number.isFinite(checkedAt) || Date.now() / 1000 - checkedAt > 60) throw Error('分支快照已过期，请重新核对');
            publish(state, projectBranchBadges([...tips.values()], checkedAt));
          }
        });
      } catch (error) {
        if (valid()) publish(state, { label: '状态待核对', detail: `当前分支读取失败：${String(error)}`, tone: 'muted' });
      } finally {
        state.reading = false;
        if (current() && state.dirty) schedule(state);
      }
    };
    const schedule = (state: typeof states[number]) => {
      if (state.timer || state.reading || !shown() || !state.online || state.busy) return;
      state.timer = setTimeout(() => { state.timer = undefined; void read(state); }, 180);
    };
    const invalidate = (state: typeof states[number]) => {
      state.version++; state.dirty = true;
      publish(state, { label: !state.online ? '离线 · 待核对' : state.busy ? '运行中 · 待核对' : '核对中…', detail: '当前状态尚未完成核对，不使用旧合并记录判断最新', tone: 'muted' });
      schedule(state);
    };
    const refreshAll = () => states.forEach(invalidate);
    const related = (id: string, executor: string) => states.filter(s => s.family.executor === executor && s.family.ids.includes(id));
    const offSession = api.onSessionUpdated(event => {
      if (event.type === 'favorite_changed' || event.type === 'token_usage_updated') return;
      related(event.sessionId, event.execKey || 'local').forEach(invalidate);
    });
    const offMerge = api.onProjectMergeUpdated((row, executor) => {
      states.filter(s => s.family.executor === executor && [row.sourceSessionId, row.actualSourceSessionId, row.targetSessionId].some(id => s.family.ids.includes(id || ''))).forEach(invalidate);
    });
    const offConnections = [...new Set(states.map(s => s.family.executor))].map(executor => api.onExecutorConnectionStatus(executor, online => {
      states.filter(s => s.family.executor === executor && s.online !== online).forEach(state => { state.online = online; invalidate(state); });
    }));
    const interval = setInterval(() => { if (shown()) refreshAll(); }, 60000);
    window.addEventListener('focus', refreshAll); document.addEventListener('visibilitychange', refreshAll);
    refreshAll();
    return () => { live = false; clearInterval(interval); states.forEach(s => clearTimeout(s.timer)); offSession(); offMerge(); offConnections.forEach(off => off()); window.removeEventListener('focus', refreshAll); document.removeEventListener('visibilitychange', refreshAll); };
  }, [owner, signature, enabled]);
  return badges;
}
